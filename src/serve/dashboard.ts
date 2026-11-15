/**
 * The local read-only dashboard served by `pdb serve` at `/` (#374, doc/design/serve.md and
 * doc/design/serve-global-dashboard-roadmap.md).
 *
 * It reads only `/api/v1/status` and `/api/v1/briefing`. Ranking, reasons and commands come from
 * the shared engine through that API; nothing here orders or chooses work. The page loads no
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

/** The HTML shell: no data, no inline script or style. */
export const dashboardPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pdb serve</title>
<link rel="stylesheet" href="/dashboard.css">
<script src="/dashboard.js" defer></script>
</head>
<body>
<header>
<h1>pdb serve</h1>
<form id="selection">
<label>Project <select id="repo"></select></label>
<label>Role <select id="role"><option value="implementer">implementer</option><option value="designer">designer</option></select></label>
<label>Agent <input id="agent" type="text" placeholder="optional" autocomplete="off" spellcheck="false"></label>
<button id="show" type="submit">Show</button>
<button id="refresh" type="button">Refresh</button>
</form>
</header>
<main>
<section id="state" aria-live="polite"></section>
<section id="actions"></section>
</main>
<footer>Read-only. Ranking, reasons and commands come from the shared rules engine. <a href="/api/v1/status">/api/v1/status</a></footer>
</body>
</html>
`;

export const dashboardCss = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 70rem; padding: 0 1rem 2rem; }
header { position: sticky; top: 0; background: Canvas; padding: .5rem 0; border-bottom: 1px solid GrayText; }
h1 { font-size: 1.2rem; margin: .25rem 0; }
form { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: end; }
label { display: flex; flex-direction: column; font-size: .8rem; }
#state { margin: 1rem 0; font-size: .9rem; }
.warn { color: #b26b00; }
.error { color: #c62828; font-weight: 600; }
.provisional { opacity: .6; }
ol { padding-left: 1.5rem; }
li { margin: 0 0 1rem; }
.kind { font-size: .75rem; border: 1px solid GrayText; border-radius: .25rem; padding: 0 .3rem; margin-left: .4rem; }
.why { margin: .2rem 0; }
code { font-size: .85rem; word-break: break-all; }
footer { margin-top: 2rem; font-size: .8rem; color: GrayText; }
`;

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
    if (e.status === "incomplete" || completeness.complete === false)
      parts.push(
        `<p class="warn">Incomplete evidence: missing facts are unknown, never approval.</p>${list(
          completeness.warnings,
        )
          .slice(0, 10)
          .map((w) => `<p class="warn">${escapeHtml(w)}</p>`)
          .join("")}`,
      );
    for (const w of list(e.warnings)) parts.push(`<p class="warn">${escapeHtml(w)}</p>`);
    const selection = record(e.selection);
    if (selection.identityDiagnostic)
      parts.push(`<p class="warn">${escapeHtml(selection.identityDiagnostic)}</p>`);
    if (selection.repository)
      parts.push(
        `<p>${escapeHtml(selection.repository)} · role ${escapeHtml(selection.triageRole ?? "")} · agent ${escapeHtml(selection.agent ?? "none (unfocused)")}</p>`,
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
    const rows = items.map((raw) => {
      const item = record(raw);
      const why = record(item.why);
      const target = String(item.target ?? "");
      const number = target.split("/").pop() ?? "";
      const link = safeLink(target);
      const title = escapeHtml(titles.get(target) ?? target);
      const name = link
        ? `<a href="${escapeHtml(link)}" rel="noreferrer">#${escapeHtml(number)} ${title}</a>`
        : `#${escapeHtml(number)} ${title}`;
      const commands = [item.nextCommand, item.thenCommand, item.inspection]
        .filter((c) => typeof c === "string" && c)
        .map((c) => `<div><code>${escapeHtml(c)}</code></div>`)
        .join("");
      const rules = list(item.ruleIds).map(escapeHtml).join(", ");
      return `<li>${name}<span class="kind">${escapeHtml(item.kind)}</span><p class="why">${escapeHtml(why.text)}${rules ? ` <small>(${rules})</small>` : ""}</p>${commands}</li>`;
    });
    const omitted = Number(ranked.omitted ?? 0);
    return `<ol>${rows.join("")}</ol>${omitted > 0 ? `<p>${omitted} more not shown.</p>` : ""}`;
  };

  return { escapeHtml, briefingUrl, renderState, renderActions };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function dashboardClient(render: DashboardRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const repo = byId("repo") as HTMLSelectElement;
  const role = byId("role") as HTMLSelectElement;
  const agent = byId("agent") as HTMLInputElement;
  const state = byId("state");
  const actions = byId("actions");
  const initial = new URLSearchParams(location.search);
  let request = 0;

  const show = async (refresh: boolean) => {
    if (!repo.value) return;
    const mine = ++request;
    const selection = { repo: repo.value, role: role.value, agent: agent.value.trim(), refresh };
    const shown = new URLSearchParams({ repo: selection.repo, role: selection.role });
    if (selection.agent) shown.set("agent", selection.agent);
    history.replaceState(null, "", `?${shown.toString()}`);
    // Earlier results stay visible but marked provisional until the new response arrives.
    actions.classList.add("provisional");
    state.innerHTML = render.renderState(null, true);
    let envelope: unknown;
    try {
      const response = await fetch(render.briefingUrl(selection), {
        headers: { accept: "application/json" },
      });
      envelope = await response.json();
    } catch (error) {
      envelope = {
        status: "error",
        error: { code: "UNREACHABLE", message: String(error) },
      };
    }
    if (mine !== request) return; // a newer request superseded this one
    actions.classList.remove("provisional");
    state.innerHTML = render.renderState(envelope, false);
    actions.innerHTML = render.renderActions(envelope);
  };

  const start = async () => {
    let status: { repositories?: { repository: string; default?: boolean }[] } = {};
    try {
      status = await (await fetch("/api/v1/status")).json();
    } catch (error) {
      state.innerHTML = render.renderState(
        { status: "error", error: { code: "UNREACHABLE", message: String(error) } },
        false,
      );
      return;
    }
    const served = status.repositories ?? [];
    for (const entry of served) {
      const option = document.createElement("option");
      option.value = option.textContent = entry.repository;
      repo.append(option);
    }
    const wanted = initial.get("repo");
    const preset = served.find((s) => s.repository === wanted) ?? served.find((s) => s.default);
    if (preset) repo.value = preset.repository;
    else {
      repo.selectedIndex = -1;
      state.innerHTML = "<p>Select a project.</p>";
    }
    if (initial.get("role") === "designer") role.value = "designer";
    agent.value = initial.get("agent") ?? "";
    byId("selection").addEventListener("submit", (event) => {
      event.preventDefault();
      void show(false);
    });
    byId("refresh").addEventListener("click", () => void show(true));
    repo.addEventListener("change", () => void show(false));
    role.addEventListener("change", () => void show(false));
    // Only the view the user opened is fetched: one project, one role, on load or on request.
    if (preset) await show(false);
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
