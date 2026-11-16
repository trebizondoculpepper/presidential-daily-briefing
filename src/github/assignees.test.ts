import { describe, expect, it } from "vite-plus/test";
import {
  collectAssignmentEvidence,
  normalizeSubjectAssignment,
  snapshotAssignmentEvidence,
} from "./assignees.js";
import { collect } from "./github.js";
import type { Issue, PullRequest, Snapshot } from "./types.js";

const baseIssue = (over: Partial<Issue> = {}): Issue => ({
  number: 1,
  title: "Test issue",
  body: "",
  url: "https://github.com/o/r/issues/1",
  state: "OPEN",
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
  labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  ...over,
});

const basePr = (over: Partial<PullRequest> = {}): PullRequest => ({
  ...baseIssue({ number: 2, url: "https://github.com/o/r/pull/2" }),
  headRefOid: "a".repeat(40),
  headRefName: "feat/x",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  commits: { nodes: [] },
  ...over,
});

describe("human assignment evidence (#665)", () => {
  it("distinguishes complete empty, bot-only, matching, other-human, and untyped assignees", () => {
    const empty = normalizeSubjectAssignment(
      baseIssue({
        assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        labels: {
          nodes: [{ name: "agent:jonas_kowalski" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(empty.completeness).toBe("complete");
    expect(empty.state).toBe("unassigned");
    expect(empty.humans).toEqual([]);

    const botOnly = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ __typename: "Bot", login: "copilot-pull-request-reviewer" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(botOnly.state).toBe("unassigned");
    expect(botOnly.bots).toEqual(["copilot-pull-request-reviewer"]);

    const matching = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ __typename: "User", login: "Alice" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(matching.state).toBe("matching");

    const other = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ __typename: "User", login: "bob" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(other.state).toBe("other-human");

    const untyped = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ login: "alice" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(untyped.state).toBe("unknown");
    expect(untyped.untyped).toEqual(["alice"]);
  });

  it("distinguishes legacy, truncated, and failed evidence and computes freshness", () => {
    const legacy = normalizeSubjectAssignment(baseIssue(), {
      employingHuman: "alice",
      source: "last-known",
      observedAt: "2026-11-16T00:00:00Z",
      now: new Date("2026-11-16T00:05:00Z"),
    });
    expect(legacy.completeness).toBe("legacy");
    expect(legacy.state).toBe("unknown");
    expect(legacy.freshness).toEqual({
      source: "last-known",
      observedAt: "2026-11-16T00:00:00Z",
      ageMs: 300_000,
    });

    const truncated = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ __typename: "User", login: "alice" }],
          pageInfo: { hasNextPage: true, endCursor: "c1" },
        },
      }),
      { employingHuman: "alice" },
    );
    expect(truncated.completeness).toBe("truncated");
    expect(truncated.state).toBe("unknown");

    const failed = normalizeSubjectAssignment(
      baseIssue({
        assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
      {
        employingHuman: "alice",
        warnings: ["https://github.com/o/r/issues/1: assignment evidence could not be read"],
      },
    );
    expect(failed.completeness).toBe("failed");
    expect(failed.state).toBe("unknown");

    const unrelatedFailure = normalizeSubjectAssignment(
      baseIssue({
        assignees: {
          nodes: [{ __typename: "User", login: "alice" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      {
        employingHuman: "alice",
        warnings: [
          "https://github.com/o/r/issues/1: native dependencies could not be read (read-failed); unknown.",
        ],
      },
    );
    expect(unrelatedFailure.completeness).toBe("complete");
    expect(unrelatedFailure.state).toBe("matching");
  });

  it("evaluates linked PR scope, missing links, and conflicting human ownership", () => {
    const aliceIssue = baseIssue({
      number: 1,
      url: "https://github.com/o/r/issues/1",
      assignees: {
        nodes: [{ __typename: "User", login: "alice" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const bobIssue = baseIssue({
      number: 3,
      url: "https://github.com/o/r/issues/3",
      assignees: {
        nodes: [{ __typename: "User", login: "bob" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const map = new Map([
      [aliceIssue.url, aliceIssue],
      [bobIssue.url, bobIssue],
    ]);

    const matchingPr = collectAssignmentEvidence(
      basePr({
        assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        closingIssuesReferences: {
          nodes: [{ number: 1, url: aliceIssue.url }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      map,
      { employingHuman: "alice" },
    );
    expect(matchingPr.linkedComplete).toBe(true);
    expect(matchingPr.conflict).toBe(false);
    expect(matchingPr.effective).toBe("matching");

    const missingLinkPr = collectAssignmentEvidence(
      basePr({
        assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        closingIssuesReferences: {
          nodes: [{ number: 99, url: "https://github.com/o/r/issues/99" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      map,
      { employingHuman: "alice" },
    );
    expect(missingLinkPr.linkedComplete).toBe(false);
    expect(missingLinkPr.effective).toBe("unknown");

    const conflictingPr = collectAssignmentEvidence(
      basePr({
        assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        closingIssuesReferences: {
          nodes: [
            { number: 1, url: aliceIssue.url },
            { number: 3, url: bobIssue.url },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      map,
      { employingHuman: "alice" },
    );
    expect(conflictingPr.conflict).toBe(true);
    expect(conflictingPr.effective).toBe("conflicting");

    const untypedIssue = baseIssue({
      number: 4,
      url: "https://github.com/o/r/issues/4",
      assignees: { nodes: [{ login: "alice" }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const mapWithUntyped = new Map<string, Issue>([
      [aliceIssue.url, aliceIssue],
      [untypedIssue.url, untypedIssue],
    ]);
    const untypedPr = collectAssignmentEvidence(
      basePr({
        closingIssuesReferences: {
          nodes: [
            { number: 1, url: aliceIssue.url },
            { number: 4, url: untypedIssue.url },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      mapWithUntyped,
      { employingHuman: "alice" },
    );
    expect(untypedPr.conflict).toBe(false);
    expect(untypedPr.effective).toBe("unknown");
  });

  it("preserves per-subject observation times from cached shortlist coverage", () => {
    const issue = baseIssue({
      assignees: {
        nodes: [{ __typename: "User", login: "alice" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const pr = basePr({
      closingIssuesReferences: {
        nodes: [{ number: 1, url: issue.url }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const snap: Snapshot = {
      schemaVersion: 1,
      repository: "o/r",
      startedAt: "2026-11-16T10:09:59Z",
      fetchedAt: "2026-11-16T10:10:00Z",
      since: null,
      issues: [issue],
      pullRequests: [pr],
      dependencies: [],
      changed: [],
      warnings: [],
      rateLimit: null,
      collection: {
        schemaVersion: 1,
        profile: "briefing-shortlist-v1",
        profileVersion: 1,
        operation: "briefing",
        bounds: {},
        notAttempted: [],
        coverage: [
          {
            source: "issue",
            subject: issue.url,
            state: "complete",
            observedAt: "2026-11-16T10:05:00Z",
            omission: null,
            failure: null,
            profileVersion: 1,
          },
          {
            source: "pull-request",
            subject: "o/r#2",
            state: "complete",
            observedAt: "2026-11-16T10:08:00Z",
            omission: null,
            failure: null,
            profileVersion: 1,
          },
        ],
        quota: null,
      } as unknown as Snapshot["collection"],
    };
    const evidence = snapshotAssignmentEvidence(snap, {
      employingHuman: "alice",
      now: new Date("2026-11-16T10:10:00Z"),
    });
    expect(evidence.get(issue.url)?.subject.freshness.observedAt).toBe("2026-11-16T10:05:00Z");
    expect(evidence.get(issue.url)?.subject.freshness.ageMs).toBe(300_000);
    expect(evidence.get(pr.url)?.subject.freshness.observedAt).toBe("2026-11-16T10:08:00Z");
    expect(evidence.get(pr.url)?.subject.freshness.ageMs).toBe(120_000);
    expect(evidence.get(pr.url)?.linkedIssues[0]?.assignment?.freshness.observedAt).toBe(
      "2026-11-16T10:05:00Z",
    );
  });

  it("collects assignees in github.ts and warns when truncated", async () => {
    let sawAssigneesQuery = false;
    const snap: Snapshot = await collect(
      "o/r",
      {},
      (async (query: string) => {
        if (query.includes("assignees(first:100){nodes{__typename login}"))
          sawAssigneesQuery = true;
        if (query.includes("pullRequests(")) {
          return {
            repository: {
              pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          };
        }
        return {
          repository: {
            issues: {
              nodes: [
                {
                  ...baseIssue({
                    assignees: {
                      nodes: [{ __typename: "User", login: "alice" }],
                      pageInfo: { hasNextPage: true, endCursor: "c1" },
                    },
                  }),
                  closedByPullRequestsReferences: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  issueDependenciesSummary: {
                    blockedBy: 0,
                    totalBlockedBy: 0,
                    blocking: 0,
                    totalBlocking: 0,
                  },
                  blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  blocking: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }) as never,
      () => new Date("2026-11-16T00:00:00Z"),
    );
    expect(sawAssigneesQuery).toBe(true);
    expect(snap.warnings).toContain(
      "https://github.com/o/r/issues/1: assignees exceed 100; assignment evidence incomplete.",
    );
    const evidence = snapshotAssignmentEvidence(snap, { employingHuman: "alice" });
    expect(evidence.get("https://github.com/o/r/issues/1")?.subject.completeness).toBe("truncated");
  });
});
