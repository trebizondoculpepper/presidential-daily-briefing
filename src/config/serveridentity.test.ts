import { prepareCommandIdentity } from "./commandidentity.js";
import { nodeSafeFs } from "./safejson.js";
import { runRebrief } from "../rebrief/cli.js";
import { prepareEffectiveIdentity } from "./effectiveidentity.js";
import { readdir } from "node:fs/promises";
import { memoryStore } from "../rebrief/core.js";
import { describe, expect, it } from "vite-plus/test";
import { withIdentityFixture as fixture } from "../testing/identity.js";
import { startLocalIdentity } from "./serveridentity.js";
import type { EffectiveIdentityRuntime } from "./effectiveidentity.js";
import type { HumanContext } from "./humancontext.js";

const human: HumanContext = {
  state: "current",
  host: "github.com",
  login: "owner",
  source: "gh-login",
  observedAt: "2026-11-17T00:00:00.000Z",
};

describe("local server identity preparation (#677)", () => {
  it("initializes at local startup and identifies that historical outcome on later reads", async () =>
    fixture(async (f) => {
      const environment = {
        CODEX_VERSION: "0.169.0",
        CODEX_THREAD_ID: "server-private-thread",
        PRIVATE_ENV_VALUE: "must-not-copy",
      };
      const runtime: EffectiveIdentityRuntime = {
        env: environment,
        fs: f.fs,
        git: f.git,
        random: f.random,
        human: async () => ({ context: human, authenticationFailed: false }),
      };
      const session = await startLocalIdentity(
        { project: f.root, repository: f.repository, role: "implementer" },
        runtime,
      );
      expect(session.startup.setup.state).toBe("created");
      const raw = await f.fs.readText(f.file);
      for (let i = 0; i < 2; i++) {
        const read = await session.read(f.root, f.repository);
        expect(read).toMatchObject({
          agent: session.startup.agent,
          setup: { state: "reused", notices: [] },
          startup: { phase: "local-server-startup", result: { setup: { state: "created" } } },
        });
        expect(await f.fs.readText(f.file)).toBe(raw);
      }
      expect(JSON.stringify(session)).not.toContain("server-private-thread");
      expect(JSON.stringify(session)).not.toContain("must-not-copy");
      environment.CODEX_THREAD_ID = "other-private-thread";
      expect((await session.read(f.root, f.repository)).agent).toBe(session.startup.agent);
    }));

  it("a server with no selected local project never consults its launch checkout", async () =>
    fixture(async (f) => {
      let gitReads = 0;
      const session = await startLocalIdentity(
        { repository: f.repository, role: "implementer" },
        {
          cwd: f.root,
          env: { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "thread" },
          fs: f.fs,
          git: async () => {
            gitReads++;
            throw new Error("must not consult launch checkout");
          },
          human: async () => ({ context: human, authenticationFailed: false }),
        },
      );
      expect(session.startup.state).toBe("unresolved");
      expect((await session.read(undefined, f.repository)).agent).toBeNull();
      expect(gitReads).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("project selection and an account switch resolve read context without initializing the selected project", async () =>
    fixture(async (first) =>
      fixture(async (other) => {
        let currentHuman = human;
        const git: EffectiveIdentityRuntime["git"] = (args, cwd) =>
          (cwd === other.root ? other.git : first.git)(args, cwd);
        const session = await startLocalIdentity(
          { project: first.root, repository: first.repository, role: "designer" },
          {
            env: { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "thread" },
            fs: first.fs,
            git,
            random: first.random,
            human: async () => ({ context: currentHuman, authenticationFailed: false }),
          },
        );
        const unknown = await session.read(other.root, other.repository);
        expect(unknown.state).toBe("unresolved");
        expect(unknown.startup.result.agent).toBe(session.startup.agent);
        expect(await readdir(other.root)).toEqual([]);
        // An existing matching binding can be displayed, without changing startup authority.
        // (Advance the other project's name generator so its default differs from startup's.)
        for (let i = 0; i < 7; i++) other.random();
        await other.setup("separately-bound-agent", "implementer");
        const initialized = await other.setup("thread", "implementer");
        currentHuman = { ...human, login: "another_owner", observedAt: "2026-11-17T01:00:00.000Z" };
        const selected = await session.read(other.root, other.repository);
        expect(selected.agent).toBe(initialized.record.name);
        expect(selected.agent).not.toBe(session.startup.agent);
        expect(selected.human).toEqual(currentHuman);
        expect(selected.triageRole).toBe("implementer");
        expect(selected.startup.result.agent).toBe(session.startup.agent);
        expect(selected.startup.result.human.login).toBe("owner");
        expect(selected.setup).toMatchObject({ state: "reused", changed: false });
      }),
    ));

  it("missing startup role leaves a later read non-initializing even if a project is selected", async () =>
    fixture(async (f) => {
      let allocations = 0;
      const session = await startLocalIdentity(
        { project: f.root, repository: f.repository },
        {
          env: { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "thread" },
          fs: f.fs,
          git: f.git,
          random: () => {
            allocations++;
            return f.random();
          },
          human: async () => ({ context: human, authenticationFailed: false }),
        },
      );
      expect(session.startup.diagnostic?.message).toContain("explicit triage role");
      expect((await session.read(f.root, f.repository)).state).toBe("unresolved");
      expect(allocations).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));
});

describe("rebrief session identity reuse", () => {
  it("reads the harness default without setup writes, for this and a new session (#1047)", async () =>
    fixture(async (f) => {
      await f.setup("rebrief-thread", "designer");
      const before = await f.fs.readText(f.file);
      let thread = "rebrief-thread";
      let result = "";
      let stateWrites = 0;
      const invoke = () =>
        runRebrief(
          [
            "init",
            "--json",
            "--state-dir",
            f.root,
            "--repo",
            f.repository,
            "--project",
            f.root,
            "--session",
            "session",
            "--platform",
            "codex",
            "--role",
            "designer",
          ],
          async (text) => {
            result = text;
          },
          {
            git: f.git,
            prepareIdentity: (options) => {
              expect(options.intent).toBe("readonly");
              expect(options.requireProject).toBe(true);
              return prepareEffectiveIdentity(options, {
                env: { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: thread },
                fs: f.fs,
                git: f.git,
                random: f.random,
                human: async () => ({ context: human, authenticationFailed: false }),
              });
            },
            state: async (_directory, use) =>
              use({ version: "none" }, async () => {
                stateWrites++;
                return memoryStore();
              }),
          },
        );
      expect(await invoke()).toBe(0);
      expect(JSON.parse(result)).toMatchObject({
        reason: "initialized",
        identity: { source: "environment" },
        effectiveIdentity: {
          source: "binding",
          triageRole: "designer",
          setup: { state: "reused" },
        },
      });
      expect(stateWrites).toBe(1);
      // #1047: a new session of the same harness reuses the default identity, read-only.
      thread = "unbound-thread";
      expect(await invoke()).toBe(0);
      expect(JSON.parse(result)).toMatchObject({
        reason: "initialized",
        effectiveIdentity: { source: "binding", triageRole: "designer" },
      });
      // The frontend's own session state is written for the initialized session; the identity
      // file is never written by a read.
      expect(stateWrites).toBe(2);
      expect(await f.fs.readText(f.file)).toBe(before);
    }));
});

it("does not inspect the prior human cache when the frontend disables lookup", async () => {
  let accesses = 0;
  const cacheFs = new Proxy(nodeSafeFs, {
    get(target, key, receiver) {
      accesses++;
      return Reflect.get(target, key, receiver);
    },
  });
  const result = await prepareCommandIdentity(
    { agent: "explicit-agent", intent: "readonly" },
    {
      env: {},
      humanOptions: { fs: cacheFs },
    },
  );
  expect(result.human).toMatchObject({ state: "unresolved", login: null, source: "none" });
  expect(accesses).toBe(0);
});
