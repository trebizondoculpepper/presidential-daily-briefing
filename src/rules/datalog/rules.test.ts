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
import { evaluatePolicy } from "./engine.js";
import type { Datom } from "datascript";
import {
  readScenarios,
  runScenario,
  runAll,
  junit,
  exitCode,
  main,
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

/**
 * Which role and subject kind each decision rule is for (#469). Pinned here, not read from the
 * policy, so deleting a guard from decisions.edn cannot silently change the expectation. A new
 * rule must be added here; changing a rule's audience is a deliberate edit of this table.
 * `pr-action` is the policy's PR audience: implementers, and a designer for a design PR they are
 * responsible for (rules.edn `pr-action`). `agents` is every role except human.
 */
const audience: Record<
  string,
  {
    role: "implementer" | "designer" | "human" | "pr-action" | "agents" | "any";
    kind: "issue" | "pr" | "any";
  }
> = {
  "D-ATTENTION": { role: "any", kind: "any" },
  "D-PR-FAIL": { role: "pr-action", kind: "pr" },
  "D-PR-REVIEW": { role: "pr-action", kind: "pr" },
  "D-PR-CONFLICT": { role: "pr-action", kind: "pr" },
  "D-PR-MERGE": { role: "pr-action", kind: "pr" },
  "D-PR-INTEGRATE": { role: "pr-action", kind: "pr" },
  "D-DECIDE": { role: "designer", kind: "any" },
  "D-DOCUMENT": { role: "designer", kind: "any" },
  "D-DESIGN-REVIEW": { role: "designer", kind: "pr" },
  "D-EASY": { role: "implementer", kind: "issue" },
  "D-OWN-EASY": { role: "implementer", kind: "issue" },
  "D-COMPLEXITY-BOOST": { role: "implementer", kind: "issue" },
  "D-COMPLEXITY": { role: "implementer", kind: "issue" },
  "D-IMPACT-BOOST": { role: "designer", kind: "issue" },
  "D-IMPACT": { role: "designer", kind: "issue" },
  "D-BAD-COMPLEXITY": { role: "implementer", kind: "issue" },
  "D-BAD-IMPACT": { role: "designer", kind: "issue" },
  "D-ORDINARY": { role: "implementer", kind: "issue" },
  "D-OWN": { role: "implementer", kind: "issue" },
  "D-DESIGN": { role: "designer", kind: "issue" },
  "D-UNFAVORABLE": { role: "implementer", kind: "issue" },
  "D-OWN-UNFAVORABLE": { role: "implementer", kind: "issue" },
  "D-INSPECT": { role: "agents", kind: "issue" },
  // Retained claims (#413): the viewer's own issue claims only.
  "D-OWN-RESUME": { role: "implementer", kind: "issue" },
  "D-REVIEW-OWNED": { role: "implementer", kind: "issue" },
  "D-REVIEW-OWNED-PARTIAL": { role: "implementer", kind: "issue" },
  "D-OWN-UNKNOWN": { role: "implementer", kind: "issue" },
  // Repository context has no GitHub issue/PR kind.
  "D-INVENTORY-UNKNOWN": { role: "implementer", kind: "any" },
  "D-OWNED-INCOMPLETE": { role: "implementer", kind: "issue" },
  "D-OWN-WAIT": { role: "implementer", kind: "issue" },
  "D-HUMAN-ASK-YOU": { role: "human", kind: "issue" },
  "D-HUMAN-ASK": { role: "human", kind: "issue" },
  "D-HUMAN-UNVERIFIED": { role: "human", kind: "issue" },
  "D-HUMAN-DECIDE": { role: "human", kind: "issue" },
  "D-HUMAN-SIGNOFF": { role: "human", kind: "pr" },
  "D-HUMAN-ORPHANED-YOU": { role: "human", kind: "issue" },
  "D-HUMAN-ORPHANED": { role: "human", kind: "issue" },
  "D-HUMAN-ORPHANED-UNKNOWN": { role: "human", kind: "issue" },
};
const roles = ["implementer", "designer", "human"] as const;

/**
 * The designer half of `pr-action` (rules.edn), restated independently of the policy: a design PR
 * (a design label on the PR or on an issue it closes) linked to the viewer as owner, as
 * responsible, or by closing an issue the viewer owns.
 */
const designLabels = ["documentation", "status:needs-design"];
function ownDesignPr(datoms: Datom[], pr: number, agent: string): boolean {
  const has = (e: number, a: string, v: unknown) =>
    datoms.some(([x, y, z]) => x === e && y === a && z === v);
  const closes = datoms.filter(([e, a]) => e === pr && a === "closes").map(([, , v]) => Number(v));
  const design = [pr, ...closes].some((e) => designLabels.some((l) => has(e, "label", l)));
  const mine =
    !!agent &&
    (has(pr, "owner", agent) ||
      has(pr, "responsible", agent) ||
      closes.some((i) => has(i, "owner", agent)));
  return design && mine;
}

describe("rule audience: roles and subject kinds (#469)", () => {
  it("pins every decision rule's audience", () => {
    expect(policy.definitions.map((d) => d.id).sort()).toEqual(Object.keys(audience).sort());
  });

  it("guards each role-specific rule with its role in the policy", () => {
    for (const d of policy.definitions) {
      const { role } = audience[d.id]!;
      if (role === "any") continue;
      const guarded =
        role === "pr-action"
          ? d.clauses.includes("(pr-action ?t)")
          : role === "agents"
            ? d.clauses.includes('[(not= ?role "human")]')
            : d.clauses.includes(`[1 "role" "${role}"]`);
      expect(guarded, `${d.id} lost its ${role} guard`).toBe(true);
    }
  });

  // Metamorphic: rerun every scenario under each role, and with each subject's kind flipped
  // (issue <-> pr). Whatever is selected must still be meant for that role and that kind, so a
  // weakened role or kind guard fails here even though no scenario was written for it.
  it.each(scenarios)(
    "%s: every role and kind variant selects only rules meant for it",
    (_, s) => {
      const subjects = [...new Set(s.datoms.filter(([, a]) => a === "kind").map(([e]) => e))];
      const flipped = (subject: number | null): Datom[] =>
        s.datoms.map(([e, a, v]) =>
          e === subject && a === "kind" ? [e, a, v === "issue" ? "pr" : "issue"] : [e, a, v],
        );
      for (const role of roles)
        for (const subject of [null, ...subjects]) {
          const datoms = flipped(subject);
          const kindOf = new Map(datoms.filter(([, a]) => a === "kind").map(([e, , v]) => [e, v]));
          const result = evaluatePolicy({ viewer: { ...s.viewer, role }, datoms }, { policy });
          for (const d of result.decisions) {
            const meant = audience[d.ruleId]!;
            const where = `${d.ruleId} on ${String(kindOf.get(d.subject))} ${d.subject} as ${role}${subject === null ? "" : ` (kind of ${subject} flipped)`}`;
            const allowed =
              meant.role === "any" ||
              meant.role === role ||
              (meant.role === "agents" && role !== "human") ||
              (meant.role === "pr-action" &&
                (role === "implementer" ||
                  (role === "designer" && ownDesignPr(datoms, d.subject, s.viewer.agent))));
            expect(allowed, where).toBe(true);
            expect(meant.kind === "any" || meant.kind === kindOf.get(d.subject), where).toBe(true);
          }
        }
    },
    // Metamorphic: roles x (1 + subjects) full evaluations per scenario. The largest scenario
    // exceeds the 20 s default on Windows runners (like #603 and #625), so it gets more time;
    // the assertions are unchanged.
    60_000,
  );
});

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
    expect(() =>
      run(
        minimal(
          `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4 :attention-section {:section "waiting" :rule "HS-WAITING-UNKNOWN"}}] :denials #{}}`,
        ),
      ),
    ).toThrow(/action 0 .* attention-section: expected/);
  });

  it("treats broken or malformed scenarios as infrastructure, never as a pass or skip", () => {
    const broken = [
      minimal(`{:actions [] :denials #{}`), // unbalanced
      minimal(`{:actions [] :denials #{} :extra 1}`), // unknown key
      minimal(`{:actions [{:subject 100 :rule "D-EASY" :kind "implement"}] :denials #{}}`), // no band
      minimal(
        `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4 :facts []}] :denials #{}}`,
      ),
      minimal(
        `{:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4 :attention-section {:section "other" :rule "HS-X"}}] :denials #{}}`,
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

  it("reports an unwritable JUnit path as an infrastructure error with exit 2", () => {
    const errors: string[] = [];
    const deps = {
      run: () => [{ name: "a", file: "x.edn", status: "passed" as const, message: "" }],
      out: () => {},
      err: (t: string) => errors.push(t),
      writeFile: () => {
        throw new Error("ENOENT: no such file or directory, open 'missing/dir/r.xml'");
      },
    };
    expect(main(["--junit", join("missing", "dir", "r.xml")], deps)).toBe(2);
    expect(errors.join("")).toMatch(
      /^RuleInfrastructureError: could not write the JUnit report to .*r\.xml: ENOENT/,
    );
    let written = "";
    expect(main(["--junit", "r.xml"], { ...deps, writeFile: (_, t) => (written = t) })).toBe(0);
    expect(written).toContain('tests="1" failures="0" errors="0"');
    expect(main(["--junit"], deps)).toBe(2);
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

  it("asserts every denial rule in at least one scenario (#340)", () => {
    const asserted = new Set(scenarios.flatMap(([, s]) => s.expect.denials.map(([, id]) => id)));
    expect(Object.keys(policy.denials).filter((id) => !asserted.has(id))).toEqual([]);
  });
});

/** Rules no scenario selects yet; #340 covered the last of them, so any new rule needs a scenario. */
const missingToday: string[] = [];
