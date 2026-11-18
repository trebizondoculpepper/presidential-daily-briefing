import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import {
  buildClaudeMcpEntry,
  desiredClaudeMcpEntryText,
  installClaudeMcp,
  uninstallClaudeMcp,
} from "./claudemcp.js";

describe("Claude MCP install/uninstall (#769, attended-installer-delivery.md)", () => {
  const pdbMcp = "/usr/local/bin/pdb-mcp";
  const fixedNow = () => new Date("2026-11-17T01:00:00.000Z");

  it("builds STDIO and HTTP mcpServers.pdb entries", () => {
    expect(
      buildClaudeMcpEntry({
        pdbMcp,
        transport: "stdio",
        url: null,
        projectRoot: "/w",
        entry: "open",
      }),
    ).toEqual({ type: "stdio", command: pdbMcp, args: ["--project", "/w", "--entry", "open"] });
    expect(buildClaudeMcpEntry({ pdbMcp, transport: "http", url: "http://x/mcp" })).toEqual({
      type: "http",
      url: "http://x/mcp",
    });
    expect(
      desiredClaudeMcpEntryText({ pdbMcp, transport: "stdio", url: null, projectRoot: "/w" }),
    ).toBe(JSON.stringify({ type: "stdio", command: pdbMcp, args: ["--project", "/w"] }));
  });

  it("installs a project .mcp.json MCP entry, rounds trip, and uninstalls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-claude-install-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "claude.json");
      const mcpFile = join(root, ".mcp.json");
      // Pre-existing unrelated entry must survive.
      await nodeSafeFs.mkdir(root);
      const initial =
        JSON.stringify({ custom: 1, mcpServers: { other: { command: "other" } } }, null, 2) + "\n";
      await nodeSafeFs.createSynced(mcpFile, initial);

      const install = await installClaudeMcp({
        scope,
        options: { transport: "stdio", url: null, entry: null, projectRoot: root },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
      });
      expect(install.mcp.outcome).toBe("applied");
      const written = JSON.parse(await readFile(mcpFile, "utf8"));
      expect(written.custom).toBe(1);
      expect(written.mcpServers.other).toEqual({ command: "other" });
      expect(written.mcpServers.pdb).toEqual({
        type: "stdio",
        command: pdbMcp,
        args: ["--project", root],
      });

      // Rerun is kept (owned and current).
      const again = await installClaudeMcp({
        scope,
        options: { transport: "stdio", url: null, entry: null, projectRoot: root },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
      });
      expect(again.mcp.outcome).toBe("kept");

      // Uninstall removes only the PDB entry.
      const removed = await uninstallClaudeMcp({ scope, manifestPath, runtime: { now: fixedNow } });
      expect(removed.mcp.outcome).toBe("applied");
      const after = JSON.parse(await readFile(mcpFile, "utf8"));
      expect(after.custom).toBe(1);
      expect(after.mcpServers.other).toEqual({ command: "other" });
      expect(after.mcpServers.pdb).toBeUndefined();

      // Repeated uninstall is a no-op.
      const gone = await uninstallClaudeMcp({ scope, manifestPath, runtime: { now: fixedNow } });
      expect(gone.mcp.outcome).toBe("kept");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a foreign mcpServers.pdb entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-claude-foreign-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "claude.json");
      const mcpFile = join(root, ".mcp.json");
      await nodeSafeFs.mkdir(root);
      const foreign =
        JSON.stringify(
          { mcpServers: { pdb: { type: "stdio", command: "/home/user-own/pdb", args: [] } } },
          null,
          2,
        ) + "\n";
      await nodeSafeFs.createSynced(mcpFile, foreign);
      const result = await installClaudeMcp({
        scope,
        options: { transport: "stdio", url: null, entry: null, projectRoot: root },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
      });
      expect(result.mcp.outcome).toBe("refused");
      expect(result.mcp.code).toBe("FOREIGN_ENTRY");
      // The foreign file is untouched.
      expect(await readFile(mcpFile, "utf8")).toBe(foreign);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("targets the user-wide Claude config for --global scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-claude-global-"));
    try {
      const homeDir = join(dir, "home");
      const stateDir = join(dir, "state");
      const scope = { kind: "global" as const, stateDir, homeDir };
      const manifestPath = join(stateDir, "pdb", "install", "claude.json");
      const claudeFile = join(homeDir, ".claude.json");
      await nodeSafeFs.mkdir(homeDir);
      await nodeSafeFs.mkdir(resolve(stateDir, "pdb", "install"));
      const install = await installClaudeMcp({
        scope,
        options: { transport: "http", url: "http://127.0.0.1:4372/mcp", entry: null },
        manifestPath,
        pdbVersion: "0.1.0",
        runtime: { now: fixedNow },
      });
      expect(install.mcp.outcome).toBe("applied");
      const written = JSON.parse(await readFile(claudeFile, "utf8"));
      expect(written.mcpServers.pdb).toEqual({ type: "http", url: "http://127.0.0.1:4372/mcp" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
