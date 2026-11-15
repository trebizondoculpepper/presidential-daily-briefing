import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { compileProjectGrammar } from "./grammar.js";
import { conjunctionText } from "../english-render.js";
const base = {
  policyVersion: 1,
  rulesHash: "811a2953071e3e54c081245f1b3b15f661cc7cb7a883e1b2c4f893d613195ba0",
};
const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const program = (
  o: {
    rules?: string;
    when?: string;
    priority?: string;
    why?: string;
    witnesses?: string;
    preferences?: string;
  } = {},
) => {
  const preference = `{:id "project-label" :when ${o.when ?? "[(project-label ?a)]"} :priority ${o.priority ?? "[[(+ 0 10) ?value]]"} :why ${o.why ?? '"Matched project label."'} :witnesses ${o.witnesses ?? "{}"}}`;
  return `{:format-version 1 :projection-version 1 :base-policy-version 1 :base-rules-hash "${base.rulesHash}" :rules ${o.rules ?? '[[(project-label ?a) [?a "pdb.action-label" "project:priority"]]]'} :preferences ${o.preferences ?? `[${preference}]`}}`;
};
const compile = (text: string) => compileProjectGrammar(text, base);
describe("native project grammar and shared English (#514)", () => {
  it("compiles the committed native source without pretending grounding or activation is done", () => {
    const g = compile(fixture);
    expect(g.phase).toBe("grammar-checked");
    expect(g.helpers[0].params).toEqual(["?a"]);
    expect(conjunctionText(g.helpers[0].clauses)).toBe('?a has collected label "project:priority"');
    expect(conjunctionText(g.preferences[0].priority)).toContain("?value = 0 + 10");
    expect(g.preferences[0].witnesses.label).toHaveLength(2);
    expect(g).not.toHaveProperty("effectiveRulesHash");
  });
  it("uses native not= and preserves its operands in English", () => {
    const g = compile(program({ priority: "[[(+ 0 10) ?value] [(not= ?value 0)]]" }));
    expect(conjunctionText(g.preferences[0].priority)).toContain("?value is not 0");
  });
  it("accepts alternatives and nested native joins while retaining source order", () => {
    const g = compile(
      program({
        rules:
          '[[(project-label ?a) [?a "pdb.action-label" "first"]] [(project-label ?a) (or-join [?a] [?a "pdb.action-label" "second"] [?a "pdb.action-label" "third"])]]',
      }),
    );
    expect(g.helpers.map((h) => h.index)).toEqual([0, 1]);
    expect(conjunctionText(g.helpers[1].clauses)).toContain("joined on ?a");
  });
  it("keeps dynamic attributes explicit and viewer facts separately scoped", () => {
    const g = compile(program({ when: '[[1 "role" "implementer"] [?a ?attribute ?v]]' }));
    expect(conjunctionText(g.preferences[0].when)).toBe(
      'the viewer\'s role is "implementer" and a fact has entity ?a, attribute ?attribute and value ?v',
    );
  });
  it.each([
    [
      "reserved helper",
      { rules: '[[(eligible ?a) [?a "pdb.action-id" _]]]' },
      "reserved-predicate",
    ],
    ["unknown predicate", { when: "[(project-missing ?a)]" }, "native-call"],
    ["wrong call arity", { when: "[(project-label ?a ?b)]" }, "native-call"],
    [
      "inconsistent alternatives",
      {
        rules:
          '[[(project-label ?a) [?a "pdb.action-id" _]] [(project-label ?a ?b) [?a "pdb.action-id" ?b]]]',
      },
      "native-arity",
    ],
    ["recursive helper", { rules: "[[(project-label ?a) (project-label ?a)]]" }, "native-cycle"],
    [
      "indirect cycle",
      { rules: "[[(project-label ?a) (project-next ?a)] [(project-next ?a) (project-label ?a)]]" },
      "native-cycle",
    ],
    ["foreign attribute", { when: '[[?a "permission" "admin"]]' }, "native-clause"],
    ["host function", { priority: '[[(eval "secret") ?value]]' }, "native-clause"],
    [
      "wrong inequality alias",
      { priority: "[[(+ 0 10) ?value] [(!= ?value 0)]]" },
      "native-clause",
    ],
    ["unary arithmetic", { priority: "[[(- 1) ?value]]" }, "native-clause"],
    ["unknown placeholder", { why: '"Unseen {missing}."' }, "preference-placeholder"],
    ["dangling placeholder", { why: '"Unclosed {missing."' }, "preference-placeholder"],
    ["blank reason", { why: '" "' }, "preference-why"],
  ])("rejects %s", (_name, options, code) => {
    expect(() => compile(program(options))).toThrow(expect.objectContaining({ code }));
  });
  it("rejects duplicate preference IDs and unknown record keys", () => {
    const p = '{:id "project-x" :when [] :priority [[(+ 0 1) ?value]] :why "X" :witnesses {}}';
    expect(() => compile(program({ preferences: `[${p} ${p}]` }))).toThrow(
      expect.objectContaining({ code: "preference-id" }),
    );
    expect(() => compile(program().replace(':why "Matched', ':extra 1 :why "Matched'))).toThrow(
      expect.objectContaining({ code: "native-key" }),
    );
  });
  it("bounds reason length, helper arity and total nested clauses", () => {
    expect(() => compile(program({ why: JSON.stringify("x".repeat(513)) }))).toThrow(
      expect.objectContaining({ code: "preference-why" }),
    );
    expect(() =>
      compile(
        program({
          rules: `[[(project-label ${Array.from({ length: 9 }, (_, i) => `?v${i}`).join(" ")}) [?v0 "pdb.action-id" _]]]`,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "native-arity" }));
    expect(() =>
      compile(program({ rules: `[[(project-label ?a) ${"[(= 1 1)] ".repeat(1001)}]]` })),
    ).toThrow(expect.objectContaining({ code: "native-clause-count" }));
  });
  it("counts reason limits in Unicode code points rather than UTF-16 units", () => {
    expect(() => compile(program({ why: JSON.stringify("😀".repeat(512)) }))).not.toThrow();
    expect(() => compile(program({ why: JSON.stringify("😀".repeat(513)) }))).toThrow(
      expect.objectContaining({ code: "preference-why" }),
    );
  });
  it("does not leak private native argument text in structural failures", () => {
    expect(() =>
      compile(program({ priority: '[[(host-fn "PRIVATE_CONTENT") ?value]]' })),
    ).not.toThrow(/PRIVATE_CONTENT/);
    expect(() => compile(program({ priority: '[[(host-fn "PRIVATE_CONTENT") ?value]]' }))).toThrow(
      expect.objectContaining({ code: "native-clause" }),
    );
  });
});
