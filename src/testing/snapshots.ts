/**
 * Shared snapshot fixtures for the split test suites (#335 stage 3, doc/design/source-layout.md).
 * Test-only: imported by `*.test.ts` files and nothing else.
 */
import type { Issue, Page, PullRequest, Snapshot } from "../github/types.js";

export const repo = "example/project";
export const time = "2026-11-12T10:00:00.000Z";
export const page = <T>(nodes: T[], more = false, cursor: string | null = null): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
export const issue = (number = 1, labels = ["status:ready"]): Issue => ({
  number,
  title: `Ticket ${number}`,
  body: "Use [design](doc/game-architecture.md).",
  url: `https://github.com/${repo}/issues/${number}`,
  state: "OPEN",
  stateReason: null,
  createdAt: time,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
export const pr = (): PullRequest => ({
  ...issue(4, []),
  url: `https://github.com/${repo}/pull/4`,
  headRefOid: "abc123",
  requiredChecks: {
    head: "abc123",
    base: "main",
    expected: [{ context: "verify", appId: null }],
    checks: [{ name: "verify", databaseId: null, appId: null, required: "required" }],
    gaps: [],
  },
  headRefName: "feature",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page([{ number: 1, url: issue().url }]),
  reviewThreads: page([]),
  reviews: page([]),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }]),
          },
        },
      },
    ],
  },
});
export const snapshot = (issues = [issue()], prs: PullRequest[] = [pr()]): Snapshot => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: time,
  fetchedAt: time,
  issues,
  pullRequests: prs,
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
});
export const clock = () => new Date(time);
/** Comment author and edit evidence (#212): an unedited comment by a user. */
export const by = (login = "kavya") => ({
  author: { __typename: "User", login },
  lastEditedAt: null as string | null,
  includesCreatedEdit: false,
  editor: null as { __typename: string; login: string } | null,
});
