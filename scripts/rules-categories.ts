/**
 * `tsx scripts/rules-categories.ts [REPORT_DIR]` (#394): the CI demonstration that rule
 * outcomes are categorized correctly. It calls the real rules runner (`main` of
 * src/rules/datalog/runner.ts, with the real filesystem) on the deliberately broken inputs in
 * src/rules/datalog/category-demo/, writes their JUnit under REPORT_DIR (default
 * reports/rules-categories, uploaded with the other reports but never read by the test
 * summary as a real suite), appends a table to $GITHUB_STEP_SUMMARY (or prints it), and exits 1
 * only when a case lands in the wrong category. Runtime: Node (current LTS) and tsx; all
 * platforms.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { categoriesMarkdown, categoryCases, judge } from "../src/ci/rulecategories.js";
import { main, runAll } from "../src/rules/datalog/runner.js";

const reportDir = process.argv[2] ?? "reports/rules-categories";
rmSync(reportDir, { recursive: true, force: true });
mkdirSync(reportDir, { recursive: true });

const verdicts = categoryCases(reportDir).map((c) => {
  let stderr = "";
  const code = main(["--scenarios", c.scenarios, ...(c.junit ? ["--junit", c.junit] : [])], {
    run: () => runAll(),
    out: () => {},
    err: (text) => void (stderr += text),
    writeFile: (path, text) => writeFileSync(path, text),
  });
  const junit = c.junit && existsSync(c.junit) ? readFileSync(c.junit, "utf8") : null;
  return judge(c, { code, stderr, junit });
});

const markdown = categoriesMarkdown(process.env.PDB_PLATFORM ?? process.platform, verdicts);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
process.stdout.write(markdown);
process.exitCode = verdicts.every((v) => v.ok) ? 0 : 1;
