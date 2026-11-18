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
      installArgumentsFor(["codex", "--url", "not-a-url", "--transport", "http"], "install"),
    ).toThrow(/--url must be an http\(s\) endpoint/);
    // Uninstall rejects an explicit transport for either value.
    expect(() => installArgumentsFor(["codex", "--transport", "stdio"], "uninstall")).toThrow(
      /--transport applies to install only/,
    );
    expect(() =>
      installArgumentsFor(["codex", "--entry", "a", "--harness", "b"], "install"),
    ).toThrow(/Give --entry or --harness, not both/);
    expect(() => installArgumentsFor(["codex", "--role", "admin"], "install")).toThrow(
      /--role must be implementer or designer/,
    );
  });

  it("requires exactly one client positional unless showing help", () => {
    expect(() => installArgumentsFor([], "install")).toThrow(/requires exactly one client/);
    expect(() => installArgumentsFor(["codex", "claude"], "install")).toThrow(
      /requires exactly one client/,
    );
    expect(installArgumentsFor(["codex", "--help"], "install").help).toBe(true);
    // Client-free help is allowed.
    expect(installArgumentsFor(["--help"], "install").help).toBe(true);
  });

  it("accepts an uppercase --repo by normalizing it before remote comparison (#844)", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const scope = await resolveInstallScope(
      installArgumentsFor(["codex", "--repo", "Example/Project"], "install"),
      runtime(git),
    );
    expect(scope).toMatchObject({ kind: "project", repository: "example/project" });
  });

  it("help text describes the surface and uninstall limits", () => {
    expect(installHelp("install")).toContain("Usage: pdb install codex");
    expect(installHelp("install")).toContain("--global");
    expect(installHelp("install")).toContain("performs no file writes");
    expect(installHelp("uninstall")).toContain("Usage: pdb uninstall codex");
    expect(installHelp("uninstall")).toContain("--global is required to target user-wide");
    expect(installHelp("uninstall")).toContain("performs no file writes");
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

  it("resolves the repository from the checkout when --repo is omitted", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const scope = await resolveInstallScope(
      installArgumentsFor(["codex"], "install"),
      runtime(git),
    );
    expect(scope).toMatchObject({ kind: "project", repository: "example/project" });
  });

  it("refuses with NO_PROJECT outside a resolvable repository", async () => {
    const git: GitRunner = async () => {
      throw new Error("not a repo");
    };
    await expect(
      resolveInstallScope(installArgumentsFor(["codex"], "install"), runtime(git)),
    ).rejects.toThrow(/NO_PROJECT/);
  });

  it("resolves the global scope to ~/.codex by default and honors an explicit CODEX_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "pdb-install-home-"));
    const savedHome = process.env.HOME;
    const savedCodexHome = process.env.CODEX_HOME;
    const envRuntime: ConfigRuntime = {
      cwd: SYNTHETIC_ROOT,
      fs: { ...emptyFileSystem },
      env: process.env,
    };
    try {
      // Empty CODEX_HOME falls back to the .codex subdirectory under home.
      process.env.HOME = home;
      process.env.CODEX_HOME = "";
      const scope = await resolveInstallScope(
        installArgumentsFor(["codex", "--global"], "install"),
        envRuntime,
      );
      expect(scope).toMatchObject({ kind: "global", home: join(home, ".codex") });
      // A nonempty CODEX_HOME takes precedence.
      process.env.CODEX_HOME = join(home, "custom-codex");
      const explicit = await resolveInstallScope(
        installArgumentsFor(["codex", "--global"], "install"),
        envRuntime,
      );
      expect(explicit).toMatchObject({ kind: "global", home: join(home, "custom-codex") });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runCodexInstallSurface (#768 slice 2a)", () => {
  it("returns a versioned install-result with planned MCP, identity decision and withheld hook", async () => {
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
    const result = JSON.parse(out.join("")) as {
      schemaVersion: number;
      kind: string;
      operation: string;
      scope: { kind: string; targets: Record<string, string> };
      items: { kind: string; outcome: string; code: string | null; file: string | null }[];
      status: { configured: boolean; trusted: string };
    };
    expect(result.schemaVersion).toBe(1);
    expect(result.kind).toBe("install-result");
    expect(result.operation).toBe("install");
    // With no --entry/--harness and no detected harness, identity is ambiguous: reported, not guessed.
    expect(code).toBe(2);
    expect(result.items.map((i) => i.kind)).toEqual(["identity", "mcp", "hook"]);
    expect(result.items[0]).toMatchObject({
      outcome: "refused",
      code: "IDENTITY_AMBIGUOUS",
    });
    // Absolute paths stay out of output: the scope and item files are scope-relative.
    expect(result.scope.kind).toBe("project");
    expect(result.scope.targets.config).toBe(".codex/config.toml");
    expect(result.items[1]).toMatchObject({ kind: "mcp", outcome: "planned", code: null });
    expect(result.items[1].file).toBe(".codex/config.toml");
    expect(result.items[2]).toMatchObject({ outcome: "not-attempted", code: "HOOK_NOT_AVAILABLE" });
    expect(result.status).toEqual({
      configured: false,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    });
  });

  it("reports removal intent for an uninstall preview and exits 0", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(
        ["codex", "--repo", "example/project", "--dry-run", "--json"],
        "uninstall",
      ),
      runtime(git),
      async (text) => void out.push(text),
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as {
      operation: string;
      items: { kind: string; action: string; outcome: string }[];
    };
    expect(result.operation).toBe("uninstall");
    // Uninstall previews describe removal intent; identity is not reported for uninstall.
    expect(result.items.map((i) => i.kind)).toEqual(["mcp", "hook"]);
    expect(result.items[0]).toMatchObject({ kind: "mcp", action: "remove", outcome: "planned" });
  });
});
