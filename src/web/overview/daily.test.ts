/** Overview daily ticket progress (#826): known zero vs unknown, partial day, breakdown. */
import { describe, expect, it } from "vite-plus/test";
import {
  averageText,
  cell,
  dailyLoader,
  dailyWindow,
  parseDailyResponse,
  type DailyState,
} from "./daily.js";

const repo = "example/project";
const fig = (days: unknown[], extra: Record<string, unknown> = {}) => ({
  series: {
    days,
    partial: {
      day: "2026-11-20",
      observedThrough: "2026-11-20T10:00:00Z",
      observed: 1,
      members: [`${repo}#9`],
    },
  },
  average: { value: 0.5, knownDays: 2, unknownDays: 1, totalDays: 3 },
  incomplete: { count: 0, members: [] },
  lowerBound: false,
  byComplexity: {},
  ...extra,
});
const known = (day: string, members: string[]) => ({
  day,
  status: "known",
  count: members.length,
  members,
});
const unknown = (day: string) => ({
  day,
  status: "unknown",
  count: null,
  observed: 0,
  members: [],
});
const body = (
  deliveries = fig([
    unknown("2026-11-17"),
    known("2026-11-18", []),
    known("2026-11-19", [`${repo}#1`]),
  ]),
) => ({
  status: "complete",
  freshness: { observedAt: "2026-11-20T10:00:00Z", stale: false },
  result: {
    kind: "pipeline-metrics",
    view: "daily",
    days: 7,
    coverage: { note: null },
    figures: {
      deliveries,
      attested: fig([]),
      closedCompletedUnverified: fig([]),
      closedNotPlanned: fig([]),
      prMerges: fig([]),
    },
    deliveredDateUnknown: { count: 1, members: [`${repo}#5`] },
  },
});

describe("overview daily ticket progress (#826)", () => {
  it("shows a known zero as 0 and an unread day as unknown, never 0", () => {
    const r = parseDailyResponse(body())!;
    expect(r.series.deliveries.days.map((d) => cell(d))).toEqual(["unknown", "0", "1"]);
    expect(r.deliveredDateUnknown.count).toBe(1);
  });

  it("states the complete-day average with the known days, and marks lower bounds", () => {
    const r = parseDailyResponse(body(fig([known("2026-11-19", [])], { lowerBound: true })))!;
    expect(averageText(r.series.deliveries)).toBe("0.5/day (2 of 3 days known), at least");
    // The partial day is carried apart, not inside the days the average uses.
    expect(r.series.deliveries.partial.members).toEqual([`${repo}#9`]);
  });

  it("keeps the complexity breakdown with its members", () => {
    const r = parseDailyResponse(
      body(
        fig([known("2026-11-19", [`${repo}#1`])], {
          byComplexity: { S: { count: 1, members: [`${repo}#1`] } },
        }),
      ),
    )!;
    expect(r.series.deliveries.byComplexity).toEqual({ S: { count: 1, members: [`${repo}#1`] } });
  });

  it("rejects other views and malformed days", () => {
    expect(parseDailyResponse({ result: { kind: "pipeline-metrics", view: "news" } })).toBeNull();
    expect(parseDailyResponse(body(fig([{ day: "x", status: "known" }])))).toBeNull();
  });

  it("reads the daily view with its window and refreshes past the cache", async () => {
    const urls: string[] = [];
    const fetcher = (async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify(body()), { status: 200 });
    }) as typeof fetch;
    const states: DailyState[] = [];
    const loader = dailyLoader("/api/v1/metrics", fetcher, (s) => void states.push(s));
    await loader.load({ repository: repo, days: 30 });
    expect(urls[0]).toBe("/api/v1/metrics?view=daily&repo=example%2Fproject&days=30");
    await loader.refresh();
    expect(urls[1]).toContain("refresh=true");
    expect(states.at(-1)).toMatchObject({ status: "ready" });
    expect(dailyWindow("?days=30d")).toBe(30);
    expect(dailyWindow("?days=9d")).toBe(7);
  });
});

describe("overview daily: lower bounds (#1186 review)", () => {
  it("shows a lower-bound count as 'at least N' and keeps unknown days unknown", () => {
    expect(cell({ day: "d", status: "known", count: 0, members: [] }, true)).toBe("at least 0");
    expect(cell({ day: "d", status: "known", count: 2, members: [] })).toBe("2");
    expect(cell({ day: "d", status: "unknown", observed: 0, members: [] }, true)).toBe("unknown");
  });
});
