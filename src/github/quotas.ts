/**
 * Shared GitHub quota view and service (#547, contract doc/design/github-quotas.md).
 *
 * One versioned, typed `quota-view` built from a single `GET /rate_limit` reading through the
 * existing gh REST boundary, plus the #293 same-response evidence a caller has retained. The
 * service is in-memory only: a 60-second TTL per verified host/login, coalesced in-flight reads
 * with per-reader cancellation, a ten-second failure cooldown, a five-minute last-good window for
 * explicit stale display, and no timers, prefetch, retries or persistence. The CLI (`pdb quotas`)
 * and the serve page (#548) are both meant to read through `QuotaService`; neither builds rows.
 *
 * Missing evidence is null, never zero. Buckets are never summed: each resource keeps its own
 * unit, window and observation. Usage is account-wide and is never attributed to a repository.
 */
import type { RestAnswer } from "./github.js";

export const QUOTA_VIEW_SCHEMA_VERSION = 1;
/** Fresh window of a held reading per verified host/login. */
export const QUOTA_TTL_MS = 60_000;
/** A failed lookup is answered from memory this long, so repeated reads do not hammer GitHub. */
export const QUOTA_FAILURE_TTL_MS = 10_000;
/** A last-good reading may be shown as stale (never fresh) this long after it was observed. */
export const QUOTA_LAST_GOOD_MS = 5 * 60_000;
/** Deadline of one quota collection. */
export const QUOTA_TIMEOUT_MS = 5_000;
/** Most resource rows in a view; more are counted as omitted. */
export const QUOTA_MAX_ROWS = 20;
/** Most recent throttling events shown. */
export const QUOTA_MAX_EVENTS = 10;
/** Most header/aggregate discrepancy notices. */
export const QUOTA_MAX_DISCREPANCIES = 5;
/** PDB display heuristics (not GitHub limits): percent used for warning and critical. */
/**
 * PDB display heuristics (owner-confirmed on #548): warning at 20% remaining or less, critical
 * below 5% remaining. Compared on the unrounded counts; the rounded percentage is display only.
 */
export const QUOTA_WARNING_REMAINING_PERCENT = 20;
export const QUOTA_CRITICAL_REMAINING_PERCENT = 5;

/** The verified gh host and login, or an unverified host (no cross-call reuse). */
export interface QuotaContext {
  host: string;
  /** Null when the login could not be established; such a context is never cached. */
  login: string | null;
}

export type QuotaFamily = "rest-core" | "graphql" | "search" | "additional";
/** Units are never mixed: REST requests are not GraphQL points. */
export type QuotaUnit = "rest-requests" | "graphql-points" | "search-requests" | "requests";
export type QuotaRowState =
  | "normal"
  | "warning"
  | "critical"
  | "exhausted"
  | "zero-limit"
  | "unknown"
  | "inconsistent"
  | "reset-passed";
export type QuotaInconsistency =
  | "invalid-limit"
  | "invalid-used"
  | "invalid-remaining"
  | "invalid-reset"
  | "remaining-exceeds-limit"
  | "used-exceeds-limit"
  | "totals-mismatch";

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

/** A classified throttling/resource-limit event from retained sanitized telemetry. */
export interface QuotaEvent {
  category: "rate-limited" | "secondary-rate-limit" | "resource-limit";
  observedAt: string;
  /** A registered operation or collector name; anything else becomes "other". */
  operation: string;
  retryAfterSeconds: number | null;
  retryAt: string | null;
  resource: string | null;
  limit: number | null;
  remaining: number | null;
}
/** A per-response header reading (#293) kept by the caller; authoritative for its own attempt. */
export interface HeaderObservation {
  resource: string;
  observedAt: string;
  operation: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}
/** What the caller's telemetry retains for one auth context; the service never stores it. */
export interface QuotaTelemetrySnapshot {
  /** `process` for a CLI invocation, `service` for a long-running server. */
  scope: "process" | "service";
  /** Start of the retained observation window. */
  since: string;
  events: readonly QuotaEvent[];
  /** Events dropped from the bounded ring before this read. */
  discarded: number;
  observations?: readonly HeaderObservation[];
}

export type QuotaFailureCategory =
  | "rate-limited"
  | "secondary-rate-limit"
  | "authentication"
  | "access"
  | "server"
  | "timeout"
  | "cancelled"
  | "malformed"
  | "unknown";
export interface QuotaFailure {
  category: QuotaFailureCategory;
  observedAt: string;
  httpStatus: number | null;
}
export interface QuotaEmbargo {
  /** Earliest retry bound for the quota lookup only; not a promise any request succeeds. */
  retryAt: string;
  retryAfterSeconds: number | null;
}

export type QuotaNotice =
  | { code: "pressure"; resource: string; state: "warning" | "critical" | "exhausted" }
  | { code: "reset-passed"; resource: string; resetAt: string }
  | { code: "unknown"; resource: string }
  | { code: "zero-limit"; resource: string }
  | { code: "inconsistent"; resource: string; reasons: QuotaInconsistency[] }
  | { code: "omitted-resources"; count: number }
  | { code: "missing-family"; family: "rest-core" | "graphql" | "search" }
  | { code: "stale"; ageSeconds: number | null }
  | { code: "stored-unvalidated" }
  | { code: "clock-rollback" }
  | { code: "refresh-failed"; category: QuotaFailureCategory }
  | { code: "embargo"; retryAt: string }
  | { code: "account-unverified" }
  | {
      code: "header-disagrees";
      resource: string;
      aggregate: { remaining: number | null; limit: number | null; observedAt: string };
      header: {
        remaining: number | null;
        limit: number | null;
        observedAt: string;
        operation: string;
      };
    }
  | { code: "refusal-with-headroom"; resource: string; eventAt: string; remaining: number }
  | { code: "secondary-observed"; count: number }
  | { code: "no-events-in-process" };

export type QuotaFreshness = "live" | "cached" | "stale" | "stored" | "unavailable";

/** The shared, versioned quota view. JSON carries exactly these facts; text is derived. */
export interface QuotaView {
  schemaVersion: typeof QUOTA_VIEW_SCHEMA_VERSION;
  kind: "quota-view";
  host: string;
  /** Focus metadata, not authorization. Null when unverified. */
  account: string | null;
  accountVerified: boolean;
  /** Usage is for the authenticated account and may include other agents and applications. */
  scope: "account";
  generatedAt: string;
  /** When the shown rows were observed (not when this view was produced); null when none. */
  observedAt: string | null;
  /** Seconds since observation; null without one or after a clock rollback. */
  ageSeconds: number | null;
  source: "rate-limit-endpoint" | null;
  freshness: QuotaFreshness;
  coverage: {
    /** Resources the reading reported. */
    total: number;
    shown: number;
    omitted: number;
    omittedResources: string[];
    /** True only when every reported resource is shown. Never a claim about unlisted families. */
    complete: boolean;
  };
  resources: QuotaRow[];
  failure: QuotaFailure | null;
  embargo: QuotaEmbargo | null;
  secondary: {
    metered: false;
    statement: "Secondary limits: unmetered";
    scope: "process" | "service" | "none";
    since: string | null;
    events: QuotaEvent[];
    retained: number;
    discarded: number;
    omitted: number;
  };
  notices: QuotaNotice[];
  /** Requests this view's collection sent: quota reads and identity reads. */
  requests: { quota: number; context: number };
}

/** The REST boundary the service reads through: the existing gh transport (`ghRestWith`). */
export type QuotaRest = (path: string, options?: { signal?: AbortSignal }) => Promise<RestAnswer>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const RESOURCE_ID = /^[a-z][a-z0-9_]{0,39}$/;
const OPERATION_ID = /^[a-z][a-z0-9-]{0,40}$/;
const safeOperation = (value: unknown): string =>
  typeof value === "string" && OPERATION_ID.test(value) ? value : "other";
const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null;

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

/** The display state of one row at `now`. A crossed reset voids the claim to current capacity. */
export function rowState(
  row: Omit<QuotaRow, "state" | "percentUsed">,
  now: number,
): { state: QuotaRowState; percentUsed: number | null } {
  if (row.inconsistencies.length) return { state: "inconsistent", percentUsed: null };
  if (row.limit === null || row.remaining === null || row.used === null)
    return { state: "unknown", percentUsed: null };
  if (row.limit === 0) return { state: "zero-limit", percentUsed: null };
  if (row.resetAt !== null && Date.parse(row.resetAt) <= now)
    return { state: "reset-passed", percentUsed: null };
  const percentUsed = Math.round((row.used / row.limit) * 1000) / 10;
  // Integer comparisons on the reported counts: 9,501 of 10,000 used (4.99% left) is critical.
  const state: QuotaRowState =
    row.remaining === 0
      ? "exhausted"
      : row.remaining * 100 < row.limit * QUOTA_CRITICAL_REMAINING_PERCENT
        ? "critical"
        : row.remaining * 100 <= row.limit * QUOTA_WARNING_REMAINING_PERCENT
          ? "warning"
          : "normal";
  return { state, percentUsed };
}

const sanitizeEvent = (event: QuotaEvent): QuotaEvent | null => {
  const observedAt = isoOrNull(event.observedAt);
  if (
    !observedAt ||
    !["rate-limited", "secondary-rate-limit", "resource-limit"].includes(event.category)
  )
    return null;
  return {
    category: event.category,
    observedAt,
    operation: safeOperation(event.operation),
    retryAfterSeconds: count(event.retryAfterSeconds),
    retryAt: isoOrNull(event.retryAt),
    resource:
      typeof event.resource === "string" && RESOURCE_ID.test(event.resource)
        ? event.resource
        : null,
    limit: count(event.limit),
    remaining: count(event.remaining),
  };
};

/** Everything the view builder needs; pure, so CLI and serve render the same facts. */
export interface QuotaViewInput {
  context: QuotaContext;
  now: number;
  reading: QuotaReading | null;
  freshness: QuotaFreshness;
  failure: QuotaFailure | null;
  embargo: QuotaEmbargo | null;
  telemetry: QuotaTelemetrySnapshot | null;
  requests: { quota: number; context: number };
}

/** Build the shared view and its typed notices. */
export function buildQuotaView(input: QuotaViewInput): QuotaView {
  const { context, now, reading } = input;
  const notices: QuotaNotice[] = [];
  const observed = reading ? Date.parse(reading.observedAt) : NaN;
  const rollback = reading !== null && observed > now;
  const ageSeconds = reading && !rollback ? Math.floor((now - observed) / 1000) : null;
  const resources: QuotaRow[] = (reading?.rows ?? []).map((row) => ({
    ...row,
    ...rowState(row, now),
  }));
  if (!context.login) notices.push({ code: "account-unverified" });
  if (rollback) notices.push({ code: "clock-rollback" });
  if (input.failure) notices.push({ code: "refresh-failed", category: input.failure.category });
  if (input.embargo) notices.push({ code: "embargo", retryAt: input.embargo.retryAt });
  if (input.freshness === "stale") notices.push({ code: "stale", ageSeconds });
  if (input.freshness === "stored") notices.push({ code: "stored-unvalidated" });
  for (const row of resources) {
    if (row.state === "warning" || row.state === "critical" || row.state === "exhausted")
      notices.push({ code: "pressure", resource: row.resource, state: row.state });
    else if (row.state === "reset-passed" && row.resetAt)
      notices.push({ code: "reset-passed", resource: row.resource, resetAt: row.resetAt });
    else if (row.state === "unknown") notices.push({ code: "unknown", resource: row.resource });
    else if (row.state === "zero-limit")
      notices.push({ code: "zero-limit", resource: row.resource });
    else if (row.state === "inconsistent")
      notices.push({ code: "inconsistent", resource: row.resource, reasons: row.inconsistencies });
  }
  if (reading) {
    for (const family of ["rest-core", "graphql", "search"] as const)
      if (!resources.some((r) => r.family === family))
        notices.push({ code: "missing-family", family });
    if (reading.omittedResources.length)
      notices.push({ code: "omitted-resources", count: reading.omittedResources.length });
  }

  // Secondary limits and recent events: never inferred from primary meters.
  const telemetry = input.telemetry;
  const relevant = (telemetry?.events ?? [])
    .map(sanitizeEvent)
    .filter((e): e is QuotaEvent => e !== null)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const events = relevant.slice(0, QUOTA_MAX_EVENTS);
  const secondaryCount = relevant.filter((e) => e.category === "secondary-rate-limit").length;
  if (secondaryCount) notices.push({ code: "secondary-observed", count: secondaryCount });
  if (!relevant.length && (telemetry === null || telemetry.scope === "process"))
    notices.push({ code: "no-events-in-process" });

  // Aggregate vs per-response evidence: each keeps its own source and time; nothing is merged.
  let discrepancies = 0;
  for (const row of resources) {
    if (discrepancies >= QUOTA_MAX_DISCREPANCIES) break;
    const header = [...(telemetry?.observations ?? [])]
      .filter((o) => o.resource === row.resource && isoOrNull(o.observedAt))
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!header) continue;
    const hRemaining = count(header.remaining);
    const hLimit = count(header.limit);
    if (hRemaining === row.remaining && (hLimit === null || hLimit === row.limit)) continue;
    discrepancies++;
    notices.push({
      code: "header-disagrees",
      resource: row.resource,
      aggregate: { remaining: row.remaining, limit: row.limit, observedAt: row.observedAt },
      header: {
        remaining: hRemaining,
        limit: hLimit,
        observedAt: isoOrNull(header.observedAt)!,
        operation: safeOperation(header.operation),
      },
    });
  }
  for (const event of relevant) {
    if (event.category !== "rate-limited" || !event.resource) continue;
    const row = resources.find((r) => r.resource === event.resource);
    if (row?.remaining && row.remaining > 0 && row.state !== "reset-passed") {
      notices.push({
        code: "refusal-with-headroom",
        resource: row.resource,
        eventAt: event.observedAt,
        remaining: row.remaining,
      });
      break;
    }
  }

  const shown = resources.length;
  return {
    schemaVersion: QUOTA_VIEW_SCHEMA_VERSION,
    kind: "quota-view",
    host: context.host,
    account: context.login,
    accountVerified: context.login !== null,
    scope: "account",
    generatedAt: new Date(now).toISOString(),
    observedAt: reading?.observedAt ?? null,
    ageSeconds,
    source: reading ? "rate-limit-endpoint" : null,
    freshness: input.freshness,
    coverage: {
      total: reading?.total ?? 0,
      shown,
      omitted: reading?.omittedResources.length ?? 0,
      omittedResources: reading?.omittedResources ?? [],
      complete: reading !== null && reading.omittedResources.length === 0,
    },
    resources,
    failure: input.failure,
    embargo: input.embargo,
    secondary: {
      metered: false,
      statement: "Secondary limits: unmetered",
      scope: telemetry?.scope ?? "none",
      since: telemetry ? isoOrNull(telemetry.since) : null,
      events,
      retained: relevant.length,
      discarded: count(telemetry?.discarded) ?? 0,
      omitted: relevant.length - events.length,
    },
    notices,
    requests: input.requests,
  };
}

/** Notices that make the primary evidence partial or unusable, whatever its freshness. */
const partialNotices = new Set<QuotaNotice["code"]>([
  "missing-family",
  "unknown",
  "inconsistent",
  "reset-passed",
  "clock-rollback",
  "omitted-resources",
]);

/**
 * Exit status of `pdb quotas`: 0 for a fresh, complete and usable primary view of a verified
 * account (not permission to send more work; an exhausted bucket is still a successful
 * diagnostic); 2 for partial, stale, stored, unavailable or unverified evidence, including an
 * empty or family-incomplete reading, contradictory or unknown counts and passed resets.
 */
export function quotaExitCode(view: QuotaView): 0 | 2 {
  return (view.freshness === "live" || view.freshness === "cached") &&
    view.failure === null &&
    view.accountVerified &&
    view.coverage.complete &&
    view.resources.length > 0 &&
    !view.notices.some((n) => partialNotices.has(n.code))
    ? 0
    : 2;
}

/** The failure category of a non-2xx answer, from its classified evidence and status only. */
function answerFailure(answer: RestAnswer): QuotaFailureCategory {
  const category = answer.evidence?.category;
  if (
    category === "rate-limited" ||
    category === "secondary-rate-limit" ||
    category === "authentication" ||
    category === "access" ||
    category === "server" ||
    category === "timeout"
  )
    return category;
  const status = answer.status;
  if (status === 429) return "rate-limited";
  if (status === 401) return "authentication";
  if (status === 403 || status === 404) return "access";
  if (status !== null && status >= 500) return "server";
  return "unknown";
}

type Outcome =
  | { ok: true; reading: QuotaReading }
  | {
      ok: false;
      failure: QuotaFailure;
      embargoUntil: number | null;
      retryAfterSeconds: number | null;
    };

interface Flight {
  controller: AbortController;
  readers: number;
  generation: number;
  promise: Promise<Outcome>;
}
interface ContextState {
  generation: number;
  lastGood: QuotaReading | null;
  lastFailure: (Outcome & { ok: false }) | null;
  flight: Flight | null;
}

export interface QuotaServiceOptions {
  /** The existing gh REST boundary; called with `rate_limit` only. */
  rest: QuotaRest;
  now?: () => Date;
  /** Retained sanitized telemetry for the context; absent means none (a fresh CLI process). */
  telemetry?: (context: QuotaContext) => QuotaTelemetrySnapshot | null;
  ttlMs?: number;
  failureTtlMs?: number;
  lastGoodMs?: number;
  timeoutMs?: number;
}

export interface QuotaReadOptions {
  refresh?: boolean;
  offline?: boolean;
  signal?: AbortSignal;
  /** Identity reads the caller already made for this view, counted in `requests.context`. */
  contextRequests?: number;
}

const keyOf = (context: QuotaContext): string | null =>
  context.login ? `${context.host.toLowerCase()}\u0000${context.login.toLowerCase()}` : null;

/**
 * The quota service. One instance per process (CLI) or server (serve, #548). Nothing runs unless
 * `view` is called: no timers, no startup request, no background refresh.
 */
export class QuotaService {
  private readonly states = new Map<string, ContextState>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly lastGoodMs: number;
  private readonly timeoutMs: number;
  /** Quota requests sent, for request-count evidence. */
  requests = 0;

  constructor(private readonly options: QuotaServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? QUOTA_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? QUOTA_FAILURE_TTL_MS;
    this.lastGoodMs = options.lastGoodMs ?? QUOTA_LAST_GOOD_MS;
    this.timeoutMs = Math.min(options.timeoutMs ?? QUOTA_TIMEOUT_MS, QUOTA_TIMEOUT_MS);
  }

  /** Drop everything held for a context (for example after a login switch); late results are ignored. */
  forget(context: QuotaContext): void {
    const key = keyOf(context);
    const state = key ? this.states.get(key) : undefined;
    if (!state || !key) return;
    state.generation++;
    state.lastGood = null;
    state.lastFailure = null;
    state.flight = null;
    this.states.delete(key);
  }

  /** The quota view for `context`, fetching only when needed and allowed. */
  async view(context: QuotaContext, read: QuotaReadOptions = {}): Promise<QuotaView> {
    if (read.refresh && read.offline)
      throw new Error("refresh and offline are mutually exclusive.");
    read.signal?.throwIfAborted();
    const key = keyOf(context);
    // An unverified context gets a private state: nothing is reused across calls or logins.
    const state: ContextState = (key ? this.states.get(key) : undefined) ?? {
      generation: 0,
      lastGood: null,
      lastFailure: null,
      flight: null,
    };
    if (key && !this.states.has(key)) this.states.set(key, state);
    const telemetry = this.options.telemetry?.(context) ?? null;
    const requests = { quota: 0, context: read.contextRequests ?? 0 };
    const build = (
      reading: QuotaReading | null,
      freshness: QuotaFreshness,
      failure: QuotaFailure | null,
      embargo: QuotaEmbargo | null,
    ) =>
      buildQuotaView({
        context,
        now: this.now().getTime(),
        reading,
        freshness,
        failure,
        embargo,
        telemetry,
        requests,
      });
    const held = (now: number): QuotaReading | null => {
      const good = state.lastGood;
      if (!good) return null;
      const age = now - Date.parse(good.observedAt);
      // A rolled-back clock gives no trustworthy age: still shown, never as fresh.
      return age < 0 || age <= this.lastGoodMs ? good : null;
    };
    const embargoOf = (now: number): QuotaEmbargo | null => {
      const f = state.lastFailure;
      return f && f.embargoUntil !== null && f.embargoUntil > now
        ? {
            retryAt: new Date(f.embargoUntil).toISOString(),
            retryAfterSeconds: f.retryAfterSeconds,
          }
        : null;
    };

    let now = this.now().getTime();
    if (read.offline) {
      const reading = held(now);
      return build(reading, reading ? "stored" : "unavailable", null, null);
    }
    const good = state.lastGood;
    const goodAge = good ? now - Date.parse(good.observedAt) : NaN;
    if (!read.refresh && good && goodAge >= 0 && goodAge < this.ttlMs) {
      // A refresh that failed after this reading keeps being reported until a lookup succeeds:
      // the held data is then stale with the failure, never a clean cached success.
      const after = state.lastFailure;
      if (after && Date.parse(after.failure.observedAt) >= Date.parse(good.observedAt))
        return build(good, "stale", after.failure, embargoOf(now));
      return build(good, "cached", null, null);
    }
    const embargo = embargoOf(now);
    if (embargo) {
      const reading = held(now);
      return build(reading, reading ? "stale" : "unavailable", state.lastFailure!.failure, embargo);
    }
    const failed = state.lastFailure;
    if (
      failed &&
      now - Date.parse(failed.failure.observedAt) < this.failureTtlMs &&
      !state.flight
    ) {
      const failedAge = now - Date.parse(failed.failure.observedAt);
      if (failedAge >= 0) {
        const reading = held(now);
        return build(reading, reading ? "stale" : "unavailable", failed.failure, null);
      }
    }

    // A lookup whose last reader cancelled is aborted: never join it, start a fresh one.
    let flight = state.flight?.controller.signal.aborted ? null : state.flight;
    if (!flight) {
      flight = this.start(state);
      requests.quota = 1;
    }
    const outcome = await this.join(flight, read.signal);
    now = this.now().getTime();
    if (outcome.ok) return build(outcome.reading, "live", null, null);
    const reading = held(now);
    return build(
      reading,
      reading ? "stale" : "unavailable",
      outcome.failure,
      outcome.embargoUntil !== null && outcome.embargoUntil > now
        ? {
            retryAt: new Date(outcome.embargoUntil).toISOString(),
            retryAfterSeconds: outcome.retryAfterSeconds,
          }
        : null,
    );
  }

  private start(state: ContextState): Flight {
    const controller = new AbortController();
    const generation = state.generation;
    const flight: Flight = {
      controller,
      readers: 0,
      generation,
      promise: this.collect(controller.signal).then((outcome) => {
        if (state.flight === flight) state.flight = null;
        // A forgotten context or a newer generation never receives a late result.
        if (state.generation !== generation) return outcome;
        if (outcome.ok) {
          state.lastGood = outcome.reading;
          state.lastFailure = null;
        } else if (outcome.failure.category !== "cancelled") state.lastFailure = outcome;
        return outcome;
      }),
    };
    state.flight = flight;
    return flight;
  }

  /** One reader of a shared flight; aborting it detaches only this reader. */
  private join(flight: Flight, signal?: AbortSignal): Promise<Outcome> {
    flight.readers++;
    return new Promise<Outcome>((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        flight.readers--;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (flight.readers === 0) flight.controller.abort();
        reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void flight.promise.then((outcome) => {
        if (leave()) resolve(outcome);
      });
    });
  }

  /** One `GET /rate_limit` with a five-second deadline; never retried. */
  private async collect(signal: AbortSignal): Promise<Outcome> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    const fail = (
      category: QuotaFailureCategory,
      httpStatus: number | null = null,
      retry: { seconds: number | null; at: string | null } = { seconds: null, at: null },
    ): Outcome => {
      const observed = this.now().getTime();
      let until: number | null = null;
      if (retry.seconds !== null) until = observed + retry.seconds * 1000;
      else if (retry.at !== null) until = Date.parse(retry.at);
      // GitHub's own Retry-After or reset is kept as given: never shortened (no clamp).
      return {
        ok: false,
        failure: { category, observedAt: new Date(observed).toISOString(), httpStatus },
        embargoUntil: until,
        retryAfterSeconds: retry.seconds,
      };
    };
    this.requests++;
    let answer: RestAnswer;
    try {
      answer = await this.options.rest("rate_limit", { signal: combined });
    } catch {
      if (signal.aborted) return fail("cancelled");
      if (deadline.aborted) return fail("timeout");
      return fail("unknown");
    }
    const status = answer.status;
    if (status === null || status < 200 || status >= 300) {
      const o = answer.evidence?.observation;
      const category = answerFailure(answer);
      const limited = category === "rate-limited" || category === "secondary-rate-limit";
      return fail(
        category,
        status,
        limited
          ? {
              seconds: count(o?.retryAfterSeconds),
              at: isoOrNull(o?.retryAt) ?? (o?.remaining === 0 ? isoOrNull(o?.resetAt) : null),
            }
          : undefined,
      );
    }
    const reading = normalizeRateLimit(answer.body, this.now().toISOString());
    return reading ? { ok: true, reading } : fail("malformed", status);
  }
}
