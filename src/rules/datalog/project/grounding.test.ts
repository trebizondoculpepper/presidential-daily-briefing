import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { compileProjectGrammar } from "./grammar.js";
import { validateGrounding } from "./grounding.js";
import { readOne, printEdn } from "../edn.js";
const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = {
  policyVersion: 1,
  rulesHash: "811a2953071e3e54c081245f1b3b15f661cc7cb7a883e1b2c4f893d613195ba0",
};
const check = (text: string) => validateGrounding(compileProjectGrammar(text, base));
type EdnMap = { map: [{ key: string }, unknown][] };
const priority = (clauses: string, text = fixture) => {
  const form = readOne(text, "fixture") as EdnMap;
  const pref = (form.map.find(([k]) => k.key === "preferences")![1] as EdnMap[])[0];
  pref.map.find(([k]) => k.key === "priority")![1] = readOne(clauses, "priority");
  return printEdn(form, "fixture");
};
describe("native project variable binding modes (#514)", () => {
  it("accepts the real source including independently bound witnesses", () =>
    expect(() => check(fixture)).not.toThrow());
  it("requires every preference priority and witness output to bind value", () => {
    expect(() => check(priority("[]"))).toThrow(
      expect.objectContaining({ code: "native-grounding" }),
    );
    expect(() => check(priority("[[(+ ?unknown 10) ?value]]"))).toThrow(
      expect.objectContaining({ code: "native-grounding" }),
    );
    expect(() =>
      check(fixture.replace('[(str "project:priority") ?value]', "[(str ?unseen) ?value]")),
    ).toThrow(expect.objectContaining({ code: "native-grounding" }));
  });
  it("allows values bound in when to flow into priority", () => {
    const t = priority("[[(+ ?key 1) ?value]]").replace(
      ":when [(project-hotfix ?a)]",
      ':when [(project-hotfix ?a) [?a "pdb.base-band" ?key]]',
    );
    expect(() => check(t)).not.toThrow();
  });
  it("does not leak when-only variables into independent witnesses", () => {
    const t = fixture
      .replace(
        ":when [(project-hotfix ?a)]",
        ':when [(project-hotfix ?a) [?a "pdb.base-band" ?key]]',
      )
      .replace('[(str "project:priority") ?value]', "[(str ?key) ?value]");
    expect(() => check(t)).toThrow(expect.objectContaining({ code: "native-grounding" }));
  });
  it("validates derived helper output modes", () => {
    const t = fixture.replace(
      '[(project-hotfix ?a) [?a "pdb.action-label" "project:priority"]]',
      '[(project-hotfix ?a) [?a "pdb.action-label" "project:priority"]] [(project-key ?a ?v) [?a "pdb.base-band" ?v]]',
    );
    expect(() => check(priority("[(project-key ?a ?value)]", t))).not.toThrow();
  });
  it("rejects ungrounded comparisons and incompatible ordinary or branches", () => {
    expect(() => check(priority("[[(> ?x 1)] [(+ 0 10) ?value]]"))).toThrow(
      expect.objectContaining({ code: "native-grounding" }),
    );
    expect(() => check(priority("[(or [(+ 0 10) ?value] [(+ 0 20) ?other])]"))).toThrow(
      expect.objectContaining({ code: "native-grounding" }),
    );
  });
  it("handles joined local variables without exporting them", () => {
    expect(() =>
      check(
        priority(
          '[(or-join [?a ?value] (and [?a "pdb.base-band" ?local] [(+ ?local 1) ?value]) [(+ 0 20) ?value])]',
        ),
      ),
    ).not.toThrow();
    expect(() =>
      check(priority('[(not-join [?a] [?a "pdb.action-label" ?local]) [(+ 0 10) ?value]]')),
    ).not.toThrow();
    expect(() =>
      check(priority('[(not-join [?missing] [?a "pdb.action-label" ?missing]) [(+ 0 10) ?value]]')),
    ).toThrow(expect.objectContaining({ code: "native-grounding" }));
  });
  it("rejects a local variable in plain not unless previously bound", () => {
    expect(() => check(priority('[(not [?a "pdb.action-label" ?new]) [(+ 0 10) ?value]]'))).toThrow(
      expect.objectContaining({ code: "native-grounding" }),
    );
  });
});
