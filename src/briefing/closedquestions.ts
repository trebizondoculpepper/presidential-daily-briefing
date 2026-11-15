/**
 * Questions on closed sources (#414). Contract: doc/reports/closed-question-discovery.md and
 * doc/design/human-briefing.md "Closed sources".
 *
 * A ticket closing (by a merged PR, by hand or as not planned) does not answer its questions.
 * This collector reads closed issues within a fixed request budget, hydrates their comment
 * histories, folds explicit resolve/withdraw records against the exact question they name, and
 * hands the human policy trust, version and outcome facts. It never decides what is shown: the
 * D-HUMAN-ORPHANED* rules do. Whatever it could not read is reported as incomplete coverage,
 * never as "no question" or "answered".
 */
import type { Comment, Issue } from "../github/types.js";
import { comment as commentFields, common, info, prop } from "../github/github.js";
import type { Query, QueryVariables, Rest } from "../github/github.js";
import type { QuestionRecordFact } from "../rules/datalog/datalog.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { parseQuestionMarker, questionMarkerPrefix } from "../workflow/claims.js";
import {
  classifyMarkers,
  foldQuestionResolutions,
  parseResolutionComment,
} from "../workflow/claimactivity.js";
import type { ActivityComment } from "../workflow/claimactivity.js";
import { parseQuestionRecord } from "./questionrecord.js";
import type { HumanRecord } from "./questionrecord.js";

/** Request bounds of one closed-source read. */
export interface ClosedQuestionBounds {
  requests: number;
  inventoryPages: number;
  commentPages: number;
  pageSize: number;
}
export const closedQuestionPolicy: Readonly<ClosedQuestionBounds> = {
  /** GitHub requests per read: inventory pages, comment pages and permission lookups together. */
  requests: 13,
  /** Closed-issue inventory pages, newest update first. */
  inventoryPages: 3,
  /** Follow-up comment pages, rotated across sources so none monopolises the budget. */
  commentPages: 10,
  /** Rows per page. */
  pageSize: 100,
};

/** What the bounded closed-source read covered; `complete` only when nothing was left unread. */
export interface ClosedSourceCoverage {
  read: true;
  complete: boolean;
  bounds: ClosedQuestionBounds;
  requests: number;
  inventory: { pages: number; rows: number; complete: boolean };
  /** Closed issues read in the inventory. */
  discovered: number;
  /** Closed issues whose whole comment history was read. */
  hydrated: number;
  /** Closed issues with comment pages left unread, by URL. */
  pending: string[];
  /** Permission lookups that could not be made or answered. */
  permissionGaps: number;
  records: {
    /** Trusted records with no explicit outcome; a legacy v1 one may still be resolved by labels. */
    noOutcome: number;
    unknown: number;
    resolved: number;
    withdrawn: number;
    untrusted: number;
    unverified: number;
  };
  startedAt: string;
  fetchedAt: string;
  failure: string | null;
}
/** Closed-source discovery that did not run (offline, cached, or no GraphQL boundary). */
export interface ClosedSourceNotRead {
  read: false;
  complete: false;
  why: string;
}

/** A closed source carrying at least one trusted question the policy must consider. */
export interface ClosedSource {
  issue: Issue;
  facts: QuestionRecordFact[];
  /** Trusted records not settled by an explicit outcome, newest first. */
  records: HumanRecord[];
}
export interface ClosedQuestions {
  read: true;
  sources: ClosedSource[];
  coverage: ClosedSourceCoverage;
  /** `${url}: …` warnings; every one also makes the coverage incomplete. */
  warnings: string[];
}

export interface ClosedQuestionRuntime {
  query: Query;
  /** Permission REST boundary; each lookup consumes the same budget. */
  rest?: Rest;
  /** Builds the #212 trust rule over a (budgeted) REST boundary. */
  trustWith?: (rest: Rest) => TrustDecision;
  /** Fallback trust when no REST boundary is given; its lookups are not budgeted here. */
  trust?: TrustDecision;
  now?: () => Date;
  signal?: AbortSignal;
  bounds?: Partial<ClosedQuestionBounds>;
}

const inventorySource = (size: number) =>
  `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:${size},after:$cursor,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${common}} ${info}}} rateLimit{remaining resetAt}}`;
const commentsSource = (size: number) =>
  `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:${size},after:$cursor){nodes{${commentFields}} ${info}}}}}}`;

class BudgetExhausted extends Error {}

const pageOf = (value: unknown): { nodes: unknown[]; more: boolean; cursor: string | null } => {
  const nodes = prop(value, "nodes");
  const cursor = prop(value, "pageInfo", "endCursor");
  if (!Array.isArray(nodes)) throw new Error("the response has no page of nodes");
  return {
    nodes,
    more: prop(value, "pageInfo", "hasNextPage") === true,
    cursor: typeof cursor === "string" ? cursor : null,
  };
};

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Read closed issues and their question records within the bounds. `exclude` holds URLs already
 * read as open in the snapshot, which keep the open-ticket contract.
 */
export async function discoverClosedQuestions(
  repository: string,
  runtime: ClosedQuestionRuntime,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ClosedQuestions> {
  const bounds: ClosedQuestionBounds = { ...closedQuestionPolicy, ...runtime.bounds };
  const now = runtime.now ?? (() => new Date());
  const signal = runtime.signal;
  const [owner, name] = repository.split("/");
  const startedAt = now().toISOString();
  const warnings: string[] = [];
  let used = 0;
  let permissionGaps = 0;
  const take = () => {
    if (used >= bounds.requests) throw new BudgetExhausted();
    used++;
  };
  const request = async (source: string, variables: QueryVariables) => {
    take();
    const data = await runtime.query(source, {
      owner: owner ?? "",
      name: name ?? "",
      ...variables,
    });
    const repo = prop(data, "repository");
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };
  // Permission lookups spend the same budget; past it they answer nothing, which the #212 rule
  // reads as unknown authority (missing evidence), never as trusted or untrusted.
  const budgetedRest: Rest | undefined = runtime.rest
    ? async (path, options) => {
        if (used >= bounds.requests) {
          permissionGaps++;
          return { status: null, body: null };
        }
        used++;
        return runtime.rest!(path, options);
      }
    : undefined;
  const trust = budgetedRest && runtime.trustWith ? runtime.trustWith(budgetedRest) : runtime.trust;

  // 1. Inventory: closed issues, newest update first. GraphQL `issues` excludes pull requests.
  const issues = new Map<string, Issue>();
  const hasNext = new Map<string, string | null>();
  let pages = 0;
  let rows = 0;
  let inventoryComplete = false;
  let failure: string | null = null;
  let cursor: string | null = null;
  try {
    while (pages < bounds.inventoryPages) {
      signal?.throwIfAborted();
      const page = pageOf(
        prop(await request(inventorySource(bounds.pageSize), cursor ? { cursor } : {}), "issues"),
      );
      pages++;
      rows += page.nodes.length;
      for (const node of page.nodes as Issue[]) {
        // Pages of a mutable list can shift: deduplicate, keeping the first observation.
        if (node.state !== "CLOSED" || exclude.has(node.url) || issues.has(node.url)) continue;
        issues.set(node.url, node);
        if (node.comments.pageInfo.hasNextPage)
          hasNext.set(node.url, node.comments.pageInfo.endCursor);
      }
      if (!page.more || !page.cursor) {
        inventoryComplete = true;
        break;
      }
      cursor = page.cursor;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof BudgetExhausted)) failure = `inventory: ${failureText(error)}`;
  }
  if (!inventoryComplete)
    warnings.push(
      failure
        ? `${repository}: the closed-issue inventory failed after ${pages} page(s) (${failure}); questions on unread closed tickets are unknown.`
        : `${repository}: closed tickets beyond the ${rows} most recently updated were not read (bound: ${bounds.inventoryPages} page(s) of ${bounds.pageSize}); questions on them are unknown, not absent.`,
    );

  // 2. Hydrate truncated comment histories, one page per source in rotation.
  const comments = new Map<string, Comment[]>(
    [...issues].map(([url, issue]) => [url, [...issue.comments.nodes]]),
  );
  let commentPages = 0;
  const queue = [...hasNext.keys()];
  try {
    while (queue.length && commentPages < bounds.commentPages) {
      signal?.throwIfAborted();
      const url = queue.shift()!;
      const issue = issues.get(url)!;
      const page = pageOf(
        prop(
          await request(commentsSource(bounds.pageSize), {
            number: issue.number,
            ...(hasNext.get(url) ? { cursor: hasNext.get(url)! } : {}),
          }),
          "issueOrPullRequest",
          "comments",
        ),
      );
      commentPages++;
      comments.get(url)!.push(...(page.nodes as Comment[]));
      if (page.more && page.cursor) {
        hasNext.set(url, page.cursor);
        queue.push(url);
      } else hasNext.delete(url);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof BudgetExhausted))
      failure = [failure, `comments: ${failureText(error)}`].filter(Boolean).join("; ");
  }
  const pending = [...hasNext.keys()];
  for (const url of pending)
    warnings.push(
      `${url}: closed ticket's comment history was not fully read within the bound; its questions and their resolutions are unknown.`,
    );

  // 3. Fold each source's question records and explicit outcomes.
  const counts = {
    noOutcome: 0,
    unknown: 0,
    resolved: 0,
    withdrawn: 0,
    untrusted: 0,
    unverified: 0,
  };
  const sources: ClosedSource[] = [];
  for (const [url, issue] of issues) {
    signal?.throwIfAborted();
    const all = comments.get(url)!;
    if (!all.some((c) => (c.body ?? "").includes(questionMarkerPrefix))) continue;
    const historyComplete = !hasNext.has(url);
    const candidates: { comment: Comment; record: HumanRecord }[] = [];
    for (const comment of all) {
      const record = parseQuestionRecord(comment);
      if (!record) continue;
      const marker = parseQuestionMarker(comment.body ?? "");
      if (
        marker?.version === 2 &&
        (marker.repository.toLowerCase() !== repository.toLowerCase() ||
          marker.issue !== issue.number)
      ) {
        warnings.push(
          `${url}: question record ${comment.url} is bound to ${marker.repository}#${marker.issue}; ignored.`,
        );
        continue;
      }
      if (marker?.version === "malformed") {
        counts.unverified++;
        warnings.push(
          `${url}: question record ${comment.url} has a malformed marker (${marker.why}); ignored.`,
        );
        continue;
      }
      candidates.push({ comment, record });
    }
    if (!candidates.length) continue;
    if (!trust) {
      counts.unverified += candidates.length;
      warnings.push(
        `${url}: question record authors' permissions were not read; questions on this closed ticket are unverified.`,
      );
      continue;
    }
    const ordered = all.filter(
      (c) => typeof c.databaseId === "number" && typeof c.createdAt === "string",
    ) as ActivityComment[];
    const questionIds = new Map(
      candidates
        .filter((c) => typeof c.comment.databaseId === "number")
        .map((c) => [String(c.comment.databaseId), c.record.opId]),
    );
    const folded = foldQuestionResolutions(
      await classifyMarkers(
        ordered,
        { repository, issue: issue.number },
        trust,
        parseResolutionComment,
      ),
      questionIds,
    );
    for (const gap of folded.unknown)
      warnings.push(`${url}: a question-resolution record could not be verified (${gap}).`);
    const facts: QuestionRecordFact[] = [];
    const records: HumanRecord[] = [];
    const seen = new Set<string>();
    for (const { comment, record } of [...candidates].reverse()) {
      if (seen.has(record.marker)) continue;
      seen.add(record.marker);
      const authority = await trust(comment);
      if (authority.status === "untrusted") {
        counts.untrusted++;
        continue;
      }
      if (authority.status === "unknown") {
        counts.unverified++;
        warnings.push(
          `${url}: authority of the question record ${record.url} on this closed ticket could not be verified (${authority.why}).`,
        );
        continue;
      }
      const id = typeof comment.databaseId === "number" ? String(comment.databaseId) : null;
      const outcome = id ? folded.outcomes.get(id) : undefined;
      const state: NonNullable<QuestionRecordFact["outcome"]> = outcome
        ? outcome.op === "resolve"
          ? "resolved"
          : "withdrawn"
        : !id || !historyComplete || folded.unknown.length
          ? "unknown"
          : "none";
      if (state === "resolved") counts.resolved++;
      else if (state === "withdrawn") counts.withdrawn++;
      else if (state === "unknown") counts.unknown++;
      else counts.noOutcome++;
      if (state === "unknown" && !id)
        warnings.push(
          `${url}: question record ${record.url} has no comment id; its resolution is unknown.`,
        );
      facts.push({ trust: "trusted", to: record.to, version: record.version, outcome: state });
      if (state === "none" || state === "unknown") records.push(record);
    }
    if (facts.length)
      sources.push({
        issue: { ...issue, comments: { ...issue.comments, nodes: all } },
        facts,
        records,
      });
  }
  if (permissionGaps)
    warnings.push(
      `${repository}: ${permissionGaps} permission lookup(s) for closed-ticket records exceeded the request bound; those records are unverified.`,
    );
  const coverage: ClosedSourceCoverage = {
    read: true,
    complete: inventoryComplete && !pending.length && !failure && !warnings.length,
    bounds,
    requests: used,
    inventory: { pages, rows, complete: inventoryComplete },
    discovered: issues.size,
    hydrated: issues.size - pending.length,
    pending,
    permissionGaps,
    records: counts,
    startedAt,
    fetchedAt: now().toISOString(),
    failure,
  };
  return { read: true, sources, coverage, warnings };
}
