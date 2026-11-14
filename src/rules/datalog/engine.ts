/**
 * The rules engine (doc/design/rules-component.md, "Component boundary"): normalized facts in,
 * ordered decisions and explanations out. Pure and synchronous: no GitHub objects, no clock,
 * no filesystem or network, no command text. The host adapter (adapter.ts) builds the facts and
 * renders the result; an import-boundary test keeps host modules out of this file.
 */
import ds from "datascript";
import type { Datom, Value, Db } from "datascript";
import bundleJson from "./policy.generated.json" with { type: "json" };
import type { PolicyBundle } from "./bundle.js";
import { rulesHashOf } from "./hash.js";

/** The validated policy artifact written by `npm run rules:build` from policy/*.edn. */
// Validated by the build and by `rules:build --check` in npm run check; JSON types are too wide.
const bundle = bundleJson as unknown as PolicyBundle;
const {
  definitions,
  clauses,
  schema,
  constants,
  keyQueries,
  queries,
  commonWitnesses,
  eligibilityWitnesses,
  sortClauses,
  policyVersion,
} = bundle;

export const rulesHash = rulesHashOf(bundle);
export { policyVersion };

/** Most datoms one evaluation accepts, including the policy's own constants and rule entities. */
export const maxDatoms = 50000;
/** Most subjects (issues and pull requests) one evaluation accepts. */
export const maxSubjects = 500;
/** Entity ids below this are reserved: 1 is the viewer, 2–99 hold policy rule entities. */
export const firstSubjectId = 100;

export class DatalogError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}. Roll back: pdb config set briefing.engine typescript`);
  }
}

export interface PolicyViewer {
  role: string;
  agent: string;
  platform: string;
  order: string;
}
/**
 * Raw facts about the collected repository. `datoms` may assert global completeness facts on
 * entity 1 and subject facts on entities from `firstSubjectId`; never policy entities 2–99.
 */
export interface PolicyFacts {
  viewer: PolicyViewer;
  datoms: Datom[];
}
export interface PolicyExplanation {
  text: string;
  ruleIds: string[];
  facts: Record<string, Value>;
  overriddenRuleIds: string[];
}
export interface PolicyDecision {
  subject: number;
  ruleId: string;
  kind: string;
  band: number;
  codes: string[];
  why: PolicyExplanation;
  unlocks: number;
  unlocksUnknown: string[];
  /** For implementation decisions: other open issues the viewer already owns. */
  otherClaims: number[];
}
export interface PolicyResult {
  policyVersion: number;
  rulesHash: string;
  /** Already in policy order. */
  decisions: PolicyDecision[];
  denials: { subject: number; ruleId: string }[];
  datoms: number;
}

/** Fixed comparator executes policy-emitted scalar keys; no policy decisions here. */
export function compareKeys(a: readonly Value[], b: readonly Value[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i],
      y = b[i];
    if (typeof x !== typeof y) throw new DatalogError("invalid-sort-key", "inconsistent key types");
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
// Bundle queries are canonical EDN printed by the build, so ":in $ %" has exactly this spelling.
const query = (db: Db, q: string) => (q.includes(":in $ %") ? ds.q(q, db, clauses) : ds.q(q, db));

export function evaluatePolicy(
  input: PolicyFacts,
  options: { signal?: AbortSignal } = {},
): PolicyResult {
  options.signal?.throwIfAborted();
  if (!["implementer", "designer"].includes(input.viewer.role))
    throw new DatalogError("unsupported-role", "use --role implementer or --role designer");
  for (const [entity] of input.datoms)
    if (entity !== 1 && entity < firstSubjectId)
      throw new DatalogError("invalid-facts", `entity ${entity} is reserved for the policy`);
  // Subjects are the entities with a "kind" fact; the same limit the adapter applies first.
  const subjects = new Set(input.datoms.filter(([, a]) => a === "kind").map(([e]) => e));
  if (subjects.size > maxSubjects)
    throw new DatalogError(
      "experimental-scope-exceeded",
      `at most ${maxSubjects} subjects are supported`,
    );
  const facts: Datom[] = [
    [1, "role", input.viewer.role],
    [1, "agent", input.viewer.agent],
    [1, "platform", input.viewer.platform],
    [1, "order", input.viewer.order],
  ];
  for (const [key, values] of Object.entries(constants))
    for (const v of values) facts.push([1, key, v]);
  facts.push(...input.datoms);
  for (const [i, r] of definitions.entries())
    for (const [k, v] of Object.entries({
      rule: r.id,
      kind: r.kind,
      band: r.band,
      preference: r.preference,
      why: r.why,
    }))
      facts.push([10 + i, k, v]);
  if (facts.length > maxDatoms)
    throw new DatalogError(
      "experimental-scope-exceeded",
      `at most ${maxDatoms} datoms are supported`,
    );
  const fullSchema = {
    ...schema,
    ...Object.fromEntries(
      Object.keys(constants).map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
    ),
  };
  const database = () => {
    options.signal?.throwIfAborted();
    if (facts.length > maxDatoms)
      throw new DatalogError(
        "experimental-scope-exceeded",
        `at most ${maxDatoms} datoms are supported`,
      );
    return ds.init_db(facts, fullSchema);
  };
  let db = database();
  const denials = query(db, queries.denials).map(([id, rule]) => ({
    subject: Number(id),
    ruleId: String(rule),
  }));
  // Each root query derives a relation; the host only transacts the returned tuples.
  for (const [i, r] of definitions.entries()) {
    const rows = query(db, r.query);
    for (const [t] of rows) facts.push([Number(t), "matched", 10 + i]);
    options.signal?.throwIfAborted();
  }
  db = database();
  // Explicit deny-over-permit: unfavorable beats ordinary; easy wins beat ordinary.
  // Preference resolves overlapping boosted/default assessment rules. All matches remain auditable.
  const overrides = ds.q(queries.q0, db);
  for (const [t, r] of overrides) facts.push([Number(t), "overridden", r]);
  db = database();
  // Native direct unlocks only: the dependent has exactly one open blocker and is otherwise ready.
  const unlockRows = query(db, queries.q1);
  for (const [t, d] of unlockRows) facts.push([Number(t), "unlocks-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "unlocks-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  const counts = ds.q(queries.q2, db);
  for (const [t, reason] of query(db, queries["unknown-unlocks"]))
    facts.push([Number(t), "unlock-unknown", reason]);
  for (const [t, n] of counts) facts.push([Number(t), "unlock-count", n]);
  for (const [t] of ds.q(queries.q3, database())) facts.push([Number(t), "unlock-count", 0]);
  db = database();
  for (const [t, d] of query(db, queries["active-dependents"]))
    facts.push([Number(t), "active-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "active-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  for (const [t, n] of ds.q(queries["active-count"], db))
    facts.push([Number(t), "active-count", n]);
  db = database();
  for (const [t] of ds.q(queries["missing-active-count"], db))
    facts.push([Number(t), "active-count", 0]);
  // Boolean/order keys are inferred from the raw relations, not precomputed by an adapter.
  db = database();

  for (const [field, q] of keyQueries)
    for (const [t, k] of query(db, q)) facts.push([Number(t), field, k]);
  db = database();

  facts.push(
    [1, "assessment-kind", "estimate-complexity"],
    [1, "assessment-kind", "assess-impact"],
    [1, "assessment-kind", "inspect-assessment"],
  );
  db = ds.init_db(facts, {
    ...fullSchema,
    "assessment-kind": { ":db/cardinality": ":db.cardinality/many" },
  });
  const rows = ds.q(queries.q4, db, sortClauses);
  options.signal?.throwIfAborted();
  const decisions = rows
    .sort((a, b) => compareKeys(a.slice(2), b.slice(2)))
    .map((row): PolicyDecision => {
      const [t, r, b] = row;
      const definition = definitions[Number(r) - 10];
      if (!definition) throw new DatalogError("invalid-inference", "unknown subject or rule");
      const bindings: Record<string, Value> = {};
      const selectedWitnesses = {
        ...commonWitnesses,
        ...eligibilityWitnesses,
        ...definition.witnesses,
      };
      for (const [key, witnessQuery] of Object.entries(selectedWitnesses)) {
        const values = ds.q(witnessQuery, db, clauses, t).flat();
        if (values.length === 1) bindings[key] = values[0];
        else if (values.length > 1) {
          const sorted = values.map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          bindings[key] = sorted.slice(0, 8).join("; ");
          if (values.length > 8) bindings[`${key}Omitted`] = values.length - 8;
        }
      }
      const text = definition.why.replace(/\{(\w+)\}/g, (_, key: string) => {
        if (!(key in bindings)) throw new DatalogError("missing-explanation-binding", key);
        return String(bindings[key]);
      });
      const ruleIds = [definition.id];
      return {
        subject: Number(t),
        ruleId: definition.id,
        kind: definition.kind,
        band: Number(b),
        codes: definition.codes,
        why: {
          text,
          ruleIds,
          facts: bindings,
          overriddenRuleIds: ds.q(queries.q5, db, t).flat().map(String),
        },
        unlocks: Number(ds.q(queries.q6, db, t)[0]?.[0] ?? 0),
        unlocksUnknown: ds.q(queries.q7, db, t).flat().map(String),
        otherClaims:
          definition.kind === "implement"
            ? query(db, queries["other-claims"])
                .filter(([id]) => Number(id) === Number(t))
                .map(([, id]) => Number(id))
            : [],
      };
    });
  options.signal?.throwIfAborted();
  return { policyVersion, rulesHash, decisions, denials, datoms: facts.length };
}
