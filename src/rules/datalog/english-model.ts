/**
 * The compiled English policy model (doc/design/rules-english-command.md, #416).
 *
 * `npm run rules:build` compiles the validated policy bundle into this model and writes it to
 * english.generated.json. The model is structural: every clause of every rule, predicate, query
 * and witness is kept with its variables and grouping, and each input attribute carries the
 * lexicon phrase from policy/schema.edn. Optional rule-attached purposes are literal
 * authored metadata; the generated formal conditions remain separate. `pdb rules`
 * and the web rules page (#392) render this model; neither needs the build-time EDN reader.
 */

/** Version of this model's own shape. */
export const ENGLISH_MODEL_VERSION = 3;

/** A clause argument: a variable, a literal value, or DataScript's `_` wildcard. */
export type Term = { var: string } | { lit: string | number | boolean } | { wild: true };

/**
 * What a fact pattern on entity 1 is about. Entity 1 holds the viewer, the constant sets and
 * the few context facts the engine asserts there; every other entity is a subject or rule.
 */
export type FactScope = "viewer" | "constant" | "context" | "entity";

export type Clause =
  | { type: "dynamic-fact"; entity: Term; attribute: Term; value: Term }
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
  /** A bare `(and ...)` outside an `or`: a parenthesised conjunction. */
  | { type: "and"; body: Clause[] }
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
  /** The first definition's head variables; each alternative keeps its own in `params`. */
  params: string[];
  /**
   * Each alternative definition is a conjunction over its own head variables (which may be
   * named differently from another alternative's); the alternatives are a disjunction.
   */
  alternatives: { params: string[]; clauses: Clause[]; source: SourceRef }[];
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
  purpose?: string;
  kind: string;
  band: number;
  preference: number;
  codes: string[];
  /** Roles named by a top-level `[1 "role" "..."]` fact, or null when the rule names none. */
  roles: string[] | null;
  /**
   * Every where-clause the engine runs for this rule, in order: the shared match template
   * (queries.edn :match, e.g. foreground(?t)) followed by the rule's own :when clauses.
   */
  clauses: Clause[];
  /** How many leading `clauses` come from the shared match template rather than :when. */
  templateClauses: number;
  /** Predicates the condition calls directly. */
  calls: string[];
  /** The rule's own evidence bindings; EnglishPolicy.evidence lists those shared by all rules. */
  evidence: CompiledEvidence[];
  source: SourceRef;
}

export interface CompiledDenial {
  id: string;
  purpose?: string;
  /** The predicate whose alternative produces this denial ID. */
  predicate: string;
  /** That alternative's clauses, without the binding that names the ID. */
  clauses: Clause[];
  calls: string[];
}

/**
 * A native action obligation (#1113): authored in policy/obligations.edn with an id, the action
 * outcomes it applies to, an optional role restriction and a purpose. The clauses are the
 * applicable `obligation-applies` alternatives as native witnesses (rule-attached generated
 * English for the shared document model).
 */
export interface CompiledObligation {
  id: string;
  purpose: string;
  /** The claim outcomes this obligation applies to (e.g. claimed, noop, denied, partial). */
  outcomes: string[];
  /** Role restriction from obligations.edn, or null when the obligation applies to every role. */
  roles: string[] | null;
  /** Applicability clauses (native witnesses) from the obligation-applies predicate. */
  clauses: Clause[];
  calls: string[];
  source: SourceRef;
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
  /** Optional for older artifacts that contain no authored purposes. */
  narrationHash?: string | null;
  sources: string[];
  lexicon: { attributes: Record<string, string>; viewer: Record<string, string> };
  constants: Record<string, (string | number | boolean)[]>;
  /** Evidence bindings every decision may show (common and eligibility witnesses). */
  evidence: CompiledEvidence[];
  decisions: CompiledDecision[];
  predicates: CompiledPredicate[];
  denials: CompiledDenial[];
  /** Native action obligations in source order (#1113). */
  obligations: CompiledObligation[];
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
    obligations: number;
    queries: number;
    keyQueries: number;
    evidence: number;
    overrides: number;
    constants: number;
    attributes: number;
    clauses: number;
  };
}
