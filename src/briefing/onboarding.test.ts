import { describe, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COORDINATION_END,
  COORDINATION_START,
  onboardingDocument,
  onboardingInstructions,
  onboardingText,
  validServerOrigin,
} from "./onboarding.js";
import { firstUseHint, hintFileName, runOnboard } from "./onboardcli.js";
import { createGitService } from "../git/service.js";
import { installCoordinationSection, withCoordinationSection } from "../config/agentsguide.js";
import { nodeSafeFs } from "../config/safejson.js";
import { main } from "../cli.js";
import type { GitRunner } from "../config/config.js";

const repo = "owner/name";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "pdb-onboard-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** A checkout of owner/name rooted at `root`. */
const checkoutGit =
  (root: string): GitRunner =>
  async (args) => {
    if (args[0] === "rev-parse") return `${root}\n`;
    if (args[0] === "remote")
      return `origin\thttps://github.com/${repo}.git (fetch)\norigin\thttps://github.com/${repo}.git (push)\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
const noCheckout: GitRunner = async () => {
  throw new Error("not a git repository");
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    output: async (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  };
};

describe("onboarding document (#351)", () => {
  it("puts onboarding and rules first in the prompt and the session-start rule in both texts", () => {
    const doc = onboardingDocument({ repository: repo, role: "implementer" });
    const lines = doc.prompt.split("\n");
    expect(lines[2]).toContain("pdb onboard --repo owner/name");
    expect(lines[2]).toContain("`pdb rules`");
    expect(doc.prompt).toContain("At the start of every session, read the current rules");
    expect(doc.prompt).toContain("pdb --repo owner/name --role implementer");
    expect(doc.prompt).not.toContain("--agent NAME");
    expect(doc.prompt).toContain("--entry KEY");
    expect(doc.prompt).toContain(
      "unsupported sessions must keep passing --entry KEY on every invocation",
    );
    expect(doc.persistentSection).toContain(
      "unsupported sessions must keep passing --entry KEY on every invocation",
    );
    expect(doc.persistentSection.startsWith(COORDINATION_START)).toBe(true);
    expect(doc.persistentSection.endsWith(COORDINATION_END)).toBe(true);
    expect(doc.persistentSection).toContain(
      "At the start of every session, read the current rules",
    );
    // No transient agent name is frozen into the shared section.
    expect(doc.persistentSection).not.toMatch(/--agent [a-z]+_[a-z]+/);
    expect(doc.selectProject).toBeNull();
    expect(doc.rules.url).toBeNull();
  });

  it("passes the selected repository to every identity setup command", () => {
    const doc = onboardingDocument({ repository: "owner/B", role: "implementer" });
    const all = [
      doc.prompt,
      doc.persistentSection,
      ...doc.identity,
      ...doc.examples.map((e) => e.command),
    ];
    const setups = all.flatMap((t) => t.match(/pdb setup identity[^`\n]*/g) ?? []);
    expect(setups.length).toBeGreaterThanOrEqual(1);
    expect(doc.examples.find((e) => e.purpose.startsWith("First use"))?.command).toBe(
      "pdb --repo owner/B --role implementer",
    );
    for (const command of setups) expect(command).toContain("--repo owner/B");
  });

  it("without a project gives a selection hint and placeholders, never another project", () => {
    const doc = onboardingDocument({ repository: null });
    expect(doc.repository).toBeNull();
    expect(doc.selectProject).toContain("--repo OWNER/NAME");
    expect(doc.prompt).toContain("--repo OWNER/NAME");
    expect(doc.prompt).toContain("--role implementer|designer");
  });

  it("links the rules page of a validated server with the repository escaped", () => {
    const origin = validServerOrigin("http://[::1]:7777/");
    expect(origin).toBe("http://[::1]:7777");
    const doc = onboardingDocument({ repository: "o/n.x", server: origin });
    expect(doc.rules.url).toBe("http://[::1]:7777/rules?repo=o%2Fn.x");
    expect(doc.prompt).toContain(doc.rules.url!);
  });

  it("rejects server values with credentials, secrets, paths or other schemes", () => {
    for (const bad of [
      "http://user:pw@host:1",
      "http://host:1/?token=x",
      "http://host:1/#x",
      "http://host:1/path",
      "ftp://host",
      "not a url",
    ])
      expect(validServerOrigin(bad)).toBeNull();
    expect(validServerOrigin("https://pdb.example:8443")).toBe("https://pdb.example:8443");
  });

  it("renders text and MCP instructions from the same document", () => {
    const doc = onboardingDocument({ repository: repo });
    const text = onboardingText(doc);
    expect(text).toContain(doc.prompt);
    expect(text).toContain(doc.persistentSection);
    for (const e of doc.examples) expect(text).toContain(e.command);
    const instructions = onboardingInstructions(doc);
    expect(instructions).toContain(doc.purpose);
    expect(instructions).toContain("pdb onboard --repo owner/name");
    expect(instructions).toContain("start of every session");
  });
});

describe("AGENTS.md coordination section (#351)", () => {
  const section = onboardingDocument({ repository: repo }).persistentSection;

  it("creates, appends with one blank line, and is idempotent", () => {
    expect(withCoordinationSection(null, section)).toEqual({ text: `${section}\n` });
    expect(withCoordinationSection("# Guide\n", section)).toEqual({
      text: `# Guide\n\n${section}\n`,
    });
    expect(withCoordinationSection("# Guide", section)).toEqual({
      text: `# Guide\n\n${section}\n`,
    });
    const installed = `# Guide\n\n${section}\n`;
    expect(withCoordinationSection(installed, section)).toEqual({ unchanged: true });
  });

  it("replaces only the managed block, preserving bytes outside it", () => {
    const before = `# Guide\r\nkeep this\n\n${COORDINATION_START}\nold\n${COORDINATION_END}\ntrailing  \n`;
    const result = withCoordinationSection(before, section);
    expect(result).toEqual({
      text: `# Guide\r\nkeep this\n\n${section}\ntrailing  \n`,
    });
  });

  it("refuses broken markers and an unmarked pdb section", () => {
    for (const text of [
      `${COORDINATION_START}\nx\n`,
      `x\n${COORDINATION_END}\n`,
      `${COORDINATION_END}\n${COORDINATION_START}\n`,
      `${COORDINATION_START}\n${COORDINATION_START}\n${COORDINATION_END}\n`,
      "# Notes\n\n## Using pdb\nrun pdb\n",
      "## Presidential Daily Briefing\n",
    ])
      expect(withCoordinationSection(text, section)).toHaveProperty("refuse");
  });

  it("installs into a root, keeps a lowercase agents.md, and refuses symbolic links", async () => {
    await withDir(async (dir) => {
      const first = await installCoordinationSection(dir, section);
      expect(first).toMatchObject({ status: "written", file: "AGENTS.md" });
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(`${section}\n`);
      expect(await installCoordinationSection(dir, section)).toMatchObject({ status: "kept" });
      expect((await readdir(dir)).filter((n) => !n.startsWith("."))).toEqual(["AGENTS.md"]);
    });
    await withDir(async (dir) => {
      await writeFile(join(dir, "agents.md"), "# Lower\n");
      expect(await installCoordinationSection(dir, section)).toMatchObject({
        status: "written",
        file: "agents.md",
      });
      expect(await readdir(dir)).toEqual(["agents.md"]);
      expect(await readFile(join(dir, "agents.md"), "utf8")).toBe(`# Lower\n\n${section}\n`);
    });
    await withDir(async (dir) => {
      await mkdir(join(dir, "elsewhere"));
      await writeFile(join(dir, "elsewhere", "guide.md"), "# Outside\n");
      try {
        await symlink(join(dir, "elsewhere", "guide.md"), join(dir, "AGENTS.md"));
      } catch {
        return; // No symlink permission (Windows without developer mode).
      }
      const outcome = await installCoordinationSection(dir, section);
      expect(outcome).toMatchObject({ status: "not-written" });
      expect(await readFile(join(dir, "elsewhere", "guide.md"), "utf8")).toBe("# Outside\n");
    });
  });

  it("refuses, keeping the other edit, when AGENTS.md changes during the install", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "AGENTS.md");
      await writeFile(target, "# Guide\n");
      const fs = {
        ...nodeSafeFs,
        createSynced: async (path: string, text: string) => {
          await writeFile(target, "# Guide\nedited by someone else\n");
          await nodeSafeFs.createSynced(path, text);
        },
      };
      const outcome = await installCoordinationSection(dir, section, { fs });
      expect(outcome).toMatchObject({ status: "not-written" });
      expect(await readFile(target, "utf8")).toBe("# Guide\nedited by someone else\n");
      expect((await readdir(dir)).sort()).toEqual(["AGENTS.md"]);
    });
  });

  it("does not change a file whose markers are broken", async () => {
    await withDir(async (dir) => {
      const text = `# Guide\n${COORDINATION_START}\nmine\n`;
      await writeFile(join(dir, "AGENTS.md"), text);
      const outcome = await installCoordinationSection(dir, section);
      expect(outcome).toMatchObject({ status: "not-written" });
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(text);
    });
  });
});

describe("pdb onboard (#351)", () => {
  it("prints instructions outside a checkout without writing anything", async () => {
    await withDir(async (dir) => {
      const io = capture();
      expect(await runOnboard([], io.output, { cwd: dir, git: noCheckout }, io.stderr)).toBe(0);
      expect(io.out.join("")).toContain("No project selected");
      expect(await readdir(dir)).toEqual([]);
      const explicit = capture();
      expect(
        await runOnboard(
          ["--repo", repo],
          explicit.output,
          { cwd: dir, git: noCheckout },
          explicit.stderr,
        ),
      ).toBe(0);
      expect(explicit.out.join("")).toContain("onboarding for owner/name");
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("emits the same document as clean JSON", async () => {
    await withDir(async (dir) => {
      const io = capture();
      expect(
        await runOnboard(
          ["--json", "--role", "designer"],
          io.output,
          { cwd: dir, git: checkoutGit(dir) },
          io.stderr,
        ),
      ).toBe(0);
      const doc = JSON.parse(io.out.join(""));
      const { files, install, ...rest } = doc;
      expect(rest).toEqual(onboardingDocument({ repository: repo, role: "designer" }));
      // #1027: a verified checkout now reports both file outcomes; --dry-run reports them
      // without writing, which is why this read-only check stays read-only.
      expect(files).toEqual([
        { file: "rules.md", status: "written" },
        { file: "AGENTS.md", status: "written" },
      ]);
      expect(install.status).toBe("written");
      expect(io.err).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual(["AGENTS.md", "rules.md"]);
    });
  });

  it("accepts a typed GitService in OnboardRuntime (#900)", async () => {
    await withDir(async (dir) => {
      const io = capture();
      const gitService = createGitService({ git: checkoutGit(dir) });
      expect(await runOnboard(["--json"], io.output, { cwd: dir, gitService }, io.stderr)).toBe(0);
      expect(JSON.parse(io.out.join("")).repository).toBe(repo);
    });
  });

  it("installs only in a verified checkout, and repeats as a no-op", async () => {
    await withDir(async (dir) => {
      const io = capture();
      expect(
        await runOnboard(["--install"], io.output, { cwd: dir, git: noCheckout }, io.stderr),
      ).toBe(2);
      expect(await readdir(dir)).toEqual([]);
      await writeFile(join(dir, "AGENTS.md"), "# Project guide\n");
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      const first = capture();
      expect(await runOnboard(["--install"], first.output, runtime, first.stderr)).toBe(0);
      expect(first.err.join("")).toContain("wrote AGENTS.md");
      expect(first.err.join("")).toContain("wrote rules.md");
      const after = await readFile(join(dir, "AGENTS.md"), "utf8");
      expect(after.startsWith("# Project guide\n\n" + COORDINATION_START)).toBe(true);
      const again = capture();
      expect(await runOnboard(["--install", "--json"], again.output, runtime, again.stderr)).toBe(
        0,
      );
      expect(JSON.parse(again.out.join("")).install.status).toBe("kept");
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(after);
    });
  });

  it("writes rules.md and links it from the managed section (#1027)", async () => {
    await withDir(async (dir) => {
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      const io = capture();
      expect(await runOnboard([], io.output, runtime, io.stderr)).toBe(0);
      const rules = await readFile(join(dir, "rules.md"), "utf8");
      // A generated snapshot: marker with the policy identity, then the shared English document.
      expect(rules.startsWith("<!-- github-triage:rules-file v1 ")).toBe(true);
      expect(rules).toContain('"policyVersion":1');
      expect(rules).toMatch(/"rulesHash":"[a-f0-9]{64}"/);
      expect(rules).toContain("Do not edit it by hand.");
      expect(rules).toContain("Compiled Policy");
      const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
      expect(agents).toContain("`rules.md`");
      expect(agents).toContain(COORDINATION_START);
      // The generated default is reported, not silent.
      expect(io.err.join("")).toContain("wrote rules.md");
      expect(io.err.join("")).toContain("wrote AGENTS.md");
    });
  });

  it("keeps both generated files unchanged on a repeat run (#1027)", async () => {
    await withDir(async (dir) => {
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      expect(await runOnboard([], capture().output, runtime, capture().stderr)).toBe(0);
      const rules = await readFile(join(dir, "rules.md"), "utf8");
      const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
      // The marker carries a generation time, so a repeat run replaces only when the policy or
      // the document changed; an identical document is a no-op either way.
      const again = capture();
      expect(await runOnboard(["--json"], again.output, runtime, again.stderr)).toBe(0);
      const receipt = JSON.parse(again.out.join(""));
      expect(
        receipt.files.map((f: { file: string; status: string }) => [f.file, f.status]),
      ).toEqual([
        ["rules.md", "kept"],
        ["AGENTS.md", "kept"],
      ]);
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agents);
      void rules;
    });
  });

  it("previews both files without writing them (#1027 --dry-run)", async () => {
    await withDir(async (dir) => {
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      const io = capture();
      expect(await runOnboard(["--dry-run", "--json"], io.output, runtime, io.stderr)).toBe(0);
      const receipt = JSON.parse(io.out.join(""));
      expect(receipt.files).toEqual([
        { file: "rules.md", status: "would-write" },
        { file: "AGENTS.md", status: "would-write" },
      ]);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("refuses to overwrite a rules.md pdb did not generate (#1027)", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "rules.md"), "# My own notes\n");
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      const io = capture();
      expect(await runOnboard(["--json"], io.output, runtime, io.stderr)).toBe(1);
      const receipt = JSON.parse(io.out.join(""));
      expect(receipt.files[0]).toMatchObject({ file: "rules.md", status: "not-written" });
      expect(receipt.files[0].reason).toContain("was not generated by pdb");
      // Preflight covers both files: AGENTS.md must not be written to point at a snapshot that
      // does not exist (#1195 review).
      expect(receipt.files[1]).toMatchObject({ file: "AGENTS.md", status: "not-written" });
      expect(await readFile(join(dir, "rules.md"), "utf8")).toBe("# My own notes\n");
      expect(await readdir(dir)).toEqual(["rules.md"]);
    });
  });

  it("exits 1 when the install is refused, and 2 for bad usage", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "AGENTS.md"), `${COORDINATION_END}\n`);
      const runtime = { cwd: dir, git: checkoutGit(dir) };
      const io = capture();
      expect(await runOnboard(["--install"], io.output, runtime, io.stderr)).toBe(1);
      expect(io.err.join("")).toContain("did not change AGENTS.md");
      for (const args of [
        ["--server", "http://u:p@h:1"],
        ["--role", "human"],
        ["--repo", "bad"],
        ["--nope"],
      ]) {
        const bad = capture();
        expect(await runOnboard(args, bad.output, runtime, bad.stderr)).toBe(2);
        expect(bad.out).toEqual([]);
      }
    });
  });
});

describe("first-use hint (#351)", () => {
  it("shows once per project and version, and never fails on a broken cache", async () => {
    await withDir(async (dir) => {
      expect(await firstUseHint("a/b", "1.0.0", { cacheDir: dir })).toBe(true);
      expect(await firstUseHint("a/b", "1.0.0", { cacheDir: dir })).toBe(false);
      expect(await firstUseHint("a/b", "1.1.0", { cacheDir: dir })).toBe(true);
      expect(await firstUseHint("c/d", "1.1.0", { cacheDir: dir })).toBe(true);
      await writeFile(join(dir, hintFileName), "{ not json");
      expect(await firstUseHint("e/f", "1.1.0", { cacheDir: dir })).toBe(false);
      expect(await readFile(join(dir, hintFileName), "utf8")).toBe("{ not json");
    });
  });

  it("is offered for briefing text only, never for JSON, help or commands", async () => {
    const asked: string[] = [];
    const hint = async (project: string) => (asked.push(project), true);
    const updateCheck = async () => ({ status: "disabled" }) as never;
    const runtime = {
      firstUseHint: hint,
      updateCheck,
      collect: async () => {
        throw new Error("no gh");
      },
      currentRepository: async () => repo,
    };
    for (const args of [
      ["--json", "--repo", repo],
      ["--help"],
      ["rules"],
      ["onboard", "--repo", repo],
    ]) {
      const err: string[] = [];
      await main(args, async () => {}, { ...runtime, stderr: (t) => void err.push(t) }).catch(
        () => 1,
      );
      expect(err.join("")).not.toContain("pdb onboard` shows");
    }
    expect(asked).toEqual([]);
    const err: string[] = [];
    await main(["--repo", repo], async () => {}, {
      ...runtime,
      stderr: (t) => void err.push(t),
    }).catch(() => 1);
    expect(asked).toEqual([repo]);
    expect(err.join("")).toContain("`pdb onboard` shows the rules");
  });
});
