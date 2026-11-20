import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import {
  buildOriMcpEntry,
  desiredOriMcpEntryText,
  installOriMcp,
  uninstallOriMcp,
} from "./orimcp.js";

describe("Ori MCP install/uninstall (#772, attended-installer-delivery.md)", () => {
  const pdbMcp = "/usr/local/bin/pdb-mcp";
  const fixedNow = () => new Date("2026-11-17T01:00:00.000Z");

  it("builds STDIO and HTTP mcpServers.pdb entries", () => {
    expect(
      buildOriMcpEntry({
        pdbMcp,
        transport: "stdio",
        url: null,
        projectRoot: "/w",
        entry: "open",
        platform: "linux",
      }),
    ).toEqual({ type: "stdio", command: pdbMcp, args: ["--project", "/w", "--entry", "open"] });
    expect(
      buildOriMcpEntry({ pdbMcp, transport: "http", url: "http://x/mcp", platform: "linux" }),
    ).toEqual({
      type: "http",
      url: "http://x/mcp",
    });
    expect(
      desiredOriMcpEntryText({
        pdbMcp,
        transport: "stdio",
        url: null,
        projectRoot: "/w",
        platform: "linux",
      }),
    ).toBe(JSON.stringify({ type: "stdio", command: pdbMcp, args: ["--project", "/w"] }));
  });

  it("launches the packaged MCP script through Node on Windows", () => {
    const execPath = "/usr/bin/node";
    const original = process.execPath;
    (process as NodeJS.Process & { execPath: string }).execPath = execPath;
    try {
      expect(
        buildOriMcpEntry({
          pdbMcp,
          transport: "stdio",
          url: null,
          projectRoot: "/w",
          platform: "win32",
        }),
      ).toEqual({ type: "stdio", command: execPath, args: [pdbMcp, "--project", "/w"] });
      expect(
        buildOriMcpEntry({
          pdbMcp,
          transport: "stdio",
          url: null,
          projectRoot: "/w",
          platform: "linux",
        }),
      ).toEqual({ type: "stdio", command: pdbMcp, args: ["--project", "/w"] });
    } finally {
      (process as NodeJS.Process & { execPath: string }).execPath = original;
    }
  });

  it("installs a project .ori/mcp.json MCP entry, round trips, and uninstalls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-ori-install-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "ori.json");
      const mcpFile = join(root, ".ori", "mcp.json");
      await nodeSafeFs.mkdir(join(root, ".ori"));
      const initial =
        JSON.stringify({ custom: 1, mcpServers: { other: { command: "other" } } }, null, 2) + "\n";
      await nodeSafeFs.createSynced(mcpFile, initial);

      const install = await installOriMcp({
        scope,
        options: {
          transport: "stdio",
          url: null,
          entry: null,
          projectRoot: root,
          platform: "linux",
        },
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

      const again = await installOriMcp({
        scope,
        options: {
          transport: "stdio",
          url: null,
          entry: null,
          projectRoot: root,
          platform: "linux",
        },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
      });
      expect(again.mcp.outcome).toBe("kept");

      const removed = await uninstallOriMcp({ scope, manifestPath, runtime: { now: fixedNow } });
      expect(removed.mcp).toMatchObject({
        outcome: "applied",
        action: "remove",
        ownership: "owned",
      });
      const after = JSON.parse(await readFile(mcpFile, "utf8"));
      expect(after.custom).toBe(1);
      expect(after.mcpServers.other).toEqual({ command: "other" });
      expect(after.mcpServers.pdb).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a foreign existing PDB entry without an ownership record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-ori-foreign-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "ori.json");
      const mcpFile = join(root, ".ori", "mcp.json");
      await nodeSafeFs.mkdir(join(root, ".ori"));
      // A pre-existing pdb entry with no ownership record is foreign, never overwritten.
      await nodeSafeFs.createSynced(
        mcpFile,
        JSON.stringify(
          { mcpServers: { pdb: { type: "http", url: "https://other.example/mcp" } } },
          null,
          2,
        ),
      );

      const install = await installOriMcp({
        scope,
        options: {
          transport: "stdio",
          url: null,
          entry: null,
          projectRoot: root,
          platform: "linux",
        },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
      });
      expect(install.mcp).toMatchObject({ outcome: "refused", code: "FOREIGN_ENTRY" });
      const untouched = JSON.parse(await readFile(mcpFile, "utf8"));
      expect(untouched.mcpServers.pdb).toEqual({ type: "http", url: "https://other.example/mcp" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a concurrent change since the preview and refuses (CONFLICT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-ori-conflict-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "ori.json");
      const mcpFile = join(root, ".ori", "mcp.json");
      await nodeSafeFs.mkdir(join(root, ".ori"));
      // The preview saw one raw text; a concurrent edit changes it before apply.
      const approved = JSON.stringify({ mcpServers: {} }, null, 2);
      await nodeSafeFs.createSynced(mcpFile, approved);
      const { readOriInstallSnapshot } = await import("./orimcp.js");
      const expected = await readOriInstallSnapshot(scope, manifestPath);
      await writeFile(mcpFile, JSON.stringify({ mcpServers: { other: {} } }, null, 2), {
        flag: "w",
      });
      const install = await installOriMcp({
        scope,
        options: {
          transport: "stdio",
          url: null,
          entry: null,
          projectRoot: root,
          platform: "linux",
        },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        runtime: { now: fixedNow },
        expectedSnapshot: expected,
      });
      expect(install.mcp).toMatchObject({ outcome: "refused", code: "CONFLICT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an uninstall when mcpServers has an invalid shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-ori-badschema-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "ori.json");
      const mcpFile = join(root, ".ori", "mcp.json");
      await nodeSafeFs.mkdir(join(root, ".ori"));
      // mcpServers must be a JSON object; an array is invalid and must not be silently removed.
      await nodeSafeFs.createSynced(mcpFile, JSON.stringify({ mcpServers: [] }, null, 2));
      const removed = await uninstallOriMcp({ scope, manifestPath, runtime: { now: fixedNow } });
      expect(removed.mcp).toMatchObject({ outcome: "refused", code: "UNSUPPORTED_SCHEMA" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists an ownership record when an existing foreign entry is adopted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-ori-adopt-"));
    try {
      const root = dir;
      const scope = { kind: "project" as const, root, gitCommonDir: join(dir, ".git") };
      const manifestPath = join(dir, ".git", "pdb", "install", "ori.json");
      const mcpFile = join(root, ".ori", "mcp.json");
      await nodeSafeFs.mkdir(join(root, ".ori"));
      await nodeSafeFs.createSynced(
        mcpFile,
        JSON.stringify({ mcpServers: { pdb: { command: "existing-server" } } }, null, 2),
      );
      const install = await installOriMcp({
        scope,
        options: {
          transport: "stdio",
          url: null,
          entry: null,
          projectRoot: root,
          platform: "linux",
        },
        manifestPath,
        pdbVersion: "0.1.0",
        pdbMcp,
        adopt: true,
        runtime: { now: fixedNow },
      });
      expect(install.mcp.outcome).toBe("adopted");
      // The ownership record travels with the result and is persisted by the shared writer, so a
      // later uninstall can remove the adopted entry (the manifest key is the resolved file path).
      expect(install.mcp.manifestRecord).not.toBeNull();
      const write = await nodeSafeFs.readFile(join(dir, ".git", "pdb", "install", "ori.json"));
      expect(write).toContain('"kind": "mcp"');
      expect(write).toContain('"client": "ori"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
