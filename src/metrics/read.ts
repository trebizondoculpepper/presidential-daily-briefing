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
import { collectDeliveryFacts, evaluateDelivery } from "../workflow/completion.js";
import { legacyRelease } from "../workflow/deliverables.js";
import type { DeliverablesRuntime } from "../workflow/deliverables.js";
import { classifyDeliveryRecords, foldDelivery } from "../workflow/delivery.js";
import type { DeliveryComment } from "../workflow/delivery.js";
import { scanProvenance } from "../estimation/estimate.js";
import { complexityMetric } from "../estimation/metrics.js";
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
}

interface WalkIssue {
  number: number;
  createdAt: string;
  updatedAt: string;
  state: string;
  closedAt: string | null;
  stateReason: string | null;
  comments: { totalCount: number; nodes: Comment[] };
}

const commentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";
const walkQuery = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:50,after:$cursor,states:[OPEN,CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number createdAt updatedAt state closedAt stateReason comments(first:100){totalCount nodes{${commentFields}}}} pageInfo{hasNextPage endCursor}}}}`;
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state mergedAt}}}`;

function prop(v: unknown, k: string): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
}

/** Latest valid complexity group (owner decision), from trusted provenance only. */
async function complexityGroup(
  comments: Comment[],
  complete: boolean,
  trust: LedgerTrust,
): Promise<string> {
  const scan = await scanProvenance(complexityMetric, comments, trust.comment);
  if (scan.status === "trusted") return complete ? scan.provenance.size : "unknown";
  if (scan.status === "unknown" || !complete) return "unknown";
  return "unassessed";
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
  const counted = { query, rest: rt.rest } as Pick<DeliverablesRuntime, "query" | "rest">;
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
  const completeFrom = reachedStart ? from : oldest;
  if (!reachedStart) warnings.push(`issue walk stopped at ${bounds.maxPages} pages before ${from}`);

  // 2. Ledgers, verdicts and groups for the first `maxTickets` tickets.
  const member = (n: number) => `${repository}#${n}`;
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
    let prsComplete = true;
    for (const pr of first.requiredPullRequests ?? []) {
      const [o, nm] = pr.repository.split("/") as [string, string];
      const node = prop(
        prop(await query(prQuery, { owner: o, name: nm, number: pr.number }), "repository"),
        "pullRequest",
      ) as { number: number; state: string; mergedAt: string | null } | null | undefined;
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
      { ...base, pullRequests: { nodes: prs, complete: prsComplete } },
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
    const facts = await collectDeliveryFacts(
      { repository, issue: issue.number, issueOpen: issue.state === "OPEN", fold, legacyHandoff },
      counted,
    );
    tickets.push({
      member: member(issue.number),
      ledger,
      verdict: verdictOf(evaluateDelivery(facts).delivery),
      complexity: await complexityGroup(comments, commentsComplete, rt.trust),
    });
  }
  if (skipped.length)
    warnings.push(
      `${skipped.length} ticket(s) beyond the ${bounds.maxTickets}-ticket bound were not read`,
    );

  return {
    tickets,
    // A ticket's events are never later than its updatedAt, and skipped tickets are the least
    // recently updated, so history stays complete back to the newest skipped update.
    coverage: {
      completeFrom: skippedIssues.length
        ? latest(skippedIssues[0]!.updatedAt, completeFrom)
        : completeFrom,
    },
    historyNotRead: { count: skipped.length, members: skipped },
    requests,
    warnings,
  };
}
