import { describe, expect, it } from "vite-plus/test";
import { RateLimitError } from "./dependencies.js";
import { AuthenticationError } from "./github.js";
import {
  hydrate,
  QuotaStopped,
  quotaRefusal,
  ReadMeter,
  readProfiles,
  restOutcome,
  shapeId,
} from "./readplan.js";

const clock = () => new Date("2026-11-15T00:00:00.000Z");

describe("read profiles, coverage and telemetry (#367, collection-profiles.md)", () => {
  it("selects the GraphQL cost under an alias the caller never sees", async () => {
    const meter = new ReadMeter("issue-detail-v1", "who", clock);
    const seen: string[] = [];
    const q = meter.query(
      async (query) => {
        seen.push(query);
        return {
          repository: { issue: { number: 1 } },
          pdbReadRate: { cost: 2, remaining: 4990, resetAt: "2026-11-15T01:00:00Z" },
        };
      },
      "issue",
      "o/r#1",
    );
    const data = await q('query{repository(owner:"o",name:"r"){issue(number:1){number}}}', {});
    expect(seen[0]).toMatch(/pdbReadRate:rateLimit\{cost remaining resetAt\}\}$/);
    expect(data).toEqual({ repository: { issue: { number: 1 } } });
    const { telemetry } = meter.collection();
    expect(telemetry).toMatchObject({
      requests: 1,
      graphqlRequests: 1,
      cost: 2,
      knownCost: 2,
      unknownCostRequests: 0,
      rateLimit: { remaining: 4990, resetAt: "2026-11-15T01:00:00Z" },
    });
    expect(telemetry.bytes).toBe(Buffer.byteLength(JSON.stringify(data)));
  });

  it("an unreported cost is null, never zero, and failures are counted by category", async () => {
    const meter = new ReadMeter("pr-status-v1", "pr", clock);
    const ok = meter.query(async () => ({ repository: {} }), "pull-request", "o/r#2");
    const limited = meter.query(
      async () => {
        throw new RateLimitError("rate limited");
      },
      "pull-request",
      "o/r#3",
    );
    await ok("query{x}", {});
    await expect(limited("query{x}", {})).rejects.toThrow("rate limited");
    const { telemetry } = meter.collection();
    expect(telemetry.cost).toBeNull();
    expect(telemetry.knownCost).toBe(0);
    expect(telemetry.unknownCostRequests).toBe(2);
    expect(telemetry.failures).toEqual({ "rate-limited": 1 });
    expect(telemetry.calls[1]).toMatchObject({ outcome: "rate-limited", bytes: null, cost: null });
  });

  it("REST calls record status and a route shape without numbers or logins", async () => {
    const meter = new ReadMeter("pr-status-v1", "pr", clock);
    const rest = meter.rest(
      async (path) => ({ status: path.includes("alice") ? 200 : 404, body: { ok: true } }),
      "permissions",
      "o/r#2",
    );
    await rest("repos/o/r/collaborators/alice/permission");
    await rest("repos/o/r/collaborators/bob/permission");
    const [a, b] = meter.collection().telemetry.calls;
    expect(a).toMatchObject({ route: "rest", status: 200, cost: null, outcome: "success" });
    expect(b).toMatchObject({ status: 404, outcome: "failed" });
    // Same template for both logins: the shape never carries a variable.
    expect(a.shape).toBe(b.shape);
    expect(a.shape).toBe(shapeId("repos/{owner}/{repo}/collaborators/{login}/permission"));
  });

  it("coverage is typed per source; unread sources are not-requested, never complete", () => {
    const meter = new ReadMeter("issue-detail-v1", "deps", clock);
    meter.cover("issue", "o/r#1", "complete");
    meter.cover("comments", "o/r#1", "not-requested", { omission: "not read" });
    meter.cover("pull-request", "o/r#2", "failed", { failure: "read-failed" });
    const { coverage, profile, profileVersion, bounds } = meter.collection();
    expect(profile).toBe("issue-detail-v1");
    expect(profileVersion).toBe(readProfiles["issue-detail-v1"].version);
    expect(bounds).toMatchObject({ hydrationConcurrency: 3 });
    expect(coverage).toEqual([
      expect.objectContaining({ state: "complete", observedAt: clock().toISOString() }),
      expect.objectContaining({ state: "not-requested", observedAt: null, omission: "not read" }),
      expect.objectContaining({ state: "failed", observedAt: null, failure: "read-failed" }),
    ]);
  });

  it("hydrates at most three at once and stops scheduling after a quota refusal", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await hydrate([1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
      started.push(n);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (n === 2) throw new RateLimitError("secondary rate limit");
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // Requests already in flight finish; nothing new starts after the refusal.
    expect(started.length).toBeLessThan(8);
    expect(results[0]).toEqual({ state: "done", value: 10 });
    expect(results[1]).toMatchObject({ state: "failed" });
    expect(results.at(-1)).toEqual({ state: "not-attempted" });
    expect(quotaRefusal((results[1] as { error: unknown }).error)).toBe(true);
  });

  it("an ordinary failure does not stop the other targets", async () => {
    const results = await hydrate([1, 2, 3, 4], async (n) => {
      if (n === 1) throw new Error("boom");
      return n;
    });
    expect(results.map((r) => r.state)).toEqual(["failed", "done", "done", "done"]);
  });

  it("classifies REST outcomes by HTTP status, not by the call returning", async () => {
    const answer = (status: number | null, body: unknown = {}) => ({ status, body });
    expect(restOutcome(answer(200))).toBe("success");
    expect(restOutcome(answer(304))).toBe("success");
    for (const status of [401, 403, 404, 410, 500, 502, null])
      expect(restOutcome(answer(status)), String(status)).toBe("failed");
    expect(restOutcome(answer(429))).toBe("rate-limited");
    // The body's message is never classification evidence; only status and evidence are.
    expect(restOutcome(answer(403, { message: "API rate limit exceeded" }))).toBe("failed");
    expect(
      restOutcome({ status: 403, body: {}, evidence: { category: "rate-limited" } } as never),
    ).toBe("rate-limited");
    const meter = new ReadMeter("pr-status-v1", "pr", clock);
    const rest = meter.rest(async () => answer(502), "delivery-records", "o/r#1");
    await rest("repos/o/r/compare/a...b");
    expect(meter.collection().telemetry.failures).toEqual({ failed: 1 });
  });

  it("a prior record makes telemetry the whole command's cost", async () => {
    const first = new ReadMeter("compatibility-full-v1", "issue-intake", clock);
    await first.query(
      async () => ({ pdbReadRate: { cost: 5 } }),
      "snapshot",
      "o/r",
    )("query{x}", {});
    first.cover("open-issues", "o/r", "complete");
    const second = new ReadMeter("compatibility-full-v1", "issue-intake", clock);
    await second.query(
      async () => ({ pdbReadRate: { cost: 1 } }),
      "delivery-records",
      "o/r#1",
    )("query{y}", {});
    await second.rest(
      async () => ({ status: 200, body: {} }),
      "permissions",
      "o/r#1",
    )("repos/o/r/collaborators/a/permission");
    const merged = second.collection(first.collection());
    expect(merged.telemetry).toMatchObject({
      requests: 3,
      graphqlRequests: 2,
      restRequests: 1,
      cost: 6,
    });
    expect(merged.coverage.map((c) => c.source)).toEqual(["open-issues"]);
  });

  it("classifies quota refusals from structured evidence, never message text", async () => {
    expect(quotaRefusal(new RateLimitError("secondary limit"))).toBe(true);
    expect(
      quotaRefusal(Object.assign(new Error("x"), { evidence: { category: "rate-limited" } })),
    ).toBe(true);
    // gh's auth advice mentions rate limits; an authentication failure is never a quota refusal.
    const auth = new AuthenticationError("Check gh auth status, network and API rate limits.");
    expect(quotaRefusal(auth)).toBe(false);
    expect(quotaRefusal(Object.assign(auth, { evidence: { category: "rate-limited" } }))).toBe(
      false,
    );
    expect(quotaRefusal(new Error("API rate limit exceeded"))).toBe(false);
    // Hydration keeps going after such a failure: only a real refusal stops scheduling.
    const results = await hydrate(
      [1, 2, 3, 4],
      async (n) => {
        if (n === 1) throw new AuthenticationError("check API rate limits");
        return n;
      },
      { concurrency: 1 },
    );
    expect(results.map((r) => r.state)).toEqual(["failed", "done", "done", "done"]);
    const meter = new ReadMeter("pr-status-v1", "pr", clock);
    const q = meter.query(
      async () => {
        throw new Error("GitHub query failed. Check gh auth status, network and API rate limits.");
      },
      "pull-request",
      "o/r#1",
    );
    await expect(q("query{x}", {})).rejects.toThrow();
    expect(meter.collection().telemetry.failures).toEqual({ failed: 1 });
  });

  it("times requests with an advancing timer even when now is fixed", async () => {
    let tick = 0;
    const meter = new ReadMeter("pr-status-v1", "pr", clock, () => (tick += 7));
    await meter.query(async () => ({}), "pull-request", "o/r#1")("query{x}", {});
    const { telemetry } = meter.collection();
    expect(telemetry.calls[0].durationMs).toBe(7);
    expect(telemetry.durationMs).toBe(21);
    // The default timer is performance.now, not the fixed clock.
    const real = new ReadMeter("pr-status-v1", "pr", clock);
    await real.query(
      async () => {
        await new Promise((r) => setTimeout(r, 15));
        return {};
      },
      "pull-request",
      "o/r#1",
    )("query{x}", {});
    expect(real.collection().telemetry.calls[0].durationMs).toBeGreaterThanOrEqual(10);
  });

  it("reports a quota refusal's structured retry evidence, and null when there was none", async () => {
    const clean = new ReadMeter("issue-detail-v1", "who", clock);
    await clean.query(async () => ({}), "issue", "o/r#1")("query{x}", {});
    expect(clean.collection().quota).toBeNull();
    const refused = new ReadMeter("issue-detail-v1", "who", clock);
    await refused
      .query(
        async () => {
          throw new RateLimitError("limited", { resetAt: "2026-11-15T01:00:00.000Z" });
        },
        "pull-request",
        "o/r#2",
      )("query{x}", {})
      .catch(() => undefined);
    expect(refused.collection().quota).toEqual({
      retryAfterSeconds: null,
      resetAt: "2026-11-15T01:00:00.000Z",
    });
    // An authentication failure is not a quota refusal.
    const auth = new ReadMeter("issue-detail-v1", "who", clock);
    await auth
      .query(
        async () => {
          throw new AuthenticationError("check API rate limits");
        },
        "issue",
        "o/r#1",
      )("query{x}", {})
      .catch(() => undefined);
    expect(auth.collection().quota).toBeNull();
  });

  it("keeps an answered REST refusal's retry evidence in quota", async () => {
    const refused = (category: string, observation: object) =>
      ({ status: 403, body: {}, evidence: { category, observation } }) as never;
    const a = new ReadMeter("pr-status-v1", "pr", clock);
    await a.rest(
      async () => refused("rate-limited", { retryAfterSeconds: 60, resetAt: null, retryAt: null }),
      "permissions",
      "o/r#1",
    )("repos/o/r/collaborators/x/permission");
    expect(a.collection().quota).toEqual({ retryAfterSeconds: 60, resetAt: null });
    const b = new ReadMeter("pr-status-v1", "pr", clock);
    await b.rest(
      async () =>
        refused("secondary-rate-limit", {
          retryAfterSeconds: null,
          retryAt: null,
          resetAt: "2026-11-15T02:00:00.000Z",
        }),
      "permissions",
      "o/r#1",
    )("repos/o/r/collaborators/x/permission");
    expect(b.collection().quota).toEqual({
      retryAfterSeconds: null,
      resetAt: "2026-11-15T02:00:00.000Z",
    });
    expect(b.collection().telemetry.failures).toEqual({ "rate-limited": 1 });
  });

  it("sends nothing through any boundary after a quota refusal", async () => {
    const meter = new ReadMeter("issue-detail-v1", "who", clock);
    let sent = 0;
    const refuse = meter.rest(
      async () => {
        sent++;
        return { status: 429, body: {} };
      },
      "permissions",
      "o/r#1",
    );
    await refuse("repos/o/r/collaborators/a/permission");
    const later = meter.query(
      async () => {
        sent++;
        return {};
      },
      "pull-request",
      "o/r#2",
    );
    const err = await later("query{x}", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaStopped);
    expect(quotaRefusal(err)).toBe(true);
    await expect(refuse("repos/o/r/collaborators/b/permission")).rejects.toBeInstanceOf(
      QuotaStopped,
    );
    expect(sent).toBe(1);
    expect(meter.refused).toBe(true);
    const { notAttempted, telemetry } = meter.collection();
    expect(notAttempted).toEqual(["pull-request o/r#2", "permissions o/r#1"]);
    // Only the one request actually sent is counted.
    expect(telemetry.requests).toBe(1);
  });
});
