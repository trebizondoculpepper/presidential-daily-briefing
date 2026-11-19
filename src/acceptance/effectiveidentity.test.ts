import { prepareCommandIdentity } from "../config/commandidentity.js";
import { IssueUnavailable } from "../github/github.js";
import { readdir, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { main, type Runtime } from "../cli.js";
import { prepareEffectiveIdentity, type EffectiveIdentity } from "../config/effectiveidentity.js";
import { withIdentityFixture as fixture, type IdentityFixture } from "../testing/identity.js";
import { snapshot, clock, page, issue } from "../testing/snapshots.js";
import type { HumanContext } from "../config/humancontext.js";

const human: HumanContext = {
  state: "current",
  host: "github.com",
  login: "owner",
  source: "gh-login",
  observedAt: "2026-11-17T00:00:00.000Z",
};
const env = { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "cli-private-thread" };
const runtimeFor = (f: IdentityFixture, stderr: string[]): Runtime => ({
  collect: async () => snapshot([], []),
  currentRepository: async () => f.repository,
  now: clock,
  engineClock: () => 0,
  firstUseHint: async () => false,
  stderr: (text) => {
    stderr.push(text);
  },
  config: { cwd: f.root, fs: f.fs, git: f.git },
  guide: { cwd: f.root, fs: f.fs, git: f.git },
  estimation: { cwd: f.root, fs: f.fs, git: f.git },
  prepareIdentity: (options) =>
    prepareEffectiveIdentity(
      { ...options, project: f.root },
      {
        env,
        fs: f.fs,
        git: f.git,
        random: f.random,
        human: async () => ({ context: human, authenticationFailed: false }),
      },
    ),
});
/**
 * #865: reads never create an identity, so tests create one the way an attributed first-use
 * operation does: normal-intent preparation over the same injected fixture and environment.
 */
const create = async (f: IdentityFixture, role: "implementer" | "designer") =>
  prepareEffectiveIdentity(
    { project: f.root, role, intent: "normal" },
    {
      env,
      fs: f.fs,
      git: f.git,
      random: f.random,
      human: async () => ({ context: human, authenticationFailed: false }),
    },
  );

const invoke = async (runtime: Runtime, flags: string[]) => {
  const writes: string[] = [];
  const code = await main(
    [...flags, "--no-update-check"],
    async (text) => {
      writes.push(text);
    },
    runtime,
  );
  expect(writes).toHaveLength(1);
  return {
    code,
    document: JSON.parse(writes[0]!) as {
      effectiveIdentity: EffectiveIdentity;
      employingHuman?: HumanContext;
      human?: { human: string | null; routing: string };
      decisionEngine?: { role?: { used: string } };
      kind?: string;
      repository?: string;
      transferredFrom?: { repository: string };
      agent?: string;
      preview?: { body: string };
      error?: string;
    },
  };
};

describe("effective identity in actual CLI results (#677)", () => {
  it("never creates an identity from a briefing, and reuses one created by an attributed operation (#865)", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      const runtime = runtimeFor(f, stderr);
      const unattributed = await invoke(runtime, ["--json", "--role", "implementer"]);
      expect(unattributed.code).toBe(0);
      expect(unattributed.document.effectiveIdentity).toMatchObject({ agent: null });
      expect(unattributed.document.employingHuman).toEqual(human);
      expect(stderr.join("")).not.toContain("created agent identity");
      expect(stderr.join("")).not.toContain("Optional next steps");
      expect(await f.fs.readText(f.file)).toBeNull();
      const created = await create(f, "implementer");
      expect(created.agent).toEqual(expect.any(String));
      stderr.length = 0;
      const again = await invoke(runtime, ["--json"]);
      expect(again.document.effectiveIdentity).toMatchObject({
        agent: created.agent,
        roleSource: "stored",
        setup: { state: "reused", notices: [] },
      });
      expect(stderr.join("")).not.toContain("created agent identity");
      expect(JSON.stringify(again.document)).not.toContain(env.CODEX_THREAD_ID);
    }));

  it("shows an ordinary unattributed briefing with no identity and writes nothing (#865)", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      let collects = 0;
      const result = await invoke(
        {
          ...runtimeFor(f, stderr),
          collect: async () => {
            collects++;
            return snapshot([], []);
          },
        },
        ["--json"],
      );
      expect(result.code).toBe(0);
      expect(result.document.kind).not.toBe("identity-preparation");
      expect(result.document.effectiveIdentity).toMatchObject({ agent: null });
      expect(stderr.join("")).not.toContain("--role implementer|designer");
      expect(collects).toBe(1);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("a failing briefing neither creates nor changes an identity (#865)", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      const runtime = runtimeFor(f, stderr);
      const writes: string[] = [];
      await expect(
        main(
          ["--json", "--role", "implementer", "--no-update-check"],
          async (text) => {
            writes.push(text);
          },
          {
            ...runtime,
            collect: async () => {
              throw new Error("original collection failed");
            },
          },
        ),
      ).rejects.toThrow("original collection failed");
      expect(writes).toEqual([]);
      expect(stderr.join("")).not.toContain("created agent identity");
      expect(await f.fs.readText(f.file)).toBeNull();
    }));

  it("retains human attention and routing while reporting separate execution metadata", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      const runtime = runtimeFor(f, stderr);
      await create(f, "designer");
      const raw = await f.fs.readText(f.file);
      const report = await invoke(runtime, ["--json", "--role", "human", "--agent", "owner"]);
      expect(report.document.decisionEngine?.role?.used).toBe("human");
      expect(report.document.human).toMatchObject({ human: "owner", routing: "named" });
      expect(report.document.human).toBeDefined();
      expect(report.document.employingHuman).toEqual(human);
      expect(report.document.effectiveIdentity.agent).not.toBe("owner");
      expect(report.document.effectiveIdentity.triageRole).toBe("designer");
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it("prints no identity-creation diagnostics for a read, and keeps text stdout as the report (#865)", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      let stdout = "";
      await main(
        ["--role", "implementer", "--no-update-check"],
        async (text) => {
          stdout += text;
        },
        runtimeFor(f, stderr),
      );
      expect(stderr.join("")).not.toContain("created agent identity");
      expect(stdout).not.toContain("created agent identity");
      expect(stdout).toContain("Working for: owner");
    }));

  it("does not advance a checkpoint before the attributed JSON reaches stdout", async () =>
    fixture(async (f) => {
      const runtime = runtimeFor(f, []);
      await create(f, "implementer");
      const path = f.root + "/checkpoint.json";
      let flush: (() => void) | undefined;
      let written: (() => void) | undefined;
      const reachedOutput = new Promise<void>((resolve) => {
        written = resolve;
      });
      let document:
        | { effectiveIdentity?: EffectiveIdentity; completeness?: { complete: boolean } }
        | undefined;
      const pending = main(
        ["--json", "--checkpoint", path, "--no-update-check"],
        async (text) => {
          document = JSON.parse(text);
          written!();
          await new Promise<void>((resolve) => {
            flush = resolve;
          });
        },
        runtime,
      );
      await reachedOutput;
      try {
        expect(document?.effectiveIdentity?.setup.state).toBe("reused");
        expect(document?.completeness?.complete).toBe(true);
        expect(await f.fs.readText(path)).toBeNull();
      } finally {
        flush!();
      }
      await pending;
      expect(JSON.parse((await f.fs.readText(path))!).repository).toBe(f.repository);
    }));

  it("passes the bound actor into a live claim plan without --agent", async () =>
    fixture(async (f) => {
      const runtime = runtimeFor(f, []);
      const first = { document: { effectiveIdentity: await create(f, "implementer") } };
      const before = await f.fs.readText(f.file);
      const labels: unknown[] = [];
      let writes = 0;
      const claimed = await invoke(
        {
          ...runtime,
          query: async (_query, variables) => {
            labels.push(variables.label);
            return {
              repository: {
                issueOrPullRequest: {
                  __typename: "Issue",
                  number: 7,
                  title: "Closed ticket",
                  url: `https://github.com/${f.repository}/issues/7`,
                  state: "CLOSED",
                  labels: page([]),
                  comments: page([]),
                  timelineItems: page([]),
                  issueDependenciesSummary: { blockedBy: 0 },
                  blockedBy: page([]),
                  closedByPullRequestsReferences: page([]),
                },
                claims: page([]),
                ownerLabel: null,
              },
            };
          },
          rest: async () => {
            throw new Error("unexpected permission lookup for closed ticket");
          },
          ghRun: async () => {
            writes++;
          },
        },
        ["claim", "7", "--json"],
      );
      expect(labels).toContain(`agent:${first.document.effectiveIdentity.agent}`);
      expect(claimed.document.effectiveIdentity.agent).toBe(first.document.effectiveIdentity.agent);
      expect(claimed.code).toBe(1);
      expect(writes).toBe(0);
      expect(await f.fs.readText(f.file)).toBe(before);
    }));

  it("a new-agent claim dry-run proposes setup without allocating or planning remotely", async () =>
    fixture(async (f) => {
      let queries = 0;
      const result = await invoke(
        {
          ...runtimeFor(f, []),
          query: async () => {
            queries++;
            throw new Error("must not query");
          },
        },
        ["claim", "7", "--role", "implementer", "--dry-run", "--json"],
      );
      expect(result.document.effectiveIdentity).toMatchObject({
        state: "proposed",
        agent: null,
        setup: { state: "proposed", persisted: false },
      });
      expect(queries).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("prepares the repository catch-up command and forwards its viewer", async () =>
    fixture(async (f) => {
      const report = await invoke(runtimeFor(f, []), ["briefing", "--json", "--role", "designer"]);
      expect(report.document.kind).toBe("repository-briefing");
      // #865: the catch-up read is observational: it never creates an identity.
      expect(report.document.effectiveIdentity).toMatchObject({ agent: null });
      expect(report.document.effectiveIdentity.setup?.state).not.toBe("created");
      expect(await f.fs.readText(f.file)).toBeNull();
    }));

  it("still requires attribution for a claim when no identity exists (#865)", async () =>
    fixture(async (f) => {
      const blocked = async (): Promise<never> => {
        throw new Error("an unattributed claim must not plan or write");
      };
      const result = await invoke({ ...runtimeFor(f, []), query: blocked, ghRun: blocked }, [
        "claim",
        "7",
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.document.kind).toBe("identity-preparation");
      expect(result.document.effectiveIdentity).toMatchObject({ agent: null });
      expect(await f.fs.readText(f.file)).toBeNull();
    }));

  it("uses the bound agent in an issue-creation preview without POSTing", async () =>
    fixture(async (f) => {
      await mkdir(f.root + "/.github");
      await f.fs.writeText(f.root + "/.github/triage.toml", "schemaVersion = 1\n");
      const runtime = runtimeFor(f, []);
      const first = { document: { effectiveIdentity: await create(f, "implementer") } };
      let posts = 0;
      const report = await invoke(
        {
          ...runtime,
          issueCreate: {
            operationId: () => "0123456789abcdef0123456789abcdef",
            rest: async (path) =>
              path === "user"
                ? { status: 200, body: { login: "owner" } }
                : {
                    status: 200,
                    body: {
                      full_name: f.repository,
                      id: 1,
                      node_id: "R_1",
                      has_issues: true,
                      permissions: { push: true },
                    },
                  },
            post: async () => {
              posts++;
              throw new Error("must not post");
            },
          },
        },
        ["issue", "create", "--title", "A preview", "--dry-run", "--json"],
      );
      expect(report.document.agent).toBe(first.document.effectiveIdentity.agent);
      expect(report.document.preview?.body).toContain(first.document.effectiveIdentity.agent!);
      expect(report.document.effectiveIdentity.setup.state).toBe("reused");
      expect(posts).toBe(0);
    }));

  it("prepares estimator attribution before the configured disabled-metric result", async () =>
    fixture(async (f) => {
      await mkdir(f.root + "/.github");
      await f.fs.writeText(
        f.root + "/.github/triage.toml",
        "schemaVersion = 1\n[complexity]\nenabled = false\n",
      );
      let queries = 0;
      const report = await invoke(
        {
          ...runtimeFor(f, []),
          estimate: {
            cwd: f.root,
            fs: f.fs,
            git: f.git,
            api: {
              query: async () => {
                queries++;
                throw new Error("must not query disabled metric");
              },
              mutate: async () => {
                throw new Error("must not mutate disabled metric");
              },
            },
          },
        },
        [
          "estimate",
          "7",
          "--size",
          "S",
          "--rationale",
          "Bounded work",
          "--role",
          "implementer",
          "--json",
        ],
      );
      expect(report.code).toBe(2);
      expect(report.document.effectiveIdentity).toMatchObject({
        agent: expect.any(String),
        setup: { state: "created" },
      });
      expect(queries).toBe(0);
    }));

  it("follows a transfer with the verified invocation identity and no destination setup", async () =>
    fixture(async (f) => {
      const runtime = runtimeFor(f, []);
      const first = { document: { effectiveIdentity: await create(f, "designer") } };
      const raw = await f.fs.readText(f.file);
      const prepared: (string | undefined)[] = [];
      const collected: string[] = [];
      const destination = "another/destination";
      const report = await invoke(
        {
          ...runtime,
          prepareIdentity: async (options) => {
            prepared.push(options.repository);
            return runtime.prepareIdentity!(options);
          },
          collect: async (repository, options) => {
            collected.push(`${repository}#${options?.issue}`);
            if (repository === f.repository)
              throw new IssueUnavailable({
                repository: f.repository,
                number: 7,
                url: `https://github.com/${f.repository}/issues/7`,
                state: "moved",
                detail: "Transferred",
                next: "Inspect destination",
                destination: {
                  repository: destination,
                  number: 2,
                  url: `https://github.com/${destination}/issues/2`,
                },
              });
            return {
              ...snapshot([{ ...issue(2), url: `https://github.com/${destination}/issues/2` }], []),
              repository,
            };
          },
        },
        ["--repo", f.repository, "--issue", "7", "--include-transferred", "--json"],
      );
      expect(report.document.repository).toBe(destination);
      expect(report.document.transferredFrom?.repository).toBe(f.repository);
      expect(report.document.effectiveIdentity).toMatchObject({
        agent: first.document.effectiveIdentity.agent,
        role: "designer",
        setup: { state: "reused" },
      });
      expect(prepared).toEqual([f.repository]);
      expect(collected).toEqual([`${f.repository}#7`, `${destination}#2`]);
      expect(await f.fs.readText(f.file)).toBe(raw);
    }));

  it.each(
    // Attributed operations only: a read never prepares an identity (#865), so it is covered by
    // the unattributed-briefing tests rather than this setup-refusal matrix.
    [
      ["claim", "7"],
      ["complete", "7"],
      ["submit", "7"],
      ["issue", "create", "--title", "One"],
      ["estimate", "7", "--size", "S", "--rationale", "One"],
      ["deps", "add", "7", "--on", "2", "--note", "One"],
    ].map((command) => ({ command })),
  )("validates implicit target before setup: $command", async ({ command }) =>
    fixture(async (f) => {
      const blocked = async (): Promise<never> => {
        throw new Error("must not plan against an unverified target");
      };
      const result = await invoke(
        {
          ...runtimeFor(f, []),
          currentRepository: async () => "another/repository",
          collect: blocked,
          query: blocked,
          rest: blocked,
          ghRun: blocked,
          planDependencyChange: blocked,
          estimate: { cwd: f.root, fs: f.fs, git: f.git, api: { query: blocked, mutate: blocked } },
          issueCreate: { post: blocked },
        },
        [...command, "--role", "implementer", "--json"],
      );
      expect(result.code).toBe(2);
      expect(result.document.kind).toBe("identity-preparation");
      expect(result.document.effectiveIdentity).toMatchObject({
        state: "unresolved",
        agent: null,
        diagnostic: { code: "repository-mismatch" },
      });
      expect(JSON.stringify(result.document)).not.toContain(f.root);
      expect(await readdir(f.root)).toEqual([]);
    }),
  );

  it("scopes offline identity to the cache repository without live target lookup", async () =>
    fixture(async (f) => {
      const runtime = runtimeFor(f, []);
      await create(f, "implementer");
      const before = await f.fs.readText(f.file);
      const cache = f.root + "/snapshot.json";
      const repository = "another/repository";
      await f.fs.writeText(cache, JSON.stringify({ ...snapshot([], []), repository }));
      const result = await invoke(
        {
          ...runtime,
          currentRepository: async () => {
            throw new Error("must not resolve live target while offline");
          },
          collect: async () => {
            throw new Error("must not collect offline");
          },
        },
        ["--offline", "--cache", cache, "--json"],
      );
      expect(result.document.repository).toBe(repository);
      expect(result.document.effectiveIdentity).toMatchObject({
        state: "unresolved",
        agent: null,
        diagnostic: { code: "repository-mismatch" },
      });
      expect(JSON.stringify(result.document.effectiveIdentity)).not.toContain(f.root);
      expect(await f.fs.readText(f.file)).toBe(before);
    }));

  it("uses production preview composition without a live human lookup or identity write", async () =>
    fixture(async (f) => {
      let authentications = 0;
      let allocations = 0;
      let queries = 0;
      const runtime = runtimeFor(f, []);
      const report = await invoke(
        {
          ...runtime,
          query: async () => {
            queries++;
            throw new Error("must not plan before a name exists");
          },
          prepareIdentity: (options) =>
            prepareCommandIdentity(
              { ...options, project: f.root },
              {
                env,
                fs: f.fs,
                git: f.git,
                random: () => {
                  allocations++;
                  return f.random();
                },
                auth: async () => {
                  authentications++;
                  return { host: "github.com", login: "owner" };
                },
                humanOptions: { cacheDir: f.root },
              },
            ),
        },
        ["claim", "7", "--repo", f.repository, "--role", "implementer", "--dry-run", "--json"],
      );
      expect(report.document.effectiveIdentity).toMatchObject({
        state: "proposed",
        agent: null,
        human: { state: "unresolved", login: null },
        setup: { state: "proposed" },
      });
      expect(authentications).toBe(0);
      expect(allocations).toBe(0);
      expect(queries).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it.each(["missing", "corrupt", "unsupported"] as const)(
    "preserves the structured offline catch-up cache refusal for %s input",
    async (kind) =>
      fixture(async (f) => {
        const cache = f.root + "/cache.json";
        if (kind !== "missing")
          await f.fs.writeText(
            cache,
            kind === "corrupt"
              ? "not JSON"
              : JSON.stringify({ ...snapshot([], []), schemaVersion: 999 }),
          );
        const runtime = runtimeFor(f, []);
        let preparations = 0;
        const report = await invoke(
          {
            ...runtime,
            prepareIdentity: async (options) => {
              preparations++;
              return runtime.prepareIdentity!(options);
            },
            currentRepository: async () => {
              throw new Error("must not resolve a live offline target");
            },
            collect: async () => {
              throw new Error("must not collect offline");
            },
          },
          ["briefing", "--offline", "--cache", cache, "--json"],
        );
        expect(report.code).toBe(1);
        expect(report.document).toMatchObject({
          schemaVersion: 1,
          kind: "repository-briefing-refusal",
          file: "cache",
          path: cache,
          checkpointAdvanced: false,
          next: expect.stringContaining("pdb briefing"),
        });
        expect(preparations).toBe(0);
        expect(await f.fs.readText(f.file)).toBeNull();
        expect(await readdir(f.root)).toEqual(kind === "missing" ? [] : ["cache.json"]);
      }),
  );

  it("help and rules do not prepare an identity", async () =>
    fixture(async (f) => {
      const runtime = {
        ...runtimeFor(f, []),
        prepareIdentity: async () => {
          throw new Error("must not prepare");
        },
      };
      await main(["--help", "--no-update-check"], async () => {}, runtime);
      await main(["rules", "--help", "--no-update-check"], async () => {}, runtime);
      expect(await readdir(f.root)).toEqual([]);
    }));
});
