import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPolicy,
  readSources,
  validateBundle,
  serialize,
  artifactPath,
  policyDir,
  PolicyBuildError,
  queryInputs,
  overrideProblems,
} from "./build.js";
import { readOne, printEdn, EdnSourceError } from "./edn.js";

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyBuildError) return error.problems;
    throw error;
  }
  return [];
};
const source = (file: string) => readFileSync(join(policyDir, file), "utf8");
/** Reads the real sources with one file's text replaced. */
const editing =
  (file: string, edit: (text: string) => string) =>
  (name: string): string =>
    name === file ? edit(source(name)) : source(name);

describe("rules build (#348)", () => {
  it("builds the EDN sources and the committed artifact is current", () => {
    const artifact = buildPolicy();
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(JSON.parse(serialize(artifact)));
    // 30 agent decisions (seven for retained claims/inventory, #413) plus eight human decisions (#457, #414)
    // plus the released-unowned adoption decision (#1018).
    expect(artifact.definitions).toHaveLength(64);
  });

  it("rejects a second top-level form that DataScript would silently ignore", () => {
    expect(() => readOne("[1] [2]", "x.edn")).toThrow(
      "expected exactly one top-level form, found 2",
    );
    expect(() => readOne("  ; only a comment\n", "x.edn")).toThrow("found 0");
    expect(
      problemsOf(() => readSources(editing("rules.edn", (t) => `${t}\n[(extra ?t)]\n`))),
    ).toEqual(["policy/rules.edn:1:1: expected exactly one top-level form, found 2"]);
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

  it("prints canonical EDN and refuses values it cannot represent faithfully", () => {
    expect(
      printEdn(readOne('[:find ?t :where [?t "kind" _] (not [?t "x" 1])] ; c', "q"), "q"),
    ).toBe('[:find ?t :where [?t "kind" _] (not [?t "x" 1])]');
    expect(() => printEdn(readOne('[#inst "2026-01-01"]', "q"), "q")).toThrow(
      "unsupported EDN value",
    );
    expect(() => printEdn(readOne("[1.5]", "q"), "q")).toThrow("unsupported number");
  });

  it("rejects unknown and missing keys instead of ignoring a typo", () => {
    expect(
      problemsOf(() =>
        readSources(editing("decisions.edn", (t) => t.replace("\n   :why", "\n   :wyh"))),
      ),
    ).toEqual(["policy/decisions.edn :decisions[0]: unknown key :wyh"]);
    expect(
      problemsOf(() =>
        readSources(editing("schema.edn", (t) => t.replace(":policy-version 1", ""))),
      ),
    ).toEqual(["policy/schema.edn: missing :policy-version"]);
  });

  it("reports every validation problem at once", () => {
    const bundle = readSources();
    const [first, second] = bundle.definitions;
    const problems = problemsOf(() =>
      validateBundle({
        ...bundle,
        definitions: [
          { ...first, query: "[:find ?t :in $ % :where (no-such-predicate ?t)]" },
          { ...second, id: first.id, why: "Missing {nothing}." },
          ...bundle.definitions.slice(2),
        ],
        denials: { ...bundle.denials, "D-DENY-GONE": "No rule derives this." },
        queries: { ...bundle.queries, q2: "[:find ?t :where [?t" },
      }),
    );
    expect(problems).toEqual([
      "queries.edn :q2: queries.edn :q2:1:18: '[' is never closed",
      "decisions.edn D-ATTENTION (position 0) :when: unknown rule 'no-such-predicate'",
      "decisions.edn D-ATTENTION (position 1): duplicate rule ID",
      "decisions.edn D-ATTENTION (position 1): why placeholder {nothing} has no witness binding",
      "decisions.edn :denials: D-DENY-GONE is never derived by rules.edn",
    ]);
  });

  it("requires every derived denial to be documented", () => {
    const bundle = readSources();
    const { "D-DENY-BLOCKER": _, ...denials } = bundle.denials;
    expect(problemsOf(() => validateBundle({ ...bundle, denials }))).toEqual([
      "decisions.edn :denials: D-DENY-BLOCKER is derived but undocumented",
      "decisions.edn :denial-purposes: unknown denial ID D-DENY-BLOCKER",
    ]);
  });

  it("reads query inputs from the parsed :in clause, whatever the whitespace or comments", () => {
    const inputs = (q: string) => queryInputs(readOne(q, "q.edn"));
    expect(inputs("[:find ?t :in $ % :where [?t _ _]]")).toEqual(["$", "%"]);
    expect(inputs("[:find ?t :in  $\t%\n  ?t :where [?t _ _]]")).toEqual(["$", "%", "?t"]);
    expect(inputs("[:find ?t :in $ ; the database\n % ; the rules\n :where [?t _ _]]")).toEqual([
      "$",
      "%",
    ]);
    expect(inputs("[:find ?t :where [?t _ _]]")).toEqual(["$"]);
    expect(inputs("{:find [?t] :in [$ %] :where [[?t _ _]]}")).toEqual(["$", "%"]);
    expect(inputs("[:find ?t :in $ [[?w ?l]] :where [?t _ ?w]]")).toEqual(["$", "[[?w ?l]]"]);
  });

  it("builds sources whose :in spans lines and comments, to the same artifact", () => {
    // Rewrite the queries only, not the header comment that mentions ":in $ %".
    const spaced = editing("queries.edn", (t) =>
      t
        .split("\n")
        .map((line) =>
          line.startsWith(";;")
            ? line
            : line.replaceAll(":in $ %", ":in\n  $ ; database\n  %  ; rules\n "),
        )
        .join("\n"),
    );
    expect(spaced("queries.edn")).not.toEqual(source("queries.edn"));
    expect(buildPolicy(spaced)).toEqual(buildPolicy());
  });

  it("checks queries by their parsed :in, not their spelling", () => {
    const bundle = readSources();
    const q1 = "[:find ?t :in\n $ ;db\n %\n :where (no-such-rule ?t)]";
    expect(
      problemsOf(() => validateBundle({ ...bundle, queries: { ...bundle.queries, q1 } })),
    ).toEqual(["queries.edn :q1: unknown rule 'no-such-rule'"]);
    const q2 = "[:find ?t :in $ [?x ...] :where [?t _ ?x]]";
    const problems = problemsOf(() =>
      validateBundle({ ...bundle, queries: { ...bundle.queries, q2 } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^queries\.edn :q2: unsupported query input/);
  });

  it("fails the build when a query the engine runs is renamed or removed", () => {
    const renamed = editing("queries.edn", (t) =>
      t.replace(" :active-count\n", " :active-counts\n"),
    );
    expect(problemsOf(() => buildPolicy(renamed))).toEqual([
      "queries.edn: missing :active-count, which the engine runs",
      "queries.edn: :active-counts is never run by the engine",
    ]);
    const bundle = readSources();
    const { denials: _, ...queries } = bundle.queries;
    expect(
      problemsOf(() =>
        validateBundle({
          ...bundle,
          queries: queries as typeof bundle.queries,
          keyQueries: bundle.keyQueries.filter(([name]) => name !== "urgency-key"),
        }),
      ),
    ).toEqual([
      "queries.edn: missing :denials, which the engine runs",
      'queries.edn :key-queries: need exactly one "urgency-key", which ordering.edn reads',
    ]);
  });

  it("reads the declared ordering exceptions as data, not as rule IDs inside a query (#416)", () => {
    const bundle = buildPolicy();
    expect(bundle.overrides).toEqual([
      { winner: "D-EASY", loser: "D-ORDINARY" },
      { winner: "D-UNFAVORABLE", loser: "D-ORDINARY" },
      { winner: "D-OWN-EASY", loser: "D-OWN" },
      { winner: "D-OWN-UNFAVORABLE", loser: "D-OWN" },
      { winner: "D-ADOPT", loser: "D-ORDINARY" },
    ]);
    for (const q of [...Object.values(bundle.queries), bundle.sortClauses])
      expect(q).not.toMatch(/"D-[A-Z-]+"/);
  });

  it("validates declared overrides: IDs, kinds, duplicates, contradictions and cycles", () => {
    const bundle = readSources();
    const kind = (id: string, k: string) => ({ ...bundle.definitions[0], id, kind: k });
    const definitions = [kind("D-A", "x"), kind("D-B", "x"), kind("D-C", "x"), kind("D-Z", "y")];
    const check = (overrides: { winner: string; loser: string }[]) =>
      overrideProblems({ definitions, overrides });
    expect(check([{ winner: "D-A", loser: "D-B" }])).toEqual([]);
    expect(check([{ winner: "D-A", loser: "D-NOPE" }])).toEqual([
      "ordering.edn :overrides[0] D-A over D-NOPE: unknown rule ID D-NOPE",
    ]);
    expect(check([{ winner: "D-A", loser: "D-A" }])).toEqual([
      "ordering.edn :overrides[0] D-A over D-A: a rule cannot override itself",
    ]);
    expect(check([{ winner: "D-A", loser: "D-Z" }])).toEqual([
      "ordering.edn :overrides[0] D-A over D-Z: kinds differ (x, y), so it would never apply",
    ]);
    expect(
      check([
        { winner: "D-A", loser: "D-B" },
        { winner: "D-A", loser: "D-B" },
        { winner: "D-B", loser: "D-A" },
      ]),
    ).toEqual([
      "ordering.edn :overrides[1] D-A over D-B: duplicate pair",
      "ordering.edn :overrides[2] D-B over D-A: contradicts an earlier pair",
    ]);
    expect(
      check([
        { winner: "D-A", loser: "D-B" },
        { winner: "D-B", loser: "D-C" },
        { winner: "D-C", loser: "D-A" },
      ]),
    ).toEqual(["ordering.edn :overrides: cycle D-A over D-B over D-C over D-A"]);
    expect(
      problemsOf(() =>
        readSources(
          editing("ordering.edn", (t) => t.replace(':winner "D-EASY"', ':winer "D-EASY"')),
        ),
      ),
    ).toEqual(["policy/ordering.edn :overrides[0]: unknown key :winer"]);
  });
});
