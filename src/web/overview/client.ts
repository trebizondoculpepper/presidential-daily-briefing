/**
 * Overview page client (#824, doc/design/dashboard-pipeline-metrics.md "Overview / News (#574)"):
 * parses `/api/v1/metrics?view=news` (src/metrics/views.ts `newsView`) and loads it with
 * cancellation and late-response rejection. Plain strict TypeScript; the component only presents
 * it. Items stay in the server's order (newest first); nothing here re-derives events.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Owner default: 6 hours, with 1 hour as the alternative. */
export const newsHours = [6, 1] as const;
export type NewsHours = (typeof newsHours)[number];

export interface NewsItem {
  at: string;
  kind: string;
  member: string;
  key: string;
  detail: string | null;
}

export interface NewsResponse {
  status: "complete" | "incomplete" | "error";
  warnings: string[];
  freshness: { observedAt: string; stale: boolean } | null;
  window: { from: string; through: string };
  coverageNote: string | null;
  items: NewsItem[];
  omitted: number;
  incomplete: { count: number; members: string[] };
}

/** Parse the news envelope; null when it is not one. */
export function parseNewsResponse(body: unknown): NewsResponse | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  if (r.kind !== "pipeline-metrics" || r.view !== "news") return null;
  if (
    !isObject(r.window) ||
    typeof r.window.from !== "string" ||
    typeof r.window.through !== "string"
  )
    return null;
  if (!Array.isArray(r.items) || typeof r.omitted !== "number" || !isObject(r.incomplete))
    return null;
  const items: NewsItem[] = [];
  for (const i of r.items) {
    if (
      !isObject(i) ||
      typeof i.at !== "string" ||
      typeof i.kind !== "string" ||
      typeof i.member !== "string" ||
      typeof i.key !== "string" ||
      !(i.detail === null || typeof i.detail === "string")
    )
      return null;
    items.push({ at: i.at, kind: i.kind, member: i.member, key: i.key, detail: i.detail });
  }
  if (typeof r.incomplete.count !== "number" || !isStrings(r.incomplete.members)) return null;
  const f = isObject(body.freshness) ? body.freshness : null;
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    warnings: isStrings(body.warnings) ? body.warnings : [],
    freshness:
      f && typeof f.observedAt === "string" && typeof f.stale === "boolean"
        ? { observedAt: f.observedAt, stale: f.stale }
        : null,
    window: { from: r.window.from, through: r.window.through },
    coverageNote:
      isObject(r.coverage) && typeof r.coverage.note === "string" ? r.coverage.note : null,
    items,
    omitted: r.omitted,
    incomplete: { count: r.incomplete.count, members: r.incomplete.members },
  };
}

/** A label for each ledger event kind; an unknown kind is shown as it was supplied. */
export function kindLabel(kind: string): string {
  return (
    (
      {
        created: "Created",
        "picked-up": "Picked up",
        released: "Released",
        delivery: "Delivery record",
        "pr-merged": "PR merged",
        closed: "Closed",
        reopened: "Reopened",
      } as Record<string, string>
    )[kind] ?? kind
  );
}

const ref = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
/**
 * The evidence links for one item: its ticket in the ticket view, and for a merge the PR on
 * GitHub. A merge from the pull-request walk has no ticket (its member is the PR itself).
 */
export function itemLinks(item: NewsItem, search: string) {
  const keep = new URLSearchParams(search);
  const ticket = (m: RegExpExecArray) => {
    const q = new URLSearchParams({ repo: m[1]!, n: m[2]! });
    for (const k of ["role", "agent"]) {
      const v = keep.get(k);
      if (v) q.set(k, v);
    }
    return `/ticket?${q}`;
  };
  const pr = item.kind === "pr-merged" && item.detail ? ref.exec(item.detail) : null;
  const member = ref.exec(item.member);
  const walked = pr && item.member === item.detail;
  return {
    ticket: member && !walked ? { label: item.member, href: ticket(member) } : null,
    pr: pr ? { label: item.detail!, href: `https://github.com/${pr[1]}/pull/${pr[2]}` } : null,
  };
}

export type NewsState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: NewsResponse }
  | { status: "error"; message: string; code: string | null };

/** The page selection: repository and news window, validated; the window defaults to 6h. */
export function selection(search: string): { repository: string | null; hours: NewsHours } {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  return {
    repository: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    hours: q.get("news") === "1h" ? 1 : 6,
  };
}

/** Read the news view once; never throws. */
export async function fetchNews(
  api: string,
  repository: string,
  hours: NewsHours,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  refresh = false,
): Promise<NewsState> {
  const q = new URLSearchParams({ view: "news", repo: repository, hours: String(hours) });
  if (refresh) q.set("refresh", "true");
  let response: Response;
  try {
    response = await fetcher(`${api}?${q}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { status: "error", message: "The news could not be read from the server.", code: null };
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
          : `The news could not be read (HTTP ${response.status}).`,
      code: error && typeof error.code === "string" ? error.code : null,
    };
  }
  const parsed = parseNewsResponse(body);
  return parsed
    ? { status: "ready", response: parsed }
    : {
        status: "error",
        message: "The server returned news in a format this page does not read.",
        code: null,
      };
}

/** One loader: each read aborts the previous one; only the newest result is reported. */
export function newsLoader(api: string, fetcher: typeof fetch, report: (state: NewsState) => void) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null = null;
  let last: { repository: string | null; hours: NewsHours } = { repository: null, hours: 6 };
  const read = async (sel: typeof last, refresh: boolean): Promise<NewsState | null> => {
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
    const state = await fetchNews(
      api,
      sel.repository,
      sel.hours,
      fetcher,
      controller.signal,
      refresh,
    );
    if (mine !== sequence || controller.signal.aborted) return null;
    report(state);
    return state;
  };
  return {
    load: (sel: typeof last) =>
      JSON.stringify(sel) === loaded ? Promise.resolve(null) : read(sel, false),
    refresh: () => read(last, true),
  };
}
