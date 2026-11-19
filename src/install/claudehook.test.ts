/**
 * Claude Stop hook registration (#771): the owned `hooks.Stop` entry in the scope's Claude
 * settings file and the install/uninstall wiring over the shared manifest primitives. Injected
 * temp filesystem only; no real client configuration or trust is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import type { InstallScope } from "./manifest.js";
import { manifestPath } from "./manifest.js";
import {
  claudeHookAdapter,
  claudeStopCommand,
  claudeStopEntry,
  installClaudeStopHook,
  uninstallClaudeStopHook,
} from "./claudehook.js";

const fixedNow = () => new Date("2026-11-19T00:00:00.000Z");

const projectScope = (root: string): InstallScope => ({
  kind: "project",
  root,
  gitCommonDir: join(root, ".git"),
});

async function tmpProject(): Promise<{ dir: string; scope: InstallScope }> {
  const dir = await mkdtemp(join(tmpdir(), "pdb-claudehook-"));
  await nodeSafeFs.mkdir(join(dir, ".claude"));
  await nodeSafeFs.mkdir(join(dir, ".git"));
  return { dir, scope: projectScope(dir) };
}

const settingsFile = (dir: string) => join(dir, ".claude", "settings.local.json");

describe("claude Stop hook entry shape (#771)", () => {
  it("renders the owned command with --installed and no paths or session", () => {
    expect(claudeStopCommand({})).toBe("pdb rebrief claude-stop --installed --deadline-ms 4000");
    expect(claudeStopCommand({ role: "implementer", entry: "claude" })).toBe(
      "pdb rebrief claude-stop --installed --deadline-ms 4000 --role implementer --entry claude",
    );
    // The owned entry is a matcher group wrapping one command entry under hooks.Stop (native
    // Claude Code shape: event -> matcher group -> handler).
    expect(claudeStopEntry("pdb rebrief claude-stop --installed")).toEqual([
      {
        hooks: [{ type: "command", command: "pdb rebrief claude-stop --installed", timeout: 10 }],
      },
    ]);
  });

  it("classifies a missing Stop key as absent (create) and a PDB one as owned", () => {
    const adapter = claudeHookAdapter(claudeStopCommand({}));
    expect(adapter.inspect({})).toEqual({ canonicalText: null, looksForeign: false });
    expect(adapter.inspect({ hooks: {} })).toEqual({
      canonicalText: null,
      looksForeign: false,
    });
    // A claude-stop invocation without a manifest record is PDB-foreign.
    const foreign = adapter.inspect({
      hooks: { Stop: claudeStopEntry("pdb rebrief claude-stop --old") },
    });
    expect(foreign.looksForeign).toBe(true);
    expect(foreign.canonicalText).toContain("claude-stop");
    // An unrelated non-PDB Stop command is absent with respect to PDB (preserved, not foreign).
    const unrelated = adapter.inspect({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] },
    });
    expect(unrelated.looksForeign).toBe(false);
    expect(unrelated.canonicalText).toBeNull();
  });

  it("validates an unsupported top-level shape", () => {
    const adapter = claudeHookAdapter(claudeStopCommand({}));
    expect(adapter.validateSchema?.({ hooks: 4 })).toBe("hooks must be a JSON object.");
    expect(adapter.validateSchema?.({})).toBeNull();
    // A Stop value that is not an array is refused, not silently replaced.
    expect(adapter.validateSchema?.({ hooks: { Stop: "not-an-array" } })).toBe(
      "Stop must be a JSON array of matcher groups.",
    );
  });
});

describe("installClaudeStopHook / uninstallClaudeStopHook (#771)", () => {
  it("creates the owned Stop entry, preserves unrelated hooks, then uninstalls only it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = settingsFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify(
          {
            hooks: {
              SessionStart: [{ type: "command", command: "setup" }],
              Stop: [{ hooks: [{ type: "command", command: "unrelated-hook" }] }],
            },
          },
          null,
          2,
        ),
      );
      const manifest = manifestPath(scope, "claude");
      const installed = await installClaudeStopHook({
        scope,
        options: { role: "implementer", entry: "claude" },
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(installed.hook.outcome).toBe("applied");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      // Unrelated events and hooks survive; the owned Stop entry was appended.
      expect(doc.hooks.SessionStart).toEqual([{ type: "command", command: "setup" }]);
      const stopCommands = doc.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h: { command: string }) => h.command),
      );
      expect(stopCommands).toContain("unrelated-hook");
      expect(stopCommands.some((c: string) => c.includes("claude-stop"))).toBe(true);

      const removed = await uninstallClaudeStopHook({
        scope,
        manifestPath: manifest,
        runtime: { now: fixedNow },
      });
      expect(removed.hook).toMatchObject({
        outcome: "applied",
        action: "remove",
        ownership: "owned",
      });
      const after = JSON.parse(await nodeSafeFs.readFile(file));
      const afterCommands = after.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h: { command: string }) => h.command),
      );
      expect(afterCommands).toEqual(["unrelated-hook"]);
      expect(after.hooks.SessionStart).toEqual([{ type: "command", command: "setup" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dry-run plans without writing", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = settingsFile(dir);
      await nodeSafeFs.createSynced(file, "{}");
      const manifest = manifestPath(scope, "claude");
      const dry = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        dryRun: true,
        runtime: { now: fixedNow },
      });
      expect(dry.hook.outcome).toBe("planned");
      expect(await nodeSafeFs.readFile(file)).toBe("{}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the owned current entry on rerun", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const manifest = manifestPath(scope, "claude");
      const first = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(first.hook.outcome).toBe("applied");
      const again = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(again.hook.outcome).toBe("kept");
      expect(again.hook.action).toBe("kept");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a PDB-foreign Stop entry and never overwrites it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = settingsFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "pdb rebrief claude-stop --old" }] }],
          },
        }),
      );
      const manifest = manifestPath(scope, "claude");
      const refused = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(refused.hook.outcome).toBe("refused");
      expect(refused.hook.code).toBe("FOREIGN_ENTRY");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      expect(doc.hooks.Stop[0].hooks[0].command).toBe("pdb rebrief claude-stop --old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts an existing PDB-lookalike Stop entry when adopt is requested, without rewriting it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = settingsFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "pdb rebrief claude-stop --old" }] }],
          },
        }),
      );
      const manifest = manifestPath(scope, "claude");
      const adopted = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        adopt: true,
        runtime: { now: fixedNow },
      });
      expect(adopted.hook.outcome).toBe("adopted");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      expect(doc.hooks.Stop[0].hooks[0].command).toBe("pdb rebrief claude-stop --old");
      // A later install now replaces the adopted entry with the owned command.
      const later = await installClaudeStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(later.hook.outcome).toBe("applied");
      const after = JSON.parse(await nodeSafeFs.readFile(file));
      expect(
        after.hooks.Stop.some((g: { hooks: { command: string }[] }) =>
          g.hooks.some((h: { command: string }) => h.command.includes("--installed")),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
