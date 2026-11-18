import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
const svc = (page: unknown) =>
  createGhService({
    env: {},
    query: async () =>
      ({ repository: { issue: { closedByPullRequestsReferences: page } } }) as never,
  });

describe("typed closing-references page (#951)", () => {
  it("returns a validated page", async () => {
    expect(
      await svc({
        nodes: [{ number: 9, url: "u", state: "MERGED" }],
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      }).references.closingPage("o/r", 1, 25, null),
    ).toEqual({
      nodes: [{ number: 9, url: "u", state: "MERGED" }],
      pageInfo: { hasNextPage: true, endCursor: "c1" },
    });
  });

  it("rejects a malformed page instead of returning an empty complete list", async () => {
    for (const page of [
      null,
      {
        nodes: [{ number: "9", url: "u", state: "OPEN" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      { nodes: [], pageInfo: {} },
    ])
      await expect(svc(page).references.closingPage("o/r", 1, 25, null)).rejects.toThrow(
        /not readable/,
      );
  });
});
