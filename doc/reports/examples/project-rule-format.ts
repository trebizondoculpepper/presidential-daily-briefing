// #513 native syntax/binding fixture, not the production loader or a security proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ds from "datascript";
import { readOne, printEdn } from "../../../src/rules/datalog/edn.js";
import { definedRules, ruleCalls } from "../../../src/rules/datalog/build.js";
const raw = readFileSync(new URL("../fixtures/project-rules-v1.edn", import.meta.url), "utf8");
const form = readOne(raw, "project-rules-v1.edn") as { map: [{ key: string }, unknown][] };
const fields = new Map(form.map.map(([k, v]) => [k.key, v]));
assert.deepEqual(
  [...fields.keys()],
  [
    "format-version",
    "projection-version",
    "base-policy-version",
    "base-rules-hash",
    "rules",
    "preferences",
  ],
);
assert.equal(fields.get("format-version"), 1);
assert.match(String(fields.get("base-rules-hash")), /^[0-9a-f]{64}$/);
const rules = fields.get("rules");
assert.deepEqual([...definedRules(rules)], ["project-hotfix"]);
assert.equal(definedRules(rules).has("eligible"), false);
const preference = (fields.get("preferences") as { map: [{ key: string }, unknown][] }[])[0];
const prefs = new Map(preference.map.map(([k, v]) => [k.key, v]));
assert.deepEqual(ruleCalls(prefs.get("when") as unknown[]), ["project-hotfix"]);
const clauses = (f: unknown) => printEdn(f, "fixture").slice(1, -1);
const db = ds.init_db([
  [100, "pdb.action-id", "allowed:implement"],
  [100, "pdb.action-label", "project:priority"],
  [101, "pdb.action-id", "another:estimate"],
]);
const query = `[:find ?a ?value :in $ % :where [?a "pdb.action-id" _] ${clauses(prefs.get("when"))} ${clauses(prefs.get("priority"))}]`;
assert.deepEqual(ds.q(query, db, printEdn(rules, "rules")), [[100, 10]]);
// No preference is inferred for an admitted action without the matching label.
assert.equal(
  ds.q(query, db, printEdn(rules, "rules")).some(([id]) => id === 101),
  false,
);
console.log(
  "Passed native v1 format fixture: source metadata, helper call, generated admitted-action query and derived integer priority.",
);
