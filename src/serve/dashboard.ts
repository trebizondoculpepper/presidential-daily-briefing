/**
 * The local read-only dashboard served by `pdb serve` at `/` (#374, doc/design/serve.md and
 * doc/design/serve-global-dashboard-roadmap.md).
 *
 * It reads only `/api/v1/briefing`; each issue row links to the read-only
 * ticket detail page (#454, ticket-page.ts), which reads that one ticket only when opened.
 * Ranking, reasons and commands come from the shared engine through that API; nothing here orders or chooses work. The page loads no
 * external resources and has no inline script: the HTML, stylesheet and script are three
 * same-origin responses under a strict Content-Security-Policy.
 *
 * The browser script is generated from the TypeScript below. `dashboardRenderers` and
 * `dashboardClient` are self-contained: they reference no module-level names, so their source
 * text runs on its own in the browser. Tests call the renderers directly and execute the served
 * script in an isolated context to prove it is standalone.
 */

/** Headers for every dashboard response. */
export const dashboardSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

import { shellContext, shellPage, shellCss, type ShellContext } from "./shell.js";

/** The page is rendered for the validated request; its script reads only the selected view. */
export const dashboardPage = (context: ShellContext = shellContext("work")): string =>
  shellPage(
    context,
    "Work",
    `
<form id="selection">
<label>Role <select id="role"><option value="implementer">implementer</option><option value="designer">designer</option><option value="human">human</option></select></label>
<label>Agent <input id="agent" type="text" placeholder="optional" autocomplete="off" spellcheck="false"></label>
<button id="show" type="submit">Show</button><button id="refresh" type="button">Refresh</button>
</form>
<p><a id="human-link" href="/human">Human attention</a> · <a id="activity-link" href="/activity">Activity</a></p>
<section id="state" aria-live="polite"></section><section id="actions"></section>
`,
    "/dashboard.js",
    "Read-only. Ranking, reasons and commands come from the shared rules engine.",
  );

export const dashboardCss = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 70rem; padding: 0 1rem 2rem; }

h1 { font-size: 1.2rem; margin: .25rem 0; }
form { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: end; }
label { display: flex; flex-direction: column; font-size: .8rem; }
#state { margin: 1rem 0; font-size: .9rem; }
.warn { color: #b26b00; }
.error { color: #c62828; font-weight: 600; }
.provisional { opacity: .6; }
ol { padding-left: 1.5rem; }
li { margin: 0 0 1rem; }
.kind { font-size: .75rem; border: 1px solid GrayText; border-radius: .25rem; padding: 0 .3rem; display: inline-block; }
/* Action-kind badge palette (#597): one distinct colour per kind, neutral fallback for
   unknown kinds. Colour is supplementary; the text label is always present. */
.kind.implement { color: #1a5fb4; border-color: #1a5fb4; }
.kind.continue-implementation { color: #1a5fb4; border-color: #1a5fb4; }
.kind.pr-follow-up { color: #c01c28; border-color: #c01c28; }
.kind.inspect, .kind.inspect-ownership, .kind.inspect-assessment { color: #8643c1; border-color: #8643c1; }
.kind.decide, .kind.design, .kind.design-review { color: #b26b00; border-color: #b26b00; }
.kind.document { color: #b26b00; border-color: #b26b00; }
.kind.estimate-complexity, .kind.assess-impact { color: #00793c; border-color: #00793c; }
.kind.resume-claim, .kind.review-owned-work, .kind.wait-claim { color: #613a8e; border-color: #613a8e; }
.kind.addressed-response { color: #005b57; border-color: #005b57; }
/* Dark canvases need lighter badge text: the default palette's dark foregrounds lose contrast
   on the supported dark colour scheme. Hues stay per-kind; only lightness rises. */
@media (prefers-color-scheme: dark) {
  .kind.implement, .kind.continue-implementation { color: #8ab4ff; border-color: #8ab4ff; }
  .kind.pr-follow-up { color: #ff8a94; border-color: #ff8a94; }
  .kind.inspect, .kind.inspect-ownership, .kind.inspect-assessment { color: #c9a5ff; border-color: #c9a5ff; }
  .kind.decide, .kind.design, .kind.design-review, .kind.document { color: #ffd28a; border-color: #ffd28a; }
  .kind.estimate-complexity, .kind.assess-impact { color: #8af0b0; border-color: #8af0b0; }
  .kind.resume-claim, .kind.review-owned-work, .kind.wait-claim { color: #e6a5ff; border-color: #e6a5ff; }
  .kind.addressed-response { color: #9ce6df; border-color: #9ce6df; }
}
.why { margin: .2rem 0; }
code { font-size: .85rem; word-break: break-all; }
footer { margin-top: 2rem; font-size: .8rem; color: GrayText; }
pre.rules { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85rem; }
.identity { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
.identity dd { margin: 0; }
ul.projects { display: inline; padding: 0; }
ul.projects li { display: inline; margin: 0 .5rem 0 0; }
.toc li { margin: 0; }
a.detail { font-size: .8rem; margin-left: .4rem; }
blockquote { margin: .2rem 0 .2rem 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.kind.request { font-weight: 600; }
.kind.candidate { border-style: dashed; }
.kind.addressed { font-weight: 600; text-decoration: underline; }
.notice { border-left: 3px solid GrayText; padding-left: .5rem; }
nav a[aria-current] { font-weight: 700; text-decoration-thickness: 3px; }
ul.quotas { list-style: none; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); }
ul.quotas li { border: 1px solid GrayText; border-radius: .4rem; padding: .5rem .75rem; margin: 0; }
ul.quotas h3 { font-size: 1rem; margin: .2rem 0 .5rem; }
ul.quotas meter { width: 100%; height: 1.25rem; }
.quota-warning, .quota-critical, .quota-exhausted { border-width: 3px; }
.quota-critical .state, .quota-exhausted .state { font-weight: 700; }
.quota-unknown, .quota-inconsistent, .quota-zero-limit, .quota-reset-passed { border-style: dashed; }
.nobar, .scope, .note { font-size: .85rem; }
button:focus-visible, a:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
main a, main code { overflow-wrap: anywhere; }
${shellCss}`;

export interface DashboardRenderers {
  escapeHtml(text: unknown): string;
  briefingUrl(selection: { repo: string; role: string; agent: string; refresh?: boolean }): string;
  renderState(envelope: unknown, loading: boolean): string;
  renderActions(envelope: unknown): string;
}

/**
 * Pure HTML-string renderers over the `/api/v1/briefing` envelope. Every value from the server is
 * escaped: titles and reasons are GitHub-authored text.
 */
export function dashboardRenderers(): DashboardRenderers {
  const escapeHtml = (text: unknown): string =>
    String(text ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
    );
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const safeLink = (url: unknown): string | null =>
    typeof url === "string" && url.startsWith("https://github.com/") ? url : null;

  const briefingUrl = (s: { repo: string; role: string; agent: string; refresh?: boolean }) => {
    const query = new URLSearchParams({ repo: s.repo, role: s.role, limit: "50" });
    if (s.agent) query.set("agent", s.agent);
    if (s.refresh) query.set("refresh", "true");
    return `/api/v1/briefing?${query.toString()}`;
  };

  const renderState = (envelope: unknown, loading: boolean): string => {
    const e = record(envelope);
    const parts: string[] = [];
    if (loading) parts.push("<p>Loading… the list below is from the previous request.</p>");
    const error = record(e.error);
    if (e.status === "error" || error.code)
      parts.push(
        `<p class="error">${escapeHtml(error.code ?? "error")}: ${escapeHtml(error.message ?? "the request failed")}</p>`,
      );
    const f = record(e.freshness);
    if (f.observedAt) {
      const source = f.source === "live" ? "collected live" : String(f.source ?? "");
      parts.push(
        `<p>Observed ${escapeHtml(f.observedAt)} (${escapeHtml(f.ageSeconds)}s ago, ${escapeHtml(source)}; cache TTL ${escapeHtml(f.ttlSeconds)}s).</p>`,
      );
      if (f.stale) {
        const refresh = record(f.refreshError);
        parts.push(
          `<p class="warn">Stale snapshot: the last refresh failed (${escapeHtml(refresh.code)}: ${escapeHtml(refresh.message)}). Facts may have changed since it was observed.</p>`,
        );
      }
    }
    const result = record(e.result);
    const completeness = record(result.completeness);
    const selection = record(e.selection);
    // The role the briefing was ranked for, from the result itself: selection.triageRole is the
    // identity's configured role (null for an explicit agent), not the requested view.
    const role =
      record(record(result.decisionEngine).role).used ?? record(result.role).name ?? "unknown";
    if (e.status === "incomplete" || completeness.complete === false) {
      const warnings = list(completeness.warnings);
      const shown = 10;
      // Bounded like the CLI text, but never silent: say how many were left out and where to
      // read them all (the same selection as JSON).
      const full = briefingUrl({
        repo: String(selection.repository ?? ""),
        role: String(role),
        agent: String(selection.agent ?? ""),
      });
      parts.push(
        `<p class="warn">Incomplete evidence: missing facts are unknown, never approval.</p>${warnings
          .slice(0, shown)
          .map((w) => `<p class="warn">${escapeHtml(w)}</p>`)
          .join("")}${
          warnings.length > shown
            ? `<p class="warn">${warnings.length - shown} more warning(s) not shown; every warning is in the <a href="${escapeHtml(full)}">JSON briefing</a>.</p>`
            : ""
        }`,
      );
    }
    for (const w of list(e.warnings)) parts.push(`<p class="warn">${escapeHtml(w)}</p>`);
    if (selection.identityDiagnostic)
      parts.push(`<p class="warn">${escapeHtml(selection.identityDiagnostic)}</p>`);
    if (selection.repository)
      parts.push(
        `<p>${escapeHtml(selection.repository)} · role ${escapeHtml(role)} · agent ${escapeHtml(selection.agent ?? "none (unfocused)")}</p>`,
      );
    return parts.join("");
  };

  const renderActions = (envelope: unknown): string => {
    const result = record(record(envelope).result);
    const ranked = record(result.rankedActions);
    const items = list(ranked.items);
    if (!Object.keys(result).length) return "";
    if (!items.length) return "<p>No next steps for this selection.</p>";
    const titles = new Map(
      list(result.subjects).map((s) => [record(s).url, record(s).title] as const),
    );
    // The TypeScript engine gives no `why`: fall back to the role view's reason, then the reason
    // codes, exactly as the CLI text renderer does (briefing/compact.ts).
    const roleReasons = new Map(
      list(record(result.role).sections).flatMap((section) =>
        list(record(section).items).map((row) => [record(row).url, record(row).reason] as const),
      ),
    );
    const rows = items.map((raw) => {
      const item = record(raw);
      const why = record(item.why);
      const target = String(item.target ?? "");
      const number = target.split("/").pop() ?? "";
      const link = safeLink(target);
      const inventory = item.kind === "inspect-ownership";
      const title = escapeHtml(
        inventory ? "Repository ownership inventory" : (titles.get(target) ?? target),
      );
      const name = link
        ? `<a href="${escapeHtml(link)}" rel="noreferrer">${inventory ? "" : `#${escapeHtml(number)} `}${title}</a>`
        : `${inventory ? "" : `#${escapeHtml(number)} `}${title}`;
      const commands = [item.nextCommand, item.thenCommand, item.inspection]
        .filter((c) => typeof c === "string" && c)
        .map((c) => `<div><code>${escapeHtml(c)}</code></div>`)
        .join("");
      const codes = list(item.reasonCodes);
      const reason =
        why.text ??
        roleReasons.get(target) ??
        `Ranked ${String(item.kind)}${codes.length ? ` (${codes.join(", ")})` : ""}.`;
      const ids = list(item.ruleIds).length ? list(item.ruleIds) : codes;
      const rules = ids.map(escapeHtml).join(", ");
      // The consolidated read-only detail of this ticket (#454), only for an issue of the
      // selected project; it is fetched when opened, never prefetched from the list.
      const selection = record(record(envelope).selection);
      const repository = String(selection.repository ?? "");
      const issue = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(target);
      const detail =
        issue && issue[1]!.toLowerCase() === repository.toLowerCase()
          ? ` <a class="detail" href="${escapeHtml(
              `/ticket?${new URLSearchParams({
                repo: repository,
                n: issue[2]!,
                role: String(
                  record(record(result.decisionEngine).role).used ??
                    record(result.role).name ??
                    "implementer",
                ),
                ...(selection.agent ? { agent: String(selection.agent) } : {}),
              }).toString()}`,
            )}">details</a>`
          : "";
      // The badge text labels every action kind; the colour is supplementary. `kind` is a string
      // from the API; any other value renders escaped with a neutral class.
      const kind = typeof item.kind === "string" ? item.kind : "";
      const kindClass = kind
        .split(" ")
        .join("-")
        .replace(/[^a-z0-9-]/gi, "");
      return `<li>${name}${detail}<br><span class="kind ${kindClass}">${escapeHtml(kind)}</span><p class="why">${escapeHtml(reason)}${rules ? ` <small>(${rules})</small>` : ""}</p>${commands}</li>`;
    });
    const omitted = Number(ranked.omitted ?? 0);
    return `<ol>${rows.join("")}</ol>${omitted > 0 ? `<p>${omitted} more not shown.</p>` : ""}`;
  };

  return { escapeHtml, briefingUrl, renderState, renderActions };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function dashboardClient(render: DashboardRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const role = byId("role") as HTMLSelectElement;
  const agent = byId("agent") as HTMLInputElement;
  const state = byId("state");
  const actions = byId("actions");
  const initial = new URLSearchParams(location.search);
  const repo = byId("content")?.dataset.repo ?? initial.get("repo") ?? "";
  const humanLink = byId("human-link") as HTMLAnchorElement | null;
  const humanHref = () => `/human${repo ? `?${new URLSearchParams({ repo })}` : ""}`;
  if (humanLink) humanLink.href = humanHref();
  const activityLink = byId("activity-link") as HTMLAnchorElement | null;
  const activityHref = () =>
    `/activity${repo ? `?${new URLSearchParams({ repo, window: "1" })}` : ""}`;
  if (activityLink) activityLink.href = activityHref();
  let controller: AbortController | null = null;
  let request = 0;

  const show = async (refresh: boolean, push = false) => {
    if (!repo) {
      state.innerHTML = "<p>No project selected. Choose a project from the menu.</p>";
      return;
    }
    const mine = ++request;
    controller?.abort();
    controller = new AbortController();
    const selection = { repo, role: role.value, agent: agent.value.trim(), refresh };
    const shown = new URLSearchParams({ repo: selection.repo, role: selection.role });
    if (selection.agent) shown.set("agent", selection.agent);
    if (push) history.pushState(null, "", `?${shown.toString()}`);
    else history.replaceState(null, "", `?${shown.toString()}`);
    // The server marks only equivalent view links with their declared carry keys. Preserve
    // each link's own project while keeping its role/agent synchronized with this URL.
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-shell-carries]")) {
      const url = new URL(link.href, location.href);
      for (const key of (link.getAttribute("data-shell-carries") ?? "").split(" ")) {
        if (shown.has(key)) url.searchParams.set(key, shown.get(key)!);
        else url.searchParams.delete(key);
      }
      link.href = url.pathname + url.search + url.hash;
    }
    // Earlier results stay visible but marked provisional until the new response arrives.
    actions.classList.add("provisional");
    state.innerHTML = render.renderState(null, true);
    let envelope: unknown;
    try {
      const response = await fetch(render.briefingUrl(selection), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      envelope = await response.json();
    } catch (error) {
      envelope = {
        status: "error",
        error: { code: "UNREACHABLE", message: String(error) },
      };
    }
    if (mine !== request) return; // a newer request superseded this one
    const observed = envelope as { selection?: { repository?: string }; status?: string };
    if (observed.selection?.repository !== repo && observed.status !== "error")
      envelope = {
        status: "error",
        error: { code: "SELECTION_MISMATCH", message: "The answer was for another project." },
      };
    actions.classList.remove("provisional");
    state.innerHTML = render.renderState(envelope, false);
    actions.innerHTML = render.renderActions(envelope);
  };

  const restore = () => {
    const params = new URLSearchParams(location.search);
    role.value = params.get("role") ?? "implementer";
    agent.value = params.get("agent") ?? "";
  };
  const start = async () => {
    restore();
    if (role.value === "human") {
      location.assign(humanHref());
      return;
    }
    byId("selection").addEventListener("submit", (event) => {
      event.preventDefault();
      void show(false, true);
    });
    byId("refresh").addEventListener("click", () => void show(true));
    role.addEventListener("change", () => {
      if (role.value === "human") location.assign(humanHref());
      else void show(false, true);
    });
    addEventListener("popstate", () => {
      restore();
      void show(false);
    });
    addEventListener("pageshow", (event: PageTransitionEvent) => {
      if (event.persisted) {
        restore();
        void show(false);
      }
    });
    await show(false);
  };
  void start();
}

/**
 * The served script: the renderers and the client, each from its own TypeScript source. Running
 * from source, tsx (esbuild `keepNames`) wraps inner functions in `__name(fn, "name")`, a helper
 * that exists only in Node; the shim makes the same text valid in a browser.
 */
export const dashboardScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(${dashboardClient.toString()})((${dashboardRenderers.toString()})());\n`;
