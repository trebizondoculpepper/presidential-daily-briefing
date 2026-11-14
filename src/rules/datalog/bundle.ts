/**
 * Shape of policy.generated.json, the artifact `npm run rules:build` writes from policy/*.edn.
 * Types only: the engine imports the JSON itself, and the build writes it.
 */
import type { Schema } from "datascript";

export interface DecisionRule {
  id: string;
  kind: string;
  band: number;
  preference: number;
  /** The :when clauses as canonical EDN, for display and the English policy page (#392). */
  clauses: string;
  why: string;
  codes: string[];
  /** Complete match query: the :match template with :when appended. */
  query: string;
  /** Rule-specific witness name → complete witness query. */
  witnesses: Record<string, string>;
}

export interface PolicyBundle {
  generatedFrom: string;
  policyVersion: number;
  schema: Schema;
  constants: Record<string, (string | number | boolean)[]>;
  /** rules.edn as one canonical EDN vector. */
  clauses: string;
  comparison: string[];
  /** ordering.edn :rules as one canonical EDN vector; passed only with queries.q4. */
  sortClauses: string;
  definitions: DecisionRule[];
  denials: Record<string, string>;
  /** Named queries as canonical EDN, keyed by their queries.edn keyword without the colon. */
  queries: Record<string, string>;
  keyQueries: [string, string][];
  /** Witness name → complete witness query, for every decision. */
  commonWitnesses: Record<string, string>;
  eligibilityWitnesses: Record<string, string>;
}
