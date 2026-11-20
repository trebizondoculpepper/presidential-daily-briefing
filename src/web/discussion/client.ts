/**
 * Discussion page client (#1103, doc/design/estimation-refinement-loop.md "Discussion view").
 * Parses the `serve-read` envelope of `/api/v1/discussion` (src/briefing/discussion.ts, served by
 * src/serve/api.ts) and loads it with cancellation and late-response rejection. The page presents
 * the server's native order unchanged: it never re-sorts, re-ranks or reconstructs domain policy,
 * and it never hides an item the server supplied.
 */
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The scopes the API accepts; `open` is the default. */
export const discussionScopes = ["open", "closed", "all"] as const;
export type DiscussionScope = (typeof discussionScopes)[number];

export interface DiscussionItem {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  comments: number;
  rank: number;
  why: string;
}

export interface DiscussionResponse {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  scope: DiscussionScope;
  warnings: string[];
  freshness: { observedAt: string; stale: boolean } | null;
  items: DiscussionItem[];
  unknown: { number: number; title: string; url: string }[];
  shown: number;
  omitted: number;
  coverage: { complete: boolean; note: string | null };
}

const item = (v: unknown): v is DiscussionItem =>
  isObject(v) &&
  count(v.number) &&
  typeof v.title === "string" &&
  typeof v.url === "string" &&
  (v.state === "OPEN" || v.state === "CLOSED") &&
  count(v.comments) &&
  count(v.rank) &&
  typeof v.why === "string";

const unread = (v: unknown): v is DiscussionResponse["unknown"][number] =>
  isObject(v) && count(v.number) && typeof v.title === "string" && typeof v.url === "string";

/**
 * Parse the discussion envelope; null when it is not that view. A malformed item makes the whole
 * response unusable rather than showing a partial list as if it were the server's answer.
 */
export function parseDiscussionResponse(body: unknown): DiscussionResponse | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  if (r.kind !== "discussion-view") return null;
  if (!Array.isArray(r.items) || !r.items.every(item)) return null;
  const unknown = Array.isArray(r.unknown) ? r.unknown.filter(unread) : [];
  const selection = isObject(body.selection) ? body.selection : {};
  const coverage = isObject(r.coverage) ? r.coverage : {};
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    repository: typeof selection.repository === "string" ? selection.repository : null,
    scope: r.scope === "closed" || r.scope === "all" || r.scope === "open" ? r.scope : "open",
    warnings: isStrings(body.warnings) ? body.warnings : [],
    freshness:
      isObject(body.freshness) &&
      typeof body.freshness.observedAt === "string" &&
      typeof body.freshness.stale === "boolean"
        ? { observedAt: body.freshness.observedAt, stale: body.freshness.stale }
        : null,
    items: r.items,
    unknown,
    shown: count(r.shown) ? r.shown : r.items.length,
    omitted: count(r.omitted) ? r.omitted : 0,
    coverage: {
      complete: coverage.complete === true,
      note: typeof coverage.note === "string" ? coverage.note : null,
    },
  };
}

export type DiscussionState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: DiscussionResponse }
  | { status: "error"; message: string; code: string | null };

/** The page selection: repository and state scope, validated; `open` is the default. */
export function selection(search: string): { repository: string | null; scope: DiscussionScope } {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  const state = q.get("state");
  return {
    repository: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    scope: state === "closed" || state === "all" ? state : "open",
  };
}

/** What the page says about its scope, including the closed history it is showing. */
export function scopeText(scope: DiscussionScope): string {
  if (scope === "closed") return "Closed issues only.";
  if (scope === "all") return "Open and closed issues, including resolved discussions.";
  return "Open issues only.";
}

/** The comment-count cell: never a bare zero when the count was not read. */
export function commentText(comments: number): string {
  return comments === 1 ? "1 comment" : `${comments} comments`;
}

/** Read the discussion view once; never throws. */
export async function fetchDiscussion(
  api: string,
  repository: string,
  scope: DiscussionScope,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  refresh = false,
): Promise<DiscussionState> {
  const q = new URLSearchParams({ repo: repository, state: scope });
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
      message: "The discussion list could not be read from the server.",
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
          : "The discussion list could not be read from the server.",
      code: error && typeof error.code === "string" ? error.code : null,
    };
  }
  const parsed = parseDiscussionResponse(body);
  if (!parsed)
    return {
      status: "error",
      message: "The server answered with a discussion view this page does not understand.",
      code: null,
    };
  return { status: "ready", response: parsed };
}

/**
 * One loader with cancellation and late-response rejection: a superseded read never overwrites
 * the state of the read that replaced it (the same rule the other API-first pages follow).
 */
export function discussionLoader(
  api: string,
  fetcher: typeof fetch,
  apply: (state: DiscussionState) => void,
) {
  let current: AbortController | null = null;
  let sequence = 0;
  const run = (repository: string, scope: DiscussionScope, refresh: boolean) => {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const mine = ++sequence;
    apply({ status: "loading" });
    return fetchDiscussion(api, repository, scope, fetcher, controller.signal, refresh).then(
      (next) => {
        if (mine !== sequence) return null;
        apply(next);
        return next;
      },
    );
  };
  return {
    load: (repository: string | null, scope: DiscussionScope) =>
      repository ? run(repository, scope, false) : (apply({ status: "no-project" }), null),
    refresh: (repository: string | null, scope: DiscussionScope) =>
      repository ? run(repository, scope, true) : (apply({ status: "no-project" }), null),
    cancel: () => current?.abort(),
  };
}
