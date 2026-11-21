/** Overview daily ticket progress (#826): known zero vs unknown, partial day, breakdown. */
import { describe, expect, it } from "vite-plus/test";
import {
  averageText,
  cell,
  complexityCell,
  dailyLoader,
  dailyWindow,
  parseDailyResponse,
  prHref,
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
const aligned = (f: ReturnType<typeof fig>) =>
  (f.series.days as { day: string; status: string }[]).map((d) =>
    d.status === "known" ? known(d.day, []) : unknown(d.day),
  );
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
      // The ticket series cover the same days; their counts are zero where known.
      attested: fig(aligned(deliveries)),
      closedCompletedUnverified: fig(aligned(deliveries)),
      closedNotPlanned: fig(aligned(deliveries)),
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

describe("overview daily: unknown days make window totals lower bounds (#1186 review)", () => {
  it("qualifies complexity counts when days are unknown, and rejects misaligned series", () => {
    const r = parseDailyResponse(body())!;
    const d = r.series.deliveries;
    d.lowerBound = false;
    d.average = { value: 1, knownDays: 2, totalDays: 3 };
    d.byComplexity = { S: { count: 1, members: [`${repo}#1`] } };
    // Averaged over known days only: disclosed by the count, not qualified as a lower bound.
    expect(averageText(d)).toBe("1.0/day (2 of 3 days known)");
    expect(averageText({ ...d, lowerBound: true })).toMatch(/, at least$/);
    expect(complexityCell(d, "S")).toBe("at least 1");
    expect(complexityCell(d, "M")).toBe("at least 0");
    const exact = {
      ...d,
      days: d.days.filter((x) => x.status === "known"),
      average: { value: 1, knownDays: 2, totalDays: 2 },
    };
    expect(complexityCell(exact, "S")).toBe("1");
    expect(averageText(exact)).not.toMatch(/at least/);
    const bad = body();
    (bad.result.figures.attested.series as { days: unknown[] }).days = [];
    expect(parseDailyResponse(bad)).toBeNull();
  });
});

describe("overview merged pull requests (#827)", () => {
  it("keeps PR merges as their own series with PR links, separate from ticket counts", () => {
    const b = body();
    (b.result.figures as Record<string, unknown>).prMerges = fig([
      known("2026-11-19", ["example/project#40", "example/project#41", "example/project#42"]),
    ]);
    const r = parseDailyResponse(b)!;
    expect(r.prMerges!.days.map((d) => cell(d))).toEqual(["3"]);
    // Three merges are three PRs, while the delivery series counts tickets on its own.
    expect(r.series.deliveries.days.map((d) => cell(d))).toEqual(["unknown", "0", "1"]);
    expect(prHref("example/project#40")).toBe("https://github.com/example/project/pull/40");
    expect(prHref("nope")).toBeNull();
  });

  it("reports missing merge counts as absent, not zero", () => {
    const b = body();
    delete (b.result.figures as Record<string, unknown>).prMerges;
    expect(parseDailyResponse(b)!.prMerges).toBeNull();
  });
});
