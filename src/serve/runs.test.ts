import { describe, expect, it } from "vite-plus/test";
import { DiagnosticRuns } from "./runs.js";
import type { RunContext, RunLimits, RunProgress, RunRequest, RunRuntime } from "./runs.js";
import { HttpFailure } from "./http.js";
import type { LocalDoctorReport } from "../config/localdoctor.js";
import type { Clock } from "../mcp/polling.js";

class ManualClock implements Clock {
  time = Date.parse("2026-11-17T00:00:00Z");
  serial = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => new Date(this.time);
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => {
    if (id === undefined) throw new Error("missing timer handle");
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of Array.from(this.timers).filter(([, timer]) => timer.at <= this.time))
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.fn();
      }
  }
}
const request: RunRequest = { kind: "doctor", repo: null, options: {} };
const context: RunContext = { host: "github.com", login: "reader", repository: null };
const report = (): LocalDoctorReport => ({
  schemaVersion: 1,
  scope: "local-configuration",
  repository: null,
  agent: null,
  role: null,
  entry: null,
  checks: [],
  summary: { ok: 0, missing: 0, invalid: 0, access: 0, unsupported: 0, unknown: 0 },
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(limits: Partial<RunLimits> = {}, redact: RunRuntime["redact"] = (v) => v) {
  const clock = new ManualClock();
  const work: {
    signal: AbortSignal;
    progress: (p: RunProgress) => void;
    resolve: (value: { result: LocalDoctorReport; complete: boolean }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let id = 0;
  const runs = new DiagnosticRuns({
    clock,
    limits,
    redact,
    uuid: () => `id-${++id}`,
    execute: async (_request, _context, signal, progress) =>
      new Promise((resolve, reject) => work.push({ signal, progress, resolve, reject })),
  });
  return { runs, clock, work };
}

describe("explicit diagnostic run registry (#585)", () => {
  it("shares equivalent execution, isolates cancellation per waiter and ignores late completion", async () => {
    const { runs, work } = fixture();
    const a = runs.start(request, context),
      b = runs.start(request, context);
    expect(a.runId).toBe(b.runId);
    expect(a.waiterId).not.toBe(b.waiterId);
    await settle();
    expect(work).toHaveLength(1);
    runs.cancel(a.waiterId!);
    runs.cancel(a.waiterId!);
    runs.cancel("foreign");
    expect(runs.get(a.waiterId!).state).toBe("cancelled");
    expect(runs.get(b.waiterId!).state).toBe("running");
    expect(work[0].signal.aborted).toBe(false);
    work[0].progress({ step: "gh", state: "done", detail: null });
    expect(runs.get(a.waiterId!).progress.find((p) => p.step === "gh")?.state).toBe("pending");
    runs.cancel(b.waiterId!);
    expect(work[0].signal.aborted).toBe(true);
    work[0].resolve({ result: report(), complete: true });
    await settle();
    expect(runs.get(b.waiterId!).state).toBe("cancelled");
    runs.close();
  });

  it("retains complete and partial snapshots without creating subscriptions on latest lookup", async () => {
    const { runs, work } = fixture();
    expect(runs.latest(request, context)).toEqual({ state: "none" });
    expect(work).toEqual([]);
    const started = runs.start(request, context);
    await settle();
    expect(runs.latest(request, context)).not.toHaveProperty("waiterId");
    const result = report();
    work[0].resolve({ result, complete: false });
    await settle();
    result.agent = "changed after return";
    const retained = runs.get(started.waiterId!);
    expect(retained.state).toBe("partial");
    expect(retained.result).toMatchObject({ agent: null });
    retained.state = "failed";
    expect(runs.get(started.waiterId!).state).toBe("partial");
    const refreshed = runs.start(request, context);
    expect(refreshed.runId).not.toBe(started.runId);
    await settle();
    work[1].resolve({ result: report(), complete: true });
    await settle();
    expect(runs.get(refreshed.waiterId!).state).toBe("completed");
    expect(work).toHaveLength(2);
    runs.close();
  });

  it("keys sharing by host, login, project, kind and normalized options", () => {
    const { runs } = fixture({ active: 8 });
    const ids = [
      runs.start(request, context),
      runs.start(request, { ...context, login: "other" }),
      runs.start(request, { ...context, login: null }),
      runs.start(request, { ...context, host: "other.example" }),
      runs.start({ ...request, repo: "a/b" }, { ...context, repository: "a/b" }),
      runs.start(
        { kind: "ticket-doctor", repo: "a/b", options: { staleHours: 24, limit: 30 } },
        { ...context, repository: "a/b" },
      ),
      runs.start(
        { kind: "ticket-doctor", repo: "a/b", options: { staleHours: 48, limit: 30 } },
        { ...context, repository: "a/b" },
      ),
    ].map((s) => s.runId);
    expect(new Set(ids).size).toBe(ids.length);
    runs.close();
  });

  it("refuses excess active work or per-run handles without queuing, while allowing a valid join", () => {
    const { runs } = fixture({ active: 1, perRun: 2 });
    const a = runs.start(request, context);
    runs.start(request, context);
    expect(() => runs.start(request, { ...context, login: "other" })).toThrow(/capacity/);
    runs.cancel(a.waiterId!);
    expect(() => runs.start(request, context)).toThrow(/capacity/);
    expect(runs.counts()).toEqual({ active: 1, retained: 0, waiters: 2 });
    runs.close();
  });

  it("reclaims terminal handles but cannot evict an active waiter to admit another", async () => {
    const { runs, work } = fixture({ waiters: 1 });
    const first = runs.start(request, context);
    await settle();
    expect(() => runs.start(request, context)).toThrow(/capacity/);
    work[0].resolve({ result: report(), complete: true });
    await settle();
    const second = runs.start(request, context);
    expect(() => runs.get(first.waiterId!)).toThrow(/unknown or expired/);
    expect(runs.get(second.waiterId!).state).toBe("running");
    runs.close();
  });

  it("expires retained results and handles, cancels timers, and never restarts from latest", async () => {
    const { runs, clock, work } = fixture({ retentionMs: 100 });
    const first = runs.start(request, context);
    await settle();
    work[0].resolve({ result: report(), complete: true });
    await settle();
    expect(clock.timers.size).toBe(1);
    clock.advance(100);
    expect(runs.latest(request, context)).toEqual({ state: "none" });
    expect(() => runs.get(first.waiterId!)).toThrow(/unknown or expired/);
    expect(runs.counts()).toEqual({ active: 0, retained: 0, waiters: 0 });
    expect(work).toHaveLength(1);
    runs.close();
  });

  it.each([{ retained: 1 }, { bytes: 1 }])(
    "evicts terminal data under resource pressure %j",
    async (limits) => {
      const { runs, work } = fixture(limits);
      runs.start(request, context);
      await settle();
      work[0].resolve({ result: report(), complete: true });
      await settle();
      runs.start(request, { ...context, login: "other" });
      await settle();
      work[1].resolve({ result: report(), complete: true });
      await settle();
      expect(runs.latest(request, context)).toEqual({ state: "none" });
      expect(runs.counts().retained).toBe(limits.bytes ? 0 : 1);
      runs.close();
    },
  );

  it("aborts at the deadline and rejects late success without classifying timeout as explicit cancellation", async () => {
    const { runs, clock, work } = fixture({ timeoutMs: 100 });
    const started = runs.start(request, context);
    await settle();
    clock.advance(100);
    expect(work[0].signal.aborted).toBe(true);
    expect(runs.get(started.waiterId!)).toMatchObject({
      state: "failed",
      error: { code: "RUN_TIMEOUT" },
    });
    work[0].resolve({ result: report(), complete: true });
    await settle();
    expect(runs.get(started.waiterId!).error?.code).toBe("RUN_TIMEOUT");
    runs.close();
  });

  it("redacts stored progress/results, bounds progress details and drops unregistered fields", async () => {
    const redact: RunRuntime["redact"] = (v) =>
      JSON.parse(JSON.stringify(v).replaceAll("/private/root", "<local checkout>"));
    const { runs, work } = fixture({}, redact);
    const started = runs.start(request, context);
    await settle();
    work[0].progress({
      step: "gh",
      state: "running",
      detail: "/private/root " + "x".repeat(1000),
      secret: "NEVER",
    } as RunProgress);
    work[0].progress({ step: "unregistered", state: "done", detail: "NEVER" });
    const result = report();
    result.agent = "/private/root";
    work[0].resolve({ result, complete: true });
    await settle();
    const status = runs.get(started.waiterId!);
    expect(JSON.stringify(status)).not.toMatch(/\/private\/root|NEVER/);
    expect(status.progress).toHaveLength(5);
    expect(status.progress[2].detail!.length).toBeLessThan(530);
    runs.close();
  });

  it.each([
    new Error("SECRET /private/root"),
    new HttpFailure(429, "GITHUB_RATE_LIMITED", "SECRET"),
  ])("uses safe registered failure messages", async (error) => {
    const { runs, work } = fixture();
    const started = runs.start(request, context);
    await settle();
    work[0].reject(error);
    await settle();
    const status = runs.get(started.waiterId!);
    expect(status.state).toBe("failed");
    expect(JSON.stringify(status)).not.toMatch(/SECRET|private/);
    expect(status.error?.code).toBe(
      error instanceof HttpFailure ? "GITHUB_RATE_LIMITED" : "INTERNAL",
    );
    runs.close();
  });

  it("bounds the whole response and refuses unrepresentable results", async () => {
    const { runs, work } = fixture({ responseBytes: 2000 });
    const started = runs.start(request, context);
    await settle();
    const result = report();
    result.agent = "x".repeat(4000);
    work[0].resolve({ result, complete: true });
    await settle();
    const status = runs.get(started.waiterId!);
    expect(status).toMatchObject({
      state: "failed",
      result: null,
      error: { code: "RESULT_TOO_LARGE" },
    });
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(2000);
    const next = runs.start(request, context);
    await settle();
    const cyclic = report();
    (cyclic as unknown as { loop: unknown }).loop = cyclic;
    work[1].resolve({ result: cyclic, complete: true });
    await settle();
    expect(runs.get(next.waiterId!)).toMatchObject({
      state: "failed",
      result: null,
      error: { code: "INTERNAL" },
    });
    runs.close();
  });

  it("aborts owned work and clears every timer, handle and retained result at shutdown", async () => {
    const { runs, clock, work } = fixture();
    runs.start(request, context);
    await settle();
    runs.close();
    runs.close();
    expect(work[0].signal.aborted).toBe(true);
    expect(clock.timers.size).toBe(0);
    work[0].resolve({ result: report(), complete: true });
    await settle();
    expect(runs.counts()).toEqual({ active: 0, retained: 0, waiters: 0 });
    expect(() => runs.start(request, context)).toThrow(/shutting down/);
  });
});
