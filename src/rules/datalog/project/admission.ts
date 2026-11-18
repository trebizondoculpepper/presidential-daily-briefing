/**
 * Exact-action admission for native project preferences (#515,
 * doc/design/native-project-rules.md, "Immutable input projection and admission").
 *
 * Input is an untrusted evaluation result (it crossed a worker boundary). It is validated as a
 * whole before anything is applied: one unknown, forged, duplicate, conflicting, out-of-range or
 * incompletely bound row rejects the entire result, so a partial override is never applied.
 * Applying a valid result only reorders actions within their own adjustable band and adds
 * project reasons; every other field of every default action is preserved and re-checked.
 */
import type { Value } from "datascript";
import type { CompiledProjectPolicy } from "./compile.js";
import { ProjectEvaluationError, actionIdentity, protectedBands } from "./projection.js";
import { RANK_PARTITION } from "../engine.js";
import type { AdmittedAction, Projection } from "./projection.js";

/** Contract v1 bounds on the evaluation output. */
export const resultLimits = {
  /** Returned preference rows plus witness values, across all preferences. */
  tuples: 5000,
  /** Serialized worker output, in UTF-16 code units of its JSON text. */
  outputChars: 256 * 1024,
  priorityMin: 0,
  priorityMax: 1000,
  /** Project reasons shown per action; the rest are counted as omitted. */
  reasonsPerAction: 5,
  /** Witness values shown per binding, like the default engine's explanations. */
  valuesPerWitness: 8,
} as const;

/** One preference's matched rows: [entity, exact action identity, priority, witness values]. */
export type ProjectRow = [number, string, number, Record<string, Value[]>];
export interface ProjectQueryResult {
  version: 1;
  generation: string;
  effectiveRulesHash: string;
  projectRulesHash: string;
  /**
   * Per preference: `matched` is every admitted entity satisfying `:when` alone; `rows` are the
   * priority-bound matches. A `:when` match with no priority row is an error, never "no match".
   */
  preferences: { id: string; matched: number[]; rows: ProjectRow[] }[];
}
export interface ProjectReason {
  id: string;
  priority: number;
  text: string;
  facts: Record<string, Value>;
  /**
   * Witness name → values left out of its binding. Kept apart from `facts`, so a witness named
   * like `labelOmitted` can never collide with omission metadata.
   */
  omitted: Record<string, number>;
}
export interface ProjectMatch {
  identity: string;
  /** Highest matched priority; 0 when nothing matched. */
  priority: number;
  /** Every matched preference ID in source order, kept as auditable provenance. */
  matchedIds: string[];
  /** Reasons at the winning priority in source order, bounded. */
  reasons: ProjectReason[];
  reasonsOmitted: number;
}
export interface AdmittedProjectResult {
  generation: string;
  /** Exact action identity → its validated project match. Absent means no preference matched. */
  matches: ReadonlyMap<string, ProjectMatch>;
}

const invalid = (code: string, detail: string): never => {
  throw new ProjectEvaluationError(code, detail);
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is Value =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
/**
 * A prototype-free dictionary from a Map: project witness names such as `__proto__` or
 * `constructor` stay ordinary own keys and can never change the object's prototype.
 */
function dictionary<V>(entries: ReadonlyMap<string, V>): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  for (const [k, v] of entries)
    Object.defineProperty(out, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validate an untrusted evaluation result against the exact projection and policy it was asked
 * to evaluate. Returns only when every row is admissible; otherwise throws, applying nothing.
 */
export function admitProjectResult(
  raw: unknown,
  policy: CompiledProjectPolicy,
  projection: Projection,
  generation: string,
): AdmittedProjectResult {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "version",
      "generation",
      "effectiveRulesHash",
      "projectRulesHash",
      "preferences",
    ]) ||
    raw.version !== 1 ||
    !Array.isArray(raw.preferences)
  )
    return invalid("invalid-result", "the evaluation result has an unexpected shape");
  if (raw.generation !== generation)
    invalid("stale-generation", "the result belongs to another policy generation");
  if (
    raw.effectiveRulesHash !== policy.effectiveRulesHash ||
    raw.projectRulesHash !== policy.projectRulesHash
  )
    invalid("policy-mismatch", "the result was computed for a different project policy");
  const prefs = raw.preferences as unknown[];
  if (prefs.length !== policy.preferences.length)
    invalid("invalid-result", "the result does not cover exactly the policy's preferences");
  const perAction = new Map<string, { id: string; priority: number; reason: ProjectReason }[]>();
  let tuples = 0;
  for (const [index, pref] of policy.preferences.entries()) {
    const got = prefs[index];
    if (
      !isRecord(got) ||
      !exactKeys(got, ["id", "matched", "rows"]) ||
      !Array.isArray(got.rows) ||
      !Array.isArray(got.matched)
    )
      return invalid("invalid-result", `preference ${pref.id} has an unexpected shape`);
    if (got.id !== pref.id) invalid("invalid-result", `preference ${index} is not ${pref.id}`);
    const matched = new Set<number>();
    for (const entity of got.matched as unknown[]) {
      if (++tuples > resultLimits.tuples)
        invalid("result-limit", `more than ${resultLimits.tuples} result tuples`);
      if (typeof entity !== "number" || !projection.identities.has(entity))
        return invalid("forged-action", `preference ${pref.id} matched an unadmitted action`);
      if (matched.has(entity))
        invalid("duplicate-result", `preference ${pref.id} matched one action twice`);
      matched.add(entity);
    }
    const names = Object.keys(pref.witnesses);
    const seen = new Map<number, number>();
    for (const row of got.rows as unknown[]) {
      if (++tuples > resultLimits.tuples)
        invalid("result-limit", `more than ${resultLimits.tuples} result tuples`);
      if (!Array.isArray(row) || row.length !== 4)
        return invalid("invalid-result", `preference ${pref.id} returned a malformed row`);
      const [entity, identity, priority, witnesses] = row as unknown[];
      // The opaque entity must name an adjustable action of this projection, and the identity
      // the evaluation read must be exactly that action's: no unadmitted or renamed action.
      if (
        typeof entity !== "number" ||
        typeof identity !== "string" ||
        projection.identities.get(entity) !== identity
      )
        return invalid("forged-action", `preference ${pref.id} returned an unadmitted action`);
      if (
        typeof priority !== "number" ||
        !Number.isSafeInteger(priority) ||
        priority < resultLimits.priorityMin ||
        priority > resultLimits.priorityMax
      )
        return invalid(
          "priority-range",
          `preference ${pref.id} priority must be an integer in ` +
            `${resultLimits.priorityMin}..${resultLimits.priorityMax}`,
        );
      const previous = seen.get(entity);
      if (previous !== undefined)
        invalid(
          previous === priority ? "duplicate-result" : "conflicting-priority",
          `preference ${pref.id} returned more than one priority for one action`,
        );
      seen.set(entity, priority);
      if (!isRecord(witnesses) || !exactKeys(witnesses, names))
        return invalid("missing-witness", `preference ${pref.id} witness bindings are incomplete`);
      // A Map, not an object literal: a witness named __proto__ must stay an ordinary binding.
      const bound = new Map<string, Value>(),
        omitted = new Map<string, number>();
      for (const name of names) {
        const values = witnesses[name];
        if (!Array.isArray(values) || values.length === 0)
          return invalid("missing-witness", `preference ${pref.id} witness ${name} is unbound`);
        tuples += values.length;
        if (tuples > resultLimits.tuples)
          invalid("result-limit", `more than ${resultLimits.tuples} result tuples`);
        if (!values.every(isScalar))
          invalid("invalid-result", `preference ${pref.id} witness ${name} is not scalar`);
        const sorted = [...new Set((values as Value[]).map(String))].sort(byCodePoint);
        if (sorted.length === 1) bound.set(name, (values as Value[])[0]);
        else {
          bound.set(name, sorted.slice(0, resultLimits.valuesPerWitness).join("; "));
          if (sorted.length > resultLimits.valuesPerWitness)
            omitted.set(name, sorted.length - resultLimits.valuesPerWitness);
        }
      }
      // Placeholders were validated against witness names by the compiler; a literal :why only
      // ever explains why this preference matched and grants no authority.
      const text = pref.why.replace(/\{([^{}]*)\}/g, (_, k: string) => String(bound.get(k)));
      const facts: Record<string, Value> = dictionary(bound);
      const list = perAction.get(identity) ?? [];
      list.push({
        id: pref.id,
        priority,
        reason: {
          id: pref.id,
          priority,
          text,
          facts,
          omitted: dictionary(omitted),
        },
      });
      perAction.set(identity, list);
    }
    for (const entity of seen.keys())
      if (!matched.has(entity))
        invalid("invalid-result", `preference ${pref.id} priced an action its :when did not match`);
    for (const entity of matched)
      if (!seen.has(entity))
        invalid(
          "missing-priority",
          `preference ${pref.id} matched ${projection.identities.get(entity)} ` +
            "but its :priority clauses bound no ?value",
        );
  }
  const matches = new Map<string, ProjectMatch>();
  for (const [identity, list] of perAction) {
    const priority = Math.max(...list.map((m) => m.priority));
    // Equal keys keep source-order reasons; the key is the highest match, never a sum.
    const winners = list.filter((m) => m.priority === priority).map((m) => m.reason);
    matches.set(identity, {
      identity,
      priority,
      matchedIds: list.map((m) => m.id),
      reasons: winners.slice(0, resultLimits.reasonsPerAction),
      reasonsOmitted: Math.max(0, winners.length - resultLimits.reasonsPerAction),
    });
  }
  return { generation, matches };
}

/** A default action with project reasons added beside, never over, its default explanation. */
export type ProjectedAction<A extends AdmittedAction> = A & {
  ruleIds?: string[];
  why?: { ruleIds: string[]; project?: ProjectReason[]; projectOmitted?: number };
};
type WithWhy = AdmittedAction & { ruleIds?: string[]; why?: { ruleIds: string[] } };

/**
 * Reorder each adjustable band by descending project priority, keeping the default order as the
 * tie-break (a stable sort over the default sequence), and add project reasons. Protected bands,
 * positions of every band and every non-explanation field stay exactly as the default policy
 * admitted them; the result is checked against the input before it is returned.
 */
export function applyProjectPreferences<A extends WithWhy>(
  actions: readonly A[],
  admitted: AdmittedProjectResult,
): ProjectedAction<A>[] {
  const out: ProjectedAction<A>[] = actions.map((a) => {
    const match = admitted.matches.get(actionIdentity(a));
    if (!match) return a;
    const ruleIds = [...(a.why?.ruleIds ?? a.ruleIds ?? []), ...match.matchedIds];
    return {
      ...a,
      ...(a.ruleIds ? { ruleIds: [...a.ruleIds, ...match.matchedIds] } : {}),
      why: {
        ...a.why,
        ruleIds,
        project: match.reasons,
        ...(match.reasonsOmitted ? { projectOmitted: match.reasonsOmitted } : {}),
      },
    };
  });
  const key = (a: AdmittedAction) => admitted.matches.get(actionIdentity(a))?.priority ?? 0;
  // Regroup only within one native rank partition and band (#652): a project preference never
  // moves new work ahead of an owned obligation, an addressed response or preferred-role duties.
  const bands = new Map<string, number[]>();
  for (const [i, a] of out.entries())
    if (!protectedBands.has(a.band)) {
      const group = `${(a as { [RANK_PARTITION]?: string })[RANK_PARTITION] ?? ""}|${a.band}`;
      bands.set(group, [...(bands.get(group) ?? []), i]);
    }
  for (const slots of bands.values()) {
    const sorted = slots.map((i) => out[i]).sort((x, y) => key(y) - key(x));
    for (const [n, i] of slots.entries()) out[i] = sorted[n];
  }
  assertAdmissionPreserved(actions, out);
  return out;
}

/**
 * The immutable admission invariant: the same exact actions, each band at the same positions,
 * protected bands untouched, and no field outside the explanation changed. A violation is a
 * defect, reported instead of returning a partially overridden queue.
 */
export function assertAdmissionPreserved(
  before: readonly WithWhy[],
  after: readonly WithWhy[],
): void {
  const fail = (detail: string): never => {
    throw new ProjectEvaluationError("admission-violated", detail);
  };
  if (before.length !== after.length) fail("the number of admitted actions changed");
  const original = new Map(before.map((a) => [actionIdentity(a), a]));
  if (original.size !== before.length) fail("duplicate admitted actions");
  const strip = ({ why: _w, ruleIds: _r, ...rest }: WithWhy) => JSON.stringify(rest);
  // The default why text, facts and overridden IDs; only ruleIds may grow and project be added.
  const whyOf = (a: WithWhy) => {
    const {
      ruleIds: _r,
      project: _p,
      projectOmitted: _o,
      ...rest
    } = (a.why ?? {}) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  const seen = new Set<string>();
  for (const [i, a] of after.entries()) {
    const id = actionIdentity(a),
      o = original.get(id);
    if (!o || seen.has(id)) return fail(`unadmitted or repeated action ${id}`);
    seen.add(id);
    if (a.band !== before[i].band) fail(`band order changed at position ${i}`);
    if (protectedBands.has(a.band) && a !== before[i]) fail(`protected action ${id} changed`);
    if (strip(a) !== strip(o)) fail(`action ${id} changed beyond its explanation`);
    if (whyOf(a) !== whyOf(o)) fail(`default explanation of ${id} was overwritten`);
    // Both rule-ID lists are checked on their own: emptying either cannot pass.
    const keeps = (defaults: readonly string[] | undefined, ids: readonly string[] | undefined) =>
      defaults === undefined || (Array.isArray(ids) && defaults.every((r, n) => ids[n] === r));
    if (!keeps(o.ruleIds, a.ruleIds) || !keeps(o.why?.ruleIds, a.why?.ruleIds))
      fail(`default reasons of ${id} were replaced`);
  }
}
