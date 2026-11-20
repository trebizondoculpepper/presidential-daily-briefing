/**
 * Pipeline Health client (#684): parses the `serve-read` envelope of
 * `/api/v1/metrics?view=inventory` and loads it with cancellation and late-response rejection.
 * Plain TypeScript, so `tsc` checks it; the Svelte components only present its states. No
 * polling: a read happens on load, on a query change and on an explicit Refresh.
 */
import type { InventoryResult, InventoryStage } from "../../metrics/inventory.js";

/** The stages this section shows (#684): the canonical ready, blocked and agent-claimed states. */
export const shownStages = [
  "ready",
  "blocked",
  "claimed",
] as const satisfies readonly InventoryStage[];

export interface InventoryResponse {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  warnings: string[];
  result: InventoryResult;
}

export type InventoryState =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: InventoryResponse }
  | { status: "error"; message: string; code: string | null };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isNumberOrNull = (v: unknown) => v === null || typeof v === "number";

function validStage(v: unknown): boolean {
  if (!isObject(v) || typeof v.count !== "number" || !isStrings(v.members)) return false;
  const age = v.age;
  return (
    isObject(age) &&
    isNumberOrNull(age.medianMs) &&
    isNumberOrNull(age.oldestMs) &&
    typeof age.knownCount === "number" &&
    typeof age.unknownCount === "number" &&
    isStrings(age.unknownMembers)
  );
}

/** Every field the section reads, so a malformed result is a format error, never a broken render. */
export function parseInventoryResponse(body: unknown): InventoryResponse | null {
  if (!isObject(body) || body.schemaVersion !== 1 || body.kind !== "serve-read") return null;
  const result = body.result;
  if (
    !isObject(result) ||
    result.kind !== "pipeline-metrics" ||
    result.view !== "inventory" ||
    typeof result.observedAt !== "string" ||
    typeof result.totalOpen !== "number" ||
    !isObject(result.stages) ||
    !isObject(result.coverage) ||
    !(result.coverage.note === null || typeof result.coverage.note === "string") ||
    !isObject(result.stateUnknown) ||
    typeof result.stateUnknown.count !== "number"
  )
    return null;
  const stages = result.stages;
  if (!shownStages.every((s) => validStage(stages[s])) || !validStage(stages.unknown)) return null;
  const selection = isObject(body.selection) ? body.selection : {};
  return {
    status:
      body.status === "complete" || body.status === "incomplete" || body.status === "error"
        ? body.status
        : "error",
    repository: typeof selection.repository === "string" ? selection.repository : null,
    warnings: isStrings(body.warnings) ? body.warnings : [],
    result: result as unknown as InventoryResult,
  };
}

/** A duration for display: "3d 4h", "5h 12m", "42m", "<1m"; null is unknown. */
export function formatAge(ms: number | null): string {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** The `/ticket` link for a member (`owner/name#N`), or null when it is not one. */
export function ticketLink(member: string): string | null {
  const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(member);
  return m ? `/ticket?repo=${encodeURIComponent(m[1]!)}&n=${m[2]}` : null;
}

/** Read the inventory for one repository; never throws. */
export async function fetchInventory(
  api: string,
  repository: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  /** An explicit Refresh: bypass the server's short-lived cache for fresh facts. */
  refresh = false,
): Promise<InventoryState> {
  let response: Response;
  try {
    const query = `view=inventory&repo=${encodeURIComponent(repository)}${refresh ? "&refresh=true" : ""}`;
    response = await fetcher(`${api}?${query}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return {
      status: "error",
      message: "The inventory could not be read from the server.",
      code: null,
    };
  }
  let body: unknown;
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
          : `The inventory could not be read (HTTP ${response.status}).`,
      code: error && typeof error.code === "string" ? error.code : null,
    };
  }
  const parsed = parseInventoryResponse(body);
  return parsed
    ? { status: "ready", response: parsed }
    : {
        status: "error",
        message: "The server returned the inventory in a format this page does not read.",
        code: null,
      };
}

/**
 * A loader for one page: each read aborts the previous one and only the newest result is
 * reported, so a project change never shows another project's inventory. `load` skips an
 * unchanged project (fragment-only navigation); `refresh` always re-reads.
 */
export function inventoryLoader(
  api: string,
  fetcher: typeof fetch,
  report: (state: InventoryState) => void,
) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null | undefined;
  const read = async (repository: string | null, refresh = false): Promise<void> => {
    loaded = repository;
    current?.abort();
    const mine = ++sequence;
    if (repository === null) {
      current = null;
      report({ status: "no-project" });
      return;
    }
    const controller = new AbortController();
    current = controller;
    report({ status: "loading" });
    const state = await fetchInventory(api, repository, fetcher, controller.signal, refresh);
    if (mine === sequence && !controller.signal.aborted) report(state);
  };
  return {
    load: (repository: string | null) =>
      repository === loaded ? Promise.resolve() : read(repository),
    // Refresh asks the server for fresh facts, not its cached entry (#1141 review).
    refresh: () => read(loaded ?? null, true),
  };
}

/** The selected project from the page query (`repo`), or null. */
export function selectedRepository(search: string): string | null {
  const repo = new URLSearchParams(search).get("repo");
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}
