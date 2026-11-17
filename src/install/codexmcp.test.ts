/**
 * Codex MCP entry (#799, slice 2b of #768): the desired TOML block for each transport and the
 * install/uninstall wiring over the shared manifest primitives. Injected temp filesystem only;
 * no real client configuration or trust is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import type { InstallScope } from "./manifest.js";
import { manifestPath } from "./manifest.js";
import { buildCodexMcpBlock, installCodexMcp, uninstallCodexMcp } from "./codexmcp.js";

const fixedNow = () => new Date("2026-11-17T01:00:00.000Z");

const projectScope = (root: string): InstallScope => ({
  kind: "project",
  root,
  gitCommonDir: join(root, ".git"),
});

async function tmpProject(): Promise<{ dir: string; scope: InstallScope }> {
  const dir = await mkdtemp(join(tmpdir(), "pdb-codexmcp-"));
  await nodeSafeFs.mkdir(join(dir, ".codex"));
  await nodeSafeFs.mkdir(join(dir, ".git"));
  return { dir, scope: projectScope(dir) };
}

describe("buildCodexMcpBlock (#799)", () => {
  it("emits a STDIO block with the installed command and --project/--entry args", () => {
    const block = buildCodexMcpBlock({
      pdbMcp:
        "/usr/local/bin/../lib/node_modules/@trebizondoculpepper/presidential-daily-briefing/dist/mcp.mjs",
      transport: "stdio",
      url: null,
      projectRoot: "/work/proj",
      entry: "codex",
    });
    expect(block).toContain("[mcp_servers.pdb]");
    expect(block).toContain('command = "/usr/local/bin/../lib/node_modules');
    expect(block).toContain('args = ["--project","/work/proj","--entry","codex"]');
  });

  it("emits an HTTP block with the default or explicit URL", () => {
    const defaulted = buildCodexMcpBlock({ pdbMcp: "/x", transport: "http", url: null });
    expect(defaulted).toContain('url = "http://127.0.0.1:4372/mcp"');
    const explicit = buildCodexMcpBlock({
      pdbMcp: "/x",
      transport: "http",
      url: "http://example/mcp",
    });
    expect(explicit).toContain('url = "http://example/mcp"');
  });
});

describe("installCodexMcp / uninstallCodexMcp (#799)", () => {
  it("creates the PDB MCP table, preserves unrelated entries, then uninstalls only it", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const toml = join(dir, ".codex", "config.toml");
      await nodeSafeFs.createSynced(
        toml,
        `# user comment\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n`,
      );
      const manifest = manifestPath(scope, "codex");
      const installed = await installCodexMcp({
        scope,
        options: { transport: "stdio", url: null, entry: null, projectRoot: dir },
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        pdbMcp: "/bin/pdb-mcp",
        runtime: { now: fixedNow },
      });
      expect(installed.mcp.outcome).toBe("applied");
      const content = await nodeSafeFs.readFile(toml);
      expect(content).toContain("# user comment");
      expect(content).toContain('[mcp_servers.other]\ncommand = "other"');
      expect(content).toContain("[mcp_servers.pdb]");

      // Uninstall removes only the PDB table, preserving the unrelated one and comment.
      const removed = await uninstallCodexMcp({
        scope,
        manifestPath: manifest,
        runtime: { now: fixedNow },
      });
      expect(removed.mcp).toMatchObject({
        outcome: "applied",
        action: "remove",
        ownership: "owned",
      });
      const after = await nodeSafeFs.readFile(toml);
      expect(after).toContain("# user comment");
      expect(after).toContain('[mcp_servers.other]\ncommand = "other"');
      expect(after).not.toContain("[mcp_servers.pdb]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dry-run plans without writing", async () => {
    const { dir, scope } = await tmpProject();
    try {
      const toml = join(dir, ".codex", "config.toml");
      await nodeSafeFs.createSynced(toml, "");
      const manifest = manifestPath(scope, "codex");
      const dry = await installCodexMcp({
        scope,
        options: { transport: "stdio", url: null, entry: null },
        manifestPath: manifest,
        pdbVersion: "0.1.0",
        pdbMcp: "/bin/pdb-mcp",
        dryRun: true,
        runtime: { now: fixedNow },
      });
      expect(dry.mcp.outcome).toBe("planned");
      expect(await nodeSafeFs.readFile(toml)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
