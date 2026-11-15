/**
 * GitHub quota meters in pdb serve (#548): the account-scoped page, the quota API over the shared
 * service, the renderers' state-by-state output and the standalone browser script. An injected
 * gh REST boundary only; no test reaches GitHub.
 */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import type { RestAnswer } from "../github/github.js";
import { buildQuotaView, normalizeRateLimit } from "../github/quotas.js";
import { quotasText } from "../github/quotascli.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { dashboardRenderers, dashboardSecurityPolicy } from "./dashboard.js";
import { serveArguments } from "./options.js";
import { quotaRenderers, quotasScript } from "./quotas-page.js";
import { readServices } from "./services.js";

const T0 = Date.parse("2026-11-15T09:00:00.000Z");
const epoch = (ms: number) => Math.floor(ms / 1000);
const bucket = (limit: number, used: number, resetMs = T0 + 30 * 60_000) => ({
  limit,
  used,
  remaining: limit - used,
  reset: epoch(resetMs),
});
const body = () => ({
  resources: {
    core: bucket(5000, 120),
    graphql: bucket(5000, 4100),
    search: bucket(30, 29),
    code_search: bucket(10, 10),
  },
});
const ok = (): RestAnswer => ({ status: 200, body: body() });

async function setup(
  answer: (n: number) => RestAnswer | Promise<RestAnswer> = () => ok(),
  logins: string[] = ["octo"],
) {
  let authReads = 0;
  const calls: string[] = [];
  let collects = 0;
  const serve: ServeRuntime = {
    currentRepository: async () => "example/one",
    authContext: async () => ({
      host: "github.com",
      login: logins[Math.min(authReads++, logins.length - 1)]!,
    }),
    clock: { now: () => new Date(T0), setTimeout: () => ({}), clearTimeout: () => undefined },
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
  };
  const read: ServeReadRuntime = {
    collect: async () => {
      collects++;
      throw new Error("no collection expected");
    },
    collectIssueFocus: async () => {
      throw new Error("unused");
    },
    dependencyReport: async () => {
      throw new Error("unused");
    },
    rest: async (path) => {
      calls.push(path);
      return answer(calls.length);
    },
    now: () => new Date(T0),
    env: {},
  };
  const options = serveArguments(["--port", "0", "--repo", "example/one"]);
  const running = await startServe(options, serve, readServices(options, serve, read));
  return { running, calls, collects: () => collects, authReads: () => authReads };
}
const get = (
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string; json: any }> =>
  new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...init.headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            // HTML
          }
          done({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
        });
      },
    );
    req.on("error", fail);
    req.end();
  });

const view = quotaRenderers(dashboardRenderers());

describe("quota page and API (#548)", () => {
  it("opens with no GitHub request and says no reading was taken", async () => {
    const s = await setup();
    try {
      const page = await get(s.running.port, "/quotas");
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toBe(dashboardSecurityPolicy);
      expect(page.body).toContain("No reading has been taken yet");
      expect(page.body).toContain("Account-wide: <strong>octo</strong>");
      expect(page.body).not.toMatch(/<script>|<style|style=/);
      expect((await get(s.running.port, "/quotas.js")).body).toBe(quotasScript());
      // The passive diagnostics never read quotas either.
      await get(s.running.port, "/api/v1/diagnostics/errors");
      expect(s.calls).toEqual([]);
      expect(s.collects()).toBe(0);
      expect((await get(s.running.port, "/quotas?repo=example%2Fone")).status).toBe(400);
      expect((await get(s.running.port, "/quotas", { method: "POST" })).status).toBe(405);
    } finally {
      await s.running.close();
    }
  });

  it("reads once per explicit refresh and returns the same model as pdb quotas", async () => {
    const s = await setup();
    try {
      const reply = await get(s.running.port, "/api/v1/quotas?refresh=true");
      expect(reply.status).toBe(200);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(s.calls).toEqual(["rate_limit"]);
      const reading = normalizeRateLimit(body(), new Date(T0).toISOString())!;
      const expected = buildQuotaView({
        context: { host: "github.com", login: "octo" },
        now: T0,
        reading,
        freshness: "live",
        failure: null,
        embargo: null,
        telemetry:
          reply.json.secondary.scope === "service"
            ? { scope: "service", since: reply.json.secondary.since, events: [], discarded: 0 }
            : null,
        // A refresh re-reads the gh login first: one identity read, counted.
        requests: { quota: 1, context: 1 },
      });
      expect(reply.json).toEqual(expected);
      expect(quotasText(reply.json)).toBe(quotasText(expected));
      expect(reply.json.resources.map((r: any) => [r.resource, r.state])).toEqual([
        ["core", "normal"],
        ["graphql", "warning"],
        ["search", "critical"],
        ["code_search", "exhausted"],
      ]);
      // Another explicit refresh reads again; without refresh a fresh held reading is reused.
      await get(s.running.port, "/api/v1/quotas?refresh=true");
      expect(s.calls.length).toBe(2);
      expect((await get(s.running.port, "/api/v1/quotas")).json.freshness).toBe("cached");
      expect(s.calls.length).toBe(2);
    } finally {
      await s.running.close();
    }
    // Concurrent refreshes while a lookup is in flight share it.
    const slow = await setup(() => new Promise((done) => setTimeout(() => done(ok()), 100)));
    try {
      const replies = await Promise.all([
        get(slow.running.port, "/api/v1/quotas?refresh=true"),
        get(slow.running.port, "/api/v1/quotas?refresh=true"),
      ]);
      expect(slow.calls).toEqual(["rate_limit"]);
      expect(replies.map((r) => r.json.freshness)).toEqual(["live", "live"]);
    } finally {
      await slow.running.close();
    }
  });

  it("re-reads the gh login on refresh, so a switched login is labelled and held apart", async () => {
    const s = await setup(() => ok(), ["octo", "octo", "other-login"]);
    try {
      const first = (await get(s.running.port, "/api/v1/quotas?refresh=true")).json;
      expect(first.account).toBe("octo");
      const switched = (await get(s.running.port, "/api/v1/quotas?refresh=true")).json;
      expect(switched.account).toBe("other-login");
      expect(switched.freshness).toBe("live");
      // The page names the login the server now verifies.
      expect((await get(s.running.port, "/quotas")).body).toContain("<strong>other-login</strong>");
    } finally {
      await s.running.close();
    }
  });

  it("offline makes no request, not even an identity read", async () => {
    const s = await setup(() => ok(), ["octo"]);
    try {
      const before = s.calls.length;
      const startupReads = s.authReads();
      const offline = (await get(s.running.port, "/api/v1/quotas?offline=true")).json;
      expect(offline.freshness).toBe("unavailable");
      expect(offline.requests).toEqual({ quota: 0, context: 0 });
      expect(s.calls.length).toBe(before);
      expect(s.authReads()).toBe(startupReads);
    } finally {
      await s.running.close();
    }
  });

  it("refuses bad parameters, wrong methods and foreign origins without reading", async () => {
    const s = await setup();
    try {
      for (const path of [
        "/api/v1/quotas?host=evil.example",
        "/api/v1/quotas?refresh=yes",
        "/api/v1/quotas?refresh=true&refresh=true",
        "/api/v1/quotas?refresh=true&offline=true",
      ])
        expect((await get(s.running.port, path)).status, path).toBe(400);
      expect((await get(s.running.port, "/api/v1/quotas", { method: "POST" })).status).toBe(405);
      const foreign = await get(s.running.port, "/api/v1/quotas?refresh=true", {
        headers: { origin: "http://evil.example" },
      });
      expect(foreign.status).toBe(403);
      expect(s.calls).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("a failed refresh carries the failure, and the page shows no earlier numbers", async () => {
    const s = await setup((n) => (n === 1 ? ok() : { status: 502, body: null }));
    try {
      await get(s.running.port, "/api/v1/quotas?refresh=true");
      const failed = (await get(s.running.port, "/api/v1/quotas?refresh=true")).json;
      expect(failed.failure).toMatchObject({ category: "server", httpStatus: 502 });
      // The service may hold the last good reading as stale; the page shows none of it.
      const parts = view.render(failed, T0);
      expect(parts.meters).toBe("");
      expect(parts.notes).toBe("");
      expect(parts.state).toContain("Refresh failed (server, HTTP 502)");
      expect(parts.state).toContain("No quota numbers are shown");
      expect(parts.state + parts.secondary).not.toMatch(/\b(120|4100|4880)\b/);
    } finally {
      await s.running.close();
    }
  });
});

const viewOf = (rows: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const reading = normalizeRateLimit({ resources: rows }, new Date(T0).toISOString())!;
  return {
    ...buildQuotaView({
      context: { host: "github.com", login: "<b>octo</b>" },
      now: T0,
      reading,
      freshness: "live",
      failure: null,
      embargo: null,
      telemetry: null,
      requests: { quota: 1, context: 0 },
    }),
    ...extra,
  };
};

describe("quota renderers (#548)", () => {
  it("draws a native meter with text for every valid state, and a text state beside it", () => {
    const parts = view.render(viewOf(body().resources), T0);
    expect(parts.meters.match(/<meter /g)?.length).toBe(4);
    expect(parts.meters).toContain(
      'aria-valuetext="REST core: 120 of 5000 requests used (2.4%), 4880 remaining"',
    );
    expect(parts.meters).toContain("✓ OK");
    expect(parts.meters).toContain("! Warning: 20% or less remaining");
    expect(parts.meters).toContain("‼ Critical: below 5% remaining");
    expect(parts.meters).toContain("✕ Exhausted: none remaining");
    expect(parts.meters).toContain("resets in 30 min");
    expect(parts.state).toContain("&lt;b&gt;octo&lt;/b&gt;");
    expect(parts.secondary).toContain("Secondary limits: unmetered");
    expect(parts.secondary).toContain("that does not mean there was no throttling");
  });

  it("never draws a bar for unknown, zero-limit, inconsistent or reset-passed readings", () => {
    const parts = view.render(
      viewOf({
        core: { limit: 5000, remaining: 10 }, // used derived from limit − remaining
        graphql: { limit: 0, used: 0, remaining: 0, reset: epoch(T0 + 60_000) },
        search: { limit: 30, used: 40, remaining: 5, reset: epoch(T0 + 60_000) },
        code_search: bucket(10, 1, T0 - 60_000),
        audit_log: { limit: null, used: 1, remaining: 2 },
      }),
      T0,
    );
    expect(parts.meters).toContain("(derived: limit − remaining)");
    expect(parts.meters.match(/<meter /g)?.length ?? 0).toBe(1); // only the derived-valid core
    expect(parts.meters).toContain("? Limit is 0");
    expect(parts.meters).toContain("? Inconsistent");
    expect(parts.meters).toContain("↻ Reset passed: refresh needed");
    expect(parts.meters).toContain("? Unknown");
    expect(parts.meters.match(/No bar:/g)?.length).toBe(4);
  });

  it("drops the bar locally once a reset passes, without fetching", () => {
    const rows = body().resources;
    const later = view.render(viewOf(rows), T0 + 31 * 60_000);
    expect(later.meters).not.toContain("<meter ");
    expect(later.meters.match(/↻ Reset passed: refresh needed/g)?.length).toBe(4);
    expect(later.meters).toContain("reset passed; refresh needed");
  });

  it("escapes every string and states unreachable failures without numbers", () => {
    const parts = view.renderUnreachable("TypeError: <img src=x onerror=alert(1)>");
    expect(parts.state).not.toContain("<img");
    expect(parts.meters).toBe("");
    expect(view.countdown(new Date(T0 - 1).toISOString(), T0)).toBe("reset passed; refresh needed");
    expect(view.countdown("not a time", T0)).toBe("reset unknown");
  });
});

describe("quota browser script (#548)", () => {
  function fakeBrowser() {
    const listeners = new Map<string, () => void>();
    const element = (id: string) => ({
      id,
      innerHTML: "",
      disabled: false,
      addEventListener(type: string, fn: () => void) {
        listeners.set(`${id}:${type}`, fn);
      },
    });
    const elements = new Map(
      ["refresh", "state", "meters", "secondary", "notes"].map((id) => [id, element(id)]),
    );
    const fetched: { path: string; signal: AbortSignal }[] = [];
    const timers: (() => void)[] = [];
    const pending: ((v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)[] =
      [];
    const sandbox = {
      document: {
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => [],
      },
      AbortController,
      Date: class extends Date {
        static override now() {
          return T0;
        }
      },
      setInterval: (fn: () => void) => {
        timers.push(fn);
        return 0;
      },
      fetch: (path: string, init: { signal: AbortSignal }) => {
        fetched.push({ path, signal: init.signal });
        return new Promise((done) => pending.push(done));
      },
    };
    return { sandbox, elements, fetched, pending, listeners, timers };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("fetches nothing on open, once per Refresh, and drops a superseded answer", async () => {
    const b = fakeBrowser();
    runInNewContext(quotasScript(), b.sandbox);
    await settle();
    expect(b.fetched).toEqual([]);
    b.listeners.get("refresh:click")!();
    b.listeners.get("refresh:click")!();
    await settle();
    expect(b.fetched.map((f) => f.path)).toEqual([
      "/api/v1/quotas?refresh=true",
      "/api/v1/quotas?refresh=true",
    ]);
    expect(b.fetched[0]!.signal.aborted).toBe(true);
    b.pending[1]!({ ok: true, status: 200, json: async () => viewOf(body().resources) });
    await settle();
    expect(b.elements.get("meters")!.innerHTML).toContain("<meter ");
    // A server error clears every number, and the local redraw never brings old ones back.
    b.listeners.get("refresh:click")!();
    await settle();
    expect(b.elements.get("meters")!.innerHTML).toBe("");
    b.timers.forEach((tick) => tick());
    expect(b.elements.get("meters")!.innerHTML).toBe("");
    b.pending[2]!({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "INTERNAL", message: "Internal error." } }),
    });
    await settle();
    expect(b.elements.get("state")!.innerHTML).toContain("Refresh failed: INTERNAL");
    expect(b.elements.get("meters")!.innerHTML).toBe("");
  });
});
