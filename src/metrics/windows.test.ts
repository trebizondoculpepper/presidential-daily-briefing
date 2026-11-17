import { describe, expect, it } from "vite-plus/test";
import { dailyAverage, dailySeries, trailingWindow, utcDay } from "./windows.js";

describe("UTC days and trailing windows (#573 slice 4)", () => {
  it("buckets by UTC day at the exact boundaries", () => {
    expect(utcDay("2026-11-10T23:59:59.999Z")).toBe("2026-11-10");
    expect(utcDay("2026-11-11T00:00:00.000Z")).toBe("2026-11-11");
    // An offset instant is converted to UTC, never bucketed by local time.
    expect(utcDay("2026-11-11T01:30:00+02:00")).toBe("2026-11-10");
    expect(utcDay("not a date")).toBeNull();
  });

  it("lists the last complete days and keeps the current day partial", () => {
    const w = trailingWindow("2026-11-17T09:15:00.000Z", 7);
    expect(w.days).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
    ]);
    expect(w.partial).toEqual({ day: "2026-11-17", observedThrough: "2026-11-17T09:15:00.000Z" });
    // Exactly midnight: the new day has just begun and is partial.
    expect(trailingWindow("2026-11-17T00:00:00.000Z", 1).days).toEqual(["2026-11-16"]);
    expect(() => trailingWindow("2026-11-17T00:00:00Z", 0)).toThrow(RangeError);
  });
});

describe("daily series and complete-day averages (#573 slice 4)", () => {
  const w = trailingWindow("2026-11-17T09:15:00.000Z", 7);
  const events = [
    { at: "2026-11-10T23:59:59.999Z", key: "#1" },
    { at: "2026-11-11T00:00:00.000Z", key: "#2" },
    { at: "2026-11-11T08:00:00.000Z", key: "#3" },
    // The same event seen through two reads is one event.
    { at: "2026-11-11T08:00:00.000Z", key: "#3" },
    { at: "2026-11-17T08:00:00.000Z", key: "#9" },
  ];

  it("counts zero-event known days as 0 and excludes the partial day", () => {
    const s = dailySeries(events, w, { completeFrom: "2026-11-01T00:00:00Z" });
    expect(s.days.map((d) => d.count)).toEqual([1, 2, 0, 0, 0, 0, 0]);
    expect(s.days[1]).toMatchObject({ status: "known", members: ["#2", "#3"] });
    expect(s.partial).toMatchObject({ day: "2026-11-17", observed: 1, members: ["#9"] });
    expect(dailyAverage(s)).toEqual({ value: 3 / 7, knownDays: 7, unknownDays: 0, totalDays: 7 });
  });

  it("marks days before complete coverage unknown and averages only known days", () => {
    // Coverage starts mid-day on the 11th: the 10th and 11th are unknown, not zero.
    const s = dailySeries(events, w, { completeFrom: "2026-11-11T06:00:00Z" });
    expect(s.days[0]).toMatchObject({ status: "unknown", count: null, observed: 1 });
    expect(s.days[1]).toMatchObject({ status: "unknown", count: null, observed: 2 });
    expect(s.days[2]).toMatchObject({ status: "known", count: 0 });
    expect(dailyAverage(s)).toEqual({ value: 0, knownDays: 5, unknownDays: 2, totalDays: 7 });
  });

  it("gives no average when nothing in the window is known", () => {
    const s = dailySeries(events, w, { completeFrom: null });
    expect(s.days.every((d) => d.status === "unknown")).toBe(true);
    expect(dailyAverage(s).value).toBeNull();
  });

  it("keeps each figure equal to its drill-down membership", () => {
    const s = dailySeries(events, w, { completeFrom: "2026-11-01T00:00:00Z" });
    for (const d of s.days) if (d.status === "known") expect(d.count).toBe(d.members.length);
  });
});
