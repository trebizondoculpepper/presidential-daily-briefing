/**
 * Force decisions (#1021): the complete force-denial relation is exposed uncapped, so a host can
 * report every refusing or overridden rule even when the explanation text is bounded at eight.
 */
import { describe, expect, it } from "vite-plus/test";
import { evaluatePolicy } from "./engine.js";

describe("force denials (#1021 review)", () => {
  it("reports every force denial even when the explanation is capped", () => {
    const t = 100;
    const result = evaluatePolicy({
      viewer: { role: "implementer", agent: "me", platform: "", order: "impact" },
      datoms: [
        [1, "owned-claims-complete", false],
        [t, "kind", "issue"],
        [t, "state", "OPEN"],
        [t, "number", 1],
        [t, "target", "https://github.com/o/r/issues/1"],
        [t, "created", 0],
        [t, "labels-complete", false],
        [t, "native-complete", false],
        [t, "open-blockers", 1],
        [t, "blocking-complete", true],
        [t, "impact-state", "current"],
        [t, "impact-size", "M"],
        [t, "complexity-state", "current"],
        [t, "complexity-size", "M"],
        [t, "head", "not-a-pr"],
        [t, "label", "status:needs-design"],
        [t, "platform", "kilo"],
        [t, "closing", 500],
        [500, "state", "OPEN"],
        [t, "refinement", 200],
        [200, "refinement-state", "unknown"],
        [t, "force-request", true],
        [t, "force-operation", "claim"],
        [t, "force-reason", "valid"],
        [t, "force-agent", "known"],
        [t, "force-revision", "current"],
      ],
    });
    const ids = result.forceDenials.filter((d) => d.subject === t).map((d) => d.ruleId);
    expect(ids.length).toBeGreaterThan(8);
    expect(ids).toEqual([...ids].sort());
    const decision = result.decisions.find((d) => d.ruleId === "D-FORCE-REFUSE-TECHNICAL")!;
    // The text names at most eight; the uncapped relation has them all.
    expect(decision.why.text.split(". Force")[0]!.split("; ")).toHaveLength(8);
    for (const id of ["CLAIM-NOT-READY", "D-DENY-OPEN-PR", "D-DENY-REFINEMENT-UNKNOWN"])
      expect(ids).toContain(id);
  });
});
