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
import { collect, IssueUnavailable } from "../github/github.js";
import type { Query } from "../github/github.js";
import { RateLimitError } from "../github/dependencies.js";
import type { Issue, Page, Snapshot } from "../github/types.js";
import type { Clock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { RunningServer, ServeRuntime } from "../serve.js";
import { readServices } from "./api.js";
import { NO_PROJECT_ROOT, noLocalProject } from "./api.js";
import type { ServeReadRuntime } from "./api.js";
import { ServeCache } from "./cache.js";
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
    authContext?: ServeRuntime["authContext"];
    queryWith?: ServeReadRuntime["queryWith"];
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
    collect: (repository, options) => {
      calls.collect.push({ repository, options: { ...options, signal: undefined } });
      return (overrides.collect ?? base)(repository, options);
    },
    dependencyReport: async (repository, number, options) => {
      calls.deps++;
      return {
        schemaVersion: 1,
        kind: "dependencies",
        repository,
        number,
        tree: !!options?.tree,
      } as never;
    },
    queryWith: overrides.queryWith,
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

/** The CLI's --json output for the same flags and the same injected facts. */
async function cliJson(args: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await main(
    [...args, "--repo", repo, "--json", "--no-update-check"],
    async (text) => void (out += text),
    {
      collect: (repository, options) => collect(repository, options, query, () => new Date(start)),
      currentRepository: async () => repo,
      dependencyReport: async () => {
        throw new Error("not used");
      },
      estimation: { fs: files, git, cwd: root },
      guide: { fs: files, git, cwd: root },
      now: () => new Date(start),
      updateCheck: async () => ({ status: "disabled" }) as never,
    },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

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
          status: "complete",
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
        expect(reply.json.result).toEqual(cli);
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
      expect(issueReply.json.result).toEqual(await cliJson(["--issue", "1", "--agent", "me"]));
      const who = await call(s.running.port, "/api/v1/issues/1/who?staleHours=24");
      expect(who.json.view).toBe("who");
      expect(who.json.result).toEqual(await cliJson(["who", "1", "--stale-hours", "24"]));
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
    const git = readers.estimation!.git!;
    expect(await git(["rev-parse", "--show-toplevel"], NO_PROJECT_ROOT)).toBe(
      `${NO_PROJECT_ROOT}\n`,
    );
    expect(await git(["remote", "-v"], NO_PROJECT_ROOT)).toContain("github.com/owner/name.git");
    expect(await readers.guide!.fs!.readText(join(NO_PROJECT_ROOT, TOML_CONFIG_PATH))).toBeNull();
    await expect(readers.guide!.fs!.writeText("x", "y")).rejects.toThrow(/never writes/);
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
      expect(implementer.json.result).toEqual(
        await cliJson(["--agent", "me", "--role", "implementer"]),
      );
      expect(designer.json.result).toEqual(
        await cliJson(["--agent", "other", "--role", "designer"]),
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

  it("a refresh during a collection keeps that result out of the cache", async () => {
    const clock = new ManualClock();
    const cache = makeCache(clock, () => "old");
    let finish!: (value: string) => void;
    const key = { repository: "o/r", collector: "c", coverage: {} };
    const pending = cache.read(key, () => new Promise<string>((done) => (finish = done)));
    await until(() => finish !== undefined);
    expect(cache.refresh("o/r")).toBe(0);
    finish("before-refresh");
    expect(await pending).toBe("before-refresh");
    expect(cache.status().entries).toBe(0);
    cache.close();
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
