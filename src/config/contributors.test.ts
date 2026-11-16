/**
 * Contributor routing guidance (#672): what is recognised, and every evidence state.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contributorsMaxBytes,
  guidanceChanged,
  parseContributors,
  readContributors,
  runContributors,
} from "./contributors.js";
import type { GitRunner } from "./config.js";

const repo = "owner/name";
const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "pdb-contributors-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const checkout =
  (root: string, repository = repo): GitRunner =>
  async (args) =>
    args[0] === "rev-parse" && args[1] === "--show-toplevel"
      ? `${root}\n`
      : args[0] === "rev-parse"
        ? "abc1234def\n"
        : `origin\thttps://github.com/${repository}.git (fetch)\n`;

const guidance = `# Contributors

The rules engine and briefing belong to [@alice](https://github.com/alice).

## Rules and briefing
Owners: @alice
Paths: \`src/rules/\`, \`src/briefing/\`

## Serve and dashboard
Ask \`@bob-smith\` about anything under the server.
- **Subtrees:** \`src/serve/\`

## Unowned ideas
Nobody yet.

Default: @alice

\`\`\`
Default: @example
\`\`\`
`;

describe("contributor guidance parsing (#672)", () => {
  it("recognises accounts, areas with paths and an explicit default; ignores examples", () => {
    const g = parseContributors(guidance);
    expect(g.accounts).toEqual(["alice", "bob-smith"]);
    expect(g.areas).toEqual([
      { title: "Rules and briefing", accounts: ["alice"], paths: ["src/rules/", "src/briefing/"] },
      { title: "Serve and dashboard", accounts: ["bob-smith"], paths: ["src/serve/"] },
      { title: "Unowned ideas", accounts: [], paths: [] },
    ]);
    expect(g.default).toEqual({ state: "explicit", account: "alice" });
    expect(g.problems).toEqual(['area "Unowned ideas" names no GitHub account']);
  });

  it("never reads a default from prose, and reports several defaults as ambiguous", () => {
    expect(parseContributors("Use @alice as the default owner when routing.\n").default).toEqual({
      state: "none",
    });
    const two = parseContributors("Default: @alice\n- **Default:** @bob\n");
    expect(two.default).toEqual({ state: "ambiguous", accounts: ["alice", "bob"] });
    expect(two.problems[0]).toContain("none is used");
    // The same default twice is not ambiguous.
    expect(parseContributors("Default: @alice\nDefault: @Alice\n").default).toEqual({
      state: "explicit",
      account: "alice",
    });
  });

  it("does not take emails, URLs or code paths for accounts", () => {
    expect(
      parseContributors("mail a@b.example; see https://github.com/@x and foo/@bar\n").accounts,
    ).toEqual([]);
  });
});

describe("reading the verified project's guidance (#672)", () => {
  it("reports available guidance with digest and revision, and detects a change", async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, "CONTRIBUTORS.md"), guidance);
      const first = await readContributors(repo, root, { revision: async () => "abc1234" });
      expect(first).toMatchObject({
        state: "available",
        revision: "abc1234",
        path: "CONTRIBUTORS.md",
      });
      expect(first.state === "available" && first.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(guidanceChanged(first, await readContributors(repo, root))).toBe(false);
      writeFileSync(
        join(root, "CONTRIBUTORS.md"),
        guidance.replace("Default: @alice", "Default: @bob-smith"),
      );
      expect(guidanceChanged(first, await readContributors(repo, root))).toBe(true);
    });
  });

  it("reports missing, truncated, unsafe and unreadable guidance as evidence, never as owners", async () => {
    await withRoot(async (root) => {
      const missing = await readContributors(repo, root);
      expect(missing).toMatchObject({ state: "missing" });
      expect(guidanceChanged(missing, missing)).toBe(true);
      writeFileSync(join(root, "CONTRIBUTORS.md"), "x".repeat(contributorsMaxBytes + 1));
      expect(await readContributors(repo, root)).toMatchObject({ state: "truncated" });
    });
    await withRoot(async (root) => {
      mkdirSync(join(root, "elsewhere"));
      writeFileSync(join(root, "elsewhere", "guide.md"), "Default: @mallory\n");
      try {
        symlinkSync(join(root, "elsewhere", "guide.md"), join(root, "CONTRIBUTORS.md"));
      } catch {
        return; // No symlink permission on this platform.
      }
      expect(await readContributors(repo, root)).toMatchObject({ state: "unsafe" });
    });
    await withRoot(async (root) => {
      mkdirSync(join(root, "CONTRIBUTORS.md"));
      expect(await readContributors(repo, root)).toMatchObject({ state: "unsafe" });
    });
    await withRoot(async (root) => {
      writeFileSync(join(root, "CONTRIBUTORS.md"), guidance);
      const failing = await readContributors(repo, root, {
        readFile: async () => {
          throw new Error("EACCES");
        },
      });
      expect(failing).toMatchObject({ state: "unreadable" });
    });
  });
});

describe("pdb contributors (#672)", () => {
  const run = async (args: string[], cwd: string, git: GitRunner) => {
    let out = "";
    const code = await runContributors(args, async (t) => void (out += t), { cwd, git });
    return { code, out };
  };

  it("reads only a checkout of the requested repository", async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, "CONTRIBUTORS.md"), guidance);
      const ok = await run(["--json"], root, checkout(root));
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.out)).toMatchObject({
        schemaVersion: 1,
        kind: "contributor-guidance",
        state: "available",
        repository: repo,
        revision: "abc1234def",
        default: { state: "explicit", account: "alice" },
      });
      // An unrelated checkout's guidance is never borrowed for another repository.
      const unrelated = await run(["--repo", "other/repo"], root, checkout(root));
      expect(unrelated.code).toBe(2);
      expect(unrelated.out).toContain("another checkout's file is never used");
    });
  });

  it("exits 2 with the reason when guidance is missing", async () => {
    await withRoot(async (root) => {
      const missing = await run([], root, checkout(root));
      expect(missing.code).toBe(2);
      expect(missing.out).toContain("MISSING");
    });
  });
});
