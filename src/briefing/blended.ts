/**
 * The shared ranked-action output types (#248, doc/design/blended-action-queues.md "Output and
 * compatibility"). Since #1050 (doc/design/native-ranking-only.md) the native policy is the only
 * ranker; it produces these types and no TypeScript classification or comparator remains.
 */
import type { AssessmentState } from "./assessments.js";
import type { ComplexitySize } from "../estimation/complexity.js";

export const blendedPolicyVersion = 1 as const;

/** Registered action kinds. Assessment kinds never acquire a claim. */
export type ActionKind =
  | "addressed-response"
  | "pr-follow-up"
  | "decide"
  | "document"
  | "design-review"
  | "continue-implementation"
  | "implement"
  | "estimate-complexity"
  | "assess-impact"
  | "inspect-assessment"
  | "inspect"
  | "design"
  // Retained claims (#413): an explicit resume, the owned-work review and a visible wait.
  | "resume-claim"
  | "review-owned-work"
  | "inspect-ownership"
  | "wait-claim"
  // #1098: refinement work (native D-REFINE family) reaches the briefing.
  | "refine";
export type BlendedRole = "implementer" | "designer";
/**
 * 1 addressed, 2 PR follow-up, 3 designer duties and owned-work review/resume, 4 easy win,
 * 5 assessment, 6 ordinary, 7 unfavorable, 8 waiting (#413: shown, never work).
 */
export type Band = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** One `rankedActions` item (doc/design/blended-action-queues.md "Output and compatibility"). */
export interface RankedAction {
  ruleIds?: string[];
  why?: {
    text: string;
    ruleIds: string[];
    facts: Record<string, string | number | boolean>;
    overriddenRuleIds: string[];
  };
  id: string;
  kind: ActionKind;
  target: string;
  role: BlendedRole;
  band: Band;
  reasonCodes: string[];
  evidence: string[];
  nextCommand: string | null;
  /** Run after `nextCommand` succeeds (one-active-claim handoff); null otherwise. */
  thenCommand: string | null;
  inspection: string | null;
  complexity: { state: AssessmentState; size: ComplexitySize | null };
  impact: { state: AssessmentState; size: ComplexitySize | null };
  unlocks: number;
  unlocksUnknown: string[];
}
export interface RankedActions {
  policyVersion: typeof blendedPolicyVersion;
  total: number;
  omitted: number;
  items: RankedAction[];
}
