import { describe, expect, it } from "vite-plus/test";
import { containmentReads } from "./containment.js";

// Synthetic answers only.
const oid = "a".repeat(40);
const reads = (
  data: unknown,
  compare: { status: number | null; body: unknown } = { status: 200, body: {} },
) =>
  containmentReads(
    async () => data,
    async () => compare,
  );

describe("typed commit containment reads (#943, #890)", () => {
  it("reads the default branch, and null for anything unreadable", async () => {
    expect(
      await reads({ repository: { defaultBranchRef: { name: "main" } } }).defaultBranch("o/r"),
    ).toBe("main");
    for (const data of [
      { repository: null },
      { repository: { defaultBranchRef: { name: 1 } } },
      null,
    ])
      expect(await reads(data).defaultBranch("o/r")).toBeNull();
  });

  it("resolves a commit only to a valid object ID in its repository", async () => {
    const commit = (object: unknown) => ({ repository: { nameWithOwner: "O/R", object } });
    expect(await reads(commit({ __typename: "Commit", oid })).commit("o/r", "abc")).toEqual({
      repository: "O/R",
      oid,
    });
    expect(await reads(commit({ __typename: "Tree", oid })).commit("o/r", "abc")).toBeNull();
    expect(
      await reads(commit({ __typename: "Commit", oid: "nope" })).commit("o/r", "abc"),
    ).toBeNull();
  });

  it("reports containment from the compare status, and unknown when inconclusive", async () => {
    const at = (body: unknown, status = 200) =>
      reads({}, { status, body }).targetContainment({ repository: "o/r", branch: "main" }, oid);
    expect((await at({ status: "behind" })).state).toBe("contained");
    expect((await at({ status: "diverged" })).state).toBe("absent");
    expect((await at({ status: "weird" })).state).toBe("unknown");
    expect((await at({}, 404)).state).toBe("unknown");
  });
});
