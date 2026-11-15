/**
 * Typed read profiles, per-source coverage and per-read telemetry for focused reads (#367).
 * Contract: doc/design/collection-profiles.md, "Typed profiles and coverage" and "Pagination,
 * concurrency and telemetry".
 *
 * Collectors name a registered profile; they never accept caller-provided GraphQL. Coverage is
 * recorded per source, so an empty list that was never read is `not-requested`, not "none".
 * Unknown is never complete, and an unknown cost is null, never zero.
 */
import { createHash } from "node:crypto";

// Structural copies of the github.ts boundaries: this module imports nothing from the
// collectors, so it adds no import cycle (doc/design/source-layout.md).
type JsonObject = { [key: string]: unknown };
type Query = (query: string, variables: Record<string, string | number>) => Promise<JsonObject>;
interface RestAnswer {
  status: number | null;
  body: unknown;
}
type Rest = (path: string, options?: { signal?: AbortSignal }) => Promise<RestAnswer>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const prop = (value: unknown, ...path: string[]): unknown => {
  let at = value;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
};
/** The rate-limit text dependencies.ts `isRateLimit` matches. */
const rateLimitText = /rate limit|abuse detection|HTTP 429|retry-after/i;

/** Registered read profiles and the sources and bounds each declares. */
export const readProfiles = {
  /** One issue with its body, labels, comments and native edges, and its linked open PRs. */
  "issue-detail-v1": {
    version: 1,
    sources: [
      "issue",
      "labels",
      "comments",
      "native-blocked-by",
      "native-blocking",
      "linked-pull-requests",
      "pull-request",
      "delivery-records",
      "permissions",
    ],
    bounds: {
      labels: 100,
      commentsPerPage: 100,
      nativeEdgesPerPage: 100,
      linkedPullRequestsPerPage: 10,
      linkedPullRequestPages: 5,
      hydrationConcurrency: 3,
    },
  },
  /** One PR's head, checks, reviews and threads, plus delivery of the issues it closes. */
  "pr-status-v1": {
    version: 1,
    sources: [
      "pull-request",
      "checks",
      "review-threads",
      "closing-issues",
      "delivery-records",
      "permissions",
    ],
    bounds: { checks: 100, reviewThreads: 100, closingIssues: 10 },
  },
  /** The explicit `pr N --history` diagnosis; never implicit in a routine read. */
  "review-history-v1": { version: 1, sources: ["review-history"], bounds: {} },
  /** The full open-inventory snapshot that `--issue N` intake promises (unchanged). */
  "compatibility-full-v1": {
    version: 1,
    sources: ["open-issues", "open-pull-requests", "issue"],
    bounds: { pageSize: 50 },
  },
} as const;
export type ReadProfile = keyof typeof readProfiles;

export type CoverageState = "complete" | "partial" | "not-requested" | "failed";
/** What is known about one source of one subject. */
export interface ReadSourceCoverage {
  source: string;
  /** The subject URL or `owner/name#N`; never a secret variable. */
  subject: string;
  state: CoverageState;
  /** When the source was observed; null when it was not read. */
  observedAt: string | null;
  /** What was left unread (continuation or bound), when partial or not requested. */
  omission: string | null;
  /** A safe failure category, when failed. */
  failure: string | null;
  profileVersion: number;
}

export type CallOutcome = "success" | "rate-limited" | "cancelled" | "failed";
/** One GitHub request made by a read. */
export interface ReadCall {
  source: string;
  subject: string;
  route: "graphql" | "rest";
  /** Stable ID of the query shape or REST route template; variables are never included. */
  shape: string;
  durationMs: number;
  /** UTF-8 bytes of the returned JSON (`data` for GraphQL, the body for REST); null if none. */
  bytes: number | null;
  /** GraphQL cost the response reported; null when unknown (REST, failure, not reported). */
  cost: number | null;
  outcome: CallOutcome;
  /** REST status, when answered; null for GraphQL and for a REST call that threw. */
  status: number | null;
}
export interface ReadTelemetry {
  requests: number;
  graphqlRequests: number;
  restRequests: number;
  bytes: number;
  /** Sum of every request's cost, or null when any GraphQL request's cost is unknown. */
  cost: number | null;
  knownCost: number;
  unknownCostRequests: number;
  durationMs: number;
  /** The latest GraphQL quota the responses reported; null when none did. */
  rateLimit: { remaining: number | null; resetAt: string | null } | null;
  failures: Partial<Record<Exclude<CallOutcome, "success">, number>>;
  calls: ReadCall[];
}
/** The collection record a focused report carries alongside its unchanged fields. */
export interface ReadCollection {
  schemaVersion: 1;
  profile: ReadProfile;
  profileVersion: number;
  /** The command or route that read: `who`, `deps`, `deps-tree`, `pr`, `issue-intake`. */
  operation: string;
  bounds: Record<string, number>;
  coverage: ReadSourceCoverage[];
  /** Targets the read did not attempt, for example after a definitive quota failure. */
  notAttempted: string[];
  telemetry: ReadTelemetry;
}

/** A stable, variable-free ID for a query or REST route shape. */
export const shapeId = (text: string): string =>
  createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
/** REST route template: numbers and logins are variables, so they never reach the shape. */
const restShape = (path: string): string =>
  path
    .replace(/\?.*$/, "")
    .replace(/^repos\/[^/]+\/[^/]+/, "repos/{owner}/{repo}")
    .replace(/\/\d+(?=\/|$)/g, "/{n}")
    .replace(/\/collaborators\/[^/]+/, "/collaborators/{login}");

const RATE = "pdbReadRate";
/**
 * Select the GraphQL cost on the root, aliased so callers never see it. Only a single query
 * operation is changed: a mutation, or a document with fragments, is sent as written (its cost
 * is then unknown, never zero).
 */
const withCost = (query: string): string =>
  /\b(?:mutation|fragment|subscription)\b/.test(query) || !/}\s*$/.test(query)
    ? query
    : query.replace(/}\s*$/, ` ${RATE}:rateLimit{cost remaining resetAt}}`);

const bytesOf = (value: unknown): number | null => {
  if (value === undefined) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return null;
  }
};
const outcomeOf = (error: unknown, signal?: AbortSignal): Exclude<CallOutcome, "success"> =>
  signal?.aborted || (error instanceof Error && error.name === "AbortError")
    ? "cancelled"
    : prop(error, "evidence", "category") === "rate-limited" || prop(error, "rateLimited") === true
      ? "rate-limited"
      : "failed";

/** The outcome of an answered REST request, from its own status and classified evidence. */
export function restOutcome(answer: RestAnswer): CallOutcome {
  const status = answer.status;
  const message = prop(answer.body, "message");
  if (
    status === 429 ||
    prop(answer, "evidence", "category") === "rate-limited" ||
    (status === 403 && typeof message === "string" && rateLimitText.test(message))
  )
    return "rate-limited";
  return status !== null && ((status >= 200 && status < 300) || status === 304)
    ? "success"
    : "failed";
}

/** True when a failure is a definitive quota refusal: stop scheduling further reads. */
export const quotaRefusal = (error: unknown): boolean =>
  prop(error, "rateLimited") === true ||
  prop(error, "evidence", "category") === "rate-limited" ||
  (error instanceof Error && rateLimitText.test(error.message));

/**
 * Records every request of one read and its per-source coverage. Wrap each boundary with the
 * source and subject it reads; the wrapped boundary behaves exactly as the original apart from
 * selecting the aliased GraphQL cost.
 */
export class ReadMeter {
  readonly calls: ReadCall[] = [];
  readonly coverage: ReadSourceCoverage[] = [];
  readonly notAttempted: string[] = [];
  private rate: ReadTelemetry["rateLimit"] = null;
  private readonly started: number;
  readonly monotonic: () => number;
  /** Durations come from `monotonic`, default the injected clock, so tests are deterministic. */
  constructor(
    readonly profile: ReadProfile,
    readonly operation: string,
    readonly now: () => Date = () => new Date(),
    monotonic?: () => number,
    readonly signal?: AbortSignal,
  ) {
    this.monotonic = monotonic ?? (() => now().getTime());
    this.started = this.monotonic();
  }
  get version(): number {
    return readProfiles[this.profile].version;
  }
  /** The query boundary, metered as `source` of `subject`. */
  query(base: Query, source: string, subject: string): Query {
    return async (query, variables) => {
      const started = this.monotonic();
      const shape = shapeId(query);
      try {
        const data = await base(withCost(query), variables);
        const rate = isRecord(data) ? data[RATE] : undefined;
        let returned: JsonObject = data;
        if (isRecord(data) && RATE in data) {
          returned = { ...data };
          delete returned[RATE];
        }
        const cost = prop(rate, "cost");
        const remaining = prop(rate, "remaining");
        const resetAt = prop(rate, "resetAt");
        if (isRecord(rate))
          this.rate = {
            remaining: typeof remaining === "number" ? remaining : null,
            resetAt: typeof resetAt === "string" ? resetAt : null,
          };
        this.calls.push({
          source,
          subject,
          route: "graphql",
          shape,
          durationMs: Math.max(0, Math.round(this.monotonic() - started)),
          bytes: bytesOf(returned),
          cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
          outcome: "success",
          status: null,
        });
        return returned;
      } catch (error) {
        this.calls.push({
          source,
          subject,
          route: "graphql",
          shape,
          durationMs: Math.max(0, Math.round(this.monotonic() - started)),
          bytes: null,
          cost: null,
          outcome: outcomeOf(error, this.signal),
          status: null,
        });
        throw error;
      }
    };
  }
  /** The REST boundary, metered as `source`; the subject is the request path's route. */
  rest(base: Rest, source: string, subject: string): Rest {
    return async (path, options) => {
      const started = this.monotonic();
      const record = (answer: RestAnswer | null, outcome: CallOutcome) =>
        this.calls.push({
          source,
          subject,
          route: "rest",
          shape: shapeId(restShape(path)),
          durationMs: Math.max(0, Math.round(this.monotonic() - started)),
          bytes: answer ? bytesOf(answer.body) : null,
          cost: null,
          outcome,
          status: answer?.status ?? null,
        });
      try {
        const answer = await base(path, options);
        // A REST boundary answers failures with a status rather than throwing: only a 2xx
        // (or 304) answer is a success; a quota refusal is rate-limited; anything else failed.
        record(answer, restOutcome(answer));
        return answer;
      } catch (error) {
        record(null, outcomeOf(error, this.signal));
        throw error;
      }
    };
  }
  /** Record one source's coverage. */
  cover(
    source: string,
    subject: string,
    state: CoverageState,
    detail: { omission?: string | null; failure?: string | null; observedAt?: string | null } = {},
  ): void {
    this.coverage.push({
      source,
      subject,
      state,
      observedAt:
        detail.observedAt !== undefined
          ? detail.observedAt
          : state === "not-requested" || state === "failed"
            ? null
            : this.now().toISOString(),
      omission: detail.omission ?? null,
      failure: detail.failure ?? null,
      profileVersion: this.version,
    });
  }
  /**
   * The collection record, with telemetry summed from the recorded calls. With `prior`, an
   * earlier record of the same command (for example its snapshot read) is included, so the
   * telemetry is the whole command's cost.
   */
  collection(prior?: ReadCollection): ReadCollection {
    const calls = [...(prior?.telemetry.calls ?? []), ...this.calls];
    const graphql = calls.filter((c) => c.route === "graphql");
    const unknownCost = graphql.filter((c) => c.cost === null).length;
    const knownCost = graphql.reduce((sum, c) => sum + (c.cost ?? 0), 0);
    const failures: ReadTelemetry["failures"] = {};
    for (const c of calls)
      if (c.outcome !== "success") failures[c.outcome] = (failures[c.outcome] ?? 0) + 1;
    return {
      schemaVersion: 1,
      profile: this.profile,
      profileVersion: this.version,
      operation: this.operation,
      bounds: { ...readProfiles[this.profile].bounds },
      coverage: [...(prior?.coverage ?? []), ...this.coverage],
      notAttempted: [...(prior?.notAttempted ?? []), ...this.notAttempted],
      telemetry: {
        requests: calls.length,
        graphqlRequests: graphql.length,
        restRequests: calls.length - graphql.length,
        bytes: calls.reduce((sum, c) => sum + (c.bytes ?? 0), 0),
        cost: unknownCost ? null : knownCost,
        knownCost,
        unknownCostRequests: unknownCost,
        durationMs:
          (prior?.telemetry.durationMs ?? 0) +
          Math.max(0, Math.round(this.monotonic() - this.started)),
        rateLimit: this.rate ?? prior?.telemetry.rateLimit ?? null,
        failures,
        calls,
      },
    };
  }
}

/** The outcome of one hydration target. */
export type Hydrated<R> =
  | { state: "done"; value: R }
  | { state: "failed"; error: unknown }
  | { state: "not-attempted" };
/**
 * Hydrate independent targets with at most `concurrency` requests in flight (contract: three).
 * A definitive quota refusal stops scheduling: completed results are kept and the rest are
 * reported `not-attempted`, never retried through another credential. Cancellation rejects.
 */
export async function hydrate<T, R>(
  items: readonly T[],
  handler: (item: T) => Promise<R>,
  { concurrency = 3, signal }: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<Hydrated<R>[]> {
  const results: Hydrated<R>[] = items.map(() => ({ state: "not-attempted" }));
  let next = 0;
  let stopped = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!stopped && next < items.length) {
        signal?.throwIfAborted();
        const index = next++;
        try {
          results[index] = { state: "done", value: await handler(items[index]) };
        } catch (error) {
          signal?.throwIfAborted();
          results[index] = { state: "failed", error };
          if (quotaRefusal(error)) stopped = true;
        }
      }
    }),
  );
  return results;
}
