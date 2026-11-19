import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { GitRunner } from "../config/config.js";
import { describe, expect, it } from "vite-plus/test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { runRebrief, type CliRuntime } from "./cli.js";
import { initialize, initializeV2, memoryStore, RebriefSession } from "./core.js";
import type { SessionStore } from "./core.js";
import type { Context, Transport } from "./core.js";
const noCreate = async (): Promise<SessionStore> => {
  throw new Error("unexpected create");
};
import { withPrivateState, withSessionStore } from "./state.js";
import { read as fixtureRead } from "./fixtures.js";
import { serviceTransport } from "./transports.js";
import { snapshot, issue, pr, repo, clock } from "../testing/snapshots.js";
import { dependencyReport } from "../github/dependencies.js";
import { noLocalProject } from "../serve/api.js";

const context: Context = {
  repository: "o/r",
  agent: "tester",
  role: "implementer",
  platform: "codex",
  session: "secret-session",
};
const common = [
  "--json",
  "--repo",
  context.repository,
  "--agent",
  context.agent,
  "--role",
  context.role,
  "--platform",
  context.platform,
  "--session",
  context.session,
];
const never: Transport = {
  freshRead: true,
  read: async () => {
    throw new Error("SECRET");
  },
};

describe("rebrief CLI/private state", () => {
  it("initializes once, refuses lost/foreign state, and bounds repeated events without storing prompt/context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    let text = "";
    const output = async (value: string) => {
      text = value;
    };
    let reads = 0;
    const transport: Transport = {
      freshRead: true,
      read: async () => {
        reads++;
        throw new Error("PRIVATE details");
      },
    };
    const args = [...common, "--state-dir", dir];
    try {
      expect(
        await runRebrief(
          ["check", ...args, "--event", "1", "--reason", "natural", "--enabled"],
          output,
          { transport: () => transport },
        ),
      ).toBe(0);
      expect(JSON.parse(text).reason).toBe("state-lost");
      expect(reads).toBe(0);
      expect(await runRebrief(["init", ...args], output)).toBe(0);
      expect(JSON.parse(text).reason).toBe("initialized");
      expect(await runRebrief(["init", ...args], output)).toBe(0);
      expect(JSON.parse(text).reason).toBe("state-exists");
      for (let i = 0; i < 2; i++)
        await runRebrief(
          ["check", ...args, "--event", "secret-event", "--reason", "natural", "--enabled"],
          output,
          { transport: () => transport },
        );
      expect(JSON.parse(text).reason).toBe("duplicate-event");
      expect(reads).toBe(1);
      const stored = await readFile(join(dir, "state.json"), "utf8");
      for (const value of ["secret-session", "secret-event", "tester", "o/r", "PRIVATE"])
        expect(stored).not.toContain(value);
      if (process.platform !== "win32")
        expect((await lstat(join(dir, "state.json"))).mode & 0o077).toBe(0);
      expect(
        await runRebrief(
          [
            "check",
            ...args,
            "--session",
            "foreign",
            "--event",
            "2",
            "--reason",
            "natural",
            "--enabled",
          ],
          output,
          { transport: () => transport },
        ),
      ).toBe(0);
      expect(JSON.parse(text).reason).toBe("state-lost");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not update-check or contact any transport for disabled/unknown stop or missing identity; HTTP capability gap stops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    let output = "",
      updates = 0,
      reads = 0;
    const transport: Transport = {
      freshRead: true,
      read: async () => {
        reads++;
        throw new Error("no read");
      },
    };
    const emit = async (s: string) => {
      output = s;
    };
    const args = [...common, "--state-dir", dir, "--event", "one", "--reason", "natural"];
    try {
      expect(
        await main(["rebrief", "check", ...args], emit, {
          collect: async () => {
            throw new Error("no collect");
          },
          currentRepository: async () => {
            throw new Error("no repo read");
          },
          updateCheck: async () => {
            updates++;
            throw new Error("no update");
          },
          rebrief: { transport: () => transport },
        }),
      ).toBe(0);
      expect(JSON.parse(output).reason).toBe("disabled");
      expect(updates).toBe(0);
      await runRebrief(["check", ...args, "--enabled", "--reason", "failure"], emit, {
        transport: () => transport,
      });
      expect(JSON.parse(output).reason).toBe("not-natural-stop");
      await runRebrief(["init", ...common, "--state-dir", dir], emit);
      await runRebrief(["check", ...args, "--enabled", "--transport", "http-mcp"], emit, {
        transport: () => transport,
      });
      expect(JSON.parse(output).reason).toBe("fresh-read-unsupported");
      expect(reads).toBe(0);
      await runRebrief(
        [
          "check",
          ...args.filter((v, i, a) => v !== "--agent" && a[i - 1] !== "--agent"),
          "--enabled",
        ],
        emit,
        { env: {} },
      );
      expect(JSON.parse(output).reason).toBe("missing-identity");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("uses the existing identity resolver on the explicit project, keeping local configuration read-only", async () => {
    let reads = 0,
      text = "";
    const git = async (args: readonly string[]) =>
      args[0] === "rev-parse" ? "/project\n" : "origin\thttps://github.com/o/r.git (fetch)\n";
    const args = common.filter((v, i, a) => v !== "--agent" && a[i - 1] !== "--agent");
    const files = {
      readText: async (path: string) => {
        reads++;
        return path.endsWith("pdb.toml")
          ? '[agents.codex]\nname="tester"\ntriage_role="implementer"\n'
          : null;
      },
      writeText: async () => {
        throw new Error("no writes");
      },
      rename: async () => {
        throw new Error("no writes");
      },
      remove: async () => {
        throw new Error("no writes");
      },
      makeDirectory: async () => {
        throw new Error("no writes");
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    try {
      expect(
        await runRebrief(
          ["init", ...args, "--state-dir", dir, "--project", "/project", "--entry", "codex"],
          async (s) => {
            text = s;
          },
          { git, fs: files, env: {} },
        ),
      ).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ agent: "tester", reason: "initialized" });
      expect(reads).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reports legacy-not-imported identity and recovery without importing or writing configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    let text = "";
    const git = async (args: readonly string[]) =>
      args[0] === "rev-parse" ? "/project\n" : "origin\thttps://github.com/o/r.git (fetch)\n";
    const args = common.filter((v, i, a) => v !== "--agent" && a[i - 1] !== "--agent");
    const fs = {
      readText: async (path: string) =>
        path.endsWith("agent-inbox.toml")
          ? '[agents.codex]\nname="tester"\ntriage_role="implementer"\n'
          : null,
      writeText: async () => {
        throw new Error("no writes");
      },
      rename: async () => {
        throw new Error("no writes");
      },
      remove: async () => {
        throw new Error("no writes");
      },
      makeDirectory: async () => {
        throw new Error("no writes");
      },
    };
    try {
      expect(
        await runRebrief(
          ["init", ...args, "--state-dir", dir, "--project", "/project", "--entry", "codex"],
          async (s) => {
            text = s;
          },
          { git, fs, env: {} },
        ),
      ).toBe(0);
      expect(JSON.parse(text)).toMatchObject({
        agent: "tester",
        reason: "initialized",
        identity: {
          source: "entry",
          store: "legacy-not-imported",
          storeDiagnostic: expect.stringContaining("config set identity.triage_role"),
        },
      });
      expect(text).not.toContain("/project");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("exclusive file access refuses concurrent, malformed, public, symlinked or Git-tree storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    try {
      let release!: () => void;
      const first = withPrivateState(dir, async (_s, save) => {
        await save(initialize(context));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
      await expect(withPrivateState(dir, async () => {})).rejects.toThrow();
      release();
      await first;
      await writeFile(join(dir, "state.json"), "malformed", { mode: 0o600 });
      await expect(withPrivateState(dir, async () => {})).rejects.toThrow();
      await rm(join(dir, "state.json"));
      await mkdir(join(dir, ".git"));
      await expect(withPrivateState(dir, async () => {})).rejects.toThrow();
      await rm(join(dir, ".git"), { recursive: true });
      if (process.platform !== "win32") {
        await chmod(dir, 0o755);
        await expect(withPrivateState(dir, async () => {})).rejects.toThrow();
        await chmod(dir, 0o700);
        const link = `${dir}-link`;
        await symlink(dir, link);
        try {
          await expect(withPrivateState(link, async () => {})).rejects.toThrow();
        } finally {
          await rm(link);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("shared-service adapter makes one fresh read with explicit Codex platform and role", async () => {
    const seen: string[] = [];
    const transport = serviceTransport({
      ...noLocalProject(repo),
      now: clock,
      collect: async (r) => {
        seen.push(r);
        return snapshot([issue(1, ["status:ready", "platform:codex"])], []);
      },
      dependencyReport,
    });
    const r = await transport.read({ ...context, repository: repo }, new AbortController().signal);
    expect(seen).toEqual([repo]);
    expect(r.fresh).toBe(true);
    expect(r.report).toMatchObject({
      ranking: { platform: "codex" },
      role: { name: "implementer" },
    });
    expect(r.selection).toMatchObject({ platform: "codex", agent: "tester" });
  });
  it("offers a shared-service briefing, acknowledges exact delivery and stops an unchanged queue through CLI JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    let text = "";
    const emit = async (s: string) => {
      text = s;
    };
    let reads = 0;
    const transport = serviceTransport({
      ...noLocalProject(repo),
      collect: async () => {
        reads++;
        const stamp = new Date().toISOString();
        return {
          ...snapshot([issue(1, ["status:ready", "platform:codex"])], []),
          startedAt: stamp,
          fetchedAt: stamp,
        };
      },
      dependencyReport,
    });
    const args = [...common, "--repo", repo, "--state-dir", dir];
    try {
      await runRebrief(["init", ...args], emit);
      expect(
        await runRebrief(
          ["check", ...args, "--event", "first", "--reason", "natural", "--enabled"],
          emit,
          { transport: () => transport },
        ),
      ).toBe(0);
      const result = JSON.parse(text);
      expect(result).toMatchObject({
        decision: "continue",
        reason: "changed-actionable-queue",
        platform: "codex",
      });
      expect(
        await runRebrief(
          ["ack", ...args, "--event", "first", "--fingerprint", result.fingerprint],
          emit,
        ),
      ).toBe(0);
      expect(JSON.parse(text).reason).toBe("acknowledged");
      await runRebrief(
        ["check", ...args, "--event", "second", "--reason", "natural", "--enabled"],
        emit,
        { transport: () => transport },
      );
      expect(JSON.parse(text).reason).toBe("unchanged");
      expect(reads).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("lets a user cancellation during state-lock release suppress a prepared offer", async () => {
    let text = "",
      offered = false;
    const controller = new AbortController();
    const transport = serviceTransport({
      ...noLocalProject(repo),
      collect: async () => {
        const stamp = new Date().toISOString();
        return {
          ...snapshot([issue(1, ["status:ready", "platform:codex"])], []),
          startedAt: stamp,
          fetchedAt: stamp,
        };
      },
      dependencyReport,
    });
    const args = [
      ...common,
      "--repo",
      repo,
      "--state-dir",
      join(tmpdir(), "unused-injected-state"),
      "--event",
      "late-cancel",
      "--enabled",
      "--reason",
      "natural",
    ];
    expect(
      await runRebrief(
        ["check", ...args],
        async (s) => {
          text = s;
        },
        {
          signal: controller.signal,
          transport: () => transport,
          state: async (_path, work) => {
            const result = await work(
              {
                version: 2,
                store: memoryStore(initializeV2({ ...context, repository: repo })),
              },
              noCreate,
            );
            offered =
              !!result &&
              typeof result === "object" &&
              "decision" in result &&
              result.decision === "continue";
            controller.abort(); // an interruption while the store releases its lock
            return result;
          },
        },
      ),
    ).toBe(0);
    expect(offered).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      decision: "stop",
      reason: expect.stringMatching(/^cancelled/),
      briefing: null,
    });
  });
  it("bounds an unresponsive state store by the total CLI deadline", async () => {
    let text = "";
    const args = [
      ...common,
      "--state-dir",
      join(tmpdir(), "unused-injected-state"),
      "--event",
      "slow-store",
      "--enabled",
      "--reason",
      "natural",
      "--deadline-ms",
      "10",
    ];
    expect(
      await runRebrief(
        ["check", ...args],
        async (s) => {
          text = s;
        },
        {
          state: async () => new Promise<never>(() => {}),
          transport: () => {
            throw new Error("no transport call");
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(text)).toMatchObject({
      decision: "stop",
      reason: "cancelled-or-deadline",
      briefing: null,
    });
  });
  it("aborts setup and configuration Git subprocesses without subsequent lookups", async () => {
    for (const phase of ["project", "configuration"]) {
      let calls = 0,
        text = "";
      let child: ChildProcess | undefined;
      let closed: Promise<void> = Promise.resolve();
      const git: GitRunner = (args, _cwd, signal) => {
        calls++;
        if (phase === "configuration" && calls <= 2)
          return Promise.resolve(
            args[0] === "rev-parse" ? "/project\n" : "origin\thttps://github.com/o/r.git (fetch)\n",
          );
        return new Promise((resolve, reject) => {
          child = execFile(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { signal },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
          closed = new Promise<void>((done) => child!.once("close", () => done()));
        });
      };
      try {
        expect(
          await runRebrief(
            [
              phase === "project" ? "init" : "check",
              ...common,
              "--project",
              "/project",
              "--state-dir",
              join(tmpdir(), "unused-injected-state"),
              "--deadline-ms",
              "100",
              "--enabled",
              "--event",
              "config-cancel",
              "--reason",
              "natural",
            ],
            async (s) => {
              text = s;
            },
            {
              git,
              state: async (_path, work) =>
                work(
                  {
                    version: 2,
                    store: memoryStore(initializeV2({ ...context, project: "/project" })),
                  },
                  noCreate,
                ),
              fs: {
                readText: async () => null,
                writeText: async () => {
                  throw new Error("no writes");
                },
                rename: async () => {
                  throw new Error("no writes");
                },
                remove: async () => {
                  throw new Error("no writes");
                },
                makeDirectory: async () => {
                  throw new Error("no writes");
                },
              },
              read: {
                collect: async () => {
                  const stamp = new Date().toISOString();
                  return {
                    ...snapshot([], []),
                    repository: "o/r",
                    startedAt: stamp,
                    fetchedAt: stamp,
                  };
                },
                dependencyReport,
                rest: undefined,
                query: undefined,
                queryWith: undefined,
              },
            },
          ),
        ).toBe(0);
        await closed;
        expect(calls, phase).toBe(phase === "project" ? 1 : 3);
        expect(JSON.parse(text), phase).toMatchObject({
          decision: "stop",
          reason: expect.stringMatching(/^cancelled/),
          briefing: null,
        });
        expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      } finally {
        child?.kill();
        await closed;
      }
    }
  });
  it("rebriefs an acknowledged PR follow-up when CI changes on the same head, with a stored retired engine key (#1050)", async () => {
    const scoped = {
      ...context,
      repository: repo,
      enabled: true,
      eventId: "failed-ci",
      reason: "natural",
    };
    const session = new RebriefSession(initialize(scoped));
    const makeTransport = (outcome: string) => {
      const local = noLocalProject(repo);
      return serviceTransport({
        ...local,
        now: clock,
        guide: {
          ...local.guide,
          fs: {
            ...local.guide!.fs!,
            readText: async (path) =>
              path.endsWith("triage.toml")
                ? 'schemaVersion=1\n[briefing]\nengine="typescript"\n'
                : null,
          },
        },
        collect: async () => {
          const pull = pr();
          pull.commits!.nodes[0].commit.statusCheckRollup!.contexts.nodes[0].conclusion = outcome;
          return snapshot([], [pull]);
        },
        dependencyReport,
      });
    };
    const runtime = { transport: makeTransport("FAILURE"), now: () => clock().getTime() };
    const failed = await session.evaluate(scoped, runtime);
    expect(failed).toMatchObject({
      decision: "continue",
      policyRevision: expect.stringContaining("datalog:"),
    });
    expect(session.acknowledge(scoped, scoped.eventId, failed.fingerprint!)).toBe(true);
    const clean = await session.evaluate(
      { ...scoped, eventId: "clean-ci" },
      { ...runtime, transport: makeTransport("SUCCESS") },
    );
    expect(clean.decision).toBe("continue");
    expect(clean.fingerprint).not.toBe(failed.fingerprint);
    expect(clean.actionIds).toEqual(failed.actionIds);
    expect(clean.briefing).not.toBe(failed.briefing);
  });
  it("passes cancellation to configuration Git reads for direct service adapters too", async () => {
    let started!: () => void,
      aborted = false,
      calls = 0;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const git: GitRunner = async (_args, _cwd, signal) => {
      calls++;
      return new Promise((_resolve, reject) => {
        started();
        const cancel = () => {
          aborted = true;
          reject(new Error("cancelled"));
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    };
    const local = noLocalProject(repo);
    const transport = serviceTransport({
      ...local,
      // This test's own Git boundary replaces the empty checkout's typed service.
      guide: { ...local.guide, gitService: undefined, git },
      now: clock,
      collect: async () => snapshot([], []),
      dependencyReport,
    });
    const controller = new AbortController();
    const pending = transport.read({ ...context, repository: repo }, controller.signal);
    await ready;
    controller.abort();
    await pending.catch(() => null);
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });
  it("help/error are structured and never echo private state errors", async () => {
    let text = "";
    const output = async (s: string) => {
      text = s;
    };
    expect(await runRebrief(["--help"], output)).toBe(0);
    expect(text).toContain("init|check|ack");
    expect(
      await runRebrief(["check", "--weird", "/SECRET"], output, { transport: () => never }),
    ).toBe(1);
    expect(JSON.parse(text).decision).toBe("stop");
    expect(text).not.toContain("SECRET");
  });
});

describe("rebrief default Git boundary (#933)", () => {
  it("never falls back to a raw runner when no Git boundary is injected", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./transports.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/\bnodeGit\b/);
    expect(source).toMatch(/createGitService\(\)/);
  });
});

describe("approved continuation through the CLI (#657 slice 2)", () => {
  /** A fresh, valid read for the CLI context whose queue changes on every call. */
  const changingTransport = (): Transport => {
    let n = 0;
    return {
      freshRead: true,
      read: async () => {
        const r = fixtureRead();
        const report = r.report as {
          freshness: { startedAt: string; fetchedAt: string };
          decisionEngine: { rulesHash: string };
        };
        const at = new Date().toISOString();
        report.freshness.startedAt = at;
        report.freshness.fetchedAt = at;
        report.decisionEngine.rulesHash = `rules${n++}`;
        return { ...r, selection: { ...r.selection, agent: context.agent } };
      },
    };
  };
  async function run(args: string[], transport?: Transport) {
    let text = "";
    expect(
      await runRebrief(
        args,
        async (t) => void (text = t),
        transport ? { transport: () => transport } : {},
      ),
    ).toBe(0);
    return JSON.parse(text) as {
      decision: string;
      reason: string;
      fingerprint: string | null;
      legacy?: string;
    };
  }
  const check = (args: string[], event: string, transport: Transport, extra: string[] = []) =>
    run(
      ["check", ...args, "--event", event, "--reason", "natural", "--enabled", ...extra],
      transport,
    );
  const ack = (args: string[], event: string, fingerprint: string) =>
    run(["ack", ...args, "--event", event, "--fingerprint", fingerprint]);

  it("init creates a v2 session with no default limit: more than three acknowledged offers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    const args = [...common, "--state-dir", dir];
    const transport = changingTransport();
    try {
      expect((await run(["init", ...args])).reason).toBe("initialized");
      const meta = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
      expect(meta).toMatchObject({ schemaVersion: 2, budget: null });
      for (let i = 0; i < 5; i++) {
        const offered = await check(args, `event-${i}`, transport);
        expect(offered.decision, offered.reason).toBe("continue");
        expect(offered.legacy).toBeUndefined();
        expect((await ack(args, `event-${i}`, offered.fingerprint!)).reason).toBe("acknowledged");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit --cap budget, including values above the old limit of three", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    const args = [...common, "--state-dir", dir];
    const transport = changingTransport();
    try {
      await run(["init", ...args, "--cap", "4"]);
      expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).budget).toBe(4);
      for (let i = 0; i < 4; i++) {
        const offered = await check(args, `event-${i}`, transport);
        await ack(args, `event-${i}`, offered.fingerprint!);
      }
      expect((await check(args, "event-4", transport)).reason).toBe("continuation-cap");
      expect((await check(args, "event-5", transport, ["--cap", "100"])).reason).toBe(
        "continuation-cap",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a legacy v1 session's limit and recovery, without upgrading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-rebrief-"));
    const args = [...common, "--state-dir", dir];
    try {
      await withPrivateState(dir, async (_s, save) => save(initialize(context)));
      const before = await readFile(join(dir, "state.json"), "utf8");
      const result = await check(args, "event-0", changingTransport());
      expect(result.decision).toBe("continue");
      expect(result.legacy).toContain("Legacy v1 session: at most three continuation offers");
      expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).schemaVersion).toBe(1);
      expect(before).toContain('"schemaVersion":1');
      expect((await run(["init", ...args])).reason).toBe("state-exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("codex-stop --installed binding (#770)", () => {
  const eventInput = (event: Record<string, unknown>) =>
    Readable.from([`${JSON.stringify(event)}\n`]);
  const gitRunner: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/work/project\n";
    if (args[0] === "remote" && args[1] === "-v")
      return "origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const ready = (): Transport => {
    let n = 0;
    return {
      freshRead: true,
      read: async () => {
        const r = fixtureRead();
        const report = r.report as {
          freshness: { startedAt: string; fetchedAt: string };
          decisionEngine: { rulesHash: string };
          repository: string;
          role: { name: string };
        };
        const at = new Date().toISOString();
        report.freshness.startedAt = at;
        report.freshness.fetchedAt = at;
        report.decisionEngine.rulesHash = `rules${n++}`;
        report.repository = "o/r";
        report.role.name = "implementer";
        return {
          ...r,
          selection: { repository: "o/r", agent: "tester", role: "implementer", platform: "codex" },
        };
      },
    };
  };

  it("resolves the repository from the event cwd, initializes once on an eligible Stop, and returns the native offer", async () => {
    let text = "";
    const accept = (_path: string, work: Parameters<typeof withSessionStore>[1]) =>
      work({ version: "none" }, async (meta) => memoryStore(meta));
    const runtime: CliRuntime = {
      input: eventInput({
        hook_event_name: "Stop",
        session_id: context.session,
        turn_id: "turn-1",
        stop_hook_active: false,
        cwd: "/work/project",
      }),
      git: gitRunner,
      env: {},
      currentRepository: async () => "o/r",
      transport: () => ready(),
      state: accept as typeof withSessionStore,
      prepareIdentity: (async () =>
        ({
          schemaVersion: 1,
          state: "resolved",
          agent: "tester",
          entry: null,
          source: "explicit-agent",
          store: null,
          bindingProvider: null,
          triageRole: "implementer",
          role: "implementer",
          roleSource: "explicit",
          human: null,
          diagnostic: null,
          setup: { state: "not-needed", changed: null, persisted: null, notices: [] },
        }) as unknown) as NonNullable<CliRuntime["prepareIdentity"]>,
    };
    const code = await runRebrief(
      ["codex-stop", "--installed", "--role", "implementer"],
      async (s) => void (text = s),
      runtime,
    );
    expect(code, text).toBe(0);
    const response = JSON.parse(text) as { decision?: string | undefined };
    expect(response.decision).toBe("block");
  });

  it("fails closed with {} and exit 0 when the event cwd is not a resolvable repository", async () => {
    const git: GitRunner = async () => {
      throw new Error("not a repo");
    };
    let text = "";
    const code = await runRebrief(["codex-stop", "--installed"], async (s) => void (text = s), {
      input: eventInput({
        hook_event_name: "Stop",
        session_id: context.session,
        turn_id: "turn-2",
        stop_hook_active: false,
        cwd: "/nowhere/project",
      }),
      git,
      env: {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(text)).toEqual({});
  });
});
