/**
 * Rules-only test runner (doc/design/rules-component.md, "Rules-only tests").
 *
 * Reads native EDN scenarios from scenarios/*.edn, builds the policy in memory from
 * policy/*.edn, evaluates each scenario's facts with the pure engine and compares the result
 * with the scenario's complete expectation. It starts no PDB process, collects nothing from
 * GitHub and runs no application tests.
 *
 *   npm run rules:test                       run every scenario
 *   npm run rules:test -- --junit PATH       also write JUnit XML for CI (#394)
 *   npm run rules:test -- --scenarios DIR    run the scenarios of another directory instead
 *
 * Two outcomes are kept apart, following #336's recommendation:
 *   RuleDecisionFailure     the scenario ran, but an action, order, denial or explanation differs
 *   RuleInfrastructureError a source, scenario or the runner itself is broken, so no valid
 *                           assertion was made
 * Exit codes: 0 all passed, 1 rule failures only, 2 any infrastructure error (failures still listed).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Datom, Value } from "datascript";
import { readOne } from "./edn.js";
import { buildPolicy, PolicyBuildError } from "./build.js";
import { evaluatePolicy, firstSubjectId } from "./engine.js";
import type { PolicyBundle } from "./bundle.js";
import type { PolicyResult } from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const scenarioDir = join(here, "scenarios");

/** The scenario ran validly and the policy's answer differs from the expectation. */
export class RuleDecisionFailure extends Error {
  override name = "RuleDecisionFailure";
}
/** The assertion could not be made: unreadable source or scenario, or an evaluator fault. */
export class RuleInfrastructureError extends Error {
  override name = "RuleInfrastructureError";
}

export interface ExpectedAction {
  subject: number;
  rule: string;
  kind: string;
  band: number;
  why?: string;
  facts?: Record<string, Value>;
  overridden?: string[];
  unlocks?: number;
  unknown?: string[];
  otherClaims?: number[];
  attentionSection?: {
    section: "input" | "waiting";
    ruleId: string;
    reason?: string;
  };
}
export interface Scenario {
  id: string;
  doc: string;
  file: string;
  line: number;
  viewer: { role: string; agent: string; platform: string; order: string };
  datoms: Datom[];
  expect: { actions: ExpectedAction[]; denials: [number, string][] };
}

type Form = unknown;
const fail = (where: string, detail: string): never => {
  throw new RuleInfrastructureError(`${where}: ${detail}`);
};
const keyword = (f: Form): string | null =>
  typeof f === "object" && f !== null && "key" in f && typeof f.key === "string" ? f.key : null;
/** Map entries with their keys as `:keyword` or `"string"` text, in source order. */
function entries(form: Form, where: string): [string, Form][] {
  if (typeof form !== "object" || form === null || !("map" in form) || !Array.isArray(form.map))
    return fail(where, "expected a map");
  return (form.map as Form[][]).map(([k, v]) => {
    const kw = keyword(k);
    if (kw !== null) return [`:${kw}`, v];
    if (typeof k === "string") return [k, v];
    if (typeof k === "number") return [String(k), v];
    return fail(where, `unsupported map key ${JSON.stringify(k)}`);
  });
}
function fields(form: Form, where: string, required: string[], optional: string[]) {
  const out = new Map<string, Form>();
  for (const [k, v] of entries(form, where)) {
    if (!k.startsWith(":")) fail(where, `keys must be keywords, found ${k}`);
    const name = k.slice(1);
    if (!required.includes(name) && !optional.includes(name)) fail(where, `unknown key ${k}`);
    if (out.has(name)) fail(where, `duplicate key ${k}`);
    out.set(name, v);
  }
  for (const name of required) if (!out.has(name)) fail(where, `missing :${name}`);
  return out;
}
const vector = (f: Form, where: string): Form[] =>
  Array.isArray(f) ? f : fail(where, "expected a vector");
const text = (f: Form, where: string): string =>
  typeof f === "string" ? f : fail(where, "expected a string");
const integer = (f: Form, where: string): number =>
  typeof f === "number" && Number.isSafeInteger(f) ? f : fail(where, "expected an integer");
const scalar = (f: Form, where: string): Value =>
  typeof f === "string" || typeof f === "boolean" ? f : integer(f, where);
const setOrVector = (f: Form, where: string): Form[] => {
  if (Array.isArray(f)) return f;
  if (typeof f === "object" && f !== null && "set" in f && Array.isArray(f.set)) return f.set;
  return fail(where, "expected a set or vector");
};

/** One `{:e id "attribute" value ...}` record; a vector value asserts one datom per element. */
function datomsOf(form: Form, where: string): Datom[] {
  const pairs = entries(form, where);
  const e = pairs.find(([k]) => k === ":e");
  if (!e) return fail(where, "missing :e (the entity id)");
  const entity = integer(e[1], `${where} :e`);
  if (entity !== 1 && entity < firstSubjectId)
    fail(
      where,
      `entity ${entity} is reserved for the policy; use 1 or ${firstSubjectId} and above`,
    );
  const datoms: Datom[] = [];
  for (const [k, v] of pairs) {
    if (k === ":e") continue;
    if (k.startsWith(":")) fail(where, `attributes are strings, found ${k}`);
    for (const value of Array.isArray(v) ? v : [v])
      datoms.push([entity, k, scalar(value, `${where} "${k}"`)]);
  }
  return datoms;
}

function actionOf(form: Form, where: string): ExpectedAction {
  const m = fields(
    form,
    where,
    ["subject", "rule", "kind", "band"],
    ["why", "facts", "overridden", "unlocks", "unknown", "other-claims", "attention-section"],
  );
  const action: ExpectedAction = {
    subject: integer(m.get("subject"), `${where} :subject`),
    rule: text(m.get("rule"), `${where} :rule`),
    kind: text(m.get("kind"), `${where} :kind`),
    band: integer(m.get("band"), `${where} :band`),
  };
  if (m.has("why")) action.why = text(m.get("why"), `${where} :why`);
  if (m.has("facts"))
    action.facts = Object.fromEntries(
      entries(m.get("facts"), `${where} :facts`).map(([k, v]) => [
        k.startsWith(":") ? fail(where, `:facts keys are strings, found ${k}`) : k,
        scalar(v, `${where} :facts "${k}"`),
      ]),
    );
  if (m.has("overridden"))
    action.overridden = vector(m.get("overridden"), `${where} :overridden`).map((x) =>
      text(x, `${where} :overridden`),
    );
  if (m.has("unlocks")) action.unlocks = integer(m.get("unlocks"), `${where} :unlocks`);
  if (m.has("unknown"))
    action.unknown = vector(m.get("unknown"), `${where} :unknown`).map((x) =>
      text(x, `${where} :unknown`),
    );
  if (m.has("other-claims"))
    action.otherClaims = vector(m.get("other-claims"), `${where} :other-claims`).map((x) =>
      integer(x, `${where} :other-claims`),
    );
  if (m.has("attention-section")) {
    const sec = fields(
      m.get("attention-section"),
      `${where} :attention-section`,
      ["section", "rule"],
      ["why"],
    );
    const section = text(sec.get("section"), `${where} :attention-section :section`);
    if (section !== "input" && section !== "waiting")
      return fail(
        where,
        `:attention-section :section must be "input" or "waiting", found ${section}`,
      );
    action.attentionSection = {
      section,
      ruleId: text(sec.get("rule"), `${where} :attention-section :rule`),
      ...(sec.has("why")
        ? { reason: text(sec.get("why"), `${where} :attention-section :why`) }
        : {}),
    };
  }
  return action;
}

/** Reads one scenario file. Any structural problem is an infrastructure error, never skipped. */
export function readScenarios(source: string, file: string): Scenario[] {
  let form: Form;
  try {
    form = readOne(source, file);
  } catch (error) {
    return fail(file, error instanceof Error ? error.message : String(error));
  }
  const top = fields(form, file, ["suite", "scenarios"], []);
  text(top.get("suite"), `${file} :suite`);
  const seen = new Set<string>();
  return vector(top.get("scenarios"), `${file} :scenarios`).map((s, i) => {
    let where = `${file} :scenarios[${i}]`;
    const m = fields(s, where, ["id", "doc", "facts", "expect"], ["viewer"]);
    const id = text(m.get("id"), `${where} :id`);
    if (seen.has(id)) fail(where, `duplicate scenario id "${id}"`);
    seen.add(id);
    // The reader keeps no positions; a scenario's line is found from its unique id.
    const at = source.indexOf(`:id ${JSON.stringify(id)}`);
    const line = at < 0 ? 1 : source.slice(0, at).split("\n").length;
    where = `${file}:${line} ${id}`;
    const viewer = { role: "implementer", agent: "", platform: "", order: "impact" };
    if (m.has("viewer"))
      for (const [k, v] of fields(m.get("viewer"), `${where} :viewer`, [], Object.keys(viewer)))
        viewer[k as keyof typeof viewer] = text(v, `${where} :viewer :${k}`);
    const expectation = fields(m.get("expect"), `${where} :expect`, ["actions", "denials"], []);
    return {
      id,
      doc: text(m.get("doc"), `${where} :doc`),
      file,
      line,
      viewer,
      datoms: vector(m.get("facts"), `${where} :facts`).flatMap((r, j) =>
        datomsOf(r, `${where} :facts[${j}]`),
      ),
      expect: {
        actions: vector(expectation.get("actions"), `${where} :actions`).map((a, j) =>
          actionOf(a, `${where} :actions[${j}]`),
        ),
        denials: setOrVector(expectation.get("denials"), `${where} :denials`).map((d) => {
          const [subject, rule, ...extra] = vector(d, `${where} :denials`);
          if (extra.length) fail(where, ":denials entries are [subject rule-id]");
          return [integer(subject, `${where} :denials`), text(rule, `${where} :denials`)];
        }),
      },
    };
  });
}

/** Every difference between the result and the expectation; empty when the scenario passes. */
export function differences(scenario: Scenario, result: PolicyResult): string[] {
  const out: string[] = [];
  const got = result.decisions;
  const want = scenario.expect.actions;
  const label = (a: {
    subject: number;
    rule?: string;
    ruleId?: string;
    kind: string;
    band: number;
  }) => `${a.subject} ${a.kind} ${a.rule ?? a.ruleId} band ${a.band}`;
  const gotOrder = got.map((d) => label(d));
  const wantOrder = want.map((a) => label(a));
  if (!isDeepStrictEqual(gotOrder, wantOrder))
    out.push(
      `actions differ:\n  expected ${JSON.stringify(wantOrder)}\n  actual   ${JSON.stringify(gotOrder)}`,
    );
  else
    want.forEach((a, i) => {
      const d = got[i];
      const at = `action ${i} (${label(a)})`;
      const check = (name: string, expected: unknown, actual: unknown) => {
        if (expected !== undefined && !isDeepStrictEqual(expected, actual))
          out.push(
            `${at} ${name}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`,
          );
      };
      check("why", a.why, d.why.text);
      check("facts", a.facts, d.why.facts);
      check("overridden", a.overridden, d.why.overriddenRuleIds);
      check("unlocks", a.unlocks, d.unlocks);
      check("unknown", a.unknown, d.unlocksUnknown);
      check("other-claims", a.otherClaims, d.otherClaims);
      if (a.attentionSection !== undefined) {
        const expectedSec =
          a.attentionSection.reason === undefined
            ? { section: a.attentionSection.section, ruleId: a.attentionSection.ruleId }
            : a.attentionSection;
        const actualSec =
          d.attentionSection === undefined
            ? undefined
            : a.attentionSection.reason === undefined
              ? { section: d.attentionSection.section, ruleId: d.attentionSection.ruleId }
              : d.attentionSection;
        check("attention-section", expectedSec, actualSec);
      }
    });
  const key = ([s, r]: [number, string]) => `${s} ${r}`;
  const wantDenials = scenario.expect.denials.map(key).sort();
  const gotDenials = result.denials.map((d) => key([d.subject, d.ruleId])).sort();
  if (!isDeepStrictEqual(wantDenials, gotDenials))
    out.push(
      `denials differ:\n  expected ${JSON.stringify(wantDenials)}\n  actual   ${JSON.stringify(gotDenials)}`,
    );
  return out;
}

/** Runs one scenario; throws RuleDecisionFailure or RuleInfrastructureError. */
export function runScenario(scenario: Scenario, policy: PolicyBundle): void {
  let result: PolicyResult;
  try {
    result = evaluatePolicy({ viewer: scenario.viewer, datoms: scenario.datoms }, { policy });
  } catch (error) {
    throw new RuleInfrastructureError(
      `${scenario.file}:${scenario.line} ${scenario.id}: evaluator failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const found = differences(scenario, result);
  if (found.length)
    throw new RuleDecisionFailure(
      `${scenario.file}:${scenario.line} ${scenario.id}: ${found.join("\n")}`,
    );
}

export interface Outcome {
  name: string;
  file: string;
  status: "passed" | "RuleDecisionFailure" | "RuleInfrastructureError";
  message: string;
}

/**
 * Builds the policy and runs every scenario file. `read` and `list` exist so tests can supply
 * broken sources; by default they read policy/ and scenarios/ beside this file.
 */
export function runAll(
  options: {
    readPolicy?: (file: string) => string;
    readScenario?: (file: string) => string;
    listScenarios?: () => string[];
    /** Another scenario directory (`--scenarios DIR`), reported by that path. */
    dir?: string;
  } = {},
): Outcome[] {
  const dir = options.dir ?? scenarioDir;
  const label = options.dir ?? "src/rules/datalog/scenarios";
  const outcomes: Outcome[] = [];
  const infrastructure = (name: string, file: string, error: unknown) =>
    outcomes.push({
      name,
      file,
      status: "RuleInfrastructureError",
      message: error instanceof Error ? error.message : String(error),
    });
  let policy: PolicyBundle | null = null;
  try {
    policy = buildPolicy(options.readPolicy);
  } catch (error) {
    infrastructure(
      "rules build",
      "src/rules/datalog/policy",
      error instanceof PolicyBuildError ? error.problems.join("\n") : error,
    );
  }
  let files: string[] = [];
  try {
    files = (options.listScenarios ?? (() => readdirSync(dir)))()
      .filter((f) => f.endsWith(".edn"))
      .sort();
    if (!files.length) throw new Error(`no scenario files in ${dir}`);
  } catch (error) {
    infrastructure("scenario discovery", label, error);
  }
  const read = options.readScenario ?? ((f: string) => readFileSync(join(dir, f), "utf8"));
  for (const f of files) {
    const file = `${label}/${f}`;
    let scenarios: Scenario[];
    try {
      scenarios = readScenarios(read(f), file);
    } catch (error) {
      infrastructure(`${f} (unreadable)`, file, error);
      continue;
    }
    for (const s of scenarios) {
      const name = `${s.id} (${f}:${s.line})`;
      // Without a policy no assertion can be made; that is reported once, as the build error.
      if (!policy) {
        outcomes.push({
          name,
          file,
          status: "RuleInfrastructureError",
          message: "rules build failed",
        });
        continue;
      }
      try {
        runScenario(s, policy);
        outcomes.push({ name, file, status: "passed", message: "" });
      } catch (error) {
        outcomes.push({
          name,
          file,
          status:
            error instanceof RuleDecisionFailure
              ? "RuleDecisionFailure"
              : "RuleInfrastructureError",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcomes;
}

const xml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** JUnit XML. Rule failures are `<failure>`, infrastructure problems `<error>`; both carry the type. */
export function junit(outcomes: Outcome[]): string {
  const failures = outcomes.filter((o) => o.status === "RuleDecisionFailure").length;
  const errors = outcomes.filter((o) => o.status === "RuleInfrastructureError").length;
  const cases = outcomes.map((o) => {
    const open = `    <testcase classname="rules.datalog" name="${xml(o.name)}" file="${xml(o.file)}"`;
    if (o.status === "passed") return `${open}/>`;
    const element = o.status === "RuleDecisionFailure" ? "failure" : "error";
    const first = o.message.split("\n")[0];
    return `${open}>\n      <${element} type="${o.status}" message="${xml(first)}">${xml(o.message)}</${element}>\n    </testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="rules" tests="${outcomes.length}" failures="${failures}" errors="${errors}">\n  <testsuite name="rules.datalog" tests="${outcomes.length}" failures="${failures}" errors="${errors}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}

export const exitCode = (outcomes: Outcome[]): number =>
  outcomes.some((o) => o.status === "RuleInfrastructureError")
    ? 2
    : outcomes.some((o) => o.status === "RuleDecisionFailure")
      ? 1
      : 0;

export interface MainDeps {
  run: () => Outcome[];
  /** Runs another scenario directory (`--scenarios DIR`); default: the real runner there. */
  runIn?: (dir: string) => Outcome[];
  out: (text: string) => void;
  err: (text: string) => void;
  writeFile: (path: string, text: string) => void;
}
const defaultDeps: MainDeps = {
  run: () => runAll(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  writeFile: (path, text) => writeFileSync(path, text),
};

/** The rules:test command. Returns the exit code; never throws for a report it cannot write. */
export function main(argv: string[], deps: MainDeps = defaultDeps): number {
  const at = argv.indexOf("--junit");
  if (at >= 0 && !argv[at + 1]) {
    deps.err("--junit needs a file path.\n");
    return 2;
  }
  const scenariosAt = argv.indexOf("--scenarios");
  if (scenariosAt >= 0 && !argv[scenariosAt + 1]) {
    deps.err("--scenarios needs a directory.\n");
    return 2;
  }
  const dir = scenariosAt >= 0 ? argv[scenariosAt + 1] : undefined;
  const outcomes =
    dir === undefined ? deps.run() : (deps.runIn ?? ((d) => runAll({ dir: d })))(dir);
  for (const o of outcomes)
    deps.out(
      o.status === "passed"
        ? `ok    ${o.name}\n`
        : `FAIL  ${o.name} [${o.status}]\n${o.message.replace(/^/gm, "      ")}\n`,
    );
  const count = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  deps.out(
    `\n${count("passed")} passed, ${count("RuleDecisionFailure")} rule failures, ${count("RuleInfrastructureError")} infrastructure errors\n`,
  );
  if (at >= 0)
    try {
      deps.writeFile(argv[at + 1], junit(outcomes));
    } catch (error) {
      // A missing report must never look like a pass: this is an infrastructure error.
      deps.err(
        `RuleInfrastructureError: could not write the JUnit report to ${argv[at + 1]}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  return exitCode(outcomes);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
