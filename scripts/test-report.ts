/**
 * Local reproduction of the CI test reports (#393): `npm run test:report` runs the rule-decision
 * and test suites through the same step wrapper and reporters as CI into `reports/`, then prints
 * the same summary. Exits non-zero if any suite failed. Runtime: Node (current LTS), tsx, npm.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("reports", { recursive: true, force: true });
const tsx = (args: string[]) =>
  spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), ...args], {
    stdio: "inherit",
  }).status ?? 1;
const steps = [
  ["rules", "--", "npm", "run", "rules:test", "--", "--junit", "reports/junit-rules.xml"],
  [
    "tests",
    "--",
    "npx",
    "vp",
    "test",
    "run",
    "--reporter=default",
    "--reporter=junit",
    "--outputFile.junit=reports/junit-tests.xml",
  ],
];
let failed = 0;
for (const step of steps) if (tsx(["scripts/ci-step.ts", ...step]) !== 0) failed++;
const summary = tsx(["scripts/test-summary.ts", "reports"]);
process.exit(failed || summary ? 1 : 0);
