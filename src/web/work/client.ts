/**
 * Work preview client (#753, doc/design/svelte-work-spike.md). Plain strict TypeScript, so `tsc`
 * checks it; the Svelte component only presents its states.
 *
 * It parses the existing `/api/v1/briefing` envelope (the CLI's `--json` briefing) into rows in
 * the order the native policy supplied, keys every row by repository plus stable action ID, keeps
 * the set of open rows across refreshes by identity, and loads details from the existing
 * `/api/v1/tickets/N` route only when a row is expanded. Nothing here sorts, filters or decides
 * eligibility: reasons, commands, ownership and omissions are displayed as supplied.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The page's selection: project, role and agent. Every cache and request is scoped to it. */
export interface WorkContext {
  repository: string;
  role: string | null;
  agent: string | null;
}
export const contextKey = (c: WorkContext): string =>
  JSON.stringify([c.repository.toLowerCase(), c.role ?? "", c.agent ?? ""]);

export interface WorkRow {
  /** Canonical repository plus the native action ID: never an array position. */
  key: string;
  id: string;
  kind: string;
  target: string;
  number: number | null;
  title: string;
  /** Badges as supplied: the decision rules and the reason codes. */
  ruleIds: string[];
  reasonCodes: string[];
  why: string | null;
  nextCommand: string | null;
  owners: string[];
  /** Ownership and blocker evidence as supplied by the subject. */
  labels: string[];
  impact: string | null;
  complexity: string | null;
}

export interface WorkQueue {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  warnings: string[];
  freshness: { source: string; observedAt: string; ageSeconds: number; stale: boolean } | null;
  rows: WorkRow[];
  /** Shown and total counts, from the service; unknown is never zero work. */
  shown: number;
  total: number | null;
  omitted: number | null;
}

const issueNumber = (url: string): number | null => {
  const m = /\/(?:issues|pull)\/([1-9]\d*)$/.exec(url);
  return m ? Number(m[1]) : null;
};

function parseRow(
  repository: string,
  a: unknown,
  subjects: ReadonlyMap<string, Record<string, unknown>>,
): WorkRow | null {
  if (!isObject(a)) return null;
  const id = str(a.id);
  const kind = str(a.kind);
  const target = str(a.target);
  if (!id || !kind || !target) return null;
  const subject = subjects.get(target) ?? {};
  const why = isObject(a.why) ? str(a.why.text) : null;
  const size = (v: unknown): string | null => (isObject(v) ? str(v.size) : null);
  return {
    key: `${repository.toLowerCase()} ${id}`,
    id,
    kind,
    target,
    number: issueNumber(target),
    title: str(subject.title) ?? target,
    ruleIds: isStrings(a.ruleIds) ? a.ruleIds : [],
    reasonCodes: isStrings(a.reasonCodes) ? a.reasonCodes : [],
    why,
    nextCommand: str(a.nextCommand),
    owners: isStrings(subject.owners) ? subject.owners : [],
    labels: isStrings(subject.labels) ? subject.labels : [],
    impact: size(a.impact),
    complexity: size(a.complexity),
  };
}

/** Parse the `serve-read` envelope of `/api/v1/briefing`; null when it is not one. */
export function parseWorkQueue(body: unknown): WorkQueue | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const result = body.result;
  const selection = isObject(body.selection) ? body.selection : {};
  const repository = str(selection.repository) ?? str(result.repository);
  const ranked = isObject(result.rankedActions) ? result.rankedActions : null;
  if (!repository || !ranked || !Array.isArray(ranked.items)) return null;
  // The briefing's subjects are a CompactSubject[] (src/briefing/compact.ts), keyed here by URL.
  const subjects = new Map<string, Record<string, unknown>>();
  if (Array.isArray(result.subjects))
    for (const subject of result.subjects)
      if (isObject(subject) && typeof subject.url === "string") subjects.set(subject.url, subject);
  const rows: WorkRow[] = [];
  for (const item of ranked.items) {
    const row = parseRow(repository, item, subjects);
    if (!row) return null;
    rows.push(row);
  }
  const f = isObject(body.freshness) ? body.freshness : null;
  const freshness =
    f &&
    typeof f.source === "string" &&
    typeof f.observedAt === "string" &&
    typeof f.ageSeconds === "number" &&
    typeof f.stale === "boolean"
      ? { source: f.source, observedAt: f.observedAt, ageSeconds: f.ageSeconds, stale: f.stale }
      : null;
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    repository,
    warnings: isStrings(body.warnings) ? body.warnings : [],
    freshness,
    rows,
    shown: rows.length,
    total: typeof ranked.total === "number" ? ranked.total : null,
    omitted: typeof ranked.omitted === "number" ? ranked.omitted : null,
  };
}

/**
 * The open rows after a refresh (contract "Rows and expansion"): keep every open key that still
 * occurs, drop the rest. Keys are action identities, so a reordered row keeps its state and a
 * different action on the same issue does not inherit another's.
 */
export function reconcileOpen(open: ReadonlySet<string>, rows: readonly WorkRow[]): Set<string> {
  const present = new Set(rows.map((r) => r.key));
  return new Set([...open].filter((k) => present.has(k)));
}

/** Where focus goes when the focused row disappears: the nearest surviving row, else null. */
export function focusAfter(
  focused: string,
  before: readonly WorkRow[],
  after: readonly WorkRow[],
): string | null {
  if (after.some((r) => r.key === focused)) return focused;
  const at = before.findIndex((r) => r.key === focused);
  const survivors = new Set(after.map((r) => r.key));
  for (let d = 1; at >= 0 && d < before.length; d++) {
    for (const i of [at + d, at - d])
      if (i >= 0 && i < before.length && survivors.has(before[i]!.key)) return before[i]!.key;
  }
  return null;
}

/** The queue's view state. Refreshing keeps the earlier queue visible, labelled as updating. */
export type QueueState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; queue: WorkQueue; updating: boolean }
  | { status: "error"; message: string; code: string | null; previous: WorkQueue | null };

async function readJson(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string; code: string | null }> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" }, signal });
  } catch {
    return { ok: false, message: "The server could not be reached.", code: null };
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
      ok: false,
      message: str(error?.message) ?? `The server answered HTTP ${response.status}.`,
      code: str(error?.code),
    };
  }
  return { ok: true, body };
}

export const queueUrl = (api: string, c: WorkContext, refresh: boolean): string => {
  const q = new URLSearchParams({ repo: c.repository });
  if (c.role) q.set("role", c.role);
  if (c.agent) q.set("agent", c.agent);
  if (refresh) q.set("refresh", "true");
  return `${api}?${q}`;
};

/**
 * The queue loader: each read aborts the previous one, and a result from an older read or
 * another context is discarded even if it completes after a newer read started. A refresh of the
 * same context keeps the earlier queue visible as updating; a context change never shows another
 * context's rows.
 */
export function queueLoader(
  api: string,
  fetcher: typeof fetch,
  report: (state: QueueState, context: WorkContext | null) => void,
) {
  let generation = 0;
  let current: AbortController | null = null;
  let context: WorkContext | null = null;
  let shown: WorkQueue | null = null;
  const read = async (next: WorkContext | null, refresh: boolean): Promise<QueueState | null> => {
    const sameContext = !!next && !!context && contextKey(next) === contextKey(context);
    current?.abort();
    const mine = ++generation;
    context = next;
    if (!next) {
      current = null;
      shown = null;
      report({ status: "no-project" }, null);
      return null;
    }
    if (!sameContext) shown = null;
    const controller = new AbortController();
    current = controller;
    report(shown ? { status: "ready", queue: shown, updating: true } : { status: "loading" }, next);
    const read = await readJson(queueUrl(api, next, refresh), fetcher, controller.signal);
    // A newer read or context superseded this one, even if its request raced to completion.
    if (mine !== generation || controller.signal.aborted) return null;
    let state: QueueState;
    if (!read.ok)
      state = { status: "error", message: read.message, code: read.code, previous: shown };
    else {
      const queue = parseWorkQueue(read.body);
      if (!queue)
        state = {
          status: "error",
          message: "The server returned a briefing in a format this page does not read.",
          code: null,
          previous: shown,
        };
      else {
        shown = queue;
        state = { status: "ready", queue, updating: false };
      }
    }
    report(state, next);
    return state;
  };
  return {
    load: (next: WorkContext | null) => read(next, false),
    refresh: () => read(context, true),
  };
}

/** The parts of the existing `ticket-status` document (src/workflow/ticketstatus.ts) shown inline. */
export interface TicketDetail {
  title: string;
  state: string;
  url: string;
  ownership: string | null;
  delivery: string | null;
  pullRequests: { number: number; url: string }[];
  nextSteps: { kind: string; why: string; command: string | null }[];
  complete: boolean;
  warnings: string[];
}

/** Parse the `serve-read` envelope of `/api/v1/tickets/N`; null when it is not one. */
export function parseTicketDetail(body: unknown): TicketDetail | null {
  if (!isObject(body) || !isObject(body.result)) return null;
  const r = body.result;
  const title = str(r.title);
  const state = str(r.state);
  const url = str(r.url);
  if (r.kind !== "ticket-status" || !title || !state || !url) return null;
  const pullRequests = Array.isArray(r.pullRequests)
    ? r.pullRequests.flatMap((p) =>
        isObject(p) && typeof p.number === "number" && typeof p.url === "string"
          ? [{ number: p.number, url: p.url }]
          : [],
      )
    : [];
  const nextSteps = Array.isArray(r.nextSteps)
    ? r.nextSteps.flatMap((n) =>
        isObject(n) && typeof n.kind === "string" && typeof n.why === "string"
          ? [{ kind: n.kind, why: n.why, command: str(n.command) }]
          : [],
      )
    : [];
  const completeness = isObject(r.completeness) ? r.completeness : {};
  return {
    title,
    state,
    url,
    ownership: isObject(r.ownership) ? str(r.ownership.answer) : null,
    delivery: isObject(r.delivery) ? str(r.delivery.verdict) : null,
    pullRequests,
    nextSteps,
    complete: completeness.complete === true,
    warnings: [
      ...(isStrings(completeness.warnings) ? completeness.warnings : []),
      ...(isStrings(body.warnings) ? body.warnings : []),
    ],
  };
}

export type DetailState =
  | { status: "loading" }
  | { status: "ready"; detail: TicketDetail }
  | { status: "error"; message: string };

/**
 * Details, loaded only when a row is expanded, cached per context and ticket, with concurrent
 * requests for the same ticket coalesced. `reset` on a context change aborts pending reads and
 * drops every cached detail, so another context's details never leak.
 */
export function detailLoader(api: string, fetcher: typeof fetch) {
  let scope = "";
  let generation = 0;
  let controller = new AbortController();
  const cache = new Map<string, Promise<DetailState>>();
  const drop = () => {
    controller.abort();
    controller = new AbortController();
    cache.clear();
    generation++;
  };
  return {
    /** A context change: abort pending reads and drop every cached detail. */
    reset(c: WorkContext | null) {
      const next = c ? contextKey(c) : "";
      if (next === scope) return;
      drop();
      scope = next;
    },
    /**
     * A completed refresh of the same context: details from before it are older evidence than
     * the new list, so pending and cached ones are discarded and must be read again.
     */
    invalidate: drop,
    /** The generation a load starts in; pass it to `current` before accepting the result. */
    generation: () => generation,
    load(c: WorkContext, number: number): Promise<DetailState> {
      this.reset(c);
      const key = `${scope} ${number}`;
      const pending = cache.get(key);
      if (pending) return pending;
      const q = new URLSearchParams({ repo: c.repository });
      if (c.agent) q.set("agent", c.agent);
      const promise = readJson(`${api}/${number}?${q}`, fetcher, controller.signal).then(
        (read): DetailState => {
          if (!read.ok) {
            cache.delete(key);
            return { status: "error", message: read.message };
          }
          const detail = parseTicketDetail(read.body);
          if (!detail) {
            cache.delete(key);
            return {
              status: "error",
              message: "The ticket detail is in a format this page does not read.",
            };
          }
          return { status: "ready", detail };
        },
      );
      cache.set(key, promise);
      return promise;
    },
    /** Whether a result loaded in generation `loaded` is still current for this context. */
    current: (c: WorkContext, loaded: number) => contextKey(c) === scope && loaded === generation,
  };
}

/** The selection from the page URL: repository, role and agent, validated. */
export function selectedContext(search: string): WorkContext | null {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const valid = (v: string | null) => (v && /^[\w.-]{1,100}$/.test(v) ? v : null);
  return { repository: repo, role: valid(q.get("role")), agent: valid(q.get("agent")) };
}
