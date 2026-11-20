/**
 * Pipeline Health client (#684): parses the `serve-read` envelope of
 * `/api/v1/metrics?view=inventory` and loads it with cancellation and late-response rejection.
 * Plain TypeScript, so `tsc` checks it; the Svelte components only present its states. No
 * polling: a read happens on load, on a query change and on an explicit Refresh.
 */
import type { InventoryResult, InventoryStage } from "../../metrics/inventory.js";
import type { WaitingImpactResult } from "../../metrics/waitingimpact.js";
import type { AssessmentQueueResult } from "../../metrics/assessmentqueue.js";

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
  /**
   * When the underlying facts were collected and whether they came from the cache (#1141
   * review); `result.observedAt` is only when the figures were computed. Null when not supplied.
   */
  freshness: { source: string; observedAt: string; ageSeconds: number; stale: boolean } | null;
  result: InventoryResult;
}

export type InventoryState = ViewState<InventoryResponse>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isNumberOrNull = (v: unknown) => v === null || typeof v === "number";

function validAge(age: unknown): boolean {
  return (
    isObject(age) &&
    isNumberOrNull(age.medianMs) &&
    isNumberOrNull(age.oldestMs) &&
    typeof age.knownCount === "number" &&
    typeof age.unknownCount === "number" &&
    isStrings(age.unknownMembers)
  );
}
function validStage(v: unknown): boolean {
  return isObject(v) && typeof v.count === "number" && isStrings(v.members) && validAge(v.age);
}

/** The envelope fields every metrics section shows: status, project, warnings and freshness. */
function parseEnvelope(body: Record<string, unknown>): Omit<InventoryResponse, "result"> {
  const selection = isObject(body.selection) ? body.selection : {};
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
    repository: typeof selection.repository === "string" ? selection.repository : null,
    warnings: isStrings(body.warnings) ? body.warnings : [],
    freshness,
  };
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
  return { ...parseEnvelope(body), result: result as unknown as InventoryResult };
}

export interface WaitingResponse {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  warnings: string[];
  freshness: InventoryResponse["freshness"];
  result: WaitingImpactResult;
}
export type WaitingState = ViewState<WaitingResponse>;

const isBucket = (v: unknown): boolean =>
  isObject(v) && typeof v.count === "number" && isStrings(v.members);
function validWaitingGroup(v: unknown): boolean {
  return (
    isObject(v) &&
    ["total", "ready", "blocked", "notReady", "unknown"].every((k) => isBucket(v[k])) &&
    validAge(v.age)
  );
}

/** Every field the backlog section reads (#685), or null. */
export function parseWaitingResponse(body: unknown): WaitingResponse | null {
  if (!isObject(body) || body.schemaVersion !== 1 || body.kind !== "serve-read") return null;
  const result = body.result;
  if (
    !isObject(result) ||
    result.kind !== "pipeline-metrics" ||
    result.view !== "waiting-impact" ||
    typeof result.observedAt !== "string" ||
    typeof result.totalUnclaimed !== "number" ||
    !validWaitingGroup(result.totals) ||
    !isObject(result.groups) ||
    !Object.values(result.groups).every(validWaitingGroup) ||
    !isBucket(result.claimUnknown) ||
    !isBucket(result.stateUnknown) ||
    !isObject(result.coverage) ||
    !(result.coverage.note === null || typeof result.coverage.note === "string")
  )
    return null;
  const envelope = parseEnvelope(body);
  return { ...envelope, result: result as unknown as WaitingImpactResult };
}

export interface AssessmentResponse {
  status: "complete" | "incomplete" | "error";
  repository: string | null;
  warnings: string[];
  freshness: InventoryResponse["freshness"];
  result: AssessmentQueueResult;
}
export type AssessmentState = ViewState<AssessmentResponse>;

function validDay(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v.day === "string" &&
    isStrings(v.members) &&
    ((v.status === "known" && typeof v.count === "number") ||
      (v.status === "unknown" && v.count === null && typeof v.observed === "number"))
  );
}
/** One daily series figure (#687): days, the partial current day, average and gaps. */
function validSeriesFigure(v: unknown): boolean {
  if (!isObject(v) || !isObject(v.series) || !isObject(v.average) || !isBucket(v.incomplete))
    return false;
  const { days, partial } = v.series;
  return (
    Array.isArray(days) &&
    days.every(validDay) &&
    isObject(partial) &&
    typeof partial.day === "string" &&
    typeof partial.observedThrough === "string" &&
    typeof partial.observed === "number" &&
    isStrings(partial.members) &&
    isNumberOrNull(v.average.value) &&
    typeof v.average.knownDays === "number" &&
    typeof v.average.unknownDays === "number" &&
    typeof v.lowerBound === "boolean"
  );
}
function validVolume(v: unknown): boolean {
  if (!isObject(v) || !isObject(v.volume) || !isObject(v.revisions)) return false;
  const r = v.revisions;
  return (
    validSeriesFigure(v.volume.incoming) &&
    validSeriesFigure(v.volume.firstAssessed) &&
    typeof r.inWindow === "number" &&
    typeof r.total === "number" &&
    typeof r.lowerBound === "boolean" &&
    isBucket(r.unknown)
  );
}

function validMetricQueue(v: unknown): boolean {
  if (!isObject(v) || !isObject(v.unassessed) || !isObject(v.states)) return false;
  const u = v.unassessed;
  return (
    typeof u.count === "number" &&
    isNumberOrNull(u.medianAgeMs) &&
    isNumberOrNull(u.oldestAgeMs) &&
    typeof u.unknownAges === "number" &&
    isStrings(u.members) &&
    ["stale", "conflict", "unknown"].every((k) =>
      isBucket((v.states as Record<string, unknown>)[k]),
    ) &&
    isBucket(v.stateUnknown)
  );
}

/** Every field the assessment section reads (#686), or null. */
export function parseAssessmentResponse(body: unknown): AssessmentResponse | null {
  if (!isObject(body) || body.schemaVersion !== 1 || body.kind !== "serve-read") return null;
  const result = body.result;
  if (
    !isObject(result) ||
    result.kind !== "pipeline-metrics" ||
    result.view !== "assessment-queue" ||
    !isObject(result.window) ||
    typeof result.window.through !== "string" ||
    !isObject(result.metrics) ||
    !validMetricQueue(result.metrics.impact) ||
    !validMetricQueue(result.metrics.complexity) ||
    !validVolume(result.metrics.impact) ||
    !validVolume(result.metrics.complexity) ||
    !isObject(result.coverage) ||
    !(result.coverage.note === null || typeof result.coverage.note === "string")
  )
    return null;
  return { ...parseEnvelope(body), result: result as unknown as AssessmentQueueResult };
}

/**
 * How the two metrics' missing assessments overlap (#686): issues missing impact only, complexity
 * only, or both. Counted from the supplied members, so an issue missing both is counted once.
 */
export function assessmentOverlap(impact: readonly string[], complexity: readonly string[]) {
  const i = new Set(impact);
  const c = new Set(complexity);
  const both = [...i].filter((m) => c.has(m));
  return {
    impactOnly: [...i].filter((m) => !c.has(m)).length,
    complexityOnly: [...c].filter((m) => !i.has(m)).length,
    both: both.length,
    issues: new Set([...i, ...c]).size,
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

/** One section's state: the same lifecycle for every metrics view. */
export type ViewState<R> =
  | { status: "no-project" }
  | { status: "loading" }
  | { status: "ready"; response: R }
  | { status: "error"; message: string; code: string | null };

/** Read one metrics view for one repository; never throws. */
export async function fetchView<R>(
  api: string,
  view: string,
  repository: string,
  parse: (body: unknown) => R | null,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  /** An explicit Refresh: bypass the server's short-lived cache for fresh facts. */
  refresh = false,
): Promise<ViewState<R>> {
  let response: Response;
  try {
    const query = `view=${view}&repo=${encodeURIComponent(repository)}${refresh ? "&refresh=true" : ""}`;
    response = await fetcher(`${api}?${query}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return {
      status: "error",
      message: "The figures could not be read from the server.",
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
          : `The figures could not be read (HTTP ${response.status}).`,
      code: error && typeof error.code === "string" ? error.code : null,
    };
  }
  const parsed = parse(body);
  return parsed
    ? { status: "ready", response: parsed }
    : {
        status: "error",
        message: "The server returned figures in a format this page does not read.",
        code: null,
      };
}

/**
 * A loader for one section: each read aborts the previous one and only the newest result is
 * reported, so a project change never shows another project's figures. `load` skips an
 * unchanged project (fragment-only navigation); `refresh` always re-reads, bypassing the cache.
 */
export function viewLoader<R>(
  api: string,
  view: string,
  parse: (body: unknown) => R | null,
  fetcher: typeof fetch,
  report: (state: ViewState<R>) => void,
) {
  let current: AbortController | null = null;
  let sequence = 0;
  let loaded: string | null | undefined;
  /** Read and report; resolves to the state reported, or null when superseded or no project. */
  const read = async (repository: string | null, refresh = false): Promise<ViewState<R> | null> => {
    loaded = repository;
    current?.abort();
    const mine = ++sequence;
    if (repository === null) {
      current = null;
      report({ status: "no-project" });
      return null;
    }
    const controller = new AbortController();
    current = controller;
    report({ status: "loading" });
    const state = await fetchView(
      api,
      view,
      repository,
      parse,
      fetcher,
      controller.signal,
      refresh,
    );
    if (mine !== sequence || controller.signal.aborted) return null;
    report(state);
    return state;
  };
  return {
    load: (repository: string | null) =>
      repository === loaded ? Promise.resolve(null) : read(repository),
    // Refresh asks the server for fresh facts, not its cached entry (#1141 review).
    refresh: () => read(loaded ?? null, true),
    /** Re-read the current project through the cache (after another section refreshed it). */
    reload: () => read(loaded ?? null, false),
  };
}

/**
 * One Refresh for several sections that share the server's metrics collection (#1142 review):
 * the first bypasses the cache and collects fresh facts once; the others then re-read through
 * the cache that collection just filled. Forced reads never join each other on the server, so
 * refreshing every section with `refresh=true` would collect the same facts once per section.
 */
export async function refreshSections(
  sections: readonly {
    refresh(): Promise<ViewState<{ status: string }> | null>;
    reload(): Promise<unknown>;
  }[],
): Promise<void> {
  const [first, ...rest] = sections;
  if (!first) return;
  const fresh = await first.refresh();
  // Superseded (e.g. the project changed meanwhile): the new project's own loads are in
  // charge; starting more reads here would abort them (#1142 review).
  if (fresh === null) return;
  // The server stores only complete reads (#1142 review): reuse the cache only when the first
  // read was complete; after a failed or incomplete read, the others collect for themselves.
  const stored = fresh?.status === "ready" && fresh.response.status === "complete";
  await Promise.all(rest.map((s) => (stored ? s.reload() : s.refresh())));
}

/** The inventory section's fetch (#684). */
export const fetchInventory = (
  api: string,
  repository: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  refresh = false,
): Promise<InventoryState> =>
  fetchView(api, "inventory", repository, parseInventoryResponse, fetcher, signal, refresh);

/** The inventory section's loader (#684). */
export const inventoryLoader = (
  api: string,
  fetcher: typeof fetch,
  report: (state: InventoryState) => void,
) => viewLoader(api, "inventory", parseInventoryResponse, fetcher, report);

/** The assessment-health section's loader (#686). */
export const assessmentLoader = (
  api: string,
  fetcher: typeof fetch,
  report: (state: AssessmentState) => void,
) => viewLoader(api, "assessment-queue", parseAssessmentResponse, fetcher, report);

/** The waiting backlog section's loader (#685). */
export const waitingLoader = (
  api: string,
  fetcher: typeof fetch,
  report: (state: WaitingState) => void,
) => viewLoader(api, "waiting-impact", parseWaitingResponse, fetcher, report);

/** The selected project from the page query (`repo`), or null. */
export function selectedRepository(search: string): string | null {
  const repo = new URLSearchParams(search).get("repo");
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

const impactOrder = ["XXL", "XL", "L", "M", "S", "XS"];
const explicitGroups = ["unassessed", "stale", "conflict", "unknown"];

/**
 * The backlog's groups in display order (#685): valid impact sizes from largest to smallest, then
 * the explicit unassessed, stale, conflict and unknown groups. Any other group the server names is
 * kept (after the sizes), never dropped.
 */
export function waitingGroupOrder(groups: Record<string, unknown>): string[] {
  const names = Object.keys(groups);
  const sizes = impactOrder.filter((n) => names.includes(n));
  const other = names.filter((n) => !impactOrder.includes(n) && !explicitGroups.includes(n)).sort();
  return [...sizes, ...other, ...explicitGroups.filter((n) => names.includes(n))];
}
