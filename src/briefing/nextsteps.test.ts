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
    expect(plain).toMatch(/\nNEXT STEPS \(\d+; \d+ omitted\)\n- #\d+ Ticket \d+ — /);
    expect(plain).toMatch(/\n {2}Why: .+\n {2}Next: pdb /);
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
});
