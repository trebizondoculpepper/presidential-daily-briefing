/** Refinement facts for the briefing (#1098): which issues are read and how evidence gaps show. */
import { describe, expect, it } from "vite-plus/test";
import { issue, snapshot } from "../testing/snapshots.js";
import { readSnapshotRefinements } from "./refinementread.js";
import { refinementLabel } from "./refinement.js";

const trusted = async () => ({ status: "trusted" as const });

describe("readSnapshotRefinements (#1098)", () => {
  it("skips issues with neither the index label nor a refinement record", async () => {
    const facts = await readSnapshotRefinements(
      snapshot([issue(1, ["status:ready"])], []),
      trusted,
    );
    expect(facts.size).toBe(0);
  });

  it("treats the index label with no readable request as incomplete evidence, never as settled", async () => {
    const i = issue(2, ["status:ready", refinementLabel]);
    const facts = await readSnapshotRefinements(snapshot([i], []), trusted);
    expect(facts.get(i.url)).toEqual({ requests: [], complete: false });
  });

  it("marks a truncated comment history incomplete", async () => {
    const i = issue(3, [refinementLabel]);
    i.comments.pageInfo.hasNextPage = true;
    const facts = await readSnapshotRefinements(snapshot([i], []), trusted);
    expect(facts.get(i.url)?.complete).toBe(false);
  });

  it("ignores closed issues", async () => {
    const i = { ...issue(4, [refinementLabel]), state: "CLOSED" };
    expect((await readSnapshotRefinements(snapshot([i], []), trusted)).size).toBe(0);
  });
});
