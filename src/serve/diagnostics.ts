/**
 * Read-only service diagnostics over REST (#459, doc/design/serve-diagnostics-api.md), first
 * slice: projects, cache and inflight. Every read inspects state the server already holds: no
 * GitHub request, collection, refresh, expiry renewal, rule evaluation or background work.
 * Rows are built field by field from typed metadata, never by spreading internal objects.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpFailure, sendJson } from "./http.js";

// This module imports nothing from serve.ts, api.ts or cache.ts, so it adds no import cycle
// (src/acceptance/importcycles.test.ts): its inputs are passed in by services.ts.

/** One held cache entry as diagnostics show it (doc/design/serve-diagnostics-api.md "Cache"). */
export interface CacheEntryDiagnostic {
  id: string;
  repository: string;
  collector: string;
  /** The focused issue or PR number when the key names one. */
  subject: number | null;
  /** Allowlisted non-identifying coverage options only (booleans and small numbers). */
  options: Record<string, boolean | number>;
  observedAt: string;
  expiresAt: string;
  ageMs: number;
  approxBytes: number;
  state: "fresh" | "stale-eligible" | "expired";
  hits: number;
}
/** One in-flight shared collection (doc/design/serve-diagnostics-api.md "Inflight"). */
export interface InflightDiagnostic {
  id: string;
  repository: string;
  collector: string;
  subject: number | null;
  startedAt: string;
  elapsedMs: number;
  waiters: number;
  cancelled: boolean;
}

/** The request facts a diagnostic read needs. */
export interface DiagnosticContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}
/** The server facts a diagnostic read needs. */
export interface DiagnosticFacts {
  served: readonly { repository: string; project?: string }[];
  auth: { host: string };
}
/** Held cache state, read without side effects (ServeCache.diagnostics). */
export type HeldState = () => { entries: CacheEntryDiagnostic[]; inflight: InflightDiagnostic[] };

export const diagnosticViews = ["projects", "cache", "inflight"] as const;
type View = (typeof diagnosticViews)[number];
const prefix = "/api/v1/diagnostics/";

interface ProjectDiagnostic {
  repository: string;
  host: string;
  default: boolean;
  hasLocalContext: boolean;
  /** How the project was registered; today only explicit --repo/--project arguments exist. */
  registrationSource: "explicit";
}

/** Each view's accepted query parameters; anything else, or a repeated one, is refused. */
const accepted: Record<View, readonly string[]> = {
  projects: ["limit", "cursor"],
  cache: ["repo", "limit", "cursor"],
  inflight: ["repo", "limit", "cursor"],
};

const invalid = (message: string) => new HttpFailure(400, "INVALID_ARGUMENT", message);

/** Numeric part of a process-scoped ID ("c12" -> 12), for a stable order not tied to keys. */
const idOrder = (id: string): number => Number(id.slice(1));

/**
 * The diagnostics routes. `instanceId` is public random metadata for this server process; it
 * scopes cursors (a restart expires them) and is never a credential or control token.
 */
export function diagnosticsApi(
  facts: DiagnosticFacts,
  held: HeldState,
  /** The served-repository resolver shared with the read API (selectRepository). */
  select: (repo: string | undefined) => string,
  instanceId: string,
  now: () => Date,
): (context: DiagnosticContext) => Promise<boolean> {
  return async (context) => {
    const path = context.url.pathname;
    if (!path.startsWith(prefix)) return false;
    const view = path.slice(prefix.length) as View;
    if (!diagnosticViews.includes(view)) return false;
    if (context.request.method !== "GET")
      throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET" });
    const values = new Map<string, string>();
    for (const [name, value] of context.url.searchParams) {
      if (!accepted[view].includes(name))
        // Never reflect a supplied name: it may hold a credential or a local path.
        throw invalid(`Unknown parameter; allowed: ${accepted[view].join(", ") || "none"}.`);
      if (values.has(name)) throw invalid(`${name} may be given once.`);
      values.set(name, value);
    }
    const limitText = values.get("limit");
    if (limitText !== undefined && !/^(?:[1-9]\d?|100)$/.test(limitText))
      throw invalid("limit must be an integer from 1 to 100.");
    const limit = limitText === undefined ? 20 : Number(limitText);

    const selected = view === "projects" ? null : select(values.get("repo"));
    let items: (ProjectDiagnostic | CacheEntryDiagnostic | InflightDiagnostic)[];
    if (view === "projects")
      items = [...facts.served]
        .sort((a, b) => a.repository.localeCompare(b.repository))
        .map((s) => ({
          repository: s.repository,
          host: facts.auth.host,
          default: facts.served.length === 1,
          hasLocalContext: s.project !== undefined,
          registrationSource: "explicit" as const,
        }));
    else {
      const state = held();
      const mine = (r: string) => r === selected!.toLowerCase();
      items =
        view === "cache"
          ? state.entries
              .filter((e) => mine(e.repository))
              .sort((a, b) => idOrder(a.id) - idOrder(b.id))
              .map((e) => ({ ...e, repository: selected! }))
          : state.inflight
              .filter((f) => mine(f.repository))
              .sort(
                (a, b) => a.startedAt.localeCompare(b.startedAt) || idOrder(a.id) - idOrder(b.id),
              )
              .map((f) => ({ ...f, repository: selected! }));
    }

    // The list revision fingerprints the filtered inventory: any added or removed row changes
    // it, request time never does. A cursor from another revision or process is expired.
    const ids = items.map((i) => ("id" in i ? i.id : i.repository)).join("\n");
    const revision = createHash("sha256").update(ids).digest("hex").slice(0, 16);
    let offset = 0;
    const cursor = values.get("cursor");
    if (cursor !== undefined) {
      if (cursor.length > 120 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw invalid("cursor is malformed; request the first page without it.");
      const parts = Buffer.from(cursor, "base64url").toString("utf8").split(":");
      if (parts.length !== 4 || parts[0] !== view || !/^\d{1,6}$/.test(parts[3]!))
        throw invalid("cursor is malformed; request the first page without it.");
      if (parts[1] !== instanceId || parts[2] !== revision)
        throw new HttpFailure(
          409,
          "DIAGNOSTIC_CURSOR_EXPIRED",
          "The listed state changed or the server restarted since this cursor was issued.",
          [`${path}${selected ? `?repo=${selected}` : ""}`],
        );
      offset = Number(parts[3]);
    }
    const page = items.slice(offset, offset + limit);
    const next = offset + page.length;
    const nextCursor =
      next < items.length
        ? Buffer.from(`${view}:${instanceId}:${revision}:${next}`).toString("base64url")
        : null;
    sendJson(context.response, 200, {
      schemaVersion: 1,
      kind: "serve-diagnostics",
      view,
      observedAt: now().toISOString(),
      instanceId,
      selection: { repository: selected },
      coverage: { complete: true, warnings: [] },
      data: { total: items.length, omitted: items.length - page.length, nextCursor, items: page },
    });
    return true;
  };
}
