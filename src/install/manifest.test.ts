import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodeSafeFs } from "../config/safejson.js";
import {
  assertSafeInstallPath,
  classifyEntry,
  defaultUserStateDir,
  editJsonEntry,
  editTomlTable,
  manifestPath,
  readInstallManifest,
  removeJsonEntry,
  removeTomlTable,
  resolveProjectGitCommonDir,
  sha256Hex,
  writeInstallManifestRecord,
} from "./manifest.js";
import type { InstallFs, JsonEntryAdapter, ManifestRecord } from "./manifest.js";

const fixedNow = () => new Date("2026-11-17T01:00:00.000Z");

const mcpJsonAdapter = (command: string): JsonEntryAdapter => ({
  kind: "mcp",
  validateSchema(doc) {
    if (
      "mcpServers" in doc &&
      (typeof doc.mcpServers !== "object" ||
        doc.mcpServers === null ||
        Array.isArray(doc.mcpServers))
    )
      return "mcpServers must be a JSON object.";
    return null;
  },
  inspect(doc) {
    const servers = doc.mcpServers as Record<string, unknown> | undefined;
    const entry = servers?.pdb;
    if (entry === undefined) return { canonicalText: null, looksForeign: false };
    const canonicalText = JSON.stringify(entry);
    const looksForeign =
      typeof entry === "object" &&
      entry !== null &&
      "command" in entry &&
      String((entry as { command: unknown }).command).includes("pdb");
    return { canonicalText, looksForeign };
  },
  apply(doc) {
    const existing = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
    return {
      ...doc,
      mcpServers: {
        ...existing,
        pdb: { command, args: ["--project", "."] },
      },
    };
  },
  remove(doc) {
    const existing = { ...(doc.mcpServers as Record<string, unknown> | undefined) };
    delete existing.pdb;
    const next = { ...doc };
    if (Object.keys(existing).length === 0) delete next.mcpServers;
    else next.mcpServers = existing;
    return next;
  },
  desiredCanonicalText: () => JSON.stringify({ command, args: ["--project", "."] }),
});

describe("installer ownership manifest & scope (#767)", () => {
  it("resolves project git-common-dir, global state dir, and rejects invalid client names", async () => {
    const common = await resolveProjectGitCommonDir(
      resolve("repo root with spaces"),
      async () => ".git/worktrees/wt1\n",
    );
    expect(common).toBe(resolve("repo root with spaces", ".git/worktrees/wt1"));
    expect(defaultUserStateDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/u", "linux")).toBe(
      resolve("/xdg/state"),
    );
    expect(
      defaultUserStateDir(
        { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        "C:\\Users\\u",
        "win32",
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local");
    expect(manifestPath({ kind: "project", root: "/r", gitCommonDir: "/r/.git" }, "codex")).toBe(
      join("/r/.git", "pdb", "install", "codex.json"),
    );
    expect(() =>
      manifestPath({ kind: "project", root: "/r", gitCommonDir: "/r/.git" }, "../bad"),
    ).toThrow(/Invalid installer client/);
  });

  it("refuses malformed and future-version manifests without overwriting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-install-manifest-"));
    try {
      const mPath = join(dir, "pdb", "install", "codex.json");
      await nodeSafeFs.mkdir(join(dir, "pdb", "install"));
      await nodeSafeFs.createSynced(mPath, "{not json");
      expect(await readInstallManifest(mPath)).toMatchObject({
        status: "error",
        code: "MALFORMED_MANIFEST",
      });
      const badWrite = await writeInstallManifestRecord(mPath, "codex", "mcp", null, {
        now: fixedNow,
      });
      expect(badWrite.status).toBe("not-written");

      const mPath2 = join(dir, "pdb", "install", "claude.json");
      await nodeSafeFs.createSynced(
        mPath2,
        JSON.stringify({ schemaVersion: 99, client: "claude", records: {} }),
      );
      expect(await readInstallManifest(mPath2)).toMatchObject({
        status: "error",
        code: "FUTURE_MANIFEST_VERSION",
      });
      const futureWrite = await writeInstallManifestRecord(mPath2, "claude", "mcp", null, {
        now: fixedNow,
      });
      expect(futureWrite.status).toBe("not-written");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses symlinks and paths escaping the allowed scope root", async () => {
    const root = resolve("scope root");
    await expect(assertSafeInstallPath(join(root, "..", "escape.json"), root)).rejects.toThrow(
      /UNSAFE_PATH/,
    );
    await expect(
      assertSafeInstallPath(join(root, ".codex", "hooks.json"), root, async (p) => ({
        isSymbolicLink: () => p.endsWith(".codex"),
      })),
    ).rejects.toThrow(/UNSAFE_PATH/);
  });
});

describe("safe JSON entry edits (#767)", () => {
  it("supports dry-run, create with unrelated keys preserved, rerun kept, replace, edited/foreign conflict, adopt, and owned-only uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-install-json with spaces-"));
    try {
      const mcpFile = join(dir, ".mcp.json");
      const mPath = join(dir, ".git", "pdb", "install", "claude.json");
      await nodeSafeFs.createSynced(
        mcpFile,
        JSON.stringify({ custom: 1, mcpServers: { other: { command: "other-mcp" } } }, null, 2) +
          "\n",
      );

      // 1. Dry-run plans without modifying disk.
      const dry = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        dryRun: true,
        runtime: { now: fixedNow },
      });
      expect(dry.outcome).toBe("planned");
      expect(dry.action).toBe("create");
      expect(dry.diff).toContain("/bin/pdb-mcp");
      expect(await nodeSafeFs.readFile(mcpFile)).not.toContain("/bin/pdb-mcp");

      // 2. Apply create and record in manifest.
      const applied = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(applied.outcome).toBe("applied");
      expect(applied.manifestRecord).not.toBeNull();
      const mWrite = await writeInstallManifestRecord(
        mPath,
        "claude",
        "mcp",
        applied.manifestRecord,
        { now: fixedNow },
      );
      expect(mWrite.status).toBe("written");
      const afterCreate = JSON.parse(await nodeSafeFs.readFile(mcpFile));
      expect(afterCreate.custom).toBe(1);
      expect(afterCreate.mcpServers.other).toEqual({ command: "other-mcp" });

      // 3. Rerun is kept with no write.
      const mRead = await readInstallManifest(mPath);
      expect(mRead.status).toBe("ok");
      const record = mRead.status === "ok" ? mRead.manifest.records.mcp : undefined;
      const rerun = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: record,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(rerun.outcome).toBe("kept");
      expect(rerun.action).toBe("kept");

      // 4. Owned entry edited externally refuses with OWNED_ENTRY_EDITED.
      const editedText = JSON.stringify({
        custom: 1,
        mcpServers: { other: { command: "other-mcp" }, pdb: { command: "/edited/pdb-mcp" } },
      });
      await writeFile(mcpFile, editedText, "utf8");
      const editedRefusal = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: record,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(editedRefusal).toMatchObject({
        outcome: "refused",
        ownership: "edited",
        code: "OWNED_ENTRY_EDITED",
      });

      // 5. Foreign entry (no manifest record) refuses unless adopt: true.
      const foreignRefusal = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(foreignRefusal).toMatchObject({
        outcome: "refused",
        ownership: "foreign",
        code: "FOREIGN_ENTRY",
      });

      const adopted = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        adopt: true,
        runtime: { now: fixedNow },
      });
      expect(adopted).toMatchObject({
        outcome: "applied",
        action: "replace",
        ownership: "foreign",
      });

      // 6. Owned-only uninstall removes pdb while keeping custom & other.
      const removed = await removeJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: adopted.manifestRecord ?? undefined,
        runtime: { now: fixedNow },
      });
      expect(removed).toMatchObject({ outcome: "applied", action: "remove", ownership: "owned" });
      const afterRemove = JSON.parse(await nodeSafeFs.readFile(mcpFile));
      expect(afterRemove).toEqual({ custom: 1, mcpServers: { other: { command: "other-mcp" } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports concurrent edits as CONFLICT and post-rename fsync failures as committed-with-error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-install-conflict-"));
    try {
      const mcpFile = join(dir, ".mcp.json");
      await nodeSafeFs.createSynced(mcpFile, "{}\n");

      // Concurrent edit between initial read and lock acquisition.
      let reads = 0;
      const raceFs: InstallFs = {
        ...nodeSafeFs,
        readFile: async (p) => {
          reads++;
          if (reads === 2 && p === mcpFile) return '{"concurrent":true}\n';
          return nodeSafeFs.readFile(p);
        },
      };
      const conflict = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { fs: raceFs, now: fixedNow },
      });
      expect(conflict).toMatchObject({ outcome: "refused", code: "CONFLICT" });

      // Post-rename syncDirectory failure returns committed-with-error.
      const syncFailFs: InstallFs = {
        ...nodeSafeFs,
        syncDirectory: async () => {
          throw new Error("EIO dir sync");
        },
      };
      const partial = await editJsonEntry({
        file: mcpFile,
        allowedRoot: dir,
        adapter: mcpJsonAdapter("/bin/pdb-mcp"),
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { fs: syncFailFs, now: fixedNow },
      });
      expect(partial.outcome).toBe("committed-with-error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("safe TOML table edits (#767)", () => {
  it("preserves unrelated comments and tables, validates parses, handles rerun/edited/foreign/uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-install-toml-"));
    try {
      const tomlFile = join(dir, ".codex", "config.toml");
      await nodeSafeFs.mkdir(join(dir, ".codex"));
      const initial = `# User config comment\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n`;
      await nodeSafeFs.createSynced(tomlFile, initial);

      const desired = `[mcp_servers.pdb]\ncommand = "/bin/pdb-mcp"\nargs = ["--project", "${dir.replace(/\\/g, "\\\\")}"]`;
      const created = await editTomlTable({
        file: tomlFile,
        allowedRoot: dir,
        tablePath: ["mcp_servers", "pdb"],
        desiredBlock: desired,
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(created.outcome).toBe("applied");
      expect(created.action).toBe("create");
      const content = await nodeSafeFs.readFile(tomlFile);
      expect(content).toContain("# User config comment");
      expect(content).toContain('[mcp_servers.other]\ncommand = "other"');
      expect(content).toContain("[mcp_servers.pdb]");

      // Rerun is kept.
      const record: ManifestRecord = created.manifestRecord!;
      expect(classifyEntry(record, desired, true)).toBe("owned");
      expect(sha256Hex(desired)).toBe(record.sha256);
      const rerun = await editTomlTable({
        file: tomlFile,
        allowedRoot: dir,
        tablePath: ["mcp_servers", "pdb"],
        desiredBlock: desired,
        manifestRecord: record,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(rerun.outcome).toBe("kept");

      // Uninstall removes only [mcp_servers.pdb], preserving comments and [mcp_servers.other].
      const removed = await removeTomlTable({
        file: tomlFile,
        allowedRoot: dir,
        tablePath: ["mcp_servers", "pdb"],
        manifestRecord: record,
        runtime: { now: fixedNow },
      });
      expect(removed).toMatchObject({ outcome: "applied", action: "remove", ownership: "owned" });
      const afterRemove = await nodeSafeFs.readFile(tomlFile);
      expect(afterRemove).toContain("# User config comment");
      expect(afterRemove).toContain('[mcp_servers.other]\ncommand = "other"');
      expect(afterRemove).not.toContain("[mcp_servers.pdb]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses malformed TOML and unsafe TOML edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-install-bad-toml-"));
    try {
      const tomlFile = join(dir, "config.toml");
      await nodeSafeFs.createSynced(tomlFile, "bad = [unclosed\n");
      const malformed = await editTomlTable({
        file: tomlFile,
        allowedRoot: dir,
        tablePath: ["mcp_servers", "pdb"],
        desiredBlock: '[mcp_servers.pdb]\ncommand = "pdb-mcp"',
        manifestRecord: undefined,
        pdbVersion: "0.10.0",
        runtime: { now: fixedNow },
      });
      expect(malformed).toMatchObject({ outcome: "refused", code: "MALFORMED_CONFIG" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
