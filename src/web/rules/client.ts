/**
 * The Rules page's API client (#853): typed parsing of `/api/v1/rules` and a loader that
 * cancels superseded reads and never shows a late response for an older query. Plain
 * TypeScript, so `tsc` checks it; the Svelte components only present its states.
 */
import type { RulesView } from "../../serve/rules-page.js";

export interface RulesResponse {
  schemaVersion: 1;
  kind: "rules";
  selected: string | null;
  filters: { role?: string; rule?: string };
  view: RulesView;
}

export type RulesState =
  | { status: "loading" }
  | { status: "ready"; response: RulesResponse }
  /** The read succeeded but this view lists no section (e.g. a filter matched nothing). */
  | { status: "empty"; response: RulesResponse }
  | { status: "error"; message: string; code: string | null };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The response, or null when it is not a rules document of a version this page reads. */
export function parseRulesResponse(body: unknown): RulesResponse | null {
  if (!isObject(body) || body.schemaVersion !== 1 || body.kind !== "rules") return null;
  if (body.selected !== null && typeof body.selected !== "string") return null;
  if (!isObject(body.filters) || !isObject(body.view)) return null;
  const view = body.view;
  if (!Array.isArray(view.sections) || !isObject(view.policy) || !isObject(view.narration))
    return null;
  return body as unknown as RulesResponse;
}

/** The API's error envelope message, or a generic one: never a page fragment. */
function errorOf(status: number, body: unknown): { message: string; code: string | null } {
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  return {
    message:
      error && typeof error.message === "string"
        ? error.message
        : `The rules could not be read (HTTP ${status}).`,
    code: error && typeof error.code === "string" ? error.code : null,
  };
}

/** Read the rules for one page query; never throws. */
export async function fetchRules(
  api: string,
  search: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<RulesState> {
  let response: Response;
  try {
    response = await fetcher(`${api}${search}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { status: "error", message: "The rules could not be read from the server.", code: null };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) return { status: "error", ...errorOf(response.status, body) };
  const parsed = parseRulesResponse(body);
  if (!parsed)
    return {
      status: "error",
      message: "The server returned rules in a format this page does not read.",
      code: null,
    };
  return parsed.view.sections.length
    ? { status: "ready", response: parsed }
    : { status: "empty", response: parsed };
}

/**
 * A loader for one page: each `load` aborts the previous read, and only the newest read's result
 * is reported, so a project or role change never shows the previous query's rules.
 */
export function rulesLoader(
  api: string,
  fetcher: typeof fetch,
  report: (state: RulesState) => void,
) {
  let current: AbortController | null = null;
  let sequence = 0;
  return {
    async load(search: string): Promise<void> {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const mine = ++sequence;
      report({ status: "loading" });
      const state = await fetchRules(api, search, fetcher, controller.signal);
      if (mine === sequence && !controller.signal.aborted) report(state);
    },
  };
}
