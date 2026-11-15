/** Facts captured from GitHub, kept separate from workflow interpretations (#683). */
export type Page<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount?: number;
};
export type Comment = {
  /** Stable numeric id; orders delivery records (#182). Absent from older caches: order unknown. */
  databaseId?: number;
  body: string;
  url: string;
  /** `__typename` and the edit fields (#247) are absent from older caches: authority unknown. */
  author: { __typename?: string; login: string } | null;
  createdAt?: string;
  updatedAt?: string;
  lastEditedAt?: string | null;
  includesCreatedEdit?: boolean;
  editor?: { __typename?: string; login?: string } | null;
};
export type Check = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  /** CheckRun database id: a stable per-run identity (StatusContexts have none). */
  databaseId?: number | null;
};
export type NativeNode = {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  repository: { nameWithOwner: string };
  issueDependenciesSummary: {
    blockedBy: number;
    totalBlockedBy: number;
    blocking: number;
    totalBlocking: number;
  };
};
export type Issue = {
  issueDependenciesSummary?: NativeNode["issueDependenciesSummary"];
  blockedBy?: Page<NativeNode>;
  blocking?: Page<NativeNode>;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  stateReason?: string | null;
  lastEditedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  labels: Page<{ name: string }>;
  comments: Page<Comment>;
  /** Open PRs that would close this issue (#162); absent in snapshots that predate it. */
  closedByPullRequestsReferences?: Page<{ number: number; url: string; state: string }>;
};
export type PullRequest = Issue & {
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  mergedAt?: string | null;
  closingIssuesReferences: Page<{ number: number; url: string }>;
  reviewThreads: Page<{
    isResolved: boolean;
    isOutdated: boolean;
    comments: Page<Comment>;
  }>;
  /** `submittedAt` is the review event time; null for a pending review. */
  /** `commit` is the reviewed head (#182); absent from older caches: review head unknown. */
  reviews: Page<
    Comment & { state: string; submittedAt?: string | null; commit?: { oid: string } | null }
  >;
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string; contexts: Page<Check> } | null } }[];
  };
  /**
   * Required-check evidence (#343), hydrated only for open non-draft PRs with an unfinished
   * check; absent means requiredness unknown (never advisory).
   */
  requiredChecks?: import("./requiredchecks.js").RequiredChecks;
};
export type Reference = { repository: string; number: number; url: string };
export type Dependency = Reference & {
  available: boolean;
  state?: string;
  stateReason?: string | null;
  mergedAt?: string | null;
  title?: string;
};
export type Snapshot = {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  issues: Issue[];
  pullRequests: PullRequest[];
  dependencies: Dependency[];
  changed: { number: number; title: string; url: string; state: string; updatedAt: string }[];
  since: string | null;
  /**
   * The requested history window's own outcome (#370), absent when no history was requested.
   * `failed`/`partial` mean changes in the window are unknown, not none.
   */
  history?: {
    since: string;
    state: "complete" | "partial" | "failed";
    failure: string | null;
    sources: { source: string; pages: number; complete: boolean; failure: string | null }[];
  };
  /** Optional, versioned briefing-mode evidence (#168); absent in legacy snapshots. */
  changeEvidence?: import("./changes.js").ChangeEvidence;
  warnings: string[];
  metrics?: {
    requestCount: number;
    durationMs: number;
    /** Per-attempt gh evidence summary (#293); present only for the production transport. */
    github?: import("./evidence.js").AttemptSummary;
  };
  rateLimit: { remaining: number; resetAt: string } | null;
  /**
   * Read profile, per-source coverage and cost (#367). A focused profile is not a repository
   * inventory; absent in snapshots that predate it.
   */
  collection?: import("./readplan.js").ReadCollection;
  /**
   * Routine shortlist hydration (#368): which open items were hydrated and which were only
   * discovered. Absent in full snapshots, where every open item was read.
   */
  shortlist?: import("./shortlist.js").ShortlistRecord;
  /**
   * The repository's declared review policy (#301), attached by the front end that resolved
   * configuration; never cached or collected from GitHub. Absent: legacy, reported as not read.
   */
  reviewPolicy?: import("../workflow/reviewpolicy.js").DeclaredReviewPolicy;
};
export type Action = {
  rule: string;
  priority: number;
  target: string;
  title: string;
  reason: string;
  next: string;
  evidence: string[];
  uncertainty: "factual" | "candidate" | "unknown";
};
