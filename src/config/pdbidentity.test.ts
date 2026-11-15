/**
 * PDB-owned identity store and one-time Agent Inbox import (#319,
 * doc/design/pdb-owned-identity.md). Real temporary Git repositories and the real filesystem
 * are used throughout; nothing here reads or writes this checkout's own identity files.
 */
import { describe, expect, it } from "vite-plus/test";
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { nodeFileSystem, type ConfigFileSystem } from "./config.js";
import {
  IDENTITY_FILE,
  IDENTITY_LOCK_FILE,
  LEGACY_IDENTITY_FILE,
  listEntryKeys,
  readIdentity,
  resolveIdentityTarget,
  setIdentity,
} from "./identity.js";
import { resolveReadIdentity } from "./readidentity.js";
import { localDoctor, nodeProbe, type Probe } from "./localdoctor.js";

/** Real git, but no gh process (and so no network) during doctor checks. */
const probe: Probe = (command, args, cwd) =>
  command === "git" ? nodeProbe(command, args, cwd) : Promise.resolve({ code: 0, stdout: "" });

const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );

const LEGACY = `hub = "https://hub.example"
token = "legacy-secret-token"

[agents.codex]
name = "legacy_codex"
triage_role = "designer"
role = "agent"
api_key = "private"

[agents.claude]
name = "legacy_claude"
`;

/** A fresh repository in a temporary directory, removed afterwards. */
async function withRepo(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdb-identity-"));
  try {
    await git(dir, "init", "-q");
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A filesystem that records every mutation, to prove read-only paths make none. */
function recording(): { fs: ConfigFileSystem; writes: string[] } {
  const writes: string[] = [];
  const fs: ConfigFileSystem = {
    ...nodeFileSystem,
    writeText: async (path, text, mode) => {
      writes.push(path);
      await nodeFileSystem.writeText(path, text, mode);
    },
    appendText: async (path, text) => {
      writes.push(path);
      await nodeFileSystem.appendText!(path, text);
    },
    rename: async (from, to) => {
      writes.push(to);
      await nodeFileSystem.rename(from, to);
    },
    remove: async (path) => {
      writes.push(path);
      await nodeFileSystem.remove(path);
    },
    makeDirectory: async (path) => {
      writes.push(path);
      await nodeFileSystem.makeDirectory(path);
    },
  };
  return { fs, writes };
}

async function config(dir: string, env: Record<string, string>, ...args: string[]) {
  const out: string[] = [];
  const code = await main(["config", ...args, "--no-update-check"], async (t) => void out.push(t), {
    collect: async () => {
      throw new Error("no GitHub");
    },
    currentRepository: async () => {
      throw new Error("no GitHub");
    },
    config: { cwd: dir, env, random: () => 0.37 },
  });
  return { code, text: out.join(""), json: () => JSON.parse(out.at(-1)!) };
}

describe("PDB-owned identity store (#319)", () => {
  it("keeps an existing pdb.toml identity canonical over a different legacy name", async () => {
    await withRepo(async (dir) => {
      await writeFile(
        join(dir, IDENTITY_FILE),
        'schemaVersion = 1\n\n[agents.codex]\nname = "pdb_codex"\n',
      );
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      const target = await resolveIdentityTarget(dir, undefined);
      expect(await readIdentity(dir, "codex")).toMatchObject({
        source: "pdb",
        path: IDENTITY_FILE,
        name: "pdb_codex",
        triageRole: null,
      });
      const write = await setIdentity(target, "codex", "identity.triage_role", "implementer");
      expect(write).toMatchObject({ importedFrom: null, generatedName: null });
      expect(write.record).toMatchObject({ name: "pdb_codex", triageRole: "implementer" });
      // The legacy role "designer" was not copied over an existing PDB entry.
      expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe(LEGACY);
    });
  });

  it("returns a legacy identity read-only, then imports only name and triage_role once", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      const env = { CODEX_THREAD_ID: "t" };

      // Read-only lookups: legacy-not-imported, zero filesystem writes, no import claimed.
      const { fs, writes } = recording();
      const read = await readIdentity(dir, "codex", fs);
      expect(read).toMatchObject({
        source: "legacy-not-imported",
        path: LEGACY_IDENTITY_FILE,
        name: "legacy_codex",
        triageRole: "designer",
        fileExists: false,
        entryExists: false,
      });
      const focused = await resolveReadIdentity({ project: dir, env, fs });
      expect(focused).toMatchObject({
        agent: "legacy_codex",
        store: "legacy-not-imported",
        storeDiagnostic: expect.stringContaining(
          "pdb config set identity.triage_role designer --entry codex",
        ),
      });
      await git(dir, "remote", "add", "origin", "https://github.com/owner/name.git");
      const report = await localDoctor({}, { cwd: dir, fs, env, probe, nodeVersion: "26.0.0" });
      expect(report).toMatchObject({ agent: "legacy_codex", role: "designer", entry: "codex" });
      expect(report.checks.find((c) => c.id === "identity.entry")).toMatchObject({
        status: "missing",
        detail: expect.stringContaining("legacy-not-imported"),
      });
      expect(writes).toEqual([]);
      const got = await config(dir, env, "get", "identity.name", "--json");
      expect(got.json()).toMatchObject({
        value: "legacy_codex",
        store: "legacy-not-imported",
        path: LEGACY_IDENTITY_FILE,
      });
      expect(await readdir(dir)).not.toContain(IDENTITY_FILE);

      // The explicit initializer imports it; the legacy file is never changed.
      const set = await config(dir, env, "set", "identity.triage_role", "designer", "--json");
      expect(set.code).toBe(0);
      expect(set.json()).toMatchObject({
        changed: true,
        createdFile: true,
        createdEntry: true,
        generatedName: null,
        importedFrom: LEGACY_IDENTITY_FILE,
        value: "designer",
      });
      const stored = await readFile(join(dir, IDENTITY_FILE), "utf8");
      expect(stored).toMatch(/^schemaVersion = 1\n/);
      expect(stored).toContain('name = "legacy_codex"');
      for (const secret of ["legacy-secret-token", "private", "hub", 'role = "agent"', "claude"])
        expect(stored).not.toContain(secret);
      expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe(LEGACY);
      expect(await readIdentity(dir, "codex")).toMatchObject({ source: "pdb" });
    });
  });

  it("imports the legacy role when an explicit name is set, keeping the explicit name", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      const target = await resolveIdentityTarget(dir, undefined);
      const write = await setIdentity(target, "codex", "identity.name", "chosen_name");
      expect(write.importedFrom).toBe(LEGACY_IDENTITY_FILE);
      expect(write.record).toMatchObject({ name: "chosen_name", triageRole: "designer" });
    });
  });

  it("generates a fresh name once when neither store has the entry, avoiding legacy names", async () => {
    await withRepo(async (dir) => {
      const target = await resolveIdentityTarget(dir, undefined);
      // A random source that would pick legacy_claude's name is irrelevant: generated names are
      // first_last, so check the taken-set by making the legacy file hold the first candidate.
      const first = await setIdentity(target, "codex", "identity.triage_role", "implementer", {
        random: () => 0,
      });
      expect(first.generatedName).toBe("amara_abara");
      await rm(join(dir, IDENTITY_FILE));
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), '[agents.other]\nname = "amara_abara"\n');
      let calls = 0;
      const second = await setIdentity(target, "codex", "identity.triage_role", "implementer", {
        random: () => (calls++ < 2 ? 0 : 0.99),
      });
      expect(second.importedFrom).toBeNull();
      expect(second.generatedName).not.toBe("amara_abara");
      // Rerun: the generated name is kept, never regenerated.
      const again = await setIdentity(target, "codex", "identity.triage_role", "designer", {
        random: () => 0.5,
      });
      expect(again).toMatchObject({ generatedName: null, createdEntry: false });
      expect(again.record.name).toBe(second.generatedName);
    });
  });

  it("keeps the imported name stable after the legacy file is edited or removed", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      const target = await resolveIdentityTarget(dir, undefined);
      await setIdentity(target, "codex", "identity.triage_role", "implementer");
      await writeFile(
        join(dir, LEGACY_IDENTITY_FILE),
        LEGACY.replace("legacy_codex", "renamed_elsewhere"),
      );
      expect((await readIdentity(dir, "codex")).name).toBe("legacy_codex");
      const rerun = await setIdentity(target, "codex", "identity.triage_role", "implementer");
      expect(rerun).toMatchObject({ changed: false, importedFrom: null });
      await rm(join(dir, LEGACY_IDENTITY_FILE));
      expect(await readIdentity(dir, "codex")).toMatchObject({
        name: "legacy_codex",
        source: "pdb",
      });
      await setIdentity(target, "codex", "identity.triage_role", "designer");
      expect((await readIdentity(dir, "codex")).name).toBe("legacy_codex");
    });
  });

  it("refuses ambiguous or conflicting harness evidence with explicit selection guidance", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, IDENTITY_FILE), '[agents.codex]\nname = "pdb_codex"\n');
      await writeFile(
        join(dir, LEGACY_IDENTITY_FILE),
        '[agents."codex.review"]\nname = "reviewer"\n',
      );
      // Legacy-only entries count: they are distinct logical agents that may be imported.
      expect(await listEntryKeys(dir)).toEqual(["codex", "codex.review"]);
      await expect(
        config(dir, { CODEX_THREAD_ID: "t" }, "set", "identity.triage_role", "designer"),
      ).rejects.toThrow(
        /Several logical agent entries use the codex harness[\s\S]*--entry codex\.review/,
      );
      await expect(
        config(dir, { CODEX_THREAD_ID: "t", CLAUDECODE: "1" }, "get", "identity.name"),
      ).rejects.toThrow(/Signals of several harnesses[\s\S]*--entry KEY/);
      // Explicit selection recovers, and nothing was written by the refusals.
      expect(await readdir(dir)).not.toContain(IDENTITY_LOCK_FILE);
      const chosen = await config(
        dir,
        {},
        "set",
        "identity.triage_role",
        "designer",
        "--entry",
        "codex.review",
        "--json",
      );
      expect(chosen.json()).toMatchObject({
        entry: "codex.review",
        importedFrom: LEGACY_IDENTITY_FILE,
      });
    });
  });

  it("never falls back from an invalid canonical entry or a future schema", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      await writeFile(join(dir, IDENTITY_FILE), '[agents.codex]\nname = "-bad name"\n');
      expect(await readIdentity(dir, "codex")).toMatchObject({ source: "pdb", name: null });
      const future = 'schemaVersion = 2\n\n[agents.codex]\nname = "x"\n';
      await writeFile(join(dir, IDENTITY_FILE), future);
      await expect(readIdentity(dir, "codex")).rejects.toMatchObject({
        code: "unsupported-version",
      });
      const target = await resolveIdentityTarget(dir, undefined);
      await expect(
        setIdentity(target, "codex", "identity.triage_role", "designer"),
      ).rejects.toMatchObject({ code: "unsupported-version" });
      expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toBe(future);
    });
  });

  it("refuses to initialise over a malformed, invalid or colliding legacy identity", async () => {
    await withRepo(async (dir) => {
      const target = await resolveIdentityTarget(dir, undefined);
      const cases: [string, string][] = [
        ["[agents\nbroken", "malformed"],
        ['[agents.codex]\nname = "-not valid"\n', "legacy-unsafe"],
        ["agents = 3\n", "malformed"],
      ];
      for (const [legacy, code] of cases) {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), legacy);
        await expect(
          setIdentity(target, "codex", "identity.triage_role", "designer"),
        ).rejects.toMatchObject({ code });
        expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe(legacy);
        expect(await readdir(dir)).not.toContain(IDENTITY_FILE);
        // Read-only lookups report it rather than treating it as absent.
        expect((await readIdentity(dir, "codex")).problems.join(" ")).toMatch(/agent-inbox\.toml/);
      }
      await writeFile(join(dir, IDENTITY_FILE), '[agents.claude]\nname = "legacy_codex"\n');
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      const before = await readFile(join(dir, IDENTITY_FILE), "utf8");
      await expect(
        setIdentity(target, "codex", "identity.triage_role", "designer"),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("already used"),
      });
      expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toBe(before);
    });
  });

  describe("an explicit name is the way out of an unusable legacy file (#528 review)", () => {
    type Prepare = (dir: string, legacyPath: string) => Promise<ConfigFileSystem | undefined>;
    const written =
      (legacy: string): Prepare =>
      async (_dir, legacyPath) => {
        await writeFile(legacyPath, legacy);
        return undefined;
      };
    const cases: [string, Prepare, RegExp][] = [
      ["malformed", written("[agents\nbroken"), /not valid for identity use/],
      ["not a table", written("[agents]\ncodex = 3\n"), /is not a table/],
      [
        "an invalid name",
        written('[agents.codex]\nname = "-not valid"\n'),
        /not a valid agent name/,
      ],
      [
        "tracked",
        async (dir, legacyPath) => {
          await writeFile(legacyPath, LEGACY);
          await git(dir, "add", "--", LEGACY_IDENTITY_FILE);
          return undefined;
        },
        /tracked by Git/,
      ],
      [
        "unreadable",
        async (_dir, legacyPath) => {
          await writeFile(legacyPath, LEGACY);
          return {
            ...nodeFileSystem,
            readText: async (path) => {
              if (path.endsWith(LEGACY_IDENTITY_FILE))
                throw Object.assign(new Error("denied"), { code: "EACCES" });
              return nodeFileSystem.readText(path);
            },
          };
        },
        /could not be read \(EACCES\)/,
      ],
    ];
    if (process.platform !== "win32")
      cases.push([
        "a symbolic link",
        async (dir, legacyPath) => {
          await writeFile(join(dir, "elsewhere.toml"), LEGACY);
          await symlink(join(dir, "elsewhere.toml"), legacyPath);
          return undefined;
        },
        /symbolic link/,
      ]);

    for (const [kind, prepare, reason] of cases)
      it(`creates the pdb.toml entry past a legacy file that is ${kind}, never importing or writing it`, async () => {
        await withRepo(async (dir) => {
          const target = await resolveIdentityTarget(dir, undefined);
          const legacyPath = join(target.root, LEGACY_IDENTITY_FILE);
          const fs = await prepare(target.root, legacyPath);
          const legacyBefore = await readFile(legacyPath, "utf8");
          // The automatic import (a role set generating or importing a name) still refuses.
          await expect(
            setIdentity(target, "codex", "identity.triage_role", "designer", { fs }),
          ).rejects.toBeInstanceOf(Error);
          expect(await readdir(target.root)).not.toContain(IDENTITY_FILE);
          const write = await setIdentity(target, "codex", "identity.name", "chosen_name", { fs });
          expect(write).toMatchObject({
            changed: true,
            createdEntry: true,
            importedFrom: null,
            generatedName: null,
            legacyIgnored: expect.stringMatching(reason),
          });
          expect(write.legacyIgnored).not.toMatch(/neither file was changed/);
          expect(write.record).toMatchObject({ name: "chosen_name", triageRole: null });
          // The role can now be set on the existing entry, still ignoring the legacy file.
          const role = await setIdentity(target, "codex", "identity.triage_role", "designer", {
            fs,
          });
          expect(role.record).toMatchObject({ name: "chosen_name", triageRole: "designer" });
          expect(await readFile(legacyPath, "utf8")).toBe(legacyBefore);
        });
      });

    it("reports the ignored legacy file in config set output", async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), "[agents\nbroken");
        const set = await config(
          dir,
          {},
          "set",
          "identity.name",
          "chosen_name",
          "--entry",
          "codex",
          "--json",
        );
        expect(set.json()).toMatchObject({
          importedFrom: null,
          legacyIgnored: expect.stringContaining("agent-inbox.toml is not valid"),
        });
        const text = await config(
          dir,
          {},
          "set",
          "identity.name",
          "other_name",
          "--entry",
          "claude",
        );
        expect(text.text).toMatch(
          /ignored the legacy identity file \(nothing imported; it was not changed\)/,
        );
        expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe("[agents\nbroken");
      });
    });
  });

  describe("names held only in agent-inbox.toml are never duplicated (#528 review)", () => {
    it("refuses an explicit name held by another legacy-only agent, on create and rename", async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
        const target = await resolveIdentityTarget(dir, undefined);
        await expect(
          setIdentity(target, "gemini", "identity.name", "Legacy_Claude"),
        ).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining(LEGACY_IDENTITY_FILE),
        });
        expect(await readdir(dir)).not.toContain(IDENTITY_FILE);
        await setIdentity(target, "gemini", "identity.name", "gemini_agent");
        await expect(
          setIdentity(target, "gemini", "identity.name", "legacy_codex"),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await readIdentity(dir, "gemini")).name).toBe("gemini_agent");
        // The same entry's own legacy name is not a collision.
        const own = await setIdentity(target, "codex", "identity.name", "legacy_codex");
        expect(own).toMatchObject({ changed: true, legacyNamesUnchecked: null });
      });
    });

    it("refuses an import whose name another legacy entry also holds", async () => {
      await withRepo(async (dir) => {
        const legacy = '[agents.codex]\nname = "twin"\n\n[agents.claude]\nname = "twin"\n';
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), legacy);
        const target = await resolveIdentityTarget(dir, undefined);
        await expect(
          setIdentity(target, "codex", "identity.triage_role", "designer"),
        ).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining("besides [agents.codex]"),
        });
        expect(await readdir(dir)).not.toContain(IDENTITY_FILE);
        expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe(legacy);
      });
    });

    it("generates names that avoid every legacy name", async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), '[agents.other]\nname = "amara_abara"\n');
        const target = await resolveIdentityTarget(dir, undefined);
        let calls = 0;
        const write = await setIdentity(target, "codex", "identity.triage_role", "designer", {
          random: () => (calls++ < 2 ? 0 : 0.99),
        });
        expect(write.generatedName).not.toBe("amara_abara");
      });
    });

    it("allows an explicit name when legacy names are unknown, reporting the unchecked collision", async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), "[agents\nbroken");
        const target = await resolveIdentityTarget(dir, undefined);
        await setIdentity(target, "codex", "identity.name", "first_name");
        // A rename of an existing entry: the legacy file is not otherwise consulted.
        const rename = await setIdentity(target, "codex", "identity.name", "second_name");
        expect(rename).toMatchObject({
          changed: true,
          legacyIgnored: null,
          legacyNamesUnchecked: expect.stringContaining("agent-inbox.toml is not valid"),
        });
        const text = await config(
          dir,
          {},
          "set",
          "identity.name",
          "third_name",
          "--entry",
          "codex",
        );
        expect(text.text).toContain("could not check the name against agent-inbox.toml names");
        expect(await readFile(join(dir, LEGACY_IDENTITY_FILE), "utf8")).toBe("[agents\nbroken");
      });
    });

    it("refuses an explicit name if the legacy file changes during the collision check", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const legacyPath = join(target.root, LEGACY_IDENTITY_FILE);
        await writeFile(legacyPath, '[agents.other]\nname = "someone"\n');
        const fs: ConfigFileSystem = {
          ...nodeFileSystem,
          writeText: async (file, text, mode) => {
            await nodeFileSystem.writeText(file, text, mode);
            if (file.endsWith(".tmp"))
              await writeFile(legacyPath, '[agents.other]\nname = "picked"\n');
          },
        };
        await expect(
          setIdentity(target, "codex", "identity.name", "picked", { fs }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await readdir(target.root)).not.toContain(IDENTITY_FILE);
      });
    });
  });

  it("distinguishes ignored from tracked files and refuses tracked identity on either side", async () => {
    await withRepo(async (dir) => {
      const target = await resolveIdentityTarget(dir, undefined);
      // Untracked and unignored: rules for the file, temporary copies and the lock are added.
      await setIdentity(target, "codex", "identity.triage_role", "designer", { random: () => 0.2 });
      const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
      for (const rule of [`/${IDENTITY_FILE}`, `/${IDENTITY_FILE}.*.tmp`, `/${IDENTITY_LOCK_FILE}`])
        expect(exclude.split("\n")).toContain(rule);
      expect(await git(dir, "status", "--porcelain", "--untracked-files=all")).toBe("");

      // A tracked legacy file is not private: refuse the import, change nothing.
      await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
      await git(dir, "add", "--", LEGACY_IDENTITY_FILE);
      const before = await readFile(join(dir, IDENTITY_FILE), "utf8");
      await expect(
        setIdentity(target, "claude", "identity.triage_role", "designer"),
      ).rejects.toMatchObject({ code: "legacy-unsafe" });
      expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toBe(before);
      await git(dir, "rm", "-q", "--cached", "--", LEGACY_IDENTITY_FILE);

      // A tracked pdb.toml is refused and never untracked.
      await git(dir, "add", "-f", "--", IDENTITY_FILE);
      await expect(
        setIdentity(target, "codex", "identity.triage_role", "implementer"),
      ).rejects.toMatchObject({ code: "tracked" });
      expect(await git(dir, "ls-files", "--", IDENTITY_FILE)).toBe(`${IDENTITY_FILE}\n`);
      expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toBe(before);
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses to write through a symbolic link out of the project",
    async () => {
      await withRepo(async (dir) => {
        const outside = await mkdtemp(join(tmpdir(), "pdb-outside-"));
        try {
          const elsewhere = join(outside, "elsewhere.toml");
          await writeFile(elsewhere, '[agents.codex]\nname = "outside"\n');
          await symlink(elsewhere, join(dir, IDENTITY_FILE));
          const target = await resolveIdentityTarget(dir, undefined);
          await expect(
            setIdentity(target, "codex", "identity.triage_role", "designer"),
          ).rejects.toMatchObject({ code: "unsafe-path" });
          expect((await lstat(join(dir, IDENTITY_FILE))).isSymbolicLink()).toBe(true);
          expect(await readFile(elsewhere, "utf8")).toBe('[agents.codex]\nname = "outside"\n');
        } finally {
          await rm(outside, { recursive: true, force: true });
        }
      });
    },
  );

  describe("concurrent writers", () => {
    const patient = { waitMs: 60_000, pollMs: 5 };

    /** Writer B starts once A holds the lock; A renames only after B found the lock held. */
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

    it("keeps both entries when two agents initialise different entries at once", async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, LEGACY_IDENTITY_FILE), LEGACY);
        const target = await resolveIdentityTarget(dir, undefined);
        const { a, b, aHoldsLock } = sequenced(join(target.root, IDENTITY_LOCK_FILE));
        const first = setIdentity(target, "codex", "identity.triage_role", "designer", {
          fs: a,
          lockTiming: patient,
        });
        await aHoldsLock;
        const second = setIdentity(target, "gemini", "identity.triage_role", "implementer", {
          fs: b,
          lockTiming: patient,
          random: () => 0.6,
        });
        const [one, two] = await Promise.all([first, second]);
        expect(one.importedFrom).toBe(LEGACY_IDENTITY_FILE);
        expect(two.generatedName).not.toBeNull();
        expect(await readIdentity(dir, "codex")).toMatchObject({
          name: "legacy_codex",
          source: "pdb",
        });
        expect(await readIdentity(dir, "gemini")).toMatchObject({
          name: two.generatedName,
          triageRole: "implementer",
        });
        expect(await readdir(dir)).not.toContain(IDENTITY_LOCK_FILE);
      });
    });

    it("serialises same-entry initialisers so the second reuses the first name", async () => {
      await withRepo(async (dir) => {
        const target = await resolveIdentityTarget(dir, undefined);
        const { a, b, aHoldsLock } = sequenced(join(target.root, IDENTITY_LOCK_FILE));
        const first = setIdentity(target, "codex", "identity.triage_role", "designer", {
          fs: a,
          lockTiming: patient,
          random: () => 0.1,
        });
        await aHoldsLock;
        const second = setIdentity(target, "codex", "identity.triage_role", "implementer", {
          fs: b,
          lockTiming: patient,
          random: () => 0.9,
        });
        const [one, two] = await Promise.all([first, second]);
        expect(one.generatedName).not.toBeNull();
        expect(two).toMatchObject({ generatedName: null, createdEntry: false });
        expect(await readIdentity(dir, "codex")).toMatchObject({
          name: one.generatedName,
          triageRole: "implementer",
        });
      });
    });

    it("refuses an import whose legacy source changed before the commit, writing nothing", async () => {
      await withRepo(async (dir) => {
        const legacyPath = join(dir, LEGACY_IDENTITY_FILE);
        await writeFile(legacyPath, LEGACY);
        const target = await resolveIdentityTarget(dir, undefined);
        const edited = LEGACY.replace("legacy_codex", "edited_meanwhile");
        const fs: ConfigFileSystem = {
          ...nodeFileSystem,
          writeText: async (file, text, mode) => {
            await nodeFileSystem.writeText(file, text, mode);
            // Another application edits the legacy file after it was read for import.
            if (file.endsWith(".tmp")) await writeFile(legacyPath, edited);
          },
        };
        await expect(
          setIdentity(target, "codex", "identity.triage_role", "designer", { fs }),
        ).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining(LEGACY_IDENTITY_FILE),
        });
        const left = await readdir(dir);
        expect(left).not.toContain(IDENTITY_FILE);
        expect(left.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
        expect(await readFile(legacyPath, "utf8")).toBe(edited);
        // A retry imports the current legacy identity.
        const retry = await setIdentity(target, "codex", "identity.triage_role", "designer");
        expect(retry.record.name).toBe("edited_meanwhile");
      });
    });

    it("refuses a pdb.toml edit made outside the lock instead of overwriting it", async () => {
      await withRepo(async (dir) => {
        const path = join(dir, IDENTITY_FILE);
        await writeFile(path, '[agents.codex]\nname = "pdb_codex"\n');
        const target = await resolveIdentityTarget(dir, undefined);
        const intruder = '[agents.codex]\nname = "pdb_codex"\n\n[agents.other]\nname = "editor"\n';
        const fs: ConfigFileSystem = {
          ...nodeFileSystem,
          writeText: async (file, text, mode) => {
            await nodeFileSystem.writeText(file, text, mode);
            if (file.endsWith(".tmp")) await writeFile(path, intruder);
          },
        };
        await expect(
          setIdentity(target, "codex", "identity.triage_role", "designer", { fs }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await readFile(path, "utf8")).toBe(intruder);
      });
    });
  });
});
