/**
 * Rule-outcome category demonstration (#394, doc/design/test-reporting.md): runs the real
 * rules runner against deliberately broken inputs and checks that each lands in the right
 * category: a wrong decision is a JUnit `<failure type="RuleDecisionFailure">` with exit 1;
 * malformed EDN, an unloadable scenario directory and an unwritable report are
 * `RuleInfrastructureError` with exit 2. The demonstration passes only when every case is
 * categorized as expected, so CI stays green while proving the categories never mix.
 */

export interface CategoryCase {
  id: string;
  title: string;
  /** Scenario directory passed with --scenarios. */
  scenarios: string;
  /** Where the runner is asked to write JUnit; null for none. */
  junit: string | null;
  expectExit: 1 | 2;
  /** The JUnit element and type expected in the report, or null when no report may exist. */
  expectElement: { element: "failure" | "error"; type: string } | null;
  /** Text the runner must print on stderr (for a fault that leaves no report). */
  expectStderr?: string;
}

const demo = "src/rules/datalog/category-demo";

/** The four demonstration cases; `reportDir` holds their JUnit output. */
export function categoryCases(reportDir: string): CategoryCase[] {
  return [
    {
      id: "wrong-decision",
      title: "Intentional wrong decision (valid EDN, wrong expectation)",
      scenarios: `${demo}/wrong-decision`,
      junit: `${reportDir}/wrong-decision.xml`,
      expectExit: 1,
      expectElement: { element: "failure", type: "RuleDecisionFailure" },
    },
    {
      id: "malformed-edn",
      title: "Malformed EDN scenario (unclosed map)",
      scenarios: `${demo}/malformed`,
      junit: `${reportDir}/malformed-edn.xml`,
      expectExit: 2,
      expectElement: { element: "error", type: "RuleInfrastructureError" },
    },
    {
      id: "runner-cannot-load",
      title: "Runner cannot load its scenarios (missing directory)",
      scenarios: `${demo}/does-not-exist`,
      junit: `${reportDir}/runner-cannot-load.xml`,
      expectExit: 2,
      expectElement: { element: "error", type: "RuleInfrastructureError" },
    },
    {
      id: "runner-cannot-report",
      title: "Runner cannot write its JUnit report",
      scenarios: `${demo}/wrong-decision`,
      junit: `${reportDir}/no-such-directory/report.xml`,
      expectExit: 2,
      expectElement: null,
      expectStderr: "RuleInfrastructureError: could not write the JUnit report",
    },
  ];
}

export interface CaseRun {
  code: number;
  stderr: string;
  /** The JUnit the run left behind, or null when none exists. */
  junit: string | null;
}

export interface CaseVerdict {
  id: string;
  title: string;
  ok: boolean;
  observed: string;
  problems: string[];
}

const elements = (xml: string) =>
  [...xml.matchAll(/<(failure|error) type="([^"]*)"/g)].map((m) => ({
    element: m[1] as "failure" | "error",
    type: m[2]!,
  }));

/** Whether one run was categorized as the case expects. Pure. */
export function judge(c: CategoryCase, run: CaseRun): CaseVerdict {
  const problems: string[] = [];
  if (run.code !== c.expectExit) problems.push(`exit ${run.code}, expected ${c.expectExit}`);
  const found = run.junit === null ? [] : elements(run.junit);
  if (c.expectElement) {
    if (run.junit === null) problems.push("no JUnit report was written");
    else {
      const want = c.expectElement;
      if (!found.some((f) => f.element === want.element && f.type === want.type))
        problems.push(`no \`<${want.element} type="${want.type}">\` in the report`);
      // The categories must never mix: nothing of the other kind may appear.
      const other = found.filter((f) => f.element !== want.element || f.type !== want.type);
      if (other.length)
        problems.push(
          `also reported ${other.map((o) => `\`<${o.element} type="${o.type}">\``).join(", ")}`,
        );
    }
  } else if (run.junit !== null) problems.push("a report exists although writing it must fail");
  if (c.expectStderr && !run.stderr.includes(c.expectStderr))
    problems.push(`stderr lacks "${c.expectStderr}"`);
  const observed = `exit ${run.code}; ${
    run.junit === null
      ? "no report"
      : found.length
        ? found.map((f) => `\`<${f.element} type="${f.type}">\``).join(", ")
        : "report with no failure or error"
  }`;
  return { id: c.id, title: c.title, ok: problems.length === 0, observed, problems };
}

/** The step-summary table. */
export function categoriesMarkdown(platform: string, verdicts: CaseVerdict[]): string {
  const ok = verdicts.every((v) => v.ok);
  const rows = verdicts.map(
    (v) =>
      `| ${v.title} | ${v.observed} | ${v.ok ? "categorized correctly" : `**WRONG**: ${v.problems.join("; ")}`} |`,
  );
  return [
    `### Rule outcome categories (${platform})`,
    "",
    "Deliberately broken inputs run through the real rules runner. These are demonstrations, not production failures: the step fails only if a case lands in the wrong category.",
    "",
    "| Case | Observed | Verdict |",
    "| --- | --- | --- |",
    ...rows,
    "",
    ok
      ? "All categories are distinct: a wrong decision is a `RuleDecisionFailure` (exit 1); malformed sources and runner faults are `RuleInfrastructureError` (exit 2)."
      : "**A category is wrong**: rule failures and infrastructure errors are not reliably distinguished.",
    "",
  ].join("\n");
}
