/**
 * Next steps are the default role view (#355, doc/design/next-steps-only.md): the compact text
 * holds the ranked next steps, a repository/role identifier and material warnings; background,
 * totals and engine metadata need --context (CLI) or context: true (MCP). JSON never changes.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { argumentsFor, main } from "../cli.js";
import { CONFIG_PATH, type ConfigFileSystem, type GitRunner } from "../config/config.js";
import { briefingView } from "../mcp/views.js";
import type { Snapshot } from "../github/types.js";
import { issue, repo, snapshot, time } from "../testing/snapshots.js";

const root = "/repo";
const files = (engine: "datalog" | "typescript"): ConfigFileSystem => ({
  readText: async (file) =>
    file === join(root, CONFIG_PATH)
      ? JSON.stringify({ schemaVersion: 1, briefing: { engine } })
      : null,
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const run = async (data: Snapshot, engine: "datalog" | "typescript", args: string[]) => {
  let out = "";
  const code = await main(["--no-update-check", ...args], async (t) => void (out = t), {
    collect: async () => data,
    currentRepository: async () => repo,
    now: () => new Date(time),
    estimation: { fs: files(engine), git, cwd: root },
    guide: { fs: files(engine), git, cwd: root },
  });
  return { code, out };
};
const populated = () => snapshot([issue(1), issue(2, ["status:parked"]), issue(3)], []);

describe("next steps only by default (#355)", () => {
  for (const engine of ["datalog", "typescript"] as const)
    for (const role of ["implementer", "designer"] as const)
      it(`${engine} ${role}: next steps and identifier only; --context restores the background`, async () => {
        const plain = (await run(populated(), engine, ["--role", role])).out;
        expect(plain.split("\n")[0]).toBe(
          `${repo} — ${role} next steps (fetched ${populated().fetchedAt})`,
        );
        // No totals, role question, background sections, assessment counts or engine banner.
        expect(plain).not.toMatch(/issues; \d+ PRs; \d+ findings/);
        expect(plain).not.toMatch(/^Role (implementer|designer):/m);
        expect(plain).not.toContain("OTHER CONTEXT");
        expect(plain).not.toContain("Decision engine:");
        expect(plain).not.toMatch(/^- (Impact|Complexity) assessment:/m);
        const context = (await run(populated(), engine, ["--role", role, "--context"])).out;
        expect(context).toMatch(/issues; \d+ PRs; \d+ findings/);
        expect(context).toMatch(new RegExp(`^Role ${role}:`, "m"));
        if (engine === "datalog") expect(context).toContain("Decision engine: Datalog");
        // Presentation only: the JSON report is identical with and without --context.
        const json = (await run(populated(), engine, ["--role", role, "--json"])).out;
        const jsonContext = (
          await run(populated(), engine, ["--role", role, "--json", "--context"])
        ).out;
        expect(jsonContext).toBe(json);
      });

  it("keeps the ranked steps, their reasons and commands, and nonzero omissions", async () => {
    const plain = (await run(populated(), "datalog", ["--limit", "1"])).out;
    expect(plain).toMatch(
      /\nNEXT STEPS \(\d+; \d+ omitted\)\n1\. [A-Z][a-z ]+ #\d+: Ticket \d+\n {3}.+\n {3}Next: pdb .+--repo /,
    );
  });

  it("says no next steps were found, and never implies no work when evidence is incomplete", async () => {
    const empty = snapshot([issue(1, ["status:parked"])], []);
    expect((await run(empty, "datalog", [])).out).toContain("\nNo next steps found.");
    const incomplete = { ...empty, warnings: ["Change evidence incomplete: test"] };
    const text = (await run(incomplete, "datalog", [])).out;
    expect(text).toContain(
      "No next steps found, but evidence is incomplete: this does not mean no work exists.",
    );
  });

  it("parses --context as a presentation flag", () => {
    expect(argumentsFor(["--context"]).context).toBe(true);
    expect(argumentsFor([]).context).toBeUndefined();
  });

  it("MCP text follows the same default; context: true restores the background lines", () => {
    const report = {
      schemaVersion: 2,
      freshness: { fetchedAt: time },
      completeness: { complete: true, warnings: [] },
      rankedActions: { total: 0, omitted: 0, items: [] },
      actions: { items: ["https://github.com/o/r/issues/1"] },
      sections: {},
      subjects: [],
    };
    const base = { repository: "o/r" } as Parameters<typeof briefingView>[0];
    const presentation = {} as Parameters<ReturnType<typeof briefingView>["text"]>[1];
    const plain = briefingView(base, report).text(report, presentation).join("\n");
    expect(plain).toContain("No next steps found.");
    expect(plain).not.toContain("Action targets");
    expect(plain).not.toContain("Subjects:");
    const context = briefingView(base, report, { context: true })
      .text(report, presentation)
      .join("\n");
    expect(context).toContain("Action targets");
    expect(context).toContain("Subjects:");
  });

  it("renders lean rows (#487): rank, label, title, one reason, commands, link; no metrics or codes", async () => {
    const plain = (await run(populated(), "datalog", ["--role", "implementer"])).out;
    const rows = plain.slice(plain.indexOf("NEXT STEPS"));
    expect(rows).toMatch(/\n1\. (Implement|Estimate complexity) #\d+: Ticket \d+\n/);
    // No paired metric line, reason-code lists or zero-only unlock decoration by default.
    expect(rows).not.toMatch(/impact \w+ · complexity/);
    expect(rows).not.toMatch(/\((ordinary|assessment|easy-win)[,)]/);
    expect(rows).not.toContain("unlocks at least 0");
    expect(rows).not.toMatch(/^- #/m);
    // --context keeps the detailed rows.
    const context = (await run(populated(), "datalog", ["--role", "implementer", "--context"])).out;
    expect(context).toMatch(/impact \w+ · complexity/);
    expect(context).toMatch(/^- #\d+ Ticket \d+ — \S+ \(/m);
  });

  it("shows unlock evidence only when it is positive or uncertain", async () => {
    const { leanRow } = await import("./leanrows.js");
    const base = {
      kind: "implement",
      target: "https://github.com/o/r/issues/7",
      nextCommand: "pdb claim 7 --repo o/r",
    };
    const subject = { number: 7, title: "Seven" };
    expect(leanRow(2, { ...base, unlocks: 0, unlocksUnknown: [] }, subject, "Why.")).toBe(
      "2. Implement #7: Seven\n   Why.\n   Next: pdb claim 7 --repo o/r\n   https://github.com/o/r/issues/7",
    );
    expect(leanRow(1, { ...base, unlocks: 2, unlocksUnknown: [] }, subject, "Why.")).toContain(
      "   Unlocks 2 otherwise-ready ticket(s).",
    );
    expect(
      leanRow(1, { ...base, unlocks: 1, unlocksUnknown: ["#9 evidence incomplete"] }, subject, "W"),
    ).toContain("   Unlocks at least 1 otherwise-ready ticket(s).");
    expect(
      leanRow(1, { ...base, unlocks: 0, unlocksUnknown: ["#9 evidence incomplete"] }, subject, "W"),
    ).toContain("   Unlocks unknown: #9 evidence incomplete.");
    // Without a command the inspection path stays; the reason is never invented.
    const inspect = leanRow(
      1,
      { kind: "inspect", target: base.target, inspection: "pdb --issue 7 --json" },
      subject,
      null,
    );
    expect(inspect).toBe(
      "1. Inspect #7: Seven\n   Inspect: pdb --issue 7 --json\n   https://github.com/o/r/issues/7",
    );
  });

  it("CLI and MCP default text render the same lean rows", async () => {
    const json = JSON.parse(
      (await run(populated(), "datalog", ["--role", "implementer", "--json"])).out,
    );
    const cli = (await run(populated(), "datalog", ["--role", "implementer"])).out;
    const base = { repository: repo } as Parameters<typeof briefingView>[0];
    const presentation = {} as Parameters<ReturnType<typeof briefingView>["text"]>[1];
    const view = briefingView(base, json);
    const mcp = view.text(json, presentation).join("\n");
    const rowsOf = (text: string) => text.split("\n").filter((l) => /^(\d+\. | {3})/.test(l));
    expect(rowsOf(mcp)).toEqual(rowsOf(cli));
    expect(rowsOf(mcp).length).toBeGreaterThan(0);
  });
});
