import { describe, expect, it } from "vite-plus/test";
import { historyReads } from "./history.js";

// Synthetic GraphQL answers only.
const issue = (over: Record<string, unknown> = {}) => ({
  number: 7,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  lastEditedAt: null,
  state: "OPEN",
  closedAt: null,
  stateReason: null,
  labels: { nodes: [{ name: "status:ready" }], pageInfo: { hasNextPage: false } },
  comments: { totalCount: 1, nodes: [{ body: "hi", databaseId: 1 }] },
  ...over,
});
const page = (field: string, nodes: unknown[], more = false) => ({
  repository: {
    [field]: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? "c1" : null } },
  },
});

describe("typed history reads (#931)", () => {
  it("returns validated issue pages with the cursor passed through", async () => {
    const seen: Record<string, unknown>[] = [];
    const reads = historyReads(async (_q, v) => {
      seen.push(v);
      return page("issues", [issue()], true);
    });
    const result = await reads.issuesByUpdate("o/r", "c0");
    expect(result).toMatchObject({ hasNextPage: true, endCursor: "c1" });
    expect(result.nodes[0]).toMatchObject({
      number: 7,
      labels: { pageInfo: { hasNextPage: false } },
    });
    expect(seen[0]).toEqual({ owner: "o", name: "r", cursor: "c0" });
  });

  it("rejects malformed nodes and a missing repository instead of guessing", async () => {
    const bad = historyReads(async () => page("issues", [issue({ number: "7" })]));
    await expect(bad.openIssues("o/r", null)).rejects.toThrow(/malformed issue/);
    const gone = historyReads(async () => ({ repository: null }));
    await expect(gone.issuesByUpdate("o/r", null)).rejects.toThrow(/Repository unavailable/);
  });

  it("treats missing paging evidence as incomplete, never complete", async () => {
    const reads = historyReads(async (q) =>
      q.includes("pullRequests")
        ? page("pullRequests", [
            {
              number: 9,
              updatedAt: "2026-11-02T00:00:00Z",
              mergedAt: "2026-11-02T00:00:00Z",
              closingIssuesReferences: {
                nodes: [{ number: 7, repository: { nameWithOwner: "o/r" } }],
              },
            },
          ])
        : page("issues", [issue({ labels: { nodes: [] } })]),
    );
    const pulls = await reads.mergedPulls("o/r", null);
    expect(pulls.nodes[0]).toMatchObject({
      closes: [{ number: 7, repository: "o/r" }],
      closesTruncated: true,
    });
    const issues = await reads.openIssues("o/r", null);
    expect(issues.nodes[0]!.labels.pageInfo.hasNextPage).toBe(true);
  });

  it("returns null for an unseen issue or pull request", async () => {
    const reads = historyReads(async () => ({ repository: { issue: null, pullRequest: null } }));
    expect(await reads.issue("o/r", 1)).toBeNull();
    expect(await reads.pullState("o/r", 1)).toBeNull();
  });
});
