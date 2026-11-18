import { describe, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { GitError } from "../git/service.js";
import { nodeFileSystem } from "./config.js";
import { localDoctor, localDoctorExitCode, localDoctorText, nodeProbe } from "./localdoctor.js";
import { configArgumentsFor } from "./configcli.js";

describe("local configuration doctor (#64)", () => {
  type Answers = Record<string, number | null>;
  const base: Answers = {
    "gh --version": 0,
    "gh auth status --active --hostname github.com": 0,
    "git rev-parse --show-toplevel": 0,
    "git remote -v": 0,
    "git check-ignore --quiet --no-index pdb.toml": 0,
    "git ls-files --error-unmatch -- pdb.toml": 1,
  };
  const SECRET = "SECRET-TOKEN-VALUE";
  async function run(
    answers: Answers = {},
    file: string | null | Error = 'name = "x"\ntoken = "SECRET-TOKEN-VALUE"\n',
    options: {
      repo?: string;
      agent?: string;
      role?: string;
      entry?: string;
      harness?: string;
    } = {},
    nodeVersion = "26.1.0",
    env: Record<string, string> = {},
  ) {
    const all = { ...base, ...answers };
    const calls: string[] = [];
    const probe = async (command: string, args: readonly string[]) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const code = key in all ? all[key]! : 0;
      const stdout =
        key === "git rev-parse --show-toplevel"
          ? "/private/home/user/project\n"
          : key === "git remote -v"
            ? "origin\tgit@github.com:owner/name.git (fetch)\n"
            : `${SECRET}\n`;
      return { code, stdout };
    };
    const fs = {
      readText: async () => {
        if (file instanceof Error) throw file;
        return file;
      },
      writeText: async () => expect.fail("doctor wrote a file"),
      rename: async () => expect.fail("doctor renamed a file"),
      remove: async () => expect.fail("doctor removed a file"),
      makeDirectory: async () => expect.fail("doctor created a directory"),
    };
    const report = await localDoctor(options, { cwd: "/x", probe, fs, nodeVersion, env });
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    return { report, status, calls, text: localDoctorText(report), json: JSON.stringify(report) };
  }

  it("reports a healthy checkout with explicit identity, never leaking contents or paths", async () => {
    const { report, status, text, json, calls } = await run({}, undefined, {
      agent: "kavya",
      role: "implementer",
    });
    expect(report).toMatchObject({ schemaVersion: 1, repository: "owner/name", agent: "kavya" });
    expect(status).toMatchObject({
      "runtime.node": "ok",
      "gh.available": "ok",
      "gh.auth": "ok",
      "project.checkout": "ok",
      "identity.file": "ok",
      "identity.git-ignored": "ok",
      "identity.git-tracked": "ok",
      "identity.parse": "ok",
      "identity.entry": "unknown",
      "identity.agent": "ok",
      "triage.role": "ok",
    });
    expect(localDoctorExitCode(report)).toBe(2);
    for (const out of [text, json]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("/private/home");
    }
    expect(calls.every((c) => !c.includes("login") && !c.startsWith("git rm"))).toBe(true);
  });

  it("distinguishes a missing ignore rule from an already tracked file", async () => {
    const missingRule = await run({ "git check-ignore --quiet --no-index pdb.toml": 1 });
    expect(missingRule.status["identity.git-ignored"]).toBe("missing");
    expect(missingRule.status["identity.git-tracked"]).toBe("ok");
    const tracked = await run({ "git ls-files --error-unmatch -- pdb.toml": 0 });
    expect(tracked.status["identity.git-ignored"]).toBe("ok");
    expect(tracked.status["identity.git-tracked"]).toBe("invalid");
    expect(tracked.report.checks.find((c) => c.id === "identity.git-tracked")!.next).toEqual([
      'git rm --cached -- ":/pdb.toml"',
    ]);
    expect(localDoctorExitCode(tracked.report)).toBe(1);
  });

  it("suggests an untracking command that works from a checkout subdirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const git = (cwd: string, ...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      await git(dir, "init", "-q");
      await writeFile(join(dir, "pdb.toml"), "x\n");
      await git(dir, "add", "pdb.toml");
      const sub = join(dir, "sub");
      await mkdir(sub);
      const tracked = await run({ "git ls-files --error-unmatch -- pdb.toml": 0 });
      const suggested = tracked.report.checks.find((c) => c.id === "identity.git-tracked")!
        .next[0]!;
      // Run the suggested command's arguments from the subdirectory, as a user would.
      const args = suggested
        .replace(/^git /, "")
        .split(" ")
        .map((a) => a.replace(/^"(.*)"$/, "$1"));
      await git(sub, ...args);
      expect(await git(dir, "ls-files")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps reporting every check when gh and the checkout are unavailable", async () => {
    const { status, report } = await run({
      "gh --version": null,
      "git rev-parse --show-toplevel": 128,
    });
    expect(status).toMatchObject({
      "gh.available": "missing",
      "gh.auth": "unknown",
      "project.checkout": "missing",
      "identity.file": "unknown",
      "identity.git-ignored": "unknown",
      "identity.git-tracked": "unknown",
      "identity.parse": "unknown",
      "identity.entry": "unknown",
      "identity.name": "unknown",
      "identity.triage-role": "unknown",
      "triage.role": "unknown",
    });
    expect(report.repository).toBeNull();
    expect(localDoctorExitCode(report)).toBe(1);
  });

  it("checks only the active GitHub account, not expired inactive ones", async () => {
    const r = await run({
      "gh auth status --active --hostname github.com": 0,
      "gh auth status --hostname github.com": 1,
    });
    expect(r.status["gh.auth"]).toBe("ok");
  });

  it("separates unauthenticated gh, missing identity file, unreadable file and old Node", async () => {
    expect(
      (await run({ "gh auth status --active --hostname github.com": 1 })).status["gh.auth"],
    ).toBe("access");
    expect((await run({}, null)).status["identity.file"]).toBe("missing");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect((await run({}, denied)).status["identity.file"]).toBe("access");
    expect((await run({}, undefined, {}, "20.11.0")).status["runtime.node"]).toBe("invalid");
  });

  it("treats an ambiguous project or mismatched --repo as unknown, not a guess", async () => {
    const { status, report } = await run({}, undefined, { repo: "other/repo" });
    expect(status["project.checkout"]).toBe("unknown");
    expect(report.repository).toBeNull();
  });

  it("validates --role against registered views and leaves identity unknown without --agent", async () => {
    const { status, report } = await run({}, undefined, { role: "agent" });
    expect(status["triage.role"]).toBe("invalid");
    expect(status["identity.agent"]).toBe("unknown");
    const role = report.checks.find((c) => c.id === "triage.role")!;
    expect(role.next).toContain("pdb doctor --role implementer --repo owner/name");
  });

  const persisted = [
    'top = "SECRET-TOKEN-VALUE"',
    "[agents.claude]",
    'name = "kavya_sabbagh"',
    'triage_role = "implementer"',
    'role = "agent"',
    "unknown_key = 3",
    "[agents.codex]",
    'name = "other_agent_name"',
    'triage_role = "designer"',
    'token = "SECRET-TOKEN-VALUE"',
    "",
  ].join("\n");
  const check = (report: { checks: { id: string; next: string[] }[] }, id: string) =>
    report.checks.find((c) => c.id === id)!;
  /** Every suggested triage command parses with the CLI's own argument parser. */
  const expectParsable = (commands: string[]) => {
    for (const command of commands) {
      expect(command).not.toContain("#");
      const words = command.split(" ");
      if (words[0] !== "pdb") continue;
      expect(command).toContain("--repo ");
      if (words[1] === "config") {
        expect(command).toContain("--entry ");
        expect(() => configArgumentsFor(words.slice(2))).not.toThrow();
      }
    }
  };

  it("reads the persisted name and triage_role of the detected entry only", async () => {
    const { report, status, text, json } = await run({}, persisted, {}, "26.1.0", {
      CLAUDECODE: "1",
    });
    expect(status).toMatchObject({
      "identity.file": "ok",
      "identity.parse": "ok",
      "identity.entry": "ok",
      "identity.name": "ok",
      "identity.triage-role": "ok",
      "identity.agent": "ok",
      "triage.role": "ok",
    });
    expect(report).toMatchObject({ entry: "claude", agent: "kavya_sabbagh", role: "implementer" });
    expect(check(report, "identity.entry")).toMatchObject({
      source: "environment (signals: CLAUDECODE)",
    });
    expect(localDoctorExitCode(report)).toBe(0);
    expect(status).not.toHaveProperty("identity.compatibility");
    for (const out of [text, json]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("other_agent_name");
      expect(out).not.toContain("unknown_key");
    }
    // Explicit selection still wins over persisted values.
    const explicit = await run({}, persisted, { agent: "a", role: "designer" }, "26.1.0", {
      CLAUDECODE: "1",
    });
    expect(explicit.report).toMatchObject({ agent: "a", role: "designer" });
    expect(explicit.status["triage.role"]).toBe("ok");
  });

  it("reports a malformed file by line and column, never its text, and stops there", async () => {
    const { status, report, text, json } = await run({}, `[agents.claude]\nname = "${SECRET}\n`, {
      entry: "claude",
    });
    expect(status).toMatchObject({
      "identity.parse": "invalid",
      "identity.entry": "unknown",
      "identity.name": "unknown",
      "identity.triage-role": "unknown",
    });
    expect(check(report, "identity.parse").next[0]).toContain("pdb doctor --repo owner/name");
    for (const out of [text, json]) expect(out).not.toContain(SECRET);
    expect(localDoctorExitCode(report)).toBe(1);
  });

  it("guides an absent file or entry to the config initialiser with --entry and --repo", async () => {
    const absent = await run({}, null, { entry: "codex" });
    expect(absent.status).toMatchObject({
      "identity.file": "missing",
      "identity.parse": "unknown",
      "identity.entry": "missing",
      "identity.name": "missing",
      "identity.triage-role": "missing",
      "identity.agent": "unknown",
      "triage.role": "unknown",
    });
    expect(check(absent.report, "identity.entry").next).toEqual([
      "pdb setup identity --role implementer --entry codex --repo owner/name",
      "pdb setup identity --role designer --entry codex --repo owner/name",
    ]);
    const missingEntry = await run({}, persisted, { entry: "ori.review" });
    expect(missingEntry.status["identity.entry"]).toBe("missing");
    for (const { report } of [absent, missingEntry])
      expectParsable(report.checks.flatMap((c) => c.next));
  });

  it("never selects an entry from absent, conflicting or ambiguous evidence", async () => {
    const none = await run({}, persisted);
    expect(none.status["identity.entry"]).toBe("unknown");
    expect(none.report.entry).toBeNull();
    const conflict = await run({}, persisted, {}, "26.1.0", { CLAUDECODE: "1", CODEX_CI: "1" });
    expect(conflict.status["identity.entry"]).toBe("unknown");
    expect(check(conflict.report, "identity.entry")).toMatchObject({
      source: "conflict (signals: CLAUDECODE, CODEX_CI)",
    });
    const several = await run(
      {},
      '[agents.codex]\nname = "a"\n[agents."codex.review"]\nname = "b"\n',
      { harness: "codex" },
    );
    expect(check(several.report, "identity.entry").next).toEqual([
      "pdb doctor --entry codex --repo owner/name",
      "pdb doctor --entry codex.review --repo owner/name",
    ]);
    expect(several.text).not.toContain('"a"');
    const ori = await run({}, persisted, {}, "26.1.0", { ORI_SESSION_ID: "s" });
    // No ori entry exists at all (#310): missing, with a create step, never a borrowed entry.
    expect(ori.status["identity.entry"]).toBe("missing");
    expect(ori.text).not.toContain("=s");
    const badEntry = await run({}, persisted, { entry: "bad key!" });
    expect(badEntry.status["identity.entry"]).toBe("invalid");
    for (const r of [none, conflict, several, ori, badEntry]) {
      expect(r.status["identity.name"]).toBe("unknown");
      expect(r.status["identity.agent"]).toBe("unknown");
      expectParsable(r.report.checks.flatMap((c) => c.next));
    }
  });

  it("says plainly when the harness has no entry, lists keys only, and how to create one (#310)", async () => {
    const file = '[agents.claude]\nname = "secret-a"\n[agents.codex]\nname = "secret-b"\n';
    const missing = await run({}, file, {}, "26.1.0", { ORI_SESSION_ID: "s" });
    const entry = check(missing.report, "identity.entry") as unknown as {
      status: string;
      detail: string;
      next: string[];
    };
    expect(entry.status).toBe("missing");
    expect(entry.detail).toMatch(/^No entry exists for the ori harness/);
    expect(entry.detail).toContain(
      "Existing entries: claude (claude harness), codex (codex harness); none of them is this agent's",
    );
    expect(entry.next).toEqual([
      "pdb setup identity --role ROLE --entry ori.SERVER --repo owner/name",
    ]);
    expect(missing.text).not.toMatch(/secret-a|secret-b/);
    // Several ori entries: ambiguous, with the concrete candidates to choose from.
    const several = await run(
      {},
      `${file}[agents."ori.review"]\nname = "c"\n[agents."ori.build"]\nname = "d"\n`,
      {},
      "26.1.0",
      { ORI_SESSION_ID: "s" },
    );
    const choose = check(several.report, "identity.entry") as unknown as {
      status: string;
      detail: string;
      next: string[];
    };
    expect(choose.status).toBe("unknown");
    expect(choose.detail).toContain("Candidate entries: ori.review, ori.build");
    expect(choose.next).toEqual([
      "pdb doctor --entry ori.review --repo owner/name",
      "pdb doctor --entry ori.build --repo owner/name",
    ]);
  });

  it("separates missing and invalid name and triage_role; a generic role is no substitute", async () => {
    const generic = await run({}, '[agents.claude]\nrole = "implementer"\n', { entry: "claude" });
    expect(generic.status).toMatchObject({
      "identity.entry": "ok",
      "identity.name": "missing",
      "identity.triage-role": "missing",
      "triage.role": "unknown",
    });
    expect(check(generic.report, "identity.name").next).toEqual([
      "pdb config set identity.name <AGENT_NAME> --entry claude --repo owner/name",
    ]);
    const invalid = await run(
      {},
      `[agents.claude]\nname = "${SECRET} x"\ntriage_role = "boss-${SECRET}"\n`,
      { entry: "claude" },
    );
    expect(invalid.status).toMatchObject({
      "identity.name": "invalid",
      "identity.triage-role": "invalid",
    });
    expect(invalid.text).not.toContain(SECRET);
    expect(invalid.json).not.toContain(SECRET);
    const notTable = await run({}, '[agents]\nclaude = "x"\n', { entry: "claude" });
    expect(notTable.status["identity.entry"]).toBe("invalid");
    for (const r of [generic, invalid, notTable]) {
      expect(localDoctorExitCode(r.report)).toBe(1);
      expectParsable(r.report.checks.flatMap((c) => c.next));
    }
  });

  it("finds the root file from a nested directory of a linked worktree, not a parent's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-doctor-wt-"));
    try {
      const git = (cwd: string, ...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      const primary = join(dir, "main");
      await mkdir(primary);
      await git(primary, "init", "-q");
      await git(primary, "remote", "add", "origin", "https://github.com/owner/name.git");
      await git(
        primary,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      );
      const worktree = join(dir, "wt");
      await git(primary, "worktree", "add", "-q", worktree);
      await writeFile(join(dir, "pdb.toml"), '[agents.claude]\nname = "decoy"\n');
      await writeFile(join(primary, "pdb.toml"), '[agents.claude]\nname = "decoy"\n');
      await writeFile(
        join(worktree, "pdb.toml"),
        '[agents.claude]\nname = "worktree_agent"\ntriage_role = "designer"\n',
      );
      const nested = join(worktree, "a", "b");
      await mkdir(nested, { recursive: true });
      const probe = async (command: string, args: readonly string[], cwd: string) =>
        command === "git" ? nodeProbe(command, args, cwd) : { code: 0, stdout: "" };
      const report = await localDoctor(
        {},
        { cwd: nested, probe, fs: nodeFileSystem, nodeVersion: "26.0.0", env: { CLAUDECODE: "1" } },
      );
      expect(report).toMatchObject({ entry: "claude", agent: "worktree_agent", role: "designer" });
      expect(JSON.stringify(report)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is wired into the CLI with versioned JSON", async () => {
    let out = "";
    const probe = async (command: string, args: readonly string[]) => {
      const key = [command, ...args].join(" ");
      return {
        code: key in base ? base[key]! : 0,
        stdout:
          key === "git rev-parse --show-toplevel"
            ? "/r\n"
            : key === "git remote -v"
              ? "origin\thttps://github.com/owner/name (fetch)\n"
              : "",
      };
    };
    const code = await main(
      ["doctor", "--json", "--agent", "a", "--role", "designer"],
      async (t) => void (out += t),
      {
        collect: async () => expect.fail("doctor must not collect"),
        currentRepository: async () => "owner/name",
        updateCheck: async () => ({ status: "skipped" }) as never,
        localDoctor: {
          cwd: "/r",
          probe,
          nodeVersion: "26.0.0",
          fs: { ...nodeFileSystem, readText: async () => null },
        },
      },
    );
    expect(JSON.parse(out)).toMatchObject({ schemaVersion: 1, scope: "local-configuration" });
    expect(code).toBe(1);
  });
});

describe("Doctor run cancellation and observed progress (#585)", () => {
  const dependencies = async () => ({
    id: "install.dependencies",
    status: "ok" as const,
    source: "test",
    detail: "Installed dependencies available.",
    next: [],
  });

  it("runs only host checks when no verified checkout is available and records skipped groups", async () => {
    const steps: unknown[] = [];
    const calls: string[] = [];
    const report = await localDoctor(
      {},
      {
        cwd: "/unused",
        nodeVersion: "26.1.0",
        dependencies,
        projectUnavailable: "Select a registered project with a local checkout.",
        onStep: (step) => steps.push(step),
        probe: async (command, args) => {
          expect(command).toBe("gh");
          calls.push(args.join(" "));
          return { code: 0, stdout: "PRIVATE PROBE OUTPUT" };
        },
        fs: {
          ...nodeFileSystem,
          readText: async () => {
            throw new Error("unexpected filesystem read");
          },
        },
      },
    );
    expect(report.checks.map((c) => c.id)).toEqual([
      "runtime.node",
      "install.dependencies",
      "gh.available",
      "gh.auth",
    ]);
    expect(report.summary.ok).toBe(4);
    expect(report.repository).toBeNull();
    expect(calls).toEqual(["--version", "auth status --active --hostname github.com"]);
    expect(steps).toEqual([
      { step: "runtime", state: "running", detail: null },
      { step: "runtime", state: "done", detail: null },
      { step: "dependencies", state: "running", detail: null },
      { step: "dependencies", state: "done", detail: null },
      { step: "gh", state: "running", detail: null },
      { step: "gh", state: "done", detail: null },
      {
        step: "project",
        state: "skipped",
        detail: "Select a registered project with a local checkout.",
      },
      {
        step: "identity",
        state: "skipped",
        detail: "Select a registered project with a local checkout.",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE PROBE OUTPUT");
  });

  it("propagates cancellation through a probe instead of reporting missing or healthy evidence", async () => {
    const controller = new AbortController();
    const steps: string[] = [];
    await expect(
      localDoctor(
        {},
        {
          signal: controller.signal,
          dependencies,
          onStep: (s) => steps.push(`${s.step}:${s.state}`),
          probe: async (_command, _args, _cwd, signal) => {
            expect(signal).toBe(controller.signal);
            controller.abort();
            signal!.throwIfAborted();
            return { code: 0, stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(steps).toContain("gh:running");
    expect(steps).not.toContain("gh:done");
    await expect(
      localDoctor(
        {},
        {
          signal: AbortSignal.abort(),
          probe: async () => {
            throw new Error("must not probe");
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("terminates its real probe child when cancelled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-doctor-probe-"));
    const marker = join(dir, "pid");
    const controller = new AbortController();
    const child = nodeProbe(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      dir,
      controller.signal,
    );
    // Observe rejection immediately, even if setup fails before awaiting the child.
    const outcome = child.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      let pid: number | null = null;
      for (let n = 0; n < 200; n++) {
        try {
          pid = Number(await readFile(marker, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).not.toBeNull();
      controller.abort();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      // The abort's rejection can land while the OS is still reaping the child (a zombie still
      // answers kill(pid,0) without error, and the close event may race the exit). Poll until
      // the child is observably gone within a bounded deadline instead of asserting on the
      // first attempt, so the test cannot race the child's exit.
      let reaped = false;
      for (let n = 0; n < 100; n++) {
        let alive = false;
        try {
          process.kill(pid!, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive) {
          reaped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reaped).toBe(true);
    } finally {
      controller.abort();
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports unavailable evidence when a Git check hits the internal probe timeout", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new DOMException("Timed out", "TimeoutError")));
    try {
      const report = await localDoctor(
        {},
        {
          cwd: "/x",
          fs: {
            readText: async () => {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            },
            writeText: async () => expect.fail("doctor wrote a file"),
            rename: async () => expect.fail("doctor renamed a file"),
            remove: async () => expect.fail("doctor removed a file"),
            makeDirectory: async () => expect.fail("doctor created a directory"),
          },
          git: {
            workingTreeRoot: async (ctx) => {
              if (ctx.signal?.aborted) throw new GitError("cancelled", "timed out");
              return "/x";
            },
            commonDirectory: async () => null,
            remotes: async () => [],
            checkout: async () => null,
            revision: async () => null,
            headRef: async () => null,
            isAncestor: async () => false,
            divergence: async () => null,
            isIgnored: async (ctx) => {
              if (ctx.signal?.aborted) throw new GitError("cancelled", "timed out");
              return false;
            },
            isTracked: async () => false,
            gitPath: async () => null,
          },
          gh: {
            diagnostics: {
              version: async () => ({ exitCode: 0 }),
              authStatus: async () => ({ exitCode: 0 }),
            },
          },
          dependencies,
          nodeVersion: "26.0.0",
          env: {},
        },
      );
      expect(report.checks.find((c) => c.id === "gh.available")?.status).toBe("ok");
      expect(report.checks.find((c) => c.id === "project.checkout")?.status).toBe("missing");
      expect(report.checks.find((c) => c.id === "identity.git-ignored")?.status).toBe("unknown");

      // Also verify an internal timeout during identity.git-ignored does not abort Doctor.
      const identityReport = await localDoctor(
        {},
        {
          cwd: "/x",
          fs: {
            readText: async () => '[agent]\nname = "a"\ntriage_role = "implementer"\n',
            writeText: async () => expect.fail("doctor wrote a file"),
            rename: async () => expect.fail("doctor renamed a file"),
            remove: async () => expect.fail("doctor removed a file"),
            makeDirectory: async () => expect.fail("doctor created a directory"),
          },
          git: {
            workingTreeRoot: async () => "/x",
            commonDirectory: async () => "/x/.git",
            remotes: async () => [
              {
                name: "origin",
                url: "https://github.com/owner/name.git",
                host: "github.com",
                repository: "owner/name",
              },
            ],
            checkout: async () => null,
            revision: async () => null,
            headRef: async () => null,
            isAncestor: async () => false,
            divergence: async () => null,
            isIgnored: async (ctx) => {
              if (ctx.signal?.aborted) throw new GitError("cancelled", "timed out");
              return false;
            },
            isTracked: async () => false,
            gitPath: async () => null,
          },
          gh: {
            diagnostics: {
              version: async () => ({ exitCode: 0 }),
              authStatus: async () => ({ exitCode: 0 }),
            },
          },
          dependencies,
          nodeVersion: "26.0.0",
          env: {},
        },
      );
      expect(identityReport.checks.find((c) => c.id === "project.checkout")?.status).toBe("ok");
      expect(identityReport.checks.find((c) => c.id === "identity.git-ignored")?.status).toBe(
        "unknown",
      );
      expect(identityReport.checks.find((c) => c.id === "identity.git-tracked")?.status).toBe("ok");
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
