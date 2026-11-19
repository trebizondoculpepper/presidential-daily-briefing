/**
 * Host-to-policy bridge for Human-view Unassign (#588, doc/design/human-unassign.md).
 *
 * All Unassign policy rules live in `src/rules/datalog/policy/decisions.edn` and are compiled
 * into `policy.generated.json`. This module asserts the verified facts as datoms and delegates
 * evaluation to the canonical shared `evaluatePolicy` engine.
 */
import type { Datom } from "datascript";
import { evaluatePolicy } from "./engine.js";

export type UnassignPermission = "allow" | "deny" | "unknown";

export interface UnassignRuleFacts {
  issueNumber: number;
  issueState: "OPEN" | "CLOSED";
  agent: string;
  claimPresent: boolean;
  claimStart: string | null;
  claimHistoryComplete: boolean;
  trustedHumanContext: boolean;
  permission: UnassignPermission;
  overrideUnknownHistory: boolean;
}

export type UnassignDecisionCode =
  | "UNASSIGN_ALLOWED"
  | "UNASSIGN_NOOP"
  | "HUMAN_CONTEXT_REQUIRED"
  | "PERMISSION_DENIED"
  | "PERMISSION_UNKNOWN"
  | "EVIDENCE_INCOMPLETE";

export interface UnassignDecision {
  verdict: "allow" | "noop" | "refuse";
  code: UnassignDecisionCode;
  reason: string;
  witness: string[];
}

const KIND_TO_OUTCOME: Record<
  string,
  { verdict: UnassignDecision["verdict"]; code: UnassignDecisionCode }
> = {
  "unassign-allow": { verdict: "allow", code: "UNASSIGN_ALLOWED" },
  "unassign-noop": { verdict: "noop", code: "UNASSIGN_NOOP" },
  "unassign-refuse-context": { verdict: "refuse", code: "HUMAN_CONTEXT_REQUIRED" },
  "unassign-refuse-permission-denied": { verdict: "refuse", code: "PERMISSION_DENIED" },
  "unassign-refuse-permission-unknown": { verdict: "refuse", code: "PERMISSION_UNKNOWN" },
  "unassign-refuse-evidence": { verdict: "refuse", code: "EVIDENCE_INCOMPLETE" },
};

const UNASSIGN_SUBJECT_ID = 100;

/** Evaluate the canonical native Unassign policy over verified facts (#588). */
export function evaluateUnassignDecision(facts: UnassignRuleFacts): UnassignDecision {
  const datoms: Datom[] = [
    [1, "trusted-human-context", facts.trustedHumanContext],
    [1, "permission", facts.permission],
    [1, "override-unknown-history", facts.overrideUnknownHistory],
    [UNASSIGN_SUBJECT_ID, "unassign-subject", true],
    [UNASSIGN_SUBJECT_ID, "kind", "unassign"],
    [UNASSIGN_SUBJECT_ID, "state", facts.issueState],
    [UNASSIGN_SUBJECT_ID, "number", facts.issueNumber],
    [UNASSIGN_SUBJECT_ID, "target", `issue:${facts.issueNumber}`],
    [UNASSIGN_SUBJECT_ID, "created", 0],
    [UNASSIGN_SUBJECT_ID, "labels-complete", true],
    [UNASSIGN_SUBJECT_ID, "native-complete", true],
    [UNASSIGN_SUBJECT_ID, "reverse-complete", true],
    [UNASSIGN_SUBJECT_ID, "open-blockers", 0],
    [UNASSIGN_SUBJECT_ID, "blocking-complete", true],
    [UNASSIGN_SUBJECT_ID, "impact-size", "unknown"],
    [UNASSIGN_SUBJECT_ID, "impact-state", "unknown"],
    [UNASSIGN_SUBJECT_ID, "complexity-size", "unknown"],
    [UNASSIGN_SUBJECT_ID, "complexity-state", "unknown"],
    [UNASSIGN_SUBJECT_ID, "head", "not-a-pr"],
    [UNASSIGN_SUBJECT_ID, "unassign-agent", facts.agent],
    [UNASSIGN_SUBJECT_ID, "claim-present", facts.claimPresent],
    [UNASSIGN_SUBJECT_ID, "claim-history-complete", facts.claimHistoryComplete],
    [UNASSIGN_SUBJECT_ID, "claim-start", facts.claimStart ?? ""],
  ];
  const evaluation = evaluatePolicy({
    viewer: { role: "human", agent: "", platform: "", order: "oldest" },
    datoms,
  });
  const matched = evaluation.decisions.find(
    (a) => a.subject === UNASSIGN_SUBJECT_ID && a.kind in KIND_TO_OUTCOME,
  );
  const witness = [
    `issue:#${facts.issueNumber}(${facts.issueState})`,
    `agent:${facts.agent}`,
    `claimPresent:${String(facts.claimPresent)}`,
    `claimStart:${facts.claimStart ?? "unknown"}`,
    `historyComplete:${String(facts.claimHistoryComplete)}`,
    `permission:${facts.permission}`,
    `trustedHumanContext:${String(facts.trustedHumanContext)}`,
    ...(facts.overrideUnknownHistory ? ["overrideUnknownHistory:true"] : []),
  ];
  if (!matched) {
    return {
      verdict: "refuse",
      code: "EVIDENCE_INCOMPLETE",
      reason: `Unassign preconditions for agent:${facts.agent} on #${facts.issueNumber} could not be established.`,
      witness,
    };
  }
  const mapped = KIND_TO_OUTCOME[matched.kind]!;
  return {
    verdict: mapped.verdict,
    code: mapped.code,
    reason: matched.why.text,
    witness,
  };
}
