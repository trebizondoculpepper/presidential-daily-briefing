/**
 * `pdb rules` (#416): the document and its text projection, filters, failure behaviour and the
 * CLI contract (stdout only on success, stderr and exit 2 for arguments, no GitHub calls).
 */
import { describe, it, expect } from "vite-plus/test";
import { main } from "../../cli.js";
import { buildPolicy } from "./build.js";
import { compileEnglish } from "./english.js";
import { mdClauseLines } from "./english-render.js";
import {
  RulesArgumentError,
  RulesArtifactError,
  rulesDocument,
  ruleIds,
  rulesText,
  shippedModel,
} from "./rules-command.js";
import type { RulesContext } from "./rules-command.js";

const context: RulesContext = {
  defaults: [{ name: "briefing.engine", value: "datalog", declaredBy: "test registry" }],
  mutatingCommands: ["claim", "release"],
  processCommand: "pdb process",
};
const model = shippedModel();
const noNetwork = {
  collect: async () => {
    throw new Error("no network");
  },
  currentRepository: async () => {
    throw new Error("no network");
  },
};
async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, async (t) => void (stdout += t), {
    ...noNetwork,
    stderr: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
}

describe("pdb rules document (#416)", () => {
  const doc = rulesDocument(context);
  const text = rulesText(doc);

  it("ships the English compiled from the very bundle the engine runs", () => {
    expect(model).toEqual(compileEnglish(buildPolicy()));
    expect(() => shippedModel({ ...model, rulesHash: "0".repeat(64) })).toThrow(RulesArtifactError);
  });

  it("is the complete policy by default, and the text lists every part of the document", () => {
    expect(doc.scope.complete).toBe(true);
    expect(doc.decisions).toHaveLength(model.decisions.length);
    expect(doc.eligibility.denials).toHaveLength(model.denials.length);
    expect(doc.predicates).toHaveLength(model.predicates.length);
    expect(doc.ordering.overrides).toEqual(model.ordering.overrides);
    expect(text).toContain(
      `- Policy: version \`${model.policyVersion}\`, \`rulesHash\` \`${model.rulesHash}\``,
    );
    for (const d of doc.decisions) {
      expect(text).toContain(`#### \`${d.id}\``);
      expect(text).toContain(
        `- Proposed action: \`${d.kind}\`. Preference: \`${d.preference}\`. Codes:`,
      );
      for (const line of mdClauseLines(d.clauses, "  ")) expect(text).toContain(line);
    }
    for (const d of doc.eligibility.denials) {
      expect(text).toContain(`### \`${d.id}\``);
      expect(text).toContain(`- Predicate: \`${d.predicate}\``);
    }
    for (const p of doc.predicates) {
      expect(text).toContain(`### \`${p.name}(${p.params.join(", ")})\``);
      for (const a of p.alternatives)
        for (const line of mdClauseLines(a.clauses, "   ")) expect(text).toContain(line);
    }
    for (const q of [...doc.queries, ...doc.ordering.keyQueries, ...doc.ordering.overrideQueries])
      expect(text).toContain(`${q.name}: find ${q.find.join(", ")}`);
    for (const o of doc.ordering.overrides)
      expect(text).toContain(`- \`${o.winner}\` over \`${o.loser}\``);
    expect(text).toContain(
      `Sort keys, compared in this sequence, smaller first: ${model.ordering.comparison.map((c) => `\`${c}\``).join(", ")}.`,
    );
    for (const name of Object.keys(model.lexicon.attributes))
      expect(text).toContain(`- \`${name}\`: `);
    expect(text).toContain("## Not formalized here");
    expect(text).toContain("Commands that change GitHub");
    expect(text).toContain("This repository's effective settings: unknown.");
    expect(text).toContain("pdb process prints the short workflow guide");
    expect(text).not.toContain("FILTERED");
    // Deterministic, and runtime why templates are not the listing's source.
    expect(rulesText(rulesDocument(context))).toBe(text);
    for (const d of buildPolicy().definitions) expect(text).not.toContain(d.why);
  });

  it("keeps rules without a top-level role fact for every role and labels the subset", () => {
    const designer = rulesDocument(context, { role: "designer" });
    expect(designer.scope).toMatchObject({ complete: false, filters: { role: "designer" } });
    const ids = designer.decisions.map((d) => d.id);
    expect(ids).toContain("D-DESIGN");
    expect(ids).toContain("D-INSPECT"); // role is a variable compared with not=: kept
    expect(ids).toContain("D-ATTENTION"); // names no role: kept
    expect(ids).toContain("D-EASY"); // #651: one agent pool, so implementer duties are kept too
    expect(ids).not.toContain("D-HUMAN-ASK");
    expect(designer.eligibility.denials).toHaveLength(model.denials.length);
    expect(designer.predicates).toHaveLength(model.predicates.length);
    const out = rulesText(designer);
    expect(out).toContain("- Scope: FILTERED (`--role designer`). Filtered subset of the policy");
    expect(out).not.toContain("Scope: Complete");
    expect(out).toContain("This output is a filtered subset");
  });

  it("selects one rule with the predicates it needs and its precedence context", () => {
    const easy = rulesDocument(context, { rule: "D-EASY" });
    expect(easy.scope.selected).toEqual({ id: "D-EASY", type: "decision" });
    expect(easy.decisions.map((d) => d.id)).toEqual([
      "D-EASY",
      "D-ORDINARY",
      "D-ADOPT",
      "D-UNFAVORABLE",
    ]);
    expect(easy.ordering.overrides).toEqual([{ winner: "D-EASY", loser: "D-ORDINARY" }]);
    const names = easy.predicates.map((p) => p.name);
    for (const needed of ["eligible", "easy", "implementation-deny", "large-impact", "platform-ok"])
      expect(names).toContain(needed);
    expect(names).not.toContain("pr-failure");

    const predicate = rulesDocument(context, { rule: "blocked" });
    expect(predicate.decisions).toEqual([]);
    expect(predicate.predicates.map((p) => p.name)).toEqual(["blocked"]);
    expect(predicate.predicates[0].usedBy?.denials).toEqual(["D-DENY-BLOCKER"]);

    const denial = rulesDocument(context, { rule: "D-DENY-BLOCKER" });
    expect(denial.eligibility.denials.map((d) => d.id)).toEqual(["D-DENY-BLOCKER"]);
    expect(rulesText(denial)).toContain("- Scope: FILTERED (`--rule D-DENY-BLOCKER`)");
  });

  it("rejects unknown rules and roles with a hint, before anything is printed", () => {
    expect(() => rulesDocument(context, { rule: "EASY" })).toThrow(
      /unknown rule or predicate "EASY"\. Did you mean: D-EASY, D-OWN-EASY, easy\?/,
    );
    expect(() => rulesDocument(context, { role: "human" })).toThrow(RulesArgumentError);
    expect(() => rulesDocument(context, { rule: "D-HUMAN-ASK", role: "implementer" })).toThrow(
      "D-HUMAN-ASK names role(s) human, so --role implementer excludes it",
    );
    expect(ruleIds(model)).toContain("D-DENY-PLATFORM");
  });
});

describe("pdb rules command (#416)", () => {
  it("prints the complete listing on stdout only, without GitHub", async () => {
    const { code, stdout, stderr } = await cli(["rules"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.split("\n")[0]).toBe("# `pdb rules` — Compiled Policy");
    expect(stdout).not.toContain("briefing.engine");
    expect(stdout).toContain('- `--order` = `"impact"` (briefing, when --order is omitted)');
  });

  it("prints JSON projecting the same document", async () => {
    const { code, stdout } = await cli(["rules", "--json"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.policy.rulesHash).toBe(model.rulesHash);
    expect(json.decisions.map((d: { id: string }) => d.id)).toEqual(
      model.decisions.map((d) => d.id),
    );
    expect(json.scope.complete).toBe(true);
    expect(json.defaults.effective.status).toBe("unknown");
  });

  it("exits 2 with only stderr for invalid arguments and unknown rules", async () => {
    for (const args of [
      ["--rule", "D-NOPE"],
      ["--role", "human"],
      ["--bogus"],
      ["extra"],
      ["--rule"],
    ]) {
      const { code, stdout, stderr } = await cli(["rules", ...args]);
      expect(code, args.join(" ")).toBe(2);
      expect(stdout, args.join(" ")).toBe("");
      expect(stderr, args.join(" ")).toMatch(/^pdb rules: /);
    }
  });

  it("has its own help, and the main help and pdb process cross-link", async () => {
    const help = await cli(["rules", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(
      /^Usage: pdb rules \[--json\] \[--rule ID\] \[--role implementer\|designer\]/,
    );
    expect(help.stdout).toContain("pdb process is the short workflow");
    const main = await cli(["--help"]);
    expect(main.stdout).toContain("rules [--json] [--rule ID] [--role R]");
    const process = await cli(["process"]);
    expect(process.stdout).toContain("pdb rules");
  });

  it("shows a predicate alternative over different head variables with its own head", () => {
    const base = shippedModel();
    const blocked = base.predicates.find((p) => p.name === "blocked");
    if (!blocked) throw new Error("blocked predicate missing");
    const renamed = {
      ...blocked,
      alternatives: [blocked.alternatives[0], { ...blocked.alternatives[1], params: ["?x"] }],
    };
    const doc = rulesDocument(
      context,
      { rule: "blocked" },
      { ...base, predicates: base.predicates.map((p) => (p === blocked ? renamed : p)) },
    );
    const out = rulesText(doc);
    expect(out).toContain("1. all of:");
    expect(out).toContain("2. `blocked(?x)` all of:");
  });

  it("renders Markdown safely by escaping injected headings, HTML, links, backticks and ANSI (#1049)", async () => {
    const doc = rulesDocument({
      ...context,
      effective: {
        status: "unknown",
        reason:
          "bad\n# Fake Heading\n[link](https://x) <img src=x> &lt;urgent&gt; \x1b[31mred\x1b[0m",
      },
    });
    const out = rulesText(doc);
    expect(out).not.toContain("\n# Fake Heading");
    expect(out).not.toContain("\x1b[31m");
    expect(out).toContain("\\[link\\]\\(https://x\\)");
    expect(out).toContain("\\<img src=x\\>");
    expect(out).toContain("\\&lt;urgent\\&gt;");
    const help = await cli(["rules", "--help"]);
    expect(help.stdout).toContain("Markdown");
  });

  it("indents children of multi-digit numbered alternatives to match their CommonMark marker width", () => {
    const out = rulesText(rulesDocument(context, { rule: "pr-specific-blocker" }));
    expect(out).toContain("\n10. all of:\n    - ");
    expect(out).not.toContain("\n10. all of:\n   - ");
  });

  it("exposes procedural obligations in full and --rule filtered views (#1029)", () => {
    const full = rulesText(rulesDocument(context));
    expect(full).toContain("## Procedural obligations (");
    expect(full).toContain("`O-CLAIM-NOOP-CONTINUE`");

    const single = rulesText(rulesDocument(context, { rule: "O-CLAIM-NOOP-CONTINUE" }));
    expect(single).toContain("## Procedural obligations (1)");
    expect(single).toContain("`O-CLAIM-NOOP-CONTINUE`");
  });

  it("defines every predicate a filtered view names, context included (#480 review)", () => {
    const names = new Set(model.predicates.map((p) => p.name));
    const filters = [
      ...model.decisions.map((d) => ({ rule: d.id })),
      ...model.denials.map((d) => ({ rule: d.id })),
      ...model.predicates.map((p) => ({ rule: p.name })),
      { role: "implementer" },
      { role: "designer" },
    ];
    for (const filter of filters) {
      const doc = rulesDocument(context, filter);
      const out = rulesText(doc);
      const glossary = new Set(doc.predicates.map((p) => p.name));
      // Every predicate call rendered anywhere, as name(...), must be defined in the glossary.
      const called = [...out.matchAll(/(?<![\w-])([a-z][a-z-]*)\((?=[?"\d_a])/g)]
        .map((m) => m[1])
        .filter((n) => names.has(n));
      for (const n of called) expect(glossary.has(n), `${JSON.stringify(filter)}: ${n}`).toBe(true);
    }
  });
});
