/**
 * The English compiler (#416, doc/design/rules-english-command.md): every source construct is
 * accounted for, the lexicon is complete and used, unsupported forms fail, and the English is
 * derived from clauses, so editing a clause changes it while editing `:why` does not.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPolicy,
  definedRules,
  englishPath,
  policyDir,
  PolicyBuildError,
  serialize,
} from "./build.js";
import ds from "datascript";
import { readOne } from "./edn.js";
import { clauseEdn, compileEnglish, EnglishCompileError } from "./english.js";
import { clauseLines, clauseText, conjunctionText, predicateHead } from "./english-render.js";
import type { EnglishPolicy } from "./english-model.js";

const source = (file: string) => readFileSync(join(policyDir, file), "utf8");
const editing =
  (file: string, edit: (text: string) => string) =>
  (name: string): string =>
    name === file ? edit(source(name)) : source(name);
const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyBuildError || error instanceof EnglishCompileError)
      return error.problems;
    throw error;
  }
  return [];
};
const decisionText = (model: EnglishPolicy, id: string) =>
  conjunctionText(model.decisions.find((d) => d.id === id)?.clauses ?? []);

describe("English policy compiler (#416)", () => {
  const bundle = buildPolicy();
  const model = compileEnglish(bundle);

  it("is the committed english.generated.json, deterministically", () => {
    expect(compileEnglish(bundle)).toEqual(model);
    expect(JSON.parse(readFileSync(englishPath, "utf8"))).toEqual(JSON.parse(serialize(model)));
    expect(model.rulesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(model)).not.toMatch(/\/Users\/|[A-Z]:\\\\/);
  });

  it("enumerates every decision rule, predicate alternative, denial and query from the policy", () => {
    expect(model.decisions.map((d) => d.id)).toEqual(bundle.definitions.map((d) => d.id));
    for (const d of model.decisions) {
      const def = bundle.definitions.find((x) => x.id === d.id);
      expect([d.kind, d.band, d.preference, d.codes]).toEqual([
        def?.kind,
        def?.band,
        def?.preference,
        def?.codes,
      ]);
      expect(d.clauses.length).toBeGreaterThan(0);
      expect(d.evidence.map((e) => e.name)).toEqual(Object.keys(def?.witnesses ?? {}));
    }
    const rules = readOne(bundle.clauses, "rules") as unknown[];
    const sorting = readOne(bundle.sortClauses, "ordering") as unknown[];
    expect(model.predicates.map((p) => p.name)).toEqual([
      ...definedRules(rules),
      ...definedRules(sorting),
    ]);
    expect(model.coverage.alternatives).toBe(rules.length + sorting.length);
    expect(model.predicates.reduce((n, p) => n + p.alternatives.length, 0)).toBe(
      rules.length + sorting.length,
    );
    expect(model.denials.map((d) => d.id).sort()).toEqual(Object.keys(bundle.denials).sort());
    expect(
      [...model.ordering.overrideQueries, model.ordering.sortQuery, ...model.queries]
        .map((q) => q.name)
        .sort(),
    ).toEqual(Object.keys(bundle.queries).sort());
    expect(model.ordering.keyQueries.map((q) => q.name)).toEqual(
      bundle.keyQueries.map(([name]) => name),
    );
    expect(model.ordering.overrides).toEqual(bundle.overrides);
    expect(model.evidence.map((e) => e.name)).toEqual([
      ...Object.keys(bundle.commonWitnesses),
      ...Object.keys(bundle.eligibilityWitnesses),
    ]);
    expect(model.coverage).toMatchObject({
      decisions: bundle.definitions.length,
      denials: Object.keys(bundle.denials).length,
      overrides: bundle.overrides.length,
      constants: Object.keys(bundle.constants).length,
    });
  });

  it("compiles each predicate's alternatives as a disjunction of conjunctions, without expanding calls", () => {
    const mineLinked = model.predicates.find((p) => p.name === "mine-linked");
    expect(mineLinked?.alternatives.map((a) => conjunctionText(a.clauses))).toEqual([
      "mine(?t)",
      `the viewer's agent name is ?a and ?t has responsible agent ?a`,
      "?t has issue it closes ?i and mine(?i)",
    ]);
    expect(mineLinked?.calls).toEqual(["mine"]);
  });

  it("names inputs only through the lexicon and keeps entity-1 viewer, constant and context facts apart", () => {
    expect(decisionText(model, "D-EASY")).toBe(
      `foreground(?t) and the viewer's role is "implementer" and eligible(?t) and easy(?t) and the viewer's requested order is "impact"`,
    );
    const largeImpact = model.predicates.find((p) => p.name === "large-impact");
    expect(conjunctionText(largeImpact?.alternatives[0].clauses ?? [])).toBe(
      `?t's impact assessment state is "current" and ?t's impact size is ?s and ?s is in the constant set "large"`,
    );
    const closing = model.predicates.find((p) => p.name === "closing-complete");
    expect(conjunctionText(closing?.alternatives[1].clauses ?? [])).toBe(
      "?t has some kind and the context records completeness of forward closing-PR evidence true",
    );
  });

  it("keeps negation as absence of a match and or-join grouping with its join variables", () => {
    expect(decisionText(model, "D-DESIGN-REVIEW")).toContain("no match for: own-follow-up(?t)");
    const lines = clauseLines(
      model.ordering.keyQueries.find((q) => q.name === "urgency-key")?.clauses ?? [],
    );
    expect(lines[1]).toBe("  - at least one of (joined on ?t, ?k):");
    expect(lines).toContain(`          - no match for: ?t has label "urgency:low"`);
  });

  it("reads denial IDs from the str bindings that produce them", () => {
    const blocker = model.denials.find((d) => d.id === "D-DENY-BLOCKER");
    expect(blocker?.predicate).toBe("implementation-deny");
    expect(conjunctionText(blocker?.clauses ?? [])).toBe("issue(?t) and blocked(?t)");
    const closing = model.denials.find((d) => d.id === "D-DENY-CLOSING-UNKNOWN");
    expect(conjunctionText(closing?.clauses ?? [])).toBe(
      "issue(?t) and (no match for: closing-complete(?t))",
    );
  });

  it("compiles declared overrides, comparisons, arithmetic and aggregates as written", () => {
    const declared = model.ordering.overrideQueries.find((q) => q.name === "declared-overrides");
    expect(declared?.inputs).toEqual(["$", "[[?winner ?loser]]"]);
    expect(conjunctionText(declared?.clauses ?? [])).toContain("?r's rule ID is ?loser");
    const ageNewest = model.predicates.find((p) => p.name === "age")?.alternatives[1];
    expect(conjunctionText(ageNewest?.clauses ?? [])).toContain("?created = 0 - ?c");
    expect(model.queries.find((q) => q.name === "q2")?.find).toEqual([
      "?t",
      "count of distinct ?d",
    ]);
  });

  it("compiles every supported synthetic construct, including forms production does not use yet", () => {
    const q3 =
      '[:find ?t (count-distinct ?d) :in $ % :where [?t "kind" _] (not-join [?t] [?t "label" ?l] [?t "state" "OPEN"]) (or (issue ?t) (and (pr ?t) [?t "draft" false])) [(>= ?n 2)] [(<= ?n 9)] [(* ?n 2) ?m] [(/ ?m 2) ?h] [(str ?a "-" 1) ?s] [?t "dependent" ?d]]';
    const synthetic = compileEnglish({ ...bundle, queries: { ...bundle.queries, q3 } });
    const q = synthetic.queries.find((x) => x.name === "q3");
    expect(q?.clauses.map(clauseText)).toEqual([
      "?t has some kind",
      `no match (joined on ?t) for: (?t has label ?l and ?t's state is "OPEN")`,
      `at least one of: (1) issue(?t); (2) pr(?t) and ?t's draft flag is false`,
      "?n ≥ 2",
      "?n ≤ 9",
      "?m = ?n * 2",
      "?h = ?m / 2",
      `?s is the text joining ?a, "-", 1`,
      "?t has native dependent ?d",
    ]);
  });

  it("preserves native dynamic attributes without assigning a viewer scope or guessed lexicon", () => {
    const query = "[:find ?a ?v :in $ :where [1 ?a ?v]]";
    const wildcard = '[:find ?t :in $ :where [?t _ "OPEN"]]';
    const queries = { ...bundle.queries, dynamic: query, wildcard };
    const synthetic = compileEnglish({ ...bundle, queries });
    const clause = synthetic.queries.find((q) => q.name === "dynamic")!.clauses[0];
    expect(clause).toEqual({
      type: "dynamic-fact",
      entity: { lit: 1 },
      attribute: { var: "?a" },
      value: { var: "?v" },
    });
    expect(clauseEdn(clause)).toBe("[1 ?a ?v]");
    expect(clauseText(clause)).toBe("a fact has entity 1, attribute ?a and value ?v");
    expect(clauseText(synthetic.queries.find((q) => q.name === "wildcard")!.clauses[0])).toBe(
      'a fact has entity ?t, attribute anything and value "OPEN"',
    );
    const db = ds.init_db([
      [1, "role", "implementer"],
      [1, "state", "OPEN"],
    ]);
    expect(ds.q(query, db).sort()).toEqual([
      ["role", "implementer"],
      ["state", "OPEN"],
    ]);
    expect(ds.q(wildcard, db)).toEqual([[1]]);
    expect(
      problemsOf(() =>
        compileEnglish({
          ...bundle,
          queries: { ...bundle.queries, q3: '[:find ?v :where [1 "?a" ?v]]' },
        }),
      ),
    ).toContain(
      'policy/queries.edn :q3 where[0]: attribute "?a" has no phrase in schema.edn :lexicon',
    );
  });

  it("fails on unsupported constructs instead of omitting them", () => {
    const withClauses = (extra: string) =>
      problemsOf(() =>
        compileEnglish({ ...bundle, clauses: bundle.clauses.replace(/\]$/, ` ${extra}]`) }),
      );
    expect(withClauses('[(odd ?t) [?t "number" ?n] [(odd? ?n)]]')).toEqual([
      expect.stringMatching(
        /policy\/rules\.edn\[\d+\] odd\[1\]: unsupported function clause \(odd\?\)/,
      ),
    ]);
    expect(withClauses("[(any ?t) [?t 42 ?v]]")).toEqual([
      expect.stringMatching(
        /policy\/rules\.edn\[\d+\] any\[0\]: a dynamic attribute must be a variable or wildcard/,
      ),
    ]);
    expect(withClauses('[(first ?t) [?t "label" ?l] [(count ?l) ?n]]')).toEqual([
      expect.stringMatching(
        /policy\/rules\.edn\[\d+\] first\[1\]: unsupported function clause \(count\)/,
      ),
    ]);
    const q2 = '[:find ?t (max ?d) :where [?t "unlocks-dependent" ?d]]';
    expect(
      problemsOf(() => compileEnglish({ ...bundle, queries: { ...bundle.queries, q2 } })),
    ).toEqual(["policy/queries.edn :q2: unsupported :find aggregate"]);
  });

  it("fails the build when an attribute has no phrase, a phrase is unused or a viewer fact is unnamed", () => {
    expect(
      problemsOf(() =>
        buildPolicy(
          editing("schema.edn", (t) =>
            t.replace('   "open-blockers" "number of open blockers"\n', ""),
          ),
        ),
      ),
    ).toEqual([
      'policy/rules.edn[29] blocked[0]: attribute "open-blockers" has no phrase in schema.edn :lexicon',

      'policy/schema.edn :eligibility-witnesses "openBlockers"[0]: attribute "open-blockers" has no phrase in schema.edn :lexicon',
      'policy/queries.edn :q1 where[3]: attribute "open-blockers" has no phrase in schema.edn :lexicon',
    ]);
    expect(
      problemsOf(() =>
        buildPolicy(
          editing("schema.edn", (t) =>
            t.replace(
              '"urgency-key" "urgency sort key"',
              '"urgency-key" "urgency sort key"\n   "colour" "colour"',
            ),
          ),
        ),
      ),
    ).toEqual(['schema.edn :lexicon :attributes: "colour" is not used by any rule']);
    expect(
      problemsOf(() =>
        buildPolicy(editing("schema.edn", (t) => t.replace('   "order" "requested order"', ""))),
      ),
    ).toContain('schema.edn :lexicon :viewer: missing viewer fact "order"');
    expect(
      problemsOf(() =>
        buildPolicy(
          editing("schema.edn", (t) =>
            t.replace('"label" "label"', '"label" "label"\n   "label" "tag"'),
          ),
        ),
      ),
    ).toEqual(['policy/schema.edn :lexicon :attributes: duplicate key "label"']);
  });

  it("changes the English when a clause changes, and not when only :why changes", () => {
    const edited = compileEnglish(
      buildPolicy(
        editing("decisions.edn", (t) =>
          t.replace(
            ':when [[1 "role" "implementer"] (eligible ?t) (easy ?t) [1 "order" "impact"]]',
            ':when [[1 "role" "implementer"] (eligible ?t) (unfavorable ?t) [1 "order" "oldest"]]',
          ),
        ),
      ),
    );
    expect(decisionText(edited, "D-EASY")).toBe(
      `foreground(?t) and the viewer's role is "implementer" and eligible(?t) and unfavorable(?t) and the viewer's requested order is "oldest"`,
    );
    expect(edited.rulesHash).not.toBe(model.rulesHash);

    const predicate = compileEnglish(
      buildPolicy(
        editing("rules.edn", (t) =>
          t.replace(
            '[(blocked ?t) [?t "open-blockers" ?n] [(> ?n 0)]]',
            '[(blocked ?t) [?t "open-blockers" ?n] [(> ?n 1)]]',
          ),
        ),
      ),
    );
    expect(
      conjunctionText(
        predicate.predicates.find((p) => p.name === "blocked")?.alternatives[0].clauses ?? [],
      ),
    ).toBe("?t's number of open blockers is ?n and ?n > 1");

    const why = compileEnglish(
      buildPolicy(
        editing("decisions.edn", (t) =>
          t.replace(
            '"Known easy win: impact {impact}, complexity {complexity}."',
            '"Reworded {impact}."',
          ),
        ),
      ),
    );
    // Both revision identities change when a legacy hash input changes.
    const strip = (m: EnglishPolicy) => ({ ...m, rulesHash: "", narrationHash: "" });
    expect(strip(why)).toEqual(strip(model));

    const overrides = compileEnglish(
      buildPolicy(
        editing("ordering.edn", (t) => t.replace(/\{:winner "D-OWN-UNFAVORABLE"[^}]*\}/, "")),
      ),
    );
    expect(overrides.ordering.overrides).toHaveLength(3);
  });

  it("keeps each predicate alternative's own head variables (Codex, #478)", () => {
    const extra = '[(linked ?t) [?t "closes" ?i]] [(linked ?x) [?x "responsible" ?a]]';
    const m = compileEnglish({ ...bundle, clauses: bundle.clauses.replace(/\]$/, ` ${extra}]`) });
    const linked = m.predicates.find((p) => p.name === "linked");
    expect(linked?.alternatives.map((a) => predicateHead("linked", a.params))).toEqual([
      "linked(?t)",
      "linked(?x)",
    ]);
    expect(conjunctionText(linked?.alternatives[1].clauses ?? [])).toBe(
      "?x has responsible agent ?a",
    );
    for (const p of model.predicates)
      for (const a of p.alternatives) expect(a.params).toHaveLength(p.params.length);
  });

  it("renders every comparison operand and rejects arities it cannot state (Codex, #478)", () => {
    const q3 =
      '[:find ?t :where [?t "number" ?n] [?t "created" ?c] [(< 0 ?n ?c)] [(= ?n ?c 3)] [(not= ?n ?c 5)] [(>= ?c ?n 1)]]';
    const m = compileEnglish({ ...bundle, queries: { ...bundle.queries, q3 } });
    expect(
      m.queries
        .find((q) => q.name === "q3")
        ?.clauses.slice(2)
        .map(clauseText),
    ).toEqual(["0 < ?n < ?c", "?n = ?c = 3", "not all of ?n, ?c, 5 are equal", "?c ≥ ?n ≥ 1"]);
    const rejected = (where: string) =>
      problemsOf(() =>
        compileEnglish({
          ...bundle,
          queries: {
            ...bundle.queries,
            q3: `[:find ?t :where [?t "number" ?n] ${where}]`,
          },
        }),
      );
    expect(rejected("[(> ?n)]")).toEqual([
      "policy/queries.edn :q3 where[1]: > needs at least two operands",
    ]);
    expect(rejected("[(- ?n) ?m]")).toEqual([
      "policy/queries.edn :q3 where[1]: - with 1 operand(s) is not supported",
    ]);
    expect(rejected("[(str) ?m]")).toEqual([
      "policy/queries.edn :q3 where[1]: str with 0 operand(s) is not supported",
    ]);
    expect(rejected("(not)")).toEqual(["policy/queries.edn :q3 where[1]: empty not"]);
    expect(rejected("(or-join [?n])")).toEqual(["policy/queries.edn :q3 where[1]: empty or-join"]);
    // The renderer refuses rather than print a partial condition if a bad shape ever reaches it.
    expect(() => clauseText({ type: "compare", op: "<", args: [{ var: "?n" }] })).toThrow(
      "cannot render comparison",
    );
    expect(() =>
      clauseText({ type: "bind", fn: "-", args: [{ var: "?n" }], result: "?m" }),
    ).toThrow("cannot render -");
  });

  it("compiles each decision as exactly the query the engine runs, match template included (Codex, #478)", () => {
    for (const [i, d] of bundle.definitions.entries()) {
      const compiled = model.decisions[i];
      expect(compiled.id).toBe(d.id);
      // The model printed back as EDN is the engine's :where, clause for clause.
      const engineWhere = d.query.slice(d.query.indexOf(":where ") + ":where ".length, -1);
      expect(compiled.clauses.map(clauseEdn).join(" "), d.id).toBe(engineWhere);
      expect(compiled.clauses.slice(compiled.templateClauses).map(clauseEdn).join(" "), d.id).toBe(
        d.clauses,
      );
    }
    const attention = model.decisions.find((d) => d.id === "D-ATTENTION");
    expect(attention?.templateClauses).toBe(1);
    expect(conjunctionText(attention?.clauses ?? [])).toBe(
      "foreground(?t) and open(?t) and addressed(?t)",
    );
  });

  it("delimits nested groups and keeps a single-alternative or-join's variables (CodeRabbit, #478)", () => {
    const q3 =
      '[:find ?t :in $ % :where [?t "kind" _] (not (issue ?t) (open ?t)) (or-join [?t] (and (pr ?t) (open ?t))) (and (pr ?t) (not (open ?t))) (not (or (issue ?t) (pr ?t)))]';
    const m = compileEnglish({ ...bundle, queries: { ...bundle.queries, q3 } });
    const clauses = m.queries.find((q) => q.name === "q3")?.clauses ?? [];
    expect(clauses.map(clauseEdn).join(" ")).toBe(q3.slice(q3.indexOf(":where ") + 7, -1));
    expect(conjunctionText(clauses)).toBe(
      "?t has some kind and (no match for: (issue(?t) and open(?t))) and (at least one of (joined on ?t): (1) pr(?t) and open(?t)) and (pr(?t) and (no match for: open(?t))) and (no match for: (at least one of: (1) issue(?t); (2) pr(?t)))",
    );
    expect(clauseLines(clauses.slice(2, 3))).toEqual([
      "  - at least one of (joined on ?t):",
      "      (1) all of:",
      "          - pr(?t)",
      "          - open(?t)",
    ]);
  });
});
