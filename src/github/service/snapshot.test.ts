import { describe, expect, it } from "vite-plus/test";
import { discoveryPage, issueCommentsPage, issuesByNumber } from "./snapshot.js";
import type { Query } from "../github.js";

// Synthetic GraphQL answers only.
const fake = (answer: unknown) => {
  const calls: { q: string; v: Record<string, unknown> }[] = [];
  const query = (async (q: string, v: Record<string, unknown>) => {
    calls.push({ q, v });
    return answer;
  }) as unknown as Query;
  return { calls, query };
};

describe("typed snapshot reads (#927)", () => {
  it("reads a discovery page with owner, name and cursor", async () => {
    const page = { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } };
    const f = fake({ repository: { issues: page } });
    expect(await discoveryPage(f.query, "o/r", "issues", "number", 50, "c1")).toEqual(page);
    expect(f.calls[0]!.v).toEqual({ owner: "o", name: "r", cursor: "c1" });
    expect(f.calls[0]!.q).toContain("issues(first:50,after:$cursor");
  });

  it("returns aliased issues in order, null for absent ones", async () => {
    const f = fake({ repository: { i0: { number: 3 }, i1: null } });
    expect(await issuesByNumber(f.query, "o/r", [3, 4], "number")).toEqual([{ number: 3 }, null]);
    expect(f.calls[0]!.v).toEqual({ owner: "o", name: "r", n0: 3, n1: 4 });
  });

  it("unwraps a comments page and reports a missing repository", async () => {
    const comments = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const f = fake({ repository: { issue: { comments } } });
    expect(await issueCommentsPage(f.query, "o/r", 3, "body", "c2")).toEqual(comments);
    const gone = fake({ repository: null });
    await expect(issuesByNumber(gone.query, "o/r", [1], "number")).rejects.toThrow(
      /Repository unavailable/,
    );
  });

  it("does not start a read after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fake({ repository: {} });
    await expect(
      discoveryPage(f.query, "o/r", "issues", "number", 50, null, controller.signal),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
