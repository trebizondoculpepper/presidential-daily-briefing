/**
 * `pdb install codex` / `pdb uninstall codex` command surface (#768 slice 2a).
 * Injected git/fs/clock only; no real client configuration or trust is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
    expect(installHelp("install")).toContain("pass --yes to apply");
    expect(installHelp("uninstall")).toContain("Usage: pdb uninstall codex");
    expect(installHelp("uninstall")).toContain("--global is required to target user-wide");
    expect(installHelp("uninstall")).toContain("preserving identity");
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
    // Without an explicit --entry/--harness the Codex identity is targeted; it needs setup here,
    // so the result is partial with exit 2.
    expect(code).toBe(2);
    expect(result.items.map((i) => i.kind)).toEqual(["identity", "mcp", "hook"]);
    expect(result.items[0]).toMatchObject({
      outcome: "refused",
      code: "IDENTITY_REQUIRED",
    });
    // Absolute paths stay out of output: the scope and item files are scope-relative.
    expect(result.scope.kind).toBe("project");
    expect(result.scope.targets.config).toBe(".codex/config.toml");
    expect(result.items[1]).toMatchObject({
      kind: "mcp",
      outcome: "not-attempted",
      code: "IDENTITY_REQUIRED",
    });
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
    // Uninstall previews describe removal intent; identity is not reported for uninstall. With
    // no owned entry recorded, the dry-run removal reports the entry as absent/kept (nothing
    // written), which is the honest preview for this state.
    expect(result.items.map((i) => i.kind)).toEqual(["mcp", "hook"]);
    expect(result.items[0]).toMatchObject({ kind: "mcp", action: "absent", outcome: "kept" });
  });

  it("exits 1 when a non-preview request applies nothing (#844 finding)", async () => {
    const out: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "pdb-install-exit1-"));
    const savedHome = process.env.HOME;
    const savedCodexHome = process.env.CODEX_HOME;
    const envRuntime: ConfigRuntime = {
      cwd: SYNTHETIC_ROOT,
      fs: { ...emptyFileSystem },
      env: process.env,
    };
    try {
      process.env.HOME = home;
      process.env.CODEX_HOME = join(home, ".codex");
      const code = await runCodexInstallSurface(
        installArgumentsFor(["codex", "--global", "--json"], "install"),
        envRuntime,
        async (text) => void out.push(text),
      );
      // Global scope has no identity item and nothing is applied in this slice: exit 1.
      expect(code).toBe(1);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves an explicit role in the identity setup retry (#844 finding)", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(
        ["codex", "--repo", "example/project", "--role", "designer", "--dry-run", "--json"],
        "install",
      ),
      runtime(git),
      async (text) => void out.push(text),
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as {
      items: { kind: string; outcome: string; diff: string | null; retry: string | null }[];
    };
    const identity = result.items.find((i) => i.kind === "identity");
    expect(identity).toBeDefined();
    expect(identity!.outcome).toBe("planned");
    expect(identity!.diff).toContain("designer");
    expect(identity!.retry).toContain("--role designer");
    expect(identity!.retry).not.toContain("implementer");
  });

  it("returns a structured identity refusal when the identity file is unreadable (#844 finding)", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const badFs = {
      ...emptyFileSystem,
      readText: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(["codex", "--repo", "example/project", "--dry-run", "--json"], "install"),
      { ...runtime(git), fs: badFs },
      async (text) => void out.push(text),
    );
    expect(code).toBe(2);
    const result = JSON.parse(out.join("")) as {
      items: { kind: string; outcome: string; message: string }[];
    };
    const identity = result.items.find((i) => i.kind === "identity");
    expect(identity?.outcome).toBe("refused");
    expect(identity?.message).toContain("pdb.toml");
  });

  it("creates repository identity on apply, reuses on rerun, and prints Here's what to do next (#800)", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "pdb-codex-800-")));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
        cwd: dir,
      });
      const out1: string[] = [];
      const code1 = await runCodexInstallSurface(
        installArgumentsFor(
          [
            "codex",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--yes",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
        async (text) => void out1.push(text),
      );
      expect(code1, out1.join("")).toBe(0);
      const text1 = out1.join("");
      expect(text1).toContain("Here's what to do next:");
      expect(text1).toContain("unverified for Codex (#397)");

      const out2: string[] = [];
      const code2 = await runCodexInstallSurface(
        installArgumentsFor(
          ["codex", "--repo", "example/project", "--transport", "http", "--yes", "--json"],
          "install",
        ),
        { cwd: dir, env: {} },
        async (text) => void out2.push(text),
      );
      expect(code2).toBe(0);
      const res2 = JSON.parse(out2.join("")) as {
        status: { configured: boolean; trusted: string; executed: string; receiptVerified: string };
        items: { kind: string; action: string; outcome: string }[];
      };
      expect(res2.status).toEqual({
        configured: true,
        trusted: "unknown",
        executed: "unknown",
        receiptVerified: "unknown",
      });
      expect(res2.items[0]).toMatchObject({ kind: "identity", action: "kept", outcome: "applied" });
      expect(res2.items[1]).toMatchObject({ kind: "mcp", action: "kept", outcome: "kept" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous identity with IDENTITY_AMBIGUOUS and withholds MCP (#800)", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const fsWithTwoCodexEntries = {
      ...emptyFileSystem,
      readText: async (path: string) => {
        if (path.endsWith("pdb.toml")) {
          return [
            '[agents."codex.a"]',
            'harness = "codex"',
            'identity = { name = "agent_a", triage_role = "implementer" }',
            '[agents."codex.b"]',
            'harness = "codex"',
            'identity = { name = "agent_b", triage_role = "implementer" }',
          ].join("\n");
        }
        return null;
      },
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(["codex", "--repo", "example/project", "--yes", "--json"], "install"),
      { ...runtime(git), fs: fsWithTwoCodexEntries },
      async (text) => void out.push(text),
    );
    expect(code).toBe(2);
    const res = JSON.parse(out.join("")) as {
      items: { kind: string; outcome: string; code: string | null }[];
    };
    expect(res.items[0]).toMatchObject({
      kind: "identity",
      outcome: "refused",
      code: "IDENTITY_AMBIGUOUS",
    });
    expect(res.items[1]).toMatchObject({
      kind: "mcp",
      outcome: "not-attempted",
      code: "IDENTITY_REQUIRED",
    });
  });

  it("respects confirmation prompt and falls back to dry-run when declined (#800)", async () => {
    const git: GitRunner = async (args, _cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return SYNTHETIC_ROOT + "\n";
      if (args[0] === "remote") return "origin\thttps://github.com/example/project.git (fetch)\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await runCodexInstallSurface(
      installArgumentsFor(
        ["codex", "--repo", "example/project", "--role", "implementer", "--json"],
        "install",
      ),
      { ...runtime(git), confirm: async () => false },
      async (text) => void out.push(text),
    );
    expect(code).toBe(1);
    const res = JSON.parse(out.join("")) as {
      dryRun: boolean;
      items: { kind: string; outcome: string }[];
    };
    expect(res.dryRun).toBe(true);
    expect(res.items[0]).toMatchObject({ kind: "identity", outcome: "planned" });
  });

  it("displays preview before requesting interactive confirmation (#768)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-codexcli-confirm-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
        cwd: dir,
      });
      const events: string[] = [];
      const code = await runCodexInstallSurface(
        installArgumentsFor(
          ["codex", "--repo", "example/project", "--role", "implementer", "--transport", "http"],
          "install",
        ),
        {
          cwd: dir,
          env: {},
          confirm: async () => {
            events.push("confirm");
            return true;
          },
        },
        async (text) => {
          events.push(`output:${text.includes("(planned") ? "preview" : "applied"}`);
        },
      );
      expect(code).toBe(0);
      expect(events).toEqual(["output:preview", "confirm", "output:applied"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with CONFLICT when config changes while awaiting interactive confirmation (#768)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-codexcli-conflict-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { mkdir, readFile, writeFile } = await import("node:fs/promises");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
        cwd: dir,
      });
      // Install an initial HTTP entry first, then preview an uninstall whose target changes mid-prompt.
      const setupCode = await runCodexInstallSurface(
        installArgumentsFor(
          [
            "codex",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--yes",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
        async () => {},
      );
      expect(setupCode).toBe(0);
      const out: string[] = [];
      const code = await runCodexInstallSurface(
        installArgumentsFor(["codex", "--repo", "example/project", "--json"], "uninstall"),
        {
          cwd: dir,
          env: {},
          confirm: async () => {
            await mkdir(join(dir, ".codex"), { recursive: true });
            await writeFile(
              join(dir, ".codex", "config.toml"),
              '[mcp_servers.pdb]\nurl = "https://changed.example/mcp"\n',
              "utf8",
            );
            return true;
          },
        },
        async (text) => void out.push(text),
      );
      expect(code).toBe(2);
      const res = JSON.parse(out.join("")) as {
        items: { kind: string; outcome: string; code: string }[];
      };
      expect(res.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "refused",
        code: "CONFLICT",
      });
      const current = await readFile(join(dir, ".codex", "config.toml"), "utf8");
      expect(current).toContain("https://changed.example/mcp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
