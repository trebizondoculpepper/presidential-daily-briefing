/**
 * Codex Stop hook registration (#770): the owned `hooks.json` Stop entry and the
 * install/uninstall wiring over the shared manifest primitives. Injected temp
 * filesystem only; no real client configuration or trust is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import type { InstallScope } from "./manifest.js";
import { manifestPath } from "./manifest.js";
import {
  codexHookAdapter,
  codexStopCommand,
  codexStopGroup,
  installCodexStopHook,
  uninstallCodexStopHook,
} from "./codexhook.js";

const fixedNow = () => new Date("2026-11-19T00:00:00.000Z");

const projectScope = (root: string): InstallScope => ({
  kind: "project",
  root,
  gitCommonDir: join(root, ".git"),
});

async function tmpProject(): Promise<{ dir: string; scope: InstallScope }> {
  const dir = await mkdtemp(join(tmpdir(), "pdb-codexhook-"));
  await nodeSafeFs.mkdir(join(dir, ".codex"));
  await nodeSafeFs.mkdir(join(dir, ".git"));
  return { dir, scope: projectScope(dir) };
}

const hooksFile = (dir: string) => join(dir, ".codex", "hooks.json");

describe("codex Stop hook entry shape (#770)", () => {
  it("renders the owned command with --installed and no paths or session", () => {
    expect(codexStopCommand({})).toBe("pdb rebrief codex-stop --installed --deadline-ms 4000");
    expect(codexStopCommand({ role: "implementer", entry: "codex" })).toBe(
      "pdb rebrief codex-stop --installed --deadline-ms 4000 --role implementer --entry codex",
    );
    // The group is one command entry under the Stop event, native timeout 5.
    expect(codexStopGroup("pdb rebrief codex-stop --installed")).toEqual([
      {
        hooks: [{ type: "command", command: "pdb rebrief codex-stop --installed", timeout: 5 }],
      },
    ]);
  });

  it("classifies a missing Stop key as absent (create) and a PDB one as owned", async () => {
    const adapter = codexHookAdapter(codexStopCommand({}));
    expect(adapter.inspect({})).toEqual({ canonicalText: null, looksForeign: false });
    expect(adapter.inspect({ hooks: {} })).toEqual({
      canonicalText: null,
      looksForeign: false,
    });
    // A codex-stop invocation is PDB-lookalike; with no manifest record it is foreign, and with
    // a matching record classifyEntry makes it owned. Assert the inspect facts only here.
    const ownedText = adapter.inspect({
      hooks: { Stop: codexStopGroup(codexStopCommand({})) },
    });
    expect(ownedText.looksForeign).toBe(true);
    expect(ownedText.canonicalText).toContain("codex-stop");
    // A codex-stop invocation with a different command is still foreign.
    const foreign = adapter.inspect({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "pdb rebrief codex-stop --old" }] }] },
    });
    expect(foreign.looksForeign).toBe(true);
    expect(foreign.canonicalText).toContain("codex-stop");
    // An unrelated non-PDB Stop command is absent with respect to PDB (preserved, not foreign).
    const unrelated = adapter.inspect({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] },
    });
    expect(unrelated.looksForeign).toBe(false);
    expect(unrelated.canonicalText).toBeNull();
  });

  it("validates an unsupported top-level shape", () => {
    const adapter = codexHookAdapter(codexStopCommand({}));
    expect(adapter.validateSchema?.({ hooks: 4 })).toBe("hooks must be a JSON object.");
    expect(adapter.validateSchema?.({})).toBeNull();
  });
});

describe("installCodexStopHook / uninstallCodexStopHook (#770)", () => {
  it("creates the owned Stop entry, preserves unrelated hooks, then uninstalls only it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = hooksFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify(
          { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "setup" }] }] } },
          null,
          2,
        ),
      );
      const manifest = manifestPath(scope, "codex");
      const installed = await installCodexStopHook({
        scope,
        options: { role: "implementer", entry: "codex" },
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(installed.hook.outcome).toBe("applied");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      // Unrelated events survive; the owned Stop group was added.
      expect(doc.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "setup" }] }]);
      expect(Array.isArray(doc.hooks.Stop)).toBe(true);
      expect(doc.hooks.Stop[0].hooks[0].command).toContain("codex-stop");

      // Uninstall removes only the owned Stop group, preserving unrelated hooks.
      const removed = await uninstallCodexStopHook({
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
      expect(after.hooks.SessionStart).toEqual([
        { hooks: [{ type: "command", command: "setup" }] },
      ]);
      expect(after.hooks.Stop).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dry-run plans without writing", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = hooksFile(dir);
      await nodeSafeFs.createSynced(file, "{}");
      const manifest = manifestPath(scope, "codex");
      const dry = await installCodexStopHook({
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
      const manifest = manifestPath(scope, "codex");
      const first = await installCodexStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(first.hook.outcome).toBe("applied");
      const again = await installCodexStopHook({
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
      const file = hooksFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "pdb rebrief codex-stop --old" }] }],
          },
        }),
      );
      const manifest = manifestPath(scope, "codex");
      const refused = await installCodexStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(refused.hook.outcome).toBe("refused");
      expect(refused.hook.code).toBe("FOREIGN_ENTRY");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      expect(doc.hooks.Stop[0].hooks[0].command).toBe("pdb rebrief codex-stop --old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts an existing PDB-lookalike Stop entry when adopt is requested, without rewriting it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = hooksFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "pdb rebrief codex-stop --old" }] }],
          },
        }),
      );
      const manifest = manifestPath(scope, "codex");
      const adopted = await installCodexStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        adopt: true,
        runtime: { now: fixedNow },
      });
      // Adoption only records ownership; the native file is left exactly as found (reinstall
      // replaces it once owned).
      expect(adopted.hook.outcome).toBe("adopted");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      expect(doc.hooks.Stop[0].hooks[0].command).toBe("pdb rebrief codex-stop --old");
      // A later install now replaces the adopted entry with the owned command.
      const later = await installCodexStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(later.hook.outcome).toBe("applied");
      const after = JSON.parse(await nodeSafeFs.readFile(file));
      expect(after.hooks.Stop[0].hooks[0].command).toContain("--installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an unrelated Stop hook alongside the owned entry", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const file = hooksFile(dir);
      await nodeSafeFs.createSynced(
        file,
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] },
        }),
      );
      const manifest = manifestPath(scope, "codex");
      const installed = await installCodexStopHook({
        scope,
        options: {},
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(installed.hook.outcome).toBe("applied");
      const doc = JSON.parse(await nodeSafeFs.readFile(file));
      const commands = doc.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h: { command: string }) => h.command),
      );
      expect(commands).toContain("some-other-tool");
      expect(commands.some((c: string) => c.includes("codex-stop"))).toBe(true);

      // Uninstall removes only the owned entry and keeps the unrelated Stop hook.
      const removed = await uninstallCodexStopHook({
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
      expect(afterCommands).toEqual(["some-other-tool"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
