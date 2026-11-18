/**
 * `pdb serve` cached read API (doc/design/serve.md "Testing and acceptance" 2-6, #373).
 * Ephemeral ports, fake collectors and a manual clock; no test touches GitHub.
 */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { main } from "../cli.js";
import { TOML_CONFIG_PATH } from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { collect, collectIssueFocus, ghQueryFailure, IssueUnavailable } from "../github/github.js";
import { dependencyReport, dependencyText } from "../github/dependencies.js";
import { graphQuery } from "../testing/fakegh.js";
import { repo as fakeRepo } from "../testing/snapshots.js";
import type { Query } from "../github/github.js";
import { RateLimitError } from "../github/dependencies.js";
import type { Issue, Page, Snapshot } from "../github/types.js";
import type { Clock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { RunningServer, ServeRuntime } from "../serve.js";
import {
  definitiveRest,
  NO_PROJECT_ROOT,
  noLocalProject,
  queryRepository,
  servedOnlyQuery,
  servedOnlyRest,
} from "./api.js";
import { readServices } from "./services.js";
import type { LoadedGlobalConfig } from "../config/globalconfig.js";
import { ticketRenderers } from "./ticket-page.js";
import type { ServeReadRuntime } from "./api.js";
import { classifyFailure, ServeCache } from "./cache.js";
import { serveArguments } from "./options.js";

const repo = "example/parity";
const start = Date.parse("2026-11-12T10:00:00.000Z");
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (n: number, labels: string[], createdAt: string): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt,
  updatedAt: "2026-11-12T09:00:00.000Z",
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
const issues = (): Issue[] => [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XS", "complexity:XL"], "2026-10-01T00:00:00Z"),
  issue(3, ["status:ready", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
  issue(4, ["status:ready", "impact:XL"], "2026-11-03T00:00:00Z"),
  issue(5, ["status:needs-design", "complexity:XS"], "2026-11-04T00:00:00Z"),
  issue(8, ["status:ready", "agent:me", "impact:S"], "2026-11-07T00:00:00Z"),
];
const query: Query = async (source) => ({
  repository: {
    issues: page(source.includes("issues(first") ? issues() : []),
    pullRequests: page([]),
    issue: source.includes("issue(number") ? issues()[0] : null,
  },
});
const root = resolve("/work/parity-checkout");
const files: ConfigFileSystem = {
  readText: async (file) => (file === join(root, TOML_CONFIG_PATH) ? null : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
};
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;

/** A manual clock: time only moves when a test advances it; timers never fire on their own. */
class ManualClock implements Clock {
  time = start;
  now = () => new Date(this.time);
  setTimeout = () => ({});
  clearTimeout = () => undefined;
  advance(ms: number) {
    this.time += ms;
  }
}

interface Setup {
  running: RunningServer;
  clock: ManualClock;
  calls: {
    collect: { repository: string; options: unknown }[];
    deps: number;
    auth: number;
    projectRuntime: (string | undefined)[];
  };
  stderr: string[];
  close: () => Promise<void>;
}

async function setup(
  args: string[] = ["--repo", repo],
  overrides: {
    collect?: ServeReadRuntime["collect"];
    collectIssueFocus?: ServeReadRuntime["collectIssueFocus"];
    authContext?: ServeRuntime["authContext"];
    queryWith?: ServeReadRuntime["queryWith"];
    dependencyReport?: ServeReadRuntime["dependencyReport"];
    rest?: ServeReadRuntime["rest"];
    loadEngine?: ServeReadRuntime["loadEngine"];
  } = {},
): Promise<Setup> {
  const clock = new ManualClock();
  const calls: Setup["calls"] = { collect: [], deps: 0, auth: 0, projectRuntime: [] };
  const stderr: string[] = [];
  const serve: ServeRuntime = {
    currentRepository: async () => repo,
    authContext:
      overrides.authContext ??
      (async () => {
        calls.auth++;
        return { host: "github.com", login: "octo" };
      }),
    clock,
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
  };
  const base: ServeReadRuntime["collect"] = (repository, options) =>
    collect(repository, options, query, () => clock.now());
  const read: ServeReadRuntime = {
    engineClock: () => 0,
    // The focused `who` read over the same facts (#367).
    collectIssueFocus:
      overrides.collectIssueFocus ??
      ((repository, number, options) =>
        collectIssueFocus(repository, number, options, query, () => clock.now())),
    collect: (repository, options) => {
      calls.collect.push({ repository, options: { ...options, signal: undefined } });
      return (overrides.collect ?? base)(repository, options);
    },
    dependencyReport: async (repository, number, options) => {
      if (overrides.dependencyReport)
        return overrides.dependencyReport(repository, number, options);
      calls.deps++;
      return {
        schemaVersion: 1,
        kind: "dependencies",
        repository,
        number,
        tree: !!options?.tree,
        ...(options?.tree
          ? {
              treeBounds: {
                complete: true,
                nodeLimit: 50,
                nodesRead: 1,
                stoppedBy: null,
                notRead: 0,
                notServed: 0,
                notReadSample: [],
                cyclesComplete: true,
              },
            }
          : {}),
      } as never;
    },
    queryWith: overrides.queryWith,
    ...(overrides.loadEngine ? { loadEngine: overrides.loadEngine } : {}),
    ...(overrides.rest ? { rest: overrides.rest } : {}),
    now: () => clock.now(),
    env: {},
    git,
    fs: files,
    projectRuntime: (project) => {
      calls.projectRuntime.push(project);
      return {
        estimation: { fs: files, git, cwd: root },
        guide: { fs: files, git, cwd: root },
      };
    },
  };
  const options = serveArguments(["--port", "0", ...args]);
  const running = await startServe(options, serve, readServices(options, serve, read));
  return { running, clock, calls, stderr, close: () => running.close() };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, any>;
}

function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(body) as Record<string, unknown>;
          } catch {
            // Not JSON (HTML placeholder).
          }
          done({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

/**
 * The same JSON with measured read durations zeroed (#367): durations come from an advancing
 * timer, so two reads of the same facts differ only there.
 */
const timeless = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key: string, v: unknown) => (key === "durationMs" ? 0 : v));

/** The CLI's --json output for the same flags and the same injected facts. */
async function cliJson(args: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await main(
    [...args, "--repo", repo, "--json", "--no-update-check"],
    async (text) => void (out += text),
    {
      collect: (repository, options) => collect(repository, options, query, () => new Date(start)),
      collectIssueFocus: (repository, number, options) =>
        collectIssueFocus(repository, number, options, query, () => new Date(start)),
      currentRepository: async () => repo,
      dependencyReport: async () => {
        throw new Error("not used");
      },
      estimation: { fs: files, git, cwd: root },
      guide: { fs: files, git, cwd: root },
      now: () => new Date(start),
      engineClock: () => 0,
      updateCheck: async () => ({ status: "disabled" }) as never,
    },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * #516: a served --repo-only repository cannot read its project configuration, so its effective
 * policy is "unavailable", while a checkout without configuration reports "disabled". Everything
 * else must be identical; this removes only that manifest and returns the states it held.
 */
const splitPolicy = (value: unknown): { rest: unknown; states: string[] } => {
  const states: string[] = [];
  const rest = JSON.parse(JSON.stringify(value), (key: string, v: unknown) => {
    if (key !== "effectivePolicy") return v;
    states.push((v as { state: string }).state);
    return undefined;
  }) as unknown;
  return { rest, states };
};

const envelopeKeys = [
  "schemaVersion",
  "kind",
  "view",
  "status",
  "selection",
  "freshness",
  "warnings",
  "result",
  "error",
];

describe("pdb serve read API (#373)", () => {
  it("briefing JSON equals CLI --json for the same facts, flags and clock", async () => {
    const s = await setup();
    try {
      for (const [role, order] of [
        ["implementer", "impact"],
        ["designer", "oldest"],
        // The human briefing (#457) goes through the same shared service.
        ["human", "impact"],
      ] as const) {
        const reply = await call(
          s.running.port,
          `/api/v1/briefing?agent=me&role=${role}&order=${order}&limit=10`,
        );
        expect(reply.status).toBe(200);
        expect(Object.keys(reply.json)).toEqual(envelopeKeys);
        expect(reply.json).toMatchObject({
          schemaVersion: 1,
          kind: "serve-read",
          view: "briefing",
          // #414: with no live REST/GraphQL boundary closed sources are not read, which the
          // human view reports as incomplete rather than as no orphaned question.
          status: role === "human" ? "incomplete" : "complete",
          selection: { repository: repo, agent: "me", identitySource: "tool" },
          error: null,
        });
        const cli = await cliJson([
          "--agent",
          "me",
          "--role",
          role,
          "--order",
          order,
          "--limit",
          "10",
        ]);
        const served = splitPolicy(reply.json.result);
        const local = splitPolicy(cli);
        expect(served.rest).toEqual(local.rest);
        if (role !== "human") {
          expect(served.states).toEqual(["unavailable"]);
          expect(local.states).toEqual(["disabled"]);
        }
      }
    } finally {
      await s.close();
    }
  });

  it("issue, who and team JSON equal the CLI's for the same facts", async () => {
    const s = await setup();
    try {
      const issueReply = await call(s.running.port, "/api/v1/issues/1?agent=me");
      expect(issueReply.json.view).toBe("issue");
      expect(timeless(issueReply.json.result)).toEqual(
        timeless(await cliJson(["--issue", "1", "--agent", "me"])),
      );
      const who = await call(s.running.port, "/api/v1/issues/1/who?staleHours=24");
      expect(who.json.view).toBe("who");
      expect(timeless(who.json.result)).toEqual(
        timeless(await cliJson(["who", "1", "--stale-hours", "24"])),
      );
      const team = await call(s.running.port, "/api/v1/team");
      expect(team.json.view).toBe("team");
      expect(team.json.result).toEqual(await cliJson(["team"]));
      const deps = await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(deps.json).toMatchObject({
        view: "dependencies",
        status: "complete",
        result: { number: 1, tree: true },
      });
    } finally {
      await s.close();
    }
  });

  it("an unavailable issue is 200 with the existing diagnosis", async () => {
    const s = await setup(["--repo", repo], {
      collect: async (repository, options) => {
        throw new IssueUnavailable({
          repository,
          number: options?.issue ?? 0,
          url: url(options?.issue ?? 0),
          state: "missing",
          detail: "Issue not found.",
          next: "Check the number.",
        } as never);
      },
    });
    try {
      const reply = await call(s.running.port, "/api/v1/issues/77");
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        status: "incomplete",
        freshness: { source: "live" },
        result: { schemaVersion: 1, kind: "issue-unavailable", state: "missing", number: 77 },
      });
    } finally {
      await s.close();
    }
  });

  it("rejects unknown or invalid parameters and resolves repositories per the served set", async () => {
    const one = await setup();
    try {
      for (const path of [
        "/api/v1/briefing?nope=1",
        "/api/v1/briefing?limit=0",
        "/api/v1/briefing?limit=101",
        "/api/v1/briefing?role=owner",
        "/api/v1/briefing?order=random",
        "/api/v1/briefing?since=yesterday",
        "/api/v1/briefing?agent=-bad",
        "/api/v1/briefing?refresh=yes",
        "/api/v1/briefing?limit=1&limit=2",
        "/api/v1/team?staleHours=-1",
        "/api/v1/issues/1/deps?tree=1",
        "/api/v1/issues/1/deps?role=implementer",
        "/api/v1/briefing?entry=a&harness=claude",
        // #311: an unknown or explicitly empty section, with or without a role.
        "/api/v1/briefing?role=implementer&section=nope",
        "/api/v1/briefing?section=nope",
        "/api/v1/briefing?section=",
      ]) {
        const reply = await call(one.running.port, path);
        expect(reply.status, path).toBe(400);
        expect(reply.json.error.code, path).toBe("INVALID_ARGUMENT");
      }
      const notServed = await call(one.running.port, "/api/v1/briefing?repo=other/repo");
      expect(notServed.status).toBe(403);
      expect(notServed.json.error.code).toBe("REPOSITORY_NOT_SERVED");
      // Case-insensitive match keeps the served set's spelling.
      const upper = await call(one.running.port, "/api/v1/team?repo=EXAMPLE/Parity");
      expect(upper.json.selection.repository).toBe(repo);
      expect((await call(one.running.port, "/api/v1/issues/0")).status).toBe(404);
      expect((await call(one.running.port, "/api/v1/prs/1/who")).status).toBe(404);
      expect((await call(one.running.port, "/api/v1/briefing", { method: "DELETE" })).status).toBe(
        405,
      );
    } finally {
      await one.close();
    }
    const two = await setup(["--repo", repo, "--repo", "example/second"]);
    try {
      const reply = await call(two.running.port, "/api/v1/briefing");
      expect(reply.status).toBe(400);
      expect(reply.json.error).toMatchObject({
        code: "REPOSITORY_UNRESOLVED",
        next: [`?repo=${repo}`, "?repo=example/second"],
      });
      expect(two.calls.collect).toEqual([]);
    } finally {
      await two.close();
    }
  });
});

describe("pdb serve identity selection (#373)", () => {
  it("uses request agent, then startup agent, else an unfocused read with a diagnostic", async () => {
    const withAgent = await setup(["--repo", repo, "--agent", "boss"]);
    try {
      const startup = await call(withAgent.running.port, "/api/v1/briefing");
      expect(startup.json.selection).toMatchObject({ agent: "boss", identitySource: "startup" });
      const tool = await call(withAgent.running.port, "/api/v1/briefing?agent=me");
      expect(tool.json.selection).toMatchObject({ agent: "me", identitySource: "tool" });
    } finally {
      await withAgent.close();
    }
    const bare = await setup();
    try {
      const unfocused = await call(bare.running.port, "/api/v1/briefing");
      expect(unfocused.json.selection).toMatchObject({
        agent: null,
        identitySource: "unresolved",
      });
      expect(unfocused.json.selection.identityDiagnostic).toContain("no local project");
    } finally {
      await bare.close();
    }
  });
});

describe("pdb serve without a local project (#271)", () => {
  it("never reads configuration from the working directory for a --repo-only repository", async () => {
    const s = await setup(["--repo", repo]);
    const cwd = vi.spyOn(process, "cwd");
    try {
      for (const path of ["/api/v1/briefing?role=implementer", "/api/v1/issues/1"]) {
        const reply = await call(s.running.port, path);
        expect(reply.status, path).toBe(200);
      }
      expect(cwd).not.toHaveBeenCalled();
      expect(s.calls.projectRuntime).toEqual([]);
    } finally {
      cwd.mockRestore();
      await s.close();
    }
  });

  it("presents an empty checkout of exactly that repository, read-only", async () => {
    const readers = noLocalProject("owner/name");
    // A typed GitService (#934), shared by the estimation and guide readers.
    const git = readers.guide!.gitService!;
    expect(readers.estimation!.git).toBe(git);
    const ctx = { cwd: NO_PROJECT_ROOT };
    expect(await git.workingTreeRoot(ctx)).toBe(NO_PROJECT_ROOT);
    expect(await git.checkout(ctx)).toEqual({ host: "github.com", repository: "owner/name" });
    expect((await git.remotes(ctx)).map((r) => r.url)).toEqual([
      "https://github.com/owner/name.git",
    ]);
    expect(await git.isTracked(ctx, "pdb.toml")).toBe(false);
    expect(await readers.guide!.fs!.readText(join(NO_PROJECT_ROOT, TOML_CONFIG_PATH))).toBeNull();
    await expect(readers.guide!.fs!.writeText("x", "y")).rejects.toThrow(/never writes/);
  });
});

const moved = (destination: string) => async () => {
  throw new IssueUnavailable({
    repository: repo,
    number: 7,
    url: url(7),
    state: "moved",
    detail: "Transferred.",
    next: "Follow it.",
    destination: {
      repository: destination,
      number: 3,
      url: `https://github.com/${destination}/issues/3`,
    },
  } as never);
};

describe("pdb serve never reads an unserved repository (#373 review)", () => {
  it("does not follow a transfer into a repository it does not serve", async () => {
    const s = await setup(["--repo", repo], {
      collect: async (repository, options) =>
        repository === repo ? moved("someone/else")() : collect(repository, options, query),
    });
    try {
      const reply = await call(s.running.port, "/api/v1/issues/7?includeTransferred=true");
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        status: "incomplete",
        result: { kind: "issue-unavailable", state: "moved" },
      });
      expect(reply.json.warnings[0]).toContain("someone/else is not served");
      expect(s.calls.collect.map((c) => c.repository)).toEqual([repo]);
    } finally {
      await s.close();
    }
  });

  it("follows a transfer into another served repository", async () => {
    const s = await setup(["--repo", repo, "--repo", "example/second"], {
      collect: async (repository, options) =>
        repository === repo
          ? moved("example/second")()
          : collect(repository, options, query, () => new Date(start)),
    });
    try {
      const reply = await call(
        s.running.port,
        `/api/v1/issues/7?repo=${repo}&includeTransferred=true`,
      );
      expect(reply.json.result.transferredFrom).toMatchObject({ state: "moved" });
      expect(s.calls.collect.map((c) => c.repository)).toEqual([repo, "example/second"]);
    } finally {
      await s.close();
    }
  });

  it("reports a capped tree as incomplete with what was not read, and never caches it (#196)", async () => {
    const { query, calls } = graphQuery({
      edges: Array.from({ length: 6 }, (_, i): [number, number] => [10 + i, 1]),
    });
    const s = await setup(["--repo", fakeRepo], {
      dependencyReport: (repository, number, options) =>
        dependencyReport(repository, number, { ...options, maxNodes: 3 }, query),
    });
    try {
      const reply = await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(reply.status).toBe(200);
      expect(reply.json.status).toBe("incomplete");
      expect(reply.json.result.treeBounds).toMatchObject({
        complete: false,
        stoppedBy: "node-limit",
        nodesRead: 3,
        notRead: 4,
      });
      const warnings = reply.json.warnings.join("\n");
      expect(warnings).toContain("TREE INCOMPLETE (node limit 3)");
      expect(warnings).toContain("Not read:");
      // CLI text gives the same verdict for the same report.
      expect(dependencyText(reply.json.result)).toContain("TREE INCOMPLETE (node limit 3)");
      // Not stored: a second request reads live again.
      const before = calls.length;
      await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(calls.length).toBe(before + 3);
      // A complete direct read is cached as before.
      await call(s.running.port, "/api/v1/issues/1/deps");
      const direct = calls.length;
      await call(s.running.port, "/api/v1/issues/1/deps");
      expect(calls.length).toBe(direct);
    } finally {
      await s.close();
    }
  });

  it("does not walk dependency edges into unserved repositories, and says so", async () => {
    const asked: string[] = [];
    const node = (owner: string, number: number, blockedBy: unknown[]) => ({
      number,
      title: `T${number}`,
      body: "",
      url: `https://github.com/${owner}/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      updatedAt: "2026-11-12T09:00:00Z",
      labels: page([]),
      issueDependenciesSummary: {
        blockedBy: blockedBy.length,
        totalBlockedBy: blockedBy.length,
        blocking: 0,
        totalBlocking: 0,
      },
      blockedBy: page(blockedBy),
      blocking: page([]),
    });
    const edge = (owner: string, number: number) => ({
      number,
      title: `T${number}`,
      url: `https://github.com/${owner}/issues/${number}`,
      state: "OPEN",
      repository: { nameWithOwner: owner },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    });
    const depQuery: Query = async (_source, variables) => {
      const owner = `${String(variables.owner)}/${String(variables.name)}`;
      asked.push(owner);
      return {
        repository: {
          issue:
            owner === repo
              ? node(repo, Number(variables.number), [edge("someone/else", 9)])
              : node(owner, Number(variables.number), []),
        },
      };
    };
    const s = await setup(["--repo", repo], {
      dependencyReport: (repository, number, options) =>
        dependencyReport(repository, number, options, depQuery),
    });
    try {
      const reply = await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(reply.status).toBe(200);
      expect(reply.json.status).toBe("incomplete");
      expect(reply.json.result.unfollowed).toEqual([{ repository: "someone/else", number: 9 }]);
      expect(reply.json.warnings[0]).toContain("someone/else#9");
      // An unfollowed node makes the tree itself incomplete, as the CLI says (#196).
      expect(reply.json.result.treeBounds).toMatchObject({ complete: false, notServed: 1 });
      expect(reply.json.warnings.join()).toContain("TREE INCOMPLETE");
      expect(asked).toEqual([repo]);
    } finally {
      await s.close();
    }
  });

  it("refuses GraphQL and REST reads of unserved repositories before gh runs", async () => {
    const served = (r: string) => r.toLowerCase() === repo;
    let ran = 0;
    const guarded = servedOnlyQuery(
      () => async () => {
        ran++;
        return {};
      },
      served,
    )();
    await expect(guarded("q", { owner: "someone", name: "else", number: 1 })).rejects.toThrow(
      /not served/,
    );
    await expect(guarded("q", { url: "https://github.com/someone/else/pull/2" })).rejects.toThrow(
      /not served/,
    );
    await guarded("q", { owner: "Example", name: "Parity", number: 1 });
    await guarded("q", { number: 1 });
    expect(ran).toBe(2);
    expect(queryRepository({ url: "https://github.com/a/b" })).toBe("a/b");
    const rest = servedOnlyRest(async () => ({ status: 200, body: {} }), served);
    expect(await rest("repos/someone/else/compare/a...b")).toEqual({ status: null, body: null });
    expect(await rest(`repos/${repo}/collaborators/x/permission`)).toEqual({
      status: 200,
      body: {},
    });
  });
});

describe("pdb serve classifies GitHub failures by structured signals (#373 review)", () => {
  // gh's sanitized message mentions "gh auth status" on every failure; only types decide.
  const failures: [string, unknown, string][] = [
    [
      "network outage",
      { code: 1, stderr: "error connecting to api.github.com\ncheck your internet connection" },
      "GITHUB_UNAVAILABLE",
    ],
    ["timeout", { code: null, killed: true, signal: "SIGTERM", stderr: "" }, "GITHUB_UNAVAILABLE"],
    [
      "HTTP 502",
      { code: 1, stderr: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)" },
      "GITHUB_UNAVAILABLE",
    ],
    [
      "HTTP 401",
      { code: 1, stderr: "gh: HTTP 401: Bad credentials (https://api.github.com/graphql)" },
      "GITHUB_AUTH",
    ],
    [
      "gh not logged in (exit 4)",
      { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" },
      "GITHUB_AUTH",
    ],
    [
      "rate limit",
      { code: 1, stderr: "gh: HTTP 403: API rate limit exceeded\nRetry-After: 30" },
      "GITHUB_RATE_LIMITED",
    ],
  ];
  for (const [name, execError, code] of failures)
    it(`${name} is ${code}`, () => {
      const thrown = ghQueryFailure(execError);
      expect(thrown.message).not.toContain("Bad credentials");
      expect(classifyFailure(thrown, start).code).toBe(code);
    });

  it("an outage reaches clients as GITHUB_UNAVAILABLE and keeps auth handling out of it", async () => {
    const s = await setup(["--repo", repo], {
      collect: async () => {
        throw ghQueryFailure({ code: 1, stderr: "gh: HTTP 503: Service Unavailable" });
      },
    });
    try {
      const reply = await call(s.running.port, "/api/v1/briefing");
      expect(reply.status).toBe(502);
      expect(reply.json.error.code).toBe("GITHUB_UNAVAILABLE");
    } finally {
      await s.close();
    }
    const auth = await setup(["--repo", repo], {
      collect: async () => {
        throw ghQueryFailure({ code: 1, stderr: "gh: HTTP 401: Bad credentials" });
      },
    });
    try {
      expect((await call(auth.running.port, "/api/v1/briefing")).json.error.code).toBe(
        "GITHUB_AUTH",
      );
    } finally {
      await auth.close();
    }
  });
});

describe("pdb serve maps domain errors (#373 review)", () => {
  it("a missing engine module carries its safe cause and recovery (#346)", async () => {
    const s = await setup(["--repo", repo], {
      loadEngine: async () => {
        throw Object.assign(
          new Error("Cannot find package 'datascript' imported from /private/home/x/dist/d.mjs"),
          { code: "ERR_MODULE_NOT_FOUND", stack: "at /private/home/x" },
        );
      },
    });
    try {
      const reply = await call(s.running.port, "/api/v1/briefing");
      expect(reply.status).toBe(500);
      expect(reply.json.error).toMatchObject({
        code: "INTERNAL",
        cause: {
          category: "missing-module",
          module: "datascript",
          recovery: ["npm ci", "pdb doctor"],
        },
      });
      expect(reply.json.error.message).toMatch(/Missing module datascript/);
      expect(reply.json.error.next.slice(0, 2)).toEqual(["npm ci", "pdb doctor"]);
      expect(reply.body).not.toContain("/private/home");
      expect(reply.body).not.toContain("Cannot find package");
    } finally {
      await s.close();
    }
  });

  it("who answers an unavailable issue with its diagnosis, not a 500", async () => {
    const s = await setup(["--repo", repo], { collectIssueFocus: moved("someone/else") });
    try {
      const reply = await call(s.running.port, "/api/v1/issues/7/who");
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        view: "who",
        status: "incomplete",
        result: { kind: "issue-unavailable", state: "moved" },
      });
    } finally {
      await s.close();
    }
  });

  it("an unknown pull request is 404 NOT_FOUND, never stale or a GitHub failure", async () => {
    const s = await setup(["--repo", repo], {
      queryWith: () => async () => ({ repository: { pullRequest: null } }),
    });
    try {
      for (const path of ["/api/v1/prs/99", "/api/v1/prs/99?history=true"]) {
        const reply = await call(s.running.port, path);
        expect(reply.status, path).toBe(404);
        expect(reply.json.error, path).toMatchObject({ code: "NOT_FOUND" });
        expect(reply.json.error.message).toContain("Pull request #99 is unavailable");
      }
      const status = await call(s.running.port, "/api/v1/status");
      expect(status.json.repositories[0].lastError).toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe("pdb serve cache (#373)", () => {
  it("serves a fresh entry from cache, collects again after the TTL, and reports freshness", async () => {
    const s = await setup();
    try {
      const first = await call(s.running.port, "/api/v1/briefing?agent=me");
      expect(first.json.freshness).toEqual({
        source: "live",
        observedAt: new Date(start).toISOString(),
        ageSeconds: 0,
        ttlSeconds: 300,
        expiresAt: new Date(start + 300_000).toISOString(),
        stale: false,
        refreshError: null,
      });
      s.clock.advance(83_000);
      const second = await call(s.running.port, "/api/v1/briefing?agent=me");
      expect(second.json.freshness).toMatchObject({ source: "cached", ageSeconds: 83 });
      expect(s.calls.collect).toHaveLength(1);
      // The request log names the cache source; never query values.
      expect(s.stderr.join("")).toMatch(/GET \/api\/v1\/briefing 200 cached \d+ms/);
      expect(s.stderr.join("")).not.toContain("agent=me");
      s.clock.advance(300_000);
      const third = await call(s.running.port, "/api/v1/briefing?agent=me");
      expect(third.json.freshness.source).toBe("live");
      expect(s.calls.collect).toHaveLength(2);
      const status = await call(s.running.port, "/api/v1/status");
      expect(status.json.cache).toMatchObject({ entries: 1, hits: 1, misses: 2, inflight: 0 });
      expect(status.json.cache.approxBytes).toBeGreaterThan(0);
      expect(status.json.repositories[0].observedAt).toBe(new Date(s.clock.time).toISOString());
    } finally {
      await s.close();
    }
  });

  it("coalesces concurrent identical reads into one collection and keeps coverage keys apart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const s = await setup(["--repo", repo], {
      collect: async (repository, options) => {
        await gate;
        return collect(repository, options, query, () => new Date(start));
      },
    });
    try {
      const pending = Array.from({ length: 5 }, () =>
        call(s.running.port, "/api/v1/briefing?agent=me"),
      );
      const focused = call(s.running.port, "/api/v1/issues/1");
      await until(() => s.calls.collect.length === 2);
      release();
      const replies = await Promise.all(pending);
      expect(replies.every((r) => r.json.freshness.source === "live")).toBe(true);
      expect((await focused).json.view).toBe("issue");
      // One unfocused and one focused collection: distinct coverage is never shared.
      expect(s.calls.collect.map((c) => c.options)).toEqual([
        { signal: undefined },
        { issue: 1, signal: undefined },
      ]);
      const status = await call(s.running.port, "/api/v1/status");
      expect(status.json.cache.coalesced).toBe(4);
    } finally {
      await s.close();
    }
  });

  it("two agents with different roles get their own correct queues from one cached snapshot", async () => {
    const s = await setup();
    try {
      const implementer = await call(s.running.port, "/api/v1/briefing?agent=me&role=implementer");
      const designer = await call(s.running.port, "/api/v1/briefing?agent=other&role=designer");
      expect(s.calls.collect).toHaveLength(1);
      expect(designer.json.freshness.source).toBe("cached");
      expect(splitPolicy(implementer.json.result).rest).toEqual(
        splitPolicy(await cliJson(["--agent", "me", "--role", "implementer"])).rest,
      );
      expect(splitPolicy(designer.json.result).rest).toEqual(
        splitPolicy(await cliJson(["--agent", "other", "--role", "designer"])).rest,
      );
      expect(implementer.json.result).not.toEqual(designer.json.result);
    } finally {
      await s.close();
    }
  });

  it("clears the cache when the gh login changes", async () => {
    let login = "octo";
    const s = await setup(["--repo", repo], {
      authContext: async () => ({ host: "github.com", login }),
    });
    try {
      await call(s.running.port, "/api/v1/team");
      s.clock.advance(301_000);
      login = "someone-else";
      await call(s.running.port, "/api/v1/briefing");
      const status = await call(s.running.port, "/api/v1/status");
      expect(status.json.auth).toEqual({ host: "github.com", login: "someone-else" });
      // The old login's entry is gone; only the new collection remains.
      expect(status.json.cache.entries).toBe(1);
      // A read the old login had cached is collected again.
      await call(s.running.port, "/api/v1/team");
      expect(s.calls.collect).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("evicts least recently used entries at the entry and byte bounds", async () => {
    const clock = new ManualClock();
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: async () => ({ host: "h", login: "l" }),
      initialAuth: { host: "h", login: "l" },
      maxEntries: 2,
      maxBytes: 1000,
    });
    const key = (n: number) => ({ repository: "o/r", collector: "c", coverage: { n } });
    let produced = 0;
    const produce = (size: number) => async () => {
      produced++;
      return "x".repeat(size);
    };
    await cache.read(key(1), produce(10));
    await cache.read(key(2), produce(10));
    await cache.read(key(1), produce(10)); // hit: 1 becomes most recently used
    await cache.read(key(3), produce(10)); // evicts 2
    expect(cache.status()).toMatchObject({ entries: 2, evictions: 1, hits: 1 });
    await cache.read(key(1), produce(10));
    expect(produced).toBe(3);
    await cache.read(key(2), produce(10));
    expect(produced).toBe(4);
    await cache.read(key(4), produce(900)); // byte bound: older entries go first
    expect(cache.status().approxBytes).toBeLessThanOrEqual(1000);
    await cache.read(key(5), produce(5000)); // alone over the bound: served, not kept
    expect(cache.status().approxBytes).toBeLessThanOrEqual(1000);
    cache.close();
  });

  it("collector-scoped refresh invalidates only that collector's flights and entries (#808 deps)", async () => {
    const clock = new ManualClock();
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: async () => ({ host: "h", login: "l" }),
      initialAuth: { host: "h", login: "l" },
    });
    const briefing = { repository: "o/r", collector: "briefing", coverage: { v: 1 } };
    const deps = { repository: "o/r", collector: "deps", coverage: { v: 1 } };
    const counts = { briefing: 0, deps: 0 };
    const produce = (which: "briefing" | "deps") => async () => {
      counts[which]++;
      return `${which}#${counts[which]}`;
    };
    // Collect both collectors, then a collector-scoped refresh of exactly `deps`.
    expect(await cache.read(briefing, produce("briefing"))).toBe("briefing#1");
    expect(await cache.read(deps, produce("deps"))).toBe("deps#1");
    // #414: a closed-question scan slot exists for the project/repository before the refresh.
    const scan = cache.closedQuestions.slot("p", "o/r");
    const dropped = cache.refresh("o/r", ["deps"]);
    expect(dropped).toBe(1);
    // The briefing entry survives its cache row; the deps row is gone and re-collected; and the
    // closed-question scan state is preserved (dependency-only invalidation never discards scan
    // progress of an unchanged context).
    expect(await cache.read(briefing, produce("briefing"))).toBe("briefing#1");
    expect(await cache.read(deps, produce("deps"))).toBe("deps#2");
    expect(counts).toEqual({ briefing: 1, deps: 2 });
    expect(scan.lost).toBeNull();
    // An explicit briefing-scope refresh revalidates the scans (#414, human-briefing.md).
    const scoped = cache.closedQuestions.slot("p3", "o/r");
    (scoped as { state: unknown }).state = { overwritten: false } as never;
    cache.refresh("o/r", ["collect", "discovery", "issue-facts"]);
    expect(scoped.lost).not.toBeNull();
    // A repository-wide refresh also discards the scan.
    const scan2 = cache.closedQuestions.slot("p2", "o/r");
    (scan2 as { state: unknown }).state = { overwritten: false } as never;
    cache.refresh("o/r");
    expect(scan2.lost).not.toBeNull();
    cache.close();
  });

  it("a repository-scoped refresh invalidates every collector of the repository", async () => {
    const clock = new ManualClock();
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: async () => ({ host: "h", login: "l" }),
      initialAuth: { host: "h", login: "l" },
    });
    const briefing = { repository: "o/r", collector: "briefing", coverage: { v: 1 } };
    const deps = { repository: "o/r", collector: "deps", coverage: { v: 1 } };
    const counts = { briefing: 0, deps: 0 };
    const produce = (which: "briefing" | "deps") => async () => {
      counts[which]++;
      return `${which}#${counts[which]}`;
    };
    expect(await cache.read(briefing, produce("briefing"))).toBe("briefing#1");
    expect(await cache.read(deps, produce("deps"))).toBe("deps#1");
    expect(cache.refresh("o/r")).toBe(2);
    expect(await cache.read(briefing, produce("briefing"))).toBe("briefing#2");
    expect(await cache.read(deps, produce("deps"))).toBe("deps#2");
    cache.close();
  });

  it("refresh drops entries; refresh=true bypasses a fresh entry", async () => {
    const s = await setup();
    try {
      await call(s.running.port, "/api/v1/briefing");
      await call(s.running.port, "/api/v1/issues/1/deps");
      const noJson = await call(s.running.port, "/api/v1/refresh", { method: "POST", body: "{}" });
      expect(noJson.status).toBe(415);
      const big = await call(s.running.port, "/api/v1/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, pad: "x".repeat(70 * 1024) }),
      });
      expect(big.status).toBe(413);
      expect(big.json.error.code).toBe("BODY_TOO_LARGE");
      const bad = await call(s.running.port, "/api/v1/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, extra: 1 }),
      });
      expect(bad.status).toBe(400);
      const scoped = await call(s.running.port, "/api/v1/refresh", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ repo, scope: "deps" }),
      });
      expect(scoped.json).toMatchObject({ kind: "serve-refresh", evicted: 1, scope: "deps" });
      const all = await call(s.running.port, "/api/v1/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(all.json.evicted).toBe(1);
      await call(s.running.port, "/api/v1/briefing");
      expect(s.calls.collect).toHaveLength(2);
      const forced = await call(s.running.port, "/api/v1/briefing?refresh=true");
      expect(forced.json.freshness.source).toBe("live");
      expect(s.calls.collect).toHaveLength(3);
      expect((await call(s.running.port, "/api/v1/refresh")).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});

describe("pdb serve cache races (#373)", () => {
  const makeCache = (clock: ManualClock, login: () => string, maxConcurrent = 4) =>
    new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: async () => ({ host: "h", login: login() }),
      initialAuth: { host: "h", login: "old" },
      maxConcurrent,
    });

  it("never stores a collection that ran under a login that changed before it finished", async () => {
    const clock = new ManualClock();
    let login = "old";
    const cache = makeCache(clock, () => login);
    let finish!: (value: string) => void;
    const slow = cache.read(
      { repository: "o/r", collector: "c", coverage: { n: 1 } },
      () => new Promise<string>((done) => (finish = done)),
    );
    await until(() => finish !== undefined);
    // Another collection notices gh auth switch while the first is still running.
    clock.advance(301_000);
    login = "new";
    await cache.read({ repository: "o/r", collector: "c", coverage: { n: 2 } }, async () => "b");
    finish("collected-as-old");
    // Its own waiter still gets what it asked for...
    expect(await slow).toBe("collected-as-old");
    // ...but a read under the new login does not see it.
    let produced = 0;
    expect(
      await cache.read({ repository: "o/r", collector: "c", coverage: { n: 1 } }, async () => {
        produced++;
        return "collected-as-new";
      }),
    ).toBe("collected-as-new");
    expect(produced).toBe(1);
    cache.close();
  });

  it("marks an A to B to A collection stale and never stores its potentially mixed facts", async () => {
    const clock = new ManualClock();
    let login = "old";
    const cache = makeCache(clock, () => login);
    let finish!: (value: string) => void;
    const key = { repository: "o/r", collector: "c", coverage: { n: 1 } };
    const slow = cache.track(false, () =>
      cache.read(
        key,
        () =>
          new Promise<string>((done) => {
            finish = done;
          }),
      ),
    );
    await until(() => finish !== undefined);
    clock.advance(301_000);
    login = "new";
    await cache.verifiedAuth(false);
    clock.advance(301_000);
    login = "old";
    await cache.verifiedAuth(false);
    finish("potentially-mixed");
    const observed = await slow;
    expect(observed.freshness[0]).toMatchObject({
      source: "stale",
      stale: true,
      refreshError: { code: "CACHE_INVALIDATED" },
    });
    expect(cache.status().entries).toBe(0);
    expect(await cache.read(key, async () => "fresh-as-old")).toBe("fresh-as-old");
    cache.close();
  });

  it.each([undefined, "o/r"])(
    "does not adopt a manual refresh during login verification (%s)",
    async (repository) => {
      const clock = new ManualClock();
      let checking = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cache = new ServeCache({
        ttlMs: 300_000,
        clock,
        initialAuth: { host: "h", login: "old" },
        authContext: async () => {
          checking = true;
          await gate;
          return { host: "h", login: "new" };
        },
      });
      clock.advance(301_000);
      const read = cache.track(false, () =>
        cache.read({ repository: "o/r", collector: "c", coverage: {} }, async () => "fresh-as-new"),
      );
      await until(() => checking);
      cache.refresh(repository);
      release();
      expect((await read).freshness[0]).toMatchObject({
        source: "stale",
        refreshError: { code: "CACHE_INVALIDATED" },
      });
      expect(cache.status().entries).toBe(0);
      cache.close();
    },
  );

  it("a queued read does not start once a rate-limit cooldown has begun", async () => {
    const clock = new ManualClock();
    const cache = makeCache(clock, () => "old", 1);
    let fail!: (error: unknown) => void;
    const first = cache.read(
      { repository: "o/r", collector: "c", coverage: { n: 1 } },
      () => new Promise<string>((_done, reject) => (fail = reject)),
    );
    let started = false;
    const queued = cache.read(
      { repository: "o/r", collector: "c", coverage: { n: 2 } },
      async () => {
        started = true;
        return "never";
      },
    );
    await until(() => fail !== undefined);
    fail(new RateLimitError("rate limited", { retryAfterSeconds: 60 }));
    await expect(first).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    await expect(queued).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    expect(started).toBe(false);
    cache.close();
  });

  it("one cancelled caller does not fail another collection's shared login check", async () => {
    const clock = new ManualClock();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: async () => {
        await gate;
        return { host: "h", login: "old" };
      },
      initialAuth: { host: "h", login: "old" },
    });
    clock.advance(301_000);
    const a = new AbortController();
    const cancelled = cache.read(
      { repository: "o/r", collector: "c", coverage: { n: 1 } },
      async () => "a",
      a.signal,
    );
    const kept = cache.read(
      { repository: "o/r", collector: "c", coverage: { n: 2 } },
      async () => "b",
    );
    a.abort();
    await expect(cancelled).rejects.toThrow();
    release();
    expect(await kept).toBe("b");
    cache.close();
  });

  it("an already cancelled read never starts a collection", async () => {
    const cache = makeCache(new ManualClock(), () => "old");
    const gone = new AbortController();
    gone.abort();
    let started = false;
    await expect(
      cache.read(
        { repository: "o/r", collector: "c", coverage: {} },
        async () => {
          started = true;
          return "x";
        },
        gone.signal,
      ),
    ).rejects.toThrow();
    expect(started).toBe(false);
    expect(cache.status()).toMatchObject({ entries: 0, inflight: 0, misses: 0 });
    cache.close();
  });

  it("after a refresh, new reads never join a collection that started before it", async () => {
    const cache = makeCache(new ManualClock(), () => "old");
    const key = { repository: "o/r", collector: "c", coverage: {} };
    let finishOld!: (value: string) => void;
    const before = cache.read(key, () => new Promise<string>((done) => (finishOld = done)));
    await until(() => finishOld !== undefined);
    cache.refresh("o/r");
    let produced = 0;
    const after = cache.read(key, async () => {
      produced++;
      return "after-refresh";
    });
    expect(await after).toBe("after-refresh");
    expect(produced).toBe(1);
    finishOld("before-refresh");
    expect(await before).toBe("before-refresh");
    // The post-refresh result is the one cached.
    expect(await cache.read(key, async () => "unused")).toBe("after-refresh");
    cache.close();
  });

  it("a refresh during a collection keeps that result out of the cache", async () => {
    const clock = new ManualClock();
    const cache = makeCache(clock, () => "old");
    let finish!: (value: string) => void;
    const key = { repository: "o/r", collector: "c", coverage: {} };
    const pending = cache.track(false, () =>
      cache.read(key, () => new Promise<string>((done) => (finish = done))),
    );
    await until(() => finish !== undefined);
    expect(cache.refresh("o/r")).toBe(0);
    finish("before-refresh");
    expect(await pending).toMatchObject({
      value: "before-refresh",
      freshness: [{ source: "stale", stale: true, refreshError: { code: "CACHE_INVALIDATED" } }],
    });
    expect(cache.status().entries).toBe(0);
    cache.close();
  });
});

describe("pdb serve cache: only definitive values, nothing outlives close (#373 review)", () => {
  const fresh = (
    clock = new ManualClock(),
    auth?: (signal?: AbortSignal) => Promise<{ host: string; login: string }>,
  ) =>
    new ServeCache({
      ttlMs: 300_000,
      clock,
      authContext: auth ?? (async () => ({ host: "h", login: "l" })),
      initialAuth: { host: "h", login: "l" },
    });

  it("memoises only definitive REST answers", async () => {
    for (const status of [200, 204, 404, 410])
      expect(definitiveRest({ status, body: null })).toBe(true);
    for (const status of [null, 403, 429, 500, 502, 503])
      expect(definitiveRest({ status, body: null }), String(status)).toBe(false);
    const cache = fresh();
    const key = { repository: "o/r", collector: "c", coverage: {} };
    let calls = 0;
    const answers = [503, 429, 200];
    await cache.track(false, async () => {
      await cache.read(key, async () => "snapshot");
      for (let i = 0; i < 4; i++)
        await cache.memo(
          "rest\u0000p",
          async () => ({ status: answers[Math.min(calls++, 2)]!, body: null }),
          definitiveRest,
        );
    });
    // 503 and 429 were retried; 200 was kept, so the fourth call used it.
    expect(calls).toBe(3);
    cache.close();
  });

  it("memoised reads leave no abort listeners behind on the cache lifetime", async () => {
    const cache = fresh();
    const key = { repository: "o/r", collector: "c", coverage: {} };
    const baseline = cache.lifetimeListeners();
    await cache.track(false, async () => {
      await cache.read(key, async () => "snapshot");
      for (let i = 0; i < 500; i++) {
        // Distinct keys: every one is a miss; failures and non-definitive answers too.
        await cache.memo(`q${i}`, async () => ({ status: 200, body: i }), definitiveRest);
        await cache.memo(`r${i}`, async () => ({ status: 503, body: i }), definitiveRest);
        await cache
          .memo(
            `e${i}`,
            async () => Promise.reject(new Error("gh failed")),
            () => true,
          )
          .catch(() => undefined);
      }
    });
    expect(cache.lifetimeListeners()).toBe(baseline);
    // Collections and their waiters clean up too.
    const signal = new AbortController().signal;
    const { getEventListeners } = await import("node:events");
    for (let i = 0; i < 200; i++)
      await cache.read({ ...key, coverage: { n: i } }, async () => i, signal);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(cache.lifetimeListeners()).toBe(baseline);
    cache.close();
  });

  it("does not store a value its producer marks as not definitive", async () => {
    const cache = fresh();
    const key = { repository: "o/r", collector: "pr", coverage: { n: 1 } };
    let produced = 0;
    const incomplete = async () => ({ complete: (++produced, false) });
    await cache.read(key, incomplete, undefined, (v) => v.complete);
    await cache.read(key, incomplete, undefined, (v) => v.complete);
    expect(produced).toBe(2);
    expect(cache.status().entries).toBe(0);
    cache.close();
  });

  it("close() cancels the shared login check, so shutdown never waits on GitHub", async () => {
    const clock = new ManualClock();
    let seen: AbortSignal | undefined;
    const cache = fresh(clock, (signal?: AbortSignal) => {
      seen = signal;
      return new Promise((_done, fail) =>
        signal?.addEventListener("abort", () => fail(new Error("aborted"))),
      );
    });
    clock.advance(301_000);
    const pending = cache.read(
      { repository: "o/r", collector: "c", coverage: {} },
      async () => "x",
    );
    await until(() => seen !== undefined);
    cache.close();
    expect(seen!.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
  });

  it("close() aborts queued and refresh-replaced collections and pending memoised reads", async () => {
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock: new ManualClock(),
      authContext: async () => ({ host: "h", login: "l" }),
      initialAuth: { host: "h", login: "l" },
      maxConcurrent: 1,
    });
    const signals: AbortSignal[] = [];
    const hang = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>((_done, fail) =>
        signal.addEventListener("abort", () => fail(new Error("aborted"))),
      );
    };
    const key = { repository: "o/r", collector: "c", coverage: {} };
    const first = cache.read(key, hang);
    await until(() => signals.length === 1);
    // A refresh=true read replaces the in-flight entry; the first collection must still stop.
    const replaced = cache.track(true, () => cache.read(key, hang));
    let queuedRan = false;
    const queued = cache.read({ ...key, coverage: { n: 2 } }, async () => {
      queuedRan = true;
      return "late";
    });
    let memoStarted = false;
    cache.close();
    await expect(first).rejects.toThrow();
    await expect(replaced).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    expect(queuedRan).toBe(false);
    expect(signals.every((s) => s.aborted)).toBe(true);
    // A memoised read pending at close is rejected immediately.
    const open = fresh();
    const pendingMemo = open.track(false, async () => {
      await open.read({ repository: "o/r", collector: "c", coverage: {} }, async () => "s");
      memoStarted = true;
      return open.memo(
        "q",
        () => new Promise<string>(() => undefined),
        () => true,
      );
    });
    await until(() => memoStarted);
    open.close();
    await expect(pendingMemo).rejects.toThrow();
    expect(open.status().inflight).toBe(0);
  });
});

describe("pdb serve failure behaviour (#373)", () => {
  /** A collector that fails while `failing` is set. */
  function flaky() {
    const state = {
      failing: false,
      error: new Error("gh exited 1: secret stderr /home/me/x") as unknown,
    };
    const fn: ServeReadRuntime["collect"] = async (repository, options) => {
      if (state.failing) throw state.error;
      return collect(repository, options, query, () => new Date(start));
    };
    return { state, fn };
  }

  it("errors without a previous entry; serves stale within 30 minutes; errors after", async () => {
    const f = flaky();
    const s = await setup(["--repo", repo], { collect: f.fn });
    try {
      f.state.failing = true;
      const none = await call(s.running.port, "/api/v1/briefing");
      expect(none.status).toBe(502);
      expect(none.json).toMatchObject({
        status: "error",
        result: null,
        freshness: null,
        error: { code: "GITHUB_UNAVAILABLE", next: [`pdb --repo ${repo} --json`] },
      });
      expect(none.body).not.toContain("secret stderr");
      expect(none.body).not.toContain("/home/me");
      f.state.failing = false;
      await call(s.running.port, "/api/v1/briefing");
      f.state.failing = true;
      s.clock.advance(20 * 60_000);
      const stale = await call(s.running.port, "/api/v1/briefing");
      expect(stale.status).toBe(200);
      expect(stale.json).toMatchObject({
        status: "incomplete",
        freshness: {
          source: "stale",
          stale: true,
          ageSeconds: 1200,
          observedAt: new Date(start).toISOString(),
          refreshError: { code: "GITHUB_UNAVAILABLE" },
        },
      });
      expect(stale.json.warnings[0]).toContain("facts may have changed");
      s.clock.advance(11 * 60_000);
      const gone = await call(s.running.port, "/api/v1/briefing");
      expect(gone.status).toBe(502);
      // Failures are not cached: the next request tries again.
      f.state.failing = false;
      expect((await call(s.running.port, "/api/v1/briefing")).json.freshness.source).toBe("live");
      const status = await call(s.running.port, "/api/v1/status");
      expect(status.json.repositories[0].lastError).toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    } finally {
      await s.close();
    }
  });

  it("a failing refresh=true keeps the last good result", async () => {
    const f = flaky();
    const s = await setup(["--repo", repo], { collect: f.fn });
    try {
      await call(s.running.port, "/api/v1/briefing");
      f.state.failing = true;
      const refreshed = await call(s.running.port, "/api/v1/briefing?refresh=true");
      expect(refreshed.status).toBe(200);
      expect(refreshed.json.freshness).toMatchObject({ source: "stale", ageSeconds: 0 });
      f.state.failing = false;
      expect((await call(s.running.port, "/api/v1/briefing")).json.freshness.source).toBe("cached");
    } finally {
      await s.close();
    }
  });

  it("a rate limit refuses live collections until reset, with Retry-After", async () => {
    const f = flaky();
    f.state.error = new RateLimitError("gh api graphql was rate limited by GitHub.", {
      retryAfterSeconds: 120,
    });
    const s = await setup(["--repo", repo], { collect: f.fn });
    try {
      f.state.failing = true;
      const first = await call(s.running.port, "/api/v1/team");
      expect(first.status).toBe(502);
      expect(first.json.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(first.headers["retry-after"]).toBe("120");
      f.state.failing = false;
      const during = await call(s.running.port, "/api/v1/briefing");
      expect(during.json.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(s.calls.collect).toHaveLength(1);
      s.clock.advance(121_000);
      expect((await call(s.running.port, "/api/v1/briefing")).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it("who stopped by a linked-PR quota refusal starts the cooldown and is not cached", async () => {
    let focused = 0;
    const s = await setup(["--repo", repo], {
      // A linked-PR read refused for quota: the focused read returns, incomplete, instead of
      // throwing (#367), so only its collection's quota signal reaches serve.
      collectIssueFocus: async (repository, number, options) => {
        focused++;
        // The ticket is read, then its linked PR's read is refused for quota.
        const snapshot = await collectIssueFocus(
          repository,
          number,
          options,
          query,
          () => new Date(start),
        );
        await options.meter
          .query(
            async () => {
              throw new RateLimitError("rate limited", { retryAfterSeconds: 120 });
            },
            "pull-request",
            `${repository}#9`,
          )("query{x}", {})
          .catch(() => undefined);
        options.meter.notAttempted.push(`https://github.com/${repository}/pull/9`);
        return snapshot;
      },
    });
    try {
      const first = await call(s.running.port, "/api/v1/issues/1/who");
      expect(first.status).toBe(200);
      expect(first.json.status).toBe("incomplete");
      expect(first.json.result.collection.quota).toEqual({
        retryAfterSeconds: 120,
        resetAt: null,
      });
      // The cooldown is in force for every live read, as after a thrown RateLimitError.
      const during = await call(s.running.port, "/api/v1/briefing");
      expect(during.json.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(during.headers["retry-after"]).toBe("120");
      expect(s.calls.collect).toHaveLength(0);
      s.clock.advance(121_000);
      // The incomplete answer was not cached as fresh: the next who read runs again.
      const after = await call(s.running.port, "/api/v1/issues/1/who");
      expect(after.json.freshness.source).not.toBe("cached");
      expect(focused).toBe(2);
    } finally {
      await s.close();
    }
  });

  it("a deps tree stopped by a quota refusal starts the cooldown and is not cached (#196)", async () => {
    const { query: base, calls } = graphQuery({
      edges: Array.from({ length: 6 }, (_, i): [number, number] => [10 + i, 1]),
    });
    let sent = 0;
    const refusing: Query = async (source, variables) => {
      if (++sent === 3) throw new RateLimitError("rate limited", { retryAfterSeconds: 90 });
      return base(source, variables);
    };
    const s = await setup(["--repo", fakeRepo], {
      dependencyReport: (repository, number, options) =>
        dependencyReport(repository, number, options, refusing),
    });
    try {
      const first = await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(first.status).toBe(200);
      expect(first.json.status).toBe("incomplete");
      expect(first.json.result.treeBounds).toMatchObject({ complete: false, stoppedBy: "quota" });
      expect(first.json.result.collection.quota).toEqual({
        retryAfterSeconds: 90,
        resetAt: null,
      });
      // The shared cooldown is in force for every live read.
      const during = await call(s.running.port, "/api/v1/briefing");
      expect(during.json.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(during.headers["retry-after"]).toBe("90");
      expect(s.calls.collect).toHaveLength(0);
      s.clock.advance(91_000);
      // Not cached: the next tree read runs live again.
      const before = calls.length;
      const after = await call(s.running.port, "/api/v1/issues/1/deps?tree=true");
      expect(after.json.freshness.source).not.toBe("cached");
      expect(calls.length).toBeGreaterThan(before);
    } finally {
      await s.close();
    }
  });

  it("an incomplete collection is cached and served as incomplete", async () => {
    const s = await setup(["--repo", repo], {
      collect: async (repository, options) => ({
        ...(await collect(repository, options, query, () => new Date(start))),
        warnings: ["Issue list truncated at 1000."],
      }),
    });
    try {
      const first = await call(s.running.port, "/api/v1/briefing");
      expect(first.json.status).toBe("incomplete");
      const second = await call(s.running.port, "/api/v1/briefing");
      expect(second.json).toMatchObject({ status: "incomplete", freshness: { source: "cached" } });
    } finally {
      await s.close();
    }
  });
});

describe("pdb serve cancellation (#373)", () => {
  it("one cancelled waiter leaves the other's result intact; the last one aborts the collector", async () => {
    const cache = new ServeCache({
      ttlMs: 300_000,
      clock: new ManualClock(),
      authContext: async () => ({ host: "h", login: "l" }),
      initialAuth: { host: "h", login: "l" },
    });
    const key = { repository: "o/r", collector: "c", coverage: {} };
    let collectorSignal!: AbortSignal;
    let finish!: (value: string) => void;
    const produce = (signal: AbortSignal) => {
      collectorSignal = signal;
      return new Promise<string>((done) => (finish = done));
    };
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.read(key, produce, a.signal);
    const second = cache.read(key, produce, b.signal);
    await until(() => collectorSignal !== undefined);
    a.abort();
    await expect(first).rejects.toThrow();
    expect(collectorSignal.aborted).toBe(false);
    finish("facts");
    expect(await second).toBe("facts");
    // Now the last waiter leaves: the shared collection is aborted.
    const c = new AbortController();
    const third = cache.read({ ...key, coverage: { n: 2 } }, produce, c.signal);
    await until(() => !collectorSignal.aborted && cache.status().inflight === 1);
    c.abort();
    await expect(third).rejects.toThrow();
    expect(collectorSignal.aborted).toBe(true);
    expect(cache.status().inflight).toBe(0);
    cache.close();
  });

  it("shutdown aborts in-flight collections and completes", async () => {
    let collectorSignal: AbortSignal | undefined;
    const s = await setup(["--repo", repo], {
      collect: (_repository, options) =>
        new Promise((_done, fail) => {
          collectorSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => fail(new Error("aborted")));
        }),
    });
    const pending = call(s.running.port, "/api/v1/briefing").catch((error: unknown) => error);
    await until(() => collectorSignal !== undefined);
    await s.close();
    expect(collectorSignal!.aborted).toBe(true);
    // The open request was cut off, never answered as a complete result.
    const outcome = await pending;
    expect(outcome instanceof Error || (outcome as Reply).status !== 200).toBe(true);
  });
});

describe("pdb serve pull-request reads (#373)", () => {
  it("caches the whole PR report per number and history flag; failures name the CLI command", async () => {
    let calls = 0;
    let failing = true;
    const s = await setup(["--repo", repo], {
      queryWith: () => async () => {
        calls++;
        if (failing) throw new Error("gh: HTTP 502");
        throw new Error("unreachable");
      },
    });
    try {
      const reply = await call(s.running.port, "/api/v1/prs/5?history=true");
      expect(reply.status).toBe(502);
      expect(reply.json).toMatchObject({
        view: "pull-request",
        status: "error",
        error: { code: "GITHUB_UNAVAILABLE", next: [`pdb pr 5 --repo ${repo} --json`] },
      });
      expect(calls).toBeGreaterThan(0);
      const invalid = await call(s.running.port, "/api/v1/prs/5?history=maybe");
      expect(invalid.status).toBe(400);
      expect(invalid.json).toMatchObject({
        kind: "serve-read",
        view: "pull-request",
        status: "error",
        selection: { repository: repo },
        error: { code: "INVALID_ARGUMENT" },
      });
    } finally {
      await s.close();
    }
  });
});

describe("pdb serve output hygiene (#373)", () => {
  it("never returns token-like or local path strings", async () => {
    const sentinel = "ghp_SENTINEL0000000000000000000000000000";
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = sentinel;
    const project = resolve("/work/sentinel-project-path");
    const s = await setup(["--project", project]);
    try {
      const bodies: string[] = [];
      for (const path of [
        "/",
        "/healthz",
        "/api/v1/status",
        "/api/v1/briefing?agent=me&role=implementer",
        "/api/v1/issues/1",
        "/api/v1/issues/1/who",
        "/api/v1/issues/1/deps",
        "/api/v1/team",
        "/api/v1/nope",
        "/api/v1/briefing?repo=other/one",
      ])
        bodies.push((await call(s.running.port, path)).body);
      const all = bodies.join("\n");
      expect(all).not.toContain(sentinel);
      expect(all).not.toContain(project);
      expect(all).not.toContain("sentinel-project-path");
      expect(all).not.toContain(process.cwd());
    } finally {
      await s.close();
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}

void ({} as Snapshot);

describe("pdb serve ticket detail (#454)", () => {
  // The fixture's GraphQL plus the closing-reference list the ticket service reads (none).
  let ticketReads = 0;
  const ticketQuery: Query = async (source, variables) => {
    ticketReads++;
    const answer = (await query(source, variables)) as { repository: Record<string, unknown> };
    // The ticket's closing references (none), open or closed, are read in full.
    if (source.includes("issue(number"))
      answer.repository.issue = {
        ...(answer.repository.issue as object),
        closedByPullRequestsReferences: page([]),
      };
    return answer;
  };
  const ticketWorld = () => ({
    queryWith: () => ticketQuery,
    rest: ticketRest,
    collectIssueFocus: ((repository, number, options) =>
      collectIssueFocus(
        repository,
        number,
        options,
        ticketQuery,
        () => new Date(start),
      )) as ServeReadRuntime["collectIssueFocus"],
  });
  // Record authors' permissions are known, so delivery records are evaluated, not skipped.
  const ticketRest: ServeReadRuntime["rest"] = async (path) =>
    path.includes("/collaborators/")
      ? { status: 200, body: { user: { login: "writer" }, role_name: "write" } }
      : { status: 404, body: null };

  it("serves the shared service's ticket-status document unchanged, as the CLI prints it", async () => {
    const s = await setup(["--repo", repo], ticketWorld());
    try {
      const reply = await call(s.running.port, "/api/v1/tickets/1?agent=me");
      expect(reply.status).toBe(200);
      expect(Object.keys(reply.json)).toEqual(envelopeKeys);
      expect(reply.json).toMatchObject({
        view: "ticket",
        selection: { repository: repo, agent: "me" },
        result: { kind: "ticket-status", schemaVersion: 1, number: 1 },
      });
      let out = "";
      await main(
        ["ticket", "1", "--agent", "me", "--repo", repo, "--json", "--no-update-check"],
        async (text) => void (out += text),
        {
          collectIssueFocus: ticketWorld().collectIssueFocus,
          query: ticketQuery,
          rest: ticketRest,
          currentRepository: async () => repo,
          now: () => new Date(start),
          updateCheck: async () => ({ status: "disabled" }) as never,
        } as never,
      );
      const cli = JSON.parse(out) as Record<string, any>;
      expect(timeless(reply.json.result)).toEqual(timeless(cli));
      // The envelope status follows the document's own completeness, never the page's guess.
      expect(cli.completeness.warnings).toEqual([]);
      expect(cli.completeness.complete).toBe(true);
      expect(reply.json.status).toBe("complete");
      // The page projects the shared service's evidence, not its own interpretation.
      const html = ticketRenderers().renderTicket(reply.json);
      expect(html).toContain(`#1 ${String(cli.title)}`);
      expect(html).toContain(`data-delivery="${String(cli.delivery.verdict)}"`);
      expect(html).toContain(String(cli.ownership.answer));
      expect(html).toContain(String(cli.links.intake));
      expect(html).toContain("not proof that none exists");
    } finally {
      await s.close();
    }
  });

  it("caches the whole result per ticket and selection; refresh=true reads live again", async () => {
    const s = await setup(["--repo", repo], ticketWorld());
    try {
      await call(s.running.port, "/api/v1/tickets/1");
      const reads = ticketReads;
      const second = await call(s.running.port, "/api/v1/tickets/1");
      expect(second.json.status).toBe("complete");
      expect(second.json.freshness.source).toBe("cached");
      expect(ticketReads).toBe(reads);
      const fresh = await call(s.running.port, "/api/v1/tickets/1?refresh=true");
      expect(fresh.json.freshness.source).toBe("live");
      expect(ticketReads).toBeGreaterThan(reads);
      // The refresh scope evicts ticket results.
      const evicted = await call(s.running.port, "/api/v1/refresh", {
        method: "POST",
        body: JSON.stringify({ scope: "tickets" }),
        headers: { "content-type": "application/json" },
      });
      expect(evicted.json).toMatchObject({ kind: "serve-refresh", scope: "tickets" });
    } finally {
      await s.close();
    }
  });

  it("rejects bad arguments and unserved repositories before any read", async () => {
    let focused = 0;
    const s = await setup(["--repo", repo], {
      queryWith: () => ticketQuery,
      collectIssueFocus: async (...args) => {
        focused++;
        return collectIssueFocus(args[0], args[1], args[2], ticketQuery, () => new Date(start));
      },
    });
    try {
      for (const [path, code] of [
        ["/api/v1/tickets/1?repo=someone/else", "REPOSITORY_NOT_SERVED"],
        ["/api/v1/tickets/1?bogus=1", "INVALID_ARGUMENT"],
        ["/api/v1/tickets/1?agent=me&agent=you", "INVALID_ARGUMENT"],
        ["/api/v1/tickets/1?limitPrs=0", "INVALID_ARGUMENT"],
        ["/api/v1/tickets/1?platform=%3Cx%3E", "INVALID_ARGUMENT"],
        ["/api/v1/tickets/1?agent=%3Cscript%3E", "INVALID_ARGUMENT"],
      ] as const) {
        const reply = await call(s.running.port, path);
        expect(reply.json.error?.code, path).toBe(code);
        expect(reply.json.view, path).toBe("ticket");
      }
      expect((await call(s.running.port, "/api/v1/tickets/0")).status).toBe(404);
      expect(focused).toBe(0);
    } finally {
      await s.close();
    }
  });

  it("keeps a missing and an inaccessible ticket distinct, never a server error", async () => {
    for (const state of ["missing", "forbidden"] as const) {
      const s = await setup(["--repo", repo], {
        queryWith: () => ticketQuery,
        collectIssueFocus: async () => {
          throw new IssueUnavailable({
            repository: repo,
            number: 7,
            url: url(7),
            state,
            detail: `It is ${state}.`,
            next: "gh issue view 7",
          });
        },
      });
      try {
        const reply = await call(s.running.port, "/api/v1/tickets/7");
        expect(reply.status).toBe(200);
        expect(reply.json).toMatchObject({
          view: "ticket",
          status: "incomplete",
          result: { kind: "issue-unavailable", state },
        });
      } finally {
        await s.close();
      }
    }
  });

  it("a quota refusal the read stopped on starts the cooldown and is not cached", async () => {
    let focused = 0;
    const s = await setup(["--repo", repo], {
      queryWith: () => ticketQuery,
      collectIssueFocus: async (repository, number, options) => {
        focused++;
        const snapshot = await collectIssueFocus(
          repository,
          number,
          options,
          ticketQuery,
          () => new Date(start),
        );
        await options.meter
          .query(
            async () => {
              throw new RateLimitError("rate limited", { retryAfterSeconds: 120 });
            },
            "pull-request",
            `${repository}#9`,
          )("query{x}", {})
          .catch(() => undefined);
        return snapshot;
      },
    });
    try {
      const first = await call(s.running.port, "/api/v1/tickets/1");
      expect(first.status).toBe(200);
      expect(first.json.status).toBe("incomplete");
      expect(first.json.result.collection.quota).toEqual({
        retryAfterSeconds: 120,
        resetAt: null,
      });
      const during = await call(s.running.port, "/api/v1/briefing");
      expect(during.json.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(during.headers["retry-after"]).toBe("120");
      s.clock.advance(121_000);
      const after = await call(s.running.port, "/api/v1/tickets/1");
      expect(after.json.freshness.source).not.toBe("cached");
      expect(focused).toBe(2);
    } finally {
      await s.close();
    }
  });

  it("serves the ticket page under the dashboard policy, with Host and Origin guarded", async () => {
    const s = await setup(["--repo", repo], ticketWorld());
    const port = s.running.port;
    const before = ticketReads;
    try {
      const page = await call(port, "/ticket?repo=example%2Fparity&n=1&agent=me");
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(page.body).toContain('<script src="/ticket.js" defer></script>');
      expect((await call(port, "/ticket.js")).headers["content-type"]).toContain("javascript");
      expect((await call(port, "/ticket?evil=1")).status).toBe(400);
      expect((await call(port, "/ticket.js?repo=x")).status).toBe(400);
      expect((await call(port, "/ticket", { headers: { host: "evil.example" } })).status).toBe(421);
      expect(
        (await call(port, "/api/v1/tickets/1", { headers: { origin: "http://evil.example" } }))
          .status,
      ).toBe(403);
      // Opening the page reads nothing from GitHub: the browser asks for the ticket itself.
      expect(ticketReads).toBe(before);
    } finally {
      await s.close();
    }
  });
});

describe("pipeline metrics endpoint (#573 slice 5b)", () => {
  // Clock: 2026-11-12T10:00Z. One quiet issue and one standalone merged PR on the 11th.
  const metricsQuery = (counter: { n: number }) => () => async (q: string) => {
    counter.n++;
    if (q.includes("states:[OPEN]"))
      return {
        repository: {
          issues: {
            nodes: [
              {
                number: 8,
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-02T00:00:00Z",
                lastEditedAt: null,
                state: "OPEN",
                closedAt: null,
                stateReason: null,
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { totalCount: 0, nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    if (q.includes("issues(first:50"))
      return {
        repository: {
          issues: {
            nodes: [
              {
                number: 3,
                createdAt: "2026-11-01T00:00:00Z",
                updatedAt: "2026-11-11T09:00:00Z",
                lastEditedAt: null,
                state: "OPEN",
                closedAt: null,
                stateReason: null,
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { totalCount: 0, nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    if (q.includes("pullRequests(first:50"))
      return {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 40,
                updatedAt: "2026-11-11T08:00:00Z",
                mergedAt: "2026-11-11T08:00:00Z",
                closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    if (q.includes("timelineItems"))
      return {
        repository: {
          issue: {
            timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
          },
        },
      };
    return { repository: null };
  };

  it("serves the daily view with walked merges and caches the read for the window", async () => {
    const counter = { n: 0 };
    const s = await setup(["--repo", repo], {
      queryWith: metricsQuery(counter) as never,
      rest: (async () => null) as never,
    });
    try {
      const reply = await call(s.running.port, "/api/v1/metrics?view=daily&days=7");
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ view: "metrics", status: "complete" });
      const result = reply.json.result;
      expect(result).toMatchObject({ kind: "pipeline-metrics", view: "daily", days: 7 });
      const day = result.figures.prMerges.series.days.find(
        (d: { day: string }) => d.day === "2026-11-11",
      );
      expect(day).toMatchObject({ status: "known", count: 1, members: [`${repo}#40`] });
      expect(result.limitations.join(" ")).toMatch(/another repository/);
      const before = counter.n;
      // The timing view for the same window reuses the cached read.
      const timing = await call(s.running.port, "/api/v1/metrics?view=timing&days=7");
      expect(timing.json.result).toMatchObject({
        view: "timing",
        groupBasis: "latest-valid-complexity",
      });
      // The quiet open ticket from the open inventory is part of the read, not missing.
      expect(timing.json.result.historyNotRead).toMatchObject({ count: 0 });
      expect(counter.n).toBe(before);
      // The inventory view for the same 7-day cache entry reuses the cached read too.
      const inventory = await call(
        s.running.port,
        "/api/v1/metrics?view=inventory&stalledHours=24",
      );
      expect(inventory.status).toBe(200);
      expect(inventory.json.result).toMatchObject({
        view: "inventory",
        cohort: "current-open-inventory",
        totalOpen: 2,
        stalled: { thresholdHours: 24 },
      });
      // The assessment-queue view for the same window also reuses the cached read.
      const aq = await call(s.running.port, "/api/v1/metrics?view=assessment-queue&days=7");
      expect(aq.status).toBe(200);
      expect(aq.json.result).toMatchObject({
        view: "assessment-queue",
        days: 7,
      });
      expect(aq.json.result.metrics.complexity.unassessed.count).toBeTypeOf("number");
      expect(aq.json.result.metrics.impact.unassessed.count).toBeTypeOf("number");
      expect(counter.n).toBe(before);
    } finally {
      await s.close();
    }
  });

  it("rejects unsupported views and window sizes before any GitHub read", async () => {
    const counter = { n: 0 };
    const s = await setup(["--repo", repo], {
      queryWith: metricsQuery(counter) as never,
      rest: (async () => null) as never,
    });
    try {
      for (const path of [
        "/api/v1/metrics?view=sankey",
        "/api/v1/metrics?view=daily&days=14",
        "/api/v1/metrics?view=news&hours=3",
        "/api/v1/metrics?view=news&days=7",
      ]) {
        const reply = await call(s.running.port, path);
        expect([path, reply.status, reply.json.error?.code]).toEqual([
          path,
          400,
          "INVALID_ARGUMENT",
        ]);
      }
      expect(counter.n).toBe(0);
      const news = await call(s.running.port, "/api/v1/metrics?view=news&hours=6");
      expect(news.json.result).toMatchObject({ view: "news" });
    } finally {
      await s.close();
    }
  });
  it("labels a read with per-ticket gaps incomplete and does not cache it", async () => {
    const counter = { n: 0 };
    const base = metricsQuery(counter)();
    const s = await setup(["--repo", repo], {
      // The one issue has more comments than the first page: its evidence is partial.
      queryWith: (() => async (q: string) => {
        const r = (await base(q)) as {
          repository?: { issues?: { nodes: { comments: { totalCount: number } }[] } };
        };
        if (q.includes("issues(first:50"))
          r.repository!.issues!.nodes[0]!.comments.totalCount = 150;
        return r;
      }) as never,
      rest: (async () => null) as never,
    });
    try {
      const first = await call(s.running.port, "/api/v1/metrics?view=daily");
      expect(first.json.status).toBe("incomplete");
      const before = counter.n;
      await call(s.running.port, "/api/v1/metrics?view=daily");
      expect(counter.n).toBeGreaterThan(before);
    } finally {
      await s.close();
    }
  });

  it("applies a live saved configuration to the running server and repoints selection (#808)", async () => {
    // A verified global configuration boundary: the config file starts with one registered
    // repository; the live application adds and removes registrations.
    const dir = resolve("/global");
    const configText = (projects: string) =>
      `schemaVersion = 1\n\n[serve]\nprojects = [${projects}]\n`;
    const files = new Map<string, string>([
      [join(dir, "config.toml"), configText('{ repository = "owner/a" }')],
    ]);
    const fs: ConfigFileSystem = {
      readText: async (path) => files.get(path) ?? null,
      writeText: async (path, text) => void files.set(path, text),
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const clock = new ManualClock();
    const read: ServeReadRuntime = {
      collect: (async () => {
        throw new Error("no GitHub reader in this live-application test");
      }) as never,
      dependencyReport: (async () => {
        throw new Error("no GitHub reader in this live-application test");
      }) as never,
      now: () => clock.now(),
      env: {},
    };
    const serve: ServeRuntime = {
      cwd: "/not/a/checkout",
      currentRepository: async () => "",
      authContext: async () => ({ host: "github.com", login: "octo" }),
      clock,
      stdout: () => undefined,
      stderr: () => undefined,
      signals: new EventEmitter(),
      exit: () => undefined,
      version: async () => "9.9.9",
      platform: "linux",
      globalConfig: { dir, fs },
    };
    const running = await startServe(
      serveArguments(["--port", "0"]),
      serve,
      readServices(serveArguments(["--port", "0"]), serve, read),
    );
    try {
      // Startup served the saved registration only.
      expect(running.facts.served.map((s) => s.repository)).toEqual(["owner/a"]);

      // A live saved change: drop owner/a, add owner/b. The served set repoints and the
      // generation advances so reads for an obsolete context are rejected.
      await running.applyLiveConfiguration!({
        path: join(dir, "config.toml"),
        storedVersion: 1,
        explicit: new Map([["serve.projects", [{ host: "github.com", repository: "owner/b" }]]]),
        settings: [],
        raw: "schemaVersion = 1",
      } satisfies LoadedGlobalConfig);
      expect(running.facts.served.map((s) => s.repository)).toEqual(["owner/b"]);
      expect(running.facts.contextVersion!.value).toBe(1);

      // owner/a is no longer selectable: the API refuses it instead of serving stale facts.
      const obsolete = await call(running.port, "/api/v1/team?repo=owner/a");
      expect(obsolete.status).toBe(403);
      expect(obsolete.json.error?.code).toBe("REPOSITORY_NOT_SERVED");
    } finally {
      await running.close();
    }
  });
});
