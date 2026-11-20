/**
 * Shape of policy.generated.json, the artifact `npm run rules:build` writes from policy/*.edn.
 * The engine imports the JSON itself, and the build writes it; this module holds its type and
 * the query names both of them rely on.
 */
import type { Schema } from "datascript";

/**
 * Every named query the engine runs. The engine reads queries only through these names (the
 * bundle type enforces it), and the build fails if policy/queries.edn lacks one or defines a
 * query the engine never runs, so a rename cannot surface as a runtime failure.
 */
export const requiredQueries = [
  "check-ready",
  "check-blockers",
  "discussion-ranked",
  "discussion-unknown",
  "pr-blockers",
  "review-head-reviewed",
  "review-head-findings",
  "delivery-follow-up",
  "human-sections",
  "q0",
  "declared-overrides",
  "q1",
  "q2",
  "q3",
  "q4",
  "q5",
  "q6",
  "q7",
  "unknown-unlocks",
  "active-dependents",
  "denials",
  "claim-denials",
  "claim-obligations",
  "other-claims",
  "active-count",
  "missing-active-count",
] as const;
export type RequiredQuery = (typeof requiredQueries)[number];

/** Sort-key attributes the ordering rules read; each needs exactly one key query. */
export const requiredKeyQueries = [
  "own-key",
  "linked-key",
  "incomplete-key",
  "urgency-key",
] as const;

/** A declared precedence exception: when both rules match one subject, the winner overrides. */
export interface OverridePair {
  winner: string;
  loser: string;
}

export interface DecisionRule {
  id: string;
  /** Authored literal purpose, excluded from rule matching. */
  purpose?: string;
  kind: string;
  band: number;
  preference: number;
  /** The duty's role affinity (#651): an ordering key, never a membership gate. */
  affinity: "implementer" | "designer" | "shared" | "human";
  /** A positively owned obligation (#651): ranks before every new activity. */
  owned: boolean;
  /** The :when clauses as canonical EDN, for display and the English policy page (#392). */
  clauses: string;
  why: string;
  codes: string[];
  /** Complete match query: the :match template with :when appended. */
  query: string;
  /** Rule-specific witness name → complete witness query. */
  witnesses: Record<string, string>;
}

/**
 * schema.edn :lexicon: a phrase naming each input attribute and viewer fact, for the English
 * compiler. It names inputs only and never describes a rule. The engine does not read it.
 */
export interface Lexicon {
  attributes: Record<string, string>;
  viewer: Record<string, string>;
}

export interface PolicyBundle {
  generatedFrom: string;
  policyVersion: number;
  lexicon: Lexicon;
  schema: Schema;
  constants: Record<string, (string | number | boolean)[]>;
  /** obligations.edn :obligations, in source order (#1113). */
  obligations: { id: string; outcome: string[]; role?: string[]; purpose: string }[];
  /** rules.edn as one canonical EDN vector. */
  clauses: string;
  comparison: string[];
  /**
   * ordering.edn :overrides, in source order. The engine passes them to the
   * `declared-overrides` query as [winner loser] tuples; `pdb rules` renders the same list.
   */
  overrides: OverridePair[];
  /** ordering.edn :rules as one canonical EDN vector; passed only with queries.q4. */
  sortClauses: string;
  definitions: DecisionRule[];
  denials: Record<string, string>;
  /** Optional literal purposes keyed by declared denial ID. */
  denialPurposes?: Record<string, string>;
  /** Named queries as canonical EDN, keyed by their queries.edn keyword without the colon. */
  queries: Record<RequiredQuery, string>;
  keyQueries: [string, string][];
  /** Witness name → complete witness query, for every decision. */
  commonWitnesses: Record<string, string>;
  eligibilityWitnesses: Record<string, string>;
}
