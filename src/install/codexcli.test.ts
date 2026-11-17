/**
 * `pdb install codex` / `pdb uninstall codex` command surface (#768 slice 2a).
 * Injected git/fs/clock only; no real client configuration or trust is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import type { GitRunner } from "../config/config.js";
import {
  installArgumentsFor,
  installHelp,
  resolveInstallScope,
  runCodexInstallSurface,
} from "./codexcli.js";
import type { ConfigRuntime } from "../config/configcli.js";

const runtime = (
  git: GitRunner = fakeGit("example/project"),
  cwd = SYNTHETIC_ROOT,
): ConfigRuntime => ({
  cwd,
  git,
  fs: { ...emptyFileSystem },
  env: {},
});

describe("install codex argument surface (#768 slice 2a)", () => {
  it("parses the full option set and defaults", () => {
    const args = installArgumentsFor(
      [
        "codex",
        "--global",
        "--transport",
        "http",
        "--url",
        "http://x/mcp",
        "--role",
        "designer",
        "--dry-run",
        "--json",
        "--yes",
      ],
      "install",
    );
    expect(args).toMatchObject({
      client: "codex",
      operation: "install",
      global: true,
      transport: "http",
      url: "http://x/mcp",
      role: "designer",
      dryRun: true,
      json: true,
      yes: true,
    });
    const defaults = installArgumentsFor(["codex"], "install");
    expect(defaults).toMatchObject({
      transport: "stdio",
      global: false,
      dryRun: false,
      json: false,
    });
  });

  it("refuses unsupported clients, invalid transport, url without http, and role/entry conflicts", () => {
    expect(() => installArgumentsFor(["claude"], "install")).toThrow(
      /Unsupported installer client/,
    );
    expect(() => installArgumentsFor(["codex", "--transport", "ssh"], "install")).toThrow(
      /--transport must be stdio or http/,
    );
    expect(() => installArgumentsFor(["codex", "--url", "http://x"], "install")).toThrow(
      /--url requires --transport http/,
    );
    expect(() =>
      installArgumentsFor(["codex", "--entry", "a", "--harness", "b"], "install"),
    ).toThrow(/Give --entry or --harness, not both/);
    expect(() => installArgumentsFor(["codex", "--role", "admin"], "install")).toThrow(
      /--role must be implementer or designer/,
    );
  });

  it("help text describes the surface and uninstall limits", () => {
    expect(installHelp("install")).toContain("Usage: pdb install codex");
    expect(installHelp("install")).toContain("--global");
    expect(installHelp("uninstall")).toContain("Usage: pdb uninstall codex");
    expect(installHelp("uninstall")).toContain("--global is required to touch user-wide");
  });
});

describe("install codex scope resolution (#768 slice 2a)", () => {
  it("resolves the project scope from the git working-tree root", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const scope = await resolveInstallScope(
      installArgumentsFor(["codex", "--repo", "example/project"], "install"),
      runtime(git),
    );
    expect(scope).toMatchObject({
      kind: "project",
      root: SYNTHETIC_ROOT,
      repository: "example/project",
    });
  });

  it("refuses with NO_PROJECT outside a resolvable repository", async () => {
    const git: GitRunner = async () => {
      throw new Error("not a repo");
    };
    await expect(
      resolveInstallScope(installArgumentsFor(["codex"], "install"), runtime(git)),
    ).rejects.toThrow(/NO_PROJECT/);
  });

  it("resolves the global scope from CODEX_HOME else HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "pdb-install-home-"));
    try {
      process.env.HOME = home;
      process.env.CODEX_HOME = "";
      const scope = await resolveInstallScope(
        installArgumentsFor(["codex", "--global"], "install"),
        runtime(),
      );
      expect(scope).toMatchObject({ kind: "global", home });
    } finally {
      delete process.env.HOME;
      delete process.env.CODEX_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runCodexInstallSurface (#768 slice 2a)", () => {
  it("returns a versioned install-result with planned MCP and withheld hook, writing nothing", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(["codex", "--repo", "example/project", "--dry-run", "--json"], "install"),
      runtime(git),
      async (text) => void out.push(text),
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as {
      schemaVersion: number;
      kind: string;
      operation: string;
      items: { kind: string; outcome: string; code: string | null }[];
      status: { configured: boolean; trusted: string };
    };
    expect(result.schemaVersion).toBe(1);
    expect(result.kind).toBe("install-result");
    expect(result.operation).toBe("install");
    expect(result.items.map((i) => i.kind)).toEqual(["mcp", "hook"]);
    expect(result.items[0]).toMatchObject({ outcome: "planned", code: null });
    expect(result.items[1]).toMatchObject({ outcome: "not-attempted", code: "HOOK_NOT_AVAILABLE" });
    expect(result.status).toEqual({
      configured: false,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    });
  });
});
