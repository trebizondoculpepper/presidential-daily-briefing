/**
 * Timing page client (#820, doc/design/dashboard-pipeline-metrics.md "Timing (#576)" with
 * dashboard-metric-owner-decisions.md taking precedence): parses the `serve-read` envelope of
 * `/api/v1/metrics?view=timing` (src/metrics/views.ts `timingView`) and loads it with
 * cancellation and late-response rejection. Plain strict TypeScript; the component only presents
 * it. The chart and the table read the same parsed groups, so they cannot disagree, and every
 * figure's drill-down is the server's own member list.
 */
import type { DurationStats } from "../../metrics/aggregate.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const numOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v));
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export const timingDays = [7, 30] as const;
export type TimingDays = (typeof timingDays)[number];

export interface TimingGroup {
  name: string;
  stats: DurationStats;
}

export interface TimingResponse {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  warnings: string[];
  freshness: { source: string; observedAt: string; ageSeconds: number; stale: boolean } | null;
  window: { from: string; through: string };
  cohort: string;
  coverageNote: string | null;
  groups: TimingGroup[];
}

function validStats(v: unknown): v is DurationStats {
  if (!isObject(v) || !isObject(v.open) || !isObject(v.members)) return false;
  const m = v.members;
  return (
    numOrNull(v.median) &&
    numOrNull(v.mean) &&
    count(v.completed) &&
    numOrNull(v.p75) &&
    numOrNull(v.p90) &&
    count(v.open.count) &&
    numOrNull(v.open.longestElapsedMs) &&
    count(v.unknown) &&
    count(v.closedUndelivered) &&
    isStrings(m.completed) &&
    isStrings(m.open) &&
    isStrings(m.unknown) &&
    isStrings(m.closedUndelivered)
  );
}

/**
 * Complexity groups in display order: sizes smallest to largest, then the explicit unassessed,
 * stale, conflict and unknown groups, then anything else the server names (kept, never dropped).
 */
const sizeOrder = ["XS", "S", "M", "L", "XL", "XXL"];
const explicitOrder = ["unassessed", "stale", "conflict", "unknown"];
export function groupOrder(names: readonly string[]): string[] {
  const rank = (n: string) => {
    const s = sizeOrder.indexOf(n);
    if (s >= 0) return s;
    const e = explicitOrder.indexOf(n);
    return e >= 0 ? sizeOrder.length + e : sizeOrder.length + explicitOrder.length;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Parse the timing envelope; null when it is not one. */
export function parseTimingResponse(body: unknown): TimingResponse | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  if (r.kind !== "pipeline-metrics" || r.view !== "timing") return null;
  if (
    !isObject(r.window) ||
    typeof r.window.from !== "string" ||
    typeof r.window.through !== "string"
  )
    return null;
  if (typeof r.cohort !== "string" || !isObject(r.groups)) return null;
  const groups: TimingGroup[] = [];
  for (const name of groupOrder(Object.keys(r.groups))) {
    const stats = r.groups[name];
    if (!validStats(stats)) return null;
    groups.push({ name, stats });
  }
  const selection = isObject(body.selection) ? body.selection : {};
  const f = isObject(body.freshness) ? body.freshness : null;
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    repository: typeof selection.repository === "string" ? selection.repository : null,
    warnings: isStrings(body.warnings) ? body.warnings : [],
    freshness:
      f &&
      typeof f.source === "string" &&
      typeof f.observedAt === "string" &&
      typeof f.ageSeconds === "number" &&
      typeof f.stale === "boolean"
        ? { source: f.source, observedAt: f.observedAt, ageSeconds: f.ageSeconds, stale: f.stale }
        : null,
    window: { from: r.window.from, through: r.window.through },
    cohort: r.cohort,
    coverageNote:
      isObject(r.coverage) && typeof r.coverage.note === "string" ? r.coverage.note : null,
    groups,
  };
}

/** A duration for people: minutes under two hours, hours under three days, else days. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = ms / 60_000;
  if (minutes < 120) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 72) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/**
 * Bars for the chart: one per group with completed samples, scaled to the largest median or
 * mean so both markers fit. Groups without completed samples get no bar (their counts are in
 * the table), never a zero-length bar that reads as zero time.
 */
export function chartBars(groups: readonly TimingGroup[]) {
  const withData = groups.filter((g) => g.stats.median !== null);
  const max = Math.max(1, ...withData.flatMap((g) => [g.stats.median ?? 0, g.stats.mean ?? 0]));
  return withData.map((g) => ({
    name: g.name,
    median: g.stats.median!,
    mean: g.stats.mean,
    medianPct: (100 * g.stats.median!) / max,
    meanPct: g.stats.mean === null ? null : (100 * g.stats.mean) / max,
    completed: g.stats.completed,
  }));
}

/** The ticket drill-down for a member key such as `owner/name#12`; null when not one. */
export function ticketLink(member: string, search: string): string | null {
  const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(member);
  if (!m) return null;
  const q = new URLSearchParams({ repo: m[1]!, n: m[2]! });
  const keep = new URLSearchParams(search);
  for (const k of ["role", "agent"]) {
    const v = keep.get(k);
    if (v) q.set(k, v);
  }
  return `/ticket?${q}`;
}

export type TimingState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: TimingResponse }
  | { status: "error"; message: string; code: string | null };

/** The page selection: repository and window, validated; days defaults to 7. */
export function selection(search: string): { repository: string | null; days: TimingDays } {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  const days = Number(q.get("days"));
  return {
    repository: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    days: days === 30 ? 30 : 7,
  };
}

/** Read the timing view once; never throws. */
export async function fetchTiming(
  api: string,
  repository: string,
  days: TimingDays,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  refresh = false,
): Promise<TimingState> {
  const q = new URLSearchParams({ view: "timing", repo: repository, days: String(days) });
  if (refresh) q.set("refresh", "true");
  let response: Response;
  try {
    response = await fetcher(`${api}?${q}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return {
      status: "error",
      message: "The timing figures could not be read from the server.",
      code: null,
    };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = isObject(body) && isObject(body.error) ? body.error : null;
    return {
      status: "error",
      message:
        error && typeof error.message === "string"
          ? error.message
          : `The timing figures could not be read (HTTP ${response.status}).`,
      code: error && typeof error.code === "string" ? error.code : null,
    };
  }
  const parsed = parseTimingResponse(body);
  return parsed
    ? { status: "ready", response: parsed }
    : {
        status: "error",
        message: "The server returned timing figures in a format this page does not read.",
        code: null,
      };
}

/**
 * One loader: each read aborts the previous one and only the newest result is reported, so a
 * project or window change never shows another selection's figures. `refresh` bypasses the
 * server's cache; `load` skips an unchanged selection.
 */
export function timingLoader(
  api: string,
  fetcher: typeof fetch,
  report: (state: TimingState) => void,
) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null = null;
  let last: { repository: string | null; days: TimingDays } = { repository: null, days: 7 };
  const read = async (
    sel: { repository: string | null; days: TimingDays },
    refresh: boolean,
  ): Promise<TimingState | null> => {
    last = sel;
    loaded = JSON.stringify(sel);
    current?.abort();
    const mine = ++sequence;
    if (!sel.repository) {
      current = null;
      report({ status: "no-project" });
      return null;
    }
    const controller = new AbortController();
    current = controller;
    report({ status: "loading" });
    const state = await fetchTiming(
      api,
      sel.repository,
      sel.days,
      fetcher,
      controller.signal,
      refresh,
    );
    if (mine !== sequence || controller.signal.aborted) return null;
    report(state);
    return state;
  };
  return {
    load: (sel: { repository: string | null; days: TimingDays }) =>
      JSON.stringify(sel) === loaded ? Promise.resolve(null) : read(sel, false),
    refresh: () => read(last, true),
  };
}
