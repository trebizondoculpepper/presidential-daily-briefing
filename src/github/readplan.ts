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
    version: 2,
    sources: [
      "required-checks",
      "pull-request",
      "checks",
      "review-threads",
      "closing-issues",
      "delivery-records",
      "permissions",
    ],
    bounds: { checks: 100, reviewThreads: 100, closingIssues: 10 },
  },
  /**
   * `pdb ticket N` (#197): issue-detail-v1 for the selected issue, its direct native edges and
   * every associated PR identity (closed included), then pr-status-v1 for at most
   * `detailedPullRequests` of them, required members first. The detail bound is the default of
   * `--limit-prs`; the report states the bound actually used.
   */
  "ticket-status-v1": {
    version: 2,
    sources: [
      "required-checks",
      "issue",
      "labels",
      "comments",
      "native-blocked-by",
      "native-blocking",
      "linked-pull-requests",
      "pull-request",
      "checks",
      "reviews",
      "review-threads",
      "closing-issues",
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
      detailedPullRequests: 10,
      checks: 100,
      reviewThreads: 100,
    },
  },
  /**
   * Routine `deps N` with its direct impact (#196): the selected issue with its labels, open
   * closing-PR identities and complete direct native edges, then the eligibility facts (labels,
   * creation time, open closing PRs, own blockers) of at most `dependantsHydrated` open direct
   * dependants for which it is the last open blocker, `dependantsPerRequest` to a request.
   * No discussion, reviews, check runs or transitive edges.
   */
  "dependency-direct-v1": {
    version: 1,
    sources: [
      "issue",
      "labels",
      "native-blocked-by",
      "native-blocking",
      "linked-pull-requests",
      "dependant-eligibility",
    ],
    bounds: {
      labels: 100,
      nativeEdgesPerPage: 100,
      linkedPullRequestsPerPage: 10,
      dependantsHydrated: 50,
      dependantsPerRequest: 25,
      dependantBlockersListed: 20,
    },
  },
  /**
   * `deps --top` (#196): discovery of open issues with labels, creation time, open closing-PR
   * identities, native summaries and bounded direct edges; no bodies, comments, reviews or
   * checks. At most `pages` pages of `pageSize`; a capped inventory is reported as partial.
   */
  "dependency-discovery-v1": {
    version: 1,
    sources: [
      "open-issues",
      "labels",
      "native-blocked-by",
      "native-blocking",
      "linked-pull-requests",
    ],
    bounds: {
      pageSize: 50,
      pages: 10,
      labels: 100,
      blockedByPerIssue: 10,
      blockingPerIssue: 50,
      linkedPullRequestsPerIssue: 10,
    },
  },
  /**
   * The explicit `deps N --tree` diagnosis (#196): a breadth-first walk of native edges that
   * stops after `treeNodes` issues and reports every known identity it did not read. Never
   * implicit in a routine read; routine dependency questions use direct edges only.
   */
  "dependency-tree-v1": {
    version: 1,
    sources: ["issue", "labels", "native-blocked-by", "native-blocking"],
    bounds: { treeNodes: 50, nativeEdgesPerPage: 100, notReadListed: 50 },
  },
  /**
   * The routine briefing (#368): discovery of every open issue and PR (labels, creation time,
   * native summaries and bounded direct edges, closing links, PR head/base/draft; no bodies,
   * comments, reviews, threads or checks), ranked through the briefing's own engine, then the
   * full snapshot fields of only the subjects the briefing would show plus the items their rules
   * need (closing links both ways). Rounds re-rank after hydration and expand the frontier; at
   * most `maxHydrated` items are hydrated, `issuesPerRequest` issues to a request. An item that
   * was not hydrated is `not-requested`, never empty evidence.
   */
  "briefing-shortlist-v1": {
    version: 1,
    sources: [
      "open-issues",
      "open-pull-requests",
      "issue",
      "comments",
      "native-blocked-by",
      "native-blocking",
      "pull-request",
      "required-checks",
    ],
    bounds: {
      pageSize: 50,
      pages: 10,
      maxHydrated: 40,
      rounds: 4,
      issuesPerRequest: 10,
      hydrationConcurrency: 3,
    },
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
  /**
   * A definitive quota refusal seen during this read, with GitHub's own retry evidence when the
   * refusal carried it; null when none was seen. A caller that keeps reading state (pdb serve)
   * starts its cooldown from this even when the read returned an incomplete result.
   */
  quota: { retryAfterSeconds: number | null; resetAt: string | null } | null;
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
/**
 * Quota refusal from structured evidence only, never message text (gh's general advice mentions
 * rate limits on unrelated failures). RateLimitError carries `rateLimited`, AuthenticationError
 * carries `authentication`; those discriminators are matched structurally because this module
 * cannot import the collectors without an import cycle. Same-response evidence classified as
 * `rate-limited` also counts. An authentication failure is never a quota refusal.
 */
export const quotaRefusal = (error: unknown): boolean =>
  prop(error, "authentication") !== true &&
  (prop(error, "rateLimited") === true || quotaCategory(prop(error, "evidence", "category")));

/** Evidence categories that are a quota refusal: the primary and the secondary rate limit. */
function quotaCategory(category: unknown): boolean {
  return category === "rate-limited" || category === "secondary-rate-limit";
}

/**
 * Thrown instead of sending a request once this read has seen a quota refusal: nothing is sent
 * after one (collection-profiles.md, "Stop scheduled reads on a definitive quota failure"). It
 * carries the refusal's retry evidence and RateLimitError's `rateLimited` discriminator.
 */
export class QuotaStopped extends Error {
  readonly rateLimited = true;
  constructor(readonly retry: { retryAfterSeconds: number | null; resetAt: string | null }) {
    super("Not sent: GitHub refused an earlier request of this read for quota.");
  }
}

/**
 * Retry evidence from a refusal: a RateLimitError's `retry`, else the refused response's own
 * classified headers (Retry-After, or the reset time). Null fields when it carried none.
 */
function retryEvidence(refusal: unknown): {
  retryAfterSeconds: number | null;
  resetAt: string | null;
} {
  const seconds =
    prop(refusal, "retry", "retryAfterSeconds") ??
    prop(refusal, "evidence", "observation", "retryAfterSeconds");
  const reset =
    prop(refusal, "retry", "resetAt") ??
    prop(refusal, "evidence", "observation", "retryAt") ??
    prop(refusal, "evidence", "observation", "resetAt");
  return {
    retryAfterSeconds: typeof seconds === "number" ? seconds : null,
    resetAt: typeof reset === "string" ? reset : null,
  };
}

const outcomeOf = (error: unknown, signal?: AbortSignal): Exclude<CallOutcome, "success"> =>
  signal?.aborted || (error instanceof Error && error.name === "AbortError")
    ? "cancelled"
    : quotaRefusal(error)
      ? "rate-limited"
      : "failed";

/**
 * The outcome of an answered REST request, from its HTTP status and its classified same-response
 * evidence only: 2xx or 304 is a success, 429 or `rate-limited` evidence is a quota refusal, and
 * anything else (401, 403, 404, 5xx, no status) failed. The body's message is never read.
 */
export function restOutcome(answer: RestAnswer): CallOutcome {
  const status = answer.status;
  if (status === 429 || quotaCategory(prop(answer, "evidence", "category"))) return "rate-limited";
  return status !== null && ((status >= 200 && status < 300) || status === 304)
    ? "success"
    : "failed";
}

/**
 * Records every request of one read and its per-source coverage. Wrap each boundary with the
 * source and subject it reads; the wrapped boundary behaves exactly as the original apart from
 * selecting the aliased GraphQL cost.
 */
export class ReadMeter {
  readonly calls: ReadCall[] = [];
  readonly coverage: ReadSourceCoverage[] = [];
  readonly notAttempted: string[] = [];
  private refusal: ReadCollection["quota"] = null;
  /** Record a quota refusal's structured retry evidence (RateLimitError's `retry`). */
  private noteRefusal(refusal: unknown): void {
    this.noteQuotaRefusal(retryEvidence(refusal));
  }
  /** Restore a shared fact read's refusal without inventing another network request. */
  noteQuotaRefusal({
    retryAfterSeconds,
    resetAt,
  }: {
    retryAfterSeconds?: number | null;
    resetAt?: string | null;
  }): void {
    this.refusal = {
      retryAfterSeconds: retryAfterSeconds ?? this.refusal?.retryAfterSeconds ?? null,
      resetAt: resetAt ?? this.refusal?.resetAt ?? null,
    };
  }
  /** True once this read has seen a quota refusal; no further request is sent then. */
  get refused(): boolean {
    return this.refusal !== null;
  }
  /** Refuse to send once refused, recording what was not attempted. */
  private gate(source: string, subject: string): void {
    if (!this.refusal) return;
    const skipped = `${source} ${subject}`;
    if (!this.notAttempted.includes(skipped)) this.notAttempted.push(skipped);
    throw new QuotaStopped(this.refusal);
  }
  private rate: ReadTelemetry["rateLimit"] = null;
  private readonly started: number;
  readonly monotonic: () => number;
  /**
   * Durations come from `monotonic` (default `performance.now`), an advancing timer kept apart
   * from `now`, which only stamps observation times and may be a fixed clock.
   */
  constructor(
    readonly profile: ReadProfile,
    readonly operation: string,
    readonly now: () => Date = () => new Date(),
    monotonic?: () => number,
    readonly signal?: AbortSignal,
  ) {
    this.monotonic = monotonic ?? (() => performance.now());
    this.started = this.monotonic();
  }
  get version(): number {
    return readProfiles[this.profile].version;
  }
  /** The query boundary, metered as `source` of `subject`. */
  query(base: Query, source: string, subject: string): Query {
    return async (query, variables) => {
      this.gate(source, subject);
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
        if (quotaRefusal(error)) this.noteRefusal(error);
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
      this.gate(source, subject);
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
        const outcome = restOutcome(answer);
        // An answered refusal keeps its retry evidence, as a thrown RateLimitError does.
        if (outcome === "rate-limited") this.noteRefusal(answer);
        record(answer, outcome);
        return answer;
      } catch (error) {
        if (quotaRefusal(error)) this.noteRefusal(error);
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
      quota: this.refusal ?? prior?.quota ?? null,
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
