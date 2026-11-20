/**
 * Manual, local-only profile for doc/reports/slow-test-redundancy.md (#706): where one native
 * policy evaluation spends its time, by datascript call. Wraps the shared datascript module in
 * this process only; no product code changes. Not part of the test suite.
 *
 * Run: npx tsx doc/reports/examples/slow-tests/query-profile.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ds from "datascript";
import { buildPolicy } from "../../../../src/rules/datalog/build.js";
import { evaluatePolicy } from "../../../../src/rules/datalog/engine.js";
import { readScenarios, scenarioDir } from "../../../../src/rules/datalog/runner.js";

const stats = new Map<string, { calls: number; ms: number }>();
const wrap = (name: string) => {
  const orig = (ds as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
  (ds as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    const t = performance.now();
    try {
      return orig(...args);
    } finally {
      const key = name === "q" ? `q ${String(args[0]).replace(/\s+/g, " ").slice(0, 70)}` : name;
      const s = stats.get(key) ?? { calls: 0, ms: 0 };
      s.calls++;
      s.ms += performance.now() - t;
      stats.set(key, s);
    }
  };
};
wrap("q");
wrap("init_db");
const policy = buildPolicy();
const scenarios = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".edn"))
  .sort()
  .flatMap((f) => readScenarios(readFileSync(join(scenarioDir, f), "utf8"), f));
// buildPolicy's own validation queries ran through the wrappers: measure evaluations only.
stats.clear();
const start = performance.now();
for (const s of scenarios) evaluatePolicy({ viewer: s.viewer, datoms: s.datoms }, { policy });
const total = performance.now() - start;
console.log(`${scenarios.length} evaluations, ${(total / 1000).toFixed(1)} s total`);
for (const [k, v] of [...stats].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15))
  console.log(
    `${((100 * v.ms) / total).toFixed(1).padStart(5)}% ${String(v.calls).padStart(5)} calls ${(v.ms / 1000).toFixed(1).padStart(6)} s  ${k}`,
  );
