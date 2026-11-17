/**
 * Bounded metrics read (#573 slice 5b): collects the tickets a metrics window needs and turns
 * them into `MetricTicket`s for the pure views in views.ts
 * (doc/design/dashboard-pipeline-metrics.md "Reads, cache and budgets").
 *
 * Its own read through the injected GraphQL/REST boundaries, so the shared briefing collector is
 * unchanged. Every bound that is hit is reported, never treated as "nothing happened":
 * - all-state issues, newest update first, until the window start or `maxPages`; history is
 *   complete only back to the oldest update actually reached;
 * - per ticket, the first 100 comments (partial beyond that), the bounded label/closure
 *   timeline, and the required pull requests' merge times;
 * - at most `maxTickets` tickets get a ledger; the rest are counted as "history not read".
 */

import { ticketHistory } from "../workflow/claims.js";
import type { Comment, GraphQuery } from "../workflow/claims.js";
import {
  collectDeliveryFacts,
  deliveryMemberCap,
  evaluateDelivery,
} from "../workflow/completion.js";
import { legacyRelease } from "../workflow/deliverables.js";
import type { DeliverablesRuntime } from "../workflow/deliverables.js";
import { classifyDeliveryRecords, foldDelivery } from "../workflow/delivery.js";
import type { DeliveryComment } from "../workflow/delivery.js";
import { classifyEstimate, complexityProvenanceDecision } from "../estimation/estimation.js";
import { labelSizeReading } from "../estimation/complexitylabels.js";
import type { CompletionVerdict } from "./aggregate.js";
import { ticketLedger } from "./ledger.js";
import type { LedgerFacts, LedgerPullRequest, LedgerTrust } from "./ledger.js";
import type { HistoryCoverage, MetricTicket } from "./views.js";

export interface MetricsReadBounds {
  /** Pages of 50 issues walked back from now. */
  maxPages: number;
  /** Tickets that get a ledger, timeline and verdict. */
  maxTickets: number;
}
export const DEFAULT_METRICS_BOUNDS: MetricsReadBounds = { maxPages: 10, maxTickets: 100 };

export interface MetricsReadRuntime extends Pick<DeliverablesRuntime, "query" | "rest"> {
  trust: LedgerTrust;
  signal?: AbortSignal;
}

export interface MetricsRead {
  tickets: MetricTicket[];
  coverage: HistoryCoverage;
  /** Tickets updated in the window that got no ledger because of `maxTickets`. */
  historyNotRead: { count: number; members: string[] };
  /** Requests made by this read. */
  requests: number;
  warnings: string[];
  /**
   * Every in-window merge from the pull request walk, keyed by PR: the PR-merge series is its
   * own unit, independent of delivery membership (standalone PRs included).
   */
  merges: { at: string; key: string }[];
  /** Structural limits of this read, always stated so an absence is never assumed. */
  limitations: string[];
}

interface WalkPr {
  number: number;
  updatedAt: string;
  mergedAt: string | null;
  closingIssuesReferences?: {
    nodes: { number: number; repository: { nameWithOwner: string } }[];
    pageInfo?: { hasNextPage?: boolean };
  };
}

interface WalkIssue {
  number: number;
  createdAt: string;
  updatedAt: string;
  state: string;
  closedAt: string | null;
  stateReason: string | null;
  lastEditedAt?: string | null;
  labels?: { nodes: { name: string }[]; pageInfo?: { hasNextPage?: boolean } };
  comments: { totalCount: number; nodes: Comment[] };
}

const commentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";
const issueFields =
  "number createdAt updatedAt lastEditedAt state closedAt stateReason labels(first:100){nodes{name} pageInfo{hasNextPage}} comments(first:100){totalCount nodes{" +
  commentFields +
  "}}";
const walkQuery = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:50,after:$cursor,states:[OPEN,CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${issueFields}} pageInfo{hasNextPage endCursor}}}}`;
const prWalkQuery = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:50,after:$cursor,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt mergedAt closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}`;
const issueQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${issueFields}}}}`;
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state mergedAt}}}`;

function prop(v: unknown, k: string): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
}

/**
 * Latest valid complexity group (owner decision), through the same classifier as the
 * estimation report: a valid size, or explicit stale, conflict, unknown and unassessed groups.
 */
async function complexityGroup(
  issue: WalkIssue,
  complete: boolean,
  trust: LedgerTrust,
): Promise<string> {
  const labels = issue.labels ?? { nodes: [], pageInfo: { hasNextPage: true } };
  const reading = labelSizeReading({ labels } as Parameters<typeof labelSizeReading>[0]);
  const decision =
    reading.kind === "known" && reading.size !== null
      ? await complexityProvenanceDecision(issue.comments.nodes, !complete, trust.comment)
      : { authority: "none" as const, record: null, ignored: [] };
  const { state, size } = classifyEstimate(reading, decision, {
    lastEditedAt: issue.lastEditedAt ?? null,
    historyIncomplete: !complete,
    evidence: "complexity size label",
  });
  switch (state) {
    case "estimated":
      return size ?? "unknown";
    case "stale":
      return "stale";
    case "conflicting":
      return "conflict";
    case "unestimated":
      return "unassessed";
    default:
      return "unknown";
  }
}

/** The later of two instants; null (never complete) wins. */
function latest(a: string, b: string | null): string | null {
  if (b === null) return null;
  return Date.parse(a) > Date.parse(b) ? a : b;
}

/** Map the completion evaluator's delivery onto the verdicts the views take. */
function verdictOf(delivery: string): CompletionVerdict {
  if (delivery === "delivered" || delivery === "attested" || delivery === "unknown")
    return delivery;
  return "none";
}

export async function readMetrics(
  repository: string,
  from: string,
  now: string,
  rt: MetricsReadRuntime,
  bounds: MetricsReadBounds = DEFAULT_METRICS_BOUNDS,
): Promise<MetricsRead> {
  const [owner, name] = repository.split("/") as [string, string];
  let requests = 0;
  const query: GraphQuery = (q, v) => {
    rt.signal?.throwIfAborted();
    requests++;
    return rt.query(q, v);
  };
  // REST evidence (target containment compares) goes through the same counter and
  // pre-request cancellation check as GraphQL.
  const rest: DeliverablesRuntime["rest"] = (...args) => {
    rt.signal?.throwIfAborted();
    requests++;
    return rt.rest(...args);
  };
  const counted: Pick<DeliverablesRuntime, "query" | "rest"> = { query, rest };
  const warnings: string[] = [];
  const fromMs = Date.parse(from);
  const nowDate = new Date(now);

  // 1. Walk all-state issues back to the window start.
  const walked: WalkIssue[] = [];
  let cursor: string | null = null;
  let reachedStart = false;
  let oldest: string | null = null;
  for (let page = 0; page < bounds.maxPages; page++) {
    const data = await query(walkQuery, { owner, name, ...(cursor ? { cursor } : {}) });
    const conn = prop(prop(data, "repository"), "issues");
    if (!conn) throw new Error(`Repository unavailable: ${repository}`);
    const nodes = (prop(conn, "nodes") as WalkIssue[] | undefined) ?? [];
    for (const n of nodes) {
      oldest = n.updatedAt;
      if (Date.parse(n.updatedAt) < fromMs) {
        reachedStart = true;
        break;
      }
      walked.push(n);
    }
    const info = prop(conn, "pageInfo");
    if (reachedStart || prop(info, "hasNextPage") !== true) {
      reachedStart = true;
      break;
    }
    cursor = (prop(info, "endCursor") as string | null) ?? null;
  }
  const issueFrom = reachedStart ? from : oldest;
  if (!reachedStart) warnings.push(`issue walk stopped at ${bounds.maxPages} pages before ${from}`);

  // 1b. Merged pull requests by their own update time: a merge need not update its ticket, so
  // tickets closed by an in-window merge are added even when the issue walk did not reach them.
  const member = (n: number) => `${repository}#${n}`;
  const linked = new Set<number>();
  const merges: { at: string; key: string }[] = [];
  // Population the read knows about but could not ledger; passed on as unread.
  const unreadLinked: string[] = [];
  let prCursor: string | null = null;
  let prReachedStart = false;
  let prOldest: string | null = null;
  for (let page = 0; page < bounds.maxPages; page++) {
    const conn = prop(
      prop(
        await query(prWalkQuery, { owner, name, ...(prCursor ? { cursor: prCursor } : {}) }),
        "repository",
      ),
      "pullRequests",
    );
    if (!conn) throw new Error(`Repository unavailable: ${repository}`);
    for (const pr of (prop(conn, "nodes") as WalkPr[] | undefined) ?? []) {
      prOldest = pr.updatedAt;
      if (Date.parse(pr.updatedAt) < fromMs) {
        prReachedStart = true;
        break;
      }
      if (
        pr.mergedAt &&
        Date.parse(pr.mergedAt) >= fromMs &&
        Date.parse(pr.mergedAt) < Date.parse(now)
      )
        merges.push({ at: pr.mergedAt, key: `${repository}#${pr.number}` });
      if (
        pr.mergedAt &&
        Date.parse(pr.mergedAt) >= fromMs &&
        pr.closingIssuesReferences?.pageInfo?.hasNextPage
      )
        unreadLinked.push(`${repository} PR #${pr.number}: closing references beyond 50`);
      if (pr.mergedAt && Date.parse(pr.mergedAt) >= fromMs)
        for (const ref of pr.closingIssuesReferences?.nodes ?? [])
          if (ref.repository.nameWithOwner.toLowerCase() === repository.toLowerCase())
            linked.add(ref.number);
    }
    const info = prop(conn, "pageInfo");
    if (prReachedStart || prop(info, "hasNextPage") !== true) {
      prReachedStart = true;
      break;
    }
    prCursor = (prop(info, "endCursor") as string | null) ?? null;
  }
  if (!prReachedStart)
    warnings.push(`pull request walk stopped at ${bounds.maxPages} pages before ${from}`);
  const prFrom = prReachedStart ? from : prOldest;
  const completeFrom = issueFrom === null || prFrom === null ? null : latest(issueFrom, prFrom);
  for (const number of linked) {
    if (walked.some((i) => i.number === number)) continue;
    // Linked lookups share the ticket bound: beyond it they are unread, not fetched.
    if (walked.length >= bounds.maxTickets) {
      unreadLinked.push(member(number));
      continue;
    }
    let issue: WalkIssue | null | undefined;
    try {
      issue = prop(
        prop(await query(issueQuery, { owner, name, number }), "repository"),
        "issue",
      ) as WalkIssue | null | undefined;
    } catch (error) {
      if (rt.signal?.aborted) throw error;
      issue = null;
    }
    if (issue) walked.push(issue);
    else {
      warnings.push(`issue #${number}, closed by an in-window merge, could not be read`);
      unreadLinked.push(member(number));
    }
  }

  // 2. Ledgers, verdicts and groups for the first `maxTickets` tickets.
  const selected = walked.slice(0, bounds.maxTickets);
  const skippedIssues = walked.slice(bounds.maxTickets);
  const skipped = skippedIssues.map((i) => member(i.number));
  const tickets: MetricTicket[] = [];
  for (const issue of selected) {
    rt.signal?.throwIfAborted();
    const comments = issue.comments.nodes;
    const commentsComplete = issue.comments.totalCount <= comments.length;
    const history = await ticketHistory(repository, issue.number, query);
    const base: LedgerFacts = {
      issue: {
        repository,
        number: issue.number,
        createdAt: issue.createdAt,
        state: issue.state,
        closedAt: issue.closedAt,
        stateReason: issue.stateReason,
      },
      comments: { nodes: comments, complete: commentsComplete },
      history,
      pullRequests: null,
    };
    // First pass learns the required PRs; read their merges, then build the final ledger.
    const first = await ticketLedger(base, rt.trust, nowDate);
    const prs: LedgerPullRequest[] = [];
    // Unknown membership means the required set itself is unknown: the PR source stays unread,
    // never an empty, complete set.
    const required = first.requiredPullRequests;
    let prsComplete = required !== null;
    // The same member cap as the completion collector: a huge deliverable set is read no
    // further, and the PR source stays incomplete with a notice rather than costing a request
    // per member.
    if (required && required.length > deliveryMemberCap) {
      prsComplete = false;
      warnings.push(
        `${member(issue.number)}: ${required.length} required pull requests exceed the cap of ${deliveryMemberCap}; their merges were not read`,
      );
    }
    for (const pr of (required ?? []).slice(0, deliveryMemberCap)) {
      const [o, nm] = pr.repository.split("/") as [string, string];
      let node: { number: number; state: string; mergedAt: string | null } | null | undefined;
      try {
        node = prop(
          prop(await query(prQuery, { owner: o, name: nm, number: pr.number }), "repository"),
          "pullRequest",
        ) as { number: number; state: string; mergedAt: string | null } | null | undefined;
      } catch (error) {
        // An inaccessible deliverable is missing evidence for this ticket, not a failed read;
        // cancellation still propagates.
        if (rt.signal?.aborted) throw error;
        node = null;
      }
      if (!node) prsComplete = false;
      else
        prs.push({
          repository: pr.repository,
          number: node.number,
          state: node.state,
          mergedAt: node.mergedAt,
        });
    }
    const ledger = await ticketLedger(
      { ...base, pullRequests: required === null ? null : { nodes: prs, complete: prsComplete } },
      rt.trust,
      nowDate,
    );

    // Verdict from the shared completion evaluator over the same delivery fold.
    const classified = await classifyDeliveryRecords(
      comments as DeliveryComment[],
      { repository, issue: issue.number },
      rt.trust.comment,
    );
    const fold = foldDelivery(classified, commentsComplete);
    const legacyHandoff =
      !fold.hasTrustedRecord &&
      !!(await legacyRelease(comments as DeliveryComment[], rt.trust.comment)).trusted;
    rt.signal?.throwIfAborted();
    const facts = await collectDeliveryFacts(
      { repository, issue: issue.number, issueOpen: issue.state === "OPEN", fold, legacyHandoff },
      counted,
    );
    // Evidence readers turn failed requests (aborts included) into missing evidence, so a
    // cancellation during collection must be re-checked here, not mistaken for a partial result.
    rt.signal?.throwIfAborted();
    tickets.push({
      member: member(issue.number),
      ledger,
      verdict: verdictOf(evaluateDelivery(facts).delivery),
      complexity: await complexityGroup(issue, commentsComplete, rt.trust),
    });
  }
  if (skipped.length)
    warnings.push(
      `${skipped.length} ticket(s) beyond the ${bounds.maxTickets}-ticket bound were not read`,
    );

  rt.signal?.throwIfAborted();
  return {
    tickets,
    // A ticket's events are never later than its updatedAt, and skipped tickets are the least
    // recently updated, so history stays complete back to the newest skipped update.
    coverage: {
      completeFrom: skippedIssues.length
        ? latest(skippedIssues[0]!.updatedAt, completeFrom)
        : completeFrom,
    },
    historyNotRead: {
      count: skipped.length + unreadLinked.length,
      members: [...skipped, ...unreadLinked],
    },
    requests,
    warnings,
    merges,
    limitations: [
      "a deliverable in another repository that merges without updating or closing its ticket is not discovered",
    ],
  };
}
