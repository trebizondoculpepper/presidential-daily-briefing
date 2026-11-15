/**
 * Structured test reports in CI (#393, doc/design/test-reporting.md): read the JUnit files and
 * step records under `reports/`, and render one bounded Markdown summary that names every
 * outcome (assertion failure, error, valid zero tests, missing or malformed report, failed step
 * without JUnit). Pure apart from the injected file reads; never decides that a run passed.
 */

/** What `scripts/ci-step.ts` records for one wrapped command. */
export interface StepRecord {
  step: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  /** The last lines of combined output, bounded. */
  tail: string;
}

export interface TestCase {
  suite: string;
  file: string | null;
  name: string;
  outcome: "passed" | "failure" | "error" | "skipped";
  message: string | null;
  detail: string | null;
}

export type ParsedReport =
  | { kind: "report"; tests: number; cases: TestCase[] }
  | { kind: "malformed"; why: string };

const entities: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};
export const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
      );
    return entities[e] ?? whole;
  });

const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]!] = decodeXml(m[2]!);
  return out;
};

/**
 * Parse the JUnit subset Vitest and the rules runner write: `<testsuites>`/`<testsuite>` with
 * `<testcase>` elements, self-closing or holding one `<failure>`, `<error>` or `<skipped>`.
 * Anything else that cannot be read consistently is malformed, never "no failures".
 */
export function parseJunit(xml: string): ParsedReport {
  if (!/<testsuites?[\s>]/.test(xml)) return { kind: "malformed", why: "no <testsuite> element" };
  if (!/<\/testsuites?>\s*$/.test(xml.trim()))
    return { kind: "malformed", why: "the document is truncated (no closing element)" };
  const cases: TestCase[] = [];
  let declared = 0;
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const sAttr = attributes(suite[1]!);
    const tests = Number(sAttr.tests ?? "NaN");
    if (!Number.isInteger(tests) || tests < 0)
      return { kind: "malformed", why: `suite ${sAttr.name ?? "?"} has no valid tests count` };
    declared += tests;
    const body = suite[2]!;
    const before = cases.length;
    for (const c of body.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attributes(c[1]!);
      const inner = c[3] ?? "";
      const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
      const skipped = /<skipped\b/.test(inner);
      // An outcome element that cannot be read whole is corruption, never a pass.
      if (!fail && /<(failure|error)\b/.test(inner))
        return {
          kind: "malformed",
          why: `test case ${a.name ?? "?"} has an unreadable failure or error element`,
        };
      const fa = fail ? attributes(fail[2]!) : {};
      cases.push({
        suite: sAttr.name ?? "",
        file: a.file ?? (a.classname && /[\\/].*\.\w+$/.test(a.classname) ? a.classname : null),
        name: a.name ?? "",
        outcome: fail ? (fail[1] as "failure" | "error") : skipped ? "skipped" : "passed",
        message: fail ? (fa.message ?? null) : null,
        detail: fail ? decodeXml(fail[3] ?? "").trim() || null : null,
      });
    }
    // Declared failure and error counts must match the parsed cases, so no failure can hide.
    const mine = cases.slice(before);
    for (const kind of ["failure", "error"] as const) {
      const attr = sAttr[kind === "failure" ? "failures" : "errors"];
      const found = mine.filter((c) => c.outcome === kind).length;
      if (attr !== undefined && Number(attr) !== found)
        return {
          kind: "malformed",
          why: `suite ${sAttr.name ?? "?"} declares ${attr} ${kind === "failure" ? "failures" : "errors"} but contains ${found}`,
        };
    }
  }
  if (cases.length !== declared)
    return {
      kind: "malformed",
      why: `declares ${declared} tests but contains ${cases.length} test cases`,
    };
  return { kind: "report", tests: declared, cases };
}

/** A required report and the step that must produce it. */
export interface RequiredReport {
  suite: string;
  file: string;
  step: string;
}
export const requiredReports: RequiredReport[] = [
  { suite: "rule decisions", file: "junit-rules.xml", step: "rules" },
  { suite: "tests", file: "junit-tests.xml", step: "tests" },
];

/** The suite a Vitest case belongs to, by path: one run, three named suites (doc). */
export const suiteOf = (c: TestCase): string => {
  const path = (c.file ?? c.suite).replaceAll("\\", "/");
  if (c.suite === "rules.datalog") return "rule decisions";
  if (path.includes("src/acceptance/")) return "integration";
  if (path.includes("src/rules/")) return "rule engine";
  return "application";
};

export type ReportState =
  | { state: "read"; report: Extract<ParsedReport, { kind: "report" }> }
  | { state: "malformed"; why: string }
  | { state: "missing"; why: string };

export interface SummaryInput {
  platform: string;
  reports: Map<string, string | null>;
  steps: StepRecord[];
  /** Source link for a path and line, or null when no repository context is known. */
  link: (path: string, line: number | null) => string | null;
}

export interface Summary {
  markdown: string;
  /** Reporting integrity problems: a required report missing or malformed after a passing step. */
  problems: string[];
}

const MAX_CASE_CHARS = 4000;
const MAX_CASE_LINES = 40;
const MAX_TOTAL_CHARS = 200_000;
const MAX_FAILED_CASES = 60;

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const bounded = (text: string): string => {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_CASE_LINES).join("\n");
  if (out.length > MAX_CASE_CHARS) out = out.slice(0, MAX_CASE_CHARS);
  return out.length < text.length ? `${out}\n… Truncated due to maximum size` : out;
};
const fence = (text: string) => `~~~~text\n${text.replaceAll("~~~~", "~~~ ~")}\n~~~~`;

/** Where a failure points: the first `path:line` frame, else the test file. */
export function locate(c: TestCase): { path: string; line: number | null } | null {
  const frame = /(?:❯|at)\s+\(?((?:[A-Za-z]:)?[^\s():]+\.\w+):(\d+)(?::\d+)?/.exec(c.detail ?? "");
  if (frame) return { path: frame[1]!.replaceAll("\\", "/"), line: Number(frame[2]) };
  return c.file ? { path: c.file.replaceAll("\\", "/"), line: null } : null;
}

/** The Markdown summary for one job, and any reporting integrity problems. */
export function summarize(input: SummaryInput): Summary {
  const problems: string[] = [];
  const stepOf = new Map(input.steps.map((s) => [s.step, s]));
  const states = new Map<string, ReportState>();
  for (const r of requiredReports) {
    const text = input.reports.get(r.file) ?? null;
    const step = stepOf.get(r.step);
    if (text === null) {
      const why = !step
        ? `the ${r.step} step did not run (an earlier step failed)`
        : step.exitCode === 0
          ? `the ${r.step} step passed but wrote no report (runner crash or reporter misconfiguration)`
          : `the ${r.step} step failed (exit ${step.exitCode}) without writing a report`;
      states.set(r.file, { state: "missing", why });
      if (step?.exitCode === 0) problems.push(`${r.file}: ${why}`);
      continue;
    }
    const parsed = parseJunit(text);
    if (parsed.kind === "malformed") {
      states.set(r.file, { state: "malformed", why: parsed.why });
      problems.push(`${r.file} is malformed: ${parsed.why}`);
    } else states.set(r.file, { state: "read", report: parsed });
  }

  const lines: string[] = [`## Test report: ${input.platform}`, ""];
  const cases = [...states.values()].flatMap((s) => (s.state === "read" ? s.report.cases : []));
  const bySuite = new Map<string, TestCase[]>();
  for (const c of cases) bySuite.set(suiteOf(c), [...(bySuite.get(suiteOf(c)) ?? []), c]);
  lines.push(
    "| Suite | Tests | Failures | Errors | Skipped |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const [suite, list] of [...bySuite].sort(([a], [b]) => a.localeCompare(b))) {
    const n = (o: TestCase["outcome"]) => list.filter((c) => c.outcome === o).length;
    lines.push(
      `| ${cell(suite)} | ${list.length} | ${n("failure")} | ${n("error")} | ${n("skipped")} |`,
    );
  }
  for (const r of requiredReports) {
    const s = states.get(r.file)!;
    if (s.state === "read" && s.report.tests === 0) lines.push(`| ${r.suite} | 0 | 0 | 0 | 0 |`);
  }
  lines.push("");
  for (const r of requiredReports) {
    const s = states.get(r.file)!;
    if (s.state === "missing") lines.push(`- **Missing report** \`${r.file}\`: ${s.why}.`);
    if (s.state === "malformed") lines.push(`- **Malformed report** \`${r.file}\`: ${s.why}.`);
    if (s.state === "read" && s.report.tests === 0)
      lines.push(`- \`${r.file}\` is a valid report with zero tests.`);
  }

  const failed = cases.filter((c) => c.outcome === "failure" || c.outcome === "error");
  if (failed.length) {
    lines.push("", `### Failing tests (${failed.length})`, "");
    for (const c of failed.slice(0, MAX_FAILED_CASES)) {
      const at = locate(c);
      const where = at
        ? (input.link(at.path, at.line) ?? `${at.path}${at.line ? `:${at.line}` : ""}`)
        : null;
      lines.push(
        `#### ${c.outcome === "error" ? "Error" : "Failure"}: ${cell(c.name)}`,
        "",
        `${suiteOf(c)} · ${input.platform}${where ? ` · ${where}` : ""}`,
        "",
        fence(bounded([c.message, c.detail].filter(Boolean).join("\n\n") || "(no message)")),
        "",
      );
    }
    if (failed.length > MAX_FAILED_CASES)
      lines.push(
        `… ${failed.length - MAX_FAILED_CASES} more failing tests; see the uploaded reports.`,
      );
  }

  const failedSteps = input.steps.filter((s) => s.exitCode !== 0);
  if (failedSteps.length) {
    lines.push("", "### Failed steps", "");
    for (const s of failedSteps)
      lines.push(
        `#### \`${s.step}\` exited ${s.exitCode}`,
        "",
        `\`${cell(s.command.join(" "))}\``,
        "",
        fence(bounded(s.tail || "(no output)")),
        "",
      );
  }
  if (!failed.length && !failedSteps.length && !problems.length)
    lines.push("All recorded steps and reported tests passed.");

  let markdown = lines.join("\n") + "\n";
  if (markdown.length > MAX_TOTAL_CHARS)
    markdown = `${markdown.slice(0, MAX_TOTAL_CHARS)}\n\nTruncated due to maximum size; see the uploaded reports.\n`;
  return { markdown, problems };
}

/** The bounded tail kept in a step record: at most 60 lines and 8 KB. */
export function tailOf(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").trimEnd().split("\n").slice(-60).join("\n");
  return lines.length > 8192 ? lines.slice(-8192) : lines;
}
