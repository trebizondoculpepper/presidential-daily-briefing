/**
 * #393: the CI test summary names every outcome and never reads a missing report as a pass.
 * Fixtures follow the exact shapes Vitest 5.1's junit reporter and the rules runner write.
 */
import { describe, expect, it } from "vite-plus/test";
import { junit } from "../rules/datalog/runner.js";
import { locate, parseJunit, summarize, tailOf, type StepRecord } from "./testreport.js";

const vitest = (cases: string, tests: number, failures = 0) =>
  `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="${tests}" failures="${failures}" errors="0" time="0.01">
    <testsuite name="src/workflow/claims.test.ts" timestamp="2026-11-15T05:27:24.806Z" hostname="h" tests="${tests}" failures="${failures}" errors="0" skipped="0" time="0.01">
${cases}
    </testsuite>
</testsuites>
`;
const passing = `        <testcase classname="src/workflow/claims.test.ts" name="claims &gt; ok" time="0.001">
        </testcase>`;
const failing = `        <testcase classname="src/workflow/claims.test.ts" name="claims &gt; deliberate | failure" time="0.002">
            <failure message="expected { a: 1 } to deeply equal { a: 2 }" type="AssertionError">
AssertionError: expected { a: 1 } to deeply equal { a: 2 }

- Expected
+ Received

  {
-   &quot;a&quot;: 2,
+   &quot;a&quot;: 1,
  }

 ❯ src/workflow/claims.test.ts:42:28
            </failure>
        </testcase>`;
const rules = junit([
  { name: "easy-win", file: "s.edn:1", status: "passed", message: "" },
] as never);
const step = (name: string, exitCode: number, tail = ""): StepRecord => ({
  step: name,
  command: ["npm", "run", name],
  exitCode,
  durationMs: 10,
  tail,
});
const run = (files: Record<string, string | null>, steps: StepRecord[]) =>
  summarize({
    platform: "ubuntu-latest",
    reports: new Map(Object.entries(files)),
    steps,
    link: (path, line) => `${path}${line ? `:${line}` : ""}`,
  });

describe("JUnit parsing (#393)", () => {
  it("reads Vitest's and the rules runner's reports, including failure detail", () => {
    const parsed = parseJunit(vitest(`${passing}\n${failing}`, 2, 1));
    expect(parsed).toMatchObject({ kind: "report", tests: 2 });
    const bad = parsed.kind === "report" ? parsed.cases[1]! : null;
    expect(bad).toMatchObject({
      outcome: "failure",
      name: "claims > deliberate | failure",
      message: "expected { a: 1 } to deeply equal { a: 2 }",
      file: "src/workflow/claims.test.ts",
    });
    expect(bad?.detail).toContain('-   "a": 2,');
    expect(locate(bad!)).toEqual({ path: "src/workflow/claims.test.ts", line: 42 });
    expect(parseJunit(rules)).toMatchObject({
      kind: "report",
      tests: 1,
      cases: [{ outcome: "passed", file: "s.edn:1" }],
    });
  });

  it("is malformed, never empty, when the document is truncated, inconsistent or not JUnit", () => {
    const whole = vitest(passing, 1);
    expect(parseJunit(whole.slice(0, whole.length - 20)).kind).toBe("malformed");
    expect(parseJunit(vitest(passing, 3)).kind).toBe("malformed");
    expect(parseJunit("<html></html>").kind).toBe("malformed");
    expect(parseJunit(vitest("", 0))).toMatchObject({ kind: "report", tests: 0 });
  });

  it("locates Windows frames and keeps a bounded tail", () => {
    expect(
      locate({
        suite: "s",
        file: null,
        name: "n",
        outcome: "failure",
        message: null,
        detail: " ❯ D:\\a\\repo\\src\\x.test.ts:7:3",
      }),
    ).toEqual({ path: "D:/a/repo/src/x.test.ts", line: 7 });
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n");
    expect(tailOf(long).split("\n")).toHaveLength(60);
    expect(tailOf(long).endsWith("line 99")).toBe(true);
  });
});

describe("job summary (#393)", () => {
  it("lists suites by path and each failing case with platform, location and diff", () => {
    const { markdown, problems } = run(
      { "junit-rules.xml": rules, "junit-tests.xml": vitest(`${passing}\n${failing}`, 2, 1) },
      [step("rules", 0), step("tests", 1)],
    );
    expect(problems).toEqual([]);
    expect(markdown).toContain("| application | 2 | 1 | 0 | 0 |");
    expect(markdown).toContain("| rule decisions | 1 | 0 | 0 | 0 |");
    expect(markdown).toContain("#### Failure: claims > deliberate \\| failure");
    expect(markdown).toContain("application · ubuntu-latest · src/workflow/claims.test.ts:42");
    expect(markdown).toContain('+   "a": 1,');
  });

  it("a passing step without its report is a reporting problem, never green", () => {
    const { markdown, problems } = run({ "junit-rules.xml": rules, "junit-tests.xml": null }, [
      step("rules", 0),
      step("tests", 0),
    ]);
    expect(problems).toEqual([
      expect.stringMatching(/junit-tests\.xml: the tests step passed but wrote no report/),
    ]);
    expect(markdown).toMatch(
      /\*\*Missing report\*\* `junit-tests.xml`: .*runner crash or reporter misconfiguration/,
    );
    expect(markdown).not.toContain("All recorded steps and reported tests passed");
  });

  it("distinguishes a step that failed or never ran from a crash, and a malformed report", () => {
    const failed = run({ "junit-rules.xml": null, "junit-tests.xml": "<testsuites" }, [
      step("rules", 2, "RuleInfrastructureError: boom"),
    ]);
    expect(failed.markdown).toMatch(
      /`junit-rules.xml`: the rules step failed \(exit 2\) without writing a report/,
    );
    expect(failed.markdown).toMatch(/\*\*Malformed report\*\* `junit-tests.xml`/);
    expect(failed.markdown).toContain("RuleInfrastructureError: boom");
    expect(failed.problems).toEqual([expect.stringMatching(/junit-tests\.xml is malformed/)]);
    const notRun = run({ "junit-rules.xml": null, "junit-tests.xml": null }, [
      step("check", 1, "lint error"),
    ]);
    expect(notRun.markdown).toMatch(/the rules step did not run \(an earlier step failed\)/);
    expect(notRun.markdown).toMatch(/#### `check` exited 1/);
    expect(notRun.problems).toEqual([]);
  });

  it("names a valid report with zero tests as such", () => {
    const { markdown, problems } = run(
      { "junit-rules.xml": rules, "junit-tests.xml": vitest("", 0) },
      [step("rules", 0), step("tests", 0)],
    );
    expect(problems).toEqual([]);
    expect(markdown).toContain("`junit-tests.xml` is a valid report with zero tests.");
  });

  it("bounds each failure and says when it truncated", () => {
    const huge = failing.replace("AssertionError:", `AssertionError:${"\nx".repeat(200)}`);
    const { markdown } = run({ "junit-rules.xml": rules, "junit-tests.xml": vitest(huge, 1, 1) }, [
      step("tests", 1),
    ]);
    expect(markdown).toContain("… Truncated due to maximum size");
    expect(markdown.split("\nx").length).toBeLessThan(60);
  });
});
