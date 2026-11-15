/**
 * #502 (doc/design/delivery-follow-up-alignment.md, precedence 1): an observed failed check on
 * the current head of a non-draft PR is actionable even when other evidence is incomplete, in
 * the delivery classifier as in the briefing's D-PR-FAIL (native scenario
 * observed-failure-is-actionable-with-incomplete-evidence in coverage-gaps.edn). Without an
 * observed failure, incomplete evidence stays unknown; complete evidence is unchanged.
 */
import { describe, expect, it } from "vite-plus/test";
import { evaluateDatalog } from "../rules/datalog/datalog.js";
import { page, pr, snapshot } from "../testing/snapshots.js";
import { classifyFollowUp, snapshotFollowUpFacts, type FollowUpFacts } from "./deliveryread.js";

const base: FollowUpFacts = {
  draft: false,
  complete: true,
  failing: false,
  pending: false,
  unknownChecks: false,
  verified: true,
  changesRequested: false,
  unresolvedThreads: false,
  mergeable: "MERGEABLE",
  mergeState: "BLOCKED",
  headReviewed: false,
  headFindings: false,
};

/** A PR whose current head has a failed verify and whose review threads were truncated. */
const incompleteFailedPr = (failed: boolean) => {
  const p = pr();
  p.reviewThreads = page([], true, "next");
  p.commits.nodes[0]!.commit.statusCheckRollup = {
    state: failed ? "FAILURE" : "SUCCESS",
    contexts: page([
      { name: "verify", status: "COMPLETED", conclusion: failed ? "FAILURE" : "SUCCESS" },
    ]),
  };
  return p;
};

describe("observed failure with incomplete evidence (#502)", () => {
  it("is actionable, naming both the failure and the incomplete evidence", () => {
    const [state, why] = classifyFollowUp({ ...base, complete: false, failing: true });
    expect(state).toBe("actionable");
    expect(why).toContain("failing checks on the current head");
    expect(why).toContain("incomplete");
    expect(why).toContain("acceptance stays unknown");
  });

  it("stays unknown without an observed failure, whatever else looks clean", () => {
    expect(classifyFollowUp({ ...base, complete: false })).toEqual([
      "unknown",
      "check, thread or review evidence is incomplete",
    ]);
    expect(
      classifyFollowUp({ ...base, complete: false, headReviewed: true, mergeState: "CLEAN" })[0],
    ).toBe("unknown");
  });

  it("leaves complete evidence and drafts unchanged", () => {
    expect(classifyFollowUp({ ...base, failing: true })).toEqual([
      "actionable",
      "failing checks on the current head",
    ]);
    expect(classifyFollowUp({ ...base, draft: true, complete: false, failing: true })).toEqual([
      "actionable",
      "draft: the responsible agent finishes it",
    ]);
  });

  it("agrees with the briefing engine on the same snapshot PR", () => {
    for (const failed of [true, false]) {
      const p = incompleteFailedPr(failed);
      const warnings: string[] = [];
      const facts = snapshotFollowUpFacts(p, warnings);
      expect(facts.complete).toBe(false);
      expect(facts.failing).toBe(failed);
      const [state] = classifyFollowUp(facts);
      const result = evaluateDatalog(snapshot([], [p]), new Map(), {
        role: "implementer",
        limit: 50,
      });
      const prFail = result.items.some(
        (item) => item.ruleIds.includes("D-PR-FAIL") && item.target === p.url,
      );
      // Same answer: a failed check is follow-up in both paths; otherwise neither says so.
      expect(prFail).toBe(failed);
      expect(state).toBe(failed ? "actionable" : "unknown");
    }
  });
});
