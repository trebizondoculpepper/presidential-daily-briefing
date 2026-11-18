import { describe, expect, it } from "vite-plus/test";
import { deliveryIssue } from "./delivery.js";
import type { Query } from "../github.js";

// Synthetic GraphQL answers only.
const q = (issue: unknown) => (async () => ({ repository: { issue } })) as unknown as Query;
const base = {
  number: 3,
  title: "t",
  url: "u",
  state: "CLOSED",
  stateReason: "COMPLETED",
  closedByPullRequestsReferences: {
    nodes: [{ number: 9, url: "p", state: "MERGED" }],
    pageInfo: { hasNextPage: false },
  },
  comments: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
};

describe("typed delivery-issue read (#945)", () => {
  it("returns a validated issue, and null only when it is absent", async () => {
    expect(await deliveryIssue(q(base), "o/r", 3)).toMatchObject({
      number: 3,
      stateReason: "COMPLETED",
    });
    expect(await deliveryIssue(q(null), "o/r", 3)).toBeNull();
  });

  it("rejects malformed answers instead of guessing delivery", async () => {
    for (const bad of [
      { ...base, number: "3" },
      { ...base, comments: { nodes: [] } },
      { ...base, closedByPullRequestsReferences: { nodes: [{ number: "x" }] } },
    ])
      await expect(deliveryIssue(q(bad), "o/r", 3)).rejects.toThrow(/malformed/);
  });

  it("treats missing closing-reference paging as more remaining", async () => {
    const r = await deliveryIssue(
      q({ ...base, closedByPullRequestsReferences: { nodes: [] } }),
      "o/r",
      3,
    );
    expect(r?.closedByPullRequestsReferences?.pageInfo.hasNextPage).toBe(true);
  });
});
