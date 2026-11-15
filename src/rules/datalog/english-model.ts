/**
 * The compiled English policy model (doc/design/rules-english-command.md, #416).
 *
 * `npm run rules:build` compiles the validated policy bundle into this model and writes it to
 * english.generated.json. The model is structural: every clause of every rule, predicate, query
 * and witness is kept with its variables and grouping, and each input attribute carries only the
 * lexicon phrase from policy/schema.edn. No rule-specific prose is authored anywhere. `pdb rules`
 * and the web rules page (#392) render this model; neither needs the build-time EDN reader.
 */

/** Version of this model's own shape. */
export const ENGLISH_MODEL_VERSION = 1;

/** A clause argument: a variable, a literal value, or DataScript's `_` wildcard. */
export type Term = { var: string } | { lit: string | number | boolean } | { wild: true };

/**
 * What a fact pattern on entity 1 is about. Entity 1 holds the viewer, the constant sets and
 * the few context facts the engine asserts there; every other entity is a subject or rule.
 */
export type FactScope = "viewer" | "constant" | "context" | "entity";

export type Clause =
  | {
      type: "fact";
      scope: FactScope;
      entity: Term;
      attribute: string;
      value: Term;
      /** Lexicon phrase for the attribute; for a constant set, null (the set is named instead). */
      phrase: string | null;
      /** Whether the attribute is cardinality-many (several values may be present). */
      many: boolean;
    }
  | { type: "call"; predicate: string; args: Term[] }
  | { type: "not"; join: string[] | null; body: Clause[] }
  | { type: "or"; join: string[] | null; alternatives: Clause[][] }
  | { type: "compare"; op: string; args: Term[] }
  | { type: "bind"; fn: string; args: Term[]; result: string };

/** Where a construct came from, without build-machine paths. */
export interface SourceRef {
  file: string;
  /** Position within the file's vector or map, in source order. */
  index: number;
}

export interface CompiledPredicate {
  name: string;
  params: string[];
  /** Each alternative definition is a conjunction; the alternatives are a disjunction. */
  alternatives: { clauses: Clause[]; source: SourceRef }[];
  /** Predicates this one calls, in first-call order. */
  calls: string[];
  /** rules.edn predicates are shared; ordering.edn predicates are passed only to sorting. */
  set: "rules" | "ordering";
}

export interface CompiledEvidence {
  name: string;
  /** "common", "eligibility" or the rule's own binding. */
  scope: "common" | "eligibility" | "rule";
  clauses: Clause[];
}

export interface CompiledDecision {
  id: string;
  kind: string;
  band: number;
  preference: number;
  codes: string[];
  /** Roles named by a top-level `[1 "role" "..."]` fact, or null when the rule names none. */
  roles: string[] | null;
  clauses: Clause[];
  /** Predicates the condition calls directly. */
  calls: string[];
  /** The rule's own evidence bindings; EnglishPolicy.evidence lists those shared by all rules. */
  evidence: CompiledEvidence[];
  source: SourceRef;
}

export interface CompiledDenial {
  id: string;
  /** The predicate whose alternative produces this denial ID. */
  predicate: string;
  /** That alternative's clauses, without the binding that names the ID. */
  clauses: Clause[];
  calls: string[];
}

export interface CompiledQuery {
  name: string;
  find: string[];
  inputs: string[];
  clauses: Clause[];
  calls: string[];
  /** Which rule set a `%` input receives. */
  ruleSet: "rules" | "ordering" | null;
}

export interface EnglishPolicy {
  modelVersion: number;
  policyVersion: number;
  rulesHash: string;
  sources: string[];
  lexicon: { attributes: Record<string, string>; viewer: Record<string, string> };
  constants: Record<string, (string | number | boolean)[]>;
  /** Evidence bindings every decision may show (common and eligibility witnesses). */
  evidence: CompiledEvidence[];
  decisions: CompiledDecision[];
  predicates: CompiledPredicate[];
  denials: CompiledDenial[];
  ordering: {
    comparison: string[];
    overrides: { winner: string; loser: string }[];
    /** The generic same-kind override query (q0) and the declared-pair query. */
    overrideQueries: CompiledQuery[];
    sortQuery: CompiledQuery;
    keyQueries: CompiledQuery[];
  };
  /** Every other named query the engine runs, in source order. */
  queries: CompiledQuery[];
  coverage: {
    decisions: number;
    predicates: number;
    alternatives: number;
    denials: number;
    queries: number;
    keyQueries: number;
    evidence: number;
    overrides: number;
    constants: number;
    attributes: number;
    clauses: number;
  };
}
