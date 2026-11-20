/**
 * Build-time compiler from the validated policy bundle to the English policy model
 * (doc/design/rules-english-command.md, #416). Pure: bundle in, model out.
 *
 * It walks the actual clauses: rule calls, attribute facts, entity-1 viewer, constant and
 * context facts, comparisons, arithmetic and string bindings, `not`/`not-join`, `or`/`or-join`
 * and `and` groups, and `count-distinct` in a query's :find. Anything else is an
 * EnglishCompileError naming its location, never dropped text. Attribute words come only from
 * the lexicon in policy/schema.edn; every literal attribute must have a phrase there, and every
 * lexicon entry must be used, so the lexicon cannot drift from the rules.
 *
 * This module uses the build-time EDN reader. The runtime renders the written model instead.
 */
import { readOne } from "./edn.js";
import type { PolicyBundle } from "./bundle.js";
import { rulesHashOf, narrationHashOf } from "./hash.js";
import { ENGLISH_MODEL_VERSION } from "./english-model.js";
import type {
  Clause,
  CompiledDecision,
  CompiledDenial,
  CompiledEvidence,
  CompiledObligation,
  CompiledPredicate,
  CompiledQuery,
  EnglishPolicy,
  FactScope,
  Term,
} from "./english-model.js";

export class EnglishCompileError extends Error {
  constructor(readonly problems: string[]) {
    super(`English compilation failed with ${problems.length} problem(s):\n${problems.join("\n")}`);
  }
}

type Form = unknown;
const sym = (f: Form): string | null =>
  typeof f === "object" && f !== null && "sym" in f && typeof f.sym === "string" ? f.sym : null;
const lst = (f: Form): Form[] | null =>
  typeof f === "object" && f !== null && "list" in f && Array.isArray(f.list) ? f.list : null;
const kw = (f: Form): string | null =>
  typeof f === "object" && f !== null && "key" in f && typeof f.key === "string" ? f.key : null;

/** Comparison predicates DataScript evaluates in a function clause without a result binding. */
const comparisons = new Set(["=", "not=", "<", ">", "<=", ">="]);
/** Functions whose result a clause binds. */
const bindings = new Set(["+", "-", "*", "/", "str"]);

/** The viewer facts the engine asserts on entity 1 (engine.ts). Each needs a lexicon phrase. */
export const viewerFacts = ["agent", "role", "platform", "order"] as const;

interface Context {
  bundle: Pick<PolicyBundle, "lexicon" | "schema" | "constants" | "denials" | "denialPurposes">;
  problems: string[];
  /** Literal attributes seen, for the lexicon completeness check. */
  attributes: Set<string>;
  viewer: Set<string>;
}

function term(f: Form, where: string, ctx: Context): Term {
  if (typeof f === "string" || typeof f === "boolean") return { lit: f };
  if (typeof f === "number" && Number.isSafeInteger(f)) return { lit: f };
  const name = sym(f);
  if (name === "_") return { wild: true };
  if (name?.startsWith("?")) return { var: name };
  ctx.problems.push(`${where}: unsupported argument ${JSON.stringify(f)}`);
  return { lit: String(name ?? JSON.stringify(f)) };
}

function joinVars(f: Form, where: string, ctx: Context): string[] {
  if (!Array.isArray(f)) {
    ctx.problems.push(`${where}: join variables must be a vector`);
    return [];
  }
  return f.map((v) => {
    const name = sym(v);
    if (!name?.startsWith("?")) ctx.problems.push(`${where}: unsupported join variable`);
    return name ?? "?";
  });
}

function fact(items: Form[], where: string, ctx: Context): Clause {
  if (items.length !== 3) {
    ctx.problems.push(`${where}: a fact pattern needs entity, attribute and value`);
    return { type: "compare", op: "?", args: [] };
  }
  const entity = term(items[0], where, ctx);
  const value = term(items[2], where, ctx);
  if (typeof items[1] !== "string") {
    const attribute = term(items[1], where, ctx);
    if ("lit" in attribute)
      ctx.problems.push(`${where}: a dynamic attribute must be a variable or wildcard`);
    return { type: "dynamic-fact", entity, attribute, value };
  }
  const attribute = items[1];
  const { bundle } = ctx;
  let scope: FactScope = "entity";
  let phrase: string | null = null;
  if ("lit" in entity && entity.lit === 1) {
    if (attribute in bundle.constants) scope = "constant";
    else if (attribute in bundle.lexicon.viewer) {
      scope = "viewer";
      ctx.viewer.add(attribute);
      phrase = bundle.lexicon.viewer[attribute];
    } else scope = "context";
  } else if ("lit" in entity)
    ctx.problems.push(`${where}: entity ${entity.lit} is not the viewer entity 1`);
  if (scope === "context" || scope === "entity") {
    ctx.attributes.add(attribute);
    phrase = bundle.lexicon.attributes[attribute] ?? null;
    if (phrase === null)
      ctx.problems.push(`${where}: attribute "${attribute}" has no phrase in schema.edn :lexicon`);
  }
  const many = attribute in bundle.schema || attribute in bundle.constants;
  return { type: "fact", scope, entity, attribute, value, phrase, many };
}

function clause(f: Form, where: string, ctx: Context): Clause {
  const items = lst(f);
  if (items) {
    const head = sym(items[0]);
    const body = (forms: Form[]) => forms.map((c, i) => clause(c, `${where} ${head}[${i}]`, ctx));
    const group = (alt: Form, i: number): Clause[] => {
      const inner = lst(alt);
      if (inner && sym(inner[0]) === "and")
        return inner.slice(1).map((c, j) => clause(c, `${where} ${head}[${i}].and[${j}]`, ctx));
      return [clause(alt, `${where} ${head}[${i}]`, ctx)];
    };
    switch (head) {
      case "not":
        if (items.length < 2) ctx.problems.push(`${where}: empty not`);
        return { type: "not", join: null, body: body(items.slice(1)) };
      case "not-join":
        if (items.length < 3) ctx.problems.push(`${where}: empty not-join`);
        return {
          type: "not",
          join: joinVars(items[1], where, ctx),
          body: body(items.slice(2)),
        };
      case "or":
        if (items.length < 2) ctx.problems.push(`${where}: empty or`);
        return { type: "or", join: null, alternatives: items.slice(1).map(group) };
      case "or-join":
        if (items.length < 3) ctx.problems.push(`${where}: empty or-join`);
        return {
          type: "or",
          join: joinVars(items[1], where, ctx),
          alternatives: items.slice(2).map(group),
        };
      case "and":
        if (items.length < 2) ctx.problems.push(`${where}: empty and`);
        return {
          type: "and",
          body: items.slice(1).map((c, i) => clause(c, `${where} and[${i}]`, ctx)),
        };
      case null:
        ctx.problems.push(`${where}: unsupported list clause`);
        return { type: "compare", op: "?", args: [] };
      default:
        return {
          type: "call",
          predicate: head,
          args: items.slice(1).map((a) => term(a, where, ctx)),
        };
    }
  }
  if (Array.isArray(f)) {
    const call = lst(f[0]);
    if (!call) return fact(f, where, ctx);
    const fn = sym(call[0]);
    const args = call.slice(1).map((a) => term(a, where, ctx));
    // Every operand is rendered; arities the renderer cannot state exactly are rejected here:
    // a one-operand comparison is trivially true, and unary - and / mean negation and reciprocal.
    if (fn && comparisons.has(fn) && f.length === 1) {
      if (args.length < 2) ctx.problems.push(`${where}: ${fn} needs at least two operands`);
      return { type: "compare", op: fn, args };
    }
    if (fn && bindings.has(fn) && f.length === 2) {
      if (fn === "str" ? args.length < 1 : args.length < 2)
        ctx.problems.push(`${where}: ${fn} with ${args.length} operand(s) is not supported`);
      const result = sym(f[1]);
      if (result?.startsWith("?")) return { type: "bind", fn, args, result };
    }
    ctx.problems.push(`${where}: unsupported function clause (${fn ?? "?"})`);
    return { type: "compare", op: "?", args: [] };
  }
  ctx.problems.push(`${where}: unsupported clause ${JSON.stringify(f)}`);
  return { type: "compare", op: "?", args: [] };
}

/** Shared structural front end for separately scoped native project clauses (#514). */
export function compileEnglishClauses(
  forms: readonly unknown[],
  source: string,
  vocabulary: Pick<PolicyBundle, "lexicon" | "schema" | "constants">,
): Clause[] {
  const ctx: Context = {
    bundle: { ...vocabulary, denials: {} },
    problems: [],
    attributes: new Set(),
    viewer: new Set(),
  };
  const compiled = forms.map((form, i) => clause(form, `${source}[${i}]`, ctx));
  if (ctx.problems.length) throw new EnglishCompileError(ctx.problems);
  return compiled;
}

/** Predicates called anywhere in the clauses, in first-call order. */
export function callsOf(clauses: Clause[]): string[] {
  const out: string[] = [];
  const walk = (cs: Clause[]) => {
    for (const c of cs)
      if (c.type === "call") {
        if (!out.includes(c.predicate)) out.push(c.predicate);
      } else if (c.type === "not" || c.type === "and") walk(c.body);
      else if (c.type === "or") for (const alt of c.alternatives) walk(alt);
  };
  walk(clauses);
  return out;
}

function compileRuleSet(
  text: string,
  file: string,
  set: "rules" | "ordering",
  ctx: Context,
): CompiledPredicate[] {
  const forms = readOne(text, file);
  const byName = new Map<string, CompiledPredicate>();
  if (!Array.isArray(forms)) {
    ctx.problems.push(`${file}: expected a vector of rules`);
    return [];
  }
  forms.forEach((rule, index) => {
    const where = `${file}[${index}]`;
    const head = Array.isArray(rule) ? lst(rule[0]) : null;
    const name = head ? sym(head[0]) : null;
    if (!Array.isArray(rule) || !head || !name) {
      ctx.problems.push(`${where}: expected [(name ?args) clauses...]`);
      return;
    }
    const params = head.slice(1).map((p) => {
      const v = sym(p);
      if (!v?.startsWith("?"))
        ctx.problems.push(`${where}: ${name} head arguments must be variables`);
      return v ?? "?";
    });
    const clauses = rule.slice(1).map((c, i) => clause(c, `${where} ${name}[${i}]`, ctx));
    let predicate = byName.get(name);
    if (!predicate) {
      predicate = { name, params, alternatives: [], calls: [], set };
      byName.set(name, predicate);
    } else if (predicate.params.length !== params.length)
      ctx.problems.push(`${where}: ${name} is defined with a different arity`);
    predicate.alternatives.push({ params, clauses, source: { file, index } });
  });
  const predicates = [...byName.values()];
  for (const p of predicates) p.calls = callsOf(p.alternatives.flatMap((a) => a.clauses));
  return predicates;
}

/** Splits a query vector into its :find, :in and :where parts. */
function compileQuery(
  name: string,
  text: string,
  where: string,
  ruleSet: "rules" | "ordering" | null,
  ctx: Context,
): CompiledQuery {
  const form = readOne(text, where);
  const parts = new Map<string, Form[]>();
  let current: string | null = null;
  if (!Array.isArray(form)) ctx.problems.push(`${where}: only vector queries are supported`);
  else
    for (const item of form) {
      const key = kw(item);
      if (key) {
        if (!["find", "in", "where"].includes(key))
          ctx.problems.push(`${where}: unsupported query key :${key}`);
        current = key;
        parts.set(key, []);
      } else if (current) parts.get(current)?.push(item);
      else ctx.problems.push(`${where}: query must start with :find`);
    }
  const find = (parts.get("find") ?? []).map((f) => {
    const items = lst(f);
    if (items) {
      const fn = sym(items[0]);
      const arg = sym(items[1]);
      if (fn !== "count-distinct" || !arg || items.length !== 2)
        ctx.problems.push(`${where}: unsupported :find aggregate`);
      return `count of distinct ${arg ?? "?"}`;
    }
    const v = sym(f);
    if (!v?.startsWith("?")) ctx.problems.push(`${where}: unsupported :find element`);
    return v ?? "?";
  });
  if (!find.length) ctx.problems.push(`${where}: query has no :find`);
  const inputs = (parts.get("in") ?? []).map((f) => {
    const s = sym(f);
    if (s) return s;
    if (Array.isArray(f) && Array.isArray(f[0]))
      return `[[${f[0].map((v: Form) => sym(v) ?? "?").join(" ")}]]`;
    ctx.problems.push(`${where}: unsupported :in binding`);
    return "?";
  });
  const clauses = (parts.get("where") ?? []).map((c, i) => clause(c, `${where} where[${i}]`, ctx));
  return {
    name,
    find,
    inputs,
    clauses,
    calls: callsOf(clauses),
    ruleSet: inputs.includes("%") ? ruleSet : null,
  };
}

/** The decision's :when clauses: the match query's :where after the template's own clauses. */
/** The where-clauses of a complete query string, compiled in order. */
function whereClauses(text: string, where: string, ctx: Context): Clause[] {
  const form = readOne(text, where);
  if (!Array.isArray(form)) return [];
  const at = form.findIndex((f) => kw(f) === "where");
  return at < 0 ? [] : form.slice(at + 1).map((c, i) => clause(c, `${where}[${i}]`, ctx));
}

/**
 * A decision's condition is exactly what the engine runs: its complete match query, so the
 * shared :match template (e.g. foreground(?t)) is part of every rule's English.
 */
function decisionClauses(
  d: { query: string; clauses: string },
  where: string,
  ctx: Context,
): { clauses: Clause[]; templateClauses: number } {
  const clauses = whereClauses(d.query, where, ctx);
  const own = readOne(`[${d.clauses}]`, where);
  const templateClauses = clauses.length - (Array.isArray(own) ? own.length : 0);
  if (templateClauses < 0) ctx.problems.push(`${where}: match query lacks the :when clauses`);
  return { clauses, templateClauses: Math.max(templateClauses, 0) };
}

/** Prints compiled clauses back as canonical EDN, to prove the model is the engine's query. */
export function clauseEdn(c: Clause): string {
  const t = (x: Term) =>
    "var" in x
      ? x.var
      : "wild" in x
        ? "_"
        : typeof x.lit === "string"
          ? JSON.stringify(x.lit)
          : String(x.lit);
  const join = (j: string[] | null) => (j ? ` [${j.join(" ")}]` : "");
  const alt = (a: Clause[]) =>
    a.length === 1 ? clauseEdn(a[0]) : `(and ${a.map(clauseEdn).join(" ")})`;
  switch (c.type) {
    case "fact":
      return `[${t(c.entity)} ${JSON.stringify(c.attribute)} ${t(c.value)}]`;
    case "dynamic-fact":
      return `[${t(c.entity)} ${t(c.attribute)} ${t(c.value)}]`;
    case "call":
      return `(${[c.predicate, ...c.args.map(t)].join(" ")})`;
    case "compare":
      return `[(${[c.op, ...c.args.map(t)].join(" ")})]`;
    case "bind":
      return `[(${[c.fn, ...c.args.map(t)].join(" ")}) ${c.result}]`;
    case "not":
      return `(${c.join ? "not-join" : "not"}${join(c.join)} ${c.body.map(clauseEdn).join(" ")})`;
    case "or":
      return `(${c.join ? "or-join" : "or"}${join(c.join)} ${c.alternatives.map(alt).join(" ")})`;
    case "and":
      return `(and ${c.body.map(clauseEdn).join(" ")})`;
  }
}

/** Witness clauses: everything after :where in the witness query. */
function witnessClauses(text: string, where: string, ctx: Context): Clause[] {
  const form = readOne(text, where);
  if (!Array.isArray(form)) return [];
  const at = form.findIndex((f) => kw(f) === "where");
  return form.slice(at + 1).map((c, i) => clause(c, `${where}[${i}]`, ctx));
}

/** Roles a condition requires through a top-level `[1 "role" "x"]` fact. */
function requiredRoles(clauses: Clause[]): string[] | null {
  const roles = clauses.flatMap((c) =>
    c.type === "fact" && c.scope === "viewer" && c.attribute === "role" && "lit" in c.value
      ? [String(c.value.lit)]
      : [],
  );
  return roles.length ? roles : null;
}

/** Denials: each predicate alternative that binds a documented denial ID with `str`. */
function compileDenials(predicates: CompiledPredicate[], ctx: Context): CompiledDenial[] {
  const out: CompiledDenial[] = [];
  const byId = new Map<string, { p: CompiledPredicate; alternatives: Clause[][] }>();
  for (const p of predicates)
    for (const alt of p.alternatives) {
      const named = alt.clauses.filter(
        (c) =>
          c.type === "bind" &&
          c.fn === "str" &&
          c.args.length === 1 &&
          "lit" in c.args[0] &&
          String(c.args[0].lit) in ctx.bundle.denials,
      );
      for (const c of named) {
        if (c.type !== "bind" || !("lit" in c.args[0])) continue;
        const denialId = String(c.args[0].lit);
        const clauses = alt.clauses.filter((x) => x !== c);
        const existing = byId.get(denialId);
        // Several alternatives may bind the same denial ID (e.g. an inventory status reached by
        // both ordinary and adoptable paths). One document-model entry, with the alternatives
        // combined as a disjunction, so no condition is dropped (reviewed #1126 finding).
        if (existing) existing.alternatives.push(clauses);
        else byId.set(denialId, { p, alternatives: [clauses] });
      }
    }
  for (const id of Object.keys(ctx.bundle.denials)) {
    const entry = byId.get(id);
    if (!entry) {
      ctx.problems.push(`denial ${id}: no predicate alternative binds it with str`);
      continue;
    }
    const combined =
      entry.alternatives.length === 1
        ? entry.alternatives[0]
        : ([{ type: "or" as const, join: null, alternatives: entry.alternatives }] as Clause[]);
    out.push({
      id,
      ...(ctx.bundle.denialPurposes?.[id] !== undefined
        ? { purpose: ctx.bundle.denialPurposes[id] }
        : {}),
      predicate: entry.p.name,
      clauses: combined,
      calls: callsOf(combined),
    });
  }
  return out;
}

/**
 * Compile native action obligations to the shared English model (#1113). Each obligation from
 * policy/obligations.edn keeps its id, purpose, outcome applicability and role restriction; the
 * clauses are the native `obligation-applies` alternatives as rule-attached witnesses: the
 * no-role alternative for obligations that apply to every role, the role-restricted alternative
 * for those with a declared role, so changing an applicability rule changes the generated model.
 */
function compileObligations(
  bundle: PolicyBundle,
  predicates: CompiledPredicate[],
  ctx: Context,
): CompiledObligation[] {
  const applies = predicates.find((p) => p.name === "obligation-applies");
  if (!applies) {
    ctx.problems.push("policy/rules.edn: no obligation-applies predicate for obligations");
    return [];
  }
  const alternatives = applies.alternatives.map((a) => a.clauses);
  return bundle.obligations.map((o, index) => {
    const clauses =
      o.role && o.role.length > 0
        ? (alternatives.find((cl) =>
            cl.some((c) => c.type === "fact" && c.attribute === "obligation-role"),
          ) ?? [])
        : (alternatives.find(
            (cl) => !cl.some((c) => c.type === "fact" && c.attribute === "obligation-role"),
          ) ?? []);
    return {
      id: o.id,
      purpose: o.purpose,
      outcomes: o.outcome,
      roles: o.role ?? null,
      clauses,
      calls: callsOf(clauses),
      source: { file: "policy/obligations.edn", index },
    };
  });
}

const countClauses = (cs: Clause[]): number =>
  cs.reduce(
    (n, c) =>
      n +
      1 +
      (c.type === "not" || c.type === "and"
        ? countClauses(c.body)
        : c.type === "or"
          ? c.alternatives.reduce((m, a) => m + countClauses(a), 0)
          : 0),
    0,
  );

/** Lexicon problems: unused, empty or misplaced entries. Missing ones are reported per use. */
function lexiconProblems(ctx: Context): string[] {
  const problems: string[] = [];
  const { attributes, viewer } = ctx.bundle.lexicon;
  for (const [k, v] of [...Object.entries(attributes), ...Object.entries(viewer)])
    if (!v.trim()) problems.push(`schema.edn :lexicon: "${k}" has an empty phrase`);
  for (const k of Object.keys(attributes)) {
    if (!ctx.attributes.has(k))
      problems.push(`schema.edn :lexicon :attributes: "${k}" is not used by any rule`);
  }
  for (const k of viewerFacts)
    if (!(k in viewer)) problems.push(`schema.edn :lexicon :viewer: missing viewer fact "${k}"`);
  for (const k of Object.keys(viewer))
    if (!(viewerFacts as readonly string[]).includes(k))
      problems.push(`schema.edn :lexicon :viewer: "${k}" is not a viewer fact the engine asserts`);
  return problems;
}

/**
 * Compiles a validated bundle. Throws EnglishCompileError listing every unsupported construct
 * and lexicon problem, so nothing reaches the model half-compiled.
 */
export function compileEnglish(bundle: PolicyBundle): EnglishPolicy {
  const ctx: Context = {
    bundle,
    problems: [],
    attributes: new Set(),
    viewer: new Set(),
  };
  const predicates = [
    ...compileRuleSet(bundle.clauses, "policy/rules.edn", "rules", ctx),
    ...compileRuleSet(bundle.sortClauses, "policy/ordering.edn :rules", "ordering", ctx),
  ];
  const decisions: CompiledDecision[] = bundle.definitions.map((d, index) => {
    const where = `policy/decisions.edn ${d.id} :when`;
    const { clauses, templateClauses } = decisionClauses(d, where, ctx);
    const evidence: CompiledEvidence[] = Object.entries(d.witnesses).map(([name, q]) => ({
      name,
      scope: "rule",
      clauses: witnessClauses(q, `policy/decisions.edn ${d.id} :witnesses "${name}"`, ctx),
    }));
    return {
      id: d.id,
      ...(d.purpose !== undefined ? { purpose: d.purpose } : {}),
      kind: d.kind,
      band: d.band,
      preference: d.preference,
      codes: d.codes,
      roles: requiredRoles(clauses),
      clauses,
      templateClauses,
      calls: callsOf(clauses),
      evidence,
      source: { file: "policy/decisions.edn", index },
    };
  });
  const shared: CompiledEvidence[] = [
    ...Object.entries(bundle.commonWitnesses).map(([name, q]) => ({
      name,
      scope: "common" as const,
      clauses: witnessClauses(q, `policy/schema.edn :common-witnesses "${name}"`, ctx),
    })),
    ...Object.entries(bundle.eligibilityWitnesses).map(([name, q]) => ({
      name,
      scope: "eligibility" as const,
      clauses: witnessClauses(q, `policy/schema.edn :eligibility-witnesses "${name}"`, ctx),
    })),
  ];
  const queries = Object.entries(bundle.queries).map(([name, q]) =>
    compileQuery(name, q, `policy/queries.edn :${name}`, name === "q4" ? "ordering" : "rules", ctx),
  );
  const keyQueries = bundle.keyQueries.map(([name, q]) =>
    compileQuery(name, q, `policy/queries.edn :key-queries ${name}`, "rules", ctx),
  );
  const denials = compileDenials(predicates, ctx);
  const obligations = compileObligations(bundle, predicates, ctx);
  const isOrdering = (name: string) => ["q0", "declared-overrides", "q4"].includes(name);
  const sortQuery = queries.find((q) => q.name === "q4");
  if (!sortQuery) ctx.problems.push("policy/queries.edn: no :q4 sort query");

  // Every call resolves to a compiled predicate in the set the construct receives.
  const known = (set: "rules" | "ordering") =>
    new Set(predicates.filter((p) => p.set === set).map((p) => p.name));
  const checkCalls = (calls: string[], set: "rules" | "ordering" | null, where: string) => {
    for (const c of calls)
      if (!set || !known(set).has(c)) ctx.problems.push(`${where}: call to unknown predicate ${c}`);
  };
  for (const d of decisions) checkCalls(d.calls, "rules", `decision ${d.id}`);
  for (const q of [...queries, ...keyQueries]) checkCalls(q.calls, q.ruleSet, `query ${q.name}`);

  const problems = [...ctx.problems, ...lexiconProblems(ctx)];
  if (problems.length) throw new EnglishCompileError(problems);
  const evidenceCount = shared.length + decisions.reduce((n, d) => n + d.evidence.length, 0);
  const allClauses = [
    ...predicates.flatMap((p) => p.alternatives.flatMap((a) => a.clauses)),
    ...decisions.flatMap((d) => d.clauses),
    ...queries.flatMap((q) => q.clauses),
    ...keyQueries.flatMap((q) => q.clauses),
  ];
  return {
    modelVersion: ENGLISH_MODEL_VERSION,
    policyVersion: bundle.policyVersion,
    rulesHash: rulesHashOf(bundle),
    ...(narrationHashOf(bundle) === null ? {} : { narrationHash: narrationHashOf(bundle) }),
    sources: [
      "policy/schema.edn",
      "policy/rules.edn",
      "policy/ordering.edn",
      "policy/queries.edn",
      "policy/decisions.edn",
      "policy/obligations.edn",
    ],
    lexicon: bundle.lexicon,
    constants: bundle.constants,
    evidence: shared,
    decisions,
    predicates,
    denials,
    obligations,
    ordering: {
      comparison: bundle.comparison,
      overrides: bundle.overrides,
      overrideQueries: queries.filter((q) => q.name === "q0" || q.name === "declared-overrides"),
      sortQuery: sortQuery as CompiledQuery,
      keyQueries,
    },
    queries: queries.filter((q) => !isOrdering(q.name)),
    coverage: {
      decisions: decisions.length,
      predicates: predicates.length,
      alternatives: predicates.reduce((n, p) => n + p.alternatives.length, 0),
      denials: denials.length,
      obligations: obligations.length,
      queries: queries.length,
      keyQueries: keyQueries.length,
      evidence: evidenceCount,
      overrides: bundle.overrides.length,
      constants: Object.keys(bundle.constants).length,
      attributes: Object.keys(bundle.lexicon.attributes).length,
      clauses: countClauses(allClauses),
    },
  };
}
