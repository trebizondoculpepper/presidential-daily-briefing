/**
 * #336 example: native EDN rule scenarios executed through Vitest against the real evaluator.
 * See doc/reports/rule-testing-recommendation.md.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  check,
  evaluate,
  loadScenarios,
  RuleDecisionFailure,
  RuleInfrastructureError,
} from "./runner.js";

const file = "doc/reports/examples/rule-testing/scenarios.edn";
const scenarios = loadScenarios(
  readFileSync(new URL("./scenarios.edn", import.meta.url), "utf8"),
  file,
);

describe("native EDN rule scenarios", () => {
  for (const s of scenarios) it(`${s.id} (${s.where.file}:${s.where.line})`, () => check(s));
});

describe("outcome categories", () => {
  it("a wrong expectation is a rule failure that names the scenario and reports every mismatch", () => {
    const [s] = loadScenarios(
      `{:scenarios [{:id :wrong
        :given {:role :implementer :issues [{:n 1 :impact "L" :complexity "S"}]}
        :expect {:actions [{:n 1 :kind :implement :rule "D-ORDINARY" :band 6}] :denials #{[1 "D-DENY-CLAIM"]}}}]}`,
      "inline.edn",
    );
    const error = (() => {
      try {
        check(s);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(RuleDecisionFailure);
    expect((error as RuleDecisionFailure).where).toEqual({
      file: "inline.edn",
      line: 1,
      scenario: "wrong",
    });
    expect((error as RuleDecisionFailure).mismatches).toHaveLength(2); // actions and denials
  });

  it("unreadable EDN and an invalid scenario are infrastructure errors, never rule failures", () => {
    expect(() => loadScenarios("{:scenarios [{:id :x", "broken.edn")).toThrow(
      RuleInfrastructureError,
    );
    expect(() =>
      loadScenarios(
        `{:scenarios [{:id :x :given {:role :reviewer :issues []} :expect {:actions []}}]}`,
        "role.edn",
      ),
    ).toThrow(/unsupported :role reviewer/);
    expect(() =>
      loadScenarios(
        `{:scenarios [{:id :x :given {:role :implementer} :expect {:actions []}}
                      {:id :x :given {:role :implementer} :expect {:actions []}}]}`,
        "dup.edn",
      ),
    ).toThrow(/duplicate scenario :id/);
  });

  it("reports the line of the failing scenario, not of the file", () => {
    const parsed = loadScenarios(
      "{:scenarios [\n\n {:id :third-line\n :given {:role :implementer} :expect {:actions []}}]}",
      "lines.edn",
    );
    expect(parsed[0].where.line).toBe(3);
  });
});

describe("metamorphic property", () => {
  // Adding an unrelated parked ticket (no attention, no dependencies) must not change any other
  // subject's decisions: a cheap check that rules do not leak across subjects.
  for (const s of scenarios)
    it(`${s.id}: an unrelated parked ticket changes nothing else`, () => {
      const others = (issues = s.issues) =>
        evaluate(s, issues)
          .items.filter((x) => !x.target.endsWith("/999"))
          .map((x) => [x.target, x.kind, x.ruleIds[0], x.band]);
      const extra = {
        n: 999,
        labels: ["status:parked"],
        labelsComplete: true,
        impact: "M",
        complexity: "M",
        blocks: [],
      };
      expect(others([...s.issues, extra])).toEqual(others());
    });
});
