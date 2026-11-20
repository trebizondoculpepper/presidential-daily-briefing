/**
 * Manual, local-only measurement for doc/reports/slow-test-redundancy.md (#706): how many full
 * policy evaluations the role/kind metamorphic matrix in src/rules/datalog/rules.test.ts runs,
 * and what they cost, compared with alternative matrix shapes. Not part of the test suite.
 *
 * Run: npx tsx doc/reports/examples/slow-tests/matrix-cost.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Datom } from "datascript";
import { buildPolicy } from "../../../../src/rules/datalog/build.js";
import { evaluatePolicy } from "../../../../src/rules/datalog/engine.js";
import { readScenarios, scenarioDir } from "../../../../src/rules/datalog/runner.js";

const roles = ["implementer", "designer", "human"] as const;
const policy = buildPolicy();
const scenarios = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".edn"))
  .sort()
  .flatMap((f) => readScenarios(readFileSync(join(scenarioDir, f), "utf8"), f));

const flip = (datoms: Datom[], subjects: Set<number | null>): Datom[] =>
  datoms.map(([e, a, v]) =>
    subjects.has(e as number) && a === "kind" ? [e, a, v === "issue" ? "pr" : "issue"] : [e, a, v],
  );

type Shape = "per-subject (current)" | "all-flipped-at-once" | "own-role-only";
const shapes: Shape[] = ["per-subject (current)", "all-flipped-at-once", "own-role-only"];
for (const shape of shapes) {
  let evaluations = 0;
  const start = performance.now();
  for (const s of scenarios) {
    const subjects = [
      ...new Set(s.datoms.filter(([, a]) => a === "kind").map(([e]) => e as number)),
    ];
    const variants: Set<number | null>[] =
      shape === "all-flipped-at-once"
        ? [new Set(), new Set(subjects)]
        : [new Set(), ...subjects.map((x) => new Set([x]))];
    const rs = shape === "own-role-only" ? [s.viewer.role ?? "implementer"] : roles;
    for (const role of rs)
      for (const v of variants) {
        evaluatePolicy({ viewer: { ...s.viewer, role }, datoms: flip(s.datoms, v) }, { policy });
        evaluations++;
      }
  }
  const ms = performance.now() - start;
  console.log(
    `${shape}: ${scenarios.length} scenarios, ${evaluations} evaluations, ${(ms / 1000).toFixed(1)} s, ${(ms / evaluations).toFixed(0)} ms/evaluation`,
  );
}
