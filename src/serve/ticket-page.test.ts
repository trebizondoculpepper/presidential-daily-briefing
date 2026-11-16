/**
 * The read-only ticket detail page (#454): pure renderers over `ticket-status` envelopes, and the
 * served script run in an isolated VM context with a minimal fake DOM, proving it is standalone,
 * fetches the one ticket only when opened and a pull request only on request.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { dashboardRenderers } from "./dashboard.js";
import { ticketPage, ticketRenderers, ticketScript } from "./ticket-page.js";

const render = ticketRenderers();
const issueUrl = (n: number) => `https://github.com/o/r/issues/${n}`;
const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;
const hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>';

const pr = (over: Record<string, unknown> = {}) => ({
  repository: "o/r",
  number: 9,
  url: prUrl(9),
  relations: ["required"],
  detail: "read",
  detailWhy: null,
  listedState: null,
  observedAt: "2026-11-15T00:00:00.000Z",
  title: "Implement it",
  state: "OPEN",
  draft: false,
  head: "abc",
  branch: "feat",
  base: "main",
  intendedTarget: null,
  targetMismatch: null,
  checks: { verify: "missing", requirements: "satisfied", counts: { passed: 3 } },
  review: { decision: null, headReviewed: true, headFindings: false, unresolvedThreads: 0 },
  mergeable: "MERGEABLE",
  blockers: [],
  memberState: "open",
  responsible: "alice",
  followUp: null,
  followUpWhy: null,
  complete: true,
  warnings: [],
  ...over,
});

const ticket = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "ticket-status",
  repository: "o/r",
  number: 1,
  title: "Ticket one",
  url: issueUrl(1),
  state: "OPEN",
  closure: "open",
  closedBy: null,
  coverage: {
    complete: true,
    warnings: [],
    sources: [],
    linkage: { scope: "closing references", complete: true },
    omitted: { pullRequests: [], discussionComments: 0, records: 0 },
    limitPullRequests: 10,
  },
  ownership: {
    answer: "Claimed by alice.",
    ticketResponsible: "alice",
    responsibilityKnown: true,
  },
  delivery: { verdict: "pending", records: [], because: ["One member open."], required: [] },
  pullRequests: [pr()],
  dependencies: { known: true, blockedBy: [], blocking: [], verdict: "Unblocked." },
  discussion: {
    totalComments: 2,
    records: [],
    excerpts: [
      {
        author: "bob",
        at: "2026-11-14T00:00:00Z",
        url: `${issueUrl(1)}#c1`,
        excerpt: "Looks fine",
        trust: "unverified",
      },
    ],
    note: "Excerpts of already read comments.",
  },
  assessments: {
    impact: { state: "current", size: "M", provenance: null },
    complexity: { state: "unknown", size: null, provenance: null },
  },
  nextSteps: [
    { kind: "wait", why: "Waiting for review.", rule: null, subject: prUrl(9), command: null },
  ],
  links: {
    intake: "pdb --issue 1 --repo o/r --json",
    dependencies: "pdb deps 1 --repo o/r",
    issue: issueUrl(1),
    pullRequests: [prUrl(9)],
  },
  completeness: { complete: true, warnings: [] },
  ...over,
});

const envelope = (result: unknown, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "ticket",
  status: "complete",
  selection: { repository: "o/r", agent: "me", identityDiagnostic: null },
  freshness: {
    source: "cached",
    observedAt: "2026-11-15T00:00:00.000Z",
    ageSeconds: 5,
    ttlSeconds: 300,
    stale: false,
    refreshError: null,
  },
  warnings: [],
  result,
  error: null,
  ...over,
});

describe("ticket detail renderers (#454)", () => {
  it("projects the document's own state, delivery, PR evidence and links, with no percentage", () => {
    const html = render.renderTicket(envelope(ticket()));
    expect(html).toContain(`<a href="${issueUrl(1)}" rel="noreferrer">#1 Ticket one</a>`);
    expect(html).toContain('data-delivery="pending"');
    expect(html).toContain("One member open.");
    expect(html).toContain("current head reviewed");
    expect(html).toContain("checks satisfied");
    expect(html).toContain("Waiting for review.");
    expect(html).toContain("<code>pdb --issue 1 --repo o/r --json</code>");
    expect(html).toContain('data-pr="9"');
    expect(html).not.toMatch(/\d+\s*%|percent/i);
  });

  it("escapes every GitHub-authored value and links only to GitHub", () => {
    const html = render.renderTicket(
      envelope(
        ticket({
          title: hostile,
          url: "javascript:alert(1)",
          pullRequests: [pr({ title: hostile, branch: hostile, url: "data:text/html,x" })],
          discussion: {
            totalComments: 1,
            records: [],
            excerpts: [
              { author: hostile, at: null, url: "javascript:x", excerpt: hostile, trust: "x" },
            ],
            note: hostile,
          },
          nextSteps: [{ kind: hostile, why: hostile, rule: hostile, command: hostile }],
        }),
      ),
    );
    expect(html).not.toMatch(/<script|<img|href="javascript|href="data:/);
    expect(html).toContain("&lt;script&gt;");
    const state = render.renderState(
      envelope(null, {
        status: "error",
        error: { code: hostile, message: hostile, next: [hostile] },
        warnings: [hostile],
      }),
      false,
    );
    expect(state).not.toMatch(/<script|<img/);
  });

  it("shows unread evidence as unknown, never as absent", () => {
    const html = render.renderTicket(
      envelope(
        ticket({
          pullRequests: [
            pr({ detail: "omitted", detailWhy: "beyond --limit-prs", checks: null, review: null }),
          ],
          coverage: {
            linkage: { complete: false },
            omitted: {
              pullRequests: [{ identity: "o/r#12", relations: ["required"], why: "bound" }],
              discussionComments: 4,
            },
          },
          dependencies: { known: false, blockedBy: [], blocking: [], verdict: "" },
          ownership: { answer: "Unknown.", ticketResponsible: null, responsibilityKnown: false },
          delivery: { verdict: "unknown", because: [] },
        }),
        { status: "incomplete" },
      ),
    );
    expect(html).toContain("status unknown (omitted: beyond --limit-prs)");
    expect(html).not.toContain("checks passed");
    expect(html).toContain("1 known pull request(s) not read in detail: o/r#12");
    expect(html).toContain("Native dependencies unknown");
    expect(html).not.toContain("No native blockers");
    expect(html).toContain('Ticket responsible: <span class="warn">unknown');
    expect(html).toContain("unknown (delivery records not read)");
    expect(html).toContain("4 more comment(s) not shown; see the source.");
    // No PR rows and an incomplete linkage is unknown, not "none".
    const empty = render.renderTicket(
      envelope(ticket({ pullRequests: [], coverage: { linkage: { complete: false } } })),
    );
    expect(empty).toContain("Associated pull requests are unknown");
    expect(empty).not.toContain("No associated pull request found");
    const none = render.renderTicket(envelope(ticket({ pullRequests: [] })));
    expect(none).toContain("not proof that none exists");
    expect(render.renderState(envelope(ticket(), { status: "incomplete" }), false)).toContain(
      "Incomplete evidence",
    );
  });

  it("lists every delivery member, commit evidence included, with its own state", () => {
    const html = render.renderTicket(
      envelope(
        ticket({
          delivery: {
            verdict: "partial",
            records: "known",
            because: [],
            required: ["o/r#9", "o/r@abc123"],
            deliverables: [
              {
                deliverable: "o/r#9",
                url: prUrl(9),
                target: "o/r:main",
                state: "open",
                why: "Open.",
                responsible: "alice",
                followUp: "none",
                followUpWhy: "",
              },
              {
                deliverable: "o/r@abc123",
                url: null,
                target: "o/r:main",
                state: "landed",
                why: "Commit on main.",
                responsible: null,
                followUp: "none",
                followUpWhy: "",
              },
            ],
          },
        }),
      ),
    );
    expect(html).toContain('data-member-state="landed"');
    expect(html).toContain("o/r@abc123 → o/r:main: landed");
    expect(html).toContain("Commit on main.");
    expect(html).toContain("Required: o/r#9, o/r@abc123");
    expect(html.match(/data-member-state=/g)).toHaveLength(2);
  });

  it("separates comments not shown (display trimming) from comments not read (coverage)", () => {
    const trimmed = render.renderTicket(
      envelope(
        ticket({
          coverage: {
            linkage: { complete: true },
            sources: [{ source: "comments", subject: "o/r#1", state: "complete" }],
            omitted: { pullRequests: [], discussionComments: 7, records: 2 },
          },
        }),
      ),
    );
    expect(trimmed).toContain("7 more comment(s) not shown; see the source.");
    expect(trimmed).toContain("2 more workflow record(s) not shown; see the source.");
    expect(trimmed).not.toMatch(/not read completely|comment\(s\) not read/);
    const gap = render.renderTicket(
      envelope(
        ticket({
          coverage: {
            linkage: { complete: true },
            sources: [
              { source: "comments", subject: "o/r#1", state: "partial", omission: "beyond 100" },
            ],
            omitted: { pullRequests: [], discussionComments: 0, records: 0 },
          },
        }),
      ),
    );
    expect(gap).toContain("Comments of o/r#1 were not read completely (partial: beyond 100)");
    expect(gap).not.toContain("more comment(s) not shown");
  });

  it("renders or counts every array of the document", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      url: issueUrl(100 + i),
      number: 100 + i,
      title: "t",
      state: "OPEN",
      repository: "o/r",
    }));
    const html = render.renderTicket(
      envelope(
        ticket({
          pullRequests: [pr({ blockers: ["a", "b", "c", "d", "e", "f", "g"], warnings: ["w1"] })],
          dependencies: { known: true, blockedBy: many, blocking: [], verdict: "Blocked." },
          ownership: {
            answer: "x",
            ticketResponsible: "alice",
            responsibilityKnown: true,
            recordedOwners: ["alice"],
          },
          freshness: { requestedAt: "t0", note: "n" },
          identity: { agent: "me", platform: "claude", note: "focus only" },
          coverage: {
            linkage: { complete: true },
            sources: [
              { source: "issue", subject: "o/r#1", state: "complete", observedAt: "t1" },
              { source: "native-edges", subject: "o/r#1", state: "failed", failure: "x" },
            ],
            omitted: { pullRequests: [], discussionComments: 0, records: 0 },
          },
        }),
      ),
    );
    expect(html).toContain("2 more blocker(s) not shown");
    expect(html).toContain("w1");
    expect(html).toContain("check counts: passed 3");
    expect(html).toContain("10 more not shown; see the source.");
    expect(html).toContain("Recorded owners: alice");
    expect(html.match(/data-source-state=/g)).toHaveLength(2);
    expect(html).toContain("observed never");
    expect(html).toContain("platform claude");
  });

  it("keeps missing, inaccessible and moved tickets distinct", () => {
    const unavailable = (state: string, extra: Record<string, unknown> = {}) =>
      render.renderTicket(
        envelope({
          schemaVersion: 1,
          kind: "issue-unavailable",
          repository: "o/r",
          number: 7,
          url: issueUrl(7),
          state,
          detail: "d",
          next: "gh issue view 7",
          ...extra,
        }),
      );
    expect(unavailable("missing")).toContain("does not exist");
    expect(unavailable("forbidden")).toContain("inaccessible, not missing");
    expect(unavailable("forbidden")).not.toContain("does not exist");
    expect(
      unavailable("moved", {
        destination: { repository: "x/y", number: 3, url: "https://github.com/x/y/issues/3" },
      }),
    ).toContain("not followed here");
  });

  it("states loading, freshness and staleness", () => {
    expect(render.renderState(null, true)).toContain("Loading the ticket");
    expect(render.renderState(envelope(ticket()), false)).toContain("5s ago, cached");
    const stale = envelope(ticket(), {
      freshness: {
        source: "stale",
        observedAt: "t",
        stale: true,
        refreshError: { code: "GITHUB_RATE_LIMITED", message: "later" },
      },
    });
    expect(render.renderState(stale, false)).toContain("Stale: the last refresh failed");
    expect(render.renderPullRequest(null, true)).toContain("Loading the pull request");
  });

  it("builds only validated, encoded same-origin requests", () => {
    const selection = { repo: "o/r", n: "1", agent: "me" };
    expect(render.validSelection(selection)).toBe(true);
    for (const bad of [
      { ...selection, repo: "o/r/x" },
      { ...selection, n: "0" },
      { ...selection, n: "1/../../refresh" },
      { ...selection, agent: "<x>" },
    ])
      expect(render.validSelection(bad)).toBe(false);
    expect(render.ticketUrl({ ...selection, refresh: true })).toBe(
      "/api/v1/tickets/1?repo=o%2Fr&agent=me&refresh=true",
    );
    expect(render.pullRequestUrl("o/r", 9)).toBe("/api/v1/prs/9?repo=o%2Fr");
    expect(render.backUrl(selection)).toBe("/?repo=o%2Fr&agent=me");
  });

  it("the to-do list links each issue of the selected project to its detail page", () => {
    const html = dashboardRenderers().renderActions({
      selection: { repository: "o/r", agent: "me" },
      result: {
        subjects: [],
        rankedActions: {
          omitted: 0,
          items: [
            { kind: "implement", target: issueUrl(4), why: { text: "x" } },
            { kind: "review", target: prUrl(9), why: { text: "y" } },
            { kind: "implement", target: "https://github.com/other/repo/issues/2", why: {} },
          ],
        },
      },
    });
    expect(html).toContain('href="/ticket?repo=o%2Fr&amp;n=4&amp;role=implementer&amp;agent=me"');
    expect(html.match(/\/ticket\?/g)).toHaveLength(1);
  });
});

describe("ticket detail page and script (#454)", () => {
  it("has no inline script or style and loads nothing from another origin", () => {
    const page = ticketPage();
    expect(page).toContain('<script src="/ticket.js" defer></script>');
    expect(page).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=|https?:\/\//);
  });

  function fakeBrowser(search: string, responses: Record<string, unknown>) {
    const listeners = new Map<string, (event?: unknown) => void>();
    const detail = { innerHTML: "" };
    const element = (id: string) => ({
      id,
      href: "",
      innerHTML: "",
      classList: { add() {}, remove() {} },
      addEventListener(type: string, fn: (event?: unknown) => void) {
        listeners.set(`${id}:${type}`, fn);
      },
      querySelector: () => detail,
    });
    const elements = new Map(["state", "ticket", "back", "refresh"].map((id) => [id, element(id)]));
    const fetched: string[] = [];
    const sandbox = {
      document: { getElementById: (id: string) => elements.get(id) },
      location: { search },
      URLSearchParams,
      AbortController,
      addEventListener: () => {},
      CSS: { escape: (s: string) => s },
      fetch: async (path: string) => {
        fetched.push(path);
        return { json: async () => responses[path.split("?")[0]!] };
      },
    };
    return { sandbox, elements, fetched, listeners, detail };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("fetches the one ticket when opened, and a pull request only when asked", async () => {
    const browser = fakeBrowser("?repo=o%2Fr&n=1&agent=me", {
      "/api/v1/tickets/1": envelope(ticket()),
      "/api/v1/prs/9": envelope({ kind: "pr-status", verdict: "Ready.", pullRequest: {} }),
    });
    runInNewContext(ticketScript(), browser.sandbox);
    await settle();
    await settle();
    expect(browser.fetched).toEqual(["/api/v1/tickets/1?repo=o%2Fr&agent=me"]);
    expect(browser.elements.get("ticket")!.innerHTML).toContain("#1 Ticket one");
    expect(browser.elements.get("back")!.href).toBe("/?repo=o%2Fr&role=implementer&agent=me");
    const button = { dataset: { pr: "9" } };
    browser.listeners.get("ticket:click")!({ target: { closest: () => button } });
    expect(browser.detail.innerHTML).toContain("Loading the pull request");
    await settle();
    await settle();
    expect(browser.fetched.at(-1)).toBe("/api/v1/prs/9?repo=o%2Fr");
    expect(browser.detail.innerHTML).toContain("Ready.");
    browser.listeners.get("refresh:click")!();
    await settle();
    expect(browser.fetched.at(-1)).toBe("/api/v1/tickets/1?repo=o%2Fr&agent=me&refresh=true");
  });

  it("fetches nothing for an invalid selection", async () => {
    const browser = fakeBrowser("?repo=o%2Fr&n=..%2Frefresh", {});
    runInNewContext(ticketScript(), browser.sandbox);
    await settle();
    expect(browser.fetched).toEqual([]);
    expect(browser.elements.get("state")!.innerHTML).toContain("INVALID_ARGUMENT");
  });
});
