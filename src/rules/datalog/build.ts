/**
 * Rules build (doc/design/rules-component.md, "Build pipeline"): read, validate and bundle.
 *
 * DataScript has no ahead-of-time compiler. "Build" here means: each policy/*.edn file is read
 * as exactly one EDN form, every clause and query is printed back as canonical EDN, cross-
 * references are checked, DataScript itself reads and runs each query against an empty database,
 * and the validated policy is written as one JSON artifact that the engine imports.
 *
 *   npm run rules:build            write policy.generated.json
 *   npm run rules:build -- --check fail if the committed artifact differs from a fresh build
 */
import ds from "datascript";
import type { Db, Schema } from "datascript";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readOne, printEdn } from "./edn.js";
import { commandKinds } from "./commands.js";
import { requiredQueries, requiredKeyQueries } from "./bundle.js";
import type { PolicyBundle, DecisionRule, OverridePair, RequiredQuery } from "./bundle.js";
import { rulesHashOf } from "./hash.js";

const here = dirname(fileURLToPath(import.meta.url));
export const artifactPath = join(here, "policy.generated.json");
export const policyDir = join(here, "policy");
export const sourceFiles = [
  "schema.edn",
  "rules.edn",
  "ordering.edn",
  "queries.edn",
  "decisions.edn",
];

/** Every problem found, so one build run reports all of them rather than stopping at the first. */
export class PolicyBuildError extends Error {
  constructor(readonly problems: string[]) {
    super(`Rules build failed with ${problems.length} problem(s):\n${problems.join("\n")}`);
  }
}

const idPattern = /^D-[A-Z]+(-[A-Z]+)*$/;

type Form = unknown;
const symbol = (f: Form): string | null =>
  typeof f === "object" && f !== null && "sym" in f && typeof f.sym === "string" ? f.sym : null;
const list = (f: Form): Form[] | null =>
  typeof f === "object" && f !== null && "list" in f && Array.isArray(f.list) ? f.list : null;
const isKeyword = (f: Form, name: string) =>
  typeof f === "object" && f !== null && "key" in f && f.key === name;

/** Names defined by a rules vector: the head symbol of each `[(name ?args) body...]`. */
export function definedRules(rules: Form): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(rules))
    for (const rule of rules) {
      const head = Array.isArray(rule) ? list(rule[0]) : null;
      const name = head ? symbol(head[0]) : null;
      if (name) names.add(name);
    }
  return names;
}

/**
 * Rule calls in where-clauses. A list clause is a rule call unless it is `not`, `not-join`,
 * `or`, `or-join` or `and`, whose bodies are searched in turn. Vector clauses are data patterns
 * or function calls such as `[(> ?n 0)]`, never rule calls.
 */
export function ruleCalls(clauses: Form[]): string[] {
  const calls: string[] = [];
  for (const clause of clauses) {
    const items = list(clause);
    const head = items ? symbol(items[0]) : null;
    if (!items || !head) continue;
    if (head === "not" || head === "or" || head === "and") calls.push(...ruleCalls(items.slice(1)));
    else if (head === "not-join" || head === "or-join") calls.push(...ruleCalls(items.slice(2)));
    else calls.push(head);
  }
  return calls;
}

/** Where-clauses of a vector or map query: everything after `:where`, or its map value. */
const whereOf = (query: Form): Form[] => {
  if (Array.isArray(query)) {
    const at = query.findIndex((f) => isKeyword(f, "where"));
    return at < 0 ? [] : query.slice(at + 1);
  }
  if (typeof query === "object" && query !== null && "map" in query && Array.isArray(query.map)) {
    const entry = (query.map as Form[][]).find(([k]) => isKeyword(k, "where"));
    return entry && Array.isArray(entry[1]) ? entry[1] : [];
  }
  return [];
};

/**
 * The inputs a vector or map query declares in `:in`, as printed symbols. Without `:in`,
 * DataScript's default is the single database `$`.
 */
export function queryInputs(query: Form): string[] {
  let declared: Form[] | null = null;
  if (Array.isArray(query)) {
    const at = query.findIndex((f) => isKeyword(f, "in"));
    if (at >= 0) {
      const end = query.findIndex(
        (f, i) => i > at && typeof f === "object" && f !== null && "key" in f,
      );
      declared = query.slice(at + 1, end < 0 ? query.length : end);
    }
  } else if (
    typeof query === "object" &&
    query !== null &&
    "map" in query &&
    Array.isArray(query.map)
  ) {
    const entry = (query.map as Form[][]).find(([k]) => isKeyword(k, "in"));
    if (entry) declared = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
  } else throw new Error("a query must be a vector or a map");
  if (declared === null) return ["$"];
  return declared.map((f) => {
    // A relation binding [[?a ?b]]: the only collection form the policy uses.
    if (
      Array.isArray(f) &&
      f.length === 1 &&
      Array.isArray(f[0]) &&
      f[0].length > 0 &&
      f[0].every((v) => symbol(v)?.startsWith("?"))
    )
      return printEdn(f, "query input");
    const name = symbol(f);
    if (name === null) throw new Error(`unsupported query input ${JSON.stringify(f)}`);
    return name;
  });
}

/**
 * DataScript only reports an unknown rule when evaluation reaches it, and an empty database
 * stops evaluation early, so rule references are also checked statically.
 */
function undefinedCalls(clauses: Form[], defined: Set<string>): string[] {
  return [...new Set(ruleCalls(clauses).filter((name) => !defined.has(name)))];
}

/** Reads an EDN map with keyword keys; unknown keys are errors, so a typo cannot be ignored. */
function keyed(form: Form, where: string, allowed: string[]): Map<string, Form> {
  if (typeof form !== "object" || form === null || !("map" in form) || !Array.isArray(form.map))
    throw new Error(`${where}: expected a map`);
  const out = new Map<string, Form>();
  for (const [k, v] of form.map as Form[][]) {
    const name = typeof k === "object" && k !== null && "key" in k ? String(k.key) : null;
    if (!name) throw new Error(`${where}: keys must be keywords, found ${JSON.stringify(k)}`);
    if (!allowed.includes(name)) throw new Error(`${where}: unknown key :${name}`);
    if (out.has(name)) throw new Error(`${where}: duplicate key :${name}`);
    out.set(name, v);
  }
  return out;
}
const need = (m: Map<string, Form>, key: string, where: string): Form => {
  if (!m.has(key)) throw new Error(`${where}: missing :${key}`);
  return m.get(key);
};
/** Reads an EDN map with string keys, preserving source order. */
function named(form: Form, where: string): [string, Form][] {
  if (typeof form !== "object" || form === null || !("map" in form) || !Array.isArray(form.map))
    throw new Error(`${where}: expected a map with string keys`);
  const seen = new Set<string>();
  return (form.map as Form[][]).map(([k, v]) => {
    if (typeof k !== "string")
      throw new Error(`${where}: keys must be strings, found ${JSON.stringify(k)}`);
    if (seen.has(k)) throw new Error(`${where}: duplicate key "${k}"`);
    seen.add(k);
    return [k, v];
  });
}
const vector = (form: Form, where: string): Form[] => {
  if (!Array.isArray(form)) throw new Error(`${where}: expected a vector`);
  return form;
};
const text = (form: Form, where: string): string => {
  if (typeof form !== "string") throw new Error(`${where}: expected a string`);
  return form;
};
const integer = (form: Form, where: string): number => {
  if (typeof form !== "number" || !Number.isSafeInteger(form))
    throw new Error(`${where}: expected an integer`);
  return form;
};
const scalar = (form: Form, where: string): string | number | boolean => {
  if (typeof form === "string" || typeof form === "boolean") return form;
  return integer(form, where);
};

/** Reads policy/*.edn into the bundle. Throws PolicyBuildError listing every source problem. */
export function readSources(
  read: (file: string) => string = (file) => readFileSync(join(policyDir, file), "utf8"),
): PolicyBundle {
  const problems: string[] = [];
  const forms = new Map<string, Form>();
  for (const file of sourceFiles)
    try {
      forms.set(file, readOne(read(file), `policy/${file}`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  if (problems.length) throw new PolicyBuildError(problems);
  const file = (name: string) => forms.get(name);
  try {
    const schemaMap = keyed(file("schema.edn"), "policy/schema.edn", [
      "policy-version",
      "many",
      "constants",
      "common-witnesses",
      "eligibility-witnesses",
    ]);
    const queryMap = named(
      // Query names are keywords in the file; read them as names in source order.
      {
        map: (file("queries.edn") as { map?: Form[][] }).map?.map(([k, v]) => [
          typeof k === "object" && k !== null && "key" in k ? String(k.key) : k,
          v,
        ]),
      },
      "policy/queries.edn",
    );
    const queryForm = new Map(queryMap);
    const template = (name: string) =>
      vector(queryForm.get(name) ?? [], `policy/queries.edn :${name}`);
    for (const name of ["match", "witness", "key-queries"])
      if (!queryForm.has(name)) throw new Error(`policy/queries.edn: missing :${name}`);
    const appended = (name: string, clauses: Form, where: string) =>
      printEdn([...template(name), ...vector(clauses, where)], where);
    const witnesses = (form: Form, where: string) =>
      Object.fromEntries(
        named(form, where).map(([k, v]) => [k, appended("witness", v, `${where} "${k}"`)]),
      );
    const ordering = keyed(file("ordering.edn"), "policy/ordering.edn", [
      "overrides",
      "comparison",
      "rules",
    ]);
    const decisionsFile = keyed(file("decisions.edn"), "policy/decisions.edn", [
      "decisions",
      "denials",
    ]);
    const definitions: DecisionRule[] = vector(
      need(decisionsFile, "decisions", "policy/decisions.edn"),
      "policy/decisions.edn :decisions",
    ).map((form, i) => {
      const where = `policy/decisions.edn :decisions[${i}]`;
      const m = keyed(form, where, [
        "id",
        "kind",
        "band",
        "preference",
        "when",
        "why",
        "codes",
        "witnesses",
      ]);
      const when = vector(need(m, "when", where), `${where} :when`);
      return {
        id: text(need(m, "id", where), `${where} :id`),
        kind: text(need(m, "kind", where), `${where} :kind`),
        band: integer(need(m, "band", where), `${where} :band`),
        preference: integer(need(m, "preference", where), `${where} :preference`),
        clauses: when.map((c) => printEdn(c, `${where} :when`)).join(" "),
        why: text(need(m, "why", where), `${where} :why`),
        codes: vector(need(m, "codes", where), `${where} :codes`).map((c) =>
          text(c, `${where} :codes`),
        ),
        query: appended("match", when, `${where} :when`),
        witnesses: m.has("witnesses") ? witnesses(m.get("witnesses"), `${where} :witnesses`) : {},
      };
    });
    return {
      generatedFrom: "src/rules/datalog/policy/*.edn by npm run rules:build. Do not edit by hand.",
      policyVersion: integer(
        need(schemaMap, "policy-version", "policy/schema.edn"),
        "policy/schema.edn :policy-version",
      ),
      schema: Object.fromEntries(
        vector(need(schemaMap, "many", "policy/schema.edn"), "policy/schema.edn :many").map((a) => [
          text(a, "policy/schema.edn :many"),
          { ":db/cardinality": ":db.cardinality/many" },
        ]),
      ),
      constants: Object.fromEntries(
        named(
          need(schemaMap, "constants", "policy/schema.edn"),
          "policy/schema.edn :constants",
        ).map(([k, v]) => [
          k,
          vector(v, `policy/schema.edn :constants "${k}"`).map((x) =>
            scalar(x, `policy/schema.edn :constants "${k}"`),
          ),
        ]),
      ),
      clauses: printEdn(vector(file("rules.edn"), "policy/rules.edn"), "policy/rules.edn"),
      comparison: vector(
        need(ordering, "comparison", "policy/ordering.edn"),
        "policy/ordering.edn :comparison",
      ).map((c) => text(c, "policy/ordering.edn :comparison")),
      overrides: vector(
        need(ordering, "overrides", "policy/ordering.edn"),
        "policy/ordering.edn :overrides",
      ).map((form, i): OverridePair => {
        const where = `policy/ordering.edn :overrides[${i}]`;
        const m = keyed(form, where, ["winner", "loser"]);
        return {
          winner: text(need(m, "winner", where), `${where} :winner`),
          loser: text(need(m, "loser", where), `${where} :loser`),
        };
      }),
      sortClauses: printEdn(
        vector(need(ordering, "rules", "policy/ordering.edn"), "policy/ordering.edn :rules"),
        "policy/ordering.edn :rules",
      ),
      definitions,
      denials: Object.fromEntries(
        named(
          need(decisionsFile, "denials", "policy/decisions.edn"),
          "policy/decisions.edn :denials",
        ).map(([k, v]) => [k, text(v, `policy/decisions.edn :denials "${k}"`)]),
      ),
      queries: Object.fromEntries(
        queryMap
          .filter(([k]) => !["match", "witness", "key-queries"].includes(k))
          .map(([k, v]) => [
            k,
            printEdn(vector(v, `policy/queries.edn :${k}`), `policy/queries.edn :${k}`),
          ]),
        // validateBundle checks that exactly the required names are present.
      ) as Record<RequiredQuery, string>,
      keyQueries: vector(queryForm.get("key-queries"), "policy/queries.edn :key-queries").map(
        (pair, i) => {
          const where = `policy/queries.edn :key-queries[${i}]`;
          const [name, q, ...extra] = vector(pair, where);
          if (extra.length) throw new Error(`${where}: expected [name query]`);
          return [text(name, where), printEdn(vector(q, where), where)];
        },
      ),
      commonWitnesses: witnesses(
        need(schemaMap, "common-witnesses", "policy/schema.edn"),
        "policy/schema.edn :common-witnesses",
      ),
      eligibilityWitnesses: witnesses(
        need(schemaMap, "eligibility-witnesses", "policy/schema.edn"),
        "policy/schema.edn :eligibility-witnesses",
      ),
    };
  } catch (error) {
    throw new PolicyBuildError([error instanceof Error ? error.message : String(error)]);
  }
}

/** Validates a bundle and returns it; throws PolicyBuildError listing every problem. */
export function validateBundle(bundle: PolicyBundle): PolicyBundle {
  const problems: string[] = [];
  const attempt = (where: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const fullSchema: Schema = {
    ...bundle.schema,
    ...Object.fromEntries(
      Object.keys(bundle.constants).map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
    ),
  };
  let db: Db | undefined;
  attempt("schema", () => {
    db = ds.init_db([], fullSchema);
  });
  const definedIn = new Map<string, Set<string>>();
  for (const [where, rules] of [
    ["rules.edn", bundle.clauses],
    ["ordering.edn :rules", bundle.sortClauses],
  ] as const)
    attempt(where, () => {
      const forms = readOne(rules, where);
      const defined = definedRules(forms);
      definedIn.set(rules, defined);
      // Rule bodies may call rules from the same set only.
      const bodies = Array.isArray(forms)
        ? forms.flatMap((rule) => (Array.isArray(rule) ? rule.slice(1) : []))
        : [];
      for (const name of undefinedCalls(bodies, defined))
        problems.push(`${where}: unknown rule '${name}'`);
      if (db) ds.q('[:find ?t :in $ % :where [?t "kind" _]]', db, rules);
    });
  /**
   * One form per string; every rule call is defined; then DataScript itself reads and runs it.
   * `rules` is the rule set the engine passes when the query's `:in` names `%`. Inputs come from
   * the parsed `:in` clause, so any valid EDN whitespace, newlines or comments work.
   */
  const check = (where: string, q: string, rules: string) =>
    attempt(where, () => {
      const form = readOne(q, where);
      const inputs = queryInputs(form);
      // An unreadable rule set is already reported; do not repeat it as every call being unknown.
      const defined = inputs.includes("%") ? definedIn.get(rules) : new Set<string>();
      const unknown = defined ? undefinedCalls(whereOf(form), defined) : [];
      for (const name of unknown) problems.push(`${where}: unknown rule '${name}'`);
      // DataScript would only repeat the unknown-rule problem already reported.
      if (!db || unknown.length) return;
      if (inputs[0] !== "$") throw new Error(`first query input must be $, found ${inputs[0]}`);
      const args = inputs.slice(1).map((input) => {
        if (input === "%") return rules;
        // The only relation input is the declared override list.
        if (input.startsWith("[[")) return overridePairs(bundle);
        // A scalar binding such as ?t: any entity id exercises the query on an empty database.
        if (/^\?[^\s]+$/.test(input)) return 0;
        throw new Error(`unsupported query input ${input}`);
      });
      ds.q(q, db, ...args);
    });

  for (const [name, q] of Object.entries(bundle.queries))
    check(`queries.edn :${name}`, q, name === "q4" ? bundle.sortClauses : bundle.clauses);
  for (const [name, q] of bundle.keyQueries)
    check(`queries.edn :key-queries ${name}`, q, bundle.clauses);
  for (const [k, q] of Object.entries(bundle.commonWitnesses))
    check(`schema.edn :common-witnesses "${k}"`, q, bundle.clauses);
  for (const [k, q] of Object.entries(bundle.eligibilityWitnesses))
    check(`schema.edn :eligibility-witnesses "${k}"`, q, bundle.clauses);

  // The engine reads queries by name; a missing or renamed one must fail here, not at runtime.
  const names: readonly string[] = requiredQueries;
  for (const name of requiredQueries)
    if (!(name in bundle.queries))
      problems.push(`queries.edn: missing :${name}, which the engine runs`);
  for (const name of Object.keys(bundle.queries))
    if (!names.includes(name)) problems.push(`queries.edn: :${name} is never run by the engine`);
  const keyNames = bundle.keyQueries.map(([name]) => name);
  for (const name of requiredKeyQueries)
    if (keyNames.filter((k) => k === name).length !== 1)
      problems.push(
        `queries.edn :key-queries: need exactly one "${name}", which ordering.edn reads`,
      );
  for (const name of keyNames)
    if (!(requiredKeyQueries as readonly string[]).includes(name))
      problems.push(`queries.edn :key-queries: "${name}" is never read by ordering.edn`);

  const ids = new Set<string>();
  for (const [i, d] of bundle.definitions.entries()) {
    const where = `decisions.edn ${d.id} (position ${i})`;
    if (!idPattern.test(d.id)) problems.push(`${where}: rule ID must match ${idPattern}`);
    if (ids.has(d.id)) problems.push(`${where}: duplicate rule ID`);
    ids.add(d.id);
    if (!(d.kind in commandKinds) && d.kind !== "implement")
      problems.push(`${where}: kind "${d.kind}" has no command mapping`);
    check(`${where} :when`, d.query, bundle.clauses);
    for (const [k, q] of Object.entries(d.witnesses))
      check(`${where} :witnesses "${k}"`, q, bundle.clauses);
    const bound = new Set([
      ...Object.keys(bundle.commonWitnesses),
      ...Object.keys(bundle.eligibilityWitnesses),
      ...Object.keys(d.witnesses),
    ]);
    for (const [, name] of d.why.matchAll(/\{(\w+)\}/g))
      if (!bound.has(name))
        problems.push(`${where}: why placeholder {${name}} has no witness binding`);
  }
  const derived = new Set([...bundle.clauses.matchAll(/"(D-DENY-[A-Z-]+)"/g)].map((m) => m[1]));
  for (const id of derived)
    if (!(id in bundle.denials))
      problems.push(`decisions.edn :denials: ${id} is derived but undocumented`);
  for (const id of Object.keys(bundle.denials))
    if (!derived.has(id))
      problems.push(`decisions.edn :denials: ${id} is never derived by rules.edn`);
  problems.push(...overrideProblems(bundle));
  for (const key of bundle.comparison)
    if (!/^[a-z]+$/.test(key)) problems.push(`ordering.edn :comparison: invalid key "${key}"`);
  if (problems.length) throw new PolicyBuildError(problems);
  return bundle;
}

/** The declared overrides as the [winner loser] tuples the `declared-overrides` query binds. */
export const overridePairs = (bundle: Pick<PolicyBundle, "overrides">): [string, string][] =>
  bundle.overrides.map(({ winner, loser }) => [winner, loser]);

/**
 * Declared overrides must name decision rules of the same kind (the query joins on kind, so a
 * cross-kind pair would silently do nothing), must not repeat or contradict each other, and must
 * not form a cycle.
 */
export function overrideProblems(bundle: Pick<PolicyBundle, "overrides" | "definitions">) {
  const problems: string[] = [];
  const kinds = new Map(bundle.definitions.map((d) => [d.id, d.kind]));
  const seen = new Set<string>();
  const beats = new Map<string, Set<string>>();
  for (const [i, { winner, loser }] of bundle.overrides.entries()) {
    const where = `ordering.edn :overrides[${i}] ${winner} over ${loser}`;
    for (const id of [winner, loser])
      if (!kinds.has(id)) problems.push(`${where}: unknown rule ID ${id}`);
    if (winner === loser) problems.push(`${where}: a rule cannot override itself`);
    else if (kinds.has(winner) && kinds.has(loser) && kinds.get(winner) !== kinds.get(loser))
      problems.push(
        `${where}: kinds differ (${kinds.get(winner)}, ${kinds.get(loser)}), so it would never apply`,
      );
    const key = `${winner}\u0000${loser}`;
    if (seen.has(key)) problems.push(`${where}: duplicate pair`);
    else if (seen.has(`${loser}\u0000${winner}`))
      problems.push(`${where}: contradicts an earlier pair`);
    seen.add(key);
    beats.set(winner, (beats.get(winner) ?? new Set()).add(loser));
  }
  // A longer cycle (A over B over C over A) has no consistent winner either. Two-rule cycles are
  // already reported as contradictions.
  const visit = (id: string, path: string[]): string[] | null => {
    for (const next of [...(beats.get(id) ?? [])].sort()) {
      const at = path.indexOf(next);
      if (at >= 0) return path.slice(at);
      const cycle = visit(next, [...path, next]);
      if (cycle) return cycle;
    }
    return null;
  };
  for (const start of [...beats.keys()].sort()) {
    const cycle = visit(start, [start]);
    // Reported once, from its alphabetically first rule.
    if (cycle && cycle.length > 2 && cycle[0] === start && cycle.every((id) => id >= start))
      problems.push(`ordering.edn :overrides: cycle ${[...cycle, start].join(" over ")}`);
  }
  return problems;
}

/** Reads and validates policy/*.edn. */
export const buildPolicy = (read?: (file: string) => string) => validateBundle(readSources(read));

/** The artifact as written: stable JSON, so a fresh build and the committed file compare exactly. */
export const serialize = (artifact: PolicyBundle) => `${JSON.stringify(artifact, null, 2)}\n`;

function main(argv: string[]): number {
  let artifact: PolicyBundle;
  try {
    artifact = buildPolicy();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (argv.includes("--check")) {
    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(artifactPath, "utf8"));
    } catch (error) {
      process.stderr.write(
        `Cannot read ${artifactPath}: ${error instanceof Error ? error.message : String(error)}. Run npm run rules:build.\n`,
      );
      return 1;
    }
    // Compared as data, so reformatting the JSON file never counts as drift.
    if (!isDeepStrictEqual(committed, JSON.parse(serialize(artifact)))) {
      process.stderr.write(
        `${artifactPath} is stale: the policy sources changed. Run npm run rules:build and commit the result.\n`,
      );
      return 1;
    }
    process.stdout.write("Rules artifact is current.\n");
    return 0;
  }
  writeFileSync(artifactPath, serialize(artifact));
  process.stdout.write(`Wrote ${artifactPath} (rulesHash ${rulesHashOf(artifact)})\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
