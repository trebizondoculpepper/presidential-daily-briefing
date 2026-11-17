/** Explicit, read-only Doctor/Ticket Doctor page (#585). Opening it never starts a run. */
import { dashboardRenderers } from "./dashboard.js";
import type { DashboardRenderers } from "./dashboard.js";
import { htmlEscape, pageById, shellContext, shellStart } from "./shell.js";
import type { ServedProject } from "./shell.js";

export const diagnosticsPageParameters = pageById("diagnostics").parameters;
export function diagnosticsPage(query: URLSearchParams, served: readonly ServedProject[] = []) {
  const context = shellContext("diagnostics", served, query);
  const tab = query.get("tab") ?? "doctor";
  if (tab !== "doctor" && tab !== "ticket-doctor") {
    context.selection = {
      ...context.selection,
      state: "malformed",
      status: 400,
      message: "tab must be doctor or ticket-doctor.",
    };
  }
  if (context.selection.status !== 200)
    return {
      status: context.selection.status,
      html: `${shellStart(context, "Diagnostics")}<main id="content" tabindex="-1"><h1>Diagnostics</h1><p class="error" role="alert">${htmlEscape(context.selection.message ?? "Invalid selection.")}</p></main></body></html>`,
    };
  const ticket = tab === "ticket-doctor",
    repo = context.selection.repository;
  return {
    status: 200,
    html: `${shellStart(context, "Diagnostics", "/diagnostics.js")}
<main id="content" tabindex="-1" data-diagnostic-tab="${tab}" data-diagnostic-repo="${htmlEscape(repo)}">
<h1>Diagnostics</h1><p>Inspect the server or a project's tickets. Suggested fixes are displayed as text; nothing repairs or changes configuration or GitHub.</p>
<div role="tablist" aria-label="Diagnostic tool" class="diagnostic-tabs">
<button id="doctor-tab" type="button" role="tab" aria-controls="diagnostic-panel" aria-selected="${!ticket}" tabindex="${ticket ? -1 : 0}">Doctor</button>
<button id="ticket-doctor-tab" type="button" role="tab" aria-controls="diagnostic-panel" aria-selected="${ticket}" tabindex="${ticket ? 0 : -1}">Ticket Doctor</button>
</div>
<section id="diagnostic-panel" role="tabpanel" aria-labelledby="${tab}-tab">
<h2 id="diagnostic-title">${ticket ? "Ticket Doctor" : "Server machine: checks run where pdb serve runs"}</h2>
<p id="diagnostic-scope">${ticket ? (repo ? `Read-only consistency scan for ${htmlEscape(repo)}.` : "Select a project above to run Ticket Doctor.") : "Doctor checks the machine running this server, not your browser's computer. Project checks require a registered local checkout."}</p>
<fieldset id="diagnostic-options"${ticket ? "" : " hidden"}><legend>Ticket scan options</legend>
<label>Maximum tickets shown <input id="diagnostic-limit" type="number" min="1" step="1" value="30"></label>
<label>Stale after hours <input id="diagnostic-stale" type="number" min="0" step="any" value="24"></label>
</fieldset>
<p class="diagnostic-controls"><button id="diagnostic-run" type="button"${ticket && !repo ? " disabled" : ""}>Run</button> <button id="diagnostic-cancel" type="button" hidden>Cancel</button></p>
<section id="diagnostic-live" aria-live="polite" aria-atomic="false"><div id="diagnostic-state"><p>No run requested. Run starts an explicit read; opening this page does not run diagnostics.</p></div><div id="diagnostic-progress"></div></section>
<section id="diagnostic-results" class="diagnostic-results" aria-label="Diagnostic results"></section>
</section></main><footer>Read-only. Earlier results are labelled with their run/source times. This page follows only a run you explicitly start or join.</footer></body></html>`,
  };
}

export interface DiagnosticRenderers {
  render(raw: unknown, retained: boolean): { state: string; progress: string; result: string };
  failure(message: string): string;
}
/** Pure projection of native reports; no matching policy, command execution or inferred health. */
export function diagnosticRenderers(
  base: Pick<DashboardRenderers, "escapeHtml">,
): DiagnosticRenderers {
  const e = base.escapeHtml;
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const count = (v: unknown): string =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : "unknown";
  const plural = (v: unknown, label: string) =>
    `${count(v)} ${label}${count(v) === "1" ? "" : "s"}`;
  const phaseNames: Record<string, string> = {
    runtime: "Runtime",
    dependencies: "Installation dependencies",
    gh: "GitHub CLI and authentication",
    project: "Project checkout",
    identity: "Agent identity",
    collect: "Collect ticket evidence",
    delivery: "Read delivery evidence",
    "closed-scan": "Closed issue scan",
    findings: "Findings",
  };
  const stamp = (v: unknown): string =>
    typeof v === "string" && Number.isFinite(Date.parse(v))
      ? `<time datetime="${e(v)}">${e(v)}</time>`
      : "unknown";
  const commands = (v: unknown) =>
    list(v)
      .filter((s) => typeof s === "string")
      .map((s) => `<pre class="rules"><code>${e(s)}</code></pre>`)
      .join("");
  const failure = (message: string) => `<p class="error" role="alert">${e(message)}</p>`;
  const plan = (raw: unknown) => {
    const value = rec(raw);
    return `${value.judgment ? "<p>Judgment required: the following are alternatives, not automatic fixes.</p>" : ""}
${list(value.facts)
  .map((fact) => `<p>Fact: ${e(fact)}</p>`)
  .join("")}
${list(value.steps)
  .map((rawStep) => {
    const step = rec(rawStep);
    return `<div class="diagnostic-plan"><p><strong>${e(step.kind)}${step.choice ? ` ${e(step.choice)}` : ""}</strong>${step.runBy ? ` · ${e(step.runBy)}` : ""}: ${e(step.description)}</p>
${list(step.preconditions)
  .map((p) => `<p>Only if: ${e(p)}</p>`)
  .join("")}${commands([step.command])}</div>`;
  })
  .join("")}`;
  };
  const ticket = (raw: unknown, repository: string, host: string) => {
    const t = rec(raw),
      n = t.number;
    const valid = typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    const internal = valid
      ? `/ticket?${new URLSearchParams({ repo: repository, n: String(n) })}`
      : null;
    let external: string | null = null;
    try {
      const url = new URL(str(t.url));
      const path = url.pathname.toLowerCase(),
        project = repository.toLowerCase();
      if (
        valid &&
        url.protocol === "https:" &&
        url.host === host &&
        !url.username &&
        !url.password &&
        [`/${project}/issues/${n}`, `/${project}/pull/${n}`].includes(path)
      )
        external = url.toString();
    } catch {
      /* Missing link stays absent; it is never guessed from arbitrary text. */
    }
    return `<article class="diagnostic-ticket"><h3>${internal ? `<a href="${e(internal)}">#${e(n)}</a>` : "Ticket"} ${e(t.title)}${external ? ` <a class="detail" href="${e(external)}">GitHub</a>` : ""}</h3>
${list(t.findings)
  .map((rawFinding) => {
    const finding = rec(rawFinding);
    return `<details class="diagnostic-finding"><summary>${e(finding.certainty)} · ${e(finding.kind)}</summary><p>${e(finding.detail)}</p>${plan(finding.plan)}</details>`;
  })
  .join("")}</article>`;
  };
  const render = (raw: unknown, retained: boolean) => {
    const run = rec(raw),
      context = rec(run.context),
      report = rec(run.result);
    const state = str(run.state);
    if (state === "none")
      return {
        state: "<p>No retained run for these options. Press Run to read current evidence.</p>",
        progress: "",
        result: "",
      };
    const error = rec(run.error);
    const heading =
      state === "running"
        ? "Run in progress"
        : state === "completed"
          ? "Run completed"
          : state === "partial"
            ? "Run completed with incomplete evidence"
            : state === "cancelled"
              ? "Run cancelled"
              : "Run failed";
    const stateHtml = `<p><strong>${heading}</strong>${retained ? " · retained result, not a new reading" : ""}</p>
<p>Server host: ${e(context.host)} · GitHub login: ${context.login === null ? "not verified" : e(context.login)}${context.repository ? ` · Project: ${e(context.repository)}` : " · Host scope"}</p>
<p>Started ${stamp(run.startedAt)}${run.finishedAt ? ` · Finished ${stamp(run.finishedAt)}` : ""}</p>
${error.code ? failure(`${str(error.code)}: ${str(error.message)}`) + commands(error.next) : ""}
${retained && state === "running" ? "<p>An equivalent execution is running. Press Run to join and watch it.</p>" : ""}`;
    const progress = `<ol class="diagnostic-progress">${list(run.progress)
      .map((rawStep) => {
        const step = rec(rawStep);
        return `<li><strong>${e(phaseNames[str(step.step)] ?? step.step)}</strong>: ${e(step.state)}${step.detail ? ` · ${e(step.detail)}` : ""}</li>`;
      })
      .join("")}</ol>`;
    let result = "";
    if (report.scope === "local-configuration" && run.run === "doctor") {
      result = `<h2>Server checks</h2><ul class="diagnostic-checks">${list(report.checks)
        .map((rawCheck) => {
          const check = rec(rawCheck);
          return `<li><h3>${e(check.id)} · ${e(check.status)}</h3><p>${e(check.detail)}</p><p class="note">Source: ${e(check.source)}</p>${commands(check.next)}</li>`;
        })
        .join("")}</ul>`;
    } else if (report.kind === "ticket-doctor" && run.run === "ticket-doctor") {
      if (report.repository !== context.repository)
        result = failure("The report belongs to a different project; it is not shown.");
      else {
        const summary = rec(report.summary),
          completeness = rec(report.completeness),
          freshness = rec(report.freshness);
        result = `<h2>Ticket findings</h2>${completeness.complete !== true ? '<p class="warn">Incomplete coverage: missing evidence is unknown.</p>' : ""}
${list(completeness.warnings)
  .map((warning) => `<p class="warn">${e(warning)}</p>`)
  .join("")}
<p>Source fetched ${stamp(report.fetchedAt)}${freshness.offline ? " · Offline evidence, not verified live" : ""}. ${plural(report.scanned, "open ticket")} scanned.</p>
<p>${plural(summary.tickets, "ticket")} with findings · ${count(summary.definite)} definite · ${count(summary.candidate)} candidate · ${count(summary.unknown)} unknown.</p>
<p>${e(report.guidance)}</p>${list(report.tickets)
          .map((t) => ticket(t, str(context.repository), str(context.host)))
          .join("")}
${typeof report.omittedTickets === "number" && report.omittedTickets > 0 ? `<p class="warn">${plural(report.omittedTickets, "further ticket")} omitted. Raise the shown-ticket limit for another explicit run.</p>` : ""}
${!list(report.tickets).length ? "<p>No findings in the available evidence.</p>" : ""}`;
      }
    }
    if (run.result !== null && run.result !== undefined && !result)
      result = failure("This response contains an unrecognized report; it is not shown.");
    return { state: stateHtml, progress, result };
  };
  return { render, failure };
}

/** Self-contained browser controller; polling exists only for this page's explicit waiter. */
export function diagnosticsClient(view: DiagnosticRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const root = byId("content"),
    runButton = byId("diagnostic-run") as HTMLButtonElement;
  if (!root || !runButton) return;
  const cancelButton = byId("diagnostic-cancel") as HTMLButtonElement;
  const state = byId("diagnostic-state"),
    progress = byId("diagnostic-progress"),
    result = byId("diagnostic-results"),
    live = byId("diagnostic-live");
  const limit = byId("diagnostic-limit") as HTMLInputElement,
    stale = byId("diagnostic-stale") as HTMLInputElement;
  const tabs = [byId("doctor-tab"), byId("ticket-doctor-tab")];
  let tab = root.dataset.diagnosticTab === "ticket-doctor" ? "ticket-doctor" : "doctor";
  let repo: string | null = root.dataset.diagnosticRepo || null;
  let generation = 0,
    waiter: string | null = null,
    timer: number | null = null;
  let reading: AbortController | null = null,
    lastRendered = "";
  const rec = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : "The diagnostic request failed.";
  const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      response = await fetch(path, { ...init, headers });
    } catch {
      throw new Error("The server could not be reached. Retry this read.");
    }
    let body: unknown = null;
    if (response.status !== 204) {
      try {
        body = await response.json();
      } catch {
        throw new Error("The server returned an unreadable diagnostic response.");
      }
    }
    if (!response.ok) {
      const failure = rec(rec(body).error);
      throw Object.assign(
        new Error(
          `${typeof failure.code === "string" ? failure.code : `HTTP ${response.status}`}: ${typeof failure.message === "string" ? failure.message : "The request failed."}`,
        ),
        { status: response.status },
      );
    }
    return body;
  };
  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    reading?.abort();
    reading = null;
    live.setAttribute("aria-busy", "false");
  };
  const release = (id: string, keepalive = false) =>
    api(`/api/v1/diagnostic-runs/waiters/${encodeURIComponent(id)}`, {
      method: "DELETE",
      keepalive,
    });
  const detach = (keepalive = false) => {
    const id = waiter;
    waiter = null;
    stop();
    if (id) void release(id, keepalive).catch(() => undefined);
  };
  const request = () => {
    if (tab === "doctor") return { kind: tab, repo, options: {} };
    if (!repo) throw new Error("Select a project to run Ticket Doctor.");
    const maximum = Number(limit.value),
      hours = Number(stale.value);
    if (!Number.isInteger(maximum) || maximum <= 0 || !Number.isFinite(hours) || hours <= 0)
      throw new Error("Give a positive whole-number ticket limit and positive stale hours.");
    return { kind: tab, repo, options: { limit: maximum, staleHours: hours } };
  };
  const matches = (body: unknown, allowNone = false, kind = tab, repository = repo) => {
    const value = rec(body),
      context = rec(value.context);
    return (
      (allowNone && value.state === "none") ||
      (value.kind === "diagnostic-run" &&
        value.schemaVersion === 1 &&
        value.run === kind &&
        context.repository === repository &&
        typeof context.host === "string" &&
        ["running", "completed", "partial", "failed", "cancelled"].includes(String(value.state)))
    );
  };
  const show = (body: unknown, retained: boolean) => {
    const key = JSON.stringify([body, retained]);
    if (key === lastRendered) return;
    lastRendered = key;
    const parts = view.render(body, retained);
    state.innerHTML = parts.state;
    progress.innerHTML = parts.progress;
    result.innerHTML = parts.result;
  };
  const clear = (message: string) => {
    lastRendered = "";
    state.textContent = message;
    progress.innerHTML = "";
    result.innerHTML = "";
  };
  const controls = (busy: boolean, label = "Run") => {
    runButton.disabled = busy || (tab === "ticket-doctor" && !repo);
    runButton.textContent = label;
    cancelButton.hidden = waiter === null;
    cancelButton.disabled = false;
    live.setAttribute("aria-busy", busy ? "true" : "false");
  };
  const watch = async (token: number) => {
    if (token !== generation || !waiter) return;
    const id = waiter;
    reading = new AbortController();
    try {
      const body = await api(`/api/v1/diagnostic-runs/waiters/${encodeURIComponent(id)}`, {
        signal: reading.signal,
      });
      if (token !== generation) return;
      if (!matches(body) || rec(body).waiterId !== id)
        throw new Error("The response does not match this diagnostic subscription.");
      show(body, false);
      if (rec(body).state === "running") {
        controls(true, "Running…");
        timer = window.setTimeout(() => void watch(token), 500);
      } else {
        waiter = null;
        stop();
        controls(false, "Run again");
      }
    } catch (error) {
      if (token !== generation) return;
      stop();
      const expired = rec(error).status === 404;
      if (expired) waiter = null;
      state.innerHTML = view.failure(errorText(error));
      controls(false, expired ? "Run again" : "Retry status");
    }
  };
  const latest = async () => {
    const token = ++generation;
    detach();
    controls(true);
    clear("Looking for the last retained run…");
    if (tab === "ticket-doctor" && !repo) {
      controls(false);
      clear("Select a project to run Ticket Doctor.");
      return;
    }
    try {
      const selected = request(),
        query = new URLSearchParams({ kind: selected.kind });
      if (selected.repo) query.set("repo", selected.repo);
      for (const [key, value] of Object.entries(selected.options)) query.set(key, String(value));
      reading = new AbortController();
      const body = await api(`/api/v1/diagnostic-runs/latest?${query}`, { signal: reading.signal });
      if (token !== generation) return;
      if (!matches(body, true))
        throw new Error("The retained response belongs to a different diagnostic context.");
      show(body, true);
      stop();
      controls(false, rec(body).state === "running" ? "Join run" : "Run");
    } catch (error) {
      if (token !== generation) return;
      stop();
      state.innerHTML = view.failure(errorText(error));
      controls(false);
    }
  };
  const start = async () => {
    if (waiter) {
      controls(true, "Reading status…");
      void watch(generation);
      return;
    }
    const token = ++generation;
    stop();
    controls(true, "Requesting…");
    clear("Requesting an explicit diagnostic run…");
    try {
      const selected = request();
      // Do not abort an unacknowledged POST: if selection changes, release its late handle.
      const body = await api("/api/v1/diagnostic-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selected),
      });
      const id = rec(body).waiterId;
      if (token !== generation) {
        if (
          matches(body, false, selected.kind, selected.repo) &&
          typeof id === "string" &&
          /^[A-Za-z0-9-]{1,100}$/.test(id)
        )
          void release(id, true).catch(() => undefined);
        return;
      }
      if (!matches(body) || typeof id !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(id))
        throw new Error("The server did not return a valid diagnostic subscription.");
      waiter = id;
      show(body, false);
      controls(true, "Running…");
      void watch(token);
    } catch (error) {
      if (token !== generation) return;
      stop();
      state.innerHTML = view.failure(errorText(error));
      controls(false);
    }
  };
  const cancel = async () => {
    if (!waiter) return;
    const id = waiter,
      token = ++generation;
    stop();
    cancelButton.disabled = true;
    clear("Cancelling this diagnostic subscription…");
    try {
      await release(id);
      if (token !== generation) return;
      waiter = null;
      try {
        const body = await api(`/api/v1/diagnostic-runs/waiters/${encodeURIComponent(id)}`);
        if (token !== generation) return;
        if (!matches(body)) throw new Error("No matching retained status.");
        show(body, false);
      } catch {
        if (token === generation)
          clear(
            "Stopped watching. The cancellation request was accepted; no retained status is available.",
          );
      }
      if (token === generation) controls(false, "Run again");
    } catch (error) {
      if (token !== generation) return;
      state.innerHTML = view.failure(`Cancellation was not confirmed. ${errorText(error)}`);
      controls(false, "Retry status");
    }
  };
  const select = (next: string, updateUrl = true) => {
    tab = next === "ticket-doctor" ? "ticket-doctor" : "doctor";
    root.dataset.diagnosticTab = tab;
    tabs.forEach((button, index) => {
      const active = index === (tab === "doctor" ? 0 : 1);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    byId("diagnostic-panel").setAttribute("aria-labelledby", `${tab}-tab`);
    byId("diagnostic-options").hidden = tab !== "ticket-doctor";
    byId("diagnostic-title").textContent =
      tab === "doctor" ? "Server machine: checks run where pdb serve runs" : "Ticket Doctor";
    byId("diagnostic-scope").textContent =
      tab === "doctor"
        ? "Doctor checks this server, not your browser's computer. Project checks require a registered local checkout."
        : repo
          ? `Read-only consistency scan for ${repo}.`
          : "Select a project above to run Ticket Doctor.";
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", url);
    }
    // Preserve every link's own project while carrying the tool selected in this page.
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      'a[data-shell-carries~="tab"]',
    )) {
      const url = new URL(link.href, window.location.href);
      url.searchParams.set("tab", tab);
      link.href = url.pathname + url.search + url.hash;
    }
    void latest();
  };
  runButton.addEventListener("click", () => void start());
  cancelButton.addEventListener("click", () => void cancel());
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => select(index === 0 ? "doctor" : "ticket-doctor"));
    button.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      event.preventDefault();
      const target = key === "Home" ? 0 : key === "End" ? 1 : 1 - index;
      tabs[target].focus();
      select(target === 0 ? "doctor" : "ticket-doctor");
    });
  });
  for (const field of [limit, stale]) field.addEventListener("change", () => void latest());
  window.addEventListener("pagehide", () => {
    generation++;
    detach(true);
  });
  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href),
      selected = url.searchParams.get("repo");
    if (selected !== repo) {
      generation++;
      detach(true);
      clear("Project selection changed. Loading its context…");
      window.location.reload();
      return;
    }
    select(url.searchParams.get("tab") ?? "doctor", false);
  });
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) void latest();
  });
  void latest();
}
export const diagnosticsScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(${diagnosticsClient.toString()})((${diagnosticRenderers.toString()})(((${dashboardRenderers.toString()})())));\n`;
