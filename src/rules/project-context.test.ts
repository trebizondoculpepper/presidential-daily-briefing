/**
 * Effective English for native project preferences (#516 part 2): the `pdb rules` document,
 * `pdb rules init`, and the serve rules page naming the same revision as the briefing.
 * Synthetic checkouts in temporary directories; no GitHub, no real configuration.
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { emptyFileSystem } from "../../scripts/benchmark-isolation.js";
import { compileProjectPolicy } from "./datalog/project/compile.js";
import { effectivePolicy } from "./datalog/project/effective.js";
import { policyVersion, rulesHash } from "./datalog/engine.js";
import { rulesDocument, rulesText } from "./datalog/rules-command.js";
import type { ProjectRulesView } from "./datalog/rules-command.js";
import { declaredRulesContext } from "./declared-context.js";
import { projectRulesContext } from "./project-context.js";
import { rulesPage } from "../serve/rules-page.js";
import { selectRepository } from "../serve/api.js";

const repository = "example/project";
const base = { policyVersion, rulesHash };
const fixture = readFileSync(
  new URL("../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
).replace(/:base-rules-hash "[0-9a-f]{64}"/, `:base-rules-hash "${rulesHash}"`);
const policy = compileProjectPolicy(fixture, base);
const active: ProjectRulesView = { state: "active", policy };

const gitAt =
  (root: string): GitRunner =>
  async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${root}\n`;
    if (command === "remote -v") return `origin\thttps://github.com/${repository}.git (fetch)\n`;
    throw new Error(`unexpected git ${command}`);
  };
const configFs = (enabled: boolean, engine = "datalog"): ConfigFileSystem => ({
  ...emptyFileSystem,
  readText: async (path) =>
    path.endsWith("triage.toml")
      ? `schemaVersion = 1\n[briefing]\nengine = "${engine}"\n[rules.project]\nenabled = ${enabled}\n`
      : null,
});

describe("effective English document (#516)", () => {
  it("renders an active project's preferences, helpers, limits and composite identity", async () => {
    const { limits } = await projectRulesContext({ unknown: "not used" });
    const doc = rulesDocument(
      { ...declaredRulesContext(), project: active },
      {},
      undefined,
      limits,
    );
    expect(doc.effectivePolicy).toMatchObject({
      state: "active",
      source: "pdb.rules.edn",
      defaultRulesHash: rulesHash,
      projectRulesHash: policy.projectRulesHash,
      effectiveRulesHash: policy.effectiveRulesHash,
      reason: null,
    });
    expect(doc.policy.rulesHash).toBe(rulesHash);
    expect(doc.project?.preferences.map((p) => p.id)).toEqual(["project-hotfix"]);
    expect(doc.project?.preferences[0]!.when).toContain("project-hotfix");
    expect(doc.project?.helpers.map((h) => h.name)).toEqual(["project-hotfix"]);
    expect(doc.project?.limits?.protectedBands).toEqual([1, 2]);
    const text = rulesText(doc);
    expect(text).toContain(`\`effectiveRulesHash\` \`${policy.effectiveRulesHash}\``);
    expect(text).toContain("## Project preferences (1)");
    expect(text).toContain("`project-hotfix`");
    expect(text).toContain("Project priority label matched:");
    expect(text).toContain("Protected bands 1 and 2");
    expect(text).toContain("`pdb.action-label`: collected label");
  });

  it("selects one project preference by ID, and suggests project IDs", () => {
    const doc = rulesDocument(
      { ...declaredRulesContext(), project: active },
      { rule: "project-hotfix" },
    );
    expect(doc.scope.selected).toEqual({ id: "project-hotfix", type: "project-preference" });
    expect(doc.decisions).toEqual([]);
    expect(doc.project?.preferences.map((p) => p.id)).toEqual(["project-hotfix"]);
    expect(doc.project?.helpers.map((h) => h.name)).toEqual(["project-hotfix"]);
    expect(() =>
      rulesDocument({ ...declaredRulesContext(), project: active }, { rule: "hotfix" }),
    ).toThrow("Did you mean: project-hotfix");
    // Project IDs are not accepted when no project policy is active.
    expect(() =>
      rulesDocument(
        { ...declaredRulesContext(), project: { state: "disabled", reason: "off" } },
        { rule: "project-hotfix" },
      ),
    ).toThrow("unknown rule");
    // A default rule selection shows no project preference.
    const d = rulesDocument(
      { ...declaredRulesContext(), project: active },
      { rule: "D-ATTENTION" },
    );
    expect(d.project?.preferences).toEqual([]);
  });

  it("never presents a default-only listing as the effective policy", () => {
    const unknown = rulesDocument(declaredRulesContext());
    expect(unknown.effectivePolicy).toMatchObject({ state: "unknown", effectiveRulesHash: null });
    expect(rulesText(unknown)).toContain("Effective policy: unknown.");
    const disabled = rulesDocument({
      ...declaredRulesContext(),
      project: { state: "disabled", reason: "rules.project.enabled is false" },
    });
    expect(disabled.effectivePolicy.effectiveRulesHash).toBe(rulesHash);
    expect(rulesText(disabled)).toContain("Effective policy: the shipped default only");
    const error = rulesDocument({
      ...declaredRulesContext(),
      project: {
        state: "error",
        reason: "pdb.rules.edn: base-rules-hash: Inspect it",
        next: ["repair"],
      },
    });
    expect(error.project).toBeNull();
    expect(error.effectivePolicy).toMatchObject({ state: "error", effectiveRulesHash: null });
    expect(rulesText(error)).toContain("Effective policy: ERROR.");
  });
});

describe("pdb rules init and surface parity (#516)", () => {
  it("writes a valid starter once, never overwrites, and the CLI, page and briefing agree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-516-rules-"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const runtime = (enabled: boolean) =>
        ({
          guide: { cwd: dir, git: gitAt(dir), fs: configFs(enabled) },
          stderr: (t: string) => void err.push(t),
        }) as never;
      expect(await main(["rules", "init"], async (t) => void out.push(t), runtime(false))).toBe(0);
      expect(out.join("")).toContain("pdb config set rules.project.enabled true");
      const written = await readFile(join(dir, "pdb.rules.edn"), "utf8");
      const starter = compileProjectPolicy(written, base);
      expect(starter.defaultRulesHash).toBe(rulesHash);
      // A second run, or a symlink in its place, is refused and changes nothing.
      expect(await main(["rules", "init"], async () => undefined, runtime(false))).toBe(1);
      expect(err.join("")).toContain("already exists");
      expect(await readFile(join(dir, "pdb.rules.edn"), "utf8")).toBe(written);

      // Disabled: the file alone enables nothing.
      const disabledJson: string[] = [];
      await main(["rules", "--json"], async (t) => void disabledJson.push(t), runtime(false));
      expect(JSON.parse(disabledJson.join("")).effectivePolicy.state).toBe("disabled");

      // Enabled: CLI, the serve page and the briefing name one effective revision.
      const json: string[] = [];
      expect(await main(["rules", "--json"], async (t) => void json.push(t), runtime(true))).toBe(
        0,
      );
      const cli = JSON.parse(json.join(""));
      expect(cli.effectivePolicy).toMatchObject({
        state: "active",
        effectiveRulesHash: starter.effectiveRulesHash,
      });
      const page = await rulesPage(
        new URLSearchParams({ repo: repository }),
        "http://127.0.0.1:4372",
        [{ repository, project: dir }],
        { git: gitAt(dir), fs: configFs(true) },
        selectRepository,
      );
      expect(page.status).toBe(200);
      expect(page.html).toContain(starter.effectiveRulesHash);
      expect(page.html).toContain("Project preferences (1)");
      const briefing = await effectivePolicy(
        { enabled: true, source: "config", root: dir },
        [],
        new Map(),
        {
          base,
          role: "implementer",
          order: "impact",
        },
      );
      expect(briefing.manifest.effectiveRulesHash).toBe(cli.effectivePolicy.effectiveRulesHash);

      // #1050: a stored retired engine key never stops project preferences from applying.
      const stale: string[] = [];
      await main(["rules", "--json"], async (t) => void stale.push(t), {
        guide: { cwd: dir, git: gitAt(dir), fs: configFs(true, "typescript") },
      } as never);
      expect(JSON.parse(stale.join("")).effectivePolicy).toMatchObject({
        state: "active",
        effectiveRulesHash: cli.effectivePolicy.effectiveRulesHash,
      });

      // A repo-only served project is unknown, never shown as default-only effective policy.
      const remote = await rulesPage(
        new URLSearchParams({ repo: repository }),
        "http://127.0.0.1:4372",
        [{ repository }],
        { git: gitAt(dir), fs: configFs(true) },
        selectRepository,
      );
      expect(remote.html).toContain("Effective policy</dt><dd>unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink and outside a checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-516-init-"));
    try {
      await writeFile(join(dir, "target.edn"), "keep");
      await symlink(join(dir, "target.edn"), join(dir, "pdb.rules.edn"));
      const err: string[] = [];
      const runtime = {
        guide: { cwd: dir, git: gitAt(dir), fs: configFs(false) },
        stderr: (t: string) => void err.push(t),
      } as never;
      expect(await main(["rules", "init"], async () => undefined, runtime)).toBe(1);
      expect(await readFile(join(dir, "target.edn"), "utf8")).toBe("keep");
      const outside = {
        guide: {
          cwd: dir,
          git: (async () => {
            throw new Error("not a git repository");
          }) as GitRunner,
          fs: configFs(false),
        },
        stderr: (t: string) => void err.push(t),
      } as never;
      expect(await main(["rules", "init"], async () => undefined, outside)).toBe(2);
      expect(err.join("")).toContain("no file was written");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
