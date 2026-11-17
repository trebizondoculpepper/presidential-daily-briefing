/**
 * UTC calendar days, trailing complete-day windows and daily averages for pipeline metrics
 * (#573 slice 4, doc/design/dashboard-pipeline-metrics.md "Days, windows and partial days").
 *
 * Pure over injected instants: no GitHub access and no clock reads.
 */

const DAY_MS = 86_400_000;

/** The UTC calendar day `YYYY-MM-DD` containing an ISO instant, or null if it is not a date. */
export function utcDay(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** The instant a UTC day starts, in milliseconds. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export interface TrailingWindow {
  /** The last `size` complete UTC days, oldest first. */
  days: string[];
  /** The current, incomplete UTC day; never part of an average. */
  partial: { day: string; observedThrough: string };
}

/** The last `size` complete UTC days before `now`, plus the current partial day. */
export function trailingWindow(now: string, size: number): TrailingWindow {
  const t = Date.parse(now);
  if (!Number.isFinite(t)) throw new RangeError(`not an instant: ${now}`);
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`window size must be >= 1`);
  const today = new Date(t).toISOString().slice(0, 10);
  const start = dayStart(today);
  const days: string[] = [];
  for (let i = size; i >= 1; i--)
    days.push(new Date(start - i * DAY_MS).toISOString().slice(0, 10));
  return { days, partial: { day: today, observedThrough: new Date(t).toISOString() } };
}

/**
 * Coverage of one event source over time. Events at or after `completeFrom` are known to be
 * complete; anything earlier is unknown. `null` means the source was not read at all.
 */
export interface DayCoverage {
  completeFrom: string | null;
}

export type DayFigure =
  | { day: string; status: "known"; count: number; members: string[] }
  | { day: string; status: "unknown"; count: null; observed: number; members: string[] };

export interface DailySeries {
  days: DayFigure[];
  partial: { day: string; observedThrough: string; observed: number; members: string[] };
}

/**
 * Bucket events into the window's days. A day is `known` only when coverage was complete from
 * its start; a known day with no events is a zero-event day (count 0). Earlier days are
 * `unknown`, keeping what was observed for drill-down but never presenting it as a count.
 * Events are keyed so a figure and its drill-down members cannot disagree.
 */
export function dailySeries(
  events: readonly { at: string; key: string }[],
  window: TrailingWindow,
  coverage: DayCoverage,
): DailySeries {
  const from = coverage.completeFrom === null ? null : Date.parse(coverage.completeFrom);
  const byDay = new Map<string, string[]>();
  for (const e of events) {
    const day = utcDay(e.at);
    if (day === null) continue;
    const list = byDay.get(day) ?? [];
    if (!list.includes(e.key)) list.push(e.key);
    byDay.set(day, list);
  }
  const days: DayFigure[] = window.days.map((day) => {
    const members = byDay.get(day) ?? [];
    const known = from !== null && Number.isFinite(from) && from <= dayStart(day);
    return known
      ? { day, status: "known", count: members.length, members }
      : { day, status: "unknown", count: null, observed: members.length, members };
  });
  const partialMembers = byDay.get(window.partial.day) ?? [];
  return {
    days,
    partial: { ...window.partial, observed: partialMembers.length, members: partialMembers },
  };
}

export interface DailyAverage {
  /** Mean events per known day; null when no day in the window is known. */
  value: number | null;
  knownDays: number;
  unknownDays: number;
  totalDays: number;
}

/** The complete-day average: zero-event known days count as 0, unknown days are excluded. */
export function dailyAverage(series: DailySeries): DailyAverage {
  const known = series.days.filter((d) => d.status === "known");
  const sum = known.reduce((n, d) => n + (d.count ?? 0), 0);
  return {
    value: known.length === 0 ? null : sum / known.length,
    knownDays: known.length,
    unknownDays: series.days.length - known.length,
    totalDays: series.days.length,
  };
}
