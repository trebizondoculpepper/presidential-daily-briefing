import type { LockTiming } from "./filelock.js";
import { describe, expect, it } from "vite-plus/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { nodeFileSystem, type ConfigFileSystem, type GitRunner } from "./config.js";
import {
  generateName,
  IDENTITY_FILE,
  IDENTITY_LOCK_FILE,
  parseIdentityDocument,
  readIdentity,
  resolveIdentityTarget,
  setIdentity,
} from "./identity.js";
import { detectClientEntry, detectHarness, HARNESS_DETECTORS, resolveEntry } from "./harness.js";

describe("agent identity in root agent-inbox.toml (#70)", () => {
  const root = "/repo";
  const file = join(root, IDENTITY_FILE);
  const exclude = join(root, ".git/info/exclude");
  const sample = `# keep me?
title = "unrelated"
big = 9007199254740993
ratio = 1.0
when = 1979-05-27T07:32:00-08:00
day = 1979-05-27
list = [1, 2]

[agents.codex]
name = "stable_one"   # trailing comment
role = "agent"
token = "s3cret-token"

[agents."ori.review"]
name = "other_agent"
triage_role = "designer"
api_key = "private-key"

[[extra]]
x = 1
`;
  function setup(
    initial?: string,
    options: { tracked?: boolean; ignored?: boolean; env?: Record<string, string> } = {},
  ) {
    const files = new Map<string, string>(initial === undefined ? [] : [[file, initial]]);
    const fs: ConfigFileSystem = {
      readText: async (path) => files.get(path) ?? null,
      writeText: async (path, text) => void files.set(path, text),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      appendText: async (path, text) => void files.set(path, (files.get(path) ?? "") + text),
      remove: async (path) => void files.delete(path),
      makeDirectory: async () => undefined,
    };
    const calls: string[] = [];
    const fail = (code: number) => Object.assign(new Error(`exit ${code}`), { code });
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
      if (args[0] === "rev-parse" && args[1] === "--git-path") return ".git/info/exclude\n";
      if (args[0] === "remote") return "origin\thttps://github.com/owner/name.git (fetch)\n";
      if (args[0] === "ls-files") {
        if (options.tracked) return IDENTITY_FILE;
        throw fail(1);
      }
      if (args[0] === "check-ignore") {
        const rules = (files.get(exclude) ?? "").split("\n");
        const name = args.at(-1)!;
        const rule = name.endsWith(".tmp") ? `/${IDENTITY_FILE}.*.tmp` : `/${name}`;
        if (options.ignored || rules.includes(rule)) return "";
        throw fail(1);
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    let seed = 0;
    const random = () => ((seed = (seed * 7 + 3) % 11) + 0.5) / 11;
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["config", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        config: { fs, git, cwd: `${root}/nested/dir`, random, env: options.env ?? {} },
      });
    return { files, fs, git, calls, out, call, json: () => JSON.parse(out.at(-1)!) };
  }

  it("reads only the selected entry's registered values and never creates files", async () => {
    const t = setup(sample);
    expect(await t.call("get", "identity.name", "--entry", "codex", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      kind: "config-get",
      scope: "agent",
      path: IDENTITY_FILE,
      entry: "codex",
      key: "identity.name",
      value: "stable_one",
      source: "explicit",
    });
    expect(await t.call("list", "--entry", "ori.review", "--json")).toBe(0);
    const listed = t.json();
    expect(listed.identity.settings).toEqual([
      { key: "identity.name", value: "other_agent", source: "explicit" },
      { key: "identity.triage_role", value: "designer", source: "explicit" },
    ]);
    const everything = t.out.join("");
    for (const secret of ["s3cret-token", "private-key", "unrelated", "stable_one\n", root + "/"]) {
      expect(everything.replace(/"path": "\/repo\/\.github[^"]*"/g, "")).not.toContain(secret);
    }
    const empty = setup();
    expect(await empty.call("get", "identity.triage_role", "--entry", "codex")).toBe(0);
    expect(empty.out[0]).toContain("(unset)");
    expect(empty.out[0]).toContain(
      "config set identity.triage_role implementer|designer --entry codex",
    );
    expect(empty.files.size).toBe(0);
    expect(empty.calls.some((c) => c.startsWith("check-ignore"))).toBe(false);
  });

  it("adds triage_role preserving names, role, typed unknown values and other agents", async () => {
    const t = setup(sample);
    expect(
      await t.call("set", "identity.triage_role", "implementer", "--entry", "codex", "--json"),
    ).toBe(0);
    expect(t.json()).toMatchObject({ changed: true, createdEntry: false, generatedName: null });
    const written = t.files.get(file)!;
    const document = parseIdentityDocument(written);
    expect(document.big).toBe(9007199254740993n);
    expect(document.ratio).toBe(1);
    expect(written).toMatch(/^ratio = 1\.0$/m);
    expect(written).toContain("when = 1979-05-27T07:32:00.000-08:00");
    expect(written).toMatch(/^day = 1979-05-27$/m);
    expect(written).toContain('[agents."ori.review"]');
    expect(document.agents).toEqual({
      codex: {
        name: "stable_one",
        role: "agent",
        token: "s3cret-token",
        triage_role: "implementer",
      },
      "ori.review": { name: "other_agent", triage_role: "designer", api_key: "private-key" },
    });
    expect(document.extra).toEqual([{ x: 1n }]);
    // Documented limitation: the serializer does not keep comments.
    expect(written).not.toContain("#");
    expect(await t.call("set", "identity.triage_role", "implementer", "--entry", "codex")).toBe(0);
    expect(t.out.at(-1)).toContain("unchanged");
  });

  it("initialises a missing file once with a generated unique name after excluding it", async () => {
    const t = setup();
    expect(
      await t.call("set", "identity.triage_role", "designer", "--entry", "claude", "--json"),
    ).toBe(0);
    const first = t.json();
    expect(first).toMatchObject({ createdFile: true, createdEntry: true, excludeRuleAdded: true });
    expect(first.generatedName).toMatch(/^[a-z]+_[a-z]+$/);
    expect(t.files.get(exclude)).toBe(
      `/${IDENTITY_FILE}\n/${IDENTITY_FILE}.*.tmp\n/${IDENTITY_FILE}.lock\n`,
    );
    expect(t.calls.indexOf("rev-parse --git-path info/exclude")).toBeGreaterThan(-1);
    expect(
      await t.call("set", "identity.triage_role", "implementer", "--entry", "claude", "--json"),
    ).toBe(0);
    expect(t.json()).toMatchObject({
      createdEntry: false,
      generatedName: null,
      excludeRuleAdded: false,
    });
    expect(await t.call("get", "identity.name", "--entry", "claude", "--json")).toBe(0);
    expect(t.json().value).toBe(first.generatedName);
    const taken = new Set(["amara_abara"]);
    expect(generateName(taken, () => 0.999)).not.toBe("amara_abara");
    let calls = 0;
    expect(generateName(taken, () => (calls++ < 2 ? 0 : 0.5))).not.toBe("amara_abara");
  });

  it("explicit name changes refuse local collisions and never regenerate", async () => {
    const t = setup(sample);
    expect(await t.call("set", "identity.name", "OTHER_AGENT", "--entry", "codex", "--json")).toBe(
      1,
    );
    expect(t.json()).toMatchObject({ code: "conflict" });
    expect(await t.call("set", "identity.name", "renamed", "--entry", "codex", "--json")).toBe(0);
    expect(parseIdentityDocument(t.files.get(file)!).agents).toMatchObject({
      codex: { name: "renamed", role: "agent" },
    });
    expect(await t.call("set", "identity.name", "bad name", "--entry", "codex", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "invalid-value" });
    expect(await t.call("set", "identity.triage_role", "agent", "--entry", "codex", "--json")).toBe(
      1,
    );
    expect(t.json()).toMatchObject({ code: "invalid-value" });
  });

  it("requires explicit entry selection without breaking repository settings", async () => {
    const t = setup(sample);
    expect(await t.call("get", "identity.name", "--repo", "owner/name", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "identity-unresolved" });
    expect(t.json().recovery).toContain(
      "pdb config get identity.name --entry KEY --repo owner/name",
    );
    expect(t.json().recovery).not.toContain("#");
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ identity: { resolved: false } });
    expect(await t.call("get", "complexity.enabled")).toBe(0);
    expect(await t.call("get", "complexity.enabled", "--entry", "codex", "--json")).toBe(1);
    expect(await t.call("get", "identity.name", "--entry", "__proto__", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "invalid-value" });
    expect(await t.call("get", "identity.colour", "--entry", "codex", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unknown-key" });
    expect(
      await t.call("get", "identity.name", "--entry", "codex", "--repo", "other/x", "--json"),
    ).toBe(1);
    expect(t.json()).toMatchObject({ code: "repository-mismatch" });
  });

  it("detects the harness from each registered signal by name only", () => {
    for (const detector of HARNESS_DETECTORS) {
      for (const signal of detector.environment) {
        expect(detectHarness({ [signal]: "secret-value" })).toEqual({
          status: "detected",
          harness: detector.harness,
          signals: [signal],
        });
      }
    }
    expect(detectHarness({})).toEqual({ status: "none", signals: [] });
    // Empty values and weak installation settings are not evidence of a live session.
    expect(detectHarness({ CLAUDECODE: "", CODEX_HOME: "/x", PATH: "/bin" })).toMatchObject({
      status: "none",
    });
    expect(detectHarness({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" })).toEqual({
      status: "conflict",
      harnesses: ["claude", "codex"],
      signals: ["CLAUDECODE", "CODEX_THREAD_ID"],
    });
  });

  it("matches the Ori server prefix before embedded generic client names", () => {
    expect(detectClientEntry("ori-pdb")).toEqual({
      harness: "ori",
      entry: "ori.pdb",
    });
    expect(detectClientEntry("ori-claude-helper")).toEqual({
      harness: "ori",
      entry: "ori.claude-helper",
    });
    expect(detectClientEntry("ori-pdb-2")?.entry).not.toBe("ori.pdb");
    expect(detectClientEntry("ori-")).toBeNull();
    expect(detectClientEntry("ori-bad name")).toBeNull();
    expect(detectClientEntry("claude-code")).toBeNull();
    expect(detectClientEntry("codex")).toBeNull();
  });

  it("resolves explicit --entry, then --harness, then detection, reading only entry keys", async () => {
    const files = new Map([[file, sample]]);
    const fs = { readText: async (path: string) => files.get(path) ?? null } as ConfigFileSystem;
    const codexEnv = { CODEX_THREAD_ID: "t" };
    expect(
      await resolveEntry({ entry: "ori.review", harness: "codex", env: codexEnv, root, fs }),
    ).toMatchObject({ status: "resolved", entry: "ori.review", source: "--entry" });
    expect(await resolveEntry({ harness: "claude", env: codexEnv, root, fs })).toMatchObject({
      status: "resolved",
      entry: "claude",
      source: "--harness",
    });
    expect(await resolveEntry({ env: codexEnv, root, fs })).toEqual({
      status: "resolved",
      entry: "codex",
      source: "environment",
      harness: "codex",
      signals: ["CODEX_THREAD_ID"],
    });
    await expect(resolveEntry({ harness: "cursor", env: {}, root, fs })).rejects.toMatchObject({
      code: "invalid-value",
    });
    // Ori in a shell names no server entry: never borrow ori.review, even though it is the only one.
    expect(await resolveEntry({ env: { ORI_SESSION_ID: "s" }, root, fs })).toMatchObject({
      status: "unresolved",
      reason: "no-entry-key",
      candidates: ["ori.review"],
    });
    expect(await resolveEntry({ harness: "ori", env: {}, root, fs })).toMatchObject({
      status: "unresolved",
      reason: "no-entry-key",
    });
    // Several logical entries for one harness need explicit selection.
    files.set(file, `${sample}\n[agents."codex.review"]\nname = "third_one"\n`);
    expect(await resolveEntry({ env: codexEnv, root, fs })).toMatchObject({
      status: "unresolved",
      reason: "several-entries",
      candidates: ["codex", "codex.review"],
    });
    // Only an unrelated or differently keyed entry exists: still no borrowing.
    files.set(file, `[agents."codex.review"]\nname = "third_one"\n`);
    expect(await resolveEntry({ env: codexEnv, root, fs })).toMatchObject({
      status: "unresolved",
      reason: "several-entries",
    });
    files.set(file, `[agents.other]\nname = "x"\n`);
    expect(await resolveEntry({ env: { CLAUDECODE: "1" }, root, fs })).toMatchObject({
      status: "resolved",
      entry: "claude",
    });
    expect(
      await resolveEntry({ env: { CLAUDECODE: "1", ORI_SESSION_ID: "s" }, root, fs }),
    ).toMatchObject({
      status: "unresolved",
      reason: "conflict",
      harnesses: ["claude", "ori"],
    });
    expect(await resolveEntry({ env: {}, root, fs })).toMatchObject({
      status: "unresolved",
      reason: "no-signal",
    });
  });

  it("config get/set/list use the detected entry and report the deciding source", async () => {
    const t = setup(sample, { env: { CODEX_SANDBOX: "seatbelt-secret" } });
    expect(await t.call("get", "identity.name", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      entry: "codex",
      value: "stable_one",
      selection: "environment",
      harness: "codex",
      signals: ["CODEX_SANDBOX"],
    });
    expect(await t.call("get", "identity.name")).toBe(0);
    expect(t.out.at(-1)).toContain("detected codex from CODEX_SANDBOX");
    expect(await t.call("set", "identity.triage_role", "designer", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ entry: "codex", changed: true, selection: "environment" });
    expect(parseIdentityDocument(t.files.get(file)!).agents).toMatchObject({
      codex: { name: "stable_one", role: "agent", triage_role: "designer" },
      "ori.review": { name: "other_agent", triage_role: "designer" },
    });
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json().identity).toMatchObject({ resolved: true, entry: "codex", harness: "codex" });
    expect(await t.call("get", "identity.name", "--harness", "claude", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ entry: "claude", selection: "--harness", value: null });
    expect(await t.call("get", "identity.name", "--entry", "ori.review", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ value: "other_agent", selection: "--entry" });
    expect(t.out.join("")).not.toContain("seatbelt-secret");
    expect(
      await t.call("get", "identity.name", "--entry", "codex", "--harness", "codex", "--json"),
    ).toBe(1);
    expect(t.json()).toMatchObject({ code: "usage" });
    expect(await t.call("get", "complexity.enabled", "--harness", "codex", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "usage" });
  });

  it("refuses conflicting, ambiguous or missing evidence with exact explicit commands", async () => {
    const conflict = setup(sample, { env: { CLAUDECODE: "1", CODEX_CI: "1" } });
    expect(
      await conflict.call(
        "set",
        "identity.triage_role",
        "designer",
        "--repo",
        "owner/name",
        "--json",
      ),
    ).toBe(1);
    const refused = conflict.json();
    expect(refused).toMatchObject({ code: "identity-unresolved" });
    expect(refused.message).toContain("claude, codex");
    expect(refused.message).toContain("CLAUDECODE, CODEX_CI");
    expect(refused.recovery).toContain(
      "pdb config set identity.triage_role designer --entry KEY --repo owner/name",
    );
    expect(refused.recovery).not.toContain("#");
    expect(conflict.files.get(file)).toBe(sample);

    const ori = setup(sample, { env: { ORI_SESSION_ID: "s" } });
    expect(await ori.call("get", "identity.name", "--json")).toBe(1);
    expect(ori.json().recovery).toContain("pdb config get identity.name --entry ori.review");
    expect(await ori.call("list", "--json")).toBe(0);
    expect(ori.json().identity).toMatchObject({ resolved: false, reason: "no-entry-key" });
    expect(await ori.call("list")).toBe(0);
    expect(ori.out.at(-1)).toContain("pdb config list --entry ori.review");

    const none = setup(undefined, { env: {} });
    expect(await none.call("set", "identity.triage_role", "designer", "--json")).toBe(1);
    expect(none.json()).toMatchObject({ code: "identity-unresolved" });
    expect(none.json().message).toContain("No supported harness was detected");
    expect(none.files.size).toBe(0);
  });

  it("keeps repository settings listable when the identity file is unreadable", async () => {
    const t = setup(sample);
    const realRead = t.fs.readText;
    t.fs.readText = async (path) => {
      if (path === file) throw Object.assign(new Error("denied"), { code: "EACCES", path });
      return realRead(path);
    };
    expect(await t.call("list", "--entry", "codex", "--json")).toBe(0);
    const listed = t.json();
    expect(listed.settings.length).toBeGreaterThan(0);
    expect(listed.identity).toMatchObject({ resolved: false, error: { code: "filesystem" } });
  });

  it("keeps repository settings listable after --harness lookup errors, but rejects bad harness names", async () => {
    const bad = setup('[agents.codex]\nname = "x"\ntoken = "leak-me\n');
    expect(await bad.call("list", "--harness", "codex", "--json")).toBe(0);
    const listed = bad.json();
    expect(listed.settings.length).toBeGreaterThan(0);
    expect(listed.identity).toMatchObject({ resolved: false, error: { code: "malformed" } });
    expect(bad.out.at(-1)).not.toContain("leak-me");
    const t = setup(sample);
    expect(await t.call("list", "--harness", "bogus", "--json")).toBe(1);
  });

  it("refuses malformed or tracked files without rewriting or echoing contents", async () => {
    const bad = setup('[agents.codex]\nname = "x"\ntoken = "leak-me\n');
    expect(await bad.call("get", "identity.name", "--entry", "codex", "--json")).toBe(1);
    expect(bad.json()).toMatchObject({ code: "malformed" });
    expect(bad.out.at(-1)).not.toContain("leak-me");
    expect(await bad.call("list", "--entry", "codex", "--json")).toBe(0);
    expect(bad.json().identity).toMatchObject({ resolved: false, error: { code: "malformed" } });
    expect(
      await bad.call("set", "identity.triage_role", "designer", "--entry", "codex", "--json"),
    ).toBe(1);
    expect(bad.files.get(file)).toBe('[agents.codex]\nname = "x"\ntoken = "leak-me\n');
    const notTable = setup("agents = 3\n");
    expect(await notTable.call("set", "identity.name", "a", "--entry", "codex", "--json")).toBe(1);
    expect(notTable.json()).toMatchObject({ code: "malformed" });
    const tracked = setup(sample, { tracked: true, ignored: true });
    expect(
      await tracked.call("set", "identity.triage_role", "designer", "--entry", "codex", "--json"),
    ).toBe(1);
    expect(tracked.json()).toMatchObject({ code: "tracked" });
    expect(tracked.files.get(file)).toBe(sample);
    expect(tracked.calls.some((c) => /\brm\b|commit|add/.test(c))).toBe(false);
  });

  it("refuses a concurrent edit instead of overwriting it", async () => {
    const t = setup(sample, { ignored: true });
    const original = t.fs.writeText;
    t.fs.writeText = async (path, text) => {
      await original(path, text);
      // An editor that ignores the lock: the unchanged-since-read guard still refuses.
      if (path.endsWith(".tmp"))
        t.files.set(file, sample + '\n[agents.late]\nname = "late_comer"\n');
    };
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: t.fs,
        git: t.git,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(t.files.get(file)).toContain("late_comer");
    expect([...t.files.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: t.fs,
        git: t.git,
        expectedRaw: sample,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a tracked file and excludes an unignored one even when the value is unchanged", async () => {
    const equal = '[agents.codex]\nname = "stable_one"\ntriage_role = "designer"\n';
    const tracked = setup(equal, { tracked: true, ignored: true });
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: tracked.fs,
        git: tracked.git,
      }),
    ).rejects.toMatchObject({ code: "tracked" });
    expect(tracked.files.get(file)).toBe(equal);

    const unignored = setup(equal);
    const write = await setIdentity(
      { root, repository: null },
      "codex",
      "identity.triage_role",
      "designer",
      { fs: unignored.fs, git: unignored.git },
    );
    expect(write).toMatchObject({ changed: false, excluded: true });
    expect(unignored.files.get(exclude)).toBe(
      `/${IDENTITY_FILE}\n/${IDENTITY_FILE}.*.tmp\n/${IDENTITY_FILE}.lock\n`,
    );
    expect(unignored.files.get(file)).toBe(equal);
  });

  it.skipIf(process.platform === "win32")(
    "creates the identity file 0600 and keeps an existing file's mode on replace",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-identity-mode-"));
      const previous = process.umask(0o022);
      try {
        await new Promise<void>((resolve, reject) =>
          execFile("git", ["init", "-q"], { cwd: dir }, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        const target = await resolveIdentityTarget(dir, undefined);
        const path = join(target.root, IDENTITY_FILE);
        await setIdentity(target, "codex", "identity.triage_role", "designer", {
          random: () => 0.1,
        });
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await setIdentity(target, "codex", "identity.triage_role", "implementer");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await chmod(path, 0o640);
        await setIdentity(target, "codex", "identity.triage_role", "designer");
        expect((await stat(path)).mode & 0o777).toBe(0o640);
      } finally {
        process.umask(previous);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("refuses to round sub-millisecond timestamps in unrelated values (#165 review)", async () => {
    const precise = `when = 1979-05-27T07:32:00.123456Z\nat = 07:32:00.999999\nnote = "12:00:00.123456"\n[agents.codex]\nname = "stable_one"\n`;
    const t = setup(precise, { ignored: true });
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: t.fs,
        git: t.git,
      }),
    ).rejects.toMatchObject({ code: "incompatible" });
    expect(t.files.get(file)).toBe(precise);
    // Millisecond values, trailing zeros and look-alike strings are still rewritten.
    const fine = `when = 1979-05-27T07:32:00.123000Z\nnote = "12:00:00.123456"\n`;
    const ok = setup(fine, { ignored: true });
    await setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
      fs: ok.fs,
      git: ok.git,
      random: () => 0.1,
    });
    expect(ok.files.get(file)).toContain('note = "12:00:00.123456"');
    // A string repeating the same time text must not mask the rounding of the literal.
    const masked = `when = 1979-05-27T07:32:00.123456Z\nnote = "07:32:00.123456"\n`;
    const m = setup(masked, { ignored: true });
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: m.fs,
        git: m.git,
      }),
    ).rejects.toMatchObject({ code: "incompatible" });
    expect(m.files.get(file)).toBe(masked);
  });

  it("appends exclude rules without replacing concurrent additions (#165 review)", async () => {
    const t = setup(sample);
    t.files.set(exclude, "# local\n/scratch");
    const realRead = t.fs.readText;
    t.fs.readText = async (path) => {
      const text = await realRead(path);
      // Another tool appends after this one read the exclude file.
      if (path === exclude) t.files.set(exclude, `${t.files.get(exclude)}\n/late-rule\n`);
      return text;
    };
    t.fs.rename = async (from, to) => {
      if (to === exclude) throw new Error("info/exclude must not be replaced");
      t.files.set(to, t.files.get(from)!);
      t.files.delete(from);
    };
    await setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
      fs: t.fs,
      git: t.git,
    });
    expect(t.files.get(exclude)!.split("\n")).toEqual(
      expect.arrayContaining(["/scratch", "/late-rule", `/${IDENTITY_FILE}`]),
    );
  });

  it("removes a partially written temporary copy when the write fails (#165 review)", async () => {
    const t = setup(sample, { ignored: true });
    const original = t.fs.writeText;
    t.fs.writeText = async (path, text) => {
      if (!path.endsWith(".tmp")) return original(path, text);
      t.files.set(path, text.slice(0, 10));
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    await expect(
      setIdentity({ root, repository: null }, "codex", "identity.triage_role", "designer", {
        fs: t.fs,
        git: t.git,
      }),
    ).rejects.toThrow("disk full");
    expect([...t.files.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);
    expect(t.files.get(file)).toBe(sample);
  });

  it("keeps an interrupted temporary copy out of git status, even when the file was already ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-identity-tmp-"));
    try {
      const run = (...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd: dir }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      await run("init", "-q");
      // The identity file is already ignored by a committed-style rule; the copy is not.
      await writeFile(join(dir, ".gitignore"), `/${IDENTITY_FILE}\n`);
      const target = await resolveIdentityTarget(dir, undefined);
      // Simulate a crash between writing the temporary copy and renaming it.
      const crashing: ConfigFileSystem = {
        ...nodeFileSystem,
        rename: async () => {
          throw new Error("killed");
        },
        remove: async () => undefined,
      };
      await expect(
        setIdentity(target, "codex", "identity.triage_role", "designer", {
          fs: crashing,
          random: () => 0.1,
          token: () => "crash",
        }),
      ).rejects.toThrow("killed");
      expect(await readdir(dir)).toContain(`${IDENTITY_FILE}.crash.tmp`);
      expect(await run("status", "--porcelain", "--untracked-files=all")).toBe("?? .gitignore\n");
      await run("add", "-A");
      expect(await run("diff", "--cached", "--name-only")).toBe(".gitignore\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("concurrent writers share one file under a lock (#165 review, Codex P1)", () => {
    async function withRepo(
      body: (dir: string, run: (...a: string[]) => Promise<string>) => Promise<void>,
    ) {
      const dir = await mkdtemp(join(tmpdir(), "triage-identity-lock-"));
      const run = (...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd: dir }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      try {
        await run("init", "-q");
        await body(dir, run);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const initial = '[agents.codex]\nname = "stable_one"\n\n[agents.ori]\nname = "other_agent"\n';
    /**
     * Explicit sequencing, no real-time head start (#177). Each writer's Git exclusion check
     * runs before the lock and takes an unpredictable time, so a sleep cannot decide which
     * writer locks first. Instead writer B is started only once writer A holds the lock, and A
     * pauses before its rename until B has tried the lock and found it held. Without the lock, B
     * would read the same document as A and its rename would revert A's change; with it, B can
     * read only after A has released. Generous lock bounds keep the wait and stale thresholds
     * out of play on a slow runner; B's polling is the only real delay left.
     */
    const patient: LockTiming = { waitMs: 60_000, staleMs: 600_000, pollMs: 5 };
    function sequenced(lockPath: string) {
      let aLocked: () => void = () => undefined;
      let bBlocked: () => void = () => undefined;
      const aHoldsLock = new Promise<void>((resolve) => (aLocked = resolve));
      const bFoundLockHeld = new Promise<void>((resolve) => (bBlocked = resolve));
      const a: ConfigFileSystem = {
        ...nodeFileSystem,
        writeText: async (file, text, mode) => {
          await nodeFileSystem.writeText(file, text, mode);
          if (file === lockPath) aLocked();
        },
        rename: async (from, to) => {
          await bFoundLockHeld;
          await nodeFileSystem.rename(from, to);
        },
      };
      const b: ConfigFileSystem = {
        ...nodeFileSystem,
        writeText: async (file, text, mode) => {
          try {
            await nodeFileSystem.writeText(file, text, mode);
          } catch (error) {
            if (file === lockPath && (error as NodeJS.ErrnoException).code === "EEXIST") bBlocked();
            throw error;
          }
        },
      };
      return { a, b, aHoldsLock };
    }

    it("keeps both agents' changes to different entries", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const path = join(target.root, IDENTITY_FILE);
        await writeFile(path, initial);
        const { a, b, aHoldsLock } = sequenced(join(target.root, IDENTITY_LOCK_FILE));
        const first = setIdentity(target, "codex", "identity.triage_role", "designer", {
          fs: a,
          lockTiming: patient,
        });
        await aHoldsLock;
        const second = setIdentity(target, "ori", "identity.triage_role", "implementer", {
          fs: b,
          lockTiming: patient,
        });
        await Promise.all([first, second]);
        const after = await readFile(path, "utf8");
        expect(after).toMatch(/\[agents\.codex\][^[]*triage_role = "designer"/);
        expect(after).toMatch(/\[agents\.ori\][^[]*triage_role = "implementer"/);
        expect(await readdir(dir)).not.toContain(IDENTITY_LOCK_FILE);
      });
    });

    it("applies concurrent writes of the same key in lock order, never corrupting the file", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const path = join(target.root, IDENTITY_FILE);
        await writeFile(path, initial);
        const { a, b, aHoldsLock } = sequenced(join(target.root, IDENTITY_LOCK_FILE));
        const first = setIdentity(target, "codex", "identity.triage_role", "designer", {
          fs: a,
          lockTiming: patient,
        });
        await aHoldsLock;
        const second = setIdentity(target, "codex", "identity.triage_role", "implementer", {
          fs: b,
          lockTiming: patient,
        });
        expect(await Promise.all([first, second])).toMatchObject([
          { changed: true },
          { changed: true },
        ]);
        const record = await readIdentity(target.root, "codex");
        expect(record).toMatchObject({ name: "stable_one", triageRole: "implementer" });
        expect(await readFile(path, "utf8")).toContain('name = "other_agent"');
        expect(await readdir(dir)).not.toContain(IDENTITY_LOCK_FILE);
      });
    });

    it("recovers a stale lock left by a crashed writer", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const lock = join(target.root, IDENTITY_LOCK_FILE);
        await writeFile(lock, '{"token":"crashed"}');
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        await setIdentity(target, "codex", "identity.triage_role", "designer", {
          random: () => 0.1,
          lockTiming: { waitMs: 2_000, staleMs: 10_000, pollMs: 10 },
        });
        expect((await readIdentity(target.root, "codex")).triageRole).toBe("designer");
        expect(await readdir(dir)).not.toContain(IDENTITY_LOCK_FILE);
      });
    });

    it("refuses as busy, leaving the file and the holder's lock alone, when the lock is held too long", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const path = join(target.root, IDENTITY_FILE);
        const lock = join(target.root, IDENTITY_LOCK_FILE);
        await writeFile(path, initial);
        await writeFile(lock, '{"token":"live-holder"}');
        await expect(
          setIdentity(target, "codex", "identity.triage_role", "designer", {
            lockTiming: { waitMs: 150, staleMs: 60_000, pollMs: 10 },
          }),
        ).rejects.toMatchObject({ code: "conflict", recovery: expect.stringMatching(/^Retry/) });
        expect(await readFile(path, "utf8")).toBe(initial);
        expect(await readFile(lock, "utf8")).toBe('{"token":"live-holder"}');
      });
    });

    it("keeps the lock file out of git status", async () => {
      await withRepo(async (dir, run) => {
        const target = await resolveIdentityTarget(dir, undefined);
        await setIdentity(target, "codex", "identity.triage_role", "designer", {
          random: () => 0.1,
        });
        // A lock left behind (crash, or a writer mid-update) is ignored too.
        await writeFile(join(target.root, IDENTITY_LOCK_FILE), '{"token":"crashed"}');
        expect(await run("status", "--porcelain", "--untracked-files=all", "--ignored=no")).toBe(
          "",
        );
      });
    });
  });

  it("resolves the working-tree root from nested directories and linked worktrees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-identity-"));
    try {
      const run = (cwd: string, ...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      const main_ = join(dir, "main");
      await mkdir(join(main_, "a", "b"), { recursive: true });
      await run(main_, "init", "-q");
      await run(
        main_,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      );
      await writeFile(join(dir, IDENTITY_FILE), '[agents.codex]\nname = "parent_leak"\n');
      const nested = await resolveIdentityTarget(join(main_, "a", "b"), undefined);
      expect(await readFile(join(nested.root, ".git", "HEAD"), "utf8")).toContain("ref:");
      const write = await setIdentity(nested, "codex", "identity.triage_role", "designer", {
        random: () => 0.1,
      });
      expect(write.createdFile).toBe(true);
      expect(write.record.name).not.toBe("parent_leak");
      expect(await run(main_, "status", "--porcelain")).toBe("");
      const tree = join(dir, "tree");
      await run(main_, "worktree", "add", "-q", tree);
      const linked = await resolveIdentityTarget(tree, undefined);
      expect(await readdir(linked.root)).not.toContain(IDENTITY_FILE);
      expect((await readIdentity(linked.root, "codex")).fileExists).toBe(false);
      await setIdentity(linked, "codex", "identity.triage_role", "implementer", {
        random: () => 0.2,
      });
      expect(await run(tree, "status", "--porcelain")).toBe("");
      expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toContain("parent_leak");
      await expect(resolveIdentityTarget(dir, undefined)).rejects.toMatchObject({
        code: "not-a-repository",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
