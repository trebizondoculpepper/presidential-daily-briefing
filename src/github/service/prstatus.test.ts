import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
const pr = {
  number: 12,
  title: "t",
  url: "u",
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  headRefOid: "a".repeat(40),
  headRefName: "b",
  baseRefName: "main",
  updatedAt: "2026-11-18T00:00:00Z",
  commits: {
    nodes: [
      {
        commit: {
          oid: "a".repeat(40),
          committedDate: null,
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "verify",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ],
  },
  reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
  closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
};
const svc = (pullRequest: unknown) =>
  createGhService({ env: {}, query: async () => ({ repository: { pullRequest } }) as never });

describe("typed pull request status read (#946)", () => {
  it("returns a validated node, and null only for an absent pull request", async () => {
    expect(await svc(pr).prStatus.pullRequest("o/r", 12)).toMatchObject({ number: 12 });
    expect(await svc(null).prStatus.pullRequest("o/r", 12)).toBeNull();
  });

  it("rejects wrongly typed evidence instead of reporting from it", async () => {
    for (const bad of [
      { ...pr, headRefOid: 1 },
      { ...pr, isDraft: "no" },
      { ...pr, reviews: { nodes: [null], pageInfo: { hasPreviousPage: false } } },
      {
        ...pr,
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 3 }] } } } }],
        },
      },
      {
        ...pr,
        reviewThreads: { nodes: [{ isResolved: "yes" }], pageInfo: { hasNextPage: false } },
      },
    ])
      await expect(svc(bad).prStatus.pullRequest("o/r", 12)).rejects.toThrow(/malformed/);
  });

  it("never reads missing paging evidence as complete", async () => {
    const r = await svc({
      ...pr,
      comments: { nodes: [] },
      reviews: { nodes: [] },
    }).prStatus.pullRequest("o/r", 12);
    expect(r?.comments.pageInfo?.hasPreviousPage).toBe(true);
    expect(r?.reviews.pageInfo?.hasPreviousPage).toBe(true);
  });
  it("rejects a non-string author discriminator and omitted required nullable fields", async () => {
    const reviews = (node: unknown) => ({
      ...pr,
      reviews: { nodes: [node], pageInfo: { hasPreviousPage: false } },
    });
    for (const bad of [
      reviews({
        author: { login: "x", __typename: 7 },
        state: "APPROVED",
        submittedAt: null,
        url: "r",
        commit: null,
      }),
      reviews({ author: null, state: "APPROVED", url: "r", commit: null }),
      {
        ...pr,
        comments: {
          nodes: [{ author: null, createdAt: "t", url: "c" }],
          pageInfo: { hasPreviousPage: false },
        },
      },
    ])
      await expect(svc(bad).prStatus.pullRequest("o/r", 12)).rejects.toThrow(/malformed/);
  });
});
