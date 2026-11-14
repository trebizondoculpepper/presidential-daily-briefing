/**
 * Rules build (doc/design/rules-component.md, "Build pipeline"): read, validate and bundle.
 *
 * DataScript has no ahead-of-time compiler. "Build" here means: every clause and query is read
 * as exactly one EDN form, DataScript itself reads and runs each one against an empty database,
 * cross-references are checked, and the validated policy is written as one JSON artifact.
 *
 *   npm run rules:build            write policy.generated.json
 *   npm run rules:build -- --check fail if the committed artifact differs from a fresh build
 *
 * At this stage the sources are still the exports of policy.ts; the EDN files replace them in
 * the next migration step without changing this file's checks.
 */
import ds from "datascript";
import type { Db, Schema } from "datascript";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as policy from "./policy.js";
import { readOne } from "./edn.js";

export const artifactPath = join(dirname(fileURLToPath(import.meta.url)), "policy.generated.json");

/** The policy as the engine consumes it. Field names and order match datalog.ts's artifact. */
export interface PolicySources {
  policyVersion: number;
  schema: Schema;
  constants: Record<string, (string | number | boolean)[]>;
  clauses: string;
  definitions: policy.RuleDefinition[];
  comparison: readonly string[];
  sortClauses: string;
  keyQueries: [string, string][];
  queries: Record<string, string>;
  unknownUnlocks: string;
  activeDependents: string;
  denialsQuery: string;
  commandTemplates: Record<string, string>;
  commandKinds: Record<string, string>;
  otherClaimsQuery: string;
  witnessClauses: Record<string, Record<string, string>>;
  commonWitnesses: Record<string, string>;
  eligibilityWitnesses: Record<string, string>;
}

export function currentSources(): PolicySources {
  return {
    policyVersion: policy.policyVersion,
    schema: policy.schema,
    constants: policy.constants,
    clauses: policy.clauses,
    definitions: policy.definitions,
    comparison: policy.comparison,
    sortClauses: policy.sortClauses,
    keyQueries: policy.keyQueries,
    queries: policy.queries,
    unknownUnlocks: policy.unknownUnlocks,
    activeDependents: policy.activeDependents,
    denialsQuery: policy.denialsQuery,
    commandTemplates: policy.commandTemplates,
    commandKinds: policy.commandKinds,
    otherClaimsQuery: policy.otherClaimsQuery,
    witnessClauses: policy.witnessClauses,
    commonWitnesses: policy.commonWitnesses,
    eligibilityWitnesses: policy.eligibilityWitnesses,
  };
}

/** Every problem found, so one build run reports all of them rather than stopping at the first. */
export class PolicyBuildError extends Error {
  constructor(readonly problems: string[]) {
    super(`Rules build failed with ${problems.length} problem(s):\n${problems.join("\n")}`);
  }
}

/** Builds the per-rule match query exactly as the engine does. */
export const matchQuery = (ruleClauses: string) =>
  `[:find ?t :in $ % :where (foreground ?t) ${ruleClauses}]`;
/** Builds the per-witness query exactly as the engine does. */
export const witnessQuery = (clause: string) => `[:find ?value :in $ % ?t :where ${clause}]`;

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

/** Where-clauses of a vector query: everything after `:where`. */
const whereOf = (query: Form): Form[] => {
  if (!Array.isArray(query)) return [];
  const at = query.findIndex((f) => isKeyword(f, "where"));
  return at < 0 ? [] : query.slice(at + 1);
};

/**
 * DataScript only reports an unknown rule when evaluation reaches it, and an empty database
 * stops evaluation early, so rule references are also checked statically.
 */
function undefinedCalls(clauses: Form[], defined: Set<string>): string[] {
  return [...new Set(ruleCalls(clauses).filter((name) => !defined.has(name)))];
}

/** Validates the sources and returns the artifact; throws PolicyBuildError listing every problem. */
export function buildPolicy(sources: PolicySources): PolicySources {
  const problems: string[] = [];
  const attempt = (where: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const fullSchema: Schema = {
    ...sources.schema,
    ...Object.fromEntries(
      Object.keys(sources.constants).map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
    ),
  };
  let db: Db | undefined;
  attempt("schema", () => {
    db = ds.init_db([], fullSchema);
  });
  const definedIn = new Map<string, Set<string>>();
  for (const [where, rules] of [
    ["clauses", sources.clauses],
    ["sortClauses", sources.sortClauses],
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
    });
  /**
   * One form per string; every rule call is defined; then DataScript itself reads and runs it.
   * `rules` is the rule set the engine passes with this query, or null when it passes none.
   */
  const check = (where: string, text: string, rules: string | null, run: (db: Db) => void) =>
    attempt(where, () => {
      const form = readOne(text, where);
      // An unreadable rule set is already reported; do not repeat it as every call being unknown.
      const defined = rules === null ? new Set<string>() : definedIn.get(rules);
      if (defined)
        for (const name of undefinedCalls(whereOf(form), defined))
          problems.push(`${where}: unknown rule '${name}'`);
      if (db) run(db);
    });

  check("clauses", "[]", null, (d) =>
    ds.q('[:find ?t :in $ % :where [?t "kind" _]]', d, sources.clauses),
  );
  check("sortClauses", "[]", null, (d) =>
    ds.q('[:find ?t :in $ % :where [?t "kind" _]]', d, sources.sortClauses),
  );
  const rulesFor = (q: string, rules: string) => (q.includes(":in $ %") ? rules : null);
  const run = (q: string, rules: string) => (d: Db) => {
    if (q.includes(":in $ % ?t")) ds.q(q, d, rules, 0);
    else if (q.includes(":in $ ?t")) ds.q(q, d, 0);
    else if (q.includes(":in $ %")) ds.q(q, d, rules);
    else ds.q(q, d);
  };
  for (const [name, q] of Object.entries(sources.queries)) {
    const rules = name === "q4" ? sources.sortClauses : sources.clauses;
    check(`queries.${name}`, q, rulesFor(q, rules), run(q, rules));
  }
  for (const [name, q] of sources.keyQueries)
    check(`keyQueries.${name}`, q, rulesFor(q, sources.clauses), run(q, sources.clauses));
  for (const name of [
    "unknownUnlocks",
    "activeDependents",
    "denialsQuery",
    "otherClaimsQuery",
  ] as const)
    check(
      name,
      sources[name],
      rulesFor(sources[name], sources.clauses),
      run(sources[name], sources.clauses),
    );

  const ids = new Set<string>();
  for (const [i, d] of sources.definitions.entries()) {
    const where = `definitions[${i}] ${d.id}`;
    if (!idPattern.test(d.id)) problems.push(`${where}: rule ID must match ${idPattern}`);
    if (ids.has(d.id)) problems.push(`${where}: duplicate rule ID`);
    ids.add(d.id);
    if (!Number.isInteger(d.band) || !Number.isInteger(d.preference))
      problems.push(`${where}: band and preference must be integers`);
    if (!(d.kind in sources.commandKinds) && d.kind !== "implement")
      problems.push(`${where}: kind "${d.kind}" has no command mapping`);
    const q = matchQuery(d.clauses);
    check(`${where} clauses`, q, sources.clauses, run(q, sources.clauses));
    const bound = new Set([
      ...Object.keys(sources.commonWitnesses),
      ...Object.keys(sources.eligibilityWitnesses),
      ...Object.keys(sources.witnessClauses[d.id] ?? {}),
    ]);
    for (const [, name] of d.why.matchAll(/\{(\w+)\}/g))
      if (!bound.has(name))
        problems.push(`${where}: why placeholder {${name}} has no witness binding`);
  }
  for (const id of Object.keys(sources.witnessClauses))
    if (!ids.has(id)) problems.push(`witnessClauses.${id}: no rule with this ID`);
  const witnesses: [string, string][] = [
    ...Object.entries(sources.commonWitnesses).map(
      ([k, c]) => [`commonWitnesses.${k}`, c] as [string, string],
    ),
    ...Object.entries(sources.eligibilityWitnesses).map(
      ([k, c]) => [`eligibilityWitnesses.${k}`, c] as [string, string],
    ),
    ...Object.entries(sources.witnessClauses).flatMap(([id, w]) =>
      Object.entries(w).map(([k, c]) => [`witnessClauses.${id}.${k}`, c] as [string, string]),
    ),
  ];
  for (const [where, clause] of witnesses) {
    const q = witnessQuery(clause);
    check(where, q, sources.clauses, run(q, sources.clauses));
  }
  if (problems.length) throw new PolicyBuildError(problems);
  return sources;
}

/** The artifact as written: stable JSON, so a fresh build and the committed file compare exactly. */
export const serialize = (artifact: PolicySources) => `${JSON.stringify(artifact, null, 2)}\n`;

function main(argv: string[]): number {
  let artifact: PolicySources;
  try {
    artifact = buildPolicy(currentSources());
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
  process.stdout.write(`Wrote ${artifactPath}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
