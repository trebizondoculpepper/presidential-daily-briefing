/**
 * The read-only consolidated ticket detail page served by `pdb serve` at `/ticket` (#454,
 * doc/design/consolidated-ticket-view.md "Shared server and dashboard").
 *
 * It displays the `ticket-status` document of `GET /api/v1/tickets/{n}`, which the shared #197
 * `readTicketStatus` service builds. Nothing here classifies delivery, review or responsibility:
 * the page projects the document's own fields, keeps unknown evidence visibly unknown (never
 * "none" or "done"), and shows no percentage. It is fetched only when the page is opened for one
 * ticket; a pull request's current status is fetched only when the user asks for it. Nothing is
 * written anywhere.
 *
 * Like the #374 dashboard, the HTML, stylesheet and script are same-origin static responses under
 * the strict Content-Security-Policy, with no inline script. `ticketRenderers` and `ticketClient`
 * reference no module-level names, so their source text runs on its own in the browser; tests call
 * the renderers directly and run the served script in an isolated context.
 */

/** Query parameters the page accepts: the selected project, ticket and focus agent. */
export const ticketPageParameters = ["repo", "n", "agent"] as const;

/** The HTML shell: no data, no inline script or style. */
export const ticketPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pdb ticket</title>
<link rel="stylesheet" href="/dashboard.css">
<script src="/ticket.js" defer></script>
</head>
<body>
<header>
<h1>pdb ticket</h1>
<p><a id="back" href="/">Back to the to-do list</a> · <button id="refresh" type="button">Refresh</button></p>
</header>
<main>
<section id="state" aria-live="polite"></section>
<section id="ticket"></section>
</main>
<footer>Read-only. Delivery, review and next steps come from the shared ticket-status service; nothing here edits GitHub.</footer>
</body>
</html>
`;

export interface TicketSelection {
  repo: string;
  n: string;
  agent: string;
  refresh?: boolean;
}

export interface TicketRenderers {
  escapeHtml(text: unknown): string;
  validSelection(selection: TicketSelection): boolean;
  ticketUrl(selection: TicketSelection): string;
  pullRequestUrl(repo: string, number: unknown, refresh?: boolean): string;
  backUrl(selection: TicketSelection): string;
  renderState(envelope: unknown, loading: boolean): string;
  renderTicket(envelope: unknown): string;
  renderPullRequest(envelope: unknown, loading: boolean): string;
}

/**
 * Pure HTML-string renderers over the `serve-read` envelopes of `/api/v1/tickets/{n}` and
 * `/api/v1/prs/{n}`. Every value from the server is escaped: titles, excerpts, branch names and
 * warnings are GitHub-authored text. Only https://github.com/ URLs become links.
 */
export function ticketRenderers(): TicketRenderers {
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
  const link = (url: unknown, text: unknown): string => {
    const href = safeLink(url);
    return href
      ? `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(text)}</a>`
      : escapeHtml(text);
  };
  const code = (text: unknown): string => `<code>${escapeHtml(text)}</code>`;
  /** A value the document does not know is said to be unknown, never left blank. */
  const known = (value: unknown, unknown = "unknown"): string =>
    value === null || value === undefined || value === "" ? unknown : escapeHtml(value);
  // Bounds of what is shown; the document's own omissions are always counted.
  const maxWarnings = 10;
  const maxRows = 50;
  /** Display trimming, never a collection gap: what is cut is counted and points to the source. */
  const more = (shown: number, total: number, what: string): string =>
    total > shown ? `<p>${total - shown} more ${what} not shown; see the source.</p>` : "";

  const validSelection = (s: TicketSelection): boolean =>
    /^[\w.-]+\/[\w.-]+$/.test(s.repo) &&
    /^[1-9]\d{0,15}$/.test(s.n) &&
    (s.agent === "" || /^[A-Za-z0-9][\w.-]*$/.test(s.agent));

  const ticketUrl = (s: TicketSelection): string => {
    const query = new URLSearchParams({ repo: s.repo });
    if (s.agent) query.set("agent", s.agent);
    if (s.refresh) query.set("refresh", "true");
    return `/api/v1/tickets/${encodeURIComponent(s.n)}?${query.toString()}`;
  };

  const pullRequestUrl = (repo: string, number: unknown, refresh = false): string => {
    const query = new URLSearchParams({ repo });
    if (refresh) query.set("refresh", "true");
    return `/api/v1/prs/${encodeURIComponent(String(number))}?${query.toString()}`;
  };

  const backUrl = (s: TicketSelection): string => {
    const query = new URLSearchParams();
    if (s.repo) query.set("repo", s.repo);
    if (s.agent) query.set("agent", s.agent);
    const text = query.toString();
    return text ? `/?${text}` : "/";
  };

  /** Loading, error, observation time, staleness and incompleteness of one envelope. */
  const header = (envelope: unknown, loading: boolean, what: string): string => {
    const e = record(envelope);
    const parts: string[] = [];
    if (loading) parts.push(`<p>Loading ${escapeHtml(what)}…</p>`);
    const error = record(e.error);
    if (e.status === "error" || error.code) {
      parts.push(
        `<p class="error">${escapeHtml(error.code ?? "error")}: ${escapeHtml(error.message ?? "the request failed")}</p>`,
      );
      for (const next of list(error.next)) parts.push(`<p>Try ${code(next)}</p>`);
    }
    const f = record(e.freshness);
    if (f.observedAt) {
      const source = f.source === "live" ? "collected live" : String(f.source ?? "");
      parts.push(
        `<p>Observed ${escapeHtml(f.observedAt)} (${escapeHtml(f.ageSeconds)}s ago, ${escapeHtml(source)}; cache TTL ${escapeHtml(f.ttlSeconds)}s).</p>`,
      );
      if (f.stale) {
        const refresh = record(f.refreshError);
        parts.push(
          `<p class="warn">Stale: the last refresh failed (${escapeHtml(refresh.code)}: ${escapeHtml(refresh.message)}). Facts may have changed since they were observed.</p>`,
        );
      }
    }
    const completeness = record(record(e.result).completeness);
    if (e.status === "incomplete" || completeness.complete === false) {
      const warnings = list(completeness.warnings);
      parts.push(
        `<p class="warn">Incomplete evidence: what was not read is unknown, never absent or approved.</p>${warnings
          .slice(0, maxWarnings)
          .map((w) => `<p class="warn">${escapeHtml(w)}</p>`)
          .join("")}${
          warnings.length > maxWarnings
            ? `<p class="warn">${warnings.length - maxWarnings} more warning(s) not shown; every warning is in the JSON document.</p>`
            : ""
        }`,
      );
    }
    for (const w of list(e.warnings)) parts.push(`<p class="warn">${escapeHtml(w)}</p>`);
    return parts.join("");
  };

  const renderState = (envelope: unknown, loading: boolean): string => {
    const parts = [header(envelope, loading, "the ticket")];
    const selection = record(record(envelope).selection);
    if (selection.identityDiagnostic)
      parts.push(`<p class="warn">${escapeHtml(selection.identityDiagnostic)}</p>`);
    return parts.join("");
  };

  /** One diagnosed unavailable ticket: missing, forbidden, moved and unknown stay distinct. */
  const unavailable = (r: Record<string, unknown>): string => {
    const words: Record<string, string> = {
      missing: "does not exist in this repository",
      forbidden: "cannot be read with the current credentials (inaccessible, not missing)",
      moved: "was transferred to another repository; it is not followed here",
      "pull-request": "is a pull request, not an issue",
      unknown: "could not be diagnosed (unknown, not missing)",
    };
    const state = String(r.state ?? "unknown");
    const destination = record(r.destination);
    return `<h2>${link(r.url, `${String(r.repository ?? "")}#${String(r.number ?? "")}`)}</h2><p class="warn" data-unavailable="${escapeHtml(state)}">Ticket ${escapeHtml(words[state] ?? words.unknown)}.</p>${r.detail ? `<p>${escapeHtml(r.detail)}</p>` : ""}${
      state === "moved" && destination.repository
        ? `<p>Now ${link(destination.url, `${String(destination.repository)}#${String(destination.number ?? "")}`)}</p>`
        : ""
    }${r.next ? `<p>Inspect with ${code(r.next)}</p>` : ""}`;
  };

  const pullRequestRow = (raw: unknown, repo: string): string => {
    const p = record(raw);
    const identity = `${String(p.repository ?? "")}#${String(p.number ?? "")}`;
    const relations = list(p.relations).map(escapeHtml).join(", ");
    const facts: string[] = [];
    if (p.detail === "read") {
      facts.push(`state ${known(p.state)}${p.draft === true ? " (draft)" : ""}`);
      facts.push(`base ${known(p.base)}`);
      if (p.intendedTarget)
        facts.push(
          `intended ${escapeHtml(p.intendedTarget)}${p.targetMismatch === true ? ' <strong class="warn">target mismatch</strong>' : p.targetMismatch === null ? " (comparison unknown)" : ""}`,
        );
      const checks = record(p.checks);
      facts.push(`checks ${p.checks ? known(checks.verify) : "unknown"}`);
      const review = record(p.review);
      facts.push(
        p.review
          ? `current head ${review.headReviewed === true ? "reviewed" : "not reviewed"}${review.headFindings === true ? ", with findings" : ""}${Number(review.unresolvedThreads) > 0 ? `, ${escapeHtml(review.unresolvedThreads)} unresolved thread(s)` : ""}`
          : "review unknown",
      );
      if (p.mergeable) facts.push(`mergeable ${escapeHtml(p.mergeable)}`);
    } else {
      // Not read: its status is unknown evidence, never absence.
      facts.push(
        `<span class="warn">status unknown (${escapeHtml(p.detail)}${p.detailWhy ? `: ${escapeHtml(p.detailWhy)}` : ""})</span>`,
      );
      if (p.listedState) facts.push(`listed as ${escapeHtml(p.listedState)}`);
    }
    if (p.memberState) facts.push(`delivery member ${escapeHtml(p.memberState)}`);
    if (p.responsible) facts.push(`responsible ${escapeHtml(p.responsible)}`);
    if (p.followUp) facts.push(`follow-up ${escapeHtml(p.followUp)}`);
    const allBlockers = list(p.blockers);
    const blockers =
      allBlockers
        .slice(0, 5)
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("") +
      (allBlockers.length > 5
        ? `<li>${allBlockers.length - 5} more blocker(s) not shown; see the source.</li>`
        : "");
    const counts = Object.entries(record(record(p.checks).counts))
      .map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`)
      .join(", ");
    if (counts) facts.push(`check counts: ${counts}`);
    const rowWarnings = list(p.warnings)
      .map((w) => `<p class="warn">${escapeHtml(w)}</p>`)
      .join("");
    // Drill-down reads are on demand and only for the selected (served) repository.
    const sameRepo = String(p.repository ?? "").toLowerCase() === repo.toLowerCase();
    const drill = sameRepo
      ? `<button type="button" class="load-pr" data-pr="${escapeHtml(p.number)}">Load current PR status</button><div class="pr-detail" data-pr-detail="${escapeHtml(p.number)}"></div>`
      : `<p>Another repository: inspect with ${code(`pdb pr ${String(p.number ?? "")} --repo ${String(p.repository ?? "")}`)}</p>`;
    return `<li>${link(p.url, `${identity}${p.title ? ` ${String(p.title)}` : ""}`)} <span class="kind">${relations}</span><p class="why">${facts.join(" · ")}</p>${p.followUpWhy ? `<p class="why">${escapeHtml(p.followUpWhy)}</p>` : ""}${blockers ? `<ul>${blockers}</ul>` : ""}${rowWarnings}${drill}</li>`;
  };

  const issueRows = (rows: unknown[]): string =>
    rows
      .slice(0, maxRows)
      .map((raw) => {
        const d = record(raw);
        return `<li>${link(d.url, `${String(d.repository ?? "")}#${String(d.number ?? "")} ${String(d.title ?? "")}`)} (${escapeHtml(d.state)})</li>`;
      })
      .join("") +
    (rows.length > maxRows
      ? `<li>${rows.length - maxRows} more not shown; see the source.</li>`
      : "");

  const renderTicket = (envelope: unknown): string => {
    const e = record(envelope);
    const r = record(e.result);
    if (r.kind === "issue-unavailable") return unavailable(r);
    if (r.kind !== "ticket-status") return "";
    const repo = String(r.repository ?? "");
    const parts: string[] = [];
    parts.push(
      `<h2>${link(r.url, `#${String(r.number ?? "")} ${String(r.title ?? "")}`)}</h2><p>${escapeHtml(repo)} · ${escapeHtml(r.state)} · ${escapeHtml(r.closure)}${r.closedBy ? ` by ${escapeHtml(r.closedBy)}` : ""}</p>`,
    );

    // Delivery: the shared evaluation, never a percentage or a "done" header over unknowns.
    const delivery = record(r.delivery);
    const verdictWords: Record<string, string> = {
      "no-record": "no delivery record",
      unknown: "unknown (delivery records not read)",
    };
    const verdict = String(delivery.verdict ?? "unknown");
    parts.push(
      `<h3>Delivery</h3><p data-delivery="${escapeHtml(verdict)}">${escapeHtml(verdictWords[verdict] ?? verdict)}</p>${list(
        delivery.because,
      )
        .map((b) => `<p class="why">${escapeHtml(b)}</p>`)
        .join("")}`,
    );
    // Every delivery member, PR or not (commit evidence included), with its own state.
    const members = list(delivery.deliverables);
    if (members.length)
      parts.push(
        `<ul class="deliverables">${members
          .slice(0, maxRows)
          .map((raw) => {
            const m = record(raw);
            return `<li data-member-state="${escapeHtml(m.state)}">${link(m.url, m.deliverable)} → ${escapeHtml(m.target)}: ${escapeHtml(m.state)}${m.responsible ? ` · responsible ${escapeHtml(m.responsible)}` : ""}${m.followUp ? ` · follow-up ${escapeHtml(m.followUp)}` : ""}${m.why ? `<p class="why">${escapeHtml(m.why)}</p>` : ""}${m.followUpWhy ? `<p class="why">${escapeHtml(m.followUpWhy)}</p>` : ""}</li>`;
          })
          .join(
            "",
          )}</ul>${more(Math.min(members.length, maxRows), members.length, "deliverable(s)")}`,
      );
    const required = list(delivery.required);
    if (required.length)
      parts.push(
        `<p>Required: ${required
          .slice(0, maxRows)
          .map(escapeHtml)
          .join(
            ", ",
          )}</p>${more(Math.min(required.length, maxRows), required.length, "required identity(ies)")}`,
      );
    if (delivery.records === "unknown" || delivery.records === "unread")
      parts.push(
        `<p class="warn">Delivery records ${escapeHtml(delivery.records)}: membership is unknown.</p>`,
      );

    const steps = list(r.nextSteps);
    if (steps.length)
      parts.push(
        `<h3>Next steps</h3><ol>${steps
          .map((raw) => {
            const s = record(raw);
            return `<li><span class="kind">${escapeHtml(s.kind)}</span> ${escapeHtml(s.why)}${s.rule ? ` <small>(${escapeHtml(s.rule)})</small>` : ""}${s.command ? `<div>${code(s.command)}</div>` : ""}</li>`;
          })
          .join("")}</ol>`,
      );

    // Pull requests: each row's own evidence; unread identities stay unknown.
    const prs = list(r.pullRequests);
    const coverage = record(r.coverage);
    const linkage = record(coverage.linkage);
    const omittedPrs = list(record(coverage.omitted).pullRequests);
    const prSection: string[] = ["<h3>Pull requests</h3>"];
    if (prs.length)
      prSection.push(
        `<ol>${prs
          .slice(0, maxRows)
          .map((p) => pullRequestRow(p, repo))
          .join("")}</ol>`,
      );
    if (prs.length > maxRows) prSection.push(`<p>${prs.length - maxRows} more not shown.</p>`);
    if (!prs.length)
      prSection.push(
        linkage.complete === true
          ? "<p>No associated pull request found within the inspected sources (not proof that none exists).</p>"
          : '<p class="warn">Associated pull requests are unknown: the linkage was not read completely.</p>',
      );
    if (omittedPrs.length)
      prSection.push(
        `<p class="warn">${omittedPrs.length} known pull request(s) not read in detail: ${omittedPrs
          .slice(0, maxRows)
          .map((o) => escapeHtml(record(o).identity))
          .join(
            ", ",
          )}${omittedPrs.length > maxRows ? ` and ${omittedPrs.length - maxRows} more` : ""}.</p>`,
      );
    parts.push(prSection.join(""));

    const ownership = record(r.ownership);
    parts.push(
      `<h3>Responsibility</h3><p>${escapeHtml(ownership.answer)}</p><p>Ticket responsible: ${
        ownership.responsibilityKnown === false
          ? '<span class="warn">unknown (delivery records not read)</span>'
          : known(ownership.ticketResponsible, "none recorded")
      }</p>${
        Array.isArray(ownership.recordedOwners)
          ? `<p>Recorded owners: ${ownership.recordedOwners.length ? ownership.recordedOwners.map(escapeHtml).join(", ") : "none"}</p>`
          : '<p class="warn">Recorded owners unknown.</p>'
      }${ownership.presence ? `<p>${escapeHtml(ownership.presence)}</p>` : ""}`,
    );

    const deps = record(r.dependencies);
    if (deps.known !== true)
      parts.push(
        '<h3>Dependencies</h3><p class="warn">Native dependencies unknown: they were not read.</p>',
      );
    else {
      const blockedBy = list(deps.blockedBy);
      const blocking = list(deps.blocking);
      parts.push(
        `<h3>Dependencies</h3><p>${escapeHtml(deps.verdict)}</p>${blockedBy.length ? `<p>Blocked by</p><ul>${issueRows(blockedBy)}</ul>` : "<p>No native blockers.</p>"}${blocking.length ? `<p>Blocking</p><ul>${issueRows(blocking)}</ul>` : ""}`,
      );
    }

    // Discussion is collapsed: opened on demand, bounded excerpts of what was already read.
    const discussion = record(r.discussion);
    const records = list(discussion.records);
    const excerpts = list(discussion.excerpts);
    // Comments read but not shown are display trimming; a collection gap is only what the
    // coverage of the comments source says was not read completely.
    const trimmedComments = Number(record(coverage.omitted).discussionComments ?? 0);
    const trimmedRecords = Number(record(coverage.omitted).records ?? 0);
    const commentGaps = list(coverage.sources)
      .map(record)
      .filter((c) => c.source === "comments" && c.state !== "complete");
    parts.push(
      `<details id="discussion"><summary>Discussion (${escapeHtml(discussion.totalComments)} comment(s); excerpts, not summaries)</summary>${discussion.note ? `<p>${escapeHtml(discussion.note)}</p>` : ""}${
        records.length
          ? `<h4>Workflow records</h4><ul>${records
              .map((raw) => {
                const d = record(raw);
                return `<li>${link(d.url, d.kind)} ${known(d.at)}: ${escapeHtml(d.excerpt)}</li>`;
              })
              .join("")}</ul>`
          : ""
      }${
        excerpts.length
          ? `<h4>Latest discussion excerpts</h4><ul>${excerpts
              .map((raw) => {
                const d = record(raw);
                return `<li>${link(d.url, d.author)} ${known(d.at)} <small>(${escapeHtml(d.trust)})</small><blockquote>${escapeHtml(d.excerpt)}</blockquote></li>`;
              })
              .join("")}</ul>`
          : ""
      }${trimmedRecords > 0 ? `<p>${escapeHtml(trimmedRecords)} more workflow record(s) not shown; see the source.</p>` : ""}${trimmedComments > 0 ? `<p>${escapeHtml(trimmedComments)} more comment(s) not shown; see the source.</p>` : ""}${commentGaps
        .map(
          (c) =>
            `<p class="warn">Comments of ${escapeHtml(c.subject)} were not read completely (${escapeHtml(c.state)}${c.omission ? `: ${escapeHtml(c.omission)}` : ""}); the discussion may be longer than shown.</p>`,
        )
        .join("")}<p>${link(r.url, "Full discussion on GitHub")}</p></details>`,
    );

    const assessments = record(r.assessments);
    const metric = (name: string, m: Record<string, unknown>) =>
      `${name} ${m.size ? escapeHtml(m.size) : ""} (${escapeHtml(m.state ?? "unknown")})`;
    parts.push(
      `<h3>Assessments</h3><p>${metric("impact", record(assessments.impact))} · ${metric("complexity", record(assessments.complexity))}</p>`,
    );

    // Per-source coverage and observation times, every one listed.
    const freshness = record(r.freshness);
    const sources = list(coverage.sources).map(record);
    const identity = record(r.identity);
    parts.push(
      `<details id="sources"><summary>Sources (${sources.length}; requested ${escapeHtml(freshness.requestedAt)})</summary>${freshness.note ? `<p>${escapeHtml(freshness.note)}</p>` : ""}<ul>${sources
        .map(
          (c) =>
            `<li data-source-state="${escapeHtml(c.state)}">${escapeHtml(c.source)} ${escapeHtml(c.subject)}: ${escapeHtml(c.state)}, observed ${known(c.observedAt, "never")}${c.omission ? ` (${escapeHtml(c.omission)})` : ""}${c.failure ? ` (${escapeHtml(c.failure)})` : ""}</li>`,
        )
        .join(
          "",
        )}</ul><p>Focus: agent ${known(identity.agent, "none")}, platform ${known(identity.platform, "none")}${identity.note ? `. ${escapeHtml(identity.note)}` : ""}</p></details>`,
    );
    const links = record(r.links);
    parts.push(
      `<h3>Full sources</h3><ul>${[links.intake, links.dependencies]
        .filter((c) => typeof c === "string" && c)
        .map((c) => `<li>${code(c)}</li>`)
        .join("")}<li>${link(links.issue ?? r.url, "Issue on GitHub")}</li></ul>`,
    );
    return parts.join("");
  };

  /** The on-demand current status of one PR (`/api/v1/prs/{n}`), bounded. */
  const renderPullRequest = (envelope: unknown, loading: boolean): string => {
    const parts = [header(envelope, loading, "the pull request")];
    const r = record(record(envelope).result);
    if (r.kind === "pr-status") {
      const p = record(r.pullRequest);
      parts.push(
        `<p>${escapeHtml(r.verdict)}</p><p>head ${code(p.head)} · ${escapeHtml(p.state)}${p.draft === true ? " (draft)" : ""} · ${escapeHtml(p.branch)} → ${escapeHtml(p.base)} · merge ${escapeHtml(p.mergeState)}</p>`,
      );
      const blockers = list(r.blockers);
      if (blockers.length)
        parts.push(
          `<ul>${blockers
            .slice(0, 10)
            .map((b) => `<li>${escapeHtml(b)}</li>`)
            .join("")}</ul>`,
        );
      const unresolved = list(record(r.threads).unresolved);
      if (unresolved.length)
        parts.push(
          `<p>${unresolved.length} unresolved review thread(s) shown on ${link(p.url, "GitHub")}.</p>`,
        );
    }
    return parts.join("");
  };

  return {
    escapeHtml,
    validSelection,
    ticketUrl,
    pullRequestUrl,
    backUrl,
    renderState,
    renderTicket,
    renderPullRequest,
  };
}

/** The browser entry point; receives the renderers so it references no module-level names. */
export function ticketClient(render: TicketRenderers): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const state = byId("state");
  const ticket = byId("ticket");
  const back = byId("back") as HTMLAnchorElement;
  const params = new URLSearchParams(location.search);
  const selection = {
    repo: params.get("repo") ?? "",
    n: params.get("n") ?? "",
    agent: params.get("agent") ?? "",
  };
  back.href = render.backUrl(selection);
  let request = 0;

  const fetchEnvelope = async (url: string): Promise<unknown> => {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      return await response.json();
    } catch (error) {
      return { status: "error", error: { code: "UNREACHABLE", message: String(error) } };
    }
  };

  const show = async (refresh: boolean) => {
    if (!render.validSelection(selection)) {
      state.innerHTML = render.renderState(
        {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: "Open a ticket from the to-do list, or pass ?repo=owner/name&n=NUMBER.",
          },
        },
        false,
      );
      return;
    }
    const mine = ++request;
    ticket.classList.add("provisional");
    state.innerHTML = render.renderState(null, true);
    const envelope = await fetchEnvelope(render.ticketUrl({ ...selection, refresh }));
    if (mine !== request) return;
    ticket.classList.remove("provisional");
    state.innerHTML = render.renderState(envelope, false);
    ticket.innerHTML = render.renderTicket(envelope);
  };

  // One PR's current status, only when its button is pressed.
  ticket.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button.load-pr") as HTMLElement | null;
    if (!button) return;
    const number = button.dataset.pr ?? "";
    const target = ticket.querySelector(
      `[data-pr-detail="${CSS.escape(number)}"]`,
    ) as HTMLElement | null;
    if (!target || !/^[1-9]\d*$/.test(number)) return;
    target.innerHTML = render.renderPullRequest(null, true);
    void fetchEnvelope(render.pullRequestUrl(selection.repo, number)).then((envelope) => {
      target.innerHTML = render.renderPullRequest(envelope, false);
    });
  });
  byId("refresh").addEventListener("click", () => void show(true));
  void show(false);
}

/** The served script, built like the dashboard's (see dashboard.ts for the `__name` shim). */
export const ticketScript = (): string =>
  `"use strict";\nvar __name = (target) => target;\n(${ticketClient.toString()})((${ticketRenderers.toString()})());\n`;
