import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ds from "datascript";
import { compileProjectPolicy, loadProjectPolicy } from "./compile.js";
import { resolve } from "node:path";
import { conjunctionText } from "../english-render.js";
const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = {
  policyVersion: 1,
  rulesHash: "811a2953071e3e54c081245f1b3b15f661cc7cb7a883e1b2c4f893d613195ba0",
};
describe("compiled native project policy (#514)", () => {
  it("generates actual DataScript priority and action-bound witness queries from the same English clauses", () => {
    const p = compileProjectPolicy(fixture, base),
      r = p.preferences[0];
    const db = ds.init_db([
      [100, "pdb.action-id", "allowed:implement"],
      [100, "pdb.action-label", "project:priority"],
      [999, "pdb.action-label", "project:priority"],
    ]);
    expect(ds.q(r.query, db, p.rules)).toEqual([[100, 10]]);
    expect(ds.q(r.witnesses.label, db, p.rules, 100)).toEqual([["project:priority"]]);
    expect(conjunctionText(r.english.when)).toBe("project-hotfix(?a)");
    expect(conjunctionText(r.english.priority)).toContain("?value = 0 + 10");
    expect(p.phase).toBe("validated-project-policy");
    expect(JSON.stringify(p)).not.toContain("/Users/");
  });
  it("does not let a native result binding replace the admitted root variable", () => {
    const text = fixture.replace("(+ 0 10) ?value", "(+ 0 999) ?a] [(+ 0 10) ?value");
    const p = compileProjectPolicy(text, base);
    const db = ds.init_db([
      [100, "pdb.action-id", "allowed:implement"],
      [100, "pdb.action-label", "project:priority"],
    ]);
    expect(ds.q(p.preferences[0].query, db, p.rules)).toEqual([]);
  });
  it("matches pinned DataScript free-variable rules without rejecting prebound branch omissions", () => {
    const db = ds.init_db([
      [100, "pdb.action-id", "allowed:implement"],
      [100, "pdb.action-label", "x"],
      [1, "role", "implementer"],
    ]);
    const withWhen = (body: string) =>
      fixture.replace(":when [(project-hotfix ?a)]", `:when [${body}]`);
    for (const body of [
      '(or [?a "pdb.action-label" "x"] [1 "role" "implementer"])',
      '(or-join [?a] [?a "pdb.action-label" "x"] [1 "role" "implementer"])',
    ]) {
      const p = compileProjectPolicy(withWhen(body), base);
      expect(ds.q(p.preferences[0].query, db, p.rules)).toEqual([[100, 10]]);
    }
    for (const body of [
      '(or (not-join [?a] [?a "pdb.action-label" ?local]) [?a "pdb.action-label" "x"])',
      '(or (or-join [?a] [?a "pdb.action-label" ?local] [?a "pdb.action-id" _]) [?a "pdb.action-label" "x"])',
      '(or-join [?a ?missing] [?a "pdb.action-label" ?missing] [1 "role" "implementer"])',
    ]) {
      expect(() => ds.q(`[:find ?a :where [?a "pdb.action-id" _] ${body}]`, db)).toThrow(
        /same set of free vars/,
      );
      expect(() => compileProjectPolicy(withWhen(body), base)).toThrow(
        expect.objectContaining({ code: "native-grounding" }),
      );
    }
    for (const op of ["or-join", "not-join"]) {
      const body = `(${op} [] [1 "role" "implementer"])`;
      expect(() => ds.q(`[:find ?a :where [?a "pdb.action-id" _] ${body}]`, db)).toThrow();
      expect(() => compileProjectPolicy(withWhen(body), base)).toThrow(
        expect.objectContaining({ code: "native-join" }),
      );
    }
  });
  it("uses the contract's exact composite identity and is stable under layout/comments", () => {
    const p = compileProjectPolicy(fixture, base);
    expect(p.effectiveRulesHash).toBe(
      createHash("sha256")
        .update(JSON.stringify([1, base.rulesHash, 1, p.canonicalSource]))
        .digest("hex"),
    );
    expect(compileProjectPolicy(`; layout\n${fixture}\n`, base).effectiveRulesHash).toBe(
      p.effectiveRulesHash,
    );
    const changed = compileProjectPolicy(fixture.replace("(+ 0 10)", "(+ 0 11)"), base);
    expect(changed.projectRulesHash).not.toBe(p.projectRulesHash);
    expect(changed.effectiveRulesHash).not.toBe(p.effectiveRulesHash);
  });
  it("composes one selected source read with static validation through injected I/O", async () => {
    let reads = 0;
    const policy = await loadProjectPolicy(resolve("fixture-project"), base, {
      realpath: async (p) => p,
      read: async () => {
        reads++;
        return Buffer.from(fixture);
      },
    });
    expect(policy.phase).toBe("validated-project-policy");
    expect(reads).toBe(1);
  });
  it("supports a native constant preference without helper definitions", () => {
    const text = `{:format-version 1 :projection-version 1 :base-policy-version 1 :base-rules-hash "${base.rulesHash}"
      :rules [] :preferences [{:id "project-all" :when [] :priority [[(+ 0 2) ?value]] :why "Constant preference." :witnesses {}}]}`;
    const p = compileProjectPolicy(text, base);
    const db = ds.init_db([[100, "pdb.action-id", "allowed:implement"]]);
    expect(ds.q(p.preferences[0].query, db, p.rules)).toEqual([[100, 2]]);
  });
  it("never emits an artifact for reserved, cyclic or ungrounded source", () => {
    expect(() =>
      compileProjectPolicy(fixture.replaceAll("project-hotfix", "eligible"), base),
    ).toThrow(expect.objectContaining({ code: "reserved-predicate" }));
    expect(() =>
      compileProjectPolicy(
        fixture.replace('[?a "pdb.action-label" "project:priority"]', "(project-hotfix ?a)"),
        base,
      ),
    ).toThrow(expect.objectContaining({ code: "native-cycle" }));
    expect(() =>
      compileProjectPolicy(fixture.replace("(+ 0 10)", "(+ ?missing 10)"), base),
    ).toThrow(expect.objectContaining({ code: "native-grounding" }));
  });
});
