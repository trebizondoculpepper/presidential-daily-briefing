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
import type { GraphQuery } from "../workflow/claims.js";
import {
  classifyMarkers,
  foldClaimActivity,
  parseActivityComment,
  type ActivityComment,
} from "../workflow/claimactivity.js";
import { workflow } from "../workflow/definition.js";
import { readRetained } from "../workflow/retained.js";
import { evaluateDatalog } from "../rules/datalog/adapter.js";
import {
  collectDeliveryFacts,
  deliveryMemberCap,
  evaluateDelivery,
} from "../workflow/completion.js";
import { legacyRelease } from "../workflow/deliverables.js";
import type { DeliverablesRuntime } from "../workflow/deliverables.js";
import { classifyDeliveryRecords, foldDelivery } from "../workflow/delivery.js";
import type { DeliveryComment } from "../workflow/delivery.js";
import { assessmentGroups } from "./assessment.js";
import type { CompletionVerdict } from "./aggregate.js";
import { ticketLedger } from "./ledger.js";
import type { LedgerFacts, LedgerPullRequest, LedgerTrust } from "./ledger.js";
import type { HistoryCoverage, InventoryFacts, InventoryStage, MetricTicket } from "./views.js";
import { createGhService } from "../github/service/service.js";
import type { HistoryIssue } from "../github/service/history.js";

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
  // Typed GH reads over the same counted, cancellable executors (#931): no GraphQL here.
  const gh = createGhService({ query, rest }).history;
  const warnings: string[] = [];
  const fromMs = Date.parse(from);
  const nowDate = new Date(now);

  // 1. Walk all-state issues back to the window start.
  const walked: HistoryIssue[] = [];
  let cursor: string | null = null;
  let reachedStart = false;
  let oldest: string | null = null;
  for (let page = 0; page < bounds.maxPages; page++) {
    const result = await gh.issuesByUpdate(repository, cursor);
    for (const n of result.nodes) {
      oldest = n.updatedAt;
      if (Date.parse(n.updatedAt) < fromMs) {
        reachedStart = true;
        break;
      }
      walked.push(n);
    }
    if (reachedStart || !result.hasNextPage) {
      reachedStart = true;
      break;
    }
    cursor = result.endCursor;
  }
  const issueFrom = reachedStart ? from : oldest;
  if (!reachedStart) warnings.push(`issue walk stopped at ${bounds.maxPages} pages before ${from}`);

  // 1a. Current open inventory, whatever its update time: quiet open tickets are exactly what a
  // window walk misses, and open work belongs in timing (contract: current state uses the full
  // open-issue inventory). Beyond the page cap the rest is unknown.
  let openComplete = false;
  let openCursor: string | null = null;
  for (let page = 0; page < bounds.maxPages; page++) {
    const result = await gh.openIssues(repository, openCursor);
    for (const issue of result.nodes)
      if (!walked.some((i) => i.number === issue.number)) walked.push(issue);
    if (!result.hasNextPage) {
      openComplete = true;
      break;
    }
    openCursor = result.endCursor;
  }
  if (!openComplete) warnings.push(`open inventory stopped at ${bounds.maxPages} pages`);

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
    const result = await gh.mergedPulls(repository, prCursor);
    for (const pr of result.nodes) {
      prOldest = pr.updatedAt;
      if (Date.parse(pr.updatedAt) < fromMs) {
        prReachedStart = true;
        break;
      }
      const inWindow = pr.mergedAt !== null && Date.parse(pr.mergedAt) >= fromMs;
      if (inWindow && Date.parse(pr.mergedAt!) < Date.parse(now))
        merges.push({ at: pr.mergedAt!, key: `${repository}#${pr.number}` });
      if (inWindow && pr.closesTruncated)
        unreadLinked.push(`${repository} PR #${pr.number}: closing references beyond 50`);
      if (inWindow)
        for (const ref of pr.closes)
          if (ref.repository.toLowerCase() === repository.toLowerCase()) linked.add(ref.number);
    }
    if (prReachedStart || !result.hasNextPage) {
      prReachedStart = true;
      break;
    }
    prCursor = result.endCursor;
  }
  if (!prReachedStart)
    warnings.push(`pull request walk stopped at ${bounds.maxPages} pages before ${from}`);
  const prFrom = prReachedStart ? from : prOldest;
  const completeFrom = issueFrom === null || prFrom === null ? null : latest(issueFrom, prFrom);
  // Linked lookups share the ticket bound, counted by attempts (failed lookups included), so
  // unreadable references can never exceed it; beyond it they are unread, not fetched.
  let linkedBudget = Math.max(0, bounds.maxTickets - walked.length);
  for (const number of linked) {
    if (walked.some((i) => i.number === number)) continue;
    if (linkedBudget <= 0) {
      unreadLinked.push(member(number));
      continue;
    }
    linkedBudget--;
    let issue: HistoryIssue | null;
    try {
      issue = await gh.issue(repository, number);
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
      let node: { number: number; state: string; mergedAt: string | null } | null;
      try {
        node = await gh.pullState(pr.repository, pr.number);
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
    const assessment = await assessmentGroups(
      {
        labels: issue.labels ?? { nodes: [], pageInfo: { hasNextPage: true } },
        lastEditedAt: issue.lastEditedAt ?? null,
        comments,
        commentsComplete,
      },
      rt.trust.comment,
    );
    let inventory: InventoryFacts | undefined;
    if (issue.state === "OPEN") {
      const labelsComplete = issue.labels ? !issue.labels.pageInfo.hasNextPage : false;
      const labelNames = new Set((issue.labels?.nodes ?? []).map((l) => l.name));
      const blocked: boolean | null =
        issue.openBlockers !== null && issue.openBlockers !== undefined
          ? issue.openBlockers > 0
          : null;
      const ownerLabels = [...labelNames].filter((l) => l.startsWith(workflow.ownerPrefix));
      let stage: InventoryStage = "unknown";
      if (labelsComplete) {
        if (
          assessment.complexity.group === "unassessed" ||
          assessment.impact.group === "unassessed"
        ) {
          stage = "unassessed";
        } else if (
          labelNames.has("status:awaiting-review") ||
          (issue.openClosingPrs !== null &&
            issue.openClosingPrs !== undefined &&
            issue.openClosingPrs > 0)
        ) {
          stage = "in-review";
        } else if (ownerLabels.length > 0) {
          stage = "claimed";
        } else if (blocked === true) {
          stage = "blocked";
        } else if (issue.openClosingPrs === 0) {
          // Delegate readiness to the canonical native Datalog evaluator rather than checking labels alone.
          type DatalogSnapshot = Parameters<typeof evaluateDatalog>[0];
          const url = `https://github.com/${repository}/issues/${issue.number}`;
          const datalog = evaluateDatalog(
            {
              schemaVersion: 1,
              repository,
              fetchedAt: now,
              warnings: [],
              issues: [
                {
                  number: issue.number,
                  title: `#${issue.number}`,
                  url,
                  state: "OPEN",
                  createdAt: issue.createdAt,
                  updatedAt: issue.updatedAt,
                  labels: issue.labels,
                  assignees: { nodes: [] },
                  issueDependenciesSummary:
                    issue.openBlockers === 0
                      ? { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 }
                      : null,
                  blockedBy:
                    issue.openBlockers === 0
                      ? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
                      : undefined,
                  closedByPullRequestsReferences: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  comments: { totalCount: issue.comments.totalCount, nodes: [] },
                } as unknown as DatalogSnapshot["issues"][number],
              ],
              pullRequests: [],
              findings: [],
            } as unknown as DatalogSnapshot,
            new Map(),
            {
              role: "implementer",
              limit: 50,
              ownedClaims: { urls: [], complete: true },
              signal: rt.signal,
            },
          );
          if (datalog.items.some((a) => a.kind === "implement" && a.target === url)) {
            stage = "ready";
          }
        }
      }
      let waiting: boolean | null = null;
      if (ownerLabels.length === 1 && commentsComplete) {
        const ownerLabel = ownerLabels[0]!;
        const ownerAgent = ownerLabel.slice(workflow.ownerPrefix.length);
        const latestClaimAdd =
          history.events
            .filter((e) => e.__typename === "LabeledEvent" && e.label.name === ownerLabel)
            .map((e) => e.createdAt)
            .sort((a, b) => a.localeCompare(b))
            .at(-1) ?? null;
        const classifiedActivity = await classifyMarkers(
          comments as ActivityComment[],
          { repository, issue: issue.number },
          rt.trust.comment,
          parseActivityComment,
        );
        const activity = foldClaimActivity(classifiedActivity, {
          agent: ownerAgent,
          claimStartedAt: latestClaimAdd,
          historyComplete: commentsComplete,
        });
        if (activity.state === "waiting") {
          try {
            const permission = async (login: string) => {
              const t = await rt.trust.actor({ __typename: "User", login });
              return t.status === "trusted"
                ? "write"
                : t.status === "untrusted"
                  ? "read"
                  : "unknown";
            };
            const retained = await readRetained(
              repository,
              issue.number,
              ownerAgent,
              query,
              permission,
            );
            waiting =
              retained.activity.state === "waiting"
                ? true
                : retained.activity.state === "active"
                  ? false
                  : null;
          } catch (error) {
            if (rt.signal?.aborted) throw error;
            waiting = null;
          }
        } else {
          waiting = activity.state === "active" ? false : null;
        }
      } else if (
        commentsComplete &&
        !comments.some((c) => c.body.includes("github-triage:claim-activity"))
      ) {
        waiting = false;
      }
      inventory = {
        stage,
        createdAt: issue.createdAt,
        lastObservedChangeAt: issue.updatedAt,
        blocked,
        waiting,
        claimed: ownerLabels.length > 0,
      };
    }
    tickets.push({
      member: member(issue.number),
      ledger,
      verdict: verdictOf(evaluateDelivery(facts).delivery),
      complexity: assessment.complexity.group,
      assessment,
      ...(inventory ? { inventory } : {}),
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
