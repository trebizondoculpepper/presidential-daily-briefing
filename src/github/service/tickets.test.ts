import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
const full = {
  state: "OPEN",
  labels: { totalCount: 2, nodes: [{ name: "b" }, { name: "a" }] },
  assignees: { nodes: [{ login: "z" }] },
  comments: { totalCount: 4 },
};
const svc = (answer: unknown) => createGhService({ env: {}, query: async () => answer as never });

describe("typed claim guard and PR state reads (#942)", () => {
  it("fingerprints a whole guard read, order-independently", async () => {
    expect(await svc({ repository: { issue: full } }).tickets.guardState("o/r", 1)).toBe(
      JSON.stringify(["OPEN", 2, ["a", "b"], ["z"], 4]),
    );
  });

  it("fails the guard on a partial or malformed read instead of comparing it", async () => {
    for (const issue of [
      { ...full, comments: undefined },
      { ...full, labels: { nodes: [] } },
      { ...full, assignees: { nodes: [{ login: 1 }] } },
      null,
    ])
      await expect(svc({ repository: { issue } }).tickets.guardState("o/r", 1)).rejects.toThrow(
        /ticket unreadable/,
      );
  });

  it("reads a pull request's state by URL, and null for anything else", async () => {
    expect(
      await svc({
        resource: { __typename: "PullRequest", state: "MERGED" },
      }).tickets.pullStateByUrl("u"),
    ).toBe("MERGED");
    expect(await svc({ resource: { __typename: "Issue" } }).tickets.pullStateByUrl("u")).toBeNull();
    expect(await svc({ resource: null }).tickets.pullStateByUrl("u")).toBeNull();
  });
});
