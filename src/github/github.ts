/** Read-only, paginated gh GraphQL collector. Never invokes a mutation or shell. */
import { completeNative, isRateLimit, nativeFields, RateLimitError } from "./dependencies.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CHANGE_EVIDENCE_SCHEMA_VERSION,
  CHANGE_SCOPE,
  CHANGE_SCOPE_EXCLUDES,
  changeSubject,
  DEFAULT_CHANGE_PAGES,
  issueEvidenceFields,
  pullRequestEvidenceFields,
} from "./changes.js";
import type {
  ComparisonWindow,
  EvidenceIssue,
  EvidencePullRequest,
  SourceCoverage,
} from "./changes.js";
import type { Comment, Issue, Page, PullRequest, Reference, Snapshot } from "./types.js";
import { hydrate, quotaRefusal, ReadMeter, readProfiles } from "./readplan.js";
import {
  classifyGhFailure,
  operationIds,
  parseGhResponse,
  quotaObservation,
  rateLimitMessage,
  summarizeAttempts,
} from "./evidence.js";
import type {
  AttemptEvent,
  AttemptObserver,
  FailureClassification,
  GhResponse,
  OperationId,
  QuotaObservation,
} from "./evidence.js";

const execute = promisify(execFile);

/** An untrusted JSON object (GitHub responses, cached files). */
export type JsonObject = { [key: string]: unknown };
export type QueryVariables = Record<string, string | number>;
/** Injected read-only GraphQL boundary: resolves to the response's `data` object. */
export type Query = (query: string, variables: QueryVariables) => Promise<JsonObject>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follow a path through untrusted JSON; undefined as soon as a step is not an object. */
export function prop(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * The single assertion boundary for GraphQL nodes. Their shape is fixed by this project's own
 * selection sets and GitHub's schema-validated response, so after checking that an object (or
 * connection) is present, its fields are trusted to match the selection rather than
 * re-validated field by field. Missing evidence is still detected by the callers.
 */
function trusted<T>(value: object): T {
  // Justified escape: see above; GraphQL guarantees the selected field shapes.
  return value as T;
}
/** A selected GraphQL object, or null when the response has none. */
export function selected<T>(value: unknown): T | null {
  return isRecord(value) ? trusted<T>(value) : null;
}

/**
 * Read-only GraphQL through gh. With `signal`, aborting terminates the running gh child
 * process (execFile's kill on abort) and rejects with the abort reason instead of a result.
 */
export interface QueryTelemetry {
  /** Registered operation ID; anything else is reported as "other". */
  operation?: OperationId;
  /** Receives one event per gh attempt. It must not throw; if it does, the read is unaffected. */
  observer?: AttemptObserver;
  /** Wall clock and monotonic milliseconds, injectable for tests. */
  now?: () => Date;
  monotonic?: () => number;
}

export const ghQueryWith =
  (signal?: AbortSignal, telemetry: QueryTelemetry = {}): Query =>
  async (query, variables) => {
    if (!telemetry.observer) return ghQueryAttempt(signal, query, variables).then((r) => r.data);
    const monotonic = telemetry.monotonic ?? (() => performance.now());
    const startedAt = (telemetry.now?.() ?? new Date()).toISOString();
    const started = monotonic();
    let outcome: Awaited<ReturnType<typeof ghQueryAttempt>> | null = null;
    let failure: unknown = null;
    try {
      outcome = await ghQueryAttempt(signal, query, variables);
      return outcome.data;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const evidence = outcome?.evidence ?? evidenceOf(failure);
      const category: AttemptEvent["outcome"] = outcome
        ? "success"
        : signal?.aborted
          ? "cancelled"
          : (evidence?.category ?? "unknown");
      try {
        telemetry.observer({
          schemaVersion: 1,
          operation: operationIds.includes(telemetry.operation ?? "other")
            ? (telemetry.operation ?? "other")
            : "other",
          route: "graphql",
          startedAt,
          durationMs: Math.max(0, Math.round(monotonic() - started)),
          outcome: category,
          httpStatus: outcome?.status ?? evidence?.httpStatus ?? null,
          errorTypes: evidence?.errorTypes ?? [],
          bodyBytes: outcome?.bodyBytes ?? attemptOf(failure)?.bodyBytes ?? null,
          cost: outcome?.cost ?? attemptOf(failure)?.cost ?? null,
          observation: outcome?.observation ?? evidence?.observation ?? quotaObservation(new Map()),
        });
      } catch {
        // Telemetry never changes a read's result (contract: observers must not throw into it).
      }
    }
  };

/** The body size and cost a failed attempt's response carried, if any. */
const attemptOf = (error: unknown): { bodyBytes: number; cost: number | null } | null => {
  const attempt = prop(error, "attempt");
  return isRecord(attempt) ? (attempt as { bodyBytes: number; cost: number | null }) : null;
};
/** The same-response classification a failed attempt carries, if any. */
const evidenceOf = (error: unknown): FailureClassification | null => {
  const evidence = prop(error, "evidence");
  return isRecord(evidence) ? (evidence as unknown as FailureClassification) : null;
};
/**
 * Attach the attempt's classification to the error it throws, without overriding evidence an
 * error already carries (a RateLimitError's own). Non-enumerable, so error serialisation and
 * messages are unchanged.
 */
function withEvidence<E extends Error>(
  error: E,
  evidence: FailureClassification,
  response: GhResponse | null = null,
): E {
  if (!evidenceOf(error))
    Object.defineProperty(error, "evidence", { value: evidence, enumerable: false });
  // The bytes and reported cost of a failed response still count (#293): a failure is not free.
  if (response && prop(error, "attempt") === undefined)
    Object.defineProperty(error, "attempt", { value: sizeAndCost(response), enumerable: false });
  return error;
}

/** UTF-8 body bytes and a reported GraphQL cost, from one response. */
function sizeAndCost(response: GhResponse): { bodyBytes: number; cost: number | null } {
  let cost: unknown = null;
  try {
    cost = prop(JSON.parse(response.body), "data", "rateLimit", "cost");
  } catch {
    cost = null;
  }
  return {
    bodyBytes: Buffer.byteLength(response.body, "utf8"),
    cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

/** One gh GraphQL attempt: the data plus its same-response evidence for telemetry. */
async function ghQueryAttempt(
  signal: AbortSignal | undefined,
  query: string,
  variables: QueryVariables,
): Promise<{
  data: JsonObject;
  status: number | null;
  bodyBytes: number;
  cost: number | null;
  observation: QuotaObservation;
  evidence: FailureClassification | null;
}> {
  signal?.throwIfAborted();
  // --include keeps the response's own status and headers, so a failure is classified from
  // the same response's evidence (#293), never from a separate /rate_limit reading.
  const args = ["api", "graphql", "--include", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
  let stdout: string;
  try {
    ({ stdout } = await execute("gh", args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
      signal,
    }));
  } catch (error) {
    signal?.throwIfAborted();
    const response = responseOf(prop(error, "stdout"));
    // gh exits non-zero on any GraphQL error but still prints the response. A response whose
    // only errors are NOT_FOUND is a valid answer ("no such issue"): callers see null fields.
    const answer = graphqlAnswer(response?.body);
    if (answer) return attemptResult(answer, response!);
    const failure = ghQueryFailure(error, response);
    // execFile's timeout kills gh with SIGTERM; that is a timeout, not a GitHub answer.
    const timedOut = prop(error, "killed") === true && prop(error, "signal") === "SIGTERM";
    throw withEvidence(
      failure,
      classifyGhFailure({ response, exitCode: prop(error, "code"), timedOut }),
      response,
    );
  }
  let response: GhResponse;
  try {
    response = parseGhResponse(stdout);
  } catch {
    throw new Error("GitHub returned a malformed response; no fresh report saved.");
  }
  stdout = response.body;
  const parsed: unknown = JSON.parse(stdout);
  const errors = prop(parsed, "errors");
  if (Array.isArray(errors) && errors.length && !graphqlAnswer(stdout)) {
    const limited = sameResponseLimit(response) ?? rateLimitFailure("", stdout);
    if (limited) throw withEvidence(limited, classifyGhFailure({ response }), response);
    throw withEvidence(
      new Error("GitHub returned incomplete query data; no fresh report saved."),
      classifyGhFailure({ response }),
      response,
    );
  }
  const data = prop(parsed, "data");
  if (!isRecord(data))
    throw new Error("GitHub returned incomplete query data; no fresh report saved.");
  return attemptResult(data, response);
}

const attemptResult = (data: JsonObject, response: GhResponse) => ({
  data,
  status: response.status,
  ...sizeAndCost(response),
  observation: quotaObservation(response.headers),
  evidence: null,
});
const text = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
/**
 * A sanitized RateLimitError when gh's output reports a GitHub rate limit (HTTP 403/429
 * text or GraphQL RATE_LIMITED errors), else null. Only a bounded retry-after number and a
 * parsed reset time survive; nothing else from the output is kept.
 */
export function rateLimitFailure(stderr: unknown, stdout: unknown): RateLimitError | null {
  const output = `${text(stderr)}\n${text(stdout)}`;
  let graphqlLimited = false;
  try {
    const errors = prop(JSON.parse(text(stdout)), "errors");
    graphqlLimited =
      Array.isArray(errors) && errors.some((e) => prop(e, "type") === "RATE_LIMITED");
  } catch {
    // Not JSON: rely on the text discriminator only.
  }
  if (!graphqlLimited && !isRateLimit(output)) return null;
  const after = /retry-after:?\s*(\d{1,6})\b/i.exec(output);
  const reset = /x-ratelimit-reset:?\s*(\d{9,11})\b/i.exec(output);
  return new RateLimitError("GitHub query was rate limited; retry after the reported reset.", {
    retryAfterSeconds: after ? Number(after[1]) : null,
    resetAt: reset ? new Date(Number(reset[1]) * 1000).toISOString() : null,
  });
}
/**
 * gh could not authenticate: it exited with its documented authentication-required status (4),
 * or GitHub answered HTTP 401. Network failures, timeouts and 5xx answers are never this.
 */
export class AuthenticationError extends Error {
  readonly authentication = true;
}

/**
 * The sanitized error for a failed `gh api graphql` run, decided from structured signals only:
 * the rate-limit discriminator, gh's exit status and the HTTP status gh reports. The message
 * keeps its general advice; callers must classify by type, never by message text.
 */
export function ghQueryFailure(error: unknown, response: GhResponse | null = null): Error {
  const evidence =
    response?.status !== null && response
      ? classifyGhFailure({ response, exitCode: prop(error, "code") })
      : null;
  const sameResponse = response ? sameResponseLimit(response) : null;
  if (sameResponse) return sameResponse;
  if (evidence?.category === "authentication")
    return new AuthenticationError(
      "GitHub refused the gh login. Run gh auth status (or gh auth login), then retry.",
    );
  const limited = rateLimitFailure(
    prop(error, "stderr"),
    response ? response.body : prop(error, "stdout"),
  );
  if (limited) return limited;
  const httpStatus = /\bHTTP (\d{3})\b/.exec(text(prop(error, "stderr")))?.[1];
  if (prop(error, "code") === 4 || httpStatus === "401")
    return new AuthenticationError(
      "GitHub refused the gh login. Run gh auth status (or gh auth login), then retry.",
    );
  // Do not echo subprocess arguments, stderr, credentials or private API response bodies.
  return new Error(
    "GitHub query failed. Check gh auth status, repository access and API rate limits.",
  );
}

/** gh output as a response, or null when it is not text or not framed as one. */
function responseOf(output: unknown): GhResponse | null {
  try {
    return parseGhResponse(text(output));
  } catch {
    return null;
  }
}

/**
 * A RateLimitError decided from one response's own evidence (#293): a registered rate-limit or
 * secondary-limit signal, with the quota headers of that same response. Its retry metadata is
 * only what that response proves: a reset only when the quota is exhausted, never a guess when
 * the headers contradict the refusal. Null when the response shows no rate limiting.
 */
function sameResponseLimit(response: GhResponse): RateLimitError | null {
  if (response.status === null) return null;
  const c = classifyGhFailure({ response });
  if (c.category !== "rate-limited" && c.category !== "secondary-rate-limit") return null;
  return new RateLimitError(
    rateLimitMessage(c),
    {
      retryAfterSeconds: c.observation.retryAfterSeconds,
      // The earliest proven retry time: an exhausted quota's reset, else an HTTP-date
      // Retry-After from this response (an explicit request, so schedulers honour it).
      resetAt:
        (c.quotaEvidence === "exhausted" ? c.observation.resetAt : null) ?? c.observation.retryAt,
    },
    c,
  );
}

/** Uncancellable production GraphQL boundary used by the CLI. */
export const ghQuery: Query = ghQueryWith();
/** Data from a GraphQL response whose errors are all NOT_FOUND, else null. */
export function graphqlAnswer(text: unknown): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(typeof text === "string" ? text : "");
    const errors = prop(parsed, "errors");
    const data = prop(parsed, "data");
    const notFoundOnly =
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors.every((e) => prop(e, "type") === "NOT_FOUND");
    return notFoundOnly && isRecord(data) ? data : null;
  } catch {
    return null;
  }
}
export interface RestAnswer {
  status: number | null;
  body: unknown;
  /**
   * Additive (#293): for a non-2xx answer, the failure classified from this same response's
   * status, headers and structured error fields. Absent on success or without headers.
   */
  evidence?: FailureClassification;
}
/**
 * Read-only REST GET. With `options.signal`, an implementation stops before starting and aborts
 * a running request; an aborted signal rejects rather than answering.
 */
export type Rest = (path: string, options?: { signal?: AbortSignal }) => Promise<RestAnswer>;

/** Read-only REST GET through gh (which follows GitHub's transfer redirects). */
export const ghRestWith =
  (bound?: AbortSignal): Rest =>
  async (path, options) => {
    const signal = options?.signal ?? bound;
    signal?.throwIfAborted();
    // --include: the status and quota headers come from this response itself (#293).
    try {
      const { stdout } = await execute("gh", ["api", "--include", path], {
        timeout: 30_000,
        signal,
      });
      const response = parseGhResponse(stdout);
      return { status: response.status ?? 200, body: JSON.parse(response.body) as unknown };
    } catch (error) {
      signal?.throwIfAborted();
      const response = responseOf(prop(error, "stdout"));
      let body: unknown = null;
      try {
        body = response ? (JSON.parse(response.body) as unknown) : null;
      } catch {
        body = null;
      }
      const status = response?.status ?? (Number(prop(body, "status")) || null);
      const timedOut = prop(error, "killed") === true && prop(error, "signal") === "SIGTERM";
      const evidence =
        response?.status !== null && response !== null
          ? classifyGhFailure({ response, exitCode: prop(error, "code"), timedOut })
          : undefined;
      return { status, body, ...(evidence ? { evidence } : {}) };
    }
  };
export const ghRest: Rest = ghRestWith();

interface LocationBase {
  repository: string;
  number: number;
  url: string;
  detail: string;
  next: string;
}
/** Why an issue number is unavailable, discriminated on `state`. */
export type IssueDiagnosis =
  | (LocationBase & {
      state: "moved";
      destination: { repository: string; number: unknown; url: unknown };
    })
  | (LocationBase & { state: "pull-request" | "missing" | "forbidden" | "unknown" });

/**
 * Why an issue number is unavailable (#39, doc/design/diagnostics.md): moved by transfer
 * (authoritative only when GitHub resolves it to another repository), a pull request,
 * missing, forbidden, or unknown. A missing or forbidden answer never implies a transfer.
 */
export async function locateIssue(
  repository: string,
  number: number,
  rest: Rest = ghRest,
): Promise<IssueDiagnosis> {
  const url = `https://github.com/${repository}/issues/${number}`;
  const { status, body } = await rest(`repos/${repository}/issues/${number}`);
  const base = { repository, number, url };
  const inspect = `gh api repos/${repository}/issues/${number}`;
  const repositoryUrl = prop(body, "repository_url");
  if (status === 200 && repositoryUrl) {
    const destination = String(repositoryUrl).replace(/^.*\/repos\//, "");
    const destNumber = prop(body, "number");
    const htmlUrl = prop(body, "html_url");
    if (destination.toLowerCase() !== repository.toLowerCase())
      return {
        ...base,
        state: "moved",
        destination: { repository: destination, number: destNumber, url: htmlUrl },
        detail: `Transferred to ${String(htmlUrl)}. It is not this project's work, and the destination's ownership is not assumed.`,
        next: `npm run --silent pdb -- --repo ${destination} --issue ${String(destNumber)} --json`,
      };
    if (prop(body, "pull_request"))
      return {
        ...base,
        state: "pull-request",
        detail: `#${number} is a pull request.`,
        next: `gh pr view ${number} --repo ${repository}`,
      };
    return {
      ...base,
      state: "unknown",
      detail: "REST found the issue but GraphQL did not; retry.",
      next: inspect,
    };
  }
  if (status === 404)
    return {
      ...base,
      state: "missing",
      detail:
        "Not found (deleted, never existed, or not visible to this account); not treated as a transfer.",
      next: inspect,
    };
  if (status === 403 || status === 401)
    return {
      ...base,
      state: "forbidden",
      detail: "Access denied; check gh auth status and repository access.",
      next: "gh auth status",
    };
  if (status === 410)
    return { ...base, state: "missing", detail: "Deleted (HTTP 410).", next: inspect };
  return {
    ...base,
    state: "unknown",
    detail: "GitHub gave no authoritative answer.",
    next: inspect,
  };
}

/** Thrown when `--issue N` cannot be read; carries the location diagnosis. */
/**
 * A read whose subject (a pull request, or an issue a report needs) does not exist or cannot be
 * read in that repository. Same message as before; the type lets services map it to "not
 * found" instead of a GitHub failure (#373).
 */
export class SubjectUnavailable extends Error {}

export class IssueUnavailable extends Error {
  readonly diagnosis: IssueDiagnosis;
  constructor(diagnosis: IssueDiagnosis) {
    super(`Issue #${diagnosis.number} is unavailable: ${diagnosis.state}. ${diagnosis.detail}`);
    this.diagnosis = diagnosis;
  }
}

/** Resolve the gh repository of the working directory (or of `cwd`, e.g. an MCP project). */
export async function currentRepository(cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { timeout: 30_000, cwd, signal },
    );
    return stdout.trim();
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Cannot resolve repository. Supply --repo owner/name and check gh authentication.",
    );
  }
}
const info = "pageInfo{hasNextPage endCursor}";
// Author type and edit history (#247) let the provenance reader apply the #212 trust rule; all
// are existing IssueComment/PullRequestReviewComment fields, so no request is added.
const comment =
  "databaseId body url author{__typename login} createdAt updatedAt lastEditedAt includesCreatedEdit editor{__typename login}";
const common = `number title body url state createdAt updatedAt lastEditedAt labels(first:100){nodes{name} ${info}} comments(first:100){nodes{${comment}} ${info}}`;
// The issue side of the closing link (#162): proves an issue has no open closing PR when an
// open PR's closing references are truncated.
const closedBy = `closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} ${info}}`;
const prFields = `${common} headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt
 closingIssuesReferences(first:100){nodes{number url} ${info}}
 reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){totalCount nodes{${comment}} ${info}}} ${info}}
 reviews(first:100){nodes{body url author{login} state submittedAt commit{oid}} ${info}}
 commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl databaseId} ... on StatusContext{context state targetUrl}} ${info}}}}}}`;

/** Cursor pagination also detects a broken/repeating cursor instead of spinning forever. */
export async function pages<T>(
  fetch: (cursor?: string) => Promise<unknown>,
  stop: (page: T[]) => boolean = () => false,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch(cursor);
    const nodes = prop(page, "nodes");
    const pageInfo = prop(page, "pageInfo");
    if (!Array.isArray(nodes) || !isRecord(pageInfo))
      throw new Error("Malformed GitHub connection.");
    const batch = trusted<T[]>(nodes);
    result.push(...batch);
    if (stop(batch) || !pageInfo.hasNextPage) return result;
    const next = pageInfo.endCursor;
    if (typeof next !== "string" || !next || seen.has(next))
      throw new Error("GitHub pagination did not advance.");
    seen.add(next);
    cursor = next;
  }
}

/** Only explicitly declared prerequisites, never every #mention in the body. */
export function declaredDependencies(body: string, repository: string): Reference[] {
  return declaredDependencyContexts(body, repository).map(({ repository, number, url }) => ({
    repository,
    number,
    url,
  }));
}
export type DeclaredReference = Reference & { context: string };
/** As declaredDependencies, with the declaring text kept for migration review. */
export function declaredDependencyContexts(body: string, repository: string): DeclaredReference[] {
  const refs = new Map<string, DeclaredReference>();
  let section = false;
  for (const original of body.split("\n")) {
    const line = original.replaceAll("**", "");
    if (/^\s*(?:#{1,6}\s*)?(?:dependencies|depends on|prerequisites)\s*:?\s*$/i.test(line)) {
      section = true;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      section = false;
      continue;
    }
    // Explicit declarations can follow an introductory sentence, but following incidental
    // references are not swallowed into the prerequisite list.
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const declaration = /^\s*(?:[-*]\s*)?(?:depends on|blocked by|requires)\b\s*:?\s*(.*)/i.exec(
        sentence,
      );
      const text = declaration?.[1] ?? (section && /^\s*[-*]\s/.test(sentence) ? sentence : "");
      const add = (repo: string, number: number, url: string) =>
        refs.set(`${repo}#${number}`, { repository: repo, number, url, context: sentence.trim() });
      for (const match of text.matchAll(
        /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g,
      ))
        add(match[1], Number(match[2]), match[0]);
      const local = text.replace(/https:\/\/github\.com\/[^\s)\]]+/g, "");
      for (const match of local.matchAll(/(?<![\w/])#([1-9]\d*)\b/g))
        add(repository, Number(match[1]), `https://github.com/${repository}/issues/${match[1]}`);
    }
  }
  return [...refs.values()];
}

export interface CollectOptions {
  since?: string;
  issue?: number;
  /** Injected issue-location diagnosis (production: `locateIssue`). */
  locate?: (repository: string, number: number) => Promise<IssueDiagnosis>;
  /**
   * Cancellation (MCP): stops further requests and, for the default gh boundaries, terminates
   * the running gh child processes. A cancelled collection rejects; it never returns a report.
   */
  signal?: AbortSignal;
  /**
   * Briefing mode only (#168): a resolved comparison window. Retains normalized all-state
   * change evidence with per-source coverage in `changeEvidence`. Exclusive with `since`.
   */
  changeWindow?: ComparisonWindow;
  /** Page cap per all-state source in change-evidence mode (default DEFAULT_CHANGE_PAGES). */
  maxChangePages?: number;
}
export async function collect(
  repository: string,
  options: CollectOptions = {},
  injected?: Query,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  // The production transport records one event per gh attempt for the additive metrics.github
  // summary (#293); an injected query keeps its own behaviour and adds no summary.
  const attempts: AttemptEvent[] = [];
  // The full intake keeps its promised inventory (contract: compatibility-full-v1); the meter
  // only records its cost, bytes and source coverage.
  const meter = new ReadMeter(
    "compatibility-full-v1",
    options.issue ? "issue-intake" : "snapshot",
    now,
    undefined,
    options.signal,
  );
  let query: Query = meter.query(
    injected ??
      ghQueryWith(options.signal, { operation: "snapshot", observer: (e) => attempts.push(e) }),
    "snapshot",
    repository,
  );
  const originalQuery = query;
  let requestCount = 0;
  query = (...args: Parameters<Query>) => {
    options.signal?.throwIfAborted();
    requestCount++;
    return originalQuery(...args);
  };
  const [owner, name] = repository.split("/");
  const vars = { owner: owner, name: name };
  const warnings: string[] = [];
  const startedAt = now().toISOString();
  let rateLimit: Snapshot["rateLimit"] = null;
  const request = async (source: string, variables: QueryVariables = {}): Promise<unknown> => {
    const data = await query(source, { ...vars, ...variables });
    rateLimit = selected<NonNullable<Snapshot["rateLimit"]>>(data.rateLimit) ?? rateLimit;
    const repo = data.repository;
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };
  const collection = async <T extends { updatedAt: string }>(
    field: string,
    fields: string,
    states: string,
    cutoff?: string,
  ): Promise<T[]> => {
    const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}${states}){nodes{${fields}} ${info}}} rateLimit{remaining resetAt}}`;
    const nodes = await pages<T>(
      async (cursor) => prop(await request(source, cursor ? { cursor } : {}), field),
      (batch) => !!cutoff && batch.some((node) => Date.parse(node.updatedAt) < Date.parse(cutoff)),
    );
    return cutoff
      ? nodes.filter((node) => Date.parse(node.updatedAt) >= Date.parse(cutoff))
      : nodes;
  };
  /**
   * All-state changes since `cutoff`, newest update first, stopping at the cutoff or after
   * `maxPages`. A cap hit before the cutoff is reported as incomplete coverage, never as
   * "nothing changed". Items updated during collection can shift between pages, so nodes are
   * deduplicated by URL and late updates (after T0) are retained: events are qualified later.
   */
  const boundedChanges = async <T extends { url: string; updatedAt: string }>(
    field: "issues" | "pullRequests",
    fields: string,
    states: string,
    cutoff: string,
    maxPages: number,
  ): Promise<[T[], SourceCoverage]> => {
    const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}${states}){nodes{${fields}} ${info}}} rateLimit{remaining resetAt}}`;
    let pageCount = 0;
    let reachedCutoff = false;
    let more = false;
    const nodes = await pages<T>(
      async (cursor) => {
        const page = prop(await request(source, cursor ? { cursor } : {}), field);
        pageCount++;
        more = prop(page, "pageInfo", "hasNextPage") === true;
        return page;
      },
      (batch) => {
        reachedCutoff = batch.some((node) => Date.parse(node.updatedAt) < Date.parse(cutoff));
        return reachedCutoff || pageCount >= maxPages;
      },
    );
    const unique = [
      ...new Map(
        nodes
          .filter((node) => Date.parse(node.updatedAt) >= Date.parse(cutoff))
          .map((node) => [node.url, node]),
      ).values(),
    ];
    const complete = reachedCutoff || !more;
    const label = field === "issues" ? "issues" : "pull-requests";
    return [
      unique,
      {
        source: label,
        complete,
        pages: pageCount,
        nodes: unique.length,
        omission: complete
          ? null
          : `${label} page cap (${maxPages} x 50) reached before ${cutoff}; older changes were not read.`,
      },
    ];
  };
  const locate =
    options.locate ??
    ((repo: string, number: number) => locateIssue(repo, number, ghRestWith(options.signal)));
  /**
   * For --issue N, a failed GraphQL read gets the read-only REST diagnosis. The failure itself
   * is never transfer evidence: only REST's own answer decides, and "unknown" keeps the error.
   */
  const diagnoseFailure = async (error: unknown): Promise<never> => {
    if (!options.issue) throw error;
    const diagnosis = await locate(repository, options.issue);
    if (diagnosis.state === "unknown") throw error;
    throw new IssueUnavailable(diagnosis);
  };
  const [issues, pullRequests] = await Promise.all([
    collection<Issue>(
      "issues",
      `${common} stateReason ${closedBy} ${nativeFields}`,
      ",states:OPEN",
    ),
    collection<PullRequest>("pullRequests", prFields, ",states:OPEN"),
  ]).catch(diagnoseFailure);
  const issueSource = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${common} stateReason ${nativeFields}}}}`;
  if (options.issue && !issues.some((issue) => issue.number === options.issue)) {
    const detail = selected<Issue>(
      prop(await request(issueSource, { number: options.issue }).catch(diagnoseFailure), "issue"),
    );
    if (!detail) throw new IssueUnavailable(await locate(repository, options.issue));
    issues.push(detail);
  }
  // All comments are available for semantic reconciliation, even if the briefing shows excerpts.
  await concurrentMap([...issues, ...pullRequests], async (item) => {
    if (item.comments.pageInfo.hasNextPage) {
      const source = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:100,after:$cursor){nodes{${comment}} ${info}}} ... on PullRequest{comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}`;
      const initial = item.comments;
      item.comments.nodes = await pages<Comment>(async (cursor) => {
        if (!cursor) return initial;
        const node = prop(
          await request(source, { number: item.number, cursor }),
          "issueOrPullRequest",
        );
        return prop(node, "comments");
      });
      item.comments.pageInfo = { hasNextPage: false, endCursor: null };
    }
    if (item.labels.pageInfo.hasNextPage)
      warnings.push(`${item.url}: labels exceed 100; label analysis incomplete.`);
  });
  for (const pr of pullRequests) {
    const nested: [string, Page<unknown> | undefined][] = [
      ["closing references", pr.closingIssuesReferences],
      ["review threads", pr.reviewThreads],
      ["reviews", pr.reviews],
      ["head checks", pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts],
    ];
    for (const [label, connection] of nested)
      if (connection?.pageInfo.hasNextPage)
        warnings.push(`${pr.url}: ${label} exceed 100; review/merge evidence incomplete.`);
  }
  // The same issue objects, now typed with their completed native evidence.
  const native = await concurrentMap(issues, (item) => completeNative(item, repository, query));
  const dependencies = [
    ...new Map(
      native
        .flatMap((item) => item.blockedBy.nodes)
        .map((item) => [
          item.url,
          { ...item, available: true, repository: item.repository.nameWithOwner },
        ]),
    ).values(),
  ];
  if (options.since && options.changeWindow)
    throw new Error("Choose either since or a change window, not both.");
  const since = options.since ?? options.changeWindow?.from ?? undefined;
  let changed: Snapshot["changed"] = [];
  let changeEvidence: Snapshot["changeEvidence"];
  if (since && options.changeWindow) {
    const window = options.changeWindow;
    const maxPages = options.maxChangePages ?? DEFAULT_CHANGE_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new Error("maxChangePages must be a positive integer.");
    const before = requestCount;
    const [issueNodes, issueCoverage] = await boundedChanges<EvidenceIssue>(
      "issues",
      `${common} stateReason ${nativeFields} ${issueEvidenceFields}`,
      ",states:[OPEN,CLOSED]",
      since,
      maxPages,
    );
    const [prNodes, prCoverage] = await boundedChanges<EvidencePullRequest>(
      "pullRequests",
      `${prFields} ${pullRequestEvidenceFields}`,
      ",states:[OPEN,CLOSED,MERGED]",
      since,
      maxPages,
    );
    changed = summarize([...issueNodes, ...prNodes]);
    const coverage = [issueCoverage, prCoverage];
    for (const item of coverage)
      if (!item.complete) warnings.push(`Change evidence incomplete: ${item.omission}`);
    changeEvidence = {
      schemaVersion: CHANGE_EVIDENCE_SCHEMA_VERSION,
      window,
      scope: { includes: CHANGE_SCOPE, excludes: CHANGE_SCOPE_EXCLUDES },
      coverage,
      complete: coverage.every((item) => item.complete),
      subjects: [
        ...issueNodes.map((node) => changeSubject("issue", node, window)),
        ...prNodes.map((node) => changeSubject("pull-request", node, window)),
      ],
      cost: { requests: requestCount - before, maxPagesPerSource: maxPages },
    };
  } else if (options.changeWindow) {
    // Baseline: no previous window, so nothing is labelled newly changed and no history query.
    changeEvidence = {
      schemaVersion: CHANGE_EVIDENCE_SCHEMA_VERSION,
      window: options.changeWindow,
      scope: { includes: CHANGE_SCOPE, excludes: CHANGE_SCOPE_EXCLUDES },
      coverage: [],
      complete: true,
      subjects: [],
      cost: { requests: 0, maxPagesPerSource: 0 },
    };
  } else if (since) {
    const values = await Promise.all([
      collection<Issue>(
        "issues",
        `${common} stateReason ${closedBy} ${nativeFields}`,
        ",states:[OPEN,CLOSED]",
        since,
      ),
      collection<PullRequest>("pullRequests", prFields, ",states:[OPEN,CLOSED,MERGED]", since),
    ]);
    changed = summarize([...values[0], ...values[1]]);
  }
  meter.cover("open-issues", repository, "complete");
  meter.cover("open-pull-requests", repository, "complete");
  if (options.issue) meter.cover("issue", `${repository}#${options.issue}`, "complete");
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    issues,
    pullRequests,
    dependencies,
    changed,
    since: since ?? null,
    ...(changeEvidence ? { changeEvidence } : {}),
    warnings,
    rateLimit,
    collection: meter.collection(),
    metrics: {
      requestCount,
      durationMs: Date.parse(now().toISOString()) - Date.parse(startedAt),
      ...(injected ? {} : { github: summarizeAttempts(attempts) }),
    },
  };
}

/** Options of a focused issue read. */
export interface FocusOptions {
  /** Records requests and coverage; the caller reports `meter.collection()`. */
  meter: ReadMeter;
  locate?: (repository: string, number: number) => Promise<IssueDiagnosis>;
  signal?: AbortSignal;
}
/**
 * One issue and the open pull requests in the same repository that would close it
 * (issue-detail-v1, #367): no repository inventory. The issue's comments and each linked PR's
 * comments are read completely, as the full snapshot reads them; the linked-PR list is bounded
 * by the profile and an unread continuation is reported, never treated as "no PR". A linked PR
 * that fails or is not attempted (after a quota refusal) is a warning and `failed` or
 * `not-attempted` coverage, so the result is incomplete rather than silently smaller.
 *
 * The result is a snapshot of that ticket only. It carries its focused `collection` record and
 * must never be read as a repository inventory.
 */
export async function collectIssueFocus(
  repository: string,
  number: number,
  options: FocusOptions,
  base: Query = ghQueryWith(options.signal),
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const { meter, signal } = options;
  const bounds = readProfiles["issue-detail-v1"].bounds;
  const startedAt = now().toISOString();
  const [owner, name] = repository.split("/");
  const subject = `${repository}#${number}`;
  const warnings: string[] = [];
  const locate =
    options.locate ?? ((repo: string, n: number) => locateIssue(repo, n, ghRestWith(signal)));
  const read = async (q: Query, source: string, variables: QueryVariables) => {
    signal?.throwIfAborted();
    const data = await q(source, { owner, name, ...variables });
    if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
    return data.repository;
  };
  const commentsSource = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:100,after:$cursor){nodes{${comment}} ${info}}} ... on PullRequest{comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}}`;
  /** The whole comment history, as the full snapshot reads it (the existing unbounded read). */
  const completeComments = async (item: Issue, q: Query) => {
    if (!item.comments.pageInfo.hasNextPage) return;
    const initial = item.comments;
    item.comments.nodes = await pages<Comment>(async (cursor) => {
      if (!cursor) return initial;
      const node = prop(
        await read(q, commentsSource, { number: item.number, cursor }),
        "issueOrPullRequest",
      );
      return prop(node, "comments");
    });
    item.comments.pageInfo = { hasNextPage: false, endCursor: null };
  };

  const issueQuery = meter.query(base, "issue", subject);
  let issue: Issue | null;
  try {
    issue = selected<Issue>(
      prop(
        await read(
          issueQuery,
          `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${common} stateReason ${closedBy}}}}`,
          { number },
        ),
        "issue",
      ),
    );
  } catch (error) {
    signal?.throwIfAborted();
    // A quota refusal sends nothing more, not even the location diagnosis.
    if (quotaRefusal(error)) throw error;
    // As collect: only REST's own answer decides; "unknown" keeps the original failure.
    const diagnosis = await locate(repository, number);
    if (diagnosis.state === "unknown") throw error;
    throw new IssueUnavailable(diagnosis);
  }
  if (!issue) throw new IssueUnavailable(await locate(repository, number));
  meter.cover("issue", subject, "complete");
  await completeComments(issue, meter.query(base, "comments", subject));
  meter.cover("comments", subject, "complete");
  if (issue.labels.pageInfo.hasNextPage) {
    warnings.push(`${issue.url}: labels exceed 100; label analysis incomplete.`);
    meter.cover("labels", subject, "partial", { omission: "labels beyond the first 100" });
  } else meter.cover("labels", subject, "complete");
  for (const source of ["native-blocked-by", "native-blocking"])
    meter.cover(source, subject, "not-requested", { omission: "not needed for ownership" });

  // Linked open PRs, from the issue side of the closing link; bounded pages.
  // An absent connection is not "no PR": it stays an unread continuation (partial).
  const linked = issue.closedByPullRequestsReferences ?? {
    nodes: [],
    pageInfo: { hasNextPage: true, endCursor: null },
  };
  const references = [...linked.nodes];
  let pageInfo = linked.pageInfo;
  let linkedPages = 1;
  const linkQuery = meter.query(base, "linked-pull-requests", subject);
  while (pageInfo.hasNextPage && linkedPages < bounds.linkedPullRequestPages) {
    const cursor = pageInfo.endCursor;
    if (!cursor) break;
    const page = selected<Page<{ number: number; url: string; state: string }>>(
      prop(
        await read(
          linkQuery,
          `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:${bounds.linkedPullRequestsPerPage},includeClosedPrs:false,after:$cursor){nodes{number url state} ${info}}}}}`,
          { number, cursor },
        ),
        "issue",
        "closedByPullRequestsReferences",
      ),
    );
    if (!page || page.pageInfo.endCursor === cursor) break;
    references.push(...page.nodes);
    pageInfo = page.pageInfo;
    linkedPages++;
  }
  if (pageInfo.hasNextPage) {
    const omission = `linked pull requests beyond ${references.length} (${linkedPages} pages of ${bounds.linkedPullRequestsPerPage}) not read`;
    warnings.push(`${issue.url}: ${omission}; ownership evidence incomplete.`);
    meter.cover("linked-pull-requests", subject, "partial", { omission });
  } else meter.cover("linked-pull-requests", subject, "complete");
  // The full snapshot holds only this repository's open PRs: keep the same population.
  const prefix = `https://github.com/${repository}/pull/`.toLowerCase();
  const targets = [
    ...new Map(
      references
        .filter((ref) => ref.state === "OPEN" && ref.url.toLowerCase().startsWith(prefix))
        .map((ref) => [ref.number, ref]),
    ).values(),
  ];
  const pullRequests = await hydratePullRequests(
    repository,
    targets,
    { meter, signal, warnings, role: "linked" },
    base,
  );
  const telemetry = meter.collection().telemetry;
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    issues: [issue],
    pullRequests,
    dependencies: [],
    changed: [],
    since: null,
    warnings,
    rateLimit:
      telemetry.rateLimit?.remaining != null && telemetry.rateLimit.resetAt
        ? { remaining: telemetry.rateLimit.remaining, resetAt: telemetry.rateLimit.resetAt }
        : null,
    metrics: {
      requestCount: telemetry.requests,
      durationMs: Date.parse(now().toISOString()) - Date.parse(startedAt),
    },
    collection: meter.collection(),
  };
}

/**
 * Hydrate open PRs of `repository` with the snapshot's PR fields and full comment history, at
 * most `hydrationConcurrency` at once (issue-detail-v1, #367). Returns the PRs that are open; a
 * closed or merged one is read but left out, as the full snapshot holds open PRs only. A failed
 * read is `failed` coverage and a warning; after a quota refusal the rest are `not-requested`,
 * listed in `meter.notAttempted` and warned about. Nothing unread is ever reported absent.
 */
export async function hydratePullRequests(
  repository: string,
  targets: readonly { number: number; url: string }[],
  options: {
    meter: ReadMeter;
    signal?: AbortSignal;
    /** Receives a warning for every PR whose evidence is incomplete or unknown. */
    warnings: string[];
    /** How the PR relates to the ticket, for warnings: a closing link or a delivery member. */
    role: "linked" | "delivery member";
  },
  base: Query = ghQueryWith(options.signal),
): Promise<PullRequest[]> {
  const { meter, signal, warnings, role } = options;
  const bounds = readProfiles["issue-detail-v1"].bounds;
  const [owner, name] = repository.split("/");
  const read = async (q: Query, source: string, variables: QueryVariables) => {
    signal?.throwIfAborted();
    const data = await q(source, { owner, name, ...variables });
    if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
    return data.repository;
  };
  const commentsSource = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on PullRequest{comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}}`;
  const completeComments = async (item: PullRequest, q: Query) => {
    if (!item.comments.pageInfo.hasNextPage) return;
    const initial = item.comments;
    item.comments.nodes = await pages<Comment>(async (cursor) => {
      if (!cursor) return initial;
      const node = prop(
        await read(q, commentsSource, { number: item.number, cursor }),
        "issueOrPullRequest",
      );
      return prop(node, "comments");
    });
    item.comments.pageInfo = { hasNextPage: false, endCursor: null };
  };
  const hydrated = await hydrate(
    targets,
    async (ref) => {
      const prSubject = `${repository}#${ref.number}`;
      const q = meter.query(base, "pull-request", prSubject);
      const pr = selected<PullRequest>(
        prop(
          await read(
            q,
            `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${prFields}}}}`,
            { number: ref.number },
          ),
          "pullRequest",
        ),
      );
      if (!pr) throw new Error("not readable");
      await completeComments(pr, q);
      return pr;
    },
    { concurrency: bounds.hydrationConcurrency, signal },
  );
  const pullRequests: PullRequest[] = [];
  hydrated.forEach((outcome, index) => {
    const ref = targets[index];
    const prSubject = `${repository}#${ref.number}`;
    if (outcome.state === "done") {
      // Only open PRs belong to the population; ticketOwnership keeps those whose closing
      // references still name this issue, exactly as it does over a full snapshot.
      const pr = outcome.value;
      if (pr.state !== "OPEN") {
        meter.cover("pull-request", prSubject, "complete");
        return;
      }
      pullRequests.push(pr);
      const nested: [string, Page<unknown> | undefined][] = [
        ["closing references", pr.closingIssuesReferences],
        ["review threads", pr.reviewThreads],
        ["reviews", pr.reviews],
        ["head checks", pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts],
      ];
      const partial = nested.filter(([, c]) => c?.pageInfo.hasNextPage).map(([label]) => label);
      for (const label of partial)
        warnings.push(`${pr.url}: ${label} exceed 100; review/merge evidence incomplete.`);
      if (pr.labels.pageInfo.hasNextPage)
        warnings.push(`${pr.url}: labels exceed 100; label analysis incomplete.`);
      meter.cover(
        "pull-request",
        prSubject,
        partial.length ? "partial" : "complete",
        partial.length ? { omission: `${partial.join(", ")} beyond the first 100` } : {},
      );
    } else if (outcome.state === "failed") {
      const rateLimited = quotaRefusal(outcome.error);
      warnings.push(
        `${ref.url}: ${role} pull request could not be read${rateLimited ? " (rate limited)" : ""}; its ownership and review evidence is unknown.`,
      );
      meter.cover("pull-request", prSubject, "failed", {
        failure: rateLimited ? "rate-limited" : "read-failed",
      });
    } else {
      meter.notAttempted.push(ref.url);
      warnings.push(
        `${ref.url}: ${role} pull request not read after a rate-limit refusal; its evidence is unknown.`,
      );
      meter.cover("pull-request", prSubject, "not-requested", {
        omission: "not attempted after a quota refusal",
      });
    }
  });
  return pullRequests;
}

const summarize = (nodes: (Issue | PullRequest)[]): Snapshot["changed"] =>
  nodes.map(({ number, title, url, state, updatedAt }) => ({
    number,
    title,
    url,
    state,
    updatedAt,
  }));

/** Bounded independent reads; results retain input order. */
export async function concurrentMap<T, R>(
  items: readonly T[],
  handler: (item: T, index: number) => Promise<R> | R,
  concurrency = 4,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index], index);
      }
    }),
  );
  return results;
}

/** Raw GraphQL response: data plus any errors, never thrown for GraphQL-level errors. */
export interface GraphqlAnswer {
  readonly data: unknown;
  readonly errors: readonly { type?: string; message?: string }[];
}

/** Injected authenticated GraphQL boundary. `query` is read-only; `mutate` changes GitHub. */
export interface GraphqlApi {
  query(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
  mutate(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
}

async function ghGraphql(query: string, variables: Record<string, string>): Promise<GraphqlAnswer> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
  let stdout: unknown;
  try {
    ({ stdout } = await execute("gh", args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) {
    // gh exits non-zero on GraphQL errors but still prints the response body.
    stdout = prop(error, "stdout");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof stdout === "string" ? stdout : "");
  } catch {
    // Never echo arguments, stderr or response bodies.
    throw new Error("GitHub query failed. Check gh auth status, network and API rate limits.");
  }
  const errors = prop(parsed, "errors");
  return {
    data: prop(parsed, "data"),
    errors: Array.isArray(errors) ? errors.filter(isRecord) : [],
  };
}

/** Production GraphQL boundary through the existing authenticated `gh` (no shell). */
export const ghGraphqlApi: GraphqlApi = { query: ghGraphql, mutate: ghGraphql };

/**
 * A user's current permission on a repository (#212), as GitHub's REST collaborator-permission
 * endpoint reports it, or `unknown` when it cannot be established.
 */
export type RepositoryPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none"
  | "unknown";
/** Looks up one login's current repository permission; never throws. */
export type PermissionLookup = (login: string) => Promise<RepositoryPermission>;
const rolePermissions = new Set<RepositoryPermission>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);
/** Permissions that may drive workflow writes through a comment marker (#212). */
export const writePermissions: ReadonlySet<RepositoryPermission> = new Set([
  "admin",
  "maintain",
  "write",
]);

/**
 * A per-run permission lookup over the injected read-only REST boundary:
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, one request per distinct login
 * (case-insensitive) for the lifetime of the returned function, never persisted across runs.
 * `role_name` is preferred; a custom role falls back on the legacy `permission` field. A non-200
 * answer (404, missing access, rate limit), a transport error, a body for another user or an
 * unrecognised value is `unknown`, which grants nothing.
 */
export function permissionLookup(
  repository: string,
  rest: Rest = ghRest,
  signal?: AbortSignal,
): PermissionLookup {
  const cache = new Map<string, Promise<RepositoryPermission>>();
  const lookup = async (login: string): Promise<RepositoryPermission> => {
    // A cancelled run starts no further requests and never reports a partial answer as unknown.
    signal?.throwIfAborted();
    // A GitHub user login; anything else (an app's `name[bot]`, a malformed value) is never asked.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return "unknown";
    try {
      const answer = await rest(
        `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        signal ? { signal } : undefined,
      );
      if (answer.status !== 200 || !isRecord(answer.body)) return "unknown";
      const user = prop(answer.body, "user", "login");
      if (typeof user === "string" && user.toLowerCase() !== login.toLowerCase()) return "unknown";
      const role = prop(answer.body, "role_name");
      if (typeof role === "string" && rolePermissions.has(role as RepositoryPermission))
        return role as RepositoryPermission;
      const legacy = prop(answer.body, "permission");
      return typeof legacy === "string" && ["admin", "write", "read", "none"].includes(legacy)
        ? (legacy as RepositoryPermission)
        : "unknown";
    } catch {
      signal?.throwIfAborted();
      return "unknown";
    }
  };
  return (login) => {
    const key = login.toLowerCase();
    let answer = cache.get(key);
    if (!answer) {
      answer = lookup(login);
      cache.set(key, answer);
    }
    return answer;
  };
}
