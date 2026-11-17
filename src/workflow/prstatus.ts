import { evaluateCheckPolicy, evaluatePrReadiness } from "../rules/datalog/engine.js";
import {
  hydrateRequiredChecks,
  requiredCheckEvidence,
  type RequiredChecks,
} from "../github/requiredchecks.js";
/**
 * "Why is this pull request not progressing?" in one operation (#59).
 * Contract: doc/design/diagnostics.md, "#59".
 *
 * Reports every blocker at once from current evidence: required-check outcomes classified as
 * passed / pending / cancelled / failed / missing / unknown, bounded failure detail, review
 * state with the reviewed commit against the current head, unresolved threads with later
 * replies, review receipts posted as comments, unanswered review requests, conflicts, linked
 * issues and their explicit owners. Green evidence means "inspect / consider merging", never
 * approval.
 */
import { workflow } from "./definition.js";
import {
  codexCommitMatches,
  codexMarker,
  codexReceiptMatchesPrefix,
  codexReviewReceipt,
} from "./reviewevidence.js";
import type { CodexMarker } from "./reviewevidence.js";
import {
  evaluateReviewPolicy,
  policyNotRead,
  reviewPolicyText,
  reviewProviders,
  snapshotPolicyReview,
} from "./reviewpolicy.js";
import type { DeclaredReviewPolicy, ReviewPolicyDetail } from "./reviewpolicy.js";
import type { PullRequest } from "../github/types.js";
export { codexMarker };
export type { CodexMarker, CodexReviewState } from "./reviewevidence.js";
import { ghQuery, ghRest, prop, selected, SubjectUnavailable } from "../github/github.js";
import type { Query, Rest } from "../github/github.js";
import type { ReadMeter } from "../github/readplan.js";

type Login = { __typename?: string; login: string } | null;
type PageInfo = { hasNextPage?: boolean; hasPreviousPage?: boolean };
type CheckContext = {
  databaseId?: number | null;
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** The GitHub App that published a check run: provider identity, never its display name. */
  checkSuite?: { app: { slug: string; databaseId?: number } | null } | null;
  /** Whether GitHub requires this check for this PR (#343); null/absent is unknown. */
  isRequired?: boolean | null;
};
type ReviewNode = {
  author: Login;
  state: string;
  submittedAt: string | null;
  url: string;
  commit: { oid: string } | null;
};
type ThreadComment = { author: Login; body?: string; createdAt: string | null; url: string };
type ThreadNode = {
  isResolved: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  first?: { totalCount?: number; nodes: ThreadComment[] } | null;
  latest?: { nodes: ThreadComment[] } | null;
};
type CommentNode = { author: Login; body: string | null; createdAt: string; url: string };
type LinkedIssueNode = {
  number: number;
  url: string;
  title: string;
  state: string;
  labels: { nodes: { name: string }[] };
};
/** The pull request as selected by `query` below. */
export type PullRequestNode = {
  requiredChecks?: RequiredChecks;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  merged?: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision?: string | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  commits: {
    nodes: {
      commit: {
        oid?: string;
        statusCheckRollup: {
          state?: string;
          contexts: { nodes: CheckContext[]; pageInfo: PageInfo };
        } | null;
      };
    }[];
  };
  reviews: { nodes: ReviewNode[]; pageInfo?: PageInfo };
  reviewThreads: { nodes: ThreadNode[]; pageInfo: PageInfo };
  comments: { nodes: CommentNode[]; pageInfo?: PageInfo };
  closingIssuesReferences: { nodes: LinkedIssueNode[]; pageInfo?: PageInfo };
};

/**
 * `advisory-pending` (#343): still running, but GitHub reports it is not required for this PR;
 * shown, never a waiting blocker. A pending check with unknown requiredness stays `pending`.
 */
export type CheckClass =
  | "passed"
  | "pending"
  | "advisory-pending"
  | "cancelled"
  | "failed"
  | "unknown";
export type Receipt = {
  by: string;
  at: string;
  url: string;
  summary: string;
  codexState: CodexMarker | null;
};
export type PrStatusReport = {
  schemaVersion: 1;
  kind: "pr-status";
  repository: string;
  fetchedAt: string;
  startedAt: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    state: string;
    draft: boolean;
    head: string;
    branch: string;
    base: string;
    mergeable: string;
    mergeState: string;
    reviewDecision: string | null;
    updatedAt: string;
  };
  checks: {
    /** Deprecated singular convention; null when requirements are a target-specific set. */
    required: { name: string; class: CheckClass; outcome: string; url: string } | null;
    requirements?: {
      expected: RequiredChecks["expected"];
      complete: boolean;
      gaps: string[];
      head: string | null;
      base: string | null;
    };
    policy?: ReturnType<typeof evaluateCheckPolicy>;
    evidence?: ReturnType<typeof requiredCheckEvidence>;
    counts: Record<string, number>;
    problems: { name: string; class: CheckClass; outcome: string; url: string; note?: string }[];
    omittedProblems: number;
  };
  reviews: {
    reviewer: string;
    state: string;
    submittedAt: string | null;
    reviewedCommit: string | null;
    current: boolean;
    url: string;
  }[];
  threads: {
    unresolved: {
      path: string | null;
      line: number | null;
      outdated: boolean;
      finding: string;
      by: string;
      url: string;
      replies: number;
      lastSpeaker: string | null;
      lastAt: string | null;
    }[];
    omitted: number;
  };
  receipts: Receipt[];
  /** Earlier receipts dropped by the presentation limit. */
  omittedReceipts: number;
  /**
   * #341 head acceptance over every fetched review and receipt (before the presentation limit):
   * an approval or clean Codex receipt bound to the current head, vetoed by head findings.
   */
  headReviewed: boolean;
  /**
   * A known finding on the current head under the effective review policy: a Codex receipt
   * (all receipts, #192), or with a declared provider policy any configured provider (#301).
   */
  headFindings: boolean;
  /** Declared review policy, per-provider head state and coverage (#301). */
  reviewPolicy: ReviewPolicyDetail;
  reviewRequest: { at: string; url: string; status: string } | null;
  linkedIssues: {
    number: number;
    url: string;
    title: string;
    state: string;
    owners: string[];
  }[];
  blockers: string[];
  verdict: string;
  completeness: { complete: boolean; warnings: string[] };
};

const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title url state isDraft merged mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName updatedAt
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name databaseId status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$number) checkSuite{app{slug databaseId}}} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage}}}}}}
reviews(last:50){nodes{author{__typename login} state submittedAt url commit{oid}} pageInfo{hasPreviousPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line first:comments(first:1){totalCount nodes{author{__typename login} body createdAt url}} latest:comments(last:1){nodes{author{login} createdAt url}}} pageInfo{hasNextPage}}
comments(last:100){nodes{author{__typename login} body createdAt url} pageInfo{hasPreviousPage}}
closingIssuesReferences(first:10){nodes{number url title state labels(first:50){nodes{name}}} pageInfo{hasNextPage}}}}}`;

/** Bounds keep the report small; omitted counts are always reported. */
export const limits = { failures: 5, threads: 8, receipts: 3, excerpt: 240 };

export const excerpt = (text: string | null | undefined): string => {
  const flat = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limits.excerpt ? `${flat.slice(0, limits.excerpt - 1)}…` : flat;
};

/** Classify one check context. Cancelled is incomplete verification, not a code defect. */
export function classifyCheck(check: CheckContext): CheckClass {
  const status = check.status ?? null;
  const outcome = check.conclusion ?? check.state ?? null;
  if (status && status !== "COMPLETED" && !check.conclusion) return "pending";
  if (outcome === null) return "unknown";
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(outcome))
    return "pending";
  if (workflow.pass.includes(outcome)) return "passed";
  if (outcome === "CANCELLED") return "cancelled";
  if (workflow.failure.includes(outcome)) return "failed";
  return "unknown";
}

const isBot = (login: string | undefined): boolean =>
  /\[bot\]$|^coderabbitai$|^chatgpt-codex-connector$|^copilot-pull-request-reviewer$/.test(
    login ?? "",
  );
const requestPattern = /@(codex|coderabbitai)\s+review\b/i;
/** The account that answers each review request; other bots never count as an answer. */
const reviewerFor: Record<string, string> = {
  codex: "chatgpt-codex-connector",
  coderabbitai: "coderabbitai",
};

/**
 * Build the report from a fetched pull request. Pure; `now` is injected.
 */
export function prStatus(
  repository: string,
  pr: PullRequestNode,
  {
    now = new Date(),
    startedAt,
    reviewPolicy = policyNotRead,
  }: { now?: Date; startedAt?: string; reviewPolicy?: DeclaredReviewPolicy } = {},
): PrStatusReport {
  const head = pr.headRefOid;
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const checkEvidence = requiredCheckEvidence(pr);
  const contexts = (rollup?.contexts.nodes ?? []).map((c, index) => ({
    name: c.name ?? c.context ?? "unnamed",
    outcome: c.conclusion ?? c.state ?? c.status ?? "UNKNOWN",
    class: ((cls) =>
      cls === "pending" && checkEvidence.checks[index]?.required === "advisory"
        ? "advisory-pending"
        : cls)(classifyCheck(c)) as CheckClass,
    url: c.detailsUrl ?? c.targetUrl ?? pr.url,
    noRunTime: c.__typename === "CheckRun" && !c.startedAt,
  }));
  const checkPolicy = evaluateCheckPolicy(checkEvidence);
  // Legacy singular detail is factual only; readiness comes exclusively from the native query.
  const requiredContexts = contexts.filter(
    (_, index) => checkEvidence.checks[index]?.required === "required",
  );
  const required = requiredContexts.length === 1 ? requiredContexts[0]! : null;
  const byClass = (k: CheckClass) => contexts.filter((c) => c.class === k);
  const problems = [...byClass("failed"), ...byClass("cancelled")];

  // Reviews: latest per reviewer, with the commit reviewed against the current head.
  const latestByReviewer = new Map<string, ReviewNode>();
  for (const r of pr.reviews.nodes) {
    const who = r.author?.login ?? "unknown";
    const prev = latestByReviewer.get(who);
    if (!prev || (r.submittedAt ?? "") > (prev.submittedAt ?? "")) latestByReviewer.set(who, r);
  }
  const reviews = [...latestByReviewer.values()].map((r) => ({
    reviewer: r.author?.login ?? "unknown",
    state: r.state,
    submittedAt: r.submittedAt,
    reviewedCommit: r.commit?.oid ?? null,
    current: r.commit?.oid === head,
    url: r.url,
  }));

  // Threads: unresolved first-comment findings, with later replies and who spoke last.
  const unresolved = pr.reviewThreads.nodes.filter((t) => !t.isResolved);
  const threads = unresolved.map((t) => {
    // The finding is the thread's first comment; the last speaker is its latest comment, read
    // separately so a long thread is never cut off before its newest reply.
    const opening = t.first?.nodes[0];
    const last = t.latest?.nodes[0] ?? opening;
    return {
      path: t.path ?? null,
      line: t.line ?? null,
      outdated: !!t.isOutdated,
      finding: excerpt(opening?.body),
      by: opening?.author?.login ?? "unknown",
      url: opening?.url ?? pr.url,
      replies: Math.max(0, (t.first?.totalCount ?? 1) - 1),
      lastSpeaker: last?.author?.login ?? null,
      lastAt: last?.createdAt ?? null,
    };
  });

  // Review receipts may be ordinary comments; requests are comments asking for a review.
  const comments = pr.comments.nodes;
  const receipts = comments
    .filter((c) => isBot(c.author?.login))
    .map((c) => ({
      by: c.author?.login ?? "unknown",
      at: c.createdAt,
      url: c.url,
      summary: excerpt(c.body).slice(0, 160),
      codexState: codexMarker(c.body),
    }));
  const codex =
    receipts
      .map((r) => r.codexState)
      .filter((m): m is CodexMarker => m !== null)
      .at(-1)?.code_review ?? null;
  // Bots often update one summary comment in place, so a receipt's creation time does not show
  // whether a later request was answered. Codex's state marker records the commit it reviewed.
  // Bot replies often quote "@coderabbitai review" as an instruction; only non-bot comments
  // count as requests, so a receipt can never replace the request it answers.
  const lastRequest =
    comments.filter((c) => !isBot(c.author?.login) && requestPattern.test(c.body ?? "")).at(-1) ??
    null;
  const requested =
    reviewerFor[(requestPattern.exec(lastRequest?.body ?? "")?.[1] ?? "").toLowerCase()];
  const answerer = (login: string | undefined): string => (login ?? "").replace(/\[bot\]$/, "");
  const codexComments = comments.filter((c) => answerer(c.author?.login) === reviewerFor.codex);
  const parsedCodexReceipts = codexComments.map((c) => codexReviewReceipt(c.body));
  const knownCommits = [
    ...pr.reviews.nodes.map((r) => r.commit?.oid),
    ...receipts.map((r) => r.codexState?.code_review?.commit_sha),
    ...parsedCodexReceipts.map((r) => r?.commitSha),
  ];
  const hasRunningHeadCodex = receipts.some(
    (r) =>
      answerer(r.by) === reviewerFor.codex &&
      r.codexState?.code_review?.commit_sha === head &&
      typeof r.codexState.code_review.status === "string" &&
      r.codexState.code_review.status !== "completed",
  );
  const codexCleanReceipt = parsedCodexReceipts.some((r) =>
    Boolean(
      r?.clean &&
      (codexCommitMatches(head, r.commitSha) ||
        (hasRunningHeadCodex && codexReceiptMatchesPrefix(head, r.commitSha, knownCommits))),
    ),
  );
  const newerReceipt = (at: string): boolean =>
    receipts.some((r) => answerer(r.by) === requested && (r.at ?? "") > at && !r.codexState) ||
    // A formal review by the requested service also answers the request.
    pr.reviews.nodes.some(
      (r) => answerer(r.author?.login) === requested && (r.submittedAt ?? "") > at,
    );
  const request: PrStatusReport["reviewRequest"] = lastRequest
    ? {
        at: lastRequest.createdAt,
        url: lastRequest.url,
        // The Codex state marker answers only a Codex request; other services need their own reply.
        status:
          requested === reviewerFor.codex &&
          ((codex?.commit_sha === head && codex.status === "completed") || codexCleanReceipt)
            ? "current head reviewed (Codex)"
            : requested === reviewerFor.codex && codex?.commit_sha === head
              ? `review in progress on the current head (Codex: ${codex.status})`
              : newerReceipt(lastRequest.createdAt)
                ? "a reviewer has posted since the request"
                : "no reaction yet",
      }
    : null;

  const linkedIssues = pr.closingIssuesReferences.nodes.map((i) => ({
    number: i.number,
    url: i.url,
    title: i.title,
    state: i.state,
    owners: i.labels.nodes
      .map((l) => l.name)
      .filter((n) => n.startsWith(workflow.ownerPrefix))
      .map((n) => n.slice(workflow.ownerPrefix.length)),
  }));

  // #301: the declared policy over every fetched review, comment and head check run.
  const policy = evaluateReviewPolicy(reviewPolicy, {
    head,
    reviews: pr.reviews.nodes.map((r) => ({
      author: r.author,
      state: r.state,
      commit: r.commit?.oid ?? null,
      at: r.submittedAt,
      url: r.url,
    })),
    comments: comments.map((c) => ({ author: c.author, body: c.body, url: c.url })),
    unresolvedThreads: unresolved.map((t) => ({
      author: t.first?.nodes[0]?.author,
      url: t.first?.nodes[0]?.url ?? pr.url,
    })),
    checks: (rollup?.contexts.nodes ?? [])
      .filter((c) => c.__typename === "CheckRun")
      .map((c) => ({
        app: c.checkSuite?.app?.slug ?? null,
        name: c.name ?? "unnamed",
        status: c.status ?? null,
        conclusion: c.conclusion ?? null,
        url: c.detailsUrl ?? pr.url,
      })),
    complete:
      !pr.comments.pageInfo?.hasPreviousPage &&
      !pr.reviews.pageInfo?.hasPreviousPage &&
      !pr.reviewThreads.pageInfo.hasNextPage,
  });
  const open = pr.state === "OPEN";
  const readiness = evaluatePrReadiness({
    state: pr.state,
    closedLabel: pr.merged ? "merged" : pr.state.toLowerCase(),
    draft: !!pr.isDraft,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ?? null,
    unresolvedThreadCount: unresolved.length,
    pendingCount: byClass("pending").length,
    checkEvidence,
    noRunTimeChecks: contexts.map((c) => c.noRunTime),
    policy: {
      effective: policy.detail.effective,
      headReviewed: policy.headReviewed,
      hasFindings: policy.detail.findings.length > 0,
      summary: policy.detail.providers
        .map((o) => `${reviewProviders[o.provider].label} ${o.state}`)
        .join(", "),
      unknownReason: reviewPolicy.state === "unknown" ? reviewPolicy.reason : "unresolved",
      findings: policy.detail.findings.map((f) => ({
        provider: f.provider,
        label: reviewProviders[f.provider].label,
        source: f.source,
      })),
    },
    codex: {
      findingsOnHead: Boolean(codex?.has_unresolved_findings && codex.commit_sha === head),
      staleHead: Boolean(
        codex &&
        codex.commit_sha !== head &&
        !codexCleanReceipt &&
        !pr.reviews.nodes.some(
          (r) => answerer(r.author?.login) === reviewerFor.codex && r.commit?.oid === head,
        ),
      ),
      runningStatus:
        !codexCleanReceipt &&
        codex?.commit_sha === head &&
        codex.status &&
        codex.status !== "completed"
          ? codex.status
          : null,
    },
    reviewRequestStatus:
      request &&
      (request.status === "no reaction yet" || request.status.startsWith("review in progress"))
        ? request.status
        : null,
  });
  const blockers = readiness.blockers;

  const incomplete: string[] = open ? [...checkEvidence.gaps] : [];
  if (rollup?.contexts.pageInfo.hasNextPage) incomplete.push("more than 100 check contexts");
  if (pr.reviewThreads.pageInfo.hasNextPage) incomplete.push("more than 100 review threads");
  // Truncated evidence is reported, never silently treated as complete.
  if (pr.comments.pageInfo?.hasPreviousPage)
    incomplete.push(
      "more than 100 comments; older comments (and earlier review receipts) not read",
    );
  if (pr.reviews.pageInfo?.hasPreviousPage)
    incomplete.push("more than 50 reviews; older reviews not read");
  if (pr.closingIssuesReferences.pageInfo?.hasNextPage)
    incomplete.push("more than 10 linked issues; ownership of the rest not read");

  return {
    schemaVersion: 1,
    kind: "pr-status",
    repository,
    fetchedAt: now.toISOString(),
    startedAt: startedAt ?? now.toISOString(),
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.merged ? "MERGED" : pr.state,
      draft: !!pr.isDraft,
      head,
      branch: pr.headRefName,
      base: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeState: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision ?? null,
      updatedAt: pr.updatedAt,
    },
    checks: {
      required,
      requirements: {
        expected: pr.requiredChecks?.expected ?? null,
        head: pr.requiredChecks?.head ?? null,
        base: pr.requiredChecks?.base ?? null,
        complete: checkEvidence.complete,
        gaps: [...checkEvidence.gaps],
      },
      policy: checkPolicy,
      evidence: checkEvidence,
      counts: Object.fromEntries(
        (["passed", "pending", "advisory-pending", "cancelled", "failed", "unknown"] as const).map(
          (k) => [k, byClass(k).length],
        ),
      ),
      problems: problems
        .slice(0, limits.failures)
        .map(({ name, class: k, outcome, url, noRunTime }) => ({
          name,
          class: k,
          outcome,
          url,
          ...(noRunTime ? { note: "no recorded run time" } : {}),
        })),
      omittedProblems: Math.max(0, problems.length - limits.failures),
    },
    reviews,
    threads: {
      unresolved: threads.slice(0, limits.threads),
      omitted: Math.max(0, threads.length - limits.threads),
    },
    receipts: receipts.slice(-limits.receipts),
    omittedReceipts: Math.max(0, receipts.length - limits.receipts),
    headReviewed: policy.headReviewed,
    headFindings: policy.headFindings,
    reviewPolicy: policy.detail,
    reviewRequest: request,
    linkedIssues,
    blockers,
    verdict: readiness.verdict,
    completeness: { complete: !incomplete.length, warnings: incomplete },
  };
}

/** Fetch live and report. */
export async function pullRequestStatus(
  repository: string,
  number: number,
  q: Query = ghQuery,
  now: () => Date = () => new Date(),
  meter?: ReadMeter,
  reviewPolicy?: DeclaredReviewPolicy,
  rest?: Rest,
): Promise<PrStatusReport> {
  const startedAt = now().toISOString();
  const [owner, name] = repository.split("/");
  const subject = `${repository}#${number}`;
  const data = await (meter ? meter.query(q, "pull-request", subject) : q)(query, {
    owner,
    name,
    number,
  });
  const pr = selected<PullRequestNode>(prop(data, "repository", "pullRequest"));
  if (!pr) throw new SubjectUnavailable(`Pull request #${number} is unavailable in ${repository}.`);
  const restBoundary = rest ?? (q === ghQuery ? ghRest : undefined);
  if (restBoundary)
    await hydrateRequiredChecks(repository, [pr], {
      query: (text, variables) =>
        (meter ? meter.query(q, "required-checks", subject) : q)(text, variables),
      rest: async (path) => {
        const answer = await (
          meter ? meter.rest(restBoundary, "required-checks", subject) : restBoundary
        )(path);
        return { status: answer.status, body: answer.body };
      },
    });
  if (meter) coverPullRequest(meter, subject, pr);
  return prStatus(repository, pr, { now: now(), startedAt, reviewPolicy });
}

/** Per-source coverage of one pr-status-v1 read; truncated connections are partial. */
function coverPullRequest(meter: ReadMeter, subject: string, pr: PullRequestNode): void {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const part = (source: string, truncated: boolean | undefined, omission: string) =>
    meter.cover(source, subject, truncated ? "partial" : "complete", truncated ? { omission } : {});
  meter.cover("pull-request", subject, "complete");
  part("checks", rollup?.contexts.pageInfo.hasNextPage, "check contexts beyond the first 100");
  part("reviews", pr.reviews.pageInfo?.hasPreviousPage, "reviews before the latest 50");
  part("review-threads", pr.reviewThreads.pageInfo.hasNextPage, "threads beyond the first 100");
  part("comments", pr.comments.pageInfo?.hasPreviousPage, "comments before the latest 100");
  part(
    "closing-issues",
    pr.closingIssuesReferences.pageInfo?.hasNextPage,
    "linked issues beyond the first 10",
  );
}

/** Text rendering. */
export function prStatusText(r: PrStatusReport): string {
  const p = r.pullRequest;
  const lines = [
    `PR #${p.number} ${p.title} ${p.url}`,
    `${p.state}${p.draft ? " (draft)" : ""} · head ${p.head.slice(0, 7)} on ${p.branch} → ${p.base} · mergeable ${p.mergeable} (${p.mergeState}) · fetched ${r.fetchedAt}`,
    "",
    r.blockers.length ? "BLOCKERS" : "BLOCKERS: none found",
    ...r.blockers.map((b) => `- ${b}`),
    "",
    `Checks: ${Object.entries(r.checks.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}; target requirements ${r.checks.policy?.ready ? "satisfied" : "unproven"}`,
    ...r.checks.problems.map(
      (c) => `  ${c.class}: ${c.name} (${c.outcome}${c.note ? `, ${c.note}` : ""}) ${c.url}`,
    ),
    ...(r.checks.omittedProblems ? [`  …${r.checks.omittedProblems} more`] : []),
    `Reviews: decision ${p.reviewDecision ?? "none"}`,
    ...r.reviews.map(
      (v) =>
        `  ${v.reviewer}: ${v.state} on ${v.reviewedCommit?.slice(0, 7) ?? "?"}${v.current ? " (current head)" : " (older commit)"}`,
    ),
    reviewPolicyText(r.reviewPolicy),
    ...r.reviewPolicy.unknowns.map((u) => `  unknown: ${u}`),
    `Unresolved threads: ${r.threads.unresolved.length + r.threads.omitted}`,
    ...r.threads.unresolved.map(
      (t) =>
        `  ${t.path ?? "general"}${t.line ? `:${t.line}` : ""} by ${t.by}${t.outdated ? " (outdated)" : ""}, ${t.replies} repl${t.replies === 1 ? "y" : "ies"}, last ${t.lastSpeaker ?? "?"}: ${t.finding} ${t.url}`,
    ),
    ...(r.threads.omitted ? [`  …${r.threads.omitted} more`] : []),
    ...(r.reviewRequest ? [`Review request ${r.reviewRequest.at}: ${r.reviewRequest.status}`] : []),
    ...r.receipts.map(
      (x) =>
        `Receipt ${x.by} ${x.at}${x.codexState?.code_review ? ` (Codex: ${x.codexState.code_review.status} on ${String(x.codexState.code_review.commit_sha).slice(0, 7)}, unresolved findings ${x.codexState.code_review.has_unresolved_findings})` : ""}${x.summary ? `: ${x.summary}` : ""} ${x.url}`,
    ),
    ...(r.omittedReceipts ? [`  …${r.omittedReceipts} earlier receipt(s) omitted`] : []),
    ...r.linkedIssues.map(
      (i) => `Linked #${i.number} ${i.state} owners: ${i.owners.join(", ") || "none"}`,
    ),
    "",
    r.verdict,
    ...r.completeness.warnings.map((w) => `INCOMPLETE: ${w}`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Shared native PR-readiness evaluation over a collected snapshot PR (#711), reusing the same
 * `evaluatePrReadiness` Datalog rules as `pdb pr`.
 */
export function snapshotPrReadiness(
  pr: PullRequest,
  warnings: readonly string[] = [],
  reviewPolicy?: DeclaredReviewPolicy,
) {
  const head = pr.headRefOid;
  const checkEvidence = requiredCheckEvidence(pr);
  const checkPolicy = evaluateCheckPolicy(checkEvidence);
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts.nodes ?? [];
  const pendingCount = checkEvidence.checks.filter(
    (c) => workflow.unfinished.includes(c.outcome) && c.required !== "advisory",
  ).length;
  const noRunTimeChecks = contexts.map((c) => !("startedAt" in c ? c.startedAt : true));
  const unresolvedThreadCount = (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length;
  const policy = snapshotPolicyReview(pr, [...warnings], reviewPolicy);
  const answerer = (login: string | undefined) => (login ?? "").replace(/\[bot\]$/, "");
  const codexComments = (pr.comments?.nodes ?? []).filter(
    (c) => answerer(c.author?.login) === reviewerFor.codex,
  );
  const codexStates = codexComments
    .map((c) => codexMarker(c.body)?.code_review)
    .filter((s): s is NonNullable<typeof s> => !!s);
  const codex = codexStates.at(-1) ?? null;
  const knownCommits = [
    ...(pr.reviews?.nodes ?? []).map((r) => r.commit?.oid),
    ...codexStates.map((s) => s.commit_sha),
    ...codexComments.map((c) => codexReviewReceipt(c.body)?.commitSha),
  ];
  const hasRunningHeadCodex = codexStates.some(
    (s) => s.commit_sha === head && typeof s.status === "string" && s.status !== "completed",
  );
  const codexCleanReceipt = codexComments.some((c) => {
    const r = codexReviewReceipt(c.body);
    return Boolean(
      r?.clean &&
      (codexCommitMatches(head, r.commitSha) ||
        (hasRunningHeadCodex && codexReceiptMatchesPrefix(head, r.commitSha, knownCommits))),
    );
  });
  const state = pr.state ?? "OPEN";
  const readiness = evaluatePrReadiness({
    state,
    closedLabel: state === "MERGED" ? "merged" : state.toLowerCase(),
    draft: !!pr.isDraft,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: pr.reviewDecision ?? null,
    unresolvedThreadCount,
    pendingCount,
    checkEvidence,
    noRunTimeChecks,
    policy: {
      effective: policy.detail.effective,
      headReviewed: policy.headReviewed,
      hasFindings: policy.detail.findings.length > 0,
      summary: policy.detail.providers
        .map((o) => `${reviewProviders[o.provider].label} ${o.state}`)
        .join(", "),
      unknownReason: reviewPolicy?.state === "unknown" ? reviewPolicy.reason : "unresolved",
      findings: policy.detail.findings.map((f) => ({
        provider: f.provider,
        label: reviewProviders[f.provider].label,
        source: f.source,
      })),
    },
    codex: {
      findingsOnHead: Boolean(codex?.has_unresolved_findings && codex.commit_sha === head),
      staleHead: Boolean(
        codex &&
        codex.commit_sha !== head &&
        !codexCleanReceipt &&
        !(pr.reviews?.nodes ?? []).some(
          (r) => answerer(r.author?.login) === reviewerFor.codex && r.commit?.oid === head,
        ),
      ),
      runningStatus:
        !codexCleanReceipt &&
        codex?.commit_sha === head &&
        codex.status &&
        codex.status !== "completed"
          ? codex.status
          : null,
    },
    reviewRequestStatus: null,
  });
  const threadsIncomplete = !pr.reviewThreads || !!pr.reviewThreads.pageInfo?.hasNextPage;
  const blockers = threadsIncomplete
    ? [...readiness.blockers, "review thread evidence is incomplete"]
    : readiness.blockers;
  return {
    ...readiness,
    ready: readiness.ready && !threadsIncomplete,
    blockers,
    requirements: (checkPolicy.ready ? "satisfied" : "unproven") as "satisfied" | "unproven",
  };
}
