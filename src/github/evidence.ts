/**
 * Same-response GitHub evidence and failure classification (#293,
 * doc/design/github-request-telemetry.md). Pure: the gh transport in github.ts supplies the
 * output of `gh api --include` and the process outcome; nothing here runs gh, logs or reads the
 * clock.
 *
 * Only an explicit allowlist of response headers and registered structured error types survive.
 * Raw bodies, error messages, stderr, queries, arguments and tokens never do.
 */

/** One `gh api --include` output: the final HTTP response's status and headers, and its body. */
export interface GhResponse {
  /** HTTP status of the final response block, or null when gh printed no header block. */
  status: number | null;
  /** Lower-cased header names to values, from the final response block only. */
  headers: ReadonlyMap<string, string>;
  /** The body text (JSON for the API), without the header blocks. */
  body: string;
}

export class GhResponseFramingError extends Error {
  readonly framing = true;
}

const statusLine = /^HTTP\/\d(?:\.\d)? (\d{3})(?: [^\r\n]*)?$/;
const headerLine = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/;

/**
 * Split `gh api --include` output into its final response block and body. Output without a header
 * block (an older or injected gh) is all body with an unknown status. Several blocks (an interim
 * `100 Continue` or proxy `200 Connection established`) are allowed; the last one before the body
 * is the API response. A block that starts like HTTP but is not framed as one is refused rather
 * than split at arbitrary body text.
 */
export function parseGhResponse(output: string): GhResponse {
  if (!output.startsWith("HTTP/")) return { status: null, headers: new Map(), body: output };
  let rest = output;
  let status: number | null = null;
  let headers = new Map<string, string>();
  while (rest.startsWith("HTTP/")) {
    const end = /\r?\n\r?\n/.exec(rest);
    if (!end) throw new GhResponseFramingError("gh response headers are not terminated.");
    const [first, ...lines] = rest.slice(0, end.index).split(/\r?\n/);
    const parsed = statusLine.exec(first!);
    if (!parsed) throw new GhResponseFramingError("gh response has a malformed status line.");
    status = Number(parsed[1]);
    headers = new Map();
    for (const line of lines) {
      const header = headerLine.exec(line);
      if (!header) throw new GhResponseFramingError("gh response has a malformed header line.");
      headers.set(header[1]!.toLowerCase(), header[2]!.trim());
    }
    rest = rest.slice(end.index + end[0].length);
  }
  return { status, headers, body: rest };
}

/** Rate-limit facts observed in one response's own headers; missing values are null, never 0. */
export interface QuotaObservation {
  source: "response-header";
  resource: string | null;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  /** From x-ratelimit-reset (epoch seconds), as ISO. */
  resetAt: string | null;
  /** From a numeric Retry-After. */
  retryAfterSeconds: number | null;
  /** From an HTTP-date Retry-After, as ISO; kept apart from the numeric form. */
  retryAt: string | null;
  /** x-github-request-id, a bounded non-secret source identifier. */
  requestId: string | null;
}

const count = (value: string | undefined, max = 1e9): number | null =>
  value !== undefined && /^\d{1,10}$/.test(value) && Number(value) <= max ? Number(value) : null;

/** The allowlisted rate-limit headers of one response, validated; anything malformed is null. */
export function quotaObservation(headers: ReadonlyMap<string, string>): QuotaObservation {
  const reset = count(headers.get("x-ratelimit-reset"), 32503680000);
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds = count(retryAfter, 86400);
  const retryDate =
    retryAfter !== undefined && retryAfterSeconds === null && /^[A-Za-z]{3}, /.test(retryAfter)
      ? Date.parse(retryAfter)
      : NaN;
  const resource = headers.get("x-ratelimit-resource");
  const requestId = headers.get("x-github-request-id");
  return {
    source: "response-header",
    resource: resource && /^[a-z_]{1,40}$/.test(resource) ? resource : null,
    limit: count(headers.get("x-ratelimit-limit")),
    remaining: count(headers.get("x-ratelimit-remaining")),
    used: count(headers.get("x-ratelimit-used")),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    retryAfterSeconds,
    retryAt: Number.isFinite(retryDate) ? new Date(retryDate).toISOString() : null,
    requestId: requestId && /^[A-Za-z0-9:._-]{1,80}$/.test(requestId) ? requestId : null,
  };
}

export type FailureCategory =
  | "rate-limited"
  | "secondary-rate-limit"
  | "resource-limit"
  | "authentication"
  | "access"
  | "server"
  | "timeout"
  | "cancelled"
  | "no-response"
  | "unknown";

/**
 * How the same response's quota headers relate to a rate-limit refusal: `exhausted` (remaining
 * 0, so the reported reset is the earliest retry candidate), `inconsistent` (quota remained, so
 * the cause and retry time are unproven) or `unknown` (no usable remaining count).
 */
export type QuotaEvidence = "exhausted" | "inconsistent" | "unknown";

export interface FailureClassification {
  category: FailureCategory;
  quotaEvidence: QuotaEvidence | null;
  /** Registered GraphQL error types seen (bounded), never their messages. */
  errorTypes: string[];
  httpStatus: number | null;
  observation: QuotaObservation;
}

/** GraphQL error types recognised as rate limiting; GitHub has used both spellings. */
const rateLimitTypes = new Set(["RATE_LIMIT", "RATE_LIMITED"]);
const rateLimitCodes = new Set(["graphql_rate_limit"]);
/** Query-size refusals: waiting alone does not fix them. */
const resourceTypes = new Set(["MAX_NODE_LIMIT_EXCEEDED", "RESOURCE_LIMITS_EXCEEDED"]);
/** Every registered error type that may be reported back (others become "OTHER"). */
const knownTypes = new Set([
  ...rateLimitTypes,
  ...resourceTypes,
  "NOT_FOUND",
  "FORBIDDEN",
  "INTERNAL",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Classify a failed gh API attempt from structured evidence only: the HTTP status and allowlisted
 * headers of the same response, registered GraphQL error types and codes, the REST error's
 * documentation link, and the process outcome. Repository content in a body never classifies.
 */
export function classifyGhFailure(input: {
  response: GhResponse | null;
  /** gh's exit code; 4 is its documented authentication-required status. */
  exitCode?: unknown;
  timedOut?: boolean;
  aborted?: boolean;
}): FailureClassification {
  const response = input.response;
  const observation = quotaObservation(response?.headers ?? new Map());
  let body: unknown = null;
  try {
    body = response ? JSON.parse(response.body) : null;
  } catch {
    body = null;
  }
  const errors = isObject(body) && Array.isArray(body.errors) ? body.errors : [];
  const types = errors.flatMap((e) => (isObject(e) && typeof e.type === "string" ? [e.type] : []));
  const codes = errors.flatMap((e) => (isObject(e) && typeof e.code === "string" ? [e.code] : []));
  const docs =
    isObject(body) && typeof body.documentation_url === "string" ? body.documentation_url : "";
  const status = response?.status ?? null;
  const result = (category: FailureCategory, quotaEvidence: QuotaEvidence | null = null) => ({
    category,
    quotaEvidence,
    errorTypes: [...new Set(types.map((t) => (knownTypes.has(t) ? t : "OTHER")))].slice(0, 5),
    httpStatus: status,
    observation,
  });
  if (input.aborted) return result("cancelled");
  if (input.timedOut) return result("timeout");
  const quota = (): QuotaEvidence =>
    observation.remaining === null
      ? "unknown"
      : observation.remaining === 0
        ? "exhausted"
        : "inconsistent";
  if (/secondary-rate-limits|#secondary-rate-limits/.test(docs))
    return result("secondary-rate-limit");
  if (types.some((t) => rateLimitTypes.has(t)) || codes.some((c) => rateLimitCodes.has(c)))
    return result("rate-limited", quota());
  if (types.some((t) => resourceTypes.has(t))) return result("resource-limit");
  if (status === 429) return result("rate-limited", quota());
  if (status === 403 && observation.remaining === 0) return result("rate-limited", "exhausted");
  if (status === 401 || input.exitCode === 4) return result("authentication");
  if (status === 403) return result("access");
  if (status !== null && status >= 500) return result("server");
  if (status === null && !response?.body) return result("no-response");
  return result("unknown");
}

/** The user-facing sentence for a rate-limit classification: grounded, never a guessed reset. */
export function rateLimitMessage(c: FailureClassification): string {
  const o = c.observation;
  const quota = `${o.remaining} of ${o.limit ?? "?"} remaining${o.resource ? ` (${o.resource})` : ""}`;
  if (c.category === "secondary-rate-limit")
    return `GitHub applied a secondary rate limit${o.retryAfterSeconds !== null ? `; it asked to retry after ${o.retryAfterSeconds}s` : o.retryAt ? `; it asked to retry after ${o.retryAt}` : "; no retry time was reported"}.`;
  if (c.quotaEvidence === "exhausted")
    return `GitHub query was rate limited: quota exhausted${o.resource ? ` (${o.resource})` : ""}${o.resetAt ? `; this response reports a reset at ${o.resetAt}` : "; no reset was reported"}.`;
  if (c.quotaEvidence === "inconsistent")
    return `GitHub refused the query as rate limited, but this same response reported ${quota}; the cause and retry time are unproven.`;
  return `GitHub query was rate limited; this response reported no quota or reset${o.retryAfterSeconds !== null ? `, only a retry after ${o.retryAfterSeconds}s` : ""}.`;
}

/**
 * Registered operation IDs (#293 "Allowed request evidence"): callers choose one of these, never
 * free text, so no prose or repository content can reach telemetry through an operation name.
 */
export const operationIds = [
  "snapshot",
  "issue",
  "comments",
  "dependencies",
  "pull-request",
  "estimate",
  "delivery",
  "other",
] as const;
export type OperationId = (typeof operationIds)[number];

/** One GitHub API attempt as observed by the gh transport; nothing else leaves it. */
export interface AttemptEvent {
  schemaVersion: 1;
  operation: OperationId;
  route: "graphql";
  startedAt: string;
  durationMs: number;
  /** `success` (including a NOT_FOUND-only answer), else the failure category. */
  outcome: "success" | FailureCategory;
  httpStatus: number | null;
  errorTypes: string[];
  /** UTF-8 bytes of the response body when known; not wire bytes. */
  bodyBytes: number | null;
  /** GraphQL query cost when the response reported it; null when not selected or unknown. */
  cost: number | null;
  observation: QuotaObservation;
}
export type AttemptObserver = (event: AttemptEvent) => void;

/** A bounded summary of attempts (#293 "Reporting, aggregation and retry"). */
export interface AttemptSummary {
  schemaVersion: 1;
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  bodyBytes: number;
  /** Sum of the costs that were reported; attempts without one are counted separately. */
  knownCost: number;
  unknownCostAttempts: number;
  /** Failures by category. */
  failures: Partial<Record<FailureCategory, number>>;
  /** The latest header observation per rate-limit resource; never summed across calls. */
  latest: Record<string, QuotaObservation>;
}

/** Summarise attempts. Retries count again; remaining allowances are never added up. */
export function summarizeAttempts(events: readonly AttemptEvent[]): AttemptSummary {
  const summary: AttemptSummary = {
    schemaVersion: 1,
    attempts: events.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    bodyBytes: 0,
    knownCost: 0,
    unknownCostAttempts: 0,
    failures: {},
    latest: {},
  };
  for (const e of events) {
    if (e.outcome === "success") summary.succeeded++;
    else if (e.outcome === "cancelled") summary.cancelled++;
    else {
      summary.failed++;
      summary.failures[e.outcome] = (summary.failures[e.outcome] ?? 0) + 1;
    }
    summary.bodyBytes += e.bodyBytes ?? 0;
    if (e.cost === null) summary.unknownCostAttempts++;
    else summary.knownCost += e.cost;
    const resource = e.observation.resource;
    if (resource && e.observation.remaining !== null) summary.latest[resource] = e.observation;
  }
  return summary;
}
