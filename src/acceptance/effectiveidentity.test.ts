import { readdir, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { main, type Runtime } from "../cli.js";
import { prepareEffectiveIdentity, type EffectiveIdentity } from "../config/effectiveidentity.js";
import { withIdentityFixture as fixture, type IdentityFixture } from "../testing/identity.js";
import { snapshot, clock, page } from "../testing/snapshots.js";
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
      agent?: string;
      preview?: { body: string };
      error?: string;
    },
  };
};

describe("effective identity in actual CLI results (#677)", () => {
  it("creates on normal first use, then reuses without --agent or a manual lookup", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      const runtime = runtimeFor(f, stderr);
      const first = await invoke(runtime, ["--json", "--role", "implementer"]);
      expect(first.document.effectiveIdentity).toMatchObject({
        agent: expect.any(String),
        human,
        setup: { state: "created", persisted: true },
      });
      expect(first.document.employingHuman).toEqual(human);
      expect(stderr.join("")).toContain(
        `created agent identity ${first.document.effectiveIdentity.agent}`,
      );
      stderr.length = 0;
      const again = await invoke(runtime, ["--json"]);
      expect(again.document.effectiveIdentity).toMatchObject({
        agent: first.document.effectiveIdentity.agent,
        roleSource: "stored",
        setup: { state: "reused", notices: [] },
      });
      expect(stderr.join("")).not.toContain("created agent identity");
      expect(JSON.stringify(first.document)).not.toContain(env.CODEX_THREAD_ID);
    }));

  it("reports missing role as a setup result before collection and writes nothing", async () =>
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
      expect(result.code).toBe(2);
      expect(result.document).toMatchObject({
        kind: "identity-preparation",
        effectiveIdentity: { state: "unresolved", agent: null },
      });
      expect(stderr.join("")).toContain("--role implementer|designer");
      expect(collects).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("keeps a successfully persisted identity when the original command fails", async () =>
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
      expect(stderr.join("")).toContain("created agent identity");
      const raw = await f.fs.readText(f.file);
      stderr.length = 0;
      const retried = await invoke(runtime, ["--json"]);
      expect(retried.document.effectiveIdentity.setup.state).toBe("reused");
      expect(await f.fs.readText(f.file)).toBe(raw);
      expect(stderr.join("")).not.toContain("created agent identity");
    }));

  it("retains human attention and routing while reporting separate execution metadata", async () =>
    fixture(async (f) => {
      const stderr: string[] = [];
      const runtime = runtimeFor(f, stderr);
      await invoke(runtime, ["--json", "--role", "designer"]);
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

  it("puts first-use diagnostics on stderr and keeps text stdout as the report", async () =>
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
      expect(stderr.join("")).toContain("created agent identity");
      expect(stdout).not.toContain("created agent identity");
      expect(stdout).toContain("Working for: owner");
    }));

  it("does not advance a checkpoint before the attributed JSON reaches stdout", async () =>
    fixture(async (f) => {
      const runtime = runtimeFor(f, []);
      await invoke(runtime, ["--json", "--role", "implementer"]);
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
      const first = await invoke(runtime, ["--json", "--role", "implementer"]);
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
      expect(report.document.effectiveIdentity).toMatchObject({
        role: "designer",
        setup: { state: "created" },
      });
    }));

  it("uses the bound agent in an issue-creation preview without POSTing", async () =>
    fixture(async (f) => {
      await mkdir(f.root + "/.github");
      await f.fs.writeText(f.root + "/.github/triage.toml", "schemaVersion = 1\n");
      const runtime = runtimeFor(f, []);
      const first = await invoke(runtime, ["--json", "--role", "implementer"]);
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
