/** Native discussion view (#1093, doc/design/estimation-refinement-loop.md). Synthetic facts only. */
import { describe, expect, it } from "vite-plus/test";
import { evaluateDiscussion, policyVersion, rulesHash } from "./engine.js";
import type { DiscussionIssue } from "./engine.js";

const issues: DiscussionIssue[] = [
  { number: 7, state: "OPEN", comments: 3 },
  { number: 2, state: "OPEN", comments: 3 }, // ties with #7: the lower number first
  { number: 5, state: "OPEN", comments: 12 },
  { number: 9, state: "OPEN", comments: 0 }, // no discussion: not included
  { number: 4, state: "OPEN", comments: null }, // unread count: unknown, never zero
  { number: 8, state: "CLOSED", comments: 20 }, // resolved/closed discussion
];

describe("native discussion view (#1093)", () => {
  it("ranks open discussion by comment count, ties by lower issue number", () => {
    const view = evaluateDiscussion({ scope: "open", issues });
    expect(view.items.map((i) => [i.number, i.comments])).toEqual([
      [5, 12],
      [2, 3],
      [7, 3],
    ]);
    expect(view.unknown).toEqual([4]);
    expect(view.scope).toBe("open");
    expect(view).toMatchObject({ policyVersion, rulesHash });
  });

  it("explains each item from policy without implying disagreement", () => {
    const [top] = evaluateDiscussion({ scope: "open", issues }).items;
    expect(top!.why).toBe(
      "12 comments: ranked by discussion volume, a rough proxy that does not imply disagreement.",
    );
  });

  it("honours the requested scope; closed and resolved discussion stays eligible", () => {
    expect(evaluateDiscussion({ scope: "closed", issues }).items.map((i) => i.number)).toEqual([8]);
    expect(evaluateDiscussion({ scope: "all", issues }).items.map((i) => i.number)).toEqual([
      8, 5, 2, 7,
    ]);
    expect(evaluateDiscussion({ scope: "closed", issues }).unknown).toEqual([]);
  });

  it("never treats a missing count as zero, and an empty input is empty", () => {
    const unknownOnly = evaluateDiscussion({
      scope: "open",
      issues: [{ number: 1, state: "OPEN", comments: null }],
    });
    expect(unknownOnly.items).toEqual([]);
    expect(unknownOnly.unknown).toEqual([1]);
    expect(evaluateDiscussion({ scope: "all", issues: [] })).toMatchObject({
      items: [],
      unknown: [],
    });
  });
});
