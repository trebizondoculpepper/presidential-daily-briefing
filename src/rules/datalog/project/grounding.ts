/** Range/binding validation over the shared clause model; no query execution. */
import type { Clause, Term } from "../english-model.js";
import { ProjectSourceError } from "./source.js";
import type { ProjectGrammar, ProjectHelper } from "./grammar.js";
const vars = (terms: Term[]) => terms.flatMap((t) => ("var" in t ? [t.var] : []));
function mentioned(cs: Clause[]): Set<string> {
  const out = new Set<string>();
  for (const c of cs) {
    let terms: Term[] = [];
    if (c.type === "fact") terms = [c.entity, c.value];
    else if (c.type === "dynamic-fact") terms = [c.entity, c.attribute, c.value];
    else if (c.type === "bind") {
      terms = c.args;
      out.add(c.result);
    } else if (c.type === "call" || c.type === "compare") terms = c.args;
    else if (c.type === "and" || c.type === "not") {
      for (const v of mentioned(c.body)) out.add(v);
    } else if (c.type === "or") {
      for (const a of c.alternatives) for (const v of mentioned(a)) out.add(v);
    }
    for (const v of vars(terms)) out.add(v);
  }
  return out;
}
/** Validates each actually used helper binding mode and every unused helper body. */
export function validateGrounding(g: ProjectGrammar): void {
  const alternatives = new Map<string, ProjectHelper[]>();
  for (const h of g.helpers) {
    const a = alternatives.get(h.name) ?? [];
    a.push(h);
    alternatives.set(h.name, a);
  }
  const done = new Set<string>(),
    active = new Set<string>();
  const fail = (where: string): never => {
    throw new ProjectSourceError(
      "native-grounding",
      `Unbound or incompatible variable scope at ${where}`,
    );
  };
  const requireBound = (names: Iterable<string>, bound: Set<string>, where: string) => {
    for (const v of names) if (!bound.has(v)) fail(where);
  };
  const helper = (name: string, mode: boolean[]) => {
    const key = `${name}:${mode.map((x) => (x ? "1" : "0")).join("")}`;
    if (done.has(key)) return;
    if (active.has(key)) fail("recursive helper");
    active.add(key);
    for (const h of alternatives.get(name) ?? []) {
      const bound = new Set(h.params.filter((_p, i) => mode[i]));
      const after = sequence(h.clauses, bound, `rules[${h.index}]`);
      requireBound(h.params, after, `rules[${h.index}].head`);
    }
    active.delete(key);
    done.add(key);
  };
  const sequence = (cs: Clause[], initial: Set<string>, where: string): Set<string> => {
    let bound = new Set(initial);
    for (const [i, c] of cs.entries()) {
      const at = `${where}[${i}]`;
      switch (c.type) {
        case "fact":
          for (const v of vars([c.entity, c.value])) bound.add(v);
          break;
        case "dynamic-fact":
          for (const v of vars([c.entity, c.attribute, c.value])) bound.add(v);
          break;
        case "compare":
          requireBound(vars(c.args), bound, at);
          break;
        case "bind":
          requireBound(vars(c.args), bound, at);
          bound.add(c.result);
          break;
        case "call": {
          helper(
            c.predicate,
            c.args.map((t) => "lit" in t || ("var" in t && bound.has(t.var))),
          );
          for (const v of vars(c.args)) bound.add(v);
          break;
        }
        case "and":
          bound = sequence(c.body, bound, at);
          break;
        case "not": {
          if (c.join) {
            requireBound(c.join, bound, at);
            sequence(c.body, new Set(c.join), at);
          } else {
            requireBound(mentioned(c.body), bound, at);
            sequence(c.body, bound, at);
          }
          break;
        }
        case "or": {
          if (c.join) {
            const input = new Set(c.join.filter((v) => bound.has(v)));
            for (const a of c.alternatives) requireBound(c.join, sequence(a, input, at), at);
            for (const v of c.join) bound.add(v);
          } else {
            const results = c.alternatives.map((a) => sequence(a, bound, at));
            const first = results[0] ?? bound;
            for (const other of results)
              if (first.size !== other.size || [...first].some((v) => !other.has(v))) fail(at);
            bound = new Set(first);
          }
          break;
        }
      }
    }
    return bound;
  };
  for (const p of g.preferences) {
    const when = sequence(p.when, new Set(["?a"]), `preferences[${p.index}].when`);
    requireBound(
      ["?value"],
      sequence(p.priority, when, `preferences[${p.index}].priority`),
      `preferences[${p.index}].priority`,
    );
    for (const cs of Object.values(p.witnesses))
      requireBound(
        ["?value"],
        sequence(cs, new Set(["?a"]), `preferences[${p.index}].witness`),
        `preferences[${p.index}].witness`,
      );
  }
  // Even a currently unused helper cannot contain an internally unbound function.
  for (const [name, hs] of alternatives)
    helper(
      name,
      hs[0].params.map(() => true),
    );
}
