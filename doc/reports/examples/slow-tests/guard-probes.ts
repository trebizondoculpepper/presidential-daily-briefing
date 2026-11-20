/**
 * Manual, local-only fault-injection probes for doc/reports/slow-test-redundancy.md (#706).
 * Each probe removes one role or kind guard from a decision rule, in memory only (buildPolicy's
 * injected reader; nothing on disk changes), and reports which test shapes detect it:
 * - scenarios: the EDN scenario expectations alone (rules.test.ts "native EDN rule scenarios");
 * - matrix shapes: the role/kind metamorphic audit, as rules.test.ts runs it ("per-subject") and
 *   two cheaper candidates, using the audience table pinned in rules.test.ts.
 * Not part of the test suite.
 *
 * Run: npx tsx doc/reports/examples/slow-tests/guard-probes.ts PROBE
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Datom } from "datascript";
import { buildPolicy, policyDir } from "../../../../src/rules/datalog/build.js";
import { evaluatePolicy } from "../../../../src/rules/datalog/engine.js";
import { readScenarios, runScenario, scenarioDir } from "../../../../src/rules/datalog/runner.js";

const probes: Record<string, { rule: string; from: string; to: string; what: string }> = {
  "role-agents": {
    rule: "D-COMPLEXITY",
    from: '[[1 "role" ?role] [(not= ?role "human")] (issue ?t) (needs-complexity ?t)]',
    to: "[(issue ?t) (needs-complexity ?t)]",
    what: "agent-only rule loses its not-human role guard",
  },
  "kind-issue": {
    rule: "D-COMPLEXITY",
    from: '[[1 "role" ?role] [(not= ?role "human")] (issue ?t) (needs-complexity ?t)]',
    to: '[[1 "role" ?role] [(not= ?role "human")] [?t "kind" _] (needs-complexity ?t)]',
    what: "issue-only rule loses its issue kind guard",
  },
  "role-agents-semantic": {
    rule: "D-COMPLEXITY",
    from: '[[1 "role" ?role] [(not= ?role "human")] (issue ?t) (needs-complexity ?t)]',
    to: '[[1 "role" ?viewer] [?t "kind" ?role] [(not= ?role "human")] (issue ?t) (needs-complexity ?t)]',
    what: "agent-only rule keeps its guard text but compares the subject kind, not the viewer's role",
  },
  "role-human-semantic": {
    rule: "D-HUMAN-ASK-YOU",
    from: '[[1 "role" "human"] (open-question ?t) (asks-viewer ?t)]',
    to: '[(or [1 "role" "human"] [?t "kind" _]) (open-question ?t) (asks-viewer ?t)]',
    what: "human-only rule keeps its guard text inside an or that any subject satisfies",
  },
  "role-human": {
    rule: "D-HUMAN-ASK-YOU",
    from: '[[1 "role" "human"] (open-question ?t) (asks-viewer ?t)]',
    to: "[(open-question ?t) (asks-viewer ?t)]",
    what: "human-only rule loses its human role guard",
  },
};
const name = process.argv[2] ?? "";
const probe = probes[name];
if (!probe) throw new Error(`probe: one of ${Object.keys(probes).join(", ")}`);

const decisions = readFileSync(join(policyDir, "decisions.edn"), "utf8");
const at = decisions.indexOf(`:id "${probe.rule}"`);
const end = decisions.indexOf(":id ", at + 5);
const block = decisions.slice(at, end < 0 ? undefined : end);
if (!block.includes(probe.from)) throw new Error(`guard text not found in ${probe.rule}`);
const mutated =
  decisions.slice(0, at) + block.replace(probe.from, probe.to) + decisions.slice(at + block.length);
const policy = buildPolicy((file) =>
  file.endsWith("decisions.edn") ? mutated : readFileSync(join(policyDir, file), "utf8"),
);

// The audience table pinned in rules.test.ts, read from its source so the probe uses the same oracle.
const testSource = readFileSync("src/rules/datalog/rules.test.ts", "utf8");
const audience: Record<string, { role: string; kind: string }> = {};
for (const m of testSource.matchAll(/"(D-[A-Z-]+)": \{ role: "([a-z-]+)", kind: "([a-z]+)" \}/g))
  audience[m[1]!] = { role: m[2]!, kind: m[3]! };
const roles = ["implementer", "designer", "human"] as const;
const scenarios = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".edn"))
  .sort()
  .flatMap((f) => readScenarios(readFileSync(join(scenarioDir, f), "utf8"), f));

const flip = (datoms: Datom[], subjects: Set<number>): Datom[] =>
  datoms.map(([e, a, v]) =>
    subjects.has(e as number) && a === "kind" ? [e, a, v === "issue" ? "pr" : "issue"] : [e, a, v],
  );
const violates = (role: string, datoms: Datom[], viewer: Record<string, unknown>): boolean => {
  const kindOf = new Map(datoms.filter(([, a]) => a === "kind").map(([e, , v]) => [e, v]));
  const result = evaluatePolicy({ viewer: { ...viewer, role } as never, datoms }, { policy });
  return result.decisions.some((d) => {
    const m = audience[d.ruleId];
    if (!m) return false;
    const roleOk = m.role === "any" || m.role === role || (m.role === "agents" && role !== "human");
    const kindOk = m.kind === "any" || m.kind === kindOf.get(d.subject);
    return !roleOk || !kindOk;
  });
};

// The static guard check in rules.test.ts ("guards each role-specific rule with its role"),
// textual, as that test applies it.
const staticCaught = policy.definitions.some((d) => {
  const role = audience[d.id]?.role;
  if (!role || role === "any") return false;
  const guarded =
    role === "pr-action"
      ? d.clauses.includes("(pr-action ?t)")
      : role === "agents"
        ? d.clauses.includes('[(not= ?role "human")]') || d.clauses.includes("(pr-action ?t)")
        : d.clauses.includes(`[1 "role" "${role}"]`);
  return !guarded;
});
console.log(
  `${name}: static role-guard check ${staticCaught ? "fails (detects)" : "passes (misses)"}`,
);

let scenarioFailures = 0;
for (const s of scenarios)
  try {
    runScenario(s, policy);
  } catch {
    scenarioFailures++;
  }
console.log(`${name} (${probe.what}): scenarios fail ${scenarioFailures}/${scenarios.length}`);

const detectedBy = new Map<string, string[]>();
for (const shape of ["per-subject", "all-flipped-at-once", "own-role-only"] as const) {
  let caught = 0;
  const ids: string[] = [];
  let evaluations = 0;
  const t = performance.now();
  for (const s of scenarios) {
    const subjects = [
      ...new Set(s.datoms.filter(([, a]) => a === "kind").map(([e]) => e as number)),
    ];
    const variants =
      shape === "all-flipped-at-once"
        ? [new Set<number>(), new Set(subjects)]
        : [new Set<number>(), ...subjects.map((x) => new Set([x]))];
    const rs = shape === "own-role-only" ? [String(s.viewer.role ?? "implementer")] : roles;
    let hit = false;
    for (const role of rs)
      for (const v of variants) {
        evaluations++;
        if (violates(role, flip(s.datoms, v), s.viewer as Record<string, unknown>)) hit = true;
      }
    if (hit) {
      caught++;
      ids.push(s.id);
    }
  }
  detectedBy.set(shape, ids);
  console.log(
    `  ${shape}: detected in ${caught}/${scenarios.length} scenarios (${evaluations} evaluations, ${((performance.now() - t) / 1000).toFixed(0)} s)`,
  );
}
const base = new Set(detectedBy.get("per-subject"));
for (const [shape, ids] of detectedBy)
  if (shape !== "per-subject")
    console.log(
      `  ${shape} vs per-subject: same scenarios ${ids.length === base.size && ids.every((i) => base.has(i))}; missing [${[...base].filter((i) => !ids.includes(i)).join(", ")}]`,
    );
