import { describe, expect, it } from "vite-plus/test";
import { defaults, hash, initialize, RebriefSession } from "./core.js";
import type { Input, Read, Runtime, Transport } from "./core.js";
import { httpMcpTransport } from "./transports.js";

const now = Date.parse("2026-11-15T10:00:00Z");
export const input: Input = {
  repository: "o/r",
  agent: "agent",
  role: "implementer",
  platform: "codex",
  session: "private-session",
  eventId: "private-event",
  enabled: true,
  reason: "natural",
};
export const read = (): Read => ({
  selection: { repository: "o/r", agent: "agent", role: "implementer", platform: "codex" },
  fresh: true,
  text: "Original policy reason and next command",
  report: {
    schemaVersion: 2,
    repository: "o/r",
    freshness: {
      offline: false,
      startedAt: new Date(now).toISOString(),
      fetchedAt: new Date(now).toISOString(),
    },
    completeness: { complete: true, warnings: [] },
    ranking: { platform: "codex" },
    role: { name: "implementer" },
    decisionEngine: { used: "datalog", policyVersion: "1", rulesHash: "rules1" },
    rankedActions: {
      policyVersion: 1,
      total: 1,
      omitted: 0,
      items: [
        {
          id: "action1",
          kind: "implement",
          target: "https://github.com/o/r/issues/1",
          role: "implementer",
          band: 6,
          complexity: { state: "current", size: "S" },
          impact: { state: "current", size: "M" },
          unlocks: 0,
          unlocksUnknown: [],
          reasonCodes: ["ordinary"],
          evidence: ["evidence"],
          nextCommand: "pdb claim 1 --agent agent --repo o/r",
          thenCommand: null,
          inspection: null,
        },
      ],
    },
    subjects: [
      {
        url: "https://github.com/o/r/issues/1",
        labels: ["status:ready"],
        owners: [],
        pullRequest: { head: "head1" },
      },
    ],
  },
});
interface FixtureReport {
  schemaVersion: number;
  repository: string;
  metrics?: { durationMs: number };
  freshness: { offline: boolean; startedAt: string; fetchedAt: string };
  completeness: { complete: boolean; warnings: string[] };
  ranking: { platform: string };
  role: { name: string };
  decisionEngine: { used: string; policyVersion: string; rulesHash: string | null };
  rankedActions: {
    policyVersion: number;
    total: number;
    omitted: number;
    items: {
      kind: string;
      unlocks: number;
      unlocksUnknown: string[];
      reasonCodes: string[];
      nextCommand: string | null;
      inspection: string | null;
    }[];
  };
  subjects: { pullRequest: { head: string } }[];
}
const obj = (r: Read) => r.report as FixtureReport;
function setup(next = read()) {
  const session = new RebriefSession(initialize(input));
  let calls = 0;
  let aborted = false;
  const transport: Transport = {
    freshRead: true,
    read: async (_c, signal) => {
      calls++;
      aborted = signal.aborted;
      return next;
    },
  };
  const runtime: Runtime = { transport, now: () => now };
  return { session, runtime, calls: () => calls, aborted: () => aborted };
}

describe("shared rebrief decision", () => {
  it("offers exact bounded instructions and requires delivery acknowledgment before another event", async () => {
    const t = setup();
    const result = await t.session.evaluate(input, t.runtime);
    expect(result).toMatchObject({
      decision: "continue",
      actionIds: ["action1"],
      policyRevision: "datalog:1:rules1",
    });
    expect(result.briefing).toContain(read().text);
    expect(Buffer.byteLength(result.briefing!)).toBeLessThanOrEqual(defaults.textBytes);
    expect(await t.session.evaluate(input, t.runtime)).toMatchObject({ reason: "duplicate-event" });
    expect(await t.session.evaluate({ ...input, eventId: "other" }, t.runtime)).toMatchObject({
      reason: "delivery-unacknowledged",
    });
    expect(t.session.acknowledge(input, "wrong", result.fingerprint!)).toBe(false);
    expect(t.session.acknowledge(input, input.eventId, hash("wrong"))).toBe(false);
    expect(t.session.acknowledge(input, input.eventId, result.fingerprint!)).toBe(true);
    expect(t.session.acknowledge(input, input.eventId, result.fingerprint!)).toBe(false);
    expect(await t.session.evaluate({ ...input, eventId: "next" }, t.runtime)).toMatchObject({
      reason: "unchanged",
    });
    expect(t.calls()).toBe(2);
    const stored = JSON.stringify(t.session.state);
    for (const secret of [input.session, input.eventId, read().text, "pdb claim", "https://"])
      expect(stored).not.toContain(secret);
  });
  it("ignores fetch times, telemetry and text formatting but includes relevant head/policy/reason changes", async () => {
    const baseline = await setup().session.evaluate(input, setup().runtime);
    for (const change of ["timestamp", "format", "head", "policy", "reason"]) {
      const r = read();
      if (change === "timestamp") {
        obj(r).freshness.fetchedAt = new Date(now + 1).toISOString();
        obj(r).metrics = { durationMs: 999 };
      }
      if (change === "format") r.text = "different whitespace rendering";
      if (change === "head") obj(r).subjects[0].pullRequest.head = "head2";
      if (change === "policy") obj(r).decisionEngine.rulesHash = "rules2";
      if (change === "reason") obj(r).rankedActions.items[0].reasonCodes = ["new-evidence"];
      const t = setup(r);
      const got = await t.session.evaluate(input, t.runtime);
      expect(got.decision, change).toBe("continue");
      expect(got.fingerprint === baseline.fingerprint, change).toBe(
        ["timestamp", "format"].includes(change),
      );
    }
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1, b: undefined })).toBe(hash({ a: 1 }));
  });
  it("offers changed native unlock evidence after an acknowledged briefing", async () => {
    for (const field of ["unlocks", "unlocksUnknown"] as const) {
      const t = setup();
      const first = await t.session.evaluate(input, t.runtime);
      expect(t.session.acknowledge(input, input.eventId, first.fingerprint!)).toBe(true);
      const changed = read();
      if (field === "unlocks") obj(changed).rankedActions.items[0].unlocks = 2;
      else
        obj(changed).rankedActions.items[0].unlocksUnknown = ["native edge coverage is incomplete"];
      const second = await t.session.evaluate(
        { ...input, eventId: "unlock-change" },
        setup(changed).runtime,
      );
      expect(second.decision, field).toBe("continue");
      expect(second.fingerprint, field).not.toBe(first.fingerprint);
      expect(second.actionIds).toEqual(first.actionIds);
    }
  });
  it("stops before reading for disabled, non-natural, missing context/state, cancelled, cap and unsupported transport", async () => {
    for (const override of [
      { enabled: false },
      { reason: "user-stop" },
      { reason: "failure" },
      { reason: "unknown" },
      { agent: "" },
      { canDeliver: false },
      { deadlineMs: 10001 },
      { cap: 4 },
    ]) {
      const t = setup();
      const got = await t.session.evaluate({ ...input, ...override }, t.runtime);
      expect(got.decision).not.toBe("continue");
      expect(t.calls()).toBe(0);
    }
    const t = setup();
    const c = new AbortController();
    c.abort();
    expect(await t.session.evaluate(input, t.runtime, c.signal)).toMatchObject({
      reason: "cancelled",
    });
    expect(await new RebriefSession(null).evaluate(input, t.runtime)).toMatchObject({
      reason: "state-lost",
    });
    expect(await t.session.evaluate({ ...input, session: "other" }, t.runtime)).toMatchObject({
      reason: "state-lost",
    });
    const fingerprint = hash("cap");
    t.session.state = {
      ...initialize(input),
      offers: 3,
      delivered: fingerprint,
      events: [1, 2, 3].map((n) => ({ id: hash(n), fingerprint, delivery: "acknowledged" })),
    };
    expect(await t.session.evaluate(input, t.runtime)).toMatchObject({
      reason: "continuation-cap",
    });
    expect(await setup().session.evaluate(input, { transport: httpMcpTransport })).toMatchObject({
      reason: "fresh-read-unsupported",
    });
    expect(t.calls()).toBe(0);
  });
  it("validates coverage, schema, freshness, selection, actionability and byte bounds", async () => {
    for (const mutate of [
      (r: Read) => {
        r.fresh = false;
      },
      (r: Read) => {
        obj(r).completeness.complete = false;
      },
      (r: Read) => {
        obj(r).schemaVersion = 999;
      },
      (r: Read) => {
        obj(r).freshness.offline = true;
      },
      (r: Read) => {
        obj(r).freshness.startedAt = new Date(now - 1000).toISOString();
      },
      (r: Read) => {
        r.selection.agent = "other";
      },
      (r: Read) => {
        obj(r).repository = "wrong/repo";
      },
      (r: Read) => {
        obj(r).role.name = "designer";
      },
      (r: Read) => {
        obj(r).ranking.platform = "claude";
      },
      (r: Read) => {
        obj(r).decisionEngine.rulesHash = null;
      },
      (r: Read) => {
        obj(r).rankedActions.items[0].kind = "waiting";
      },
      (r: Read) => {
        obj(r).rankedActions.items[0].nextCommand = null;
      },
      (r: Read) => {
        obj(r).rankedActions = { policyVersion: 1, total: 0, omitted: 0, items: [] };
      },
      (r: Read) => {
        r.report = "truncated JSON";
      },
      (r: Read) => {
        r.text = "🫠".repeat(4000);
      },
      (r: Read) => {
        obj(r).rankedActions.total = 5;
      },
    ]) {
      const r = read();
      mutate(r);
      const t = setup(r);
      expect((await t.session.evaluate(input, t.runtime)).decision).toBe("stop");
      expect(t.calls()).toBe(1);
    }
    const r = read();
    obj(r).rankedActions.items[0].kind = "inspect";
    obj(r).rankedActions.items[0].nextCommand = null;
    obj(r).rankedActions.items[0].inspection = "Read the native evidence";
    obj(r).rankedActions.total = 20;
    obj(r).rankedActions.omitted = 19;
    expect(await setup(r).session.evaluate(input, setup(r).runtime)).toMatchObject({
      decision: "continue",
    });
  });
  it("deduplicates concurrent callbacks and rejects reentry, then stops at three acknowledged offers", async () => {
    const t = setup();
    let release!: (r: Read) => void;
    const pending = t.session.evaluate(input, {
      ...t.runtime,
      transport: {
        freshRead: true,
        read: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    expect(await t.session.evaluate(input, t.runtime)).toMatchObject({ reason: "duplicate-event" });
    expect(await t.session.evaluate({ ...input, eventId: "other" }, t.runtime)).toMatchObject({
      reason: "reentry",
    });
    release(read());
    const first = await pending;
    t.session.acknowledge(input, input.eventId, first.fingerprint!);
    for (let i = 1; i < 3; i++) {
      const r = read();
      obj(r).decisionEngine.rulesHash = `rules${i + 1}`;
      const context = { ...input, eventId: `event${i}` };
      const result = await t.session.evaluate(context, setup(r).runtime);
      expect(result.decision).toBe("continue");
      expect(t.session.acknowledge(input, context.eventId, result.fingerprint!)).toBe(true);
    }
    expect(await t.session.evaluate({ ...input, eventId: "four" }, t.runtime)).toMatchObject({
      reason: "continuation-cap",
    });
  });
  it("cancels pending reads, enforces injected deadlines and sanitizes unavailable transport failures without retry", async () => {
    for (const reason of ["cancel", "timeout", "failure"]) {
      const t = setup();
      let calls = 0,
        aborted = false;
      let fire!: () => void;
      const c = new AbortController();
      const runtime: Runtime = {
        now: () => now,
        schedule: (callback) => {
          fire = callback;
          return () => {};
        },
        transport: {
          freshRead: true,
          read: async (_input, signal) => {
            calls++;
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            if (reason === "failure") throw new Error("SECRET /private/path token");
            return new Promise(() => {});
          },
        },
      };
      const p = t.session.evaluate(input, runtime, c.signal);
      if (reason === "cancel") c.abort();
      else if (reason === "timeout") fire();
      const result = await p;
      expect(result.reason).toBe(
        reason === "cancel" ? "cancelled" : reason === "timeout" ? "timeout" : "read-failed",
      );
      expect(result.briefing).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(/SECRET|private\/path|token/);
      expect(calls).toBe(1);
      if (reason !== "failure") expect(aborted).toBe(true);
    }
  });
});
