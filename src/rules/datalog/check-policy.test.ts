import { describe, expect, it } from "vite-plus/test";
import { evaluateCheckPolicy } from "./engine.js";
import type { CheckEvidence } from "./check-types.js";

const evidence = (extra: Partial<CheckEvidence> = {}): CheckEvidence => ({
  complete: true,
  gaps: [],
  checks: [],
  missing: [],
  ...extra,
});
describe("native target required-check policy (#676)", () => {
  it("accepts a known empty set and a differently named successful requirement", () => {
    expect(evaluateCheckPolicy(evidence()).ready).toBe(true);
    expect(
      evaluateCheckPolicy(
        evidence({ checks: [{ name: "CI gate", outcome: "SUCCESS", required: "required" }] }),
      ),
    ).toMatchObject({ ready: true, blockers: [] });
  });
  it.each(["PENDING", "FAILURE", "NEUTRAL", "SKIPPED", "CANCELLED"])(
    "does not accept a required verify with outcome %s",
    (outcome) => {
      expect(
        evaluateCheckPolicy(
          evidence({ checks: [{ name: "verify", outcome, required: "required" }] }),
        ),
      ).toMatchObject({ ready: false, blockers: [`Required check verify is ${outcome}`] });
    },
  );
  it("does not invent verify when a real required check is missing", () => {
    expect(evaluateCheckPolicy(evidence({ missing: ["build"] }))).toMatchObject({
      ready: false,
      blockers: ["Required check not yet reported: build"],
    });
  });
  it("names the native reason rule and policy revision", () => {
    expect(evaluateCheckPolicy(evidence({ missing: ["build"] }))).toMatchObject({
      policyVersion: 1,
      reasons: [{ ruleId: "RC-MISSING", text: "Required check not yet reported: build" }],
    });
  });
  it("keeps unread requirements and ambiguous requiredness unproven", () => {
    expect(
      evaluateCheckPolicy(evidence({ complete: false, gaps: ["rules unread"] })),
    ).toMatchObject({ ready: false, blockers: ["Required-check evidence unknown: rules unread"] });
    expect(
      evaluateCheckPolicy(
        evidence({ checks: [{ name: "same name", outcome: "SUCCESS", required: "unknown" }] }),
      ),
    ).toMatchObject({ ready: false, blockers: ["Requiredness unknown: same name"] });
  });
});
