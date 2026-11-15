/** Bounded pure-rules spike, no production policy changes or GitHub I/O. */
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import ds from "datascript";
import { readScenarios } from "../../../src/rules/datalog/runner.js";
import { evaluatePolicy } from "../../../src/rules/datalog/engine.js";
const scenarios = readScenarios(
  readFileSync("src/rules/datalog/scenarios/assessment-first.edn", "utf8"),
  "assessment-first.edn",
);
const rules = readFileSync("scripts/experiments/unified-role-ranking/rank.edn", "utf8");
let checks = 0;
for (const scenario of scenarios) {
  const inputs = ["designer", "implementer"].map((role) =>
    evaluatePolicy({ viewer: { ...scenario.viewer, role }, datoms: scenario.datoms }),
  );
  const unique = new Map<
    string,
    { subject: number; kind: string; role: string; base: number; owned: number }
  >();
  for (const [index, result] of inputs.entries())
    for (const d of result.decisions) {
      const key = `${d.subject}:${d.kind}`;
      const owned = scenario.datoms.some(
        ([e, a, v]) =>
          e === d.subject && (a === "owner" || a === "responsible") && v === scenario.viewer.agent,
      )
        ? 0
        : 1;
      if (!unique.has(key))
        unique.set(key, {
          subject: d.subject,
          kind: d.kind,
          role: index === 0 ? "designer" : "implementer",
          base: d.band,
          owned,
        });
    }
  const rows = [...unique.values()];
  const facts = rows.flatMap((x, i) => [
    [i + 100, "owned", x.owned],
    [i + 100, "role", x.role],
    [i + 100, "base", x.base],
  ]);
  const db = ds.init_db(facts as never);
  for (const role of ["designer", "implementer"]) {
    const ranked = ds.q(
      "[:find ?a ?owned ?affinity ?base :in $ % ?r :where (rank ?a ?r ?owned ?affinity ?base)]",
      db,
      rules,
      role,
    ) as number[][];
    ranked.sort((a, b) => a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]! || a[0]! - b[0]!);
    assert.equal(ranked.length, rows.length, "both roles see the same eligible action set");
    checks++;
    for (let i = 1; i < ranked.length; i++)
      assert.ok(ranked[i - 1]![1]! <= ranked[i]![1]!, "owned work always first");
    checks++;
    const unowned = ranked.filter((x) => x[1] === 1);
    for (let i = 1; i < unowned.length; i++)
      assert.ok(unowned[i - 1]![2]! <= unowned[i]![2]!, "preferred-role actions before fallback");
    checks++;
  }
  // The spike adds no action not emitted by an existing engine role, preserving its denials.
  assert.deepEqual(inputs[0]!.denials, inputs[1]!.denials);
  checks++;
  console.log(`${scenario.id}: ${rows.length} unified actions, both roles passed`);
}
console.log(`${checks} assertions passed; production policy unchanged.`);
