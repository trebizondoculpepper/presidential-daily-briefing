import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { buildPolicy, currentSources, serialize, artifactPath, PolicyBuildError } from "./build.js";
import { readOne, EdnSourceError } from "./edn.js";

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyBuildError) return error.problems;
    throw error;
  }
  return [];
};

describe("rules build (#348)", () => {
  it("accepts the current policy and the committed artifact is current", () => {
    const artifact = buildPolicy(currentSources());
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(JSON.parse(serialize(artifact)));
  });

  it("rejects a second top-level form that DataScript would silently ignore", () => {
    expect(() => readOne("[1] [2]", "x.edn")).toThrow(
      "expected exactly one top-level form, found 2",
    );
    expect(() => readOne("  ; only a comment\n", "x.edn")).toThrow("found 0");
  });

  it("locates unbalanced and unterminated sources", () => {
    const error = (() => {
      try {
        readOne('[\n  [(a ?t) [?t "kind" "issue"]\n', "rules.edn");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(EdnSourceError);
    expect((error as EdnSourceError).message).toBe("rules.edn:2:3: '[' is never closed");
    expect(() => readOne('[(str "a) ?r]', "q.edn")).toThrow("q.edn:1:7: unterminated string");
    expect(() => readOne("[(a ?t]]", "q.edn")).toThrow("q.edn:1:7: ']' does not close '('");
    expect(readOne('[(str "a ] \\" (") ?r] ; ) ]', "q.edn")).toBeTruthy();
  });

  it("reports every problem at once: unknown predicates, unbound explanations, duplicates", () => {
    const sources = currentSources();
    const [first, second] = sources.definitions;
    const problems = problemsOf(() =>
      buildPolicy({
        ...sources,
        definitions: [
          { ...first, clauses: "(no-such-predicate ?t)" },
          { ...second, id: first.id, why: "Missing {nothing}." },
          ...sources.definitions.slice(2),
        ],
        queries: { ...sources.queries, q2: "[:find ?t :where [?t" },
      }),
    );
    expect(problems.some((p) => p.endsWith("unknown rule 'no-such-predicate'"))).toBe(true);
    expect(problems.some((p) => p.includes("duplicate rule ID"))).toBe(true);
    expect(problems.some((p) => p.includes("{nothing} has no witness binding"))).toBe(true);
    expect(problems.some((p) => p.startsWith("queries.q2: queries.q2:1:"))).toBe(true);
  });

  it("rejects witnesses for rules that do not exist", () => {
    const sources = currentSources();
    const problems = problemsOf(() =>
      buildPolicy({ ...sources, witnessClauses: { ...sources.witnessClauses, "D-GONE": {} } }),
    );
    expect(problems).toEqual(["witnessClauses.D-GONE: no rule with this ID"]);
  });
});
