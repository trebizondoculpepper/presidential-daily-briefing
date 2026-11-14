/**
 * Runs the native EDN rule scenarios inside the normal suite, one test per scenario named
 * `id (file:line)`, so `npm test` and the required verify check include them. `npm run
 * rules:test` runs the same scenarios alone. Failures keep their category in the error type:
 * RuleDecisionFailure for a wrong decision, RuleInfrastructureError for anything else.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildPolicy, policyDir } from "./build.js";
import {
  readScenarios,
  runScenario,
  runAll,
  junit,
  exitCode,
  scenarioDir,
  RuleDecisionFailure,
  RuleInfrastructureError,
  type Scenario,
} from "./runner.js";

const policy = buildPolicy();
const files = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".edn"))
  .sort();
const scenarios: [string, Scenario][] = files.flatMap((f) =>
  readScenarios(readFileSync(join(scenarioDir, f), "utf8"), `src/rules/datalog/scenarios/${f}`).map(
    (s) => [`${s.id} (${f}:${s.line})`, s] as [string, Scenario],
  ),
);

describe("native EDN rule scenarios (#348)", () => {
  it.each(scenarios)("%s", (_, scenario) => runScenario(scenario, policy));
});

const minimal = (expect: string) => `{:suite "t" :scenarios [
 {:id "one" :doc "d" :viewer {:role "implementer"}
  :facts [{:e 1 "forward-complete" true}
          {:e 100 "kind" "issue" "state" "OPEN" "number" 1 "target" "t1" "created" 1
                  "label" "status:ready" "labels-complete" true "native-complete" true
                  "reverse-complete" true "blocking-complete" true "open-blockers" 0
                  "impact-state" "current" "impact-size" "L"
                  "complexity-state" "current" "complexity-size" "S"}]
  :expect ${expect}}]}`;
const run = (source: string) => {
  const [scenario] = readScenarios(source, "t.edn");
  runScenario(scenario, policy);
};

describe("rule runner outcome categories (#348)", () => {
  it("passes a correct expectation and reports a wrong one as a rule failure", () => {
    run(
      minimal(`{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4}] :denials #{}}`),
    );
    expect(() =>
      run(
        minimal(
          `{:actions [{:subject 100 :rule "D-ORDINARY" :kind "implement" :band 6}] :denials #{}}`,
        ),
      ),
    ).toThrow(RuleDecisionFailure);
    expect(() =>
      run(
        minimal(
          `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4 :why "Wrong."}] :denials #{}}`,
        ),
      ),
    ).toThrow(/action 0 .* why: expected "Wrong\."/);
    expect(() =>
      run(
        minimal(
          `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4}] :denials #{[100 "D-DENY-CLAIM"]}}`,
        ),
      ),
    ).toThrow(/denials differ/);
  });

  it("treats broken or malformed scenarios as infrastructure, never as a pass or skip", () => {
    const broken = [
      minimal(`{:actions [] :denials #{}`), // unbalanced
      minimal(`{:actions [] :denials #{} :extra 1}`), // unknown key
      minimal(`{:actions [{:subject 100 :rule "D-EASY" :kind "implement"}] :denials #{}}`), // no band
      minimal(
        `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4 :facts []}] :denials #{}}`,
      ),
      minimal(`{:actions [] :denials #{}}`).replace(":e 100", ":e 10"), // reserved entity
      minimal(`{:actions [] :denials #{}}`).replace('"implementer"', '"owner"'), // evaluator rejects
    ];
    for (const source of broken) expect(() => run(source), source).toThrow(RuleInfrastructureError);
  });

  it("runAll reports a broken policy source as infrastructure for every scenario, exit 2", () => {
    const outcomes = runAll({
      readPolicy: (file) => {
        const text = readFileSync(join(policyDir, file), "utf8");
        return file === "rules.edn" ? text.replace("[(issue ?t)", "[(issue ?t") : text;
      },
    });
    expect(outcomes[0]).toMatchObject({ name: "rules build", status: "RuleInfrastructureError" });
    expect(outcomes.every((o) => o.status === "RuleInfrastructureError")).toBe(true);
    expect(exitCode(outcomes)).toBe(2);
  });

  it("runAll lists rule failures with exit 1, and both kinds with exit 2", () => {
    const wrong = minimal(
      `{:actions [{:subject 100 :rule "D-ORDINARY" :kind "implement" :band 6}] :denials #{}}`,
    );
    const failing = runAll({ listScenarios: () => ["w.edn"], readScenario: () => wrong });
    expect(failing.map((o) => o.status)).toEqual(["RuleDecisionFailure"]);
    expect(exitCode(failing)).toBe(1);
    const both = runAll({
      listScenarios: () => ["a.edn", "b.edn"],
      readScenario: (f) => (f === "a.edn" ? wrong : "[1"),
    });
    expect(both.map((o) => o.status)).toEqual(["RuleDecisionFailure", "RuleInfrastructureError"]);
    expect(exitCode(both)).toBe(2);
    expect(runAll({ listScenarios: () => [] })[0].status).toBe("RuleInfrastructureError");
  });

  it("writes JUnit with failures and errors kept apart by element and type", () => {
    const xml = junit([
      { name: "a (x.edn:1)", file: "x.edn", status: "passed", message: "" },
      { name: "b (x.edn:9)", file: "x.edn", status: "RuleDecisionFailure", message: 'got <"D">' },
      { name: "c", file: "y.edn", status: "RuleInfrastructureError", message: "bad & broken" },
    ]);
    expect(xml).toContain('tests="3" failures="1" errors="1"');
    expect(xml).toContain(
      '<failure type="RuleDecisionFailure" message="got &lt;&quot;D&quot;&gt;">',
    );
    expect(xml).toContain('<error type="RuleInfrastructureError" message="bad &amp; broken">');
    expect(xml).toContain('<testcase classname="rules.datalog" name="a (x.edn:1)" file="x.edn"/>');
  });

  it("records which decision rules no scenario selects yet", () => {
    const won = new Set(scenarios.flatMap(([, s]) => s.expect.actions.map((a) => a.rule)));
    const missing = policy.definitions.map((d) => d.id).filter((id) => !won.has(id));
    // Recorded, not hidden: #340 adds scenarios for these.
    expect(missing).toEqual(missingToday);
  });
});

/** Rules no scenario selects yet; shrinking this list is #340's work. */
const missingToday: string[] = [
  "D-PR-REVIEW",
  "D-PR-CONFLICT",
  "D-PR-INTEGRATE",
  "D-DOCUMENT",
  "D-DESIGN-REVIEW",
  "D-OWN-EASY",
  "D-BAD-COMPLEXITY",
  "D-BAD-IMPACT",
  "D-OWN-UNFAVORABLE",
];
