/**
 * Overview daily ticket-progress client (#826): parses `/api/v1/metrics?view=daily`
 * (src/metrics/views.ts `dailyView`) for the four ticket series, kept separate and never summed.
 * Known days carry counts (a zero is a known zero); unknown days carry no count; the current
 * partial day is shown apart and never enters the complete-day averages. Plain strict TypeScript.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export const dailyDays = [7, 30] as const;
export type DailyDays = (typeof dailyDays)[number];

/** The ticket series this section shows, in display order, with their labels. */
export const ticketSeries = [
  ["deliveries", "Verified deliveries"],
  ["attested", "Attested"],
  ["closedCompletedUnverified", "Closed completed, unverified"],
  ["closedNotPlanned", "Closed not planned"],
] as const;
export type SeriesName = (typeof ticketSeries)[number][0];

export type Day =
  | { day: string; status: "known"; count: number; members: string[] }
  | { day: string; status: "unknown"; observed: number; members: string[] };
export interface Series {
  days: Day[];
  partial: { day: string; observedThrough: string; observed: number; members: string[] };
  average: { value: number | null; knownDays: number; totalDays: number };
  incomplete: { count: number; members: string[] };
  lowerBound: boolean;
  byComplexity: Record<string, { count: number; members: string[] }>;
}
export interface DailyResponse {
  status: "complete" | "incomplete" | "error";
  warnings: string[];
  observedAt: string | null;
  coverageNote: string | null;
  days: number;
  series: Record<SeriesName, Series>;
  deliveredDateUnknown: { count: number; members: string[] };
}

function day(v: unknown): Day | null {
  if (!isObject(v) || typeof v.day !== "string" || !isStrings(v.members)) return null;
  if (v.status === "known" && typeof v.count === "number")
    return { day: v.day, status: "known", count: v.count, members: v.members };
  if (v.status === "unknown")
    return {
      day: v.day,
      status: "unknown",
      observed: typeof v.observed === "number" ? v.observed : 0,
      members: v.members,
    };
  return null;
}

function series(v: unknown): Series | null {
  if (!isObject(v) || !isObject(v.series) || !isObject(v.average) || !isObject(v.incomplete))
    return null;
  const s = v.series;
  if (!Array.isArray(s.days) || !isObject(s.partial)) return null;
  const days: Day[] = [];
  for (const d of s.days) {
    const x = day(d);
    if (!x) return null;
    days.push(x);
  }
  const p = s.partial;
  if (typeof p.day !== "string" || typeof p.observedThrough !== "string" || !isStrings(p.members))
    return null;
  const by: Series["byComplexity"] = {};
  if (isObject(v.byComplexity))
    for (const [g, e] of Object.entries(v.byComplexity))
      if (isObject(e) && typeof e.count === "number" && isStrings(e.members))
        by[g] = { count: e.count, members: e.members };
  const a = v.average;
  return {
    days,
    partial: {
      day: p.day,
      observedThrough: p.observedThrough,
      observed: typeof p.observed === "number" ? p.observed : 0,
      members: p.members,
    },
    average: {
      value: typeof a.value === "number" ? a.value : null,
      knownDays: typeof a.knownDays === "number" ? a.knownDays : 0,
      totalDays: typeof a.totalDays === "number" ? a.totalDays : days.length,
    },
    incomplete: {
      count: typeof v.incomplete.count === "number" ? v.incomplete.count : 0,
      members: isStrings(v.incomplete.members) ? v.incomplete.members : [],
    },
    lowerBound: v.lowerBound === true,
    byComplexity: by,
  };
}

/** Parse the daily envelope; null when it is not one. */
export function parseDailyResponse(body: unknown): DailyResponse | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  if (r.kind !== "pipeline-metrics" || r.view !== "daily" || !isObject(r.figures)) return null;
  const out = {} as Record<SeriesName, Series>;
  for (const [name] of ticketSeries) {
    const s = series(r.figures[name]);
    if (!s) return null;
    out[name] = s;
  }
  // Every series must cover the same days in the same order: the table indexes them together.
  const sequence = (n: SeriesName) => out[n].days.map((d) => d.day).join("|");
  if (ticketSeries.some(([n]) => sequence(n) !== sequence(ticketSeries[0]![0]))) return null;
  const u = isObject(r.deliveredDateUnknown) ? r.deliveredDateUnknown : {};
  const f = isObject(body.freshness) ? body.freshness : {};
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    warnings: isStrings(body.warnings) ? body.warnings : [],
    observedAt: typeof f.observedAt === "string" ? f.observedAt : null,
    coverageNote:
      isObject(r.coverage) && typeof r.coverage.note === "string" ? r.coverage.note : null,
    days: typeof r.days === "number" ? r.days : 7,
    series: out,
    deliveredDateUnknown: {
      count: typeof u.count === "number" ? u.count : 0,
      members: isStrings(u.members) ? u.members : [],
    },
  };
}

/**
 * A day cell: a known count (zero included), "unknown" for an unread day (never 0), and "at least
 * N" when the figure is a lower bound because some tickets' evidence is missing.
 */
export const cell = (d: Day, lowerBound = false): string =>
  d.status === "unknown" ? "unknown" : lowerBound ? `at least ${d.count}` : String(d.count);

/**
 * Whether a window total is only an observed lower bound: some tickets' evidence is missing, or
 * some days in the window were not read (#1186 review). Unknown is never shown as exact.
 */
export const windowLowerBound = (s: Series): boolean =>
  s.lowerBound ||
  s.days.some((d) => d.status === "unknown") ||
  s.average.knownDays < s.average.totalDays;

/** The complete-day average text, with how many days are known. */
export function averageText(s: Series): string {
  const v = s.average.value === null ? "unknown" : s.average.value.toFixed(1);
  // The average is over known days only, so unknown days are disclosed by the known-day count,
  // not by "at least"; only missing ticket evidence makes it a lower bound (#1186 review).
  const qualify = s.average.value !== null && s.lowerBound;
  return `${v}/day (${s.average.knownDays} of ${s.average.totalDays} days known)${qualify ? ", at least" : ""}`;
}

/** A complexity total for the window: "at least N" whenever the window is a lower bound. */
export const complexityCell = (s: Series, group: string): string => {
  const n = s.byComplexity[group]?.count ?? 0;
  return windowLowerBound(s) ? `at least ${n}` : String(n);
};

export type DailyState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: DailyResponse }
  | { status: "error"; message: string; code: string | null };

/** One loader for the daily view: aborts the previous read; only the newest is reported. */
export function dailyLoader(api: string, fetcher: typeof fetch, report: (s: DailyState) => void) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null = null;
  let last: { repository: string | null; days: DailyDays } = { repository: null, days: 7 };
  const read = async (sel: typeof last, refresh: boolean): Promise<DailyState | null> => {
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
    const q = new URLSearchParams({ view: "daily", repo: sel.repository, days: String(sel.days) });
    if (refresh) q.set("refresh", "true");
    let state: DailyState;
    try {
      const response = await fetcher(`${api}?${q}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const error = isObject(body) && isObject(body.error) ? body.error : null;
        state = {
          status: "error",
          message:
            typeof error?.message === "string"
              ? error.message
              : `Daily counts could not be read (HTTP ${response.status}).`,
          code: typeof error?.code === "string" ? error.code : null,
        };
      } else {
        const parsed = parseDailyResponse(body);
        state = parsed
          ? { status: "ready", response: parsed }
          : {
              status: "error",
              message: "The server returned daily counts in a format this page does not read.",
              code: null,
            };
      }
    } catch {
      state = {
        status: "error",
        message: "Daily counts could not be read from the server.",
        code: null,
      };
    }
    if (mine !== sequence || controller.signal.aborted) return null;
    report(state);
    return state;
  };
  return {
    load: (sel: typeof last) =>
      JSON.stringify(sel) === loaded ? Promise.resolve(null) : read(sel, false),
    refresh: () => read(last, true),
    reload: () => read(last, false),
  };
}

/** The page's daily window from the URL (`days=7d|30d`), defaulting to 7. */
export const dailyWindow = (search: string): DailyDays =>
  new URLSearchParams(search).get("days") === "30d" ? 30 : 7;
