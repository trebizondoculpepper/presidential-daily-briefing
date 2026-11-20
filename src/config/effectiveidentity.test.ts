import { readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { withIdentityFixture as fixture, type IdentityFixture } from "../testing/identity.js";
import {
  prepareEffectiveIdentity,
  resolveEffectiveHuman,
  type EffectiveIdentityOptions,
  type EffectiveIdentityRuntime,
} from "./effectiveidentity.js";
import { readBoundIdentity, readIdentityBindings, parseIdentityDocument } from "./identity.js";
import { AuthenticationError } from "../github/github.js";
import type { HumanContext } from "./humancontext.js";

const human: HumanContext = {
  state: "current",
  host: "github.com",
  login: "owner",
  source: "gh-login",
  observedAt: "2026-11-17T00:00:00.000Z",
};
const env = { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "private-thread" };
const run = (
  f: IdentityFixture,
  options: Partial<EffectiveIdentityOptions> = {},
  patch: Partial<EffectiveIdentityRuntime> = {},
) =>
  prepareEffectiveIdentity(
    {
      project: f.root,
      repository: f.repository,
      role: "implementer",
      intent: "normal",
      authenticationRequired: true,
      ...options,
    },
    {
      cwd: f.root,
      env,
      fs: f.fs,
      git: f.git,
      random: f.random,
      human: async () => ({ context: human, authenticationFailed: false }),
      ...patch,
    },
  );

describe("effective identity preparation (#677)", () => {
  it("creates once, verifies persistence and reuses the binding without --agent", async () =>
    fixture(async (f) => {
      const first = await run(f);
      expect(first).toMatchObject({
        state: "resolved",
        source: "binding",
        store: "pdb",
        setup: { state: "created", persisted: true },
        human,
      });
      expect(first.setup.notices.join(" ")).toContain(`created agent identity ${first.agent}`);
      expect(
        (await readBoundIdentity(f.root, f.binding(env.CODEX_THREAD_ID).key, f.fs))?.record.name,
      ).toBe(first.agent);
      const again = await run(f);
      expect(again.agent).toBe(first.agent);
      expect(again.setup).toMatchObject({ state: "reused", changed: false, notices: [] });
      expect(JSON.stringify(first)).not.toContain(env.CODEX_THREAD_ID);
      expect(await f.fs.readText(f.file)).not.toContain(env.CODEX_THREAD_ID);
    }));

  it("reuses an existing default entry's exact name and role, automatically or when selected (#1047)", async () =>
    fixture(async (f) => {
      const raw =
        'schemaVersion = 1\n[agents.codex]\nname = "kept_agent"\ntriage_role = "designer"\n';
      await f.fs.writeText(f.file, raw);
      // #1047: the existing default is this harness's identity; a new session reuses it.
      const automatic = await run(f);
      expect(automatic).toMatchObject({
        agent: "kept_agent",
        source: "binding",
        triageRole: "designer",
      });
      expect(automatic.setup.notices.join(" ")).not.toContain("created");
      const selected = await run(f, { entry: "codex" });
      expect(selected).toMatchObject({
        agent: "kept_agent",
        source: "entry",
        triageRole: "designer",
        role: "implementer",
      });
      expect(selected.setup.notices.join(" ")).not.toContain("created");
      const reuse = await run(f, { role: undefined });
      expect(reuse).toMatchObject({
        agent: "kept_agent",
        source: "binding",
        triageRole: "designer",
        role: "designer",
        roleSource: "stored",
      });
      expect(
        (
          parseIdentityDocument((await f.fs.readText(f.file))!).agents as Record<
            string,
            Record<string, unknown>
          >
        ).codex!.triage_role,
      ).toBe("designer");
    }));

  it("does not invent an implementation role for a new identity", async () =>
    fixture(async (f) => {
      let allocations = 0;
      const result = await run(
        f,
        { role: undefined },
        {
          random: () => {
            allocations++;
            return f.random();
          },
        },
      );
      expect(result.state).toBe("unresolved");
      expect(result.diagnostic?.message).toContain("explicit triage role");
      expect(allocations).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it.each(["readonly", "dry-run"] as const)(
    "%s allocates no name and writes no identity/exclusion",
    async (intent) =>
      fixture(async (f) => {
        let allocations = 0;
        const result = await run(
          f,
          { intent },
          {
            random: () => {
              allocations++;
              return f.random();
            },
          },
        );
        expect(result.state).toBe(intent === "dry-run" ? "proposed" : "unresolved");
        expect(result.agent).toBeNull();
        expect(result.setup.notices.join(" ")).not.toContain("created");
        expect(allocations).toBe(0);
        expect(await readdir(f.root)).toEqual([]);
      }),
  );

  it("dry-run can use a known selected name while only proposing its binding", async () =>
    fixture(async (f) => {
      const raw =
        'schemaVersion = 1\n[agents.codex]\nname = "kept_agent"\ntriage_role = "designer"\n';
      await f.fs.writeText(f.file, raw);
      const result = await run(f, { intent: "dry-run", entry: "codex" });
      expect(result).toMatchObject({
        state: "proposed",
        agent: "kept_agent",
        setup: { state: "proposed", changed: false },
      });
      expect(await f.fs.readText(f.file)).toBe(raw);
      expect((await readIdentityBindings(f.root, f.fs)).size).toBe(0);
    }));

  it("an explicit name overrides without consulting or initializing a private entry", async () =>
    fixture(async (f) => {
      const result = await run(
        f,
        { agent: "explicit_agent" },
        {
          git: async () => {
            throw new Error("must not consult Git");
          },
          fs: {
            ...f.fs,
            readText: async () => {
              throw new Error("must not consult identity");
            },
          },
        },
      );
      expect(result).toMatchObject({
        state: "resolved",
        agent: "explicit_agent",
        entry: null,
        source: "explicit-agent",
        store: null,
        setup: { state: "not-needed" },
      });
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("an explicit unsupported binding harness cannot silently select the detected Codex agent", async () =>
    fixture(async (f) => {
      const result = await run(f, { harness: "claude" });
      expect(result.state).toBe("unresolved");
      expect(result.agent).toBeNull();
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("refuses conflicting session signals without borrowing a generic agent", async () =>
    fixture(async (f) => {
      const result = await run(f, {}, { env: { ...env, CLAUDECODE: "1" } });
      expect(result.state).toBe("unresolved");
      expect(result.agent).toBeNull();
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("concurrent preparations emit only one creation notice and keep per-call role overrides", async () =>
    fixture(async (f) => {
      const settled = await Promise.allSettled([
        run(f, { role: "implementer" }),
        run(f, { role: "designer" }),
      ]);
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(results.every((r) => r.state === "resolved")).toBe(true);
      expect(new Set(results.map((r) => r.agent)).size).toBe(1);
      expect(results.filter((r) => r.setup.state === "created")).toHaveLength(1);
      expect(new Set(results.map((r) => r.triageRole)).size).toBe(1);
      expect(results.map((r) => r.role)).toEqual(["implementer", "designer"]);
    }));

  it("a normal run makes earlier session records the default; a read never migrates (#1047)", async () =>
    fixture(async (f) => {
      const b = f.binding(env.CODEX_THREAD_ID);
      const sessionEntry = `codex.session_${"a".repeat(64)}`;
      const raw = `schemaVersion = 1\n[agents."${sessionEntry}"]\nname = "earlier_agent"\ntriage_role = "designer"\n[agentBindings]\n"${b.key}" = "${sessionEntry}"\n`;
      await f.fs.writeText(f.file, raw);
      // Read-only: still attributed to the earlier identity, with the correction explained.
      const read = await run(f, { intent: "readonly", role: undefined });
      expect(read).toMatchObject({ state: "resolved", agent: "earlier_agent" });
      expect(read.setup.notices.join(" ")).toMatch(/still stored as a session entry/);
      expect(await f.fs.readText(f.file)).toBe(raw);
      // A normal run establishes [agents.codex] from that record and keeps the old entry.
      const normal = await run(f, { role: undefined });
      expect(normal).toMatchObject({
        state: "resolved",
        agent: "earlier_agent",
        triageRole: "designer",
        entry: "codex",
      });
      expect(normal.setup.notices.join(" ")).toMatch(
        /default codex identity from earlier sessions/,
      );
      const doc = parseIdentityDocument((await f.fs.readText(f.file))!);
      expect(Object.keys(doc.agents as object).sort()).toEqual(["codex", sessionEntry].sort());
      expect((await readIdentityBindings(f.root, f.fs)).get(b.key)).toBe("codex");
    }));

  it("two sessions of one harness resolve to the same default identity (#1047)", async () =>
    fixture(async (f) => {
      const settled = await Promise.allSettled([
        run(f),
        run(f, {}, { env: { ...env, CODEX_THREAD_ID: "different-thread" } }),
      ]);
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(results.every((r) => r.state === "resolved")).toBe(true);
      expect(new Set(results.map((r) => r.agent)).size).toBe(1);
      const bindings = await readIdentityBindings(f.root, f.fs);
      expect(new Set(bindings.values())).toEqual(new Set(["codex"]));
    }));

  it("does not borrow local identity for a different repository", async () =>
    fixture(async (f) => {
      await run(f);
      const before = await f.fs.readText(f.file);
      const result = await run(f, { repository: "someone/else" });
      expect(result.state).toBe("unresolved");
      expect(result.agent).toBeNull();
      expect(result.diagnostic?.code).toBe("repository-mismatch");
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(await f.fs.readText(f.file)).toBe(before);
    }));

  it("follows an authenticated-account switch without renaming the agent", async () =>
    fixture(async (f) => {
      const first = await run(f);
      const switchedHuman: HumanContext = {
        ...human,
        login: "another_owner",
        observedAt: "2026-11-17T01:00:00.000Z",
      };
      const switched = await run(
        f,
        {},
        { human: async () => ({ context: switchedHuman, authenticationFailed: false }) },
      );
      expect(switched.agent).toBe(first.agent);
      expect(switched.human).toEqual(switchedHuman);
      expect(switched.setup.state).toBe("reused");
    }));

  it("reports a typed authentication refusal before setup or the original remote operation", async () =>
    fixture(async (f) => {
      const missing: HumanContext = {
        state: "unresolved",
        host: "github.com",
        login: null,
        source: "none",
        reason: "gh is not signed in (run gh auth status)",
      };
      const result = await run(
        f,
        {},
        { human: async () => ({ context: missing, authenticationFailed: true }) },
      );
      expect(result.state).toBe("unresolved");
      expect(result.diagnostic?.recovery).toContain("gh auth status");
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("last-known human evidence remains stale evidence rather than a fabricated account switch", async () =>
    fixture(async (f) => {
      const stale: HumanContext = { ...human, state: "last-known", reason: "GitHub unavailable" };
      const result = await run(
        f,
        {},
        { human: async () => ({ context: stale, authenticationFailed: false }) },
      );
      expect(result.state).toBe("resolved");
      expect(result.human).toEqual(stale);
    }));

  it("an error after persistence reports the saved identity and retry reuses it", async () =>
    fixture(async (f) => {
      let allocations = 0;
      const random = () => {
        allocations++;
        return f.random();
      };
      const failed = await run(
        f,
        {},
        {
          random,
          fs: {
            ...f.fs,
            setFileMode: async () => {
              throw Object.assign(new Error("private detail"), { code: "EACCES" });
            },
          },
        },
      );
      expect(failed).toMatchObject({
        state: "failed",
        setup: { state: "persisted-with-error", persisted: true },
      });
      expect(failed.setup.notices.join(" ")).not.toContain("created");
      expect(JSON.stringify(failed)).not.toContain("private detail");
      const count = allocations;
      const retry = await run(f, {}, { random });
      expect(retry.agent).toBe(failed.setup.persistedAgent?.name);
      expect(retry.setup).toMatchObject({ state: "reused", notices: [] });
      expect(allocations).toBe(count);
    }));

  it("uncertain readback never announces creation or blindly allocates again", async () =>
    fixture(async (f) => {
      let renamed = false;
      let allocations = 0;
      const random = () => {
        allocations++;
        return f.random();
      };
      const failed = await run(
        f,
        {},
        {
          random,
          fs: {
            ...f.fs,
            rename: async (a, b) => {
              await f.fs.rename(a, b);
              renamed = true;
            },
            readText: async (path) => {
              if (renamed && path === f.file)
                throw Object.assign(new Error("private readback"), { code: "EIO" });
              return f.fs.readText(path);
            },
          },
        },
      );
      expect(failed).toMatchObject({ state: "failed", setup: { persisted: null } });
      expect(failed.setup.notices).toEqual([]);
      const persisted = (await readBoundIdentity(
        f.root,
        f.binding(env.CODEX_THREAD_ID).key,
        f.fs,
      ))!;
      const count = allocations;
      const retry = await run(f, {}, { random });
      expect(retry.agent).toBe(persisted.record.name);
      expect(retry.setup.state).toBe("reused");
      expect(allocations).toBe(count);
    }));

  it("imports one selected legacy identity without copying unrelated private data", async () =>
    fixture(async (f) => {
      const legacy = f.root + "/agent-inbox.toml";
      const raw =
        'token = "unrelated-private-value"\n[agents.codex]\nname = "legacy_agent"\ntriage_role = "designer"\n';
      await f.fs.writeText(legacy, raw);
      const first = await run(f, { entry: "codex", role: undefined });
      expect(first).toMatchObject({
        agent: "legacy_agent",
        role: "designer",
        setup: { state: "imported", persisted: true },
      });
      expect(first.setup.notices.join(" ")).toContain("imported");
      expect(await f.fs.readText(legacy)).toBe(raw);
      expect(await f.fs.readText(f.file)).not.toContain("unrelated-private-value");
      const again = await run(f, { role: undefined });
      expect(again).toMatchObject({
        agent: "legacy_agent",
        setup: { state: "reused", notices: [] },
      });
    }));

  it("refuses malformed private configuration without replacing it", async () =>
    fixture(async (f) => {
      const raw = 'private-secret = "hidden"\n[broken';
      await f.fs.writeText(f.file, raw);
      const result = await run(f);
      expect(result.state).toBe("unresolved");
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("refuses tracked identity initialization before allocation", async () =>
    fixture(async (f) => {
      let allocations = 0;
      const result = await run(
        f,
        {},
        {
          random: () => {
            allocations++;
            return f.random();
          },
          git: async (args, cwd) => (args.includes("ls-files") ? "pdb.toml\n" : f.git(args, cwd)),
        },
      );
      expect(result.state).toBe("failed");
      expect(result.diagnostic?.code).toBe("tracked");
      expect(allocations).toBe(0);
      expect(await f.fs.readText(f.file)).toBeNull();
    }));

  it("refuses a symbolic identity target before reading or allocating", async () =>
    fixture(async (f) => {
      const result = await run(
        f,
        {},
        {
          fs: { ...f.fs, isSymbolicLink: async (path) => path === f.file },
          random: () => {
            throw new Error("must not allocate");
          },
        },
      );
      expect(result.state).toBe("unresolved");
      expect(result.diagnostic?.code).toBe("unsafe-path");
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("dry-run previews the missing bootstrap role without allocating", async () =>
    fixture(async (f) => {
      const result = await run(f, { intent: "dry-run", role: undefined });
      expect(result.state).toBe("proposed");
      expect(result.diagnostic?.recovery).toContain("--role");
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("reuses a concurrent name correction instead of writing back the earlier snapshot", async () =>
    fixture(async (f) => {
      await f.fs.writeText(
        f.file,
        'schemaVersion = 1\n[agents.codex]\nname = "earlier_agent"\ntriage_role = "designer"\n',
      );
      let corrected = false;
      const result = await run(
        f,
        { entry: "codex" },
        {
          fs: {
            ...f.fs,
            writeText: async (path, text, mode) => {
              if (path.endsWith("pdb.toml.lock") && !corrected) {
                corrected = true;
                await writeFile(
                  f.file,
                  'schemaVersion = 1\n[agents.codex]\nname = "corrected_agent"\ntriage_role = "designer"\n',
                );
              }
              return f.fs.writeText(path, text, mode);
            },
          },
        },
      );
      expect(corrected).toBe(true);
      expect(result).toMatchObject({
        agent: "corrected_agent",
        triageRole: "designer",
        setup: { state: "bound" },
      });
      expect(await f.fs.readText(f.file)).not.toContain("earlier_agent");
    }));

  it.each(["same-session", "different-session"] as const)(
    "converges when %s commits between the selection snapshot and entry read",
    async (kind) =>
      fixture(async (f) => {
        let reads = 0;
        let winner: Awaited<ReturnType<typeof f.setup>> | undefined;
        const result = await run(
          f,
          {},
          {
            fs: {
              ...f.fs,
              readText: async (path) => {
                if (path === f.file && ++reads === 3)
                  winner = await f.setup(
                    kind === "same-session" ? env.CODEX_THREAD_ID : "other-session",
                  );
                return f.fs.readText(path);
              },
            },
          },
        );
        expect(winner).toBeDefined();
        expect(result.state).toBe("resolved");
        expect(result.diagnostic).toBeNull();
        // #1047: either session's concurrent write establishes the one default identity.
        expect(result.agent).toBe(winner!.record.name);
        expect((await readIdentityBindings(f.root, f.fs)).size).toBe(
          kind === "same-session" ? 1 : 2,
        );
      }),
  );

  it("invalid selections perform no human lookup or local initialization", async () =>
    fixture(async (f) => {
      let reads = 0;
      const result = await run(
        f,
        { entry: "codex", harness: "codex" },
        {
          human: async () => {
            reads++;
            return { context: human, authenticationFailed: false };
          },
        },
      );
      expect(result.state).toBe("unresolved");
      expect(reads).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("preserves the human resolver's authentication category without interpreting its message", async () =>
    fixture(async (f) => {
      const result = await resolveEffectiveHuman(
        async () => {
          throw new AuthenticationError("private credential diagnostic");
        },
        { cacheDir: f.root },
      );
      expect(result.authenticationFailed).toBe(true);
      expect(result.context.state).toBe("unresolved");
      expect(JSON.stringify(result)).not.toContain("private credential diagnostic");
    }));
});
