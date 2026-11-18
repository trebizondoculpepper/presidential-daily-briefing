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

describe("injected ticket capabilities (#942)", () => {
  it("the claim guard uses an injected facade capability without composing a query", async () => {
    const { ticketGuard } = await import("../../workflow/claims.js");
    const asked: string[] = [];
    const guard = ticketGuard("o/r", 3, {
      guardState: async (repository, number) => {
        asked.push(`${repository}#${number}`);
        return "fingerprint";
      },
      pullStateByUrl: async () => null,
    });
    expect(await guard()).toBe("fingerprint");
    expect(asked).toEqual(["o/r#3"]);
  });
});
