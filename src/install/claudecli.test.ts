import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { claudeInstallArgumentsFor, claudeInstallHelp, runClaudeInstall } from "./claudecli.js";

const exec = promisify(execFile);

async function initTempRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
    cwd: dir,
  });
  return dir;
}

describe("claudeInstallArgumentsFor (#769)", () => {
  it("parses default and explicit options", () => {
    const defaults = claudeInstallArgumentsFor(["claude"], "install");
    expect(defaults).toMatchObject({
      client: "claude",
      operation: "install",
      global: false,
      transport: "stdio",
      url: null,
      dryRun: false,
      json: false,
      yes: false,
      help: false,
    });

    const explicit = claudeInstallArgumentsFor(
      [
        "claude",
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
      client: "claude",
      operation: "install",
      global: true,
      transport: "http",
      url: "http://127.0.0.1:4372/mcp",
      repo: "example/project",
      role: "implementer",
      dryRun: true,
      json: true,
      yes: true,
    });
  });

  it("refuses unknown clients and invalid transport or role flags", () => {
    expect(() => claudeInstallArgumentsFor(["unknown"], "install")).toThrow(
      /Unsupported installer client/,
    );
    expect(() => claudeInstallArgumentsFor(["claude", "--transport", "bogus"], "install")).toThrow(
      /--transport must be stdio or http/,
    );
    expect(() => claudeInstallArgumentsFor(["claude", "--role", "bogus"], "install")).toThrow(
      /--role/,
    );
  });

  it("renders help text for install and uninstall", () => {
    expect(claudeInstallHelp("install")).toContain("pdb install claude");
    expect(claudeInstallHelp("uninstall")).toContain("pdb uninstall claude");
  });
});

describe("runClaudeInstall (#769)", () => {
  it("creates identity and .mcp.json on apply, reuses on rerun, and uninstalls cleanly", async () => {
    const dir = await initTempRepo("pdb-claudecli-apply-");
    try {
      const out1: string[] = [];
      const code1 = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--yes",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
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

      const out2: string[] = [];
      const code2 = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--yes",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
        async (text) => void out2.push(text),
      );
      expect(code2).toBe(0);
      const res2 = JSON.parse(out2.join("")) as {
        status: { configured: boolean };
        items: { kind: string; outcome: string; action: string }[];
      };
      expect(res2.status.configured).toBe(true);
      expect(res2.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "kept",
        action: "kept",
      });

      const out3: string[] = [];
      const code3 = await runClaudeInstall(
        claudeInstallArgumentsFor(
          ["claude", "--repo", "example/project", "--yes", "--json"],
          "uninstall",
        ),
        { cwd: dir, env: {} },
        async (text) => void out3.push(text),
      );
      expect(code3).toBe(0);
      const res3 = JSON.parse(out3.join("")) as {
        items: { kind: string; outcome: string; action: string }[];
      };
      expect(res3.items.find((i) => i.kind === "mcp")).toMatchObject({
        outcome: "applied",
        action: "remove",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to dry-run and exits 1 when confirmation is declined", async () => {
    const dir = await initTempRepo("pdb-claudecli-decline-");
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--json",
          ],
          "install",
        ),
        {
          cwd: dir,
          env: {},
          confirm: async () => false,
          stderr: (text) => void err.push(text),
        },
        async (text) => void out.push(text),
      );
      expect(code).toBe(1);
      expect(err.join("")).toContain("pdb install claude");
      const res = JSON.parse(out.join("")) as {
        dryRun: boolean;
        status: { configured: boolean };
        items: { kind: string; outcome: string }[];
      };
      expect(res.dryRun).toBe(true);
      expect(res.status.configured).toBe(false);
      expect(res.items.find((i) => i.kind === "mcp")?.outcome).toBe("planned");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("displays preview before requesting interactive confirmation", async () => {
    const dir = await initTempRepo("pdb-claudecli-confirm-");
    try {
      const events: string[] = [];
      const code = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
          ],
          "install",
        ),
        {
          cwd: dir,
          env: {},
          stderr: () => {},
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

  it("refuses with CONFLICT when .mcp.json changes while awaiting confirmation", async () => {
    const dir = await initTempRepo("pdb-claudecli-conflict-");
    try {
      const setupCode = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--yes",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
        async () => {},
      );
      expect(setupCode).toBe(0);
      const out: string[] = [];
      const code = await runClaudeInstall(
        claudeInstallArgumentsFor(["claude", "--repo", "example/project", "--json"], "uninstall"),
        {
          cwd: dir,
          env: {},
          stderr: () => {},
          confirm: async () => {
            await writeFile(
              join(dir, ".mcp.json"),
              JSON.stringify({
                mcpServers: { pdb: { type: "http", url: "https://changed.example/mcp" } },
              }),
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
      const current = await readFile(join(dir, ".mcp.json"), "utf8");
      expect(current).toContain("https://changed.example/mcp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves legacy agent-inbox.toml role when importing through shared identity preparation", async () => {
    const dir = await initTempRepo("pdb-claudecli-legacy-");
    try {
      await writeFile(
        join(dir, "agent-inbox.toml"),
        '[agents.claude]\nname = "legacy_claude"\ntriage_role = "designer"\n',
        "utf8",
      );
      const out: string[] = [];
      const code = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--entry",
            "claude",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--yes",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: {} },
        async (text) => void out.push(text),
      );
      expect(code, out.join("")).toBe(0);
      const pdbToml = await readFile(join(dir, "pdb.toml"), "utf8");
      expect(pdbToml).toContain('name = "legacy_claude"');
      expect(pdbToml).toContain('triage_role = "designer"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an invoking Codex session binding when installing Claude", async () => {
    const dir = await initTempRepo("pdb-claudecli-codex-binding-");
    try {
      const { nodeFileSystem } = await import("../config/config.js");
      const { prepareEffectiveIdentity } = await import("../config/effectiveidentity.js");
      const { readIdentityBindings } = await import("../config/identity.js");
      const codexEnv = {
        CODEX_VERSION: "1.0.0",
        CODEX_THREAD_ID: "thread-123",
      };
      const seeded = await prepareEffectiveIdentity(
        {
          project: dir,
          repository: "example/project",
          role: "implementer",
          intent: "normal",
        },
        {
          cwd: dir,
          env: codexEnv,
          fs: nodeFileSystem,
          human: async () => ({
            context: {
              state: "unresolved",
              host: "github.com",
              login: null,
              source: "none",
              reason: "test",
            },
            authenticationFailed: false,
          }),
        },
      );
      expect(seeded.state).toBe("resolved");
      const beforeBindings = await readIdentityBindings(dir, nodeFileSystem);
      expect(beforeBindings.size).toBe(1);
      expect([...beforeBindings.values()]).toEqual([seeded.entry]);

      const out: string[] = [];
      const code = await runClaudeInstall(
        claudeInstallArgumentsFor(
          [
            "claude",
            "--repo",
            "example/project",
            "--role",
            "implementer",
            "--transport",
            "http",
            "--url",
            "http://127.0.0.1:4372/mcp",
            "--yes",
            "--json",
          ],
          "install",
        ),
        { cwd: dir, env: codexEnv },
        async (text) => void out.push(text),
      );
      expect(code, out.join("")).toBe(0);
      const afterBindings = await readIdentityBindings(dir, nodeFileSystem);
      expect(afterBindings).toEqual(beforeBindings);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
