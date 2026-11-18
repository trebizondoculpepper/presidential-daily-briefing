/**
 * The account's rate-limit buckets for the typed GH service (#923): `GET /rate_limit`, read and
 * normalised into a factual QuotaReading (#547) with this response's own status and failure
 * evidence. Quota policy (TTL, embargo, display) stays in src/github/quotas.ts.
 */

import type { FailureClassification } from "../evidence.js";
import type { RestAnswer } from "../github.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Most resource rows in a view; more are counted as omitted. */
export const QUOTA_MAX_ROWS = 20;

export type QuotaFamily = "rest-core" | "graphql" | "search" | "additional";

/** Units are never mixed: REST requests are not GraphQL points. */
export type QuotaUnit = "rest-requests" | "graphql-points" | "search-requests" | "requests";

export type QuotaInconsistency =
  | "invalid-limit"
  | "invalid-used"
  | "invalid-remaining"
  | "invalid-reset"
  | "remaining-exceeds-limit"
  | "used-exceeds-limit"
  | "totals-mismatch";

export type QuotaRowState =
  | "normal"
  | "warning"
  | "critical"
  | "exhausted"
  | "zero-limit"
  | "unknown"
  | "inconsistent"
  | "reset-passed";

/** One resource bucket as the aggregate endpoint reported it, validated field by field. */
export interface QuotaRow {
  resource: string;
  family: QuotaFamily;
  unit: QuotaUnit;
  limit: number | null;
  /** Measured `used`, or `limit - remaining` when `usedDerived` (not a measured count). */
  used: number | null;
  usedDerived: boolean;
  remaining: number | null;
  resetAt: string | null;
  observedAt: string;
  source: "rate-limit-endpoint";
  state: QuotaRowState;
  /** Only for a valid known limit above zero; null otherwise (no meaningful bar). */
  percentUsed: number | null;
  inconsistencies: QuotaInconsistency[];
}

const RESOURCE_ID = /^[a-z][a-z0-9_]{0,39}$/;

/** Registered families, in display order. Anything else valid is an `additional` family. */
const registered: Record<string, { family: QuotaFamily; unit: QuotaUnit }> = {
  core: { family: "rest-core", unit: "rest-requests" },
  graphql: { family: "graphql", unit: "graphql-points" },
  search: { family: "search", unit: "search-requests" },
  code_search: { family: "search", unit: "search-requests" },
};

const order = Object.keys(registered);

/** A reading normalized from one `/rate_limit` body, before time-dependent state is applied. */
export interface QuotaReading {
  observedAt: string;
  rows: Omit<QuotaRow, "state" | "percentUsed">[];
  total: number;
  omittedResources: string[];
}

/**
 * Normalize a `/rate_limit` body. Only registered fields of `resources.*` are read; the
 * deprecated top-level `rate` duplicate is ignored. Invalid numbers become null with a flag;
 * nothing is clamped into a healthy-looking value. Returns null when there is no resource map.
 */
export function normalizeRateLimit(body: unknown, observedAt: string): QuotaReading | null {
  const resources = isRecord(body) ? body.resources : undefined;
  if (!isRecord(resources)) return null;
  const ids = Object.keys(resources)
    .filter((id) => RESOURCE_ID.test(id) && isRecord(resources[id]))
    .sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || (a < b ? -1 : 1);
    });
  const shown = ids.slice(0, QUOTA_MAX_ROWS);
  const rows = shown.map((resource) => {
    const raw = resources[resource] as Record<string, unknown>;
    const flags: QuotaInconsistency[] = [];
    const field = (key: string, flag: QuotaInconsistency): number | null => {
      if (raw[key] === undefined || raw[key] === null) return null;
      const value = count(raw[key]);
      if (value === null) flags.push(flag);
      return value;
    };
    const limit = field("limit", "invalid-limit");
    let used = field("used", "invalid-used");
    const remaining = field("remaining", "invalid-remaining");
    const resetSeconds = field("reset", "invalid-reset");
    const resetAt =
      resetSeconds !== null && resetSeconds <= 32503680000
        ? new Date(resetSeconds * 1000).toISOString()
        : null;
    if (resetSeconds !== null && resetAt === null) flags.push("invalid-reset");
    let usedDerived = false;
    if (limit !== null && remaining !== null && remaining > limit)
      flags.push("remaining-exceeds-limit");
    if (limit !== null && used !== null && used > limit) flags.push("used-exceeds-limit");
    if (
      limit !== null &&
      used !== null &&
      remaining !== null &&
      used + remaining !== limit &&
      !flags.includes("remaining-exceeds-limit") &&
      !flags.includes("used-exceeds-limit")
    )
      flags.push("totals-mismatch");
    if (
      used === null &&
      raw.used === undefined &&
      limit !== null &&
      remaining !== null &&
      remaining <= limit
    ) {
      used = limit - remaining;
      usedDerived = true;
    }
    const known = registered[resource];
    return {
      resource,
      family: known?.family ?? "additional",
      unit: known?.unit ?? "requests",
      limit,
      used,
      usedDerived,
      remaining,
      resetAt,
      observedAt,
      source: "rate-limit-endpoint" as const,
      inconsistencies: flags,
    };
  });
  return { observedAt, rows, total: ids.length, omittedResources: ids.slice(QUOTA_MAX_ROWS) };
}

/** One `rate_limit` answer: the response's status and evidence, and its normalised reading. */
export interface RateLimitAnswer {
  status: number | null;
  /** For a non-2xx answer, the failure classified from this same response. */
  evidence?: FailureClassification;
  /** The normalised buckets for a 2xx answer; null when the body carries no resource map. */
  reading: QuotaReading | null;
}

type RateLimitRest = (path: string, options?: { signal?: AbortSignal }) => Promise<RestAnswer>;

/** Read `rate_limit` through a REST reader; a thrown read (abort, deadline) propagates. */
export async function readRateLimits(
  rest: RateLimitRest,
  observedAt: () => string,
  signal?: AbortSignal,
): Promise<RateLimitAnswer> {
  const answer = await rest("rate_limit", signal ? { signal } : undefined);
  const ok = answer.status !== null && answer.status >= 200 && answer.status < 300;
  return {
    status: answer.status,
    ...(answer.evidence ? { evidence: answer.evidence } : {}),
    reading: ok ? normalizeRateLimit(answer.body, observedAt()) : null,
  };
}
