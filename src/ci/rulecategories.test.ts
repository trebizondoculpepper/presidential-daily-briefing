/**
 * Rule-outcome category demonstration (#394): the judge rejects every miscategorization, and the
 * real runner categorizes each deliberately broken input correctly.
 */
import { describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main, runAll, scenarioDir } from "../rules/datalog/runner.js";
import { categoriesMarkdown, categoryCases, judge } from "./rulecategories.js";

const failure = '<failure type="RuleDecisionFailure" message="x">x</failure>';
const error = '<error type="RuleInfrastructureError" message="x">x</error>';
const [wrong, malformed, , report] = categoryCases("r");

describe("rule category judge (#394)", () => {
  it("accepts correct categories", () => {
    expect(judge(wrong!, { code: 1, stderr: "", junit: failure }).ok).toBe(true);
    expect(judge(malformed!, { code: 2, stderr: "", junit: error }).ok).toBe(true);
    expect(
      judge(report!, {
        code: 2,
        stderr: "RuleInfrastructureError: could not write the JUnit report to r: ENOENT",
        junit: null,
      }).ok,
    ).toBe(true);
  });

  it("rejects a wrong decision disguised as an infrastructure error, and the reverse", () => {
    const disguised = judge(wrong!, { code: 2, stderr: "", junit: error });
    expect(disguised.ok).toBe(false);
    expect(disguised.problems.join("; ")).toContain("exit 2, expected 1");
    expect(judge(malformed!, { code: 1, stderr: "", junit: failure }).ok).toBe(false);
  });

  it("rejects mixed categories, a missing report and a report that should not exist", () => {
    const mixed = judge(wrong!, { code: 1, stderr: "", junit: failure + error });
    expect(mixed.ok).toBe(false);
    expect(mixed.problems.join("; ")).toContain("also reported");
    expect(judge(wrong!, { code: 1, stderr: "", junit: null }).problems).toContain(
      "no JUnit report was written",
    );
    expect(
      judge(report!, {
        code: 2,
        stderr: "RuleInfrastructureError: could not write the JUnit report",
        junit: "<x/>",
      }).ok,
    ).toBe(false);
    expect(judge(report!, { code: 2, stderr: "", junit: null }).ok).toBe(false);
  });

  it("renders a visible table whose element names survive Markdown sanitization", () => {
    const md = categoriesMarkdown("linux", [
      judge(wrong!, { code: 1, stderr: "", junit: failure }),
    ]);
    expect(md).toContain('`<failure type="RuleDecisionFailure">`');
    expect(md).toContain("categorized correctly");
    const bad = categoriesMarkdown("linux", [judge(wrong!, { code: 2, stderr: "", junit: error })]);
    expect(bad).toContain("**WRONG**");
  });
});

describe("rule category demonstration with the real runner (#394)", () => {
  it("categorizes every deliberately broken input correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdb-rule-categories-"));
    try {
      const verdicts = categoryCases(dir).map((c) => {
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
      expect(verdicts.filter((v) => !v.ok)).toEqual([]);
      expect(verdicts).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Structural, not a second full run: rules.test.ts already evaluates every production scenario
  // once, and repeating that here (~3 s idle) timed out at 20 s under a loaded suite.
  it("keeps the demonstration inputs out of the production scenarios", () => {
    for (const c of categoryCases("r"))
      expect(resolve(c.scenarios).startsWith(resolve(scenarioDir))).toBe(false);
    expect(readdirSync(scenarioDir).some((f) => /category|demo|malformed/.test(f))).toBe(false);
  });
});
