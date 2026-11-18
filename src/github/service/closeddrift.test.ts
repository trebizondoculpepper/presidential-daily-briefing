import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
const comment = {
  databaseId: 1,
  url: "c",
  body: "b",
  createdAt: "t",
  author: { login: "a" },
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
};
const issue = {
  number: 4,
  title: "t",
  url: "u",
  state: "CLOSED",
  stateReason: "COMPLETED",
  closedAt: "2026-11-18T00:00:00Z",
  timelineItems: { nodes: [{ actor: { login: "me" } }] },
  comments: { nodes: [comment], pageInfo: { hasPreviousPage: false, startCursor: null } },
};
const svc = (issues: unknown) =>
  createGhService({ env: {}, query: async () => ({ repository: { issues } }) as never });

describe("typed closed-issue drift read (#944)", () => {
  it("returns validated closed issues and the page's truncation", async () => {
    const r = await svc({ nodes: [issue], pageInfo: { hasNextPage: true } }).delivery.closedSince(
      "o/r",
      "2026-11-01",
      50,
    );
    expect(r.hasNextPage).toBe(true);
    expect(r.nodes[0]).toMatchObject({ number: 4, comments: { nodes: [{ body: "b" }] } });
  });

  it("rejects a malformed page, issue, closer or comment instead of reporting no drift", async () => {
    for (const issues of [
      { nodes: [issue] },
      { nodes: [{ ...issue, closedAt: 3 }], pageInfo: { hasNextPage: false } },
      {
        nodes: [{ ...issue, timelineItems: { nodes: [{ actor: { login: 1 } }] } }],
        pageInfo: { hasNextPage: false },
      },
      {
        nodes: [
          {
            ...issue,
            comments: {
              nodes: [{ ...comment, includesCreatedEdit: undefined }],
              pageInfo: { hasPreviousPage: false },
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    ])
      await expect(svc(issues).delivery.closedSince("o/r", "s", 50)).rejects.toThrow(/malformed/);
  });
});
