/**
 * Read-only diagnostics (#459, doc/design/serve-diagnostics-api.md), first slice: projects, cache
 * and inflight. Reads never collect, refresh or renew; rows carry only allowlisted fields.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import type { Issue, Page } from "../github/types.js";
import type { Clock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { serveArguments } from "./options.js";
import { RateLimitError } from "../github/dependencies.js";
import { classifyGhFailure, parseGhResponse } from "../github/evidence.js";
import { readServices } from "./services.js";

const start = Date.parse("2026-11-15T00:00:00.000Z");
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (repository: string, n: number): Issue => ({
  number: n,
  title: `Secret title ${n}`,
  body: "",
  url: `https://github.com/${repository}/issues/${n}`,
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-12T09:00:00.000Z",
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page([{ name: "status:ready" }]),
  comments: page([]),
});

class ManualClock implements Clock {
  time = start;
  now = () => new Date(this.time);
  setTimeout = () => ({});
  clearTimeout = () => undefined;
}

async function setup(repos = ["example/one"], gate?: Promise<void>, fail?: () => Error) {
  const clock = new ManualClock();
  const collects: string[] = [];
  const login = { current: "octo-secret-login", fail: null as Error | null };
  const serve: ServeRuntime = {
    currentRepository: async () => repos[0]!,
    authContext: async () => {
      if (login.fail) throw login.fail;
      return { host: "github.com", login: login.current };
    },
    clock,
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
  };
  const query =
    (repository: string): Query =>
    async (source) => ({
      repository: {
        issues: page(source.includes("issues(first") ? [issue(repository, 1)] : []),
        pullRequests: page([]),
      },
    });
  const read: ServeReadRuntime = {
    collect: async (repository, options) => {
      collects.push(`${repository}${options?.issue ? `#${options.issue}` : ""}`);
      if (gate) await gate;
      if (fail) throw fail();
      return collect(repository, options, query(repository), () => clock.now());
    },
    dependencyReport: async () => {
      throw new Error("unused");
    },
    now: () => clock.now(),
    env: {},
  };
  const options = serveArguments(["--port", "0", ...repos.flatMap((r) => ["--repo", r])]);
  const running = await startServe(options, serve, readServices(options, serve, read));
  const base = running.facts.url;
  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, text: await response.text() };
  };
  const json = async (path: string) => JSON.parse((await get(path)).text);
  return { running, clock, collects, get, json, login };
}

describe("serve diagnostics (#459)", () => {
  it("an empty service answers every view with zero GitHub calls, and status links them", async () => {
    const s = await setup(["example/one", "example/two"]);
    try {
      const status = await s.json("api/v1/status");
      expect(status.diagnostics).toEqual(
        ["projects", "config", "cache", "inflight", "errors", "rules"].map(
          (v) => `/api/v1/diagnostics/${v}`,
        ),
      );
      const projects = await s.json("api/v1/diagnostics/projects");
      expect(projects).toMatchObject({
        schemaVersion: 1,
        kind: "serve-diagnostics",
        view: "projects",
        observedAt: "2026-11-15T00:00:00.000Z",
        selection: { repository: null },
        coverage: { complete: true, warnings: [] },
        data: { total: 2, omitted: 0, nextCursor: null },
      });
      expect(projects.data.items).toEqual([
        {
          repository: "example/one",
          host: "github.com",
          default: false,
          hasLocalContext: false,
          registrationSource: "explicit",
        },
        {
          repository: "example/two",
          host: "github.com",
          default: false,
          hasLocalContext: false,
          registrationSource: "explicit",
        },
      ]);
      for (const view of ["cache", "inflight"])
        expect((await s.json(`api/v1/diagnostics/${view}?repo=example/one`)).data).toEqual({
          total: 0,
          omitted: 0,
          nextCursor: null,
          items: [],
        });
      expect(s.collects).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("shows held entries with allowlisted fields only, and reading never collects, renews or counts a hit", async () => {
    const s = await setup();
    try {
      await s.get("api/v1/briefing");
      await s.get("api/v1/briefing");
      expect(s.collects).toEqual(["example/one"]);
      const read = await s.get("api/v1/diagnostics/cache");
      const items = JSON.parse(read.text).data.items;
      expect(items).toHaveLength(1);
      expect(Object.keys(items[0]).sort()).toEqual(
        [
          "ageMs",
          "approxBytes",
          "collector",
          "expiresAt",
          "hits",
          "id",
          "observedAt",
          "options",
          "repository",
          "state",
          "subject",
        ].sort(),
      );
      expect(items[0]).toMatchObject({
        repository: "example/one",
        state: "fresh",
        hits: 1,
        subject: null,
        ageMs: 0,
      });
      // No payload, login, raw key or title ever leaves.
      for (const sentinel of ["Secret title", "octo-secret-login", "\\u0000"])
        expect(read.text).not.toContain(sentinel);
      s.clock.time += 10 * 60_000;
      const later = (await s.json("api/v1/diagnostics/cache")).data.items[0];
      expect(later).toMatchObject({ state: "stale-eligible", hits: 1, ageMs: 600_000 });
      expect(s.collects).toEqual(["example/one"]);
    } finally {
      await s.running.close();
    }
  });

  it("pages with cursors that expire when the listed state changes", async () => {
    const s = await setup();
    try {
      await s.get("api/v1/briefing");
      await s.get("api/v1/issues/1");
      const first = await s.json("api/v1/diagnostics/cache?limit=1");
      expect(first.data).toMatchObject({ total: 2, omitted: 1 });
      expect(first.data.items[0].subject).toBeNull();
      const cursor = first.data.nextCursor as string;
      const second = await s.json(`api/v1/diagnostics/cache?limit=1&cursor=${cursor}`);
      expect(second.data.items[0].subject).toBe(1);
      expect(second.data.nextCursor).toBeNull();
      // An evicted entry changes the inventory: the old cursor is refused, never merged.
      await s.get("api/v1/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "example/one", scope: "briefing" }),
      });
      const expired = await s.get(`api/v1/diagnostics/cache?limit=1&cursor=${cursor}`);
      expect(expired.status).toBe(409);
      expect(JSON.parse(expired.text).error.code).toBe("DIAGNOSTIC_CURSOR_EXPIRED");
    } finally {
      await s.running.close();
    }
  });

  it("refuses unknown, repeated and out-of-range parameters, other methods and unserved repositories", async () => {
    const s = await setup(["example/one", "example/two"]);
    try {
      const cases: [string, number][] = [
        ["api/v1/diagnostics/projects?debug=1", 400],
        ["api/v1/diagnostics/cache?repo=example/one&repo=example/two", 400],
        ["api/v1/diagnostics/cache?repo=example/one&limit=0", 400],
        ["api/v1/diagnostics/cache?repo=example/one&limit=101", 400],
        ["api/v1/diagnostics/cache?repo=example/one&cursor=%%%", 400],
        ["api/v1/diagnostics/cache?repo=example/one&cursor=abc", 400],
        ["api/v1/diagnostics/cache", 400],
        ["api/v1/diagnostics/cache?repo=someone/else", 403],
        ["api/v1/diagnostics/inflight?repo=owner/ghp_secretvalue", 403],
        ["api/v1/diagnostics/nothing", 404],
      ];
      for (const [path, status] of cases) expect((await s.get(path)).status, path).toBe(status);
      const post = await s.get("api/v1/diagnostics/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(post.status).toBe(405);
      // A secret-looking parameter value is never reflected.
      const unserved = await s.get("api/v1/diagnostics/cache?repo=owner/ghp_secretvalue");
      expect(unserved.text).not.toContain("ghp_secretvalue");
      expect(JSON.parse(unserved.text).error).toMatchObject({
        code: "REPOSITORY_NOT_SERVED",
        message: "That repository is not served by this server.",
      });
      const reflected = await s.get("api/v1/diagnostics/projects?ghp_abc=1&%2FUsers%2Fme=2");
      expect(reflected.status).toBe(400);
      expect(reflected.text).not.toContain("ghp_abc");
      expect(reflected.text).not.toContain("/Users/me");
      expect(JSON.parse(reflected.text).error.message).toBe(
        "Unknown parameter; allowed: limit, cursor.",
      );
      expect(s.collects).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("shows an in-flight shared collection with its waiters, without starting one", async () => {
    let release = () => undefined as void;
    const s = await setup(["example/one"], new Promise<void>((done) => (release = done)));
    try {
      const pending = s.get("api/v1/briefing");
      for (let i = 0; i < 50 && s.collects.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      s.clock.time += 1500;
      const inflight = (await s.json("api/v1/diagnostics/inflight")).data.items;
      expect(inflight).toEqual([
        {
          id: expect.stringMatching(/^f\d+$/),
          repository: "example/one",
          collector: expect.any(String),
          subject: null,
          startedAt: "2026-11-15T00:00:00.000Z",
          elapsedMs: 1500,
          waiters: 1,
          cancelled: false,
        },
      ]);
      expect(s.collects).toEqual(["example/one"]);
      release();
      await pending;
      expect((await s.json("api/v1/diagnostics/inflight")).data.items).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("never shows a collection still running for a retired gh login", async () => {
    let release = () => undefined as void;
    const s = await setup(["example/one"], new Promise<void>((done) => (release = done)));
    try {
      const first = s.get("api/v1/briefing");
      for (let i = 0; i < 50 && s.collects.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect((await s.json("api/v1/diagnostics/inflight")).data.total).toBe(1);
      // gh auth switch: the next live collection (after the TTL) notices and clears the cache.
      s.login.current = "someone-else";
      s.clock.time += 6 * 60_000;
      const second = s.get("api/v1/issues/1");
      for (let i = 0; i < 50 && s.collects.length < 2; i++)
        await new Promise((r) => setTimeout(r, 10));
      const items = (await s.json("api/v1/diagnostics/inflight")).data.items;
      expect(items.map((f: { subject: number | null }) => f.subject)).toEqual([1]);
      release();
      await Promise.all([first, second]);
    } finally {
      await s.running.close();
    }
  });

  it("config reports a setting given as an argument as such, even when it equals the default", async () => {
    const { serveArguments: parse } = await import("./options.js");
    expect(parse(["--repo", "o/r", "--ttl", "5m", "--port", "4372"]).given).toEqual({
      port: true,
      ttl: true,
    });
    expect(parse(["--repo", "o/r"]).given).toEqual({ port: false, ttl: false });
  });

  it("config shows held server settings and, without a project, the applicable defaults", async () => {
    const s = await setup();
    try {
      const config = await s.json("api/v1/diagnostics/config");
      expect(config.selection).toEqual({ repository: "example/one" });
      expect(config.coverage).toEqual({
        complete: false,
        warnings: [
          "No local project: repository-local settings were not read; defaults are shown.",
        ],
      });
      expect(config.data.settings).toMatchObject({
        "serve.port": { value: 0, source: "argument", known: true },
        "serve.ttlSeconds": { value: 300, source: "default", known: true },
        "serve.staleWindowSeconds": { value: 1800, source: "default", known: true },
        processGuide: { value: false, source: "default", known: true },
      });
      expect(Object.keys(config.data.settings).sort()).toEqual(
        [
          "briefing.engine",
          "complexity.enabled",
          "impact.enabled",
          "processGuide",
          "serve.cacheEntries",
          "serve.port",
          "serve.staleWindowSeconds",
          "serve.ttlSeconds",
        ].sort(),
      );
      expect(s.collects).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("rules reports the loaded artifact's identity without evaluating anything", async () => {
    const s = await setup();
    try {
      const rules = (await s.json("api/v1/diagnostics/rules")).data;
      expect(rules).toMatchObject({
        configuredEngine: { value: "datalog", source: "default", known: true },
        policyVersion: expect.any(Number),
        rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        validation: { state: "build-checked" },
        englishRules: { cli: "pdb rules", page: "/rules" },
      });
      expect(rules.supportedRoles).toEqual(
        expect.arrayContaining(["implementer", "designer", "human"]),
      );
      expect(s.collects).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("errors keep safe fields and same-response quota evidence, never GitHub's message", async () => {
    const response = parseGhResponse(
      'HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 5000\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Resource: graphql\n\n{"errors":[{"type":"RATE_LIMIT","message":"API rate limit already exceeded for user ID 783193."}]}',
    );
    const fail = () =>
      new RateLimitError(
        "refused for user ID 783193",
        { resetAt: null },
        classifyGhFailure({ response }),
      );
    const s = await setup(["example/one"], undefined, fail);
    try {
      expect((await s.get("api/v1/briefing")).status).toBe(502);
      const read = await s.get("api/v1/diagnostics/errors");
      const data = JSON.parse(read.text).data;
      expect(data).toMatchObject({ total: 1, discarded: 0, nextCursor: null });
      expect(data.items).toEqual([
        {
          id: expect.stringMatching(/^e\d+$/),
          repository: "example/one",
          at: "2026-11-15T00:00:00.000Z",
          operation: expect.any(String),
          code: "GITHUB_RATE_LIMITED",
          category: "rate-limited",
          subject: null,
          hint: expect.stringContaining("Nothing retries automatically"),
          quota: { resource: "graphql", limit: 5000, remaining: 5000, resetAt: null },
        },
      ]);
      expect(read.text).not.toContain("783193");
      expect(read.text).not.toContain("octo-secret-login");
      // Reading errors creates no new event and starts no collection.
      expect((await s.json("api/v1/diagnostics/errors")).data.total).toBe(1);
      expect(s.collects).toEqual(["example/one"]);
    } finally {
      await s.running.close();
    }
  });

  it("the error ring keeps the newest 100 and counts what it discarded", async () => {
    const s = await setup(["example/one"], undefined, () => new Error("network down"));
    try {
      for (let i = 0; i < 102; i++) {
        s.clock.time += 1000;
        await s.get(`api/v1/issues/${(i % 50) + 1}`);
      }
      const data = (await s.json("api/v1/diagnostics/errors?limit=100")).data;
      expect(data).toMatchObject({ total: 100, discarded: 2, omitted: 0 });
      expect(data.items[0].code).toBe("GITHUB_UNAVAILABLE");
      // Newest first.
      expect(data.items[0].at > data.items[99].at).toBe(true);
    } finally {
      await s.running.close();
    }
  });

  it("records a failure once per shared collection, and not again for cooldown refusals", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((done) => (release = done));
    const response = parseGhResponse("HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n{}");
    const fail = () =>
      new RateLimitError("limited", { resetAt: null }, classifyGhFailure({ response }));
    const s = await setup(["example/one"], gate, fail);
    try {
      const waiters = [
        s.get("api/v1/briefing"),
        s.get("api/v1/briefing"),
        s.get("api/v1/briefing"),
      ];
      for (let i = 0; i < 50 && s.collects.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      release();
      await Promise.all(waiters);
      // Three coalesced waiters, one collection, one event.
      expect(s.collects).toEqual(["example/one"]);
      expect((await s.json("api/v1/diagnostics/errors")).data.total).toBe(1);
      // During the cooldown nothing runs, so nothing new is recorded.
      for (let i = 0; i < 3; i++) expect((await s.get("api/v1/briefing")).status).toBe(502);
      expect((await s.json("api/v1/diagnostics/errors")).data.total).toBe(1);
    } finally {
      await s.running.close();
    }
  });

  it("a failure of a collection that ran under a retired login is never shown under the new one", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((done) => (release = done));
    const s = await setup(["example/one"], gate, () => new Error("network down"));
    try {
      const first = s.get("api/v1/briefing");
      for (let i = 0; i < 50 && s.collects.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      s.login.current = "someone-else";
      s.clock.time += 6 * 60_000;
      const second = s.get("api/v1/issues/1");
      for (let i = 0; i < 50 && s.collects.length < 2; i++)
        await new Promise((r) => setTimeout(r, 10));
      release();
      await Promise.all([first, second]);
      const items = (await s.json("api/v1/diagnostics/errors")).data.items;
      expect(items.map((e: { subject: number | null }) => e.subject)).toEqual([1]);
    } finally {
      await s.running.close();
    }
  });

  it("records a rate-limited auth re-check that starts the cooldown", async () => {
    const s = await setup();
    try {
      await s.get("api/v1/briefing");
      // The next live read after the TTL re-checks the login, and that check is rate limited.
      s.login.fail = new RateLimitError("limited", { resetAt: null });
      s.clock.time += 6 * 60_000;
      expect((await s.get("api/v1/issues/1")).status).toBe(502);
      const errors = (await s.json("api/v1/diagnostics/errors")).data;
      expect(errors.total).toBe(1);
      expect(errors.items[0]).toMatchObject({ code: "GITHUB_RATE_LIMITED", subject: 1 });
      // Refused by that cooldown afterwards: nothing ran, nothing more is recorded.
      expect((await s.get("api/v1/issues/1")).status).toBe(502);
      expect((await s.json("api/v1/diagnostics/errors")).data.total).toBe(1);
    } finally {
      await s.running.close();
    }
  });

  it("a collection cancelled by its only waiter is not recorded as a GitHub failure", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((done) => (release = done));
    const s = await setup(["example/one"], gate, () => new Error("aborted by caller"));
    try {
      const controller = new AbortController();
      const pending = fetch(`${s.running.facts.url}api/v1/briefing`, {
        signal: controller.signal,
      }).catch(() => undefined);
      for (let i = 0; i < 50 && s.collects.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      for (let i = 0; i < 50; i++) {
        if ((await s.json("api/v1/diagnostics/inflight")).data.total === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      release();
      await pending;
      await new Promise((r) => setTimeout(r, 20));
      expect((await s.json("api/v1/diagnostics/errors")).data.total).toBe(0);
    } finally {
      await s.running.close();
    }
  });
});
