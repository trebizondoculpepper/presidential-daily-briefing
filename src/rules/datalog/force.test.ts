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
    // Every force denial carries an authored readable explanation (#1197 review).
    expect(result.forceDenials.filter((d) => d.text === null)).toEqual([]);
  });

  it("explains the force-only denials of unowned continuations and unknown activity", () => {
    const run = (op: string, extra: [number, string, string | number | boolean][]) =>
      evaluatePolicy({
        viewer: { role: "implementer", agent: "me", platform: "", order: "impact" },
        datoms: [
          [1, "owned-claims-complete", true],
          [1, "forward-complete", true],
          [100, "kind", "issue"],
          [100, "state", "OPEN"],
          [100, "number", 1],
          [100, "target", "https://github.com/o/r/issues/1"],
          [100, "created", 0],
          [100, "labels-complete", true],
          [100, "native-complete", true],
          [100, "reverse-complete", true],
          [100, "open-blockers", 0],
          [100, "blocking-complete", true],
          [100, "head", "not-a-pr"],
          [100, "label", "status:ready"],
          [100, "impact-state", "current"],
          [100, "impact-size", "M"],
          [100, "complexity-state", "current"],
          [100, "complexity-size", "M"],
          [100, "force-request", true],
          [100, "force-operation", op],
          [100, "force-reason", "valid"],
          [100, "force-agent", "known"],
          [100, "force-revision", "current"],
          ...extra,
        ],
      }).forceDenials;
    const texts = [
      ...run("resume", []),
      ...run("rework", []),
      ...run("resume", [
        [100, "owner", "me"],
        [100, "claim-activity", "unknown"],
        [100, "wait-reason", "claim history unreadable"],
      ]),
    ];
    expect(texts.map((d) => d.ruleId).sort()).toEqual([
      "FORCE-ACTIVITY-UNKNOWN",
      "FORCE-NOT-RESPONSIBLE",
      "FORCE-NOT-RETAINED",
    ]);
    for (const d of texts) expect(d.text).toMatch(/\w/);
  });
});
