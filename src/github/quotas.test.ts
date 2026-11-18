import { readRateLimits } from "./service/ratelimits.js";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { RestAnswer } from "./github.js";
import {
  buildQuotaView,
  normalizeRateLimit,
  QUOTA_MAX_ROWS,
  quotaExitCode,
  QuotaService,
  rowState,
} from "./quotas.js";
import type { QuotaContext, QuotaRest, QuotaTelemetrySnapshot } from "./quotas.js";
import { quotasText, runQuotas } from "./quotascli.js";

const T0 = Date.parse("2026-11-15T09:00:00.000Z");
const epoch = (ms: number) => Math.floor(ms / 1000);
const bucket = (limit: number, used: number, resetMs = T0 + 30 * 60_000) => ({
  limit,
  used,
  remaining: limit - used,
  reset: epoch(resetMs),
});
const families = () => ({
  resources: {
    core: bucket(5000, 120),
    graphql: bucket(5000, 4800),
    search: bucket(30, 30),
    code_search: bucket(10, 0),
    audit_log: bucket(1750, 1500),
  },
  rate: bucket(5000, 120),
});
const ctxA: QuotaContext = { host: "github.com", login: "alice" };
const ctxB: QuotaContext = { host: "github.com", login: "bob" };

/** A controllable clock and a REST fake that counts and can hold calls open. */
function harness(answer: (call: number) => RestAnswer | Promise<RestAnswer> = () => ok()) {
  let now = T0;
  const calls: { path: string; signal?: AbortSignal }[] = [];
  const rest: QuotaRest = async (path, options) => {
    calls.push({ path, signal: options?.signal });
    return answer(calls.length);
  };
  return {
    calls,
    rest,
    clock: () => new Date(now),
    advance: (ms: number) => (now += ms),
    set: (ms: number) => (now = ms),
  };
}
const ok = (body: unknown = families()): RestAnswer => ({ status: 200, body });

describe("quota normalization", () => {
  it("keeps families, units and per-row observation apart and never sums buckets", () => {
    const reading = normalizeRateLimit(families(), new Date(T0).toISOString())!;
    const view = buildQuotaView({
      context: ctxA,
      now: T0,
      reading,
      freshness: "live",
      failure: null,
      embargo: null,
      telemetry: null,
      requests: { quota: 1, context: 1 },
    });
    expect(view.resources.map((r) => [r.resource, r.family, r.unit, r.state])).toEqual([
      ["core", "rest-core", "rest-requests", "normal"],
      ["graphql", "graphql", "graphql-points", "critical"],
      ["search", "search", "search-requests", "exhausted"],
      ["code_search", "search", "search-requests", "normal"],
      ["audit_log", "additional", "requests", "warning"],
    ]);
    expect(view.resources[0]!.percentUsed).toBe(2.4);
    const json = JSON.stringify(view);
    // No total-capacity field: the sum of remaining values appears nowhere.
    expect(json).not.toMatch(/total(Remaining|Capacity)/i);
    expect(json).not.toContain(String(4880 + 200 + 0 + 10 + 250));
    expect(view.coverage).toMatchObject({ total: 5, shown: 5, omitted: 0, complete: true });
    expect(quotaExitCode(view)).toBe(0);
  });

  it("treats low, zero and unknown limits honestly; unknown is never zero or healthy", () => {
    const reading = normalizeRateLimit(
      {
        resources: {
          core: { limit: 5000, remaining: 3 },
          graphql: { limit: 0, used: 0, remaining: 0, reset: epoch(T0 + 60_000) },
          search: { remaining: 12 },
          code_search: { limit: 10, used: "7", remaining: 3 },
          scim: { limit: -1, used: 1, remaining: 2 },
        },
      },
      new Date(T0).toISOString(),
    )!;
    const view = buildQuotaView({
      context: ctxA,
      now: T0,
      reading,
      freshness: "live",
      failure: null,
      embargo: null,
      telemetry: null,
      requests: { quota: 1, context: 1 },
    });
    const row = (id: string) => view.resources.find((r) => r.resource === id)!;
    // Low: used is derived and labelled, critical.
    expect(row("core")).toMatchObject({ used: 4997, usedDerived: true, state: "critical" });
    expect(row("graphql")).toMatchObject({ state: "zero-limit", percentUsed: null });
    expect(row("search")).toMatchObject({ limit: null, used: null, state: "unknown" });
    expect(row("search").percentUsed).toBeNull();
    // An invalid field is null with a flag, not a derived or clamped value.
    expect(row("code_search")).toMatchObject({
      used: null,
      usedDerived: false,
      state: "inconsistent",
      inconsistencies: ["invalid-used"],
    });
    expect(row("scim")).toMatchObject({ limit: null, state: "inconsistent" });
    const text = quotasText(view);
    expect(text).toContain("Search: limit unknown; remaining 12");
    expect(text).toContain("unknown is not zero or healthy");
    expect(text).toContain("4997 (derived) / 5000 used");
  });

  it("flags contradictions instead of clamping them", () => {
    const reading = normalizeRateLimit(
      {
        resources: {
          core: { limit: 5000, used: 10, remaining: 6000, reset: epoch(T0 + 60_000) },
          graphql: { limit: 5000, used: 100, remaining: 100, reset: epoch(T0 + 60_000) },
        },
      },
      new Date(T0).toISOString(),
    )!;
    expect(reading.rows.map((r) => r.inconsistencies)).toEqual([
      ["remaining-exceeds-limit"],
      ["totals-mismatch"],
    ]);
    expect(reading.rows[0]!.remaining).toBe(6000);
  });

  it("caps rows with omitted counts and never claims to be comprehensive", () => {
    const resources = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`extra_${String(i).padStart(2, "0")}`, bucket(10, 1)]),
    );
    const reading = normalizeRateLimit({ resources }, new Date(T0).toISOString())!;
    expect(reading.rows).toHaveLength(QUOTA_MAX_ROWS);
    const view = buildQuotaView({
      context: ctxA,
      now: T0,
      reading,
      freshness: "live",
      failure: null,
      embargo: null,
      telemetry: null,
      requests: { quota: 1, context: 1 },
    });
    expect(view.coverage).toMatchObject({ total: 25, omitted: 5, complete: false });
    expect(view.notices).toContainEqual({ code: "missing-family", family: "rest-core" });
    expect(quotaExitCode(view)).toBe(2);
  });
});

describe("evidence, events and secondary limits", () => {
  const reading = () => normalizeRateLimit(families(), new Date(T0).toISOString())!;
  const telemetry = (t: Partial<QuotaTelemetrySnapshot>): QuotaTelemetrySnapshot => ({
    scope: "service",
    since: new Date(T0 - 3_600_000).toISOString(),
    events: [],
    discarded: 0,
    ...t,
  });
  const view = (t: QuotaTelemetrySnapshot | null) =>
    buildQuotaView({
      context: ctxA,
      now: T0,
      reading: reading(),
      freshness: "live",
      failure: null,
      embargo: null,
      telemetry: t,
      requests: { quota: 1, context: 1 },
    });

  it("keeps header and aggregate readings that disagree, each with its own source and time", () => {
    const v = view(
      telemetry({
        observations: [
          {
            resource: "core",
            observedAt: new Date(T0 - 5_000).toISOString(),
            operation: "snapshot",
            limit: 5000,
            remaining: 4700,
            resetAt: null,
          },
        ],
      }),
    );
    expect(v.resources[0]!.remaining).toBe(4880);
    expect(v.notices).toContainEqual({
      code: "header-disagrees",
      resource: "core",
      aggregate: { remaining: 4880, limit: 5000, observedAt: new Date(T0).toISOString() },
      header: {
        remaining: 4700,
        limit: 5000,
        observedAt: new Date(T0 - 5_000).toISOString(),
        operation: "snapshot",
      },
    });
    expect(quotasText(v)).toContain("Both are kept.");
  });

  it("shows primary headroom alongside a secondary throttle without inferring either", () => {
    const v = view(
      telemetry({
        events: [
          {
            category: "secondary-rate-limit",
            observedAt: new Date(T0 - 60_000).toISOString(),
            operation: "issue",
            retryAfterSeconds: 60,
            retryAt: null,
            resource: null,
            limit: null,
            remaining: null,
          },
          {
            category: "rate-limited",
            observedAt: new Date(T0 - 30_000).toISOString(),
            operation: "Robert'); DROP",
            retryAfterSeconds: null,
            retryAt: null,
            resource: "core",
            limit: 5000,
            remaining: 4000,
          },
        ],
      }),
    );
    expect(v.resources[0]!.state).toBe("normal");
    expect(v.secondary).toMatchObject({ metered: false, retained: 2, omitted: 0 });
    expect(v.secondary.events[0]!.operation).toBe("other");
    expect(v.notices).toContainEqual({ code: "secondary-observed", count: 1 });
    expect(v.notices).toContainEqual(
      expect.objectContaining({ code: "refusal-with-headroom", resource: "core" }),
    );
    const text = quotasText(v);
    expect(text).toContain("Secondary limits: unmetered.");
    expect(text).not.toContain("DROP");
  });

  it("never claims throttle-free from an empty process ring", () => {
    const text = quotasText(view(null));
    expect(text).toContain("No events observed in this process; that does not mean no throttling.");
    expect(text).not.toMatch(/all clear|throttle-free|^no throttling/im);
    const service = quotasText(view(telemetry({})));
    expect(service).toContain("No events retained since");
  });

  it("bounds the event list and reports omitted and discarded counts", () => {
    const events = Array.from({ length: 13 }, (_, i) => ({
      category: "rate-limited" as const,
      observedAt: new Date(T0 - i * 1000).toISOString(),
      operation: "snapshot",
      retryAfterSeconds: null,
      retryAt: null,
      resource: "graphql",
      limit: null,
      remaining: null,
    }));
    const v = view(telemetry({ events, discarded: 4 }));
    expect(v.secondary).toMatchObject({ retained: 13, omitted: 3, discarded: 4 });
    expect(v.secondary.events).toHaveLength(10);
    expect(v.secondary.events[0]!.observedAt).toBe(new Date(T0).toISOString());
  });
});

describe("QuotaService freshness, isolation and cancellation", () => {
  it("fetches lazily, reuses within the TTL and refreshes only when asked", async () => {
    const h = harness();
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    expect(h.calls).toHaveLength(0); // no startup request
    expect((await service.view(ctxA)).freshness).toBe("live");
    h.advance(30_000);
    const cached = await service.view(ctxA);
    expect(cached).toMatchObject({ freshness: "cached", ageSeconds: 30 });
    expect(cached.requests.quota).toBe(0);
    expect((await service.view(ctxA, { refresh: true })).freshness).toBe("live");
    expect(h.calls.map((c) => c.path)).toEqual(["rate_limit", "rate_limit"]);
    h.advance(61_000);
    expect((await service.view(ctxA)).freshness).toBe("live");
    expect(h.calls).toHaveLength(3);
  });

  it("marks a crossed reset as reset-passed inside the TTL without fetching", async () => {
    const h = harness(() =>
      ok({ resources: { core: bucket(5000, 5000, T0 + 20_000), graphql: bucket(5000, 1) } }),
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    expect((await service.view(ctxA)).resources[0]!.state).toBe("exhausted");
    h.advance(25_000);
    const v = await service.view(ctxA);
    expect(h.calls).toHaveLength(1);
    expect(v.resources[0]).toMatchObject({ state: "reset-passed", percentUsed: null });
    expect(quotasText(v)).toContain("refresh needed");
    // Rollover is not synthesized as a fresh full allowance.
    expect(v.resources[0]!.remaining).toBe(0);
  });

  it("isolates auth contexts and never reuses an unverified one", async () => {
    const h = harness();
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    expect((await service.view(ctxB)).freshness).toBe("live");
    const unverified = { host: "github.com", login: null };
    await service.view(unverified);
    const again = await service.view(unverified);
    expect(again).toMatchObject({ freshness: "live", accountVerified: false });
    expect(h.calls).toHaveLength(4);
    expect(quotaExitCode(again)).toBe(2);
  });

  it("coalesces concurrent readers and cancels only when the last reader leaves", async () => {
    let release!: (a: RestAnswer) => void;
    const h = harness(() => new Promise<RestAnswer>((r) => (release = r)));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const first = new AbortController();
    const a = service.view(ctxA, { signal: first.signal });
    const b = service.view(ctxA, { refresh: true });
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    first.abort();
    await expect(a).rejects.toBeDefined();
    expect(h.calls[0]!.signal!.aborted).toBe(false);
    release(ok());
    const view = await b;
    expect(view.freshness).toBe("live");
  });

  it("aborts the lookup when every reader cancels, and caches nothing from it", async () => {
    const h = harness(
      (call) =>
        new Promise<RestAnswer>((resolve, reject) => {
          if (call > 1) return resolve(ok());
          h.calls[0]!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const c = new AbortController();
    const pending = service.view(ctxA, { signal: c.signal });
    await Promise.resolve();
    c.abort();
    await expect(pending).rejects.toBeDefined();
    expect(h.calls[0]!.signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // The cancellation is not a ten-second failure: the next read fetches.
    expect((await service.view(ctxA)).freshness).toBe("live");
  });

  it("starts a fresh lookup when a reader arrives right after the last one cancelled", async () => {
    const h = harness((call) =>
      call === 1
        ? new Promise<RestAnswer>((_, reject) =>
            h.calls[0]!.signal!.addEventListener("abort", () =>
              // The aborted lookup settles only later, after the new reader has arrived.
              setTimeout(() => reject(new Error("aborted")), 5),
            ),
          )
        : ok(),
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const c = new AbortController();
    const cancelled = service.view(ctxA, { signal: c.signal });
    await Promise.resolve();
    c.abort();
    const fresh = service.view(ctxA);
    await expect(cancelled).rejects.toBeDefined();
    const view = await fresh;
    expect(view).toMatchObject({ freshness: "live", failure: null, requests: { quota: 1 } });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.signal!.aborted).toBe(false);
    // The late cancellation of the first lookup does not displace the fresh reading.
    await new Promise((r) => setTimeout(r, 10));
    expect((await service.view(ctxA)).freshness).toBe("cached");
  });

  it("drops a late result after the context is forgotten (login switch)", async () => {
    let release!: (a: RestAnswer) => void;
    const h = harness((call) =>
      call === 1 ? new Promise<RestAnswer>((r) => (release = r)) : ok(),
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const late = service.view(ctxA);
    await Promise.resolve();
    service.forget(ctxA);
    release(ok());
    await late;
    expect((await service.view(ctxA)).freshness).toBe("live");
    expect(h.calls).toHaveLength(2);
  });

  it("caches an access failure for ten seconds and shows last-good as stale for five minutes", async () => {
    const h = harness((call) =>
      call === 1
        ? ok()
        : {
            status: 403,
            body: { message: "secret token ghp_SENTINEL leaked" },
            evidence: {
              category: "access",
              quotaEvidence: null,
              errorTypes: [],
              httpStatus: 403,
              observation: {
                source: "response-header",
                resource: null,
                limit: null,
                remaining: null,
                used: null,
                resetAt: null,
                retryAfterSeconds: null,
                retryAt: null,
                requestId: null,
              },
            },
          },
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    h.advance(61_000);
    const failed = await service.view(ctxA);
    expect(failed).toMatchObject({ freshness: "stale", failure: { category: "access" } });
    expect(failed.ageSeconds).toBe(61);
    expect(JSON.stringify(failed)).not.toContain("SENTINEL");
    h.advance(5_000);
    await service.view(ctxA, { refresh: true });
    expect(h.calls).toHaveLength(2); // failure cooldown holds even for refresh
    h.advance(6_000);
    await service.view(ctxA);
    expect(h.calls).toHaveLength(3);
    h.advance(5 * 60_000);
    const expired = await service.view(ctxA);
    expect(expired).toMatchObject({ freshness: "unavailable", resources: [] });
    expect(quotaExitCode(expired)).toBe(2);
  });

  it("honours a retry embargo on the quota lookup instead of sending early", async () => {
    const h = harness(() => ({
      status: 403,
      body: null,
      evidence: {
        category: "secondary-rate-limit",
        quotaEvidence: null,
        errorTypes: [],
        httpStatus: 403,
        observation: {
          source: "response-header",
          resource: null,
          limit: null,
          remaining: null,
          used: null,
          resetAt: null,
          retryAfterSeconds: 120,
          retryAt: null,
          requestId: null,
        },
      },
    }));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const first = await service.view(ctxA);
    expect(first.embargo).toEqual({
      retryAt: new Date(T0 + 120_000).toISOString(),
      retryAfterSeconds: 120,
    });
    h.advance(60_000);
    const held = await service.view(ctxA, { refresh: true });
    expect(h.calls).toHaveLength(1);
    expect(held.notices).toContainEqual({ code: "embargo", retryAt: first.embargo!.retryAt });
  });

  it("enforces the five-second deadline without retrying", async () => {
    const h = harness(
      () =>
        new Promise<RestAnswer>((_, reject) =>
          h.calls[0]!.signal!.addEventListener("abort", () => reject(new Error("timeout"))),
        ),
    );
    const service = new QuotaService({ rest: h.rest, now: h.clock, timeoutMs: 20 });
    const v = await service.view(ctxA);
    expect(v.failure?.category).toBe("timeout");
    expect(h.calls).toHaveLength(1);
  });

  it("makes zero requests offline and labels held readings as stored", async () => {
    const h = harness();
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    expect((await service.view(ctxA, { offline: true })).freshness).toBe("unavailable");
    expect(h.calls).toHaveLength(0);
    await service.view(ctxA);
    h.advance(90_000);
    const stored = await service.view(ctxA, { offline: true });
    expect(stored).toMatchObject({ freshness: "stored", ageSeconds: 90 });
    expect(h.calls).toHaveLength(1);
    await expect(service.view(ctxA, { offline: true, refresh: true })).rejects.toThrow();
  });

  it("reports a clock rollback as unknown age, never negative or fresh", async () => {
    const h = harness((call) => (call === 1 ? ok() : { status: 500, body: null }));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    h.set(T0 - 3_600_000);
    const v = await service.view(ctxA);
    expect(h.calls).toHaveLength(2);
    expect(v).toMatchObject({ freshness: "stale", ageSeconds: null });
    expect(v.notices).toContainEqual({ code: "clock-rollback" });
  });
});

const refused = (
  category: "access" | "secondary-rate-limit" | "rate-limited",
  o: { retryAfterSeconds?: number; resetAt?: string; remaining?: number } = {},
): RestAnswer => ({
  status: category === "access" ? 403 : 429,
  body: null,
  evidence: {
    category,
    quotaEvidence: null,
    errorTypes: [],
    httpStatus: category === "access" ? 403 : 429,
    observation: {
      source: "response-header",
      resource: null,
      limit: null,
      remaining: o.remaining ?? null,
      used: null,
      resetAt: o.resetAt ?? null,
      retryAfterSeconds: o.retryAfterSeconds ?? null,
      retryAt: null,
      requestId: null,
    },
  },
});

describe("Codex review fixes (#551)", () => {
  it("keeps reporting a failed refresh on later reads inside the TTL", async () => {
    const h = harness((call) => (call === 1 ? ok() : refused("access")));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    h.advance(5_000);
    const refreshed = await service.view(ctxA, { refresh: true });
    expect(refreshed).toMatchObject({ freshness: "stale", failure: { category: "access" } });
    h.advance(20_000); // past the failure cooldown, still inside the 60 s TTL
    const later = await service.view(ctxA);
    expect(h.calls).toHaveLength(2);
    expect(later).toMatchObject({ freshness: "stale", failure: { category: "access" } });
    expect(later.resources).toHaveLength(5);
    expect(quotaExitCode(later)).toBe(2);
  });

  it("clears the reported failure once a later lookup succeeds", async () => {
    const h = harness((call) => (call === 2 ? refused("access") : ok()));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    await service.view(ctxA, { refresh: true });
    h.advance(11_000);
    await service.view(ctxA, { refresh: true });
    const view = await service.view(ctxA);
    expect(view).toMatchObject({ freshness: "cached", failure: null });
    expect(quotaExitCode(view)).toBe(0);
  });

  const exitFor = async (body: unknown, advanceMs = 0) => {
    const h = harness(() => ok(body));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    await service.view(ctxA);
    h.advance(advanceMs);
    return quotaExitCode(await service.view(ctxA));
  };

  it("exits 2 for an HTTP 200 with no usable or incomplete primary evidence", async () => {
    expect(await exitFor({ resources: {} })).toBe(2);
    expect(await exitFor({ resources: { core: bucket(5000, 1), search: bucket(30, 0) } })).toBe(2);
    const contradictory = families();
    contradictory.resources.core = { limit: 5000, used: 10, remaining: 6000, reset: epoch(T0) };
    expect(await exitFor(contradictory)).toBe(2);
    const unknown = { resources: { ...families().resources, graphql: { remaining: 3 } } };
    expect(await exitFor(unknown)).toBe(2);
    // Past its reset inside the TTL: no claim to current capacity.
    const passed = families();
    passed.resources.core = bucket(5000, 1, T0 + 10_000);
    expect(await exitFor(passed, 20_000)).toBe(2);
    expect(await exitFor(families())).toBe(0);
  });

  it("never shortens GitHub's Retry-After or reset, even beyond ten minutes", async () => {
    const h = harness(() => refused("secondary-rate-limit", { retryAfterSeconds: 3600 }));
    const service = new QuotaService({ rest: h.rest, now: h.clock });
    const first = await service.view(ctxA);
    expect(first.embargo).toEqual({
      retryAt: new Date(T0 + 3_600_000).toISOString(),
      retryAfterSeconds: 3600,
    });
    h.advance(30 * 60_000);
    const held = await service.view(ctxA, { refresh: true });
    expect(h.calls).toHaveLength(1);
    expect(held.embargo?.retryAt).toBe(first.embargo!.retryAt);

    const resetAt = new Date(T0 + 2 * 3_600_000).toISOString();
    const r = harness(() => refused("rate-limited", { remaining: 0, resetAt }));
    const exhausted = new QuotaService({ rest: r.rest, now: r.clock });
    expect((await exhausted.view(ctxA)).embargo?.retryAt).toBe(resetAt);
  });
});

describe("pdb quotas", () => {
  const run = async (args: string[], rest: QuotaRest, login = true) => {
    let out = "";
    const code = await runQuotas(args, async (t) => void (out += t), {
      account: {
        current: async () => {
          if (!login) throw new Error(`gh failed reading ${join("home", "user", ".config", "gh")}`);
          return { host: "github.com", login: "fixture" };
        },
        rateLimits: (signal) => readRateLimits(rest, () => new Date(T0).toISOString(), signal),
      },
      host: () => "github.com",
      now: () => new Date(T0),
    });
    return { code, out };
  };

  it("prints text and JSON with the same facts and the documented exit codes", async () => {
    const h = harness();
    const text = await run([], h.rest);
    const json = await run(["--json"], h.rest);
    expect(text.code).toBe(0);
    expect(json.code).toBe(0);
    const view = JSON.parse(json.out);
    expect(view).toMatchObject({ schemaVersion: 1, kind: "quota-view", account: "fixture" });
    expect(view.requests).toEqual({ quota: 1, context: 1 });
    expect(text.out).toContain(
      "GraphQL: 4800 / 5000 points used (96%); 200 remaining; resets 09:30 UTC [critical]",
    );
    expect(text.out).toContain("Search is exhausted until 09:30 UTC");
    expect(h.calls.map((c) => c.path)).toEqual(["rate_limit", "rate_limit"]);
  });

  it("rejects invalid and conflicting flags", async () => {
    const h = harness();
    await expect(run(["--refresh", "--offline"], h.rest)).rejects.toThrow(/mutually exclusive/);
    await expect(run(["--repo", "a/b"], h.rest)).rejects.toThrow(/Usage: pdb quotas/);
    expect(h.calls).toHaveLength(0);
  });

  it("exits 2 with an unverified login and leaks no path or error detail", async () => {
    const h = harness();
    const { code, out } = await run(["--json"], h.rest, false);
    expect(code).toBe(2);
    expect(out).not.toContain(join("home", "user"));
    expect(JSON.parse(out)).toMatchObject({ account: null, accountVerified: false });
  });

  it("offline makes no request at all and exits 2", async () => {
    const h = harness();
    const { code, out } = await run(["--offline"], h.rest);
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(out).toContain("No quota reading available (unavailable).");
  });
});

describe("display thresholds on unrounded counts (#548)", () => {
  const row = (used: number, limit = 10_000) => ({
    resource: "core",
    family: "rest-core" as const,
    unit: "rest-requests" as const,
    limit,
    used,
    usedDerived: false,
    remaining: limit - used,
    resetAt: null,
    observedAt: "2026-11-15T10:00:00.000Z",
    source: "rate-limit-endpoint" as const,
    inconsistencies: [],
  });
  it("warns at 20% remaining and is critical only below 5% remaining", () => {
    const state = (used: number, limit?: number) => rowState(row(used, limit), 0).state;
    expect(state(7_999)).toBe("normal");
    expect(state(8_000)).toBe("warning");
    expect(state(9_500)).toBe("warning");
    // 4.99% remaining rounds to 95.0% used for display, but is critical on the counts.
    expect(state(9_501)).toBe("critical");
    expect(rowState(row(9_501), 0).percentUsed).toBe(95);
    expect(state(9_999)).toBe("critical");
    expect(state(10_000)).toBe("exhausted");
    expect(state(4_750, 5_000)).toBe("warning");
    expect(state(4_751, 5_000)).toBe("critical");
  });
});
