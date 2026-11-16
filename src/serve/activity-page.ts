import { pageById, shellContext, shellStart } from "./shell.js";
/**
 * The read-only Agents/Activity view of `pdb serve` (#456), at
 * `/activity?repo=R&window=1d` (doc/design/serve-dashboard-read-views.md "Agent activity",
 * owner clarification of 2026-11-15).
 *
 * It lists agents with recorded participation in a selectable one-to-seven-day window (default
 * one day). Participation is evidenced activity, never inferred presence: an agent that owns
 * unfinished work but has no evidenced event in the window is not listed here. The page reads
 * the shared `GET /api/v1/team?repo=R` (the CLI team model) exactly as served, applies the
 * window filter to each agent by its claims' latest activity, and renders claimed work and
 * submitted responsibility separately, in the server's stable order. It draws or writes nothing.
 */
import { dashboardRenderers } from "./dashboard.js";
import type { DashboardRenderers } from "./dashboard.js";
import { HttpFailure } from "./http.js";
import { escapeHtml } from "./rules-page.js";

/** Query parameters the page accepts (the shell's registry entry). */
export const activityPageParameters = pageById("activity").parameters;

/** The participation window in days, one to seven; anything else is refused by the page.
 * An absent parameter selects the documented one-day default; only explicit invalid values
 * (a non-number, or outside 1..7) are rejected. */
const windowDays = (value: string | null): number | null => {
  if (value === null) return 1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
};
type Served = { repository: string; project?: string };

function navigation(served: readonly Served[], selected: string | null, window: number): string {
  return shellStart(
    shellContext(
      "activity",
      served,
      new URLSearchParams(
        selected ? { repo: selected, window: String(window) } : { window: String(window) },
      ),
    ),
    "Activity",
    "/activity.js",
  );
}

const footer = `<footer>Read-only. Participation is evidenced activity within the selected window; an agent with no evidenced event is not listed, whatever it owns. Nothing here edits GitHub.</footer>
</body>
</html>
`;

export interface ActivityPageResult {
  status: number;
  html: string;
}

/** Build the page for one request's query, through the served-project allowlist. */
export function activityPage(
  query: URLSearchParams,
  served: readonly Served[],
  select: (served: readonly Served[], repo: string | undefined) => Served,
): ActivityPageResult {
  const window = windowDays(query.get("window"));
  const error = (status: number, message: string): ActivityPageResult => ({
    status,
    html: `${navigation(served, null, window ?? 1)}<main id="content" tabindex="-1"><h1>Activity</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
</main>
${footer}`,
  });
  for (const key of new Set(query.keys())) {
    if (!(activityPageParameters as readonly string[]).includes(key))
      return error(
        400,
        `Unknown parameter. The activity view accepts ${activityPageParameters.join(", ")}.`,
      );
    if (query.getAll(key).length > 1) return error(400, `Give ${key} at most once.`);
  }
  if (window === null) return error(400, "window must be a whole number of days from 1 to 7.");
  const repo = query.get("repo");
  // Unlike the JSON API, the page never resolves a missing project, even when only one is served.
  if (repo === null)
    return {
      status: 200,
      html: `${navigation(served, null, window)}<main id="content" tabindex="-1"><h1>Activity</h1>
<p>No project selected. Choose a served project above to see which agents have evidence of work there.</p>
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
    html: `${navigation(served, selected.repository, window)}<main id="content" tabindex="-1" data-repo="${escapeHtml(selected.repository)}">
<h1>Activity</h1><p>Project: <strong>${escapeHtml(selected.repository)}</strong></p>
<form id="selection">
<label>Participation window
<select id="window">
<option value="1"${window === 1 ? " selected" : ""}>Last 1 day</option>
<option value="2"${window === 2 ? " selected" : ""}>Last 2 days</option>
<option value="3"${window === 3 ? " selected" : ""}>Last 3 days</option>
<option value="4"${window === 4 ? " selected" : ""}>Last 4 days</option>
<option value="5"${window === 5 ? " selected" : ""}>Last 5 days</option>
<option value="6"${window === 6 ? " selected" : ""}>Last 6 days</option>
<option value="7"${window === 7 ? " selected" : ""}>Last 7 days</option>
</select></label>
<button id="show" type="submit">Show</button>
<button id="refresh" type="button">Refresh</button>
</form>
<section id="state" aria-live="polite"></section>
<section id="notices"></section>
<section id="agents" aria-labelledby="agents-heading"></section>
<section id="coverage"></section>
</main>
${footer}`,
  };
}

export interface ActivityRenderers {
  activityUrl(selection: { repo: string; window: number; refresh?: boolean }): string;
  /** Whether the envelope belongs to the page's project (a late or foreign answer is dropped). */
  matches(envelope: unknown, repo: string): boolean;
  renderNotices(envelope: unknown): string;
  /** Agents with evidenced activity in the window, in server order; empty string when none fit. */
  renderAgents(envelope: unknown, window: number, nowMs?: number): string;
  renderCoverage(envelope: unknown, window: number, nowMs?: number): string;
}

/**
 * Pure HTML-string renderers over the team `serve-read` envelope. They take the dashboard's
 * escaping, so every GitHub-authored value is escaped once, in one place.
 */
export function activityRenderers(base: DashboardRenderers): ActivityRenderers {
  const escapeHtml = (text: unknown): string => base.escapeHtml(text);
  const ms = (days: number) => days * 24 * 3_600_000;
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  /** Agents with an evidenced event in the window. */
  const agentsActive = (agents: unknown[], window: number, nowMs: number): unknown[] =>
    agents.filter((a) =>
      [...list(record(a).claims), ...list(record(a).responsibilities)].some((c) => {
        const src = record(c);
        const at = str(record(src.latestActivity).at) || str(src.since);
        return at !== "" && Number.isFinite(Date.parse(at)) && nowMs - Date.parse(at) <= ms(window);
      }),
    );
  const safeLink = (url: unknown): string | null =>
    typeof url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\//.test(url) ? url : null;
  const link = (url: unknown, text: string): string => {
    const safe = safeLink(url);
    return safe
      ? `<a href="${escapeHtml(safe)}" rel="noreferrer">${escapeHtml(text)}</a>`
      : escapeHtml(text);
  };
  const numberOf = (url: unknown) => (typeof url === "string" ? (url.split("/").pop() ?? "") : "");
  const team = (envelope: unknown) => record(record(record(envelope).result).agents);

  const activityUrl = (s: { repo: string; window: number; refresh?: boolean }) => {
    const query = new URLSearchParams({ repo: s.repo, staleHours: String(s.window * 24) });
    if (s.refresh) query.set("refresh", "true");
    return `/api/v1/team?${query.toString()}`;
  };

  const matches = (envelope: unknown, repo: string) => {
    const selected = record(record(envelope).selection).repository;
    return typeof selected === "string" && selected.toLowerCase() === repo.toLowerCase();
  };

  const renderNotices = (envelope: unknown) => {
    const e = record(envelope);
    const sr = record(e.result);
    const warnings = list(record(sr.completeness).warnings);
    return warnings.map((w) => `<p class="notice">${escapeHtml(w)}</p>`).join("");
  };

  const claimActivity = (claim: unknown): string => {
    const activity = record(record(claim).activity);
    const state = str(activity.state);
    const reason = str(activity.reason);
    if (state === "" || state === "unknown") return "";
    const prefix =
      state === "active"
        ? "active"
        : state === "waiting"
          ? "waiting"
          : state === "resume-required"
            ? "resume required"
            : state;
    return reason ? `${prefix}: ${reason}` : prefix;
  };

  const renderClaim = (raw: unknown, repository: string): string => {
    const c = record(raw);
    const number = numberOf(c.url);
    const activity = claimActivity(c);
    const prs = list(c.pullRequests).map((p) => {
      const pr = record(p);
      return link(
        pr.url,
        `PR #${numberOf(pr.url)}${String(pr.draft) === "true" ? " (draft)" : ""}${
          str(pr.reviewDecision) ? ` · ${escapeHtml(str(pr.reviewDecision))}` : ""
        }`,
      );
    });
    const co = list(c.coOwners);
    const latest = record(c.latestActivity);
    const latestText =
      str(latest.at) !== ""
        ? `${escapeHtml(str(latest.source))}${latest.at ? ` · ${escapeHtml(str(latest.at).slice(0, 10))}` : ""}`
        : "no recorded activity";
    const candidates = list(c.candidates);
    const detail = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(
      str(c.url),
    );
    const ticket =
      detail && detail[1]!.toLowerCase() === repository.toLowerCase()
        ? ` <a class="detail" href="${escapeHtml(`/ticket?${new URLSearchParams({ repo: repository, n: detail[2]! }).toString()}`)}">details</a>`
        : "";
    return `<li>${link(c.url, `#${number} ${str(c.title)}`)}${ticket}
<p class="why">${activity ? `Activity: ${escapeHtml(activity)}; ` : ""}Latest: ${latestText}.${co.length ? ` Co-owned with ${co.map(escapeHtml).join(", ")}.` : ""}</p>${
      prs.length ? `<p>Submitted responsibilities: ${prs.join(", ")}.</p>` : ""
    }${candidates.length ? `<ul>${candidates.map((x) => `<li class="warn">${escapeHtml(x)}</li>`).join("")}</ul>` : ""}</li>`;
  };

  /** The shared model's continuing responsibilities (S18), separate from claimed work. */
  const renderResponsibilities = (raw: unknown): string => {
    const items = list(raw);
    if (!items.length) return "";
    const rows = items.map((r) => {
      const item = record(r);
      const deliverable = str(item.deliverable);
      const number = numberOf(item.url);
      const label = item.scope === "ticket" ? `#${number} ticket` : `#${number} ${deliverable}`;
      // FollowUp is a string enum from the shared inventory: none, waiting, actionable, unknown.
      const followUp = str(item.followUp);
      const followUpText =
        followUp && followUp !== "none" ? `; follow-up: ${escapeHtml(followUp)}` : "";
      return `<li>${link(item.url, label)} · delivery ${escapeHtml(str(item.delivery))}${followUpText}</li>`;
    });
    return `<h4>Continuing responsibility</h4><ol>${rows.join("")}</ol>`;
  };

  const renderAgents = (envelope: unknown, window: number, nowMs: number = Date.now()) => {
    const e = record(envelope);
    if (e.status === "error") return "";
    const agents = list(team(envelope));
    if (!agents.length) return "";
    const repository = str(record(e.selection).repository);
    // Agents with no evidenced activity in the window are not listed (owner clarification).
    const active = agentsActive(agents, window, nowMs);
    if (!active.length)
      return '<p class="warn">No agent has evidenced activity in this window within the available evidence.</p>';
    const rows = active.map((a) => {
      const agent = record(a);
      const name = escapeHtml(str(agent.agent));
      const claims = list(agent.claims);
      const responsibilities = list(agent.responsibilities);
      const warnings = list(agent.warnings).map((w) => {
        const wr = record(w);
        return `<li class="warn">${escapeHtml(str(wr.detail))}</li>`;
      });
      return `<li><h3>${name}</h3>${
        claims.length
          ? `<ol>${claims.map((c) => renderClaim(c, repository)).join("")}</ol>${renderResponsibilities(responsibilities)}`
          : responsibilities.length
            ? renderResponsibilities(responsibilities)
            : "<p>No recorded claims or responsibilities.</p>"
      }${warnings.length ? `<ul>${warnings.join("")}</ul>` : ""}</li>`;
    });
    return `<ol class="agents">${rows.join("")}</ol>`;
  };

  const renderCoverage = (envelope: unknown, window: number, nowMs: number = Date.now()) => {
    const e = record(envelope);
    const complete = e.status === "complete";
    const all = list(team(envelope));
    const total = all.length;
    const active = agentsActive(all, window, nowMs).length;
    return `<h2>Evidence</h2><p>${complete ? "Coverage complete." : '<span class="warn">Coverage incomplete: missing evidence is unknown, never absent.</span>'}</p><p>${
      active
    } of ${total} agent(s) have evidenced activity in the last ${escapeHtml(String(window))} day(s).</p>`;
  };

  return { activityUrl, matches, renderNotices, renderAgents, renderCoverage };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function activityClient(base: DashboardRenderers, view: ActivityRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement | null;
  const main = byId("content");
  const repo = main?.dataset.repo ?? "";
  // No validated project: the server already rendered the no-selection or error state.
  if (!main || !repo) return;
  const window = byId("window") as HTMLSelectElement;
  const state = byId("state")!;
  const notices = byId("notices")!;
  const agents = byId("agents")!;
  const coverage = byId("coverage")!;
  let generation = 0;
  let controller: AbortController | null = null;

  const parseWindow = (): number => {
    const n = Number(window?.value);
    return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1;
  };
  /** Restore the window the URL identifies, and keep the control in sync on history moves. */
  const syncFromUrl = (): number => {
    const n = Number(new URLSearchParams(location.search).get("window"));
    const days = Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1;
    if (window) window.value = String(days);
    return days;
  };

  const render = (envelope: unknown) => {
    state.innerHTML = base.renderState(envelope, false);
    notices.innerHTML = view.renderNotices(envelope);
    agents.innerHTML = view.renderAgents(envelope, parseWindow());
    coverage.innerHTML = view.renderCoverage(envelope, parseWindow());
    agents.classList.remove("provisional");
    coverage.classList.remove("provisional");
  };

  const show = async (refresh: boolean, push: boolean) => {
    const days = parseWindow();
    if (push)
      history.pushState(
        null,
        "",
        `?${new URLSearchParams({ repo, window: String(days) }).toString()}`,
      );
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const current = ++generation;
    agents.classList.add("provisional");
    coverage.classList.add("provisional");
    state.innerHTML = base.renderState(null, true);
    let envelope: unknown;
    try {
      const response = await fetch(view.activityUrl({ repo, window: days, refresh }), {
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
    render(envelope);
  };

  byId("selection")!.addEventListener("submit", (event) => {
    event.preventDefault();
    void show(false, true);
  });
  byId("refresh")!.addEventListener("click", () => void show(true, false));
  addEventListener("popstate", () => {
    syncFromUrl();
    void show(false, false);
  });
  addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) {
      syncFromUrl();
      void show(false, false);
    }
  });
  // Only this view is read: one project, on load or on request.
  void show(false, false);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const activityScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(() => {\nconst base = (${dashboardRenderers.toString()})();\n(${activityClient.toString()})(base, (${activityRenderers.toString()})(base));\n})();\n`;
