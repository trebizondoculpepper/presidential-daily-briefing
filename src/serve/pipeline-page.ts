import { pageById, shellContext, shellStart } from "./shell.js";
/**
 * Pipeline Health: current stage inventory (#684), at `/pipeline?repo=R`
 * (doc/design/dashboard-pipeline-metrics.md "Pipeline health (#575)", "Current inventory").
 *
 * One table of the canonical ready, blocked and agent-claimed stages of open tickets now: count,
 * typical (median) and oldest age where the stage's age definition has evidence, unknown ages
 * counted rather than dropped, and a bounded drill-down of the member tickets. The page reads
 * the shared `GET /api/v1/metrics?repo=R&view=inventory` exactly as served: stages come from the
 * native workflow facts behind that view; nothing here classifies, ranks or writes. It is labelled
 * "now" and is never drawn as a flow (no history, no Sankey, no impact chart).
 */
import { dashboardRenderers } from "./dashboard.js";
import type { DashboardRenderers } from "./dashboard.js";
import { HttpFailure } from "./http.js";
import { escapeHtml } from "./rules-page.js";

/** Query parameters the page accepts (the shell's registry entry). */
export const pipelinePageParameters = pageById("pipeline").parameters;
type Served = { repository: string; project?: string };

const navigation = (served: readonly Served[], selected: string | null): string =>
  shellStart(
    shellContext("pipeline", served, new URLSearchParams(selected ? { repo: selected } : {})),
    "Pipeline health",
    "/pipeline.js",
  );

const footer = `<footer>Read-only. Current inventory of open tickets now, from the same metrics read the API serves; nothing here edits GitHub or polls in the background.</footer>
</body>
</html>
`;

export interface PipelinePageResult {
  status: number;
  html: string;
}

/** Build the page for one request's query, through the served-project allowlist. */
export function pipelinePage(
  query: URLSearchParams,
  served: readonly Served[],
  select: (served: readonly Served[], repo: string | undefined) => Served,
): PipelinePageResult {
  const error = (status: number, message: string): PipelinePageResult => ({
    status,
    html: `${navigation(served, null)}<main id="content" tabindex="-1"><h1>Pipeline health</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
</main>
${footer}`,
  });
  for (const key of new Set(query.keys())) {
    if (!(pipelinePageParameters as readonly string[]).includes(key))
      return error(
        400,
        `Unknown parameter. The pipeline view accepts ${pipelinePageParameters.join(", ")}.`,
      );
    if (query.getAll(key).length > 1) return error(400, `Give ${key} at most once.`);
  }
  const repo = query.get("repo");
  // Like the other project pages, a missing project is never resolved implicitly.
  if (repo === null)
    return {
      status: 200,
      html: `${navigation(served, null)}<main id="content" tabindex="-1"><h1>Pipeline health</h1>
<p>No project selected. Choose a served project above to see its current stage inventory.</p>
</main>
${footer}`,
    };
  let selected: Served;
  try {
    selected = select(served, repo);
  } catch (failure) {
    if (!(failure instanceof HttpFailure)) throw failure;
    return error(
      failure.status,
      failure.code === "REPOSITORY_NOT_SERVED"
        ? "That repository is not served by this server. Choose a served project above."
        : "repo must be owner/name. Choose a served project above.",
    );
  }
  return {
    status: 200,
    html: `${navigation(served, selected.repository)}<main id="content" tabindex="-1" data-repo="${escapeHtml(selected.repository)}">
<h1>Pipeline health</h1><p>Project: <strong>${escapeHtml(selected.repository)}</strong></p>
<p><button id="refresh" type="button">Refresh</button></p>
<section id="state" aria-live="polite"></section>
<section id="inventory" aria-labelledby="inventory-heading"></section>
<section id="coverage"></section>
</main>
${footer}`,
  };
}

export interface PipelineRenderers {
  metricsUrl(selection: { repo: string; refresh?: boolean }): string;
  matches(envelope: unknown, repo: string): boolean;
  /** The inventory table and its drill-down for one answer. */
  renderInventory(envelope: unknown, repo: string): string;
  renderCoverage(envelope: unknown): string;
}

/** Pure HTML-string renderers over the served inventory view; every string is escaped. */
export function pipelineRenderers(base: DashboardRenderers): PipelineRenderers {
  const escapeHtml = (text: unknown): string => base.escapeHtml(text);
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  /** The canonical stages this view shows (#684): ready, blocked and agent-claimed. */
  const stages: readonly { key: string; label: string; age: string }[] = [
    { key: "ready", label: "Ready", age: "since created" },
    { key: "blocked", label: "Blocked", age: "since the last observed change" },
    { key: "claimed", label: "Agent-claimed", age: "since the current claim began" },
  ];
  /** Members drawn in one drill-down; the rest are counted, never silently dropped. */
  const drillLimit = 50;

  const duration = (ms: unknown): string => {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "unknown";
    const hours = ms / 3_600_000;
    if (hours < 1) return "under 1 hour";
    if (hours < 48) return `${Math.floor(hours)} hours`;
    return `${Math.floor(hours / 24)} days`;
  };
  const ticketLink = (member: unknown, repo: string): string => {
    const text = typeof member === "string" ? member : "";
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
    if (!match || match[1]!.toLowerCase() !== repo.toLowerCase()) return escapeHtml(text);
    const query = new URLSearchParams({ repo, n: match[2]! });
    return `<a href="/ticket?${escapeHtml(query.toString())}">#${escapeHtml(match[2])}</a>`;
  };

  const metricsUrl = (s: { repo: string; refresh?: boolean }) => {
    const query = new URLSearchParams({ repo: s.repo, view: "inventory" });
    if (s.refresh) query.set("refresh", "true");
    return `/api/v1/metrics?${query.toString()}`;
  };
  const matches = (envelope: unknown, repo: string) => {
    const selected = record(record(envelope).selection).repository;
    return typeof selected === "string" && selected.toLowerCase() === repo.toLowerCase();
  };

  const renderInventory = (envelope: unknown, repo: string): string => {
    const e = record(envelope);
    const result = record(e.result);
    if (e.status === "error" || result.view !== "inventory") return "";
    const byStage = record(result.stages);
    const rows = stages
      .map(({ key, label, age }) => {
        const stage = record(byStage[key]);
        const n = count(stage.count);
        const ages = record(stage.age);
        const unknownAges = count(ages.unknownCount) ?? 0;
        const members = list(stage.members);
        const shown = members.slice(0, drillLimit);
        const omitted = members.length - shown.length;
        const drill = members.length
          ? `<details><summary>${escapeHtml(members.length)} ticket${members.length === 1 ? "" : "s"}</summary><p>${shown
              .map((m) => ticketLink(m, repo))
              .join(", ")}${omitted > 0 ? ` and ${escapeHtml(omitted)} more` : ""}</p></details>`
          : "none";
        return `<tr><th scope="row">${escapeHtml(label)}</th><td>${n === null ? "unknown" : escapeHtml(n)}</td><td>${escapeHtml(duration(ages.medianMs))}</td><td>${escapeHtml(duration(ages.oldestMs))}</td><td>${escapeHtml(unknownAges)}</td><td>${escapeHtml(age)}</td><td>${drill}</td></tr>`;
      })
      .join("");
    const unknownStage = count(record(byStage.unknown).count) ?? 0;
    const stateUnknown = count(record(result.stateUnknown).count) ?? 0;
    return `<h2 id="inventory-heading">Current inventory (now)</h2>
<table><caption>Open tickets by current stage, observed ${escapeHtml(result.observedAt)}</caption>
<thead><tr><th scope="col">Stage</th><th scope="col">Count</th><th scope="col">Typical age (median)</th><th scope="col">Oldest</th><th scope="col">Unknown age</th><th scope="col">Age measured</th><th scope="col">Tickets</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="note">Each open ticket is counted once, in its current display stage, so these rows are not a flow and do not add up to a conserved total. The states overlap: an agent-claimed ticket can also be blocked by a native dependency, and is counted here only as agent-claimed. Unassessed and in-review tickets are not part of this table.</p>
${unknownStage || stateUnknown ? `<p class="notice">${escapeHtml(unknownStage)} open ticket(s) have a stage that could not be established, and ${escapeHtml(stateUnknown)} ticket(s) have an unknown open/closed state; neither is counted above.</p>` : ""}`;
  };

  const renderCoverage = (envelope: unknown): string => {
    const e = record(envelope);
    const result = record(e.result);
    const warnings = list(e.warnings).filter((w): w is string => typeof w === "string");
    const note = record(result.coverage).note;
    const lines = [
      ...(typeof note === "string" && note ? [note] : []),
      ...warnings,
      ...list(result.limitations).filter((l): l is string => typeof l === "string"),
    ];
    return lines.length
      ? `<h2>Coverage</h2><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
      : "";
  };

  return { metricsUrl, matches, renderInventory, renderCoverage };
}

/** Browser behaviour: one read on open, another only on Refresh; no polling. */
export function pipelineClient(base: DashboardRenderers, view: PipelineRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement | null;
  const main = byId("content");
  const repo = main?.dataset.repo ?? "";
  if (!main || !repo) return;
  const state = byId("state")!;
  const inventory = byId("inventory")!;
  const coverage = byId("coverage")!;
  let generation = 0;
  let controller: AbortController | null = null;
  const show = async (refresh: boolean) => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const current = ++generation;
    inventory.classList.add("provisional");
    coverage.classList.add("provisional");
    state.innerHTML = base.renderState(null, true);
    let envelope: unknown;
    try {
      const response = await fetch(view.metricsUrl({ repo, refresh }), {
        headers: { accept: "application/json" },
        signal: mine.signal,
      });
      envelope = await response.json();
    } catch (error) {
      if (mine.signal.aborted) return;
      envelope = { status: "error", error: { code: "UNREACHABLE", message: String(error) } };
    }
    if (current !== generation) return; // superseded
    if (!view.matches(envelope, repo) && (envelope as { status?: unknown }).status !== "error")
      envelope = {
        status: "error",
        error: { code: "SELECTION_MISMATCH", message: "The answer was for another project." },
      };
    state.innerHTML = base.renderState(envelope, false);
    // A failed read clears earlier numbers: nothing old is left looking current.
    inventory.innerHTML = view.renderInventory(envelope, repo);
    coverage.innerHTML = view.renderCoverage(envelope);
    inventory.classList.remove("provisional");
    coverage.classList.remove("provisional");
  };
  byId("refresh")!.addEventListener("click", () => void show(true));
  void show(false);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const pipelineScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(() => {\nconst base = (${dashboardRenderers.toString()})();\n(${pipelineClient.toString()})(base, (${pipelineRenderers.toString()})(base));\n})();\n`;
