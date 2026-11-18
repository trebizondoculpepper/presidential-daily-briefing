import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
const conn = { nodes: [], pageInfo: { hasNextPage: false } };
const pr = {
  number: 5,
  url: "u",
  headRefOid: "a".repeat(40),
  author: { login: "me" },
  commits: { ...conn, totalCount: 0 },
  reviews: conn,
  reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [] } }] },
  comments: conn,
};
const svc = (pullRequest: unknown) =>
  createGhService({ env: {}, query: async () => ({ repository: { pullRequest } }) as never });

describe("typed review-history read (#950)", () => {
  it("returns a validated history, and null only for an absent pull request", async () => {
    expect(await svc(pr).reviewHistory.pullHistory("o/r", 5)).toMatchObject({ number: 5 });
    expect(await svc(null).reviewHistory.pullHistory("o/r", 5)).toBeNull();
  });

  it("rejects a malformed history instead of reporting from a partial shape", async () => {
    for (const bad of [
      { ...pr, headRefOid: 7 },
      { ...pr, reviews: {} },
      { ...pr, reviewThreads: { nodes: [{ comments: { nodes: [] } }] } },
    ])
      await expect(svc(bad).reviewHistory.pullHistory("o/r", 5)).rejects.toThrow(/malformed/);
  });
});
