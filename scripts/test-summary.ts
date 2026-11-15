/**
 * CI test summary (#393, doc/design/test-reporting.md): `tsx scripts/test-summary.ts [DIR]` reads
 * the JUnit reports and step records under DIR (default `reports`) and appends one bounded
 * Markdown summary to $GITHUB_STEP_SUMMARY, or prints it when that is unset. Exit 1 when a
 * required report is missing or malformed although its step passed (never green without a
 * report); exit 2 on a reporting error. Runtime: Node (current LTS) and tsx; all platforms.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { requiredReports, summarize, type StepRecord } from "../src/ci/testreport.js";

try {
  const dir = process.argv[2] ?? "reports";
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const reports = new Map(requiredReports.map((r) => [r.file, read(join(dir, r.file))]));
  const stepsDir = join(dir, "steps");
  const steps: StepRecord[] = existsSync(stepsDir)
    ? readdirSync(stepsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(stepsDir, f), "utf8")) as StepRecord)
    : [];
  const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  const link = (path: string, line: number | null) => {
    const rel = relative(root, resolve(root, path)).replaceAll("\\", "/");
    const label = `${rel}${line ? `:${line}` : ""}`;
    return server && repo && sha && !rel.startsWith("..")
      ? `[${label}](${server}/${repo}/blob/${sha}/${rel}${line ? `#L${line}` : ""})`
      : label;
  };
  const platform = process.env.PDB_PLATFORM ?? process.platform;
  const { markdown, problems } = summarize({ platform, reports, steps, link });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
  for (const p of problems) process.stderr.write(`Reporting problem: ${p}\n`);
  process.exit(problems.length ? 1 : 0);
} catch (error) {
  process.stderr.write(
    `Reporting error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
