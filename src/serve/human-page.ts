/**
 * The read-only human attention view of `pdb serve` (#458): the human mode of the Work page
 * (doc/design/serve-dashboard-read-views.md "Human attention", owner clarification of
 * 2026-11-15), at `/human?repo=R[&agent=NAME]`.
 *
 * It renders the shared human briefing projection (doc/design/human-briefing.md) exactly as
 * `GET /api/v1/briefing?role=human` returns it: no ranking, inference, collector or write of its
 * own. Items keep the server's order. The page splits them into two sections: actionable input
 * first, then a separate Waiting section for items whose own projection says their outcome
 * could not be established (`resolution: "unknown"`). Explicit requests and inferred candidates
 * are labelled as such. Missing evidence is never shown as "nothing waiting".
 *
 * The HTML is rendered on the server per request, so the project is validated through the
 * served-project allowlist before any script runs (doc/design/served-page-shell.md). The page
 * has no inline script. `/human.js` is generated from the self-contained functions below, as
 * `/dashboard.js` is, and reuses the dashboard's escaping and state renderers.
 */
import { dashboardRenderers } from "./dashboard.js";
import type { DashboardRenderers } from "./dashboard.js";
import { HttpFailure } from "./http.js";
import { escapeHtml } from "./rules-page.js";

/** Query parameters the page accepts (the shell's registry entry, doc/design/served-page-shell.md). */
export const humanPageParameters = ["repo", "agent"] as const;
/** The routing name: the same form the ticket page accepts for `agent`. */
const namePattern = /^[A-Za-z0-9][\w.-]{0,99}$/;

type Served = { repository: string; project?: string };

const pageLink = (path: string, query: Record<string, string>) => {
  const text = new URLSearchParams(query).toString();
  return text ? `${path}?${text}` : path;
};

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pdb human attention</title>
<link rel="stylesheet" href="/dashboard.css">
<script src="/human.js" defer></script>
</head>
<body>
`;

/**
 * The page header until the shared toolbar (#605) replaces it: the Work modes for the selected
 * project, then one link per served project. Switching mode drops `agent`, because on the agent
 * views that name means an agent, not the human being routed to.
 */
function navigation(served: readonly Served[], selected: string | null): string {
  const repo: Record<string, string> = selected ? { repo: selected } : {};
  const modes = [
    ["Implementer", pageLink("/", { ...repo, role: "implementer" })],
    ["Designer", pageLink("/", { ...repo, role: "designer" })],
  ]
    .map(([label, href]) => `<a href="${escapeHtml(href!)}">${label}</a>`)
    .join(" · ");
  const projects = served
    .map((s) => {
      const current = s.repository === selected ? ' aria-current="true"' : "";
      return `<li><a href="${escapeHtml(pageLink("/human", { repo: s.repository }))}"${current}>${escapeHtml(s.repository)}</a></li>`;
    })
    .join("");
  return `<header>
<h1>Human attention</h1>
<nav aria-label="Work">Work: ${modes} · <a href="${escapeHtml(pageLink("/human", repo))}" aria-current="page">Human</a> · <a href="${escapeHtml(pageLink("/rules", repo))}">Project rules</a></nav>
<nav aria-label="Projects">Project: <ul class="projects">${projects}</ul></nav>
</header>
`;
}

const footer = `<footer>Read-only. Items, order and evidence come from the shared human briefing; nothing here answers, signs off or edits GitHub.</footer>
</body>
</html>
`;

export interface HumanPageResult {
  status: number;
  html: string;
}

/** Build the page for one request's query, through the served-project allowlist. */
export function humanPage(
  query: URLSearchParams,
  served: readonly Served[],
  select: (served: readonly Served[], repo: string | undefined) => Served,
): HumanPageResult {
  const error = (status: number, message: string): HumanPageResult => ({
    status,
    html: `${head}${navigation(served, null)}<main id="content">
<p class="error" role="alert">${escapeHtml(message)}</p>
</main>
${footer}`,
  });
  for (const key of new Set(query.keys())) {
    if (!(humanPageParameters as readonly string[]).includes(key))
      return error(
        400,
        `Unknown parameter. The human view accepts ${humanPageParameters.join(", ")}.`,
      );
    if (query.getAll(key).length > 1) return error(400, `Give ${key} at most once.`);
  }
  const agent = query.get("agent");
  if (agent !== null && !namePattern.test(agent))
    return error(400, "agent must be a name such as owner-name (letters, digits, . _ -).");
  const repo = query.get("repo");
  // Unlike the JSON API, the page never resolves a missing project, even when only one is served.
  if (repo === null)
    return {
      status: 200,
      html: `${head}${navigation(served, null)}<main id="content">
<p>No project selected. Choose a served project above to see the input it is waiting for.</p>
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
    html: `${head}${navigation(served, selected.repository)}<main id="content" data-repo="${escapeHtml(selected.repository)}">
<p>Project: <strong>${escapeHtml(selected.repository)}</strong></p>
<form id="selection">
<label>Human name <input id="agent" type="text" value="${escapeHtml(agent ?? "")}" placeholder="optional, as in attention:NAME" autocomplete="off" spellcheck="false"></label>
<button id="show" type="submit">Show</button>
<button id="refresh" type="button">Refresh</button>
</form>
<section id="state" aria-live="polite"></section>
<section id="notices"></section>
<section id="actionable" aria-labelledby="actionable-heading"></section>
<section id="waiting" aria-labelledby="waiting-heading"></section>
<section id="coverage"></section>
</main>
${footer}`,
  };
}

export interface HumanRenderers {
  humanUrl(selection: { repo: string; agent: string; limit: number; refresh?: boolean }): string;
  /** Whether the envelope belongs to the page's project (a late or foreign answer is dropped). */
  matches(envelope: unknown, repo: string): boolean;
  renderNotices(envelope: unknown): string;
  renderSections(envelope: unknown, limit: number): { actionable: string; waiting: string };
  renderCoverage(envelope: unknown): string;
}

/**
 * Pure HTML-string renderers over the human `serve-read` envelope. They take the dashboard's
 * escaping, so every GitHub-authored value is escaped once, in one place.
 */
export function humanRenderers(base: DashboardRenderers): HumanRenderers {
  const escapeHtml = (text: unknown): string => base.escapeHtml(text);
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const safeLink = (url: unknown): string | null =>
    typeof url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\//.test(url) ? url : null;
  const link = (url: unknown, text: string): string => {
    const safe = safeLink(url);
    return safe
      ? `<a href="${escapeHtml(safe)}" rel="noreferrer">${escapeHtml(text)}</a>`
      : escapeHtml(text);
  };
  const numberOf = (url: unknown) => (typeof url === "string" ? (url.split("/").pop() ?? "") : "");
  const human = (envelope: unknown) => record(record(record(envelope).result).human);

  const humanUrl = (s: { repo: string; agent: string; limit: number; refresh?: boolean }) => {
    const query = new URLSearchParams({ repo: s.repo, role: "human", limit: String(s.limit) });
    if (s.agent) query.set("agent", s.agent);
    if (s.refresh) query.set("refresh", "true");
    return `/api/v1/briefing?${query.toString()}`;
  };

  const matches = (envelope: unknown, repo: string) => {
    const selected = record(record(envelope).selection).repository;
    return typeof selected === "string" && selected.toLowerCase() === repo.toLowerCase();
  };

  const renderNotices = (envelope: unknown) =>
    list(human(envelope).notices)
      .map((n) => `<p class="notice">${escapeHtml(n)}</p>`)
      .join("");

  const kindText: Record<string, string> = {
    "addressed-response": "Response requested",
    "answer-questions": "Questions to answer",
    decide: "Decision needed",
    "sign-off": "Merge sign-off",
    "orphaned-question": "Question on a closed ticket",
  };

  const renderItem = (raw: unknown, repository: string): string => {
    const item = record(raw);
    const target = item.target;
    const number = numberOf(target);
    const explicit = item.explicit === true;
    const badges = [
      `<span class="kind">${escapeHtml(kindText[String(item.kind)] ?? item.kind)}</span>`,
      explicit
        ? '<span class="kind request">Request</span>'
        : '<span class="kind candidate">Candidate (inferred, nobody asked)</span>',
      ...(item.addressed === true ? ['<span class="kind addressed">Addressed to you</span>'] : []),
      ...(item.sourceState === "closed"
        ? [
            `<span class="kind closed">${item.resolution === "unknown" ? "Ticket closed, resolution unknown" : "Ticket closed, unanswered"}</span>`,
          ]
        : []),
    ].join(" ");
    const requested = list(item.requested);
    const people = [
      list(item.routedTo).length
        ? `Routed to ${list(item.routedTo).map(escapeHtml).join(", ")}`
        : "",
      list(item.raisedBy).length
        ? `raised by ${list(item.raisedBy).map(escapeHtml).join(", ")}`
        : "",
    ].filter(Boolean);
    const blocks = record(item.blocks);
    const blocked = list(blocks.subjects).map((s) => link(s, `#${numberOf(s)}`));
    const unknown = list(blocks.unknown).map((u) => escapeHtml(u));
    const issue = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(
      str(target),
    );
    // The consolidated read-only ticket detail (#454), for issues of this project only.
    const detail =
      issue && issue[1]!.toLowerCase() === repository.toLowerCase()
        ? ` <a class="detail" href="${escapeHtml(`/ticket?${new URLSearchParams({ repo: repository, n: issue[2]! }).toString()}`)}">details</a>`
        : "";
    const warnings = list(item.warnings);
    return `<li>${link(target, `#${number} ${str(item.title)}`)}${detail}
<p>${badges}</p>
<p class="why">${escapeHtml(item.reason)}</p>${
      requested.length
        ? `<p>Requested:</p><ul>${requested.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
        : ""
    }${people.length ? `<p>${people.join("; ")}.</p>` : ""}
<p>Blocks: ${blocked.length ? blocked.join(", ") : "nothing recorded"}${unknown.length ? ` <span class="warn">(${unknown.join("; ")})</span>` : ""}.</p>
<p>${link(item.source, "Open the source")} · <code>${escapeHtml(item.nextCommand)}</code> <small>(${list(item.ruleIds).map(escapeHtml).join(", ")})</small></p>${
      warnings.length
        ? `<ul>${warnings.map((w) => `<li class="warn">${escapeHtml(w)}</li>`).join("")}</ul>`
        : ""
    }</li>`;
  };

  const renderSections = (envelope: unknown, limit: number) => {
    const e = record(envelope);
    const view = human(envelope);
    if (e.status === "error" || !Object.keys(view).length)
      // No result: never an empty, all-clear list.
      return { actionable: "", waiting: "" };
    const repository = str(record(e.selection).repository);
    const items = list(view.items);
    // The projection's own field decides the split; the order stays the server's.
    const isWaiting = (i: unknown) => record(i).resolution === "unknown";
    const actionable = items.filter((i) => !isWaiting(i));
    const waiting = items.filter(isWaiting);
    const total = Number(view.total ?? 0);
    const omitted = Number(view.omitted ?? 0);
    const complete = e.status === "complete";
    let empty: string;
    if (total > 0) empty = "<p>Nothing in this section among the items shown.</p>";
    else if (complete) empty = "<p>No human input is waiting.</p>";
    else
      empty =
        '<p class="warn">No item was found, but the evidence is incomplete (see the warnings above), so this is not an all-clear.</p>';
    const more =
      omitted > 0
        ? `<p class="warn">${escapeHtml(omitted)} more item(s) not shown${
            limit < 100
              ? '. <button id="more" type="button">Show up to 100</button>'
              : "; use <code>pdb --role human --limit N</code> for the rest."
          }</p>`
        : "";
    const section = (id: string, title: string, intro: string, rows: unknown[]) =>
      `<h2 id="${id}-heading">${title} (${rows.length})</h2>${intro}${
        rows.length ? `<ol>${rows.map((r) => renderItem(r, repository)).join("")}</ol>` : empty
      }`;
    return {
      actionable:
        section(
          "actionable",
          "Needs your input",
          "<p>Requests come from trusted records or attention labels; candidates are inferred and nobody asked for them.</p>",
          actionable,
        ) + more,
      waiting: section(
        "waiting",
        "Waiting",
        "<p>Still responsibilities, but not shown as ready to act on: whether these questions were answered could not be established. Inspect the source before acting.</p>",
        waiting,
      ),
    };
  };

  const renderCoverage = (envelope: unknown) => {
    const coverage = record(human(envelope).coverage);
    if (!Object.keys(coverage).length) return "";
    const records = record(coverage.records);
    const counts = Object.entries(records)
      .map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`)
      .join(", ");
    const closed = record(coverage.closedSources);
    const scan = record(closed.scan);
    const closedText =
      closed.read === true
        ? `Closed tickets: ${closed.complete === true ? "read in full" : "partly read"}${
            scan.origin
              ? ` (scan ${escapeHtml(scan.origin)}${scan.restartReason ? `: ${escapeHtml(scan.restartReason)}` : ""})`
              : ""
          }.`
        : `Closed tickets were not read${closed.why ? ` (${escapeHtml(closed.why)})` : ""}; a question whose ticket closed may be unseen.`;
    const excluded = list(coverage.excluded);
    return `<h2>Evidence</h2><p>${coverage.complete === true ? "Coverage complete." : '<span class="warn">Coverage incomplete: missing evidence is unknown, never answered or approved.</span>'}</p><p>Question records: ${counts || "none"}.</p><p>${closedText}</p>${
      excluded.length ? `<p>Not collected: ${excluded.map(escapeHtml).join(", ")}.</p>` : ""
    }`;
  };

  return { humanUrl, matches, renderNotices, renderSections, renderCoverage };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function humanClient(base: DashboardRenderers, view: HumanRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement | null;
  const main = byId("content");
  const repo = main?.dataset.repo ?? "";
  // No validated project: the server already rendered the no-selection or error state.
  if (!main || !repo) return;
  const agent = byId("agent") as HTMLInputElement;
  const state = byId("state")!;
  const notices = byId("notices")!;
  const actionable = byId("actionable")!;
  const waiting = byId("waiting")!;
  const coverage = byId("coverage")!;
  let limit = 50;
  let generation = 0;
  let controller: AbortController | null = null;

  const render = (envelope: unknown) => {
    state.innerHTML = base.renderState(envelope, false);
    notices.innerHTML = view.renderNotices(envelope);
    const sections = view.renderSections(envelope, limit);
    actionable.innerHTML = sections.actionable;
    waiting.innerHTML = sections.waiting;
    coverage.innerHTML = view.renderCoverage(envelope);
    actionable.classList.remove("provisional");
    waiting.classList.remove("provisional");
  };

  const show = async (refresh: boolean, push: boolean) => {
    const name = agent.value.trim();
    if (push) {
      const query = new URLSearchParams({ repo });
      if (name) query.set("agent", name);
      history.pushState(null, "", `?${query.toString()}`);
    }
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const current = ++generation;
    // Earlier results stay visible, marked provisional, for this same project only.
    actionable.classList.add("provisional");
    waiting.classList.add("provisional");
    state.innerHTML = base.renderState(null, true);
    let envelope: unknown;
    try {
      const response = await fetch(view.humanUrl({ repo, agent: name, limit, refresh }), {
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
    limit = 50;
    void show(false, true);
  });
  byId("refresh")!.addEventListener("click", () => void show(true, false));
  // "Show up to 100" is rendered with the list, so listen on the section.
  actionable.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id !== "more") return;
    limit = 100;
    void show(false, false);
  });
  addEventListener("popstate", () => {
    agent.value = new URLSearchParams(location.search).get("agent") ?? "";
    limit = 50;
    void show(false, false);
  });
  // Only this view is read: one project, on load or on request.
  void show(false, false);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const humanScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(() => {\nconst base = (${dashboardRenderers.toString()})();\n(${humanClient.toString()})(base, (${humanRenderers.toString()})(base));\n})();\n`;
