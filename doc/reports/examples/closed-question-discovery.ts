// Synthetic design counterexamples for #491, not a production discovery service.
import assert from "node:assert/strict";
const sources = [
  { id: 1, labels: ["question"], questions: ["Q1"], closed: true },
  { id: 2, labels: [], questions: ["Q2", "Q3"], closed: true },
];
const labelCandidates = sources.filter((s) => s.labels.includes("question"));
assert.equal(
  labelCandidates.some((s) => s.id === 2),
  false,
);
assert.equal(sources.flatMap((s) => s.questions).length, 3);
// A newer question does not resolve an older independent operation.
const resolved = new Set(["2:Q3"]);
const remaining = sources.flatMap((s) =>
  s.questions.filter((q) => !resolved.has(`${s.id}:${q}`)).map((q) => `${s.id}:${q}`),
);
assert.deepEqual(remaining, ["1:Q1", "2:Q2"]);
// Closure and arbitrary responses do not occur in explicit resolution membership.
assert.equal(remaining.includes("2:Q2"), true);
// A bounded prefix with no question is not an exhaustive absence result.
const inventory = [{ id: 0, questions: [] }, ...sources];
const prefix = inventory.slice(0, 1);
const complete = prefix.length === inventory.length;
assert.equal(prefix.flatMap((s) => s.questions).length, 0);
assert.equal(complete, false);
// A new unresolved operation and a legacy operation can both have no resolution;
// the format discriminator, not absence of a resolution, distinguishes semantics.
const old = { version: 1, labels: [], resolution: null };
const fresh = { version: 2, labels: [], resolution: null };
assert.equal(old.resolution, fresh.resolution);
assert.notEqual(old.version, fresh.version);
console.log(
  "Passed: label-only, newest-only, prefix-absence and version-discriminator counterexamples.",
);
