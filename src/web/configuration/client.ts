/**
 * Configuration page client (#818): typed parsing of `/api/v1/configuration` and a loader that
 * cancels superseded reads and never shows a late response. Plain strict TypeScript, so `tsc`
 * checks it; the Svelte components only present the returned states.
 */
import type { ConfigurationView } from "../../serve/configuration.js";

export interface ConfigurationResponse {
  schemaVersion: 1;
  kind: "configuration";
  selected: string | null;
  view: ConfigurationView;
}

export type ConfigurationState =
  | { status: "loading" }
  | { status: "ready"; response: ConfigurationResponse }
  | { status: "error"; message: string; code: string | null };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string";

/** A JSON-safe value the registry may report (boolean, number, string, null, or project list). */
const isSafeValue = (v: unknown): boolean => {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string")
    return true;
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) =>
      isObject(item) &&
      isString(item.host) &&
      isString(item.repository) &&
      (item.localRoot === undefined || item.localRoot === null || isString(item.localRoot)),
  );
};

function validRow(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.key) &&
    (v.scope === "global" || v.scope === "project") &&
    isString(v.type) &&
    isSafeValue(v.value) &&
    isSafeValue(v.defaultValue) &&
    (v.source === "explicit" || v.source === "default") &&
    isString(v.description) &&
    (v.choices === undefined || (Array.isArray(v.choices) && v.choices.every(isString)))
  );
}

/** Parse the configuration envelope; null when it is not one. */
export function parseConfigurationResponse(body: unknown): ConfigurationResponse | null {
  if (!isObject(body)) return null;
  if (body.schemaVersion !== 1 || body.kind !== "configuration") return null;
  if (body.selected !== null && !isString(body.selected)) return null;
  const v = body.view;
  if (
    !isObject(v) ||
    (v.scope !== "global" && v.scope !== "project") ||
    (v.state !== "ok" && v.state !== "unsupported" && v.state !== "degraded") ||
    (v.repository !== null && !isString(v.repository)) ||
    !isString(v.path) ||
    (v.storedVersion !== null && typeof v.storedVersion !== "number") ||
    !Array.isArray(v.rows) ||
    !v.rows.every(validRow) ||
    !Array.isArray(v.warnings) ||
    !v.warnings.every(isString)
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "configuration",
    selected: body.selected,
    view: v as unknown as ConfigurationView,
  };
}

/** The shell-canonical search the page sends (it already carries `?repo=` when selected). */
export const configurationQuery = (search: string): string => search;

/**
 * Reads the page, cancelling any superseded load: only the latest request may deliver a state.
 * An HTTP error becomes a readable `error` state with its code; an undecodable body is an error
 * too — never a silent empty table.
 */
export function configurationLoader(
  api: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  apply: (next: ConfigurationState) => void,
) {
  let generation = 0;
  const load = async (search: string) => {
    const mine = ++generation;
    apply({ status: "loading" });
    let response: Response;
    try {
      response = await fetchImpl(`${api}${configurationQuery(search)}`, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      if (mine === generation)
        apply({
          status: "error",
          message: `Configuration could not be read: ${error instanceof Error ? error.message : String(error)}`,
          code: "network",
        });
      return;
    }
    if (mine !== generation) return;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (mine !== generation) return;
    const parsed = parseConfigurationResponse(body);
    if (!parsed) {
      apply({
        status: "error",
        message: response.ok
          ? "The configuration response was not understood."
          : `Configuration could not be read (HTTP ${response.status}).`,
        code: response.ok ? null : String(response.status),
      });
      return;
    }
    if (mine === generation) apply({ status: "ready", response: parsed });
  };
  return { load };
}
