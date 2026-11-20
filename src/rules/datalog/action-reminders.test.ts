import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_OBLIGATIONS,
  RULE_REMINDERS_MAX_CODE_POINTS,
  RULE_REMINDERS_MAX_ITEMS,
  RULE_REMINDERS_SCHEMA_VERSION,
  claimObligationsHash,
  formatActionRuleRemindersText,
  selectClaimRuleReminders,
  selectNativeClaimObligations,
} from "./action-reminders.js";
import { rulesHash } from "./adapter.js";
import { buildPolicy, readSources, validateBundle, policyDir } from "./build.js";
import { narrationHashOf, rulesHashOf } from "./hash.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("native claim-time obligations and action-reminder selection (#1029)", () => {
  it("preserves bundled rulesHash and narrationHash while providing obligationsHash", () => {
    const bundle = buildPolicy();
    const res = selectClaimRuleReminders({ role: "implementer", outcome: "claimed" });
    expect(res.schemaVersion).toBe(RULE_REMINDERS_SCHEMA_VERSION);
    expect(res.effectivePolicy.rulesHash).toBe(rulesHash);
    expect(res.effectivePolicy.rulesHash).toBe(rulesHashOf(bundle));
    expect(res.effectivePolicy.narrationHash).toBe(narrationHashOf(bundle));
    expect(res.effectivePolicy.obligationsHash).toBe(claimObligationsHash());
    expect(res.effectivePolicy.obligationsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects admission rationale and implementer obligations on successful claim", () => {
    const res = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      facts: { decisionIds: ["D-PR-FAIL"] },
    });
    expect(res.label).toBe("claimed");
    expect(res.coverage.status).toBe("complete");
    expect(res.admissionRationale.map((i) => i.id)).toEqual(["D-OWN", "D-PR-FAIL"]);
    expect(res.admissionRationale.every((i) => i.sourceKind === "decision")).toBe(true);
    expect(res.obligations.map((i) => i.id)).toEqual([
      "O-CLAIM-PUBLISH-EARLY",
      "O-CLAIM-ACCEPTANCE",
      "O-CLAIM-OWNERSHIP",
      "O-CLAIM-BLOCKERS",
      "O-CLAIM-REMOVAL",
      "O-CLAIM-DELIVERABLE",
    ]);
    expect(res.obligations.every((i) => i.sourceKind === "procedural-obligation")).toBe(true);
    // 2 admission + 6 obligations = 8 selected, bounded to 6 in items; PUBLISH-EARLY leads and is
    // shown, while the tail duties are honestly omitted (reviewed #1114 bounded-display contract).
    expect(res.selectedIds).toHaveLength(8);
    expect(res.items).toHaveLength(RULE_REMINDERS_MAX_ITEMS);
    expect(res.items.some((i) => i.id === "O-CLAIM-PUBLISH-EARLY")).toBe(true);
    expect(res.omissions).toEqual({
      count: 2,
      omittedIds: ["O-CLAIM-REMOVAL", "O-CLAIM-DELIVERABLE"],
      reason: "item-limit",
      reference: "pdb rules",
    });
  });

  it("differentiates designer role from implementer role and waiting claim activity", () => {
    const res = selectClaimRuleReminders({
      role: "designer",
      outcome: "claimed",
      facts: { needsDesign: true },
    });
    expect(res.admissionRationale.map((i) => i.id)).toEqual(["D-DESIGN"]);
    expect(res.selectedIds).not.toContain("O-CLAIM-DELIVERABLE");
    expect(res.selectedIds).toContain("O-CLAIM-ACCEPTANCE");
    expect(res.coverage.status).toBe("complete");

    const designerNoDesign = selectClaimRuleReminders({
      role: "designer",
      outcome: "claimed",
      facts: { needsDesign: false },
    });
    expect(designerNoDesign.admissionRationale).toEqual([]);

    expect(
      selectClaimRuleReminders({
        role: "designer",
        outcome: "noop",
        facts: { claimActivity: "resume-required" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN-RESUME"]);

    const waitingClaim = selectClaimRuleReminders({
      role: "implementer",
      outcome: "noop",
      facts: { claimActivity: "waiting" },
    });
    expect(waitingClaim.admissionRationale.map((i) => i.id)).toEqual(["D-OWN-WAIT"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "noop",
        facts: { claimActivity: "resume-required" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN-RESUME"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "noop",
        facts: { claimActivity: "unknown" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN-UNKNOWN"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "noop",
        facts: { decisionIds: ["D-OWN-WAIT"] },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN-WAIT"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "noop",
        facts: { needsDesign: true },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "claimed",
        facts: { inventoryComplete: false },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-OWN", "D-OWNED-INCOMPLETE"]);
  });

  it("labels noop outcomes as no-op and includes continuation obligation", () => {
    const res = selectClaimRuleReminders({ role: "implementer", outcome: "noop" });
    expect(res.label).toBe("no-op");
    expect(res.selectedIds).toContain("O-CLAIM-NOOP-CONTINUE");
    expect(res.selectedIds).toContain("D-OWN");

    const unresolvedNoop = selectClaimRuleReminders({
      role: "implementer",
      outcome: "noop",
      contextResolved: false,
    });
    expect(unresolvedNoop.selectedIds).not.toContain("D-OWN");
    expect(unresolvedNoop.selectedIds).toContain("O-CLAIM-NOOP-CONTINUE");
    expect(unresolvedNoop.coverage.status).toBe("unresolved");
  });

  it("maps denied outcomes without granting newly-acquired-owner obligations", () => {
    const res = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "OWNED_BY_OTHER" },
    });
    expect(res.label).toBe("denied");
    expect(res.admissionRationale.map((i) => i.id)).toEqual(["D-DENY-CLAIM"]);
    expect(res.admissionRationale[0]?.sourceKind).toBe("denial");
    expect(res.admissionRationale[0]?.sourceFile).toBe("policy/rules.edn");
    expect(res.obligations.map((i) => i.id)).toEqual([
      "O-CLAIM-OWNERSHIP",
      "O-CLAIM-DENIED-RECOVERY",
    ]);
    expect(res.selectedIds).not.toContain("O-CLAIM-ACCEPTANCE");
    expect(res.selectedIds).not.toContain("O-CLAIM-DELIVERABLE");
    expect(res.selectedIds).not.toContain("D-OWN");
  });

  it("maps partial outcomes with recovery obligations and incomplete inventory rationale", () => {
    const res = selectClaimRuleReminders({
      role: "implementer",
      outcome: "partial",
      facts: { inventoryComplete: false, claimObserved: true },
    });
    expect(res.label).toBe("partial");
    expect(res.admissionRationale.map((i) => i.id)).toEqual(["D-OWNED-INCOMPLETE"]);
    expect(res.obligations.map((i) => i.id)).toEqual([
      "O-CLAIM-PUBLISH-EARLY",
      "O-CLAIM-OWNERSHIP",
      "O-CLAIM-REMOVAL",
      "O-CLAIM-PARTIAL-RECOVERY",
    ]);
    expect(res.selectedIds).not.toContain("O-CLAIM-ACCEPTANCE");

    const unownedPartial = selectClaimRuleReminders({
      role: "implementer",
      outcome: "partial",
      facts: { inventoryComplete: false, claimObserved: false, hasOtherClaims: false },
    });
    expect(unownedPartial.admissionRationale.map((i) => i.id)).toEqual(["D-INVENTORY-UNKNOWN"]);

    const otherObservedPartial = selectClaimRuleReminders({
      role: "implementer",
      outcome: "partial",
      facts: { inventoryComplete: false, claimObserved: false, hasOtherClaims: true },
    });
    expect(otherObservedPartial.admissionRationale.map((i) => i.id)).toEqual([
      "D-OWNED-INCOMPLETE",
    ]);

    const multiObservedPartial = selectClaimRuleReminders({
      role: "implementer",
      outcome: "partial",
      facts: { inventoryComplete: false, claimObserved: true, hasOtherClaims: true },
    });
    expect(multiObservedPartial.admissionRationale.map((i) => i.id)).toEqual([
      "D-REVIEW-OWNED-PARTIAL",
    ]);

    const unknownPartial = selectClaimRuleReminders({
      role: "implementer",
      outcome: "partial",
      facts: { inventoryComplete: false },
    });
    expect(unknownPartial.admissionRationale).toEqual([]);
    expect(unknownPartial.coverage.status).toBe("partial");
  });

  it("handles missing purposes without inventing prose", () => {
    const res = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "OWNED_BY_OTHER" },
      purposesOverride: { "D-DENY-CLAIM": undefined },
    });
    expect(res.coverage.status).toBe("partial");
    expect(res.coverage.missingPurposes).toEqual(["D-DENY-CLAIM"]);
    expect(res.admissionRationale[0]?.purposeSupplied).toBe(false);
    expect(res.admissionRationale[0]?.english).toBe(
      "Purpose not supplied (see pdb rules --rule D-DENY-CLAIM).",
    );
  });

  it("handles unresolved context and unresolved role safely", () => {
    const res = selectClaimRuleReminders({
      role: null,
      outcome: "claimed",
      contextResolved: false,
    });
    expect(res.role).toBeNull();
    expect(res.coverage.status).toBe("unresolved");
    expect(res.coverage.contextResolved).toBe(false);
    expect(res.coverage.notes.some((n) => n.includes("unresolved"))).toBe(true);
    expect(res.selectedIds).not.toContain("O-CLAIM-DELIVERABLE");
  });

  it("enforces both item and Unicode code-point limits, including on the first item", () => {
    const res = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      maxItems: 6,
      maxCodePoints: 180,
    });
    expect(res.omissions.reason).toBe("code-point-limit");
    expect(res.omissions.count).toBeGreaterThan(0);
    const totalPoints = res.items.reduce((sum, item) => sum + Array.from(item.english).length, 0);
    expect(totalPoints).toBeLessThanOrEqual(180);

    const tiny = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      maxItems: 6,
      maxCodePoints: 1,
    });
    expect(tiny.items).toEqual([]);
    expect(tiny.omissions.reason).toBe("code-point-limit");
    expect(tiny.omissions.count).toBe(tiny.selectedIds.length);

    expect(RULE_REMINDERS_MAX_CODE_POINTS).toBe(2000);
    expect(CLAIM_OBLIGATIONS.length).toBeGreaterThan(0);
  });

  it("preserves specific incomplete-evidence denial categories without guessing", () => {
    const labels = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "EVIDENCE_INCOMPLETE", labelsComplete: false },
    });
    expect(labels.admissionRationale.map((i) => i.id)).toEqual(["D-DENY-LABELS-UNKNOWN"]);
    expect(labels.coverage.status).toBe("complete");

    const explicit = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "EVIDENCE_INCOMPLETE", denialIds: ["D-DENY-CLOSING-UNKNOWN"] },
    });
    expect(explicit.admissionRationale.map((i) => i.id)).toEqual(["D-DENY-CLOSING-UNKNOWN"]);

    const unknownCategory = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "EVIDENCE_INCOMPLETE" },
    });
    expect(unknownCategory.admissionRationale).toEqual([]);
    expect(unknownCategory.coverage.status).toBe("partial");
  });

  it("maps real planClaimFor refusal codes and marks unmapped refusals as partial", () => {
    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "denied",
        facts: { error: "HAS_OPEN_PR" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-DENY-OPEN-PR"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "denied",
        facts: { error: "PLATFORM_UNKNOWN" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-DENY-PLATFORM"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "denied",
        facts: { error: "PLATFORM_MISMATCH" },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-DENY-PLATFORM"]);

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "denied",
        facts: { error: "NOT_READY", hasPrerequisite: true },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-DENY-PREREQUISITE"]);

    const notReadyPlain = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "NOT_READY" },
    });
    expect(notReadyPlain.admissionRationale).toEqual([]);
    expect(notReadyPlain.coverage.status).toBe("partial");

    const reworkNoPr = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "REWORK_NOT_AUTHORISED" },
    });
    expect(reworkNoPr.admissionRationale).toEqual([]);
    expect(reworkNoPr.coverage.status).toBe("partial");

    const singleOtherClaim = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "OTHER_ACTIVE_CLAIM", otherClaimCount: 1 },
    });
    expect(singleOtherClaim.admissionRationale).toEqual([]);
    expect(singleOtherClaim.coverage.status).toBe("partial");

    expect(
      selectClaimRuleReminders({
        role: "implementer",
        outcome: "denied",
        facts: { error: "OTHER_ACTIVE_CLAIM", otherClaimCount: 2, inventoryComplete: true },
      }).admissionRationale.map((i) => i.id),
    ).toEqual(["D-REVIEW-OWNED"]);

    const unknownId = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { denialIds: ["D-UNKNOWN"] },
    });
    expect(unknownId.coverage.unresolvedIds).toEqual(["D-UNKNOWN"]);
    expect(unknownId.coverage.status).toBe("partial");

    const mismatch = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      effectivePolicy: { rulesHash: "0000" },
    });
    expect(mismatch.coverage.status).toBe("unresolved");
    expect(mismatch.admissionRationale).toEqual([]);
    expect(mismatch.effectivePolicy.rulesHash).toBe(rulesHash);

    const unmapped = selectClaimRuleReminders({
      role: "implementer",
      outcome: "denied",
      facts: { error: "TICKET_CLOSED" },
    });
    expect(unmapped.admissionRationale).toEqual([]);
    expect(unmapped.coverage.status).toBe("partial");
    expect(unmapped.coverage.notes.some((n) => n.includes("TICKET_CLOSED"))).toBe(true);
  });

  it("formats bounded terminal text with rationale, obligations, omissions, and coverage (#1030)", () => {
    const claimed = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      facts: { decisionIds: ["D-PR-FAIL"] },
    });
    const text = formatActionRuleRemindersText(claimed);
    expect(text).toContain("Rules for this work (claimed):");
    expect(text).toContain("Admission rationale:");
    expect(text).toContain("- D-OWN [decision]:");
    expect(text).toContain("Obligations:");
    expect(text).toContain("- O-CLAIM-PUBLISH-EARLY [procedural-obligation]:");
    // PUBLISH-EARLY leads the bounded display; the two tail duties are honestly omitted.
    expect(text).toContain(
      "Omitted: 2 more rule(s); run pdb rules (e.g. pdb rules --rule O-CLAIM-REMOVAL).",
    );

    const noop = selectClaimRuleReminders({ role: "implementer", outcome: "noop" });
    expect(formatActionRuleRemindersText(noop)).toContain("Rules for this work (no-op):");

    const unresolved = selectClaimRuleReminders({
      role: null,
      outcome: "claimed",
      contextResolved: false,
    });
    expect(formatActionRuleRemindersText(unresolved)).toContain("Coverage (unresolved):");
  });

  it("selects obligations from native policy edits without editing TypeScript (#1113)", () => {
    // A policy-side applicability change flows into selection and provenance; no TS catalog path.
    const editedReader = (name: string) =>
      name === "obligations.edn"
        ? readFileSync(join(policyDir, "obligations.edn"), "utf8").replace(
            ':id "O-CLAIM-BLOCKERS" :outcome ["claimed" "noop"]',
            ':id "O-CLAIM-BLOCKERS" :outcome ["claimed" "noop"] :role ["implementer"]',
          )
        : readFileSync(join(policyDir, name), "utf8");
    const edited = readSources(editedReader);
    const recompiled = selectNativeClaimObligations(null, "claimed", edited as never);
    // Role-restricting a formerly global obligation excludes it for an unresolved role...
    expect(recompiled.ids).not.toContain("O-CLAIM-BLOCKERS");
    // ...but a resolved implementer still receives it.
    const implementer = selectNativeClaimObligations("implementer", "claimed", edited as never);
    expect(implementer.ids).toContain("O-CLAIM-BLOCKERS");
    // The shipped policy (no TS edit) still applies it to every role's claimed selection.
    const shipped = selectClaimRuleReminders({ role: "designer", outcome: "claimed" });
    expect(shipped.selectedIds).toContain("O-CLAIM-BLOCKERS");
  });

  it("is source-driven: editing an authored role restriction changes the designer matrix (#1113)", () => {
    // The designer exclusion of O-CLAIM-DELIVERABLE comes from the authored record, not a copy:
    // removing its implementer restriction makes a designer receive it too.
    const editedReader = (name: string) =>
      name === "obligations.edn"
        ? readFileSync(join(policyDir, "obligations.edn"), "utf8").replace(
            ':id "O-CLAIM-DELIVERABLE" :outcome ["claimed" "noop"] :role ["implementer"]',
            ':id "O-CLAIM-DELIVERABLE" :outcome ["claimed" "noop"]',
          )
        : readFileSync(join(policyDir, name), "utf8");
    const edited = validateBundle(readSources(editedReader));
    const designer = selectNativeClaimObligations("designer", "claimed", edited);
    expect(designer.ids).toContain("O-CLAIM-DELIVERABLE");
  });

  it("is source-driven: the #1114 work restriction comes from the authored record", () => {
    // Observational work excludes the early-publication duty because obligations.edn restricts it
    // to repository-changing; dropping that restriction makes observational work receive it too.
    const editedReader = (name: string) =>
      name === "obligations.edn"
        ? readFileSync(join(policyDir, "obligations.edn"), "utf8").replace(
            ':id "O-CLAIM-PUBLISH-EARLY" :outcome ["claimed" "noop" "partial"] :role ["implementer" "designer"] :work ["repository-changing"]',
            ':id "O-CLAIM-PUBLISH-EARLY" :outcome ["claimed" "noop" "partial"] :role ["implementer" "designer"] :work ["repository-changing" "observational"]',
          )
        : readFileSync(join(policyDir, name), "utf8");
    const edited = validateBundle(readSources(editedReader));
    // Shipped policy excludes it for observational work...
    const shipped = selectClaimRuleReminders({
      role: "implementer",
      outcome: "claimed",
      workKind: "observational",
    });
    expect(shipped.selectedIds).not.toContain("O-CLAIM-PUBLISH-EARLY");
    // ...but the edited record grants it.
    const observational = selectNativeClaimObligations(
      "implementer",
      "claimed",
      edited,
      "observational",
    );
    expect(observational.ids).toContain("O-CLAIM-PUBLISH-EARLY");
  });
});
