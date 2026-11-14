import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { detectClientEntry } from "./harness.js";
import { resolveReadIdentity, type ReadIdentityOptions } from "./readidentity.js";

const root = "/work/project";
const identity = join(root, "agent-inbox.toml");
const toml = `[agents.codex]
name = "codex_agent"
triage_role = "designer"
[agents.claude]
name = "claude_agent"
triage_role = "implementer"
[agents."ori.codex-mcp-client"]
name = "ori_agent"
`;

function fixture(contents: string | null = toml) {
  const reads: string[] = [];
  const writes: string[] = [];
  const fs: ConfigFileSystem = {
    readText: async (path) => {
      reads.push(path);
      return path === identity ? contents : null;
    },
    writeText: async (path) => void writes.push(path),
    appendText: async (path) => void writes.push(path),
    rename: async (_from, to) => void writes.push(to),
    remove: async (path) => void writes.push(path),
    makeDirectory: async (path) => void writes.push(path),
  };
  const git: GitRunner = async (args) =>
    args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/owner/repo.git (fetch)\n";
  const resolve = (options: Partial<ReadIdentityOptions> = {}) =>
    resolveReadIdentity({
      project: root,
      repository: "owner/repo",
      clientName: "codex-mcp-client",
      env: {},
      git,
      fs,
      ...options,
    });
  return { resolve, reads, writes };
}

describe("verified Codex MCP identity (#402)", () => {
  it("matches only the verified exact name and preserves Ori server names", () => {
    expect(detectClientEntry("codex-mcp-client")).toEqual({ harness: "codex", entry: "codex" });
    for (const name of [
      "codex",
      "Codex",
      "Codex-mcp-client",
      "codex-mcp-client-extra",
      "my-codex-mcp-client",
    ])
      expect(detectClientEntry(name), name).toBeNull();
    expect(detectClientEntry("ori-codex-mcp-client")).toEqual({
      harness: "ori",
      entry: "ori.codex-mcp-client",
    });
  });

  it("uses metadata before inherited environment markers, returning the persisted role without writes", async () => {
    const t = fixture();
    for (const env of [{}, { CLAUDECODE: "1" }, { CLAUDECODE: "1", CODEX_THREAD_ID: "inherited" }])
      expect(await t.resolve({ env })).toEqual({
        agent: "codex_agent",
        source: "client",
        entry: "codex",
        triageRole: "designer",
        diagnostic: null,
      });
    expect(t.reads.every((path) => path === identity)).toBe(true);
    expect(t.writes).toEqual([]);
    expect(
      await t.resolve({ clientName: "codex-mcp-client-extra", env: { CLAUDECODE: "1" } }),
    ).toMatchObject({
      agent: "claude_agent",
      source: "environment",
    });
    expect(await t.resolve({ clientName: "ori-codex-mcp-client" })).toMatchObject({
      agent: "ori_agent",
      source: "client",
      entry: "ori.codex-mcp-client",
    });
  });

  it("preserves tool, startup, explicit entry and explicit harness precedence", async () => {
    const t = fixture();
    expect(await t.resolve({ toolAgent: "tool", startupAgent: "startup" })).toMatchObject({
      agent: "tool",
      source: "tool",
    });
    expect(await t.resolve({ startupAgent: "startup", entry: "claude" })).toMatchObject({
      agent: "startup",
      source: "startup",
    });
    expect(t.reads).toEqual([]);
    expect(await t.resolve({ entry: "claude" })).toMatchObject({
      agent: "claude_agent",
      source: "entry",
      entry: "claude",
    });
    expect(await t.resolve({ harness: "claude" })).toMatchObject({
      agent: "claude_agent",
      source: "harness",
      entry: "claude",
    });
    expect(t.writes).toEqual([]);
  });

  it("does not bypass Codex ambiguity and permits explicit entry recovery", async () => {
    const t = fixture(`${toml}\n[agents."codex.review"]\nname = "review_agent"\n`);
    expect(await t.resolve()).toMatchObject({
      agent: null,
      source: "unresolved",
      entry: null,
      diagnostic: expect.stringContaining("Candidate entries: codex, codex.review"),
    });
    expect(await t.resolve({ entry: "codex.review" })).toMatchObject({
      agent: "review_agent",
      source: "entry",
      entry: "codex.review",
    });
    expect(t.writes).toEqual([]);
  });

  it("diagnoses missing, unrelated and malformed identities without borrowing or writing", async () => {
    const cases: [string | null, RegExp][] = [
      [null, /no agent-inbox.toml/],
      ['[agents.claude]\nname = "other"\n', /no \[agents.codex\] entry/],
      ['[agents."codex.review"]\nname = "other"\n', /Several logical agent entries/],
      ['[agents.codex]\ntriage_role = "designer"\n', /no valid name/],
      ["[agents\nbroken", /not valid for identity use/],
    ];
    for (const [contents, diagnostic] of cases) {
      const t = fixture(contents);
      expect(await t.resolve()).toMatchObject({
        agent: null,
        source: "unresolved",
        diagnostic: expect.stringMatching(diagnostic),
      });
      expect(t.writes).toEqual([]);
    }
  });

  it("checks project selection and repository agreement before reading local identity", async () => {
    const t = fixture();
    expect(await t.resolve({ repository: "other/repo" })).toMatchObject({
      agent: null,
      source: "unresolved",
      diagnostic: expect.stringContaining("not other/repo"),
    });
    expect(await t.resolve({ project: undefined })).toMatchObject({
      agent: null,
      source: "unresolved",
      diagnostic: expect.stringContaining("no local project"),
    });
    expect(t.reads).toEqual([]);
    expect(t.writes).toEqual([]);
  });
});
