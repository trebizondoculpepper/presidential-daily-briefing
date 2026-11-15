/** Native project grammar and English structure (#514). Grounding is a separate stage. */
import { compileEnglishClauses, callsOf } from "../english.js";
import type { Clause } from "../english-model.js";
import { parseProjectSource, ProjectSourceError } from "./source.js";
import type { BaseIdentity, ParsedProjectSource } from "./source.js";

export const projectionVocabulary = {
  lexicon: {
    viewer: { role: "role", order: "requested order" },
    attributes: {
      role: "viewer role",
      order: "requested order",
      "pdb.action-id": "admitted action identity",
      "pdb.action-kind": "registered action kind",
      "pdb.action-role": "responsible role",
      "pdb.action-target": "action target",
      "pdb.action-label": "collected label",
      "pdb.labels-complete": "label completeness",
      "pdb.base-band": "immutable default band",
      "pdb.impact-state": "impact assessment state",
      "pdb.complexity-state": "complexity assessment state",
      "pdb.impact-size": "current impact size",
      "pdb.complexity-size": "current complexity size",
      "pdb.unlocks": "proven unlock lower bound",
      "pdb.unlocks-complete": "unlock coverage",
      "pdb.head": "current PR head",
    },
  },
  schema: { "pdb.action-label": { ":db/cardinality": ":db.cardinality/many" } },
  constants: {},
};
export interface ProjectHelper {
  name: string;
  params: string[];
  clauses: Clause[];
  index: number;
}
export interface ProjectPreference {
  id: string;
  when: Clause[];
  priority: Clause[];
  why: string;
  witnesses: Record<string, Clause[]>;
  index: number;
}
/** Not an evaluation/activation artifact: output-variable grounding is not yet established. */
export interface ProjectGrammar {
  phase: "grammar-checked";
  source: ParsedProjectSource;
  helpers: ProjectHelper[];
  preferences: ProjectPreference[];
}
function fail(code: string, where: string): never {
  throw new ProjectSourceError(code, `Inspect ${where}`);
}
const symbol = (f: unknown): string | null =>
  f && typeof f === "object" && "sym" in f && typeof f.sym === "string" ? f.sym : null;
function fields(form: unknown, allowed: readonly string[], where: string): Map<string, unknown> {
  if (!form || typeof form !== "object" || !("map" in form) || !Array.isArray(form.map))
    return fail("native-map", where);
  const out = new Map<string, unknown>();
  for (const [key, value] of form.map as unknown[][]) {
    if (
      !key ||
      typeof key !== "object" ||
      !("key" in key) ||
      typeof key.key !== "string" ||
      !allowed.includes(key.key)
    )
      fail("native-key", where);
    if (out.has(key.key)) fail("duplicate-key", where);
    out.set(key.key, value);
  }
  if (allowed.some((k) => !out.has(k))) fail("missing-key", where);
  return out;
}
function clauses(form: unknown, where: string): Clause[] {
  if (!Array.isArray(form)) return fail("native-clauses", where);
  try {
    return compileEnglishClauses(form, where, projectionVocabulary);
  } catch {
    return fail("native-clause", where);
  }
}
function* walk(cs: Clause[]): Generator<Clause> {
  for (const c of cs) {
    yield c;
    if (c.type === "and" || c.type === "not") yield* walk(c.body);
    else if (c.type === "or") for (const a of c.alternatives) yield* walk(a);
  }
}
export function compileProjectGrammar(text: string, base: BaseIdentity): ProjectGrammar {
  const source = parseProjectSource(text, base),
    helpers: ProjectHelper[] = [];
  const arities = new Map<string, number>();
  for (const [index, form] of source.rules.entries()) {
    const where = `rules[${index}]`;
    if (!Array.isArray(form) || form.length < 2) fail("native-rule", where);
    const head = form[0];
    if (!head || typeof head !== "object" || !("list" in head) || !Array.isArray(head.list))
      fail("native-head", where);
    const name = symbol(head.list[0]);
    if (!name || !/^project-[a-z0-9][a-z0-9-]*$/.test(name)) fail("reserved-predicate", where);
    const params = head.list.slice(1).map((p: unknown) => {
      const s = symbol(p);
      if (!s?.startsWith("?")) return fail("native-head", where);
      return s;
    });
    if (params.length > 8) fail("native-arity", where);
    if (arities.has(name) && arities.get(name) !== params.length) fail("native-arity", where);
    arities.set(name, params.length);
    helpers.push({ name, params, clauses: clauses(form.slice(1), where), index });
  }
  const preferences: ProjectPreference[] = [],
    ids = new Set<string>();
  for (const [index, form] of source.preferences.entries()) {
    const where = `preferences[${index}]`,
      f = fields(form, ["id", "when", "priority", "why", "witnesses"], where);
    const id = f.get("id"),
      why = f.get("why");
    if (typeof id !== "string" || !/^project-[a-z0-9][a-z0-9-]{0,62}$/.test(id) || ids.has(id))
      fail("preference-id", where);
    ids.add(id);
    if (typeof why !== "string" || !why.trim() || Array.from(why).length > 512)
      fail("preference-why", where);
    const raw = f.get("witnesses");
    if (
      !raw ||
      typeof raw !== "object" ||
      !("map" in raw) ||
      !Array.isArray(raw.map) ||
      raw.map.length > 10
    )
      fail("preference-witnesses", where);
    const witnesses: Record<string, Clause[]> = Object.create(null) as Record<string, Clause[]>;
    for (const [key, value] of raw.map as unknown[][]) {
      if (typeof key !== "string" || !key || Object.hasOwn(witnesses, key))
        fail("preference-witnesses", where);
      witnesses[key] = clauses(value, `${where}.witness`);
    }
    const placeholders = [...why.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    if (
      placeholders.some((k) => !Object.hasOwn(witnesses, k)) ||
      /[{}]/.test(why.replace(/\{[^{}]*\}/g, ""))
    )
      fail("preference-placeholder", where);
    preferences.push({
      id,
      why,
      when: clauses(f.get("when"), `${where}.when`),
      priority: clauses(f.get("priority"), `${where}.priority`),
      witnesses,
      index,
    });
  }
  const all = [
    ...helpers.map((h) => h.clauses),
    ...preferences.flatMap((p) => [p.when, p.priority, ...Object.values(p.witnesses)]),
  ];
  let count = 0;
  for (const group of all)
    for (const c of walk(group)) {
      if (++count > 1000) fail("native-clause-count", "clauses");
      if (
        c.type === "call" &&
        (!arities.has(c.predicate) || arities.get(c.predicate) !== c.args.length)
      )
        fail("native-call", "clauses");
    }
  const edges = new Map<string, Set<string>>();
  for (const h of helpers) {
    const next = edges.get(h.name) ?? new Set<string>();
    for (const n of callsOf(h.clauses)) next.add(n);
    edges.set(h.name, next);
  }
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (n: string) => {
    if (active.has(n)) fail("native-cycle", "rules");
    if (done.has(n)) return;
    active.add(n);
    for (const next of edges.get(n) ?? []) visit(next);
    active.delete(n);
    done.add(n);
  };
  for (const n of edges.keys()) visit(n);
  return { phase: "grammar-checked", source, helpers, preferences };
}
