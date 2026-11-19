import { pageById, shellContext, shellStart } from "./shell.js";
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
export const humanPageParameters = pageById("human").parameters;
/** The routing name: the same form the ticket page accepts for `agent`. */
const namePattern = /^[A-Za-z0-9][\w.-]{0,99}$/;

type Served = { repository: string; project?: string };

const pageLink = (path: string, query: Record<string, string>) => {
  const text = new URLSearchParams(query).toString();
  return text ? `${path}?${text}` : path;
};

function navigation(served: readonly Served[], selected: string | null): string {
  return shellStart(
    shellContext("human", served, new URLSearchParams(selected ? { repo: selected } : {})),
    "Human attention",
    "/human.js",
  );
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
  allowEdits = false,
): HumanPageResult {
  const error = (status: number, message: string): HumanPageResult => ({
    status,
    html: `${navigation(served, null)}<main id="content" tabindex="-1"><h1>Human attention</h1>
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
      html: `${navigation(served, null)}<main id="content" tabindex="-1"><h1>Human attention</h1>
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
    html: `${navigation(served, selected.repository)}<main id="content" tabindex="-1" data-repo="${escapeHtml(selected.repository)}" data-allow-edits="${allowEdits ? "true" : "false"}">
<h1>Human attention</h1><p><a href="${escapeHtml(pageLink("/", { repo: selected.repository, role: "implementer" }))}">Implementer</a> · <a href="${escapeHtml(pageLink("/", { repo: selected.repository, role: "designer" }))}">Designer</a></p><p>Project: <strong>${escapeHtml(selected.repository)}</strong></p>
<form id="selection">
<label>Human name <input id="agent" type="text" value="${escapeHtml(agent ?? "")}" placeholder="optional, as in attention:NAME" autocomplete="off" spellcheck="false"></label>
<button id="show" type="submit">Show</button>
<button id="refresh" type="button">Refresh</button>
</form>${
      allowEdits
        ? `\n<section id="unassign-status" aria-live="polite"></section>\n<dialog id="unassign-dialog" aria-labelledby="unassign-title">\n<form id="unassign-form" method="dialog">\n<h2 id="unassign-title">Confirm Unassign</h2>\n<div id="unassign-preview"></div>\n<label>Your actor name <input id="unassign-actor" type="text" required autocomplete="off" spellcheck="false"></label>\n<label id="unassign-override-row" hidden><input id="unassign-override" type="checkbox"> Override unknown claim history</label>\n<p class="dialog-actions"><button id="unassign-confirm" type="submit">Confirm Unassign</button> <button id="unassign-cancel" type="button">Cancel</button></p>\n</form>\n</dialog>`
        : ""
    }
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
  renderSections(
    envelope: unknown,
    limit: number,
    allowEdits?: boolean,
  ): { actionable: string; waiting: string };
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

  const renderItem = (raw: unknown, repository: string, allowEdits = false): string => {
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
            `<span class="kind closed">${item.attentionSection === "waiting" ? "Ticket closed, resolution unknown" : "Ticket closed, unanswered"}</span>`,
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
    const claimAgents = list(item.claims).filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    const unassignControl =
      allowEdits && issue && issue[1]!.toLowerCase() === repository.toLowerCase()
        ? claimAgents
            .map(
              (claimAgent) =>
                ` <button type="button" class="unassign-btn" data-issue="${escapeHtml(issue[2]!)}" data-agent="${escapeHtml(claimAgent)}">Unassign ${escapeHtml(claimAgent)}</button>`,
            )
            .join("")
        : "";
    const warnings = list(item.warnings);
    return `<li>${link(target, `#${number} ${str(item.title)}`)}${detail}${unassignControl}
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

  const renderSections = (envelope: unknown, limit: number, allowEdits = false) => {
    const e = record(envelope);
    const view = human(envelope);
    if (e.status === "error" || !Object.keys(view).length)
      // No result: never an empty, all-clear list.
      return { actionable: "", waiting: "" };
    const repository = str(record(e.selection).repository);
    const items = list(view.items);
    // The shared native projection's attentionSection field (#643) decides the split; order stays the server's.
    const isWaiting = (i: unknown) => record(i).attentionSection === "waiting";
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
        rows.length
          ? `<ol>${rows.map((r) => renderItem(r, repository, allowEdits)).join("")}</ol>`
          : empty
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
  const allowEdits = main.dataset.allowEdits === "true";
  const agent = byId("agent") as HTMLInputElement;
  const state = byId("state")!;
  const notices = byId("notices")!;
  const actionable = byId("actionable")!;
  const waiting = byId("waiting")!;
  const coverage = byId("coverage")!;
  let limit = 50;
  let generation = 0;
  let controller: AbortController | null = null;
  let csrfToken: string | null = null;
  let lastUncertainOp: { key: string; operationId: string } | null = null;
  let pendingPreview: {
    issue: string;
    agent: string;
    claimStart: string | null;
    revision: string;
    requiresOverride: boolean;
    operationId: string;
  } | null = null;

  const render = (envelope: unknown) => {
    state.innerHTML = base.renderState(envelope, false);
    notices.innerHTML = view.renderNotices(envelope);
    const sections = view.renderSections(envelope, limit, allowEdits);
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
  addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) {
      agent.value = new URLSearchParams(location.search).get("agent") ?? "";
      void show(false, false);
    }
  });
  if (allowEdits) {
    const statusBox = byId("unassign-status");
    const dialog = byId("unassign-dialog") as HTMLDialogElement | null;
    const form = byId("unassign-form") as HTMLFormElement | null;
    const previewBox = byId("unassign-preview");
    const actorInput = byId("unassign-actor") as HTMLInputElement | null;
    const overrideRow = byId("unassign-override-row");
    const overrideBox = byId("unassign-override") as HTMLInputElement | null;
    const confirmBtn = byId("unassign-confirm") as HTMLButtonElement | null;
    const cancelBtn = byId("unassign-cancel") as HTMLButtonElement | null;

    const ensureCsrf = async (): Promise<string> => {
      if (csrfToken) return csrfToken;
      const res = await fetch("/api/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as { csrfToken?: string; error?: { message?: string } };
      if (!res.ok || !json.csrfToken) {
        throw new Error(json.error?.message ?? "Could not start write session.");
      }
      csrfToken = json.csrfToken;
      return csrfToken;
    };

    const postWithCsrf = async (
      url: string,
      payload: unknown,
    ): Promise<{ res: Response; data: unknown }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await ensureCsrf();
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-pdb-csrf": token },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as { error?: { code?: string } | string | null };
        const errCode = data.error && typeof data.error === "object" ? data.error.code : undefined;
        if (res.status === 403 && errCode === "CSRF_REQUIRED" && attempt === 0) {
          csrfToken = null;
          continue;
        }
        return { res, data };
      }
      throw new Error("Could not renew write session.");
    };

    const setStatus = (cls: string, msg: string) => {
      if (!statusBox) return;
      statusBox.innerHTML = `<p class="${base.escapeHtml(cls)}">${base.escapeHtml(msg)}</p>`;
    };

    main.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest(".unassign-btn") as HTMLElement | null;
      if (!btn) return;
      const issue = btn.dataset.issue ?? "";
      const claimAgent = btn.dataset.agent ?? "";
      if (!issue || !claimAgent) return;
      void (async () => {
        try {
          const { res, data: rawData } = await postWithCsrf(
            `/api/v1/tickets/${encodeURIComponent(issue)}/unassign/preview?repo=${encodeURIComponent(repo)}`,
            { agent: claimAgent },
          );
          const data = rawData as {
            preview?: {
              number: number;
              title: string;
              agent: string;
              claimStart: string | null;
              claimHistoryComplete: boolean;
              revision: string;
              confirmationNote: string;
              preserved: { humanAssignees: string[]; state: string };
              decision: { verdict: string; code: string; reason: string };
            };
            error?: { message?: string };
          };
          if (!res.ok || !data.preview) {
            setStatus("error", data.error?.message ?? "Unassign preview failed.");
            return;
          }
          const p = data.preview;
          const requiresOverride =
            p.decision.verdict === "refuse" && p.decision.code === "EVIDENCE_INCOMPLETE";
          const opKey = JSON.stringify([issue, p.agent, p.claimStart, p.revision]);
          const operationId =
            lastUncertainOp?.key === opKey
              ? lastUncertainOp.operationId
              : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pendingPreview = {
            issue,
            agent: p.agent,
            claimStart: p.claimStart,
            revision: p.revision,
            requiresOverride,
            operationId,
          };
          if (previewBox) {
            const owners = p.preserved.humanAssignees.length
              ? p.preserved.humanAssignees.join(", ")
              : "none";
            previewBox.innerHTML = `<p>Ticket <strong>#${base.escapeHtml(p.number)}</strong>: ${base.escapeHtml(p.title)}</p><p>Release agent claim: <code>${base.escapeHtml(p.agent)}</code> (started: ${base.escapeHtml(p.claimStart ?? "unknown")})</p><p>Preserved human assignees: ${base.escapeHtml(owners)} · State: ${base.escapeHtml(p.preserved.state)}</p><p>${base.escapeHtml(p.confirmationNote)}</p>`;
          }
          if (overrideRow && overrideBox) {
            overrideRow.hidden = !requiresOverride;
            overrideBox.checked = false;
          }
          if (actorInput && !actorInput.value.trim()) {
            actorInput.value = agent.value.trim();
          }
          if (confirmBtn) {
            confirmBtn.disabled = p.decision.verdict === "refuse" && !requiresOverride;
          }
          dialog?.showModal?.();
        } catch (error) {
          setStatus("error", error instanceof Error ? error.message : String(error));
        }
      })();
    });

    cancelBtn?.addEventListener("click", () => {
      pendingPreview = null;
      dialog?.close?.();
    });

    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const current = pendingPreview;
      if (!current) return;
      const actor = actorInput?.value.trim() ?? "";
      if (!actor) return;
      if (confirmBtn) confirmBtn.disabled = true;
      const opKey = JSON.stringify([
        current.issue,
        current.agent,
        current.claimStart,
        current.revision,
      ]);
      const operationId = current.operationId;
      void (async () => {
        try {
          const { data: rawBody } = await postWithCsrf(
            `/api/v1/tickets/${encodeURIComponent(current.issue)}/unassign?repo=${encodeURIComponent(repo)}`,
            {
              operationId,
              actor,
              agent: current.agent,
              expectedClaimStart: current.claimStart,
              expectedRevision: current.revision,
              overrideUnknownHistory: Boolean(overrideBox?.checked),
            },
          );
          const body = rawBody as {
            status?: string;
            recordOutcome?: string;
            message?: string;
            error?: string | { message?: string } | null;
            next?: string[];
          };
          dialog?.close?.();
          pendingPreview = null;
          if (body.status === "applied" || body.status === "noop") {
            lastUncertainOp = null;
            setStatus("ok", body.message ?? "Unassigned.");
            void show(true, false);
          } else if (body.status === "partial" || body.status === "unknown") {
            lastUncertainOp = { key: opKey, operationId };
            const detail = typeof body.error === "string" ? ` (${body.error})` : "";
            const next = body.next?.length ? ` Next: ${body.next.join(" ")}` : "";
            setStatus("warn", `${body.message ?? "Unassign outcome incomplete."}${detail}${next}`);
            void show(true, false);
          } else {
            lastUncertainOp = null;
            const errMsg =
              typeof body.error === "object" && body.error !== null
                ? body.error.message
                : body.message;
            setStatus("error", errMsg ?? "Unassign refused.");
            if (body.recordOutcome === "applied") {
              void show(true, false);
            }
          }
        } catch (error) {
          lastUncertainOp = { key: opKey, operationId };
          setStatus(
            "warn",
            `Unassign response was lost or unreachable (${error instanceof Error ? error.message : String(error)}); refresh and inspect the issue before retrying.`,
          );
        } finally {
          if (confirmBtn) confirmBtn.disabled = false;
        }
      })();
    });
  }
  // Only this view is read: one project, on load or on request.
  void show(false, false);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const humanScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(() => {\nconst base = (${dashboardRenderers.toString()})();\n(${humanClient.toString()})(base, (${humanRenderers.toString()})(base));\n})();\n`;
