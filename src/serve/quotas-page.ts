/**
 * GitHub quota meters in `pdb serve` (#548, doc/design/github-quotas.md "Serve JSON and visual
 * page", owner decisions on #548).
 *
 * `GET /api/v1/quotas` returns the shared `quota-view` from the server's one QuotaService (the
 * same service and model as `pdb quotas`), for the server's verified gh host and login. It is an
 * explicit read that may fetch; the passive `/api/v1/diagnostics/*` views are unchanged.
 *
 * `/quotas` is account-scoped (doc/design/served-page-shell.md): it takes no project. Opening it
 * fetches nothing; the human presses Refresh, which asks for one fresh reading. When that
 * refresh fails, the page clears every earlier number and shows the error: it never leaves an
 * older reading visible as if current. The HTML has no inline script or style; `/quotas.js` is
 * generated from the self-contained functions below and reuses the dashboard's escaping.
 */
import { dashboardRenderers } from "./dashboard.js";
import type { DashboardRenderers } from "./dashboard.js";
import { HttpFailure, sendJson } from "./http.js";
import { escapeHtml } from "./rules-page.js";
import type { RequestContext } from "./types.js";
import type { QuotaContext, QuotaService } from "../github/quotas.js";

/** The page takes no parameters: it is account-wide, never per project. */
export const quotasPageParameters = [] as const;
/** The API takes only explicit Boolean refresh or offline, never a host, login or path. */
export const quotasApiParameters = ["refresh", "offline"] as const;

/** `GET /api/v1/quotas[?refresh=true|offline=true]`: the shared view, never cached by browsers. */
export function quotasApi(
  service: QuotaService,
  /**
   * The verified gh context. A refresh re-reads the login first (a switched login is noticed);
   * an offline read uses only the held context and makes no request at all.
   */
  context: (
    mode: "refresh" | "read" | "offline",
  ) => Promise<{ context: QuotaContext; contextRequests: number }>,
) {
  return async (request: RequestContext): Promise<boolean> => {
    if (request.url.pathname !== "/api/v1/quotas") return false;
    if (request.request.method !== "GET" && request.request.method !== "HEAD")
      throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
    const query = request.url.searchParams;
    const flags: Record<string, boolean> = {};
    for (const key of new Set(query.keys())) {
      if (!(quotasApiParameters as readonly string[]).includes(key))
        throw new HttpFailure(
          400,
          "INVALID_ARGUMENT",
          `Unknown parameter. /api/v1/quotas accepts ${quotasApiParameters.join(", ")}.`,
        );
      const values = query.getAll(key);
      if (values.length > 1 || (values[0] !== "true" && values[0] !== "false"))
        throw new HttpFailure(400, "INVALID_ARGUMENT", `Give ${key} once, as true or false.`);
      flags[key] = values[0] === "true";
    }
    if (flags.refresh && flags.offline)
      throw new HttpFailure(400, "INVALID_ARGUMENT", "refresh and offline are mutually exclusive.");
    let view;
    try {
      const selected = await context(
        flags.refresh ? "refresh" : flags.offline ? "offline" : "read",
      );
      view = await service.view(selected.context, {
        refresh: !!flags.refresh,
        offline: !!flags.offline,
        signal: request.signal,
        contextRequests: selected.contextRequests,
      });
    } catch (error) {
      // The caller went away: nothing to answer.
      if (request.signal.aborted) {
        request.response.destroy();
        return true;
      }
      throw error;
    }
    sendJson(request.response, 200, view);
    return true;
  };
}

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pdb quotas</title>
<link rel="stylesheet" href="/dashboard.css">
<script src="/quotas.js" defer></script>
</head>
<body>
`;

export interface QuotasPageResult {
  status: number;
  html: string;
}

/**
 * The account-scoped page shell: no project, no data, no GitHub read. Until the shared toolbar
 * (#605) lands, the header carries plain links to the other pages, none with a project.
 */
export function quotasPage(query: URLSearchParams, account: QuotaContext): QuotasPageResult {
  const header = `<header>
<h1>GitHub quotas</h1>
<nav aria-label="Pages"><a href="/">Work</a> · <a href="/human">Human attention</a> · <a href="/rules">Project rules</a> · <a href="/setup">Agent setup</a> · <a href="/quotas" aria-current="page">Quotas</a></nav>
<p class="scope">Account-wide: <strong id="quota-account">${escapeHtml(account.login ?? "unverified login")}</strong> on <strong id="quota-host">${escapeHtml(account.host)}</strong>. These quotas belong to the GitHub login, not to any project, and include other agents, machines and applications.</p>
</header>
`;
  const footer = `<footer>Read-only. One GET /rate_limit per Refresh, through the same service as <code>pdb quotas</code>; nothing is fetched on open or in the background. Model-provider, Codex and CodeRabbit quotas are separate and not shown.</footer>
</body>
</html>
`;
  if ([...query.keys()].length)
    return {
      status: 400,
      html: `${head}${header}<main id="content">
<p class="error" role="alert">/quotas takes no parameters: quotas are account-wide, not per project.</p>
</main>
${footer}`,
    };
  return {
    status: 200,
    html: `${head}${header}<main id="content">
<p><button id="refresh" type="button">Refresh</button> <span id="clock"></span></p>
<section id="state" aria-live="polite"><p>No reading has been taken yet. Press Refresh to read GitHub's /rate_limit once; nothing is fetched until you do.</p></section>
<section id="meters" aria-labelledby="meters-heading"></section>
<section id="secondary"></section>
<section id="notes"></section>
<p class="note">Warning at 20% remaining or less and critical below 5% remaining are PDB display heuristics, compared on GitHub's exact counts. They are not GitHub limits, forecasts of burst behaviour or guaranteed remaining requests.</p>
</main>
${footer}`,
  };
}

export interface QuotaRenderers {
  /** Everything after a successful answer; a failed refresh renders no numbers at all. */
  render(
    view: unknown,
    nowMs: number,
  ): { state: string; meters: string; secondary: string; notes: string };
  /** The error of a refresh that reached no view (network, server error). */
  renderUnreachable(message: string): {
    state: string;
    meters: string;
    secondary: string;
    notes: string;
  };
  /** Seconds until `resetAt`, as text, or the reset-passed statement. */
  countdown(resetAt: string, nowMs: number): string;
}

/** Pure HTML-string renderers over the shared quota view; every string is escaped. */
export function quotaRenderers(base: DashboardRenderers): QuotaRenderers {
  const escapeHtml = (text: unknown): string => base.escapeHtml(text);
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const names: Record<string, string> = {
    core: "REST core",
    graphql: "GraphQL",
    search: "Search",
    code_search: "Code search",
  };
  const units: Record<string, string> = {
    "rest-requests": "requests",
    "graphql-points": "points",
    "search-requests": "requests",
    requests: "requests",
  };
  // Text and a symbol for every state: colour (the native meter's) is only a supplement.
  const stateText: Record<string, string> = {
    normal: "✓ OK",
    warning: "! Warning: 20% or less remaining",
    critical: "‼ Critical: below 5% remaining",
    exhausted: "✕ Exhausted: none remaining",
    "zero-limit": "? Limit is 0: no usable allowance shown",
    unknown: "? Unknown: GitHub did not report a complete reading",
    inconsistent: "? Inconsistent: contradictory values, shown as reported",
    "reset-passed": "↻ Reset passed: refresh needed",
  };
  const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

  const countdown = (resetAt: string, nowMs: number): string => {
    const at = Date.parse(resetAt);
    if (!Number.isFinite(at)) return "reset unknown";
    const seconds = Math.round((at - nowMs) / 1000);
    if (seconds <= 0) return "reset passed; refresh needed";
    const m = Math.floor(seconds / 60);
    return `resets in ${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m ? `${m} min` : `${seconds} s`}`;
  };

  const card = (raw: unknown, nowMs: number): string => {
    const row = record(raw);
    const resource = str(row.resource);
    const name = names[resource] ?? resource;
    const unit = units[str(row.unit)] ?? "requests";
    const resetAtRaw = str(row.resetAt);
    // A crossed reset voids the claim to current capacity on this clock too, without a fetch.
    const crossed = resetAtRaw !== "" && Date.parse(resetAtRaw) <= nowMs;
    const state = crossed && str(row.state) !== "inconsistent" ? "reset-passed" : str(row.state);
    const limit = num(row.limit);
    const used = num(row.used);
    const remaining = num(row.remaining);
    const resetAt = str(row.resetAt);
    const percent = num(row.percentUsed);
    // A bar only for a valid, current, nonzero limit: never a full or healthy bar for unknown.
    const barred =
      ["normal", "warning", "critical", "exhausted"].includes(state) &&
      limit !== null &&
      limit > 0 &&
      used !== null &&
      remaining !== null;
    const label = `${name}: ${used ?? "unknown"} of ${limit ?? "unknown"} ${unit} used${percent !== null ? ` (${percent}%)` : ""}, ${remaining ?? "unknown"} remaining`;
    const meter = barred
      ? `<meter min="0" max="${escapeHtml(limit)}" low="${escapeHtml(limit! * 0.8)}" high="${escapeHtml(limit! * 0.95)}" optimum="0" value="${escapeHtml(used)}" aria-label="${escapeHtml(name)} usage" aria-valuetext="${escapeHtml(label)}">${escapeHtml(label)}</meter>`
      : '<p class="nobar">No bar: this reading cannot be drawn as a share of a limit.</p>';
    const reset = resetAt
      ? `Resets ${escapeHtml(utc(resetAt))} (<span class="countdown" data-reset="${escapeHtml(resetAt)}">${escapeHtml(countdown(resetAt, nowMs))}</span>)`
      : "Reset time unknown";
    const reasons = list(row.inconsistencies).map(escapeHtml).join(", ");
    return `<li class="quota quota-${escapeHtml(state)}"><h3>${escapeHtml(name)} <span class="kind state">${escapeHtml(stateText[state] ?? state)}</span></h3>
${meter}
<p class="counts">${escapeHtml(used ?? "unknown")}${row.usedDerived === true ? " (derived: limit − remaining)" : ""} / ${escapeHtml(limit ?? "unknown")} ${escapeHtml(unit)} used${percent !== null ? ` (${escapeHtml(percent)}%)` : ""} · ${escapeHtml(remaining ?? "unknown")} remaining</p>
<p>${reset}</p>${reasons ? `<p class="warn">Contradictions: ${reasons}</p>` : ""}</li>`;
  };

  const noticeText = (raw: unknown): string | null => {
    const n = record(raw);
    switch (n.code) {
      case "header-disagrees":
        return `${names[str(n.resource)] ?? str(n.resource)}: a response header reported a different remaining count than this aggregate; both are kept.`;
      case "refusal-with-headroom":
        return `${names[str(n.resource)] ?? str(n.resource)}: a request was refused for quota although allowance now remains; this reading does not explain that refusal.`;
      case "missing-family":
        return `No ${str(n.family)} bucket was reported; its allowance is unknown.`;
      case "omitted-resources":
        return `${num(n.count) ?? "Some"} further resource(s) are not shown.`;
      case "account-unverified":
        return "The gh login could not be verified; this reading is not reused.";
      case "clock-rollback":
        return "The clock is earlier than the observation time; its age is unknown.";
      case "secondary-observed":
        return `${num(n.count) ?? "Some"} secondary-limit event(s) were observed despite the primary meters.`;
      default:
        return null;
    }
  };

  const secondaryHtml = (view: Record<string, unknown>) => {
    const s = record(view.secondary);
    const events = list(s.events).map(record);
    const history = events.length
      ? `<ul>${events
          .map(
            (e) =>
              `<li>${escapeHtml(str(e.observedAt))}: ${escapeHtml(str(e.category))} (${escapeHtml(str(e.operation))})${e.retryAt ? `; retry not before ${escapeHtml(str(e.retryAt))}` : typeof e.retryAfterSeconds === "number" ? `; GitHub asked to wait ${escapeHtml(String(e.retryAfterSeconds))}s` : ""}</li>`,
          )
          .join(
            "",
          )}</ul>${num(s.omitted) ? `<p>${escapeHtml(s.omitted)} older event(s) not shown.</p>` : ""}`
      : `<p>No throttling events retained since ${escapeHtml(str(s.since) || "this server started")}; that does not mean there was no throttling.</p>`;
    return `<h2>Secondary limits: unmetered</h2><p>GitHub gives no advance meter for secondary limits, so none is drawn. Recent observed throttling for this login, kept in memory by this server:</p>${history}`;
  };

  const blank = { meters: "", secondary: "", notes: "" };

  const render = (raw: unknown, nowMs: number) => {
    const view = record(raw);
    if (view.kind !== "quota-view")
      return {
        ...blank,
        state: '<p class="error" role="alert">The server returned no quota view.</p>',
      };
    const failure = record(view.failure);
    const embargo = record(view.embargo);
    // Owner decision (#548): a failed refresh clears every earlier number on the page.
    if (Object.keys(failure).length || view.freshness === "unavailable")
      return {
        ...blank,
        state: `<p class="error" role="alert">Refresh failed${failure.category ? ` (${escapeHtml(failure.category)}${num(failure.httpStatus) !== null ? `, HTTP ${escapeHtml(failure.httpStatus)}` : ""})` : ""} at ${escapeHtml(str(failure.observedAt) || "an unknown time")}. No quota numbers are shown, because an older reading would not be current.${embargo.retryAt ? ` GitHub asked the quota lookup to wait until ${escapeHtml(str(embargo.retryAt))}; it was not sent early.` : ""} Nothing was retried.</p>`,
        secondary: secondaryHtml(view),
      };
    const rows = list(view.resources);
    const coverage = record(view.coverage);
    const age = num(view.ageSeconds);
    const state = `<p>Observed ${escapeHtml(str(view.observedAt))} via GET /rate_limit (${escapeHtml(str(view.freshness))}${age === null ? ", age unknown" : `, ${escapeHtml(age)}s old when read`}) for <strong>${escapeHtml(str(view.account) || "an unverified login")}</strong> on ${escapeHtml(str(view.host))}.</p>${
      coverage.complete === false
        ? `<p class="warn">${escapeHtml(num(coverage.omitted) ?? 0)} of ${escapeHtml(num(coverage.total) ?? 0)} reported resource(s) are not shown.</p>`
        : ""
    }`;
    const notes = list(view.notices)
      .map(noticeText)
      .filter((t): t is string => t !== null)
      .map((t) => `<li class="warn">${escapeHtml(t)}</li>`)
      .join("");
    return {
      state,
      meters: `<h2 id="meters-heading">Primary limits (${rows.length})</h2><p>Each resource keeps its own unit and reset window; they are never added together.</p>${
        rows.length
          ? `<ul class="quotas">${rows.map((r) => card(r, nowMs)).join("")}</ul>`
          : '<p class="warn">GitHub reported no resources; their allowance is unknown.</p>'
      }`,
      secondary: secondaryHtml(view),
      notes: notes ? `<h2>Notes</h2><ul>${notes}</ul>` : "",
    };
  };

  const renderUnreachable = (message: string) => ({
    ...blank,
    state: `<p class="error" role="alert">Refresh failed: ${escapeHtml(message)}. No quota numbers are shown, because an older reading would not be current.</p>`,
  });

  return { render, renderUnreachable, countdown };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function quotasClient(view: QuotaRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const button = byId("refresh") as HTMLButtonElement;
  const state = byId("state");
  const meters = byId("meters");
  const secondary = byId("secondary");
  const notes = byId("notes");
  const account = byId("quota-account");
  const host = byId("quota-host");
  /**
   * Reflect the account the last refresh actually read: a switched gh login is reported by the
   * API on refresh, and the header must never name A while showing B's quotas. A failed refresh
   * leaves the label unknown ("unverified login") rather than stale-A.
   */
  const updateAccount = (raw: unknown) => {
    const view = (raw ?? {}) as { account?: unknown; accountVerified?: unknown; host?: unknown };
    const login = view.account;
    const holds = typeof login === "string" && login !== "" && view.accountVerified === true;
    account.textContent = holds ? login : "unverified login";
    if (typeof view.host === "string" && view.host !== "") host.textContent = view.host;
  };
  let controller: AbortController | null = null;
  let generation = 0;
  /** The last successful view, redrawn locally as time passes; never re-fetched. */
  let shown: unknown = null;
  const show = (parts: { state: string; meters: string; secondary: string; notes: string }) => {
    state.innerHTML = parts.state;
    meters.innerHTML = parts.meters;
    secondary.innerHTML = parts.secondary;
    notes.innerHTML = parts.notes;
  };
  const refresh = async () => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const current = ++generation;
    button.disabled = true;
    // Earlier numbers are cleared while reading, so nothing old looks current; the local redraw
    // timer must not bring them back either.
    shown = null;
    show({ state: "<p>Reading GitHub's /rate_limit…</p>", meters: "", secondary: "", notes: "" });
    let body: unknown;
    let failure: string | null = null;
    try {
      const response = await fetch("/api/v1/quotas?refresh=true", {
        headers: { accept: "application/json" },
        signal: mine.signal,
      });
      body = await response.json();
      if (!response.ok) {
        const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
        const code = typeof error?.code === "string" ? error.code : `HTTP ${response.status}`;
        const message = typeof error?.message === "string" ? error.message : "the request failed";
        failure = `${code}: ${message}`;
      }
    } catch (error) {
      if (mine.signal.aborted) return;
      failure = String(error);
    }
    if (current !== generation) return;
    button.disabled = false;
    shown = failure ? null : body;
    updateAccount(failure ? null : body);
    show(failure ? view.renderUnreachable(failure) : view.render(body, Date.now()));
  };
  button.addEventListener("click", () => void refresh());
  // Countdowns move on locally, and a bucket whose reset passes loses its bar and becomes
  // "reset passed; refresh needed". No request is ever made by this timer.
  setInterval(() => {
    if (shown !== null) show(view.render(shown, Date.now()));
  }, 30_000);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const quotasScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(${quotasClient.toString()})((${quotaRenderers.toString()})((${dashboardRenderers.toString()})()));\n`;
