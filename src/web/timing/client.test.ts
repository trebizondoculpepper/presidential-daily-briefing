/**
 * Timing page client (#820): parsing the real `timingView` result shape, group order, chart and
 * table agreement, drill-down links, and the loader's cancellation, with an injected transport.
 */
import { describe, expect, it } from "vite-plus/test";
import { durationStats } from "../../metrics/aggregate.js";
import {
  chartBars,
  formatDuration,
  groupOrder,
  latencyLoader,
  parseLatencyResponse,
  parseTimingResponse,
  selection,
  ticketLink,
  timingLoader,
  type TimingState,
} from "./client.js";

const repo = "example/project";
const hour = 3_600_000;
/** Stats built by the server's own aggregation, so the fixture is the real shape. */
const stats = (completedHours: number[], open = 0, unknown = 0) =>
  durationStats([
    ...completedHours.map((h, i) => ({
      member: `${repo}#${i + 1}`,
      status: "completed" as const,
      ms: h * hour,
    })),
    ...Array.from({ length: open }, (_, i) => ({
      member: `${repo}#${100 + i}`,
      status: "open" as const,
      elapsedMs: 30 * hour,
    })),
    ...Array.from({ length: unknown }, (_, i) => ({
      member: `${repo}#${200 + i}`,
      status: "unknown" as const,
    })),
  ] as never);
const envelope = (groups: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  status: "complete",
  selection: { repository: repo },
  warnings: [],
  freshness: { source: "live", observedAt: "2026-11-20T10:00:00Z", ageSeconds: 0, stale: false },
  result: {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "timing",
    window: { from: "2026-11-14T00:00:00.000Z", through: "2026-11-20T10:00:00.000Z" },
    coverage: { historyCompleteFrom: null, note: "History before 2026-11-14 is not read." },
    cohort: "delivered-in(...) + open now",
    groupBasis: "latest-valid-complexity",
    groups,
  },
  ...extra,
});

describe("timing page: parsing (#820)", () => {
  it("parses the server's groups in size order, then explicit groups, keeping unknown names", () => {
    const r = parseTimingResponse(
      envelope({ unassessed: stats([5]), L: stats([20]), S: stats([4, 10], 1), odd: stats([]) }),
    )!;
    expect(r.groups.map((g) => g.name)).toEqual(["S", "L", "unassessed", "odd"]);
    const s = r.groups[0]!.stats;
    expect(s).toMatchObject({ completed: 2, median: 7 * hour, open: { count: 1 } });
    expect(r.coverageNote).toContain("not read");
    expect(groupOrder(["XL", "XS", "conflict", "M"])).toEqual(["XS", "M", "XL", "conflict"]);
  });

  it("rejects anything that is not the timing view", () => {
    expect(parseTimingResponse({ result: { kind: "pipeline-metrics", view: "daily" } })).toBeNull();
    expect(parseTimingResponse(envelope({ S: { median: "x" } }))).toBeNull();
  });
});

describe("timing page: chart, table and drill-down agree (#820)", () => {
  it("draws bars only for groups with completed samples, from the same figures as the table", () => {
    const r = parseTimingResponse(
      envelope({ S: stats([4, 10]), M: stats([], 2, 1), L: stats([20]) }),
    )!;
    const bars = chartBars(r.groups);
    expect(bars.map((b) => b.name)).toEqual(["S", "L"]);
    for (const b of bars) {
      const g = r.groups.find((x) => x.name === b.name)!;
      expect(b.median).toBe(g.stats.median);
      expect(b.completed).toBe(g.stats.completed);
    }
    // The largest of any median or mean is the full width; nothing exceeds it.
    expect(Math.max(...bars.flatMap((b) => [b.medianPct, b.meanPct ?? 0]))).toBe(100);
    // A group with only open and unknown work has no bar but keeps its counts and members.
    const m = r.groups.find((g) => g.name === "M")!.stats;
    expect(m.members.open).toHaveLength(m.open.count);
    expect(m.members.unknown).toHaveLength(m.unknown);
  });

  it("links each member to the ticket view, carrying role and agent", () => {
    expect(ticketLink(`${repo}#12`, "?repo=x&role=designer&agent=kavya")).toBe(
      "/ticket?repo=example%2Fproject&n=12&role=designer&agent=kavya",
    );
    expect(ticketLink("not a ticket", "")).toBeNull();
  });

  it("formats durations for people and shows unknown as a dash, never zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(90 * 60_000)).toBe("90m");
    expect(formatDuration(5 * hour)).toBe("5.0h");
    expect(formatDuration(100 * hour)).toBe("4.2d");
  });
});

describe("timing page: selection and loading (#820)", () => {
  it("reads the project and a 7- or 30-day window from the URL", () => {
    expect(selection("?repo=example/project&days=30")).toEqual({ repository: repo, days: 30 });
    expect(selection("?repo=example/project&days=9")).toEqual({ repository: repo, days: 7 });
    expect(selection("?repo=bad")).toEqual({ repository: null, days: 7 });
  });

  it("requests the timing view with its window, and discards a superseded response", async () => {
    const pending: { url: string; resolve: (b: unknown) => void }[] = [];
    const fetcher = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) =>
        pending.push({
          url: String(input),
          resolve: (b) => resolve(new Response(JSON.stringify(b), { status: 200 })),
        }),
      )) as typeof fetch;
    const states: TimingState[] = [];
    const loader = timingLoader("/api/v1/metrics", fetcher, (s) => void states.push(s));
    const first = loader.load({ repository: repo, days: 7 });
    const second = loader.load({ repository: repo, days: 30 });
    expect(pending[0]!.url).toBe("/api/v1/metrics?view=timing&repo=example%2Fproject&days=7");
    expect(pending[1]!.url).toContain("days=30");
    pending[1]!.resolve(envelope({ S: stats([4]) }));
    await second;
    pending[0]!.resolve(envelope({ L: stats([20]) }));
    expect(await first).toBeNull();
    const last = states.at(-1)!;
    expect(last.status === "ready" && last.response.groups.map((g) => g.name)).toEqual(["S"]);
    // Refresh bypasses the server cache.
    void loader.refresh();
    expect(pending[2]!.url).toContain("refresh=true");
  });

  it("reports the server's error code and message", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Slow down." } }), {
        status: 429,
      })) as typeof fetch;
    const states: TimingState[] = [];
    await timingLoader("/api", fetcher, (s) => void states.push(s)).load({
      repository: repo,
      days: 7,
    });
    expect(states.at(-1)).toEqual({ status: "error", message: "Slow down.", code: "RATE_LIMITED" });
  });
});

describe("timing page: creation to first impact assessment (#822)", () => {
  const queue = (impactStats: unknown, complexityStats: unknown = stats([])) => ({
    status: "incomplete",
    warnings: ["w"],
    result: {
      schemaVersion: 1,
      kind: "pipeline-metrics",
      view: "assessment-queue",
      window: { from: "2026-11-14T00:00:00.000Z", through: "2026-11-20T10:00:00.000Z" },
      coverage: { historyCompleteFrom: null, note: "partial history" },
      days: 7,
      metrics: {
        impact: { firstAssessmentLatency: impactStats },
        complexity: { firstAssessmentLatency: complexityStats },
      },
    },
  });

  it("reads only the impact metric's latency, with unknown kept apart from completed", () => {
    const r = parseLatencyResponse(queue(stats([2, 6], 0, 1), stats([50])), "impact")!;
    expect(r.stats).toMatchObject({ completed: 2, median: 4 * hour, unknown: 1 });
    expect(r.stats.members.completed).toHaveLength(2);
    expect(r.stats.members.unknown).toHaveLength(1);
    expect(r).toMatchObject({
      status: "incomplete",
      coverageNote: "partial history",
      warnings: ["w"],
    });
    expect(parseLatencyResponse(queue({ median: "x" }), "impact")).toBeNull();
    expect(parseLatencyResponse(envelope({}), "impact")).toBeNull();
  });

  it("requests the assessment-queue view with the page's window", async () => {
    const urls: string[] = [];
    const fetcher = (async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify(queue(stats([1]))), { status: 200 });
    }) as typeof fetch;
    const states: unknown[] = [];
    await latencyLoader("/api/v1/metrics", "impact", fetcher, (s) => void states.push(s)).load({
      repository: repo,
      days: 30,
    });
    expect(urls[0]).toBe("/api/v1/metrics?view=assessment-queue&repo=example%2Fproject&days=30");
    expect(states.at(-1)).toMatchObject({ status: "ready", response: { stats: { completed: 1 } } });
  });
});
