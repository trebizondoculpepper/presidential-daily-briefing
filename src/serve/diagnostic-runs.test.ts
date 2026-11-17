/** Real HTTP boundary, injected read-only services; no GitHub, credentials or local writes. */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { startServe } from "../serve.js";
import { readServices } from "./services.js";
import { serveArguments } from "./options.js";
import { RateLimitError } from "../github/dependencies.js";
import { classifyGhFailure, parseGhResponse } from "../github/evidence.js";
import { deliveryMarker } from "../workflow/delivery.js";
import { collect as collectFacts, AuthenticationError } from "../github/github.js";
import type { ServeReadRuntime, ServeRuntime } from "./types.js";
import type { RunStatus } from "./runs.js";
import { issue, snapshot, page, repo, time } from "../testing/snapshots.js";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";

const config = { cwd: SYNTHETIC_ROOT, git: fakeGit(repo), fs: emptyFileSystem };
async function setup(
  options: {
    local?: boolean;
    block?: boolean;
    fail?: Error;
    incomplete?: boolean;
    empty?: boolean;
    untrusted?: boolean;
    nativeCollector?: boolean;
    auxiliaryQuota?: "rest" | "secondary" | "thrown-rest" | "query" | "forbidden";
  } = {},
) {
  let now = Date.parse(time),
    authReads = 0,
    collects = 0;
  let authFailure: Error | null = null,
    login = "reader";
  let failure = options.fail;
  let queries = 0,
    auxiliaryRest = 0,
    auxiliaryQuery = 0;
  type Timer = { at: number; fn: () => void; native: ReturnType<typeof setTimeout> };
  const timers = new Set<Timer>();
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((t) => t.at <= now)) {
      clearTimeout(timer.native);
      timers.delete(timer);
      timer.fn();
    }
  };
  const probes: string[] = [],
    collectionSignals: AbortSignal[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = snapshot(
    options.empty ? [] : [issue(1, ["bug", "status:ready", "status:parked"])],
  );
  if (options.incomplete) fixture.warnings.push("Native dependency evidence is incomplete.");
  if (options.untrusted)
    fixture.issues[0].comments = page([
      {
        databaseId: 1,
        url: `https://github.com/${repo}/issues/1#issuecomment-1`,
        createdAt: time,
        lastEditedAt: null,
        includesCreatedEdit: false,
        editor: null,
        author: { __typename: "User", login: "unverified" },
        body: deliveryMarker({
          v: 1,
          op: "submit",
          opId: "synthetic",
          repository: repo,
          issue: 1,
          agent: "sample",
          deliverables:
            options.auxiliaryQuota === "query"
              ? [
                  {
                    kind: "pr",
                    repository: repo,
                    number: 2,
                    nodeId: "PR_2",
                    target: { repository: repo, branch: null },
                  },
                ]
              : [],
          membership: "open",
          issuedAt: time,
        }),
      },
    ]);
  const runtime: ServeRuntime = {
    currentRepository: async () => repo,
    git: fakeGit(repo),
    authContext: async () => {
      authReads++;
      if (authFailure) throw authFailure;
      return { host: "github.com", login };
    },
    clock: {
      now: () => new Date(now),
      setTimeout: (fn, ms) => {
        const timer: Timer = {
          at: now + ms,
          fn,
          native: setTimeout(() => {
            timers.delete(timer);
            fn();
          }, ms),
        };
        timers.add(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const timer = handle as Timer;
        clearTimeout(timer.native);
        timers.delete(timer);
      },
    },
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "1.0.0",
    platform: process.platform,
    doctor: {
      env: { PRIVATE_DIAGNOSTIC_VALUE: "NEVER" },
      fs: emptyFileSystem,
      nodeVersion: "26.1.0",
      dependencies: async () => ({
        id: "install.dependencies",
        status: "ok",
        source: "test",
        detail: "Dependencies at /unregistered/private/root.",
        next: [],
      }),
      probe: async (command, args) => {
        const key = `${command} ${args.join(" ")}`;
        probes.push(key);
        if (command === "gh") return { code: 0, stdout: "NEVER RAW PROBE OUTPUT" };
        if (!options.local) throw new Error("unexpected project probe");
        if (args[0] === "rev-parse") return { code: 0, stdout: SYNTHETIC_ROOT };
        if (args[0] === "remote")
          return { code: 0, stdout: `origin\thttps://github.com/${repo}.git (fetch)\n` };
        return { code: 1, stdout: "NEVER" };
      },
    },
  };
  const read: ServeReadRuntime = {
    ...(options.auxiliaryQuota
      ? {
          queryWith: () => async () => {
            auxiliaryQuery++;
            throw new RateLimitError("NEVER", { retryAfterSeconds: 60 });
          },
          rest: async () => {
            auxiliaryRest++;
            if (options.auxiliaryQuota === "forbidden")
              return {
                status: 403,
                body: {
                  message: "Permission denied; generic rate limit advice is not quota evidence.",
                },
              };
            if (options.auxiliaryQuota === "query")
              return { status: 200, body: { role_name: "write", user: { login: "unverified" } } };
            if (options.auxiliaryQuota === "thrown-rest")
              throw new RateLimitError("NEVER", { retryAfterSeconds: 60 });
            const secondary = options.auxiliaryQuota === "secondary";
            const response = parseGhResponse(
              `HTTP/2.0 ${secondary ? "403 Forbidden" : "429 Too Many Requests"}\r\nRetry-After: 60\r\n\r\n${JSON.stringify({ message: "NEVER", ...(secondary ? { documentation_url: "https://docs.github.com/rest/#secondary-rate-limits" } : {}) })}`,
            );
            return {
              status: secondary ? 403 : 429,
              body: response.body,
              evidence: classifyGhFailure({ response }),
            };
          },
        }
      : {}),
    collect: async (_repository, flags) => {
      collects++;
      const signal = flags?.signal;
      if (signal) collectionSignals.push(signal);
      if (options.block)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          gate.then(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, reject);
        });
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (options.nativeCollector)
        return collectFacts(
          repo,
          flags,
          async (source) => {
            queries++;
            return {
              repository: {
                issues: page(source.includes("issues(first") ? fixture.issues : []),
                pullRequests: page([]),
              },
            };
          },
          () => new Date(now),
        );
      return structuredClone(fixture);
    },
    dependencyReport: async () => {
      throw new Error("unused");
    },
    projectRuntime: () => ({ guide: config, estimation: config }),
    now: () => new Date(now),
    env: {},
  };
  const args = [
    "--port",
    "0",
    ...(options.local ? ["--project", SYNTHETIC_ROOT] : ["--repo", repo]),
  ];
  const serve = serveArguments(args);
  const running = await startServe(serve, runtime, readServices(serve, runtime, read));
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, running.facts.url), init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    call("api/v1/diagnostic-runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const status = (waiter: string) => call(`api/v1/diagnostic-runs/waiters/${waiter}`);
  const terminal = async (waiter: string): Promise<RunStatus> => {
    for (let n = 0; n < 200; n++) {
      const result = await status(waiter);
      if (result.body.state !== "running") return result.body;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Diagnostic run did not settle within its fixture bound");
  };
  return {
    call,
    post,
    status,
    terminal,
    fixture,
    probes,
    collectionSignals,
    runtime,
    counts: () => ({ authReads, collects }),
    costs: () => ({ queries, auxiliaryRest, auxiliaryQuery }),
    read,
    release,
    changeAuth: (next: string, error: Error | null = null) => {
      login = next;
      authFailure = error;
      advance(6 * 60_000);
    },
    advance,
    setFailure: (error: Error) => {
      failure = error;
    },
    close: () => running.close(),
  };
}

describe("active diagnostic API (#585)", () => {
  it("validates registered selection and options before any run; passive endpoints remain GET-only", async () => {
    const s = await setup();
    try {
      for (const body of [
        null,
        [],
        { kind: "shell" },
        { kind: "doctor", repo: "" },
        { kind: "ticket-doctor", repo, options: { limit: null } },
        { kind: "doctor", path: "/private" },
        { kind: "doctor", options: { limit: 3 } },
        { kind: "ticket-doctor" },
        { kind: "ticket-doctor", repo, options: { limit: 0 } },
        { kind: "ticket-doctor", repo, options: { staleHours: -1 } },
      ])
        expect((await s.post(body)).status).toBe(400);
      expect((await s.post({ kind: "doctor", repo: "unserved/project" })).status).toBe(403);
      expect((await s.post({ kind: "doctor" }, { origin: "https://evil.example" })).status).toBe(
        403,
      );
      expect(
        (
          await s.call("api/v1/diagnostic-runs", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          })
        ).status,
      ).toBe(415);
      expect((await s.call("api/v1/diagnostics/projects", { method: "POST" })).status).toBe(405);
      expect((await s.call("api/v1/diagnostic-runs/latest?kind=doctor&host=evil")).status).toBe(
        400,
      );
      expect((await s.post({ kind: "doctor", padding: "x".repeat(70 * 1024) })).status).toBe(413);
      expect((await s.call("api/v1/diagnostic-runs/latest?kind=doctor&kind=doctor")).status).toBe(
        400,
      );
      expect(s.counts()).toEqual({ authReads: 1, collects: 0 });
      expect(s.probes).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it.each([false, true])(
    "runs Doctor on the host with local project=%s and redacts local diagnostics",
    async (local) => {
      const s = await setup({ local });
      try {
        expect(
          (await s.call(`api/v1/diagnostic-runs/latest?kind=doctor${local ? `&repo=${repo}` : ""}`))
            .body,
        ).toEqual({ state: "none" });
        expect(s.probes).toEqual([]);
        const started = await s.post({ kind: "doctor", ...(local ? { repo } : {}) });
        expect(started.status).toBe(202);
        const result = await s.terminal(started.body.waiterId);
        expect(["completed", "partial"]).toContain(result.state);
        expect(result.result).toMatchObject({ scope: "local-configuration" });
        if (!local) {
          expect(result.progress.filter((p) => p.state === "skipped").map((p) => p.step)).toEqual([
            "project",
            "identity",
          ]);
          expect(
            result.result && "checks" in result.result ? result.result.checks : [],
          ).toHaveLength(4);
        }
        expect(JSON.stringify(result)).not.toMatch(
          /NEVER|unregistered\/private|synthetic\/checkout/,
        );
        expect(s.counts().collects).toBe(0);
        const latest = await s.call(
          `api/v1/diagnostic-runs/latest?kind=doctor${local ? `&repo=${repo}` : ""}`,
        );
        expect(latest.body.runId).toBe(started.body.runId);
        expect(latest.body.waiterId).toBeUndefined();
      } finally {
        await s.close();
      }
    },
  );

  it.each(["complete", "incomplete", "empty"])(
    "returns the unchanged CLI Ticket Doctor report for %s evidence",
    async (kind) => {
      const s = await setup({ incomplete: kind === "incomplete", empty: kind === "empty" });
      try {
        const started = await s.post({ kind: "ticket-doctor", repo });
        const result = await s.terminal(started.body.waiterId);
        let cli = "";
        await main(
          ["ticket-doctor", "--repo", repo, "--json"],
          async (text) => {
            cli += text;
          },
          {
            collect: async () => structuredClone(s.fixture),
            currentRepository: async () => repo,
            now: () => new Date(time),
            guide: config,
            estimation: config,
          },
        );
        expect(result.result).toEqual(JSON.parse(cli));
        expect(result.state).toBe(kind === "incomplete" ? "partial" : "completed");
        expect(s.counts()).toEqual({ authReads: 1, collects: 1 });
      } finally {
        await s.close();
      }
    },
  );

  it("shares identical runs while cancellation and foreign handles affect only one waiter", async () => {
    const s = await setup({ block: true });
    try {
      const a = await s.post({ kind: "ticket-doctor", repo }),
        b = await s.post({ kind: "ticket-doctor", repo, options: { staleHours: 24, limit: 30 } });
      expect(a.body.runId).toBe(b.body.runId);
      expect(a.body.waiterId).not.toBe(b.body.waiterId);
      expect(s.counts().collects).toBe(1);
      expect(
        (await s.call("api/v1/diagnostic-runs/waiters/foreign", { method: "DELETE" })).status,
      ).toBe(204);
      await s.call(`api/v1/diagnostic-runs/waiters/${a.body.waiterId}`, { method: "DELETE" });
      expect((await s.status(a.body.waiterId)).body.state).toBe("cancelled");
      expect(s.collectionSignals[0].aborted).toBe(false);
      await s.call(`api/v1/diagnostic-runs/waiters/${b.body.waiterId}`, { method: "DELETE" });
      expect((await s.status(b.body.waiterId)).body.state).toBe("cancelled");
      expect(s.collectionSignals[0].aborted).toBe(true);
      expect((await s.call("api/v1/diagnostics/errors")).body.data.total).toBe(0);
    } finally {
      s.release();
      await s.close();
    }
  });

  it("separates switched and unverified auth without probing on latest lookup", async () => {
    const s = await setup();
    try {
      const first = await s.post({ kind: "doctor" });
      await s.terminal(first.body.waiterId);
      s.changeAuth("other");
      const other = await s.post({ kind: "doctor" });
      await s.terminal(other.body.waiterId);
      expect(other.body.context.login).toBe("other");
      expect(other.body.runId).not.toBe(first.body.runId);
      s.changeAuth("other", new AuthenticationError("NEVER"));
      expect((await s.post({ kind: "ticket-doctor", repo })).status).toBe(503);
      const host = await s.post({ kind: "doctor" });
      expect(host.body.context.login).toBeNull();
      await s.terminal(host.body.waiterId);
      const before = s.counts();
      const latest = await s.call("api/v1/diagnostic-runs/latest?kind=doctor");
      expect(latest.body.runId).toBe(host.body.runId);
      expect(latest.body.context.login).toBeNull();
      expect(s.counts()).toEqual(before);
    } finally {
      await s.close();
    }
  });

  it("reports quota refusal safely and shares the cache cooldown", async () => {
    const s = await setup({ fail: new RateLimitError("NEVER", { retryAfterSeconds: 60 }) });
    try {
      const first = await s.post({ kind: "ticket-doctor", repo });
      const result = await s.terminal(first.body.waiterId);
      expect(result).toMatchObject({
        state: "failed",
        result: null,
        error: { code: "GITHUB_RATE_LIMITED" },
      });
      const second = await s.post({ kind: "ticket-doctor", repo });
      await s.terminal(second.body.waiterId);
      expect(s.counts().collects).toBe(1);
      expect(JSON.stringify(result)).not.toContain("NEVER");
    } finally {
      await s.close();
    }
  });
  it("refuses a fifth distinct run while a valid equivalent request can still join", async () => {
    const s = await setup({ block: true });
    try {
      const started = [];
      for (const limit of [1, 2, 3, 4])
        started.push(await s.post({ kind: "ticket-doctor", repo, options: { limit } }));
      expect(started.every((r) => r.status === 202)).toBe(true);
      expect((await s.post({ kind: "ticket-doctor", repo, options: { limit: 5 } })).status).toBe(
        429,
      );
      const joined = await s.post({ kind: "ticket-doctor", repo, options: { limit: 1 } });
      expect(joined.body.runId).toBe(started[0].body.runId);
      expect(s.counts().collects).toBe(4);
    } finally {
      s.release();
      await s.close();
    }
  });
  it("exposes deadline failure through HTTP and cancels its underlying collection", async () => {
    const s = await setup({ block: true });
    try {
      const started = await s.post({ kind: "ticket-doctor", repo });
      s.advance(10 * 60_000);
      expect((await s.status(started.body.waiterId)).body).toMatchObject({
        state: "failed",
        result: null,
        error: { code: "RUN_TIMEOUT" },
      });
      expect(s.collectionSignals[0].aborted).toBe(true);
      expect((await s.call("api/v1/diagnostics/errors")).body.data.total).toBe(0);
    } finally {
      s.release();
      await s.close();
    }
  });
  it("does not present cache fallback from an earlier successful run as a new success", async () => {
    const s = await setup();
    try {
      const first = await s.post({ kind: "ticket-doctor", repo });
      expect((await s.terminal(first.body.waiterId)).result).not.toBeNull();
      s.setFailure(new Error("NEVER raw failure"));
      const second = await s.post({ kind: "ticket-doctor", repo });
      expect(await s.terminal(second.body.waiterId)).toMatchObject({
        state: "failed",
        result: null,
        error: { code: "CACHE_INVALIDATED" },
      });
    } finally {
      await s.close();
    }
  });
  it("keeps unverified delivery records and native evidence gaps unknown", async () => {
    const s = await setup({ untrusted: true, incomplete: true });
    try {
      const started = await s.post({ kind: "ticket-doctor", repo });
      const status = await s.terminal(started.body.waiterId);
      expect(status.state).toBe("partial");
      expect(status.result).toMatchObject({ completeness: { complete: false } });
      expect(JSON.stringify(status.result)).toMatch(/unknown|unread/);
    } finally {
      await s.close();
    }
  });
  it("measures real collector requests and keeps latest and passive reads at zero additional cost", async () => {
    const s = await setup({ nativeCollector: true });
    try {
      const started = await s.post({ kind: "ticket-doctor", repo });
      const status = await s.terminal(started.body.waiterId);
      const cost = s.costs().queries;
      // The unchanged full collector reads the issue and PR inventories separately.
      expect(cost).toBe(2);
      let output = "";
      await main(
        ["ticket-doctor", "--repo", repo, "--json"],
        async (text) => {
          output += text;
        },
        {
          collect: s.read.collect,
          currentRepository: async () => repo,
          now: () => new Date(time),
          guide: config,
          estimation: config,
        },
      );
      expect(status.result).toEqual(JSON.parse(output));
      expect(s.costs().queries - cost).toBe(cost);
      const before = s.costs();
      const auth = s.counts().authReads;
      await s.call(`api/v1/diagnostic-runs/latest?kind=ticket-doctor&repo=${repo}`);
      await s.call("api/v1/diagnostics/projects");
      await s.call("api/v1/diagnostics/inflight");
      expect(s.costs()).toEqual(before);
      expect(s.counts().authReads).toBe(auth);
    } finally {
      await s.close();
    }
  });
  it("does not collect under a different login after waiting for a shared cache slot", async () => {
    const s = await setup({ block: true });
    const held = Promise.allSettled(
      [1, 2, 3, 4].map((n) => s.call(`api/v1/issues/${n}?repo=${repo}`)),
    );
    try {
      const deadline = Date.now() + 5000;
      while (s.counts().collects < 4 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(s.counts().collects).toBe(4);
      const queued = await s.post({ kind: "ticket-doctor", repo });
      expect(queued.status).toBe(202);
      s.changeAuth("other");
      const host = await s.post({ kind: "doctor" });
      await s.terminal(host.body.waiterId);
      s.release();
      await held;
      expect(await s.terminal(queued.body.waiterId)).toMatchObject({
        state: "failed",
        result: null,
        error: { code: "CACHE_INVALIDATED" },
      });
      expect(s.counts().collects).toBe(4);
    } finally {
      s.release();
      await held;
      await s.close();
    }
  });
  it.each(["rest", "secondary", "thrown-rest", "query"] as const)(
    "shares auxiliary %s refusal with the global cache before partial evidence swallows it",
    async (auxiliaryQuota) => {
      const s = await setup({ untrusted: true, auxiliaryQuota });
      try {
        const first = await s.post({ kind: "ticket-doctor", repo });
        const partial = await s.terminal(first.body.waiterId);
        expect(partial).toMatchObject({ state: "partial", error: { code: "GITHUB_RATE_LIMITED" } });
        expect(partial.result).not.toBeNull();
        const cost = s.costs();
        expect(cost.auxiliaryRest).toBeGreaterThan(0);
        const second = await s.post({ kind: "ticket-doctor", repo });
        expect(await s.terminal(second.body.waiterId)).toMatchObject({
          state: "failed",
          result: null,
          error: { code: "GITHUB_RATE_LIMITED" },
        });
        expect((await s.call(`api/v1/team?repo=${repo}`)).body.error.code).toBe(
          "GITHUB_RATE_LIMITED",
        );
        expect(s.counts().collects).toBe(1);
        expect(s.costs()).toEqual(cost);
      } finally {
        await s.close();
      }
    },
  );
  it("does not turn an ordinary auxiliary permission denial into a shared quota cooldown", async () => {
    const s = await setup({ untrusted: true, auxiliaryQuota: "forbidden" });
    try {
      for (let n = 0; n < 2; n++) {
        const started = await s.post({ kind: "ticket-doctor", repo });
        expect((await s.terminal(started.body.waiterId)).error).toBeNull();
      }
      expect(s.counts().collects).toBe(2);
      expect(s.costs().auxiliaryRest).toBe(2);
    } finally {
      await s.close();
    }
  });
});
