import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { argumentsFor, main } from "../cli.js";
import { CONFIG_PATH, type ConfigFileSystem, type GitRunner } from "../config/config.js";
import {
  commandRegistry,
  compactGuide,
  guideRules,
  MAX_GUIDE_CODE_POINTS,
  mutatingCommands,
  policyVersion,
  resolveGuideSetting,
} from "./process.js";
import { createGitService } from "../git/service.js";
import { pickupPolicy } from "./ranking.js";
import { clock, repo, snapshot } from "../testing/snapshots.js";

describe("workflow guide in help and briefings (#71, doc/design/workflow-guide.md)", () => {
  const root = "/checkout";
  const gitFor =
    (remote = `https://github.com/${repo}.git`): GitRunner =>
    async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : `origin\t${remote} (fetch)\n`;
  const fsWith = (raw: string | null): ConfigFileSystem => ({
    readText: async (file) => (file === join(root, CONFIG_PATH) ? raw : null),
    writeText: async () => {
      throw new Error("guide must never write configuration");
    },
    rename: async () => {
      throw new Error("guide must never write configuration");
    },
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  });
  const run = async (args: string[], raw: string | null, remote?: string) => {
    // Isolate guide rendering/budget behavior from the default decision engine's evaluation cost.
    let guideConfig = raw;
    try {
      const parsed = JSON.parse(raw ?? '{"schemaVersion":1}') as Record<string, unknown>;
      guideConfig = JSON.stringify({ ...parsed, briefing: { engine: "typescript" } });
    } catch {
      /* Malformed guide inputs deliberately remain malformed. */
    }
    let out = "";
    const code = await main(["--no-update-check", ...args], async (t) => void (out = t), {
      collect: async () => snapshot(),
      currentRepository: async () => repo,
      // A fixed clock keeps freshness.ageSeconds identical across runs that are compared (#422).
      now: clock,
      estimation: { fs: fsWith(null), git: gitFor(remote), cwd: root },
      guide: { fs: fsWith(guideConfig), git: gitFor(remote), cwd: root },
    });
    return { code, out };
  };

  it("keeps the guide off by default and explicitly enables generated policy guidance", async () => {
    const disabled = JSON.parse((await run(["--json"], null)).out);
    expect(disabled.process).toMatchObject({ enabled: false, source: "default", guide: null });
    expect((await run([], null)).out).not.toContain("WORKFLOW\n");
    const { code, out } = await run(["--json", "--guide"], null);
    expect(code).toBe(0);
    const process_ = JSON.parse(out).process;
    expect(process_).toMatchObject({ schemaVersion: 1, enabled: true, source: "cli" });
    expect(process_.policyVersion).toBe(policyVersion());
    expect(Array.from(process_.guide as string).length).toBeLessThanOrEqual(MAX_GUIDE_CODE_POINTS);
    expect(process_.guideCodePoints).toBe(Array.from(process_.guide as string).length);
    for (const label of pickupPolicy.available) expect(process_.guide).toContain(label);
    for (const name of mutatingCommands()) expect(process_.guide).toContain(name);
    const text = (await run(["--guide"], null)).out;
    expect(text).toContain("WORKFLOW\n- Order:");
    expect(text).toContain("pdb process");
  });

  it("only advertises implemented commands", () => {
    const templates = commandRegistry.map((c) => c.template.split(" ")[1]);
    for (const line of compactGuide().split("\n"))
      for (const match of line.matchAll(/pdb (\S+)/g)) expect(templates).toContain(match[1]);
  });

  it("honours the processGuide opt-out without changing the briefing evidence", async () => {
    const on = JSON.parse((await run(["--json"], null)).out);
    const off = JSON.parse((await run(["--json"], '{"schemaVersion":1,"processGuide":false}')).out);
    expect(off.process).toMatchObject({ enabled: false, source: "config", guide: null });
    expect(off.process.pointer).toContain(off.process.policyVersion);
    // Both runs read the injected clock, not the wall clock, so their freshness is identical.
    expect(on.freshness.ageSeconds).toBe(off.freshness.ageSeconds);
    expect(on.freshness.ageSeconds).toBe(0);
    const { process: _a, ...restOn } = on;
    const { process: _b, ...restOff } = off;
    expect(restOff).toEqual(restOn);
    const text = (await run([], '{"schemaVersion":1,"processGuide":false}')).out;
    expect(text).not.toContain("WORKFLOW\n");
    expect(text).not.toContain("Workflow guide off");
  });

  it("lets CLI flags override configuration, even when it is invalid, and refuses both", async () => {
    const forced = JSON.parse(
      (await run(["--json", "--guide"], '{"schemaVersion":1,"processGuide":false}')).out,
    );
    expect(forced.process).toMatchObject({ enabled: true, source: "cli" });
    const hidden = JSON.parse((await run(["--json", "--no-guide", "--issue", "1"], "{oops")).out);
    expect(hidden.process).toMatchObject({ enabled: false, source: "cli", diagnostics: [] });
    expect(() => argumentsFor(["--guide", "--no-guide"])).toThrow(/either --guide or --no-guide/);
  });

  it("falls back to the default with a diagnostic for malformed, future, unknown or mismatched config", async () => {
    for (const raw of [
      "{oops",
      '{"schemaVersion":99}',
      '{"schemaVersion":1,"surprise":true}',
      '{"schemaVersion":1,"processGuide":"no"}',
    ]) {
      const { code, out } = await run(["--json", "--issue", "1"], raw);
      expect(code).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed.process).toMatchObject({ enabled: false, source: "default" });
      expect(parsed.process.diagnostics[0]).toMatch(/not applied/);
      expect(parsed.completeness.complete).toBe(true);
    }
    const other = JSON.parse(
      (await run(["--json"], '{"schemaVersion":1,"processGuide":false}', "git@github.com:a/b.git"))
        .out,
    );
    expect(other.process).toMatchObject({ enabled: false, source: "default" });
    expect(other.process.diagnostics[0]).toMatch(/No matching local project setting/);
    expect((await run(["--issue", "1"], "{oops")).out).toContain(
      "CONFIG: Repository configuration not applied",
    );
  });

  it("counts against the text budget and reports omission instead of truncating", async () => {
    const { out } = await run(["--guide", "--max-chars", "600"], null);
    expect(out).not.toContain("WORKFLOW\n");
    expect(out).toContain("Workflow guide omitted by text budget. Full guide: pdb process");
  });

  it("never exceeds --max-chars with the guide on or off, including small budgets (#71, #379)", async () => {
    const off = '{"schemaVersion":1,"processGuide":false}';
    for (const raw of ['{"schemaVersion":1,"processGuide":true}', off]) {
      for (const max of [
        1,
        2,
        12,
        31,
        80,
        175,
        ...Array.from({ length: 32 }, (_, i) => 200 + i * 97),
      ]) {
        const { out } = await run(["--max-chars", String(max)], raw);
        expect(
          out.length,
          `max-chars ${max}, guide ${raw === off ? "off" : "on"}`,
        ).toBeLessThanOrEqual(max);
        expect(out.length, `max-chars ${max}`).toBeGreaterThan(0);
        if (raw === off) expect(out).not.toContain("Workflow guide off");
        else if (max >= 350) expect(out).toContain("pdb process");
        else expect(out).toMatch(/…|\[truncated\]|Truncated due to maximum size/);
      }
    }
  });

  it("serves help and the full guide locally, without GitHub or configuration", async () => {
    let helpText = "";
    let guide = "";
    let json = "";
    const offline = {
      collect: async () => {
        throw new Error("no network");
      },
      currentRepository: async () => {
        throw new Error("no network");
      },
    };
    expect(await main(["--help"], async (t) => void (helpText = t), offline)).toBe(0);
    expect(await main(["process"], async (t) => void (guide = t), offline)).toBe(0);
    expect(await main(["process", "--json"], async (t) => void (json = t), offline)).toBe(0);
    expect(helpText).toContain("Workflow (generated from the registered policy):");
    expect(helpText).toContain(`only ${mutatingCommands().join(", ")} do`);
    expect(guide).toContain(`policy ${policyVersion()}`);
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, policyVersion: policyVersion() });
  });

  it("changes the policy version with semantics, not with rendering", () => {
    const rules = guideRules();
    expect(policyVersion(rules)).toBe(policyVersion(guideRules()));
    const changed = rules.map((rule) =>
      rule.id === "one-claim" ? { ...rule, parameters: { staleHours: 72 } } : rule,
    );
    expect(policyVersion(changed)).not.toBe(policyVersion(rules));
    const reordered = rules.map((rule) => ({
      detail: rule.detail,
      summary: rule.summary,
      parameters: rule.parameters,
      id: rule.id,
    }));
    expect(policyVersion(reordered)).toBe(policyVersion(rules));
  });

  it("resolves guide settings through a typed GitService (#901)", async () => {
    const fs: ConfigFileSystem = {
      readText: async (file) =>
        file === join(root, CONFIG_PATH)
          ? JSON.stringify({ schemaVersion: 1, processGuide: true })
          : null,
      writeText: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const gitService = createGitService({ git: gitFor() });
    const setting = await resolveGuideSetting(repo, undefined, { cwd: root, fs, gitService });
    expect(setting).toEqual({ enabled: true, source: "config", diagnostics: [] });
  });
});
