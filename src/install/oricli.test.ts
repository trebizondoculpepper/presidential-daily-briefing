import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { writeFile, realpath } from "node:fs/promises";
import { nodeSafeFs } from "../config/safejson.js";
import { oriInstallArgumentsFor, oriInstallHelp, runOriInstall } from "./oricli.js";

const exec = promisify(execFile);

/** Injected installed pdb-mcp path (source checkouts cannot resolve it). */
const PDBMCP = "/npm/lib/node_modules/pdb/dist/mcp.mjs";

async function initTempRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
    cwd: dir,
  });
  return dir;
}

/** Seed a pdb.toml identity entry so the explicit project binding resolves. */
async function seedIdentity(dir: string, entry = "ori"): Promise<void> {
  await writeFile(
    join(dir, "pdb.toml"),
    `[agents.${entry}]\nname = "tester"\ntriage_role = "implementer"\n`,
    "utf8",
  );
}

describe("oriInstallArgumentsFor (#772)", () => {
  it("parses default and explicit options", () => {
    const defaults = oriInstallArgumentsFor(["ori"], "install");
    expect(defaults).toMatchObject({
      client: "ori",
      operation: "install",
      global: false,
      transport: "stdio",
      url: null,
      dryRun: false,
      json: false,
      yes: false,
      help: false,
    });

    const explicit = oriInstallArgumentsFor(
      [
        "ori",
        "--global",
        "--transport",
        "http",
        "--url",
        "http://127.0.0.1:4372/mcp",
        "--repo",
        "example/project",
        "--role",
        "implementer",
        "--dry-run",
        "--json",
        "--yes",
      ],
      "install",
    );
    expect(explicit).toMatchObject({
      client: "ori",
      operation: "install",
      global: true,
      transport: "http",
      url: "http://127.0.0.1:4372/mcp",
      repo: "example/project",
      role: "implementer",
      dryRun: true,
      json: true,
      yes: true,
      help: false,
    });

    expect(() =>
      oriInstallArgumentsFor(["ori", "--entry", "a", "--harness", "ori"], "install"),
    ).toThrow("Give --entry or --harness, not both.");
    expect(() => oriInstallArgumentsFor(["ori", "--repo", "bad"], "install")).toThrow(
      "--repo must be owner/name.",
    );
  });

  it("includes help showing the .ori/mcp.json path and no Stop hook", () => {
    expect(oriInstallHelp("install")).toContain("pdb install ori");
    expect(oriInstallHelp("install")).toContain(".ori/mcp.json");
    expect(oriInstallHelp("install")).toContain("no native Stop hook");
    expect(oriInstallHelp("uninstall")).toContain("pdb uninstall ori");
  });
});

describe("runOriInstall (#772)", () => {
  it("creates .ori/mcp.json on apply, reuses on rerun, and uninstalls cleanly", async () => {
    const dir = await initTempRepo("pdb-oricli-apply-");
    try {
      await seedIdentity(dir);
      const out1: string[] = [];
      const code1 = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--repo", "example/project", "--entry", "ori", "--yes", "--json"],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out1.push(text),
      );
      expect(code1, out1.join("")).toBe(0);
      const res1 = JSON.parse(out1.join("")) as {
        dryRun: boolean;
        status: { configured: boolean };
        items: { kind: string; outcome: string; action: string }[];
      };
      expect(res1.dryRun).toBe(false);
      expect(res1.status.configured).toBe(true);
      expect(res1.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "applied",
        action: "create",
      });

      const mcpFile = join(dir, ".ori", "mcp.json");
      const written = JSON.parse(await readFile(mcpFile, "utf8"));
      const realRoot = await realpath(dir);
      expect(written.mcpServers.pdb).toEqual({
        type: "stdio",
        command: PDBMCP,
        args: ["--project", realRoot, "--repo", "example/project", "--entry", "ori"],
      });

      const out2: string[] = [];
      const code2 = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--repo", "example/project", "--entry", "ori", "--yes", "--json"],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out2.push(text),
      );
      expect(code2, out2.join("")).toBe(0);
      const res2 = JSON.parse(out2.join("")) as {
        items: { kind: string; outcome: string }[];
      };
      expect(res2.items.find((i) => i.kind === "mcp")).toMatchObject({ outcome: "kept" });

      const out3: string[] = [];
      const code3 = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--repo", "example/project", "--yes", "--json"],
          "uninstall",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out3.push(text),
      );
      expect(code3, out3.join("")).toBe(0);
      const res3 = JSON.parse(out3.join("")) as {
        items: { kind: string; outcome: string; action: string }[];
      };
      expect(res3.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "applied",
        action: "remove",
      });
      const after = JSON.parse(await readFile(mcpFile, "utf8"));
      expect(after.mcpServers?.pdb ?? undefined).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dry-run previews without writing and keeps unrelated entries", async () => {
    const dir = await initTempRepo("pdb-oricli-dry-");
    try {
      await seedIdentity(dir);
      await nodeSafeFs.mkdir(join(dir, ".ori"));
      await nodeSafeFs.createSynced(
        join(dir, ".ori", "mcp.json"),
        JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2),
      );
      const out: string[] = [];
      const code = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--repo", "example/project", "--entry", "ori", "--dry-run", "--json"],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out.push(text),
      );
      expect(code, out.join("")).toBe(0);
      const res = JSON.parse(out.join("")) as {
        dryRun: boolean;
        items: { kind: string; outcome: string }[];
      };
      expect(res.dryRun).toBe(true);
      expect(res.items.find((i) => i.kind === "mcp")).toMatchObject({ outcome: "planned" });
      // Nothing was written.
      const file = JSON.parse(await readFile(join(dir, ".ori", "mcp.json"), "utf8"));
      expect(file.mcpServers.pdb).toBeUndefined();
      expect(file.mcpServers.other).toEqual({ command: "other" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses HTTP installs: HTTP MCP is not a verified Ori integration", async () => {
    const dir = await initTempRepo("pdb-oricli-http-");
    try {
      const out: string[] = [];
      const code = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--transport", "http", "--url", "http://127.0.0.1:4372/mcp", "--yes", "--json"],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out.push(text),
      );
      expect(code).toBe(2);
      const res = JSON.parse(out.join("")) as {
        items: { kind: string; outcome: string; code: string; message: string }[];
      };
      expect(res.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "refused",
        code: "UNSUPPORTED_SCOPE",
      });
      expect(res.items[0].message).toContain("not a verified Ori integration");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a project install when the identity entry is missing", async () => {
    const dir = await initTempRepo("pdb-oricli-identity-");
    try {
      const out: string[] = [];
      const code = await runOriInstall(
        oriInstallArgumentsFor(
          ["ori", "--repo", "example/project", "--entry", "nope", "--yes", "--json"],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out.push(text),
      );
      expect(code).toBe(2);
      const res = JSON.parse(out.join("")) as {
        items: { kind: string; outcome: string; code: string }[];
      };
      expect(res.items.find((i) => i.kind === "identity")).toMatchObject({
        outcome: "refused",
        code: "IDENTITY_REQUIRED",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initializes a missing identity entry when --role is supplied", async () => {
    const dir = await initTempRepo("pdb-oricli-role-");
    try {
      const out: string[] = [];
      const code = await runOriInstall(
        oriInstallArgumentsFor(
          [
            "ori",
            "--repo",
            "example/project",
            "--entry",
            "ori.pdb",
            "--role",
            "implementer",
            "--yes",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out.push(text),
      );
      expect(code, out.join("")).toBe(0);
      const res = JSON.parse(out.join("")) as {
        items: { kind: string; outcome: string }[];
      };
      expect(res.items.find((i) => i.kind === "mcp")).toMatchObject({ outcome: "applied" });
      // The shared setup initialized the entry in pdb.toml (a dotted key is quoted).
      const pdbToml = await readFile(join(dir, "pdb.toml"), "utf8");
      expect(pdbToml).toContain("ori.pdb");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not persist identity during a dry-run preview with --role", async () => {
    const dir = await initTempRepo("pdb-oricli-dry-role-");
    try {
      const out: string[] = [];
      const code = await runOriInstall(
        oriInstallArgumentsFor(
          [
            "ori",
            "--repo",
            "example/project",
            "--entry",
            "ori.pdb",
            "--role",
            "implementer",
            "--dry-run",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: {}, pdbMcpPath: PDBMCP },
        async (text) => void out.push(text),
      );
      expect(code, out.join("")).toBe(0);
      const res = JSON.parse(out.join("")) as {
        dryRun: boolean;
        items: { kind: string; outcome: string }[];
      };
      expect(res.dryRun).toBe(true);
      expect(res.items.find((i) => i.kind === "mcp")).toMatchObject({ outcome: "planned" });
      // A read-only preview must not write the identity (attended-installer contract).
      await expect(readFile(join(dir, "pdb.toml"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
