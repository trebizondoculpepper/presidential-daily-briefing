/**
 * Native action-specific rule reminder selection (#1029; doc/design/action-rule-reminders.md).
 *
 * Selects applicable rule IDs and structured procedural obligations for modifying actions
 * (starting with `claim`), reusing bundled decisions/denials and authored narration without
 * duplicating admission engines or inventing prose in renderers.
 */
import { createHash } from "node:crypto";
import englishJson from "./english.generated.json" with { type: "json" };
import { rulesHash, policyVersion } from "./adapter.js";
import type { EnglishPolicy } from "./english-model.js";
import { purposeText } from "./narration.js";

const sanitizeText = (value: string): string =>
  Array.from(value.replace(/[\r\n\t]+/g, " "))
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127 && code !== 133 && code !== 8232 && code !== 8233;
    })
    .join("");

export const RULE_REMINDERS_SCHEMA_VERSION = 1;
export const RULE_REMINDERS_MAX_ITEMS = 6;
export const RULE_REMINDERS_MAX_CODE_POINTS = 2000;

export type ReminderAction = "claim";
export type ClaimOutcome = "claimed" | "noop" | "denied" | "partial";
export type RuleReminderCategory = "admission" | "obligation";
export type RuleReminderSourceKind = "decision" | "denial" | "procedural-obligation";

export interface ProceduralObligation {
  readonly id: string;
  readonly sourceFile: string;
  readonly roles: readonly ("implementer" | "designer" | "human")[] | null;
  readonly outcomes: readonly ClaimOutcome[];
  readonly purpose: string;
}

/**
 * Structured procedural obligations authored in the rules component (#1029).
 * Kept distinct from formally validated Datalog decisions and denials.
 */
export const CLAIM_OBLIGATIONS: readonly ProceduralObligation[] = [
  {
    id: "O-CLAIM-ACCEPTANCE",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["claimed", "noop"],
    purpose:
      "Follow the ticket acceptance criteria and applicable architecture contracts before considering the work complete.",
  },
  {
    id: "O-CLAIM-OWNERSHIP",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["claimed", "noop", "denied", "partial"],
    purpose:
      "Respect human ownership and other agents' active claims; never overwrite or displace another owner's work.",
  },
  {
    id: "O-CLAIM-BLOCKERS",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["claimed", "noop"],
    purpose:
      "Surface blockers, missing design decisions, or unresolved questions explicitly instead of guessing.",
  },
  {
    id: "O-CLAIM-REMOVAL",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["claimed", "noop", "partial"],
    purpose:
      "Preserve useful unfinished work and share a truthful handoff if your claim is released or removed.",
  },
  {
    id: "O-CLAIM-DELIVERABLE",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: ["implementer"],
    outcomes: ["claimed", "noop"],
    purpose:
      "For an implementation deliverable, retain responsibility through review, CI checks, fixes, and merging.",
  },
  {
    id: "O-CLAIM-NOOP-CONTINUE",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["noop"],
    purpose:
      "This ticket is already claimed by you (no-op); continue from the existing work rather than re-claiming.",
  },
  {
    id: "O-CLAIM-PARTIAL-RECOVERY",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["partial"],
    purpose:
      "Claim writes were partial or unverified; inspect the live ticket state and retry only the missing steps.",
  },
  {
    id: "O-CLAIM-DENIED-RECOVERY",
    sourceFile: "src/rules/datalog/action-reminders.ts",
    roles: null,
    outcomes: ["denied"],
    purpose:
      "Claim was refused; do not start work until the reported prerequisite or ownership conflict is resolved.",
  },
];

for (const obligation of CLAIM_OBLIGATIONS) {
  purposeText(obligation.purpose, `action-reminders:${obligation.id}`);
}

let cachedObligationsHash: string | undefined;
export function claimObligationsHash(): string {
  if (!cachedObligationsHash) {
    cachedObligationsHash = createHash("sha256")
      .update(
        JSON.stringify({
          obligations: CLAIM_OBLIGATIONS,
          refusalMapper: refusalErrorToRuleId.toString(),
          ownClaimSelector: ownClaimDecisionId.toString(),
          selector: selectClaimRuleReminders.toString(),
        }),
      )
      .digest("hex");
  }
  return cachedObligationsHash;
}

const bundledEnglishModel = (): EnglishPolicy => englishJson as EnglishPolicy;

export interface ClaimReminderFactInput {
  /** Refusal error code from claim planning (e.g. OWNED_BY_OTHER, OTHER_ACTIVE_CLAIM). */
  error?: string;
  /** Explicit native denial IDs (e.g. D-DENY-CLAIM). */
  denialIds?: readonly string[];
  /** Explicit native decision IDs (e.g. D-OWN, D-PR-FAIL, D-REVIEW-OWNED). */
  decisionIds?: readonly string[];
  hasOtherClaims?: boolean;
  /** Number of other active claims when known (D-REVIEW-OWNED requires > 1). */
  otherClaimCount?: number;
  /** Whether a claim on this ticket was observed after a partial write. */
  claimObserved?: boolean;
  inventoryComplete?: boolean;
  labelsComplete?: boolean;
  closingComplete?: boolean;
  nativeComplete?: boolean;
  hasOpenPr?: boolean;
  hasBlockers?: boolean;
  needsDesign?: boolean;
  /** True when a NOT_READY refusal is caused by a prerequisite label rather than missing readiness. */
  hasPrerequisite?: boolean;
  claimActivity?: "active" | "waiting" | "resume-required" | "unknown";
}

export interface SelectClaimRemindersInput {
  action?: ReminderAction;
  role?: string | null;
  outcome: ClaimOutcome;
  facts?: ClaimReminderFactInput;
  /** False when live claim/policy context could not be fully resolved. */
  contextResolved?: boolean;
  effectivePolicy?: {
    rulesHash?: string;
    narrationHash?: string | null;
    projectRulesHash?: string | null;
  };
  /** Optional model override for tests; defaults to bundled english.generated.json. */
  model?: EnglishPolicy;
  /** Optional purpose overrides (including `undefined`) to test missing-purpose handling. */
  purposesOverride?: Record<string, string | undefined>;
  maxItems?: number;
  maxCodePoints?: number;
}

export interface RuleReminderItem {
  id: string;
  category: RuleReminderCategory;
  sourceKind: RuleReminderSourceKind;
  sourceFile: string;
  english: string;
  purposeSupplied: boolean;
  reference: string;
}

export interface ActionRuleReminders {
  schemaVersion: typeof RULE_REMINDERS_SCHEMA_VERSION;
  action: ReminderAction;
  role: string | null;
  outcome: ClaimOutcome;
  label: "claimed" | "no-op" | "denied" | "partial";
  effectivePolicy: {
    policyVersion: number;
    rulesHash: string;
    narrationHash: string | null;
    obligationsHash: string;
    projectRulesHash: string | null;
  };
  admissionRationale: RuleReminderItem[];
  obligations: RuleReminderItem[];
  items: RuleReminderItem[];
  selectedIds: string[];
  omissions: {
    count: number;
    omittedIds: string[];
    reason: "none" | "item-limit" | "code-point-limit";
    reference: string;
  };
  coverage: {
    status: "complete" | "partial" | "unresolved";
    contextResolved: boolean;
    missingPurposes: string[];
    unresolvedIds: string[];
    notes: string[];
  };
}

function ownClaimDecisionId(activity: ClaimReminderFactInput["claimActivity"]): string {
  switch (activity) {
    case "waiting":
      return "D-OWN-WAIT";
    case "resume-required":
      return "D-OWN-RESUME";
    case "unknown":
      return "D-OWN-UNKNOWN";
    default:
      return "D-OWN";
  }
}

function refusalErrorToRuleId(
  error: string | undefined,
  facts: ClaimReminderFactInput,
): string | null {
  switch (error) {
    case "OWNED_BY_OTHER":
      return "D-DENY-CLAIM";
    case "OTHER_ACTIVE_CLAIM":
      if ((facts.otherClaimCount ?? 0) > 1) {
        return facts.inventoryComplete === true ? "D-REVIEW-OWNED" : "D-REVIEW-OWNED-PARTIAL";
      }
      return null;
    case "EVIDENCE_INCOMPLETE":
      if (facts.labelsComplete === false) return "D-DENY-LABELS-UNKNOWN";
      if (facts.closingComplete === false) return "D-DENY-CLOSING-UNKNOWN";
      if (facts.nativeComplete === false) return "D-DENY-NATIVE-UNKNOWN";
      if (facts.inventoryComplete === false) return "D-DENY-INVENTORY-UNKNOWN";
      return null;
    case "BLOCKED":
    case "BLOCKED_BY_DEPENDENCY":
      return "D-DENY-BLOCKER";
    case "HAS_OPEN_PR":
    case "OPEN_PR":
    case "HAS_CLOSING_PR":
      return "D-DENY-OPEN-PR";
    case "REWORK_NOT_AUTHORISED":
      return facts.hasOpenPr ? "D-DENY-OPEN-PR" : null;
    case "NOT_READY":
      return facts.hasPrerequisite || facts.needsDesign ? "D-DENY-PREREQUISITE" : null;
    case "PREREQUISITE":
    case "NEEDS_DESIGN":
      return "D-DENY-PREREQUISITE";
    case "PLATFORM_UNKNOWN":
    case "PLATFORM_MISMATCH":
    case "PLATFORM":
    case "PLATFORM_UNSUPPORTED":
      return "D-DENY-PLATFORM";
    default:
      return null;
  }
}

function resolvePolicyRule(
  id: string,
  category: RuleReminderCategory,
  model: EnglishPolicy,
  purposesOverride: Record<string, string | undefined> | undefined,
  missingPurposes: string[],
): RuleReminderItem | null {
  const decision = model.decisions.find((d) => d.id === id);
  const denial = decision ? undefined : model.denials.find((d) => d.id === id);
  if (!decision && !denial) return null;

  const sourceKind: RuleReminderSourceKind = decision ? "decision" : "denial";
  const sourceFile = decision ? "policy/decisions.edn" : "policy/rules.edn";
  const rawPurpose =
    purposesOverride && Object.prototype.hasOwnProperty.call(purposesOverride, id)
      ? purposesOverride[id]
      : (decision?.purpose ?? denial?.purpose);
  const cleanPurpose = typeof rawPurpose === "string" ? sanitizeText(rawPurpose).trim() : "";

  if (!cleanPurpose) {
    missingPurposes.push(id);
    return {
      id,
      category,
      sourceKind,
      sourceFile,
      english: `Purpose not supplied (see pdb rules --rule ${id}).`,
      purposeSupplied: false,
      reference: `pdb rules --rule ${id}`,
    };
  }

  return {
    id,
    category,
    sourceKind,
    sourceFile,
    english: cleanPurpose,
    purposeSupplied: true,
    reference: `pdb rules --rule ${id}`,
  };
}

function outcomeLabel(outcome: ClaimOutcome): ActionRuleReminders["label"] {
  if (outcome === "noop") return "no-op";
  return outcome;
}

function normalizeRole(
  role: string | null | undefined,
): "implementer" | "designer" | "human" | null {
  if (role === "implementer" || role === "designer" || role === "human") return role;
  return null;
}

/**
 * Select applicable admission rationale and post-action procedural obligations for a claim outcome.
 */
export function selectClaimRuleReminders(input: SelectClaimRemindersInput): ActionRuleReminders {
  const model = input.model ?? bundledEnglishModel();
  const facts = input.facts ?? {};
  const contextResolved = input.contextResolved ?? true;
  const normalizedRole = normalizeRole(input.role);
  const maxItems = Math.min(
    RULE_REMINDERS_MAX_ITEMS,
    Math.max(1, input.maxItems ?? RULE_REMINDERS_MAX_ITEMS),
  );
  const maxCodePoints = Math.min(
    RULE_REMINDERS_MAX_CODE_POINTS,
    Math.max(1, input.maxCodePoints ?? RULE_REMINDERS_MAX_CODE_POINTS),
  );

  const modelRulesHash = model.rulesHash ?? rulesHash;
  const modelNarrationHash = model.narrationHash ?? null;
  const policyMismatch =
    (input.effectivePolicy?.rulesHash !== undefined &&
      input.effectivePolicy.rulesHash !== modelRulesHash) ||
    (input.effectivePolicy?.narrationHash !== undefined &&
      input.effectivePolicy.narrationHash !== modelNarrationHash);

  const missingPurposes: string[] = [];
  const unresolvedIds: string[] = [];
  const notes: string[] = [];
  const seenIds = new Set<string>();
  const admissionRationale: RuleReminderItem[] = [];
  const obligations: RuleReminderItem[] = [];

  const addPolicyItem = (id: string | null | undefined, category: RuleReminderCategory): void => {
    if (!id || seenIds.has(id) || policyMismatch) return;
    const resolved = resolvePolicyRule(
      id,
      category,
      model,
      input.purposesOverride,
      missingPurposes,
    );
    if (!resolved) {
      unresolvedIds.push(id);
      return;
    }
    seenIds.add(id);
    if (category === "admission") admissionRationale.push(resolved);
    else obligations.push(resolved);
  };

  let unresolvedEvidenceCategory = false;
  let unmappedRefusal = false;
  let unverifiedPartialOwnership = false;
  if (!policyMismatch) {
    if (input.outcome === "denied") {
      const explicitDenials = facts.denialIds ?? [];
      for (const id of explicitDenials) addPolicyItem(id, "admission");
      if (explicitDenials.length === 0) {
        const mapped = refusalErrorToRuleId(facts.error, facts);
        if (mapped) addPolicyItem(mapped, "admission");
        else if (facts.error === "EVIDENCE_INCOMPLETE") unresolvedEvidenceCategory = true;
        else if ((facts.decisionIds ?? []).length === 0) unmappedRefusal = true;
      }
      for (const id of facts.decisionIds ?? []) addPolicyItem(id, "admission");
    } else if (input.outcome === "partial") {
      for (const id of facts.denialIds ?? []) addPolicyItem(id, "admission");
      if (facts.inventoryComplete === false) {
        const observedCount =
          (facts.claimObserved === true ? 1 : 0) +
          (facts.otherClaimCount ?? (facts.hasOtherClaims === true ? 1 : 0));
        if (observedCount > 1) {
          addPolicyItem("D-REVIEW-OWNED-PARTIAL", "admission");
        } else if (facts.claimObserved === true || facts.hasOtherClaims === true) {
          addPolicyItem("D-OWNED-INCOMPLETE", "admission");
        } else if (facts.claimObserved === false && facts.hasOtherClaims === false) {
          addPolicyItem("D-INVENTORY-UNKNOWN", "admission");
        } else {
          unverifiedPartialOwnership = true;
        }
      }
      for (const id of facts.decisionIds ?? []) addPolicyItem(id, "admission");
    } else {
      // claimed or noop
      const ownDecisionIds = new Set([
        "D-OWN",
        "D-OWN-WAIT",
        "D-OWN-RESUME",
        "D-OWN-UNKNOWN",
        "D-OWN-EASY",
        "D-OWN-UNFAVORABLE",
      ]);
      const hasExplicitOwnDecision = (facts.decisionIds ?? []).some((id) => ownDecisionIds.has(id));
      if (normalizedRole === "implementer" && !hasExplicitOwnDecision) {
        if (facts.claimActivity !== undefined || contextResolved) {
          addPolicyItem(ownClaimDecisionId(facts.claimActivity), "admission");
        }
      } else if (normalizedRole === "designer") {
        if (input.outcome === "claimed" && facts.needsDesign) {
          addPolicyItem("D-DESIGN", "admission");
        }
        if (
          !hasExplicitOwnDecision &&
          (facts.claimActivity === "waiting" ||
            facts.claimActivity === "resume-required" ||
            facts.claimActivity === "unknown")
        ) {
          addPolicyItem(ownClaimDecisionId(facts.claimActivity), "admission");
        }
      }
      if (facts.hasOtherClaims) {
        addPolicyItem(
          facts.inventoryComplete === true ? "D-REVIEW-OWNED" : "D-REVIEW-OWNED-PARTIAL",
          "admission",
        );
      } else if (facts.inventoryComplete === false) {
        addPolicyItem("D-OWNED-INCOMPLETE", "admission");
      }
      for (const id of facts.decisionIds ?? []) addPolicyItem(id, "admission");
    }
  }

  for (const obl of CLAIM_OBLIGATIONS) {
    if (!obl.outcomes.includes(input.outcome)) continue;
    if (obl.roles !== null && (!normalizedRole || !obl.roles.includes(normalizedRole))) continue;
    if (seenIds.has(obl.id)) continue;
    seenIds.add(obl.id);
    obligations.push({
      id: obl.id,
      category: "obligation",
      sourceKind: "procedural-obligation",
      sourceFile: obl.sourceFile,
      english: sanitizeText(obl.purpose),
      purposeSupplied: true,
      reference: `pdb rules --rule ${obl.id}`,
    });
  }

  const allItems = [...admissionRationale, ...obligations];
  const selectedIds = allItems.map((i) => i.id);

  const bounded: RuleReminderItem[] = [];
  let usedCodePoints = 0;
  let omissionReason: "none" | "item-limit" | "code-point-limit" = "none";

  for (const item of allItems) {
    if (bounded.length >= maxItems) {
      omissionReason = "item-limit";
      break;
    }
    const itemLen = Array.from(item.english).length;
    if (usedCodePoints + itemLen > maxCodePoints) {
      omissionReason = "code-point-limit";
      break;
    }
    bounded.push(item);
    usedCodePoints += itemLen;
  }

  if (policyMismatch) {
    notes.push(
      "Effective policy identity does not match the bundled English model; policy-matched explanations are omitted.",
    );
  }
  if (!contextResolved) {
    notes.push(
      "Reminder context is unresolved; showing only applicable baseline rules without inventing ticket-specific instructions.",
    );
  }
  if (!normalizedRole) {
    notes.push("Viewer role is unresolved; role-specific deliverable obligations are omitted.");
  }
  if (unresolvedEvidenceCategory) {
    notes.push("Incomplete-evidence refusal did not identify a specific native denial category.");
  }
  if (unmappedRefusal) {
    notes.push(
      `Refusal ${facts.error ? sanitizeText(facts.error) : "reason"} has no single mapped Datalog denial rule; see the refusal prerequisite.`,
    );
  }
  if (unverifiedPartialOwnership) {
    notes.push(
      "Partial claim outcome did not establish whether ownership was written; verify live ticket state.",
    );
  }
  if (unresolvedIds.length > 0) {
    notes.push(`Unresolved rule ID(s) absent from the English model: ${unresolvedIds.join(", ")}.`);
  }
  if (missingPurposes.length > 0) {
    notes.push(`Purpose not supplied for ${missingPurposes.length} rule(s); see pdb rules.`);
  }

  const coverageStatus: ActionRuleReminders["coverage"]["status"] =
    !contextResolved || policyMismatch
      ? "unresolved"
      : !normalizedRole ||
          missingPurposes.length > 0 ||
          unresolvedEvidenceCategory ||
          unmappedRefusal ||
          unverifiedPartialOwnership ||
          unresolvedIds.length > 0
        ? "partial"
        : "complete";

  const omittedIds = allItems.slice(bounded.length).map((i) => i.id);

  return {
    schemaVersion: RULE_REMINDERS_SCHEMA_VERSION,
    action: input.action ?? "claim",
    role: normalizedRole,
    outcome: input.outcome,
    label: outcomeLabel(input.outcome),
    effectivePolicy: {
      policyVersion,
      rulesHash: modelRulesHash,
      narrationHash: modelNarrationHash,
      obligationsHash: claimObligationsHash(),
      projectRulesHash: input.effectivePolicy?.projectRulesHash ?? null,
    },
    admissionRationale,
    obligations,
    items: bounded,
    selectedIds,
    omissions: {
      count: omittedIds.length,
      omittedIds,
      reason: omittedIds.length === 0 ? "none" : omissionReason,
      reference: "pdb rules",
    },
    coverage: {
      status: coverageStatus,
      contextResolved: contextResolved && !policyMismatch,
      missingPurposes,
      unresolvedIds,
      notes,
    },
  };
}

/**
 * Format bounded action-rule reminders into plain terminal text (#1030).
 * Keeps admission rationale distinct from procedural obligations and preserves omission/coverage notices.
 */
export function formatActionRuleRemindersText(reminders: ActionRuleReminders): string {
  const lines: string[] = ["", `Rules for this work (${reminders.label}):`];
  const admission = reminders.items.filter((i) => i.category === "admission");
  const obligations = reminders.items.filter((i) => i.category === "obligation");

  if (admission.length > 0) {
    lines.push("Admission rationale:");
    for (const item of admission) {
      lines.push(
        `- ${item.id} [${item.sourceKind}]: ${sanitizeText(item.english)} (${item.reference})`,
      );
    }
  }
  if (obligations.length > 0) {
    lines.push("Obligations:");
    for (const item of obligations) {
      lines.push(
        `- ${item.id} [${item.sourceKind}]: ${sanitizeText(item.english)} (${item.reference})`,
      );
    }
  }
  if (reminders.omissions.count > 0) {
    const sample = reminders.omissions.omittedIds[0];
    const hint = sample ? ` (e.g. pdb rules --rule ${sample})` : "";
    lines.push(
      `Omitted: ${reminders.omissions.count} more rule(s); run ${reminders.omissions.reference}${hint}.`,
    );
  }
  if (reminders.coverage.status !== "complete" || reminders.coverage.notes.length > 0) {
    const detail = reminders.coverage.notes.map(sanitizeText).join(" ");
    lines.push(`Coverage (${reminders.coverage.status})${detail ? `: ${detail}` : ""}`);
  }
  const text = `${lines.join("\n")}\n`;
  const points = Array.from(text);
  if (points.length <= RULE_REMINDERS_MAX_CODE_POINTS) return text;
  return `${points
    .slice(0, RULE_REMINDERS_MAX_CODE_POINTS - 4)
    .join("")
    .trimEnd()}...\n`;
}
