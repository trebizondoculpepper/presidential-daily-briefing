// #499 research probe: actual engine/DataScript, not a production override loader.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ds from "datascript";
import type { Datom } from "datascript";
import { evaluatePolicy } from "../../../src/rules/datalog/engine.js";
import { buildPolicy, validateBundle } from "../../../src/rules/datalog/build.js";
import { readOne, printEdn } from "../../../src/rules/datalog/edn.js";
import { compileEnglish } from "../../../src/rules/datalog/english.js";
import { conjunctionText } from "../../../src/rules/datalog/english-render.js";

const policy = buildPolicy();
const subject = (id: number): Datom[] => [
  [id, "kind", "issue"],
  [id, "state", "OPEN"],
  [id, "number", id],
  [id, "target", `fixture-${id}`],
  [id, "created", id],
  [id, "label", "status:ready"],
  [id, "labels-complete", id !== 102],
  [id, "native-complete", true],
  [id, "reverse-complete", true],
  [id, "blocking-complete", true],
  [id, "open-blockers", id === 103 ? 1 : 0],
  [id, "impact-state", "current"],
  [id, "impact-size", "L"],
  [id, "complexity-state", "current"],
  [id, "complexity-size", "S"],
  ...(id === 101 ? [[id, "owner", "someone-else"] as Datom] : []),
  ...(id === 104 ? [[id, "label", "project:priority"] as Datom] : []),
];
const input = {
  viewer: { role: "implementer", agent: "fixture-agent", platform: "", order: "impact" },
  datoms: [[1, "forward-complete", true] as Datom, ...[100, 101, 102, 103, 104].flatMap(subject)],
};
const baseline = evaluatePolicy(input);
const allowed = baseline.decisions.filter((d) => d.kind === "implement");
assert.deepEqual(
  allowed.map((d) => d.subject),
  [100, 104],
);
// The test-runner policy injection is trusted, not a safe project-file boundary:
// adding an OR alternative named eligible shadows its immutable intended meaning.
const unsafe = validateBundle({
  ...policy,
  clauses: policy.clauses.replace(/\]$/, " [(eligible ?t) (issue ?t) (open ?t)]]"),
});
const unsafeImplement = evaluatePolicy(input, { policy: unsafe })
  .decisions.filter((d) => d.kind === "implement")
  .map((d) => d.subject);
for (const id of [101, 102, 103]) assert.ok(unsafeImplement.includes(id));

const raw = readFileSync(new URL("../fixtures/project-priority.edn", import.meta.url), "utf8");
const native = printEdn(readOne(raw, "project-priority.edn"), "project-priority.edn");
const query = "[:find ?t ?score :in $ % :where (project-priority ?t ?score)]";
const rows = ds.q(
  query,
  ds.init_db(input.datoms, { label: { ":db/cardinality": ":db.cardinality/many" } }),
  native,
);
const scores = new Map(rows.map(([id, score]) => [Number(id), Number(score)]));
// Research-only boundary sketch: native output can order existing exact action
// identities; it cannot turn another action kind or denied issue into implement.
const byKey = new Map(allowed.map((d) => [`${d.subject}:${d.kind}`, d]));
const projectOutputs = [
  ...allowed.map((d) => ({ key: `${d.subject}:${d.kind}`, score: scores.get(d.subject) ?? 0 })),
  { key: "101:implement", score: 999 },
  { key: "102:implement", score: 999 },
  { key: "103:implement", score: 999 },
  { key: "100:merge", score: 999 },
];
const accepted = projectOutputs.filter((d) => byKey.has(d.key));
assert.deepEqual(
  accepted.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).map((d) => d.key),
  ["104:implement", "100:implement"],
);
const clauses = native.slice(1, -1);
const extended = { ...policy, clauses: policy.clauses.replace(/\]$/, ` ${clauses}]`) };
const english = compileEnglish(extended).predicates.find((p) => p.name === "project-priority")!;
assert.equal(
  conjunctionText(english.alternatives[0].clauses),
  '?t has label "project:priority" and ?score = 0 + 10',
);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
assert.equal(digest(native), digest(printEdn(readOne(`; comment\n${raw}`, "same"), "same")));
assert.notEqual(digest(native), digest(native.replace("10", "11")));
console.log(
  JSON.stringify(
    {
      baselineImplement: allowed.map((d) => d.subject),
      unsafeImplement,
      accepted: accepted.map((d) => d.key),
      english: conjunctionText(english.alternatives[0].clauses),
      canonicalHash: digest(native),
    },
    null,
    2,
  ),
);
