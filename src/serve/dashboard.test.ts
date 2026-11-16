/**
 * The read-only dashboard (#374): pure renderers, and the served script run in an isolated VM
 * context with a minimal fake DOM, proving it is standalone and reads only the documented API.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  dashboardCss,
  dashboardPage,
  dashboardRenderers,
  dashboardScript,
  dashboardSecurityPolicy,
} from "./dashboard.js";

const render = dashboardRenderers();
const url = (n: number) => `https://github.com/o/r/issues/${n}`;
const envelope = (over: Record<string, unknown> = {}, result: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "briefing",
  status: "complete",
  // An explicit agent has no configured triage role; the view's role comes from the result.
  selection: {
    repository: "o/r",
    agent: "me",
    triageRole: null,
    identityDiagnostic: null,
  },
  freshness: {
    source: "cached",
    observedAt: "2026-11-15T00:00:00.000Z",
    ageSeconds: 42,
    ttlSeconds: 300,
    stale: false,
    refreshError: null,
  },
  result: {
    completeness: { complete: true, warnings: [] },
    decisionEngine: { role: { used: "designer", source: "request" } },
    subjects: [{ url: url(1), title: "Fix <b>bold</b> & things" }],
    rankedActions: {
      total: 3,
      omitted: 2,
      items: [
        {
          kind: "implement",
          target: url(1),
          nextCommand: "pdb claim 1 --repo o/r --agent me",
          thenCommand: null,
          inspection: null,
          ruleIds: ["D-ORDINARY"],
          why: { text: "Eligible implementation: impact M, complexity M." },
        },
      ],
    },
    ...result,
  },
  error: null,
  ...over,
});

describe("dashboard renderers (#374)", () => {
  it("renders ranked steps with titles, reasons, rule IDs and commands, escaping GitHub text", () => {
    const html = render.renderActions(envelope());
    expect(html).toContain(
      `<a href="${url(1)}" rel="noreferrer">#1 Fix &lt;b&gt;bold&lt;/b&gt; &amp; things</a>`,
    );
    expect(html).toContain('<span class="kind implement">implement</span>');
    // The badge sits on its own line below the title (the title link and the badge are
    // separated by a line break, so long titles wrap before the badge).
    const titleEnd = html.indexOf("</a>");
    const kindStart = html.indexOf('<span class="kind implement">', titleEnd);
    expect(kindStart).toBeGreaterThan(titleEnd);
    expect(html.slice(titleEnd, kindStart)).toContain("<br>");
    expect(html).toContain(
      "Eligible implementation: impact M, complexity M. <small>(D-ORDINARY)</small>",
    );
    expect(html).toContain("<code>pdb claim 1 --repo o/r --agent me</code>");
    expect(html).toContain("2 more not shown.");
    expect(html).not.toMatch(/<b>|<script/);
  });

  it("falls back to the role view's reason, then the reason codes, for the TypeScript engine", () => {
    const typescript = envelope(
      {},
      {
        decisionEngine: undefined,
        role: {
          name: "implementer",
          sections: [{ items: [{ url: url(1), reason: "Unclaimed, ready, impact <M>." }] }],
        },
        rankedActions: {
          omitted: 0,
          items: [
            { kind: "implement", target: url(1), reasonCodes: ["ordinary"] },
            { kind: "estimate-complexity", target: url(2), reasonCodes: ["assessment"] },
          ],
        },
      },
    );
    const html = render.renderActions(typescript);
    expect(html).toContain("Unclaimed, ready, impact &lt;M&gt;. <small>(ordinary)</small>");
    expect(html).toContain("Ranked estimate-complexity (assessment). <small>(assessment)</small>");
    expect(render.renderState(typescript, false)).toContain("role implementer");
  });

  it("links only to GitHub, keeps the server's order and reports an empty list", () => {
    const hostile = envelope(
      {},
      {
        subjects: [],
        rankedActions: {
          omitted: 0,
          items: [
            { kind: "inspect", target: "javascript:alert(1)", why: { text: "x" } },
            { kind: "implement", target: url(9), why: { text: '"><script>alert(1)</script>' } },
          ],
        },
      },
    );
    const html = render.renderActions(hostile);
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain("<script>");
    expect(html.indexOf("inspect")).toBeLessThan(html.indexOf("#9"));
    expect(render.renderActions(envelope({}, { rankedActions: { items: [], omitted: 0 } }))).toBe(
      "<p>No next steps for this selection.</p>",
    );
    expect(render.renderActions({ status: "error", result: null })).toBe("");
  });

  it("states freshness, staleness, incompleteness, identity and errors truthfully", () => {
    expect(render.renderState(envelope(), false)).toContain(
      "Observed 2026-11-15T00:00:00.000Z (42s ago, cached; cache TTL 300s).",
    );
    const stale = render.renderState(
      envelope({
        status: "incomplete",
        freshness: {
          source: "stale",
          observedAt: "2026-11-15T00:00:00.000Z",
          ageSeconds: 900,
          ttlSeconds: 300,
          stale: true,
          refreshError: { code: "GITHUB_RATE_LIMITED", message: "reset at 01:00" },
        },
      }),
      false,
    );
    expect(stale).toContain(
      "Stale snapshot: the last refresh failed (GITHUB_RATE_LIMITED: reset at 01:00)",
    );
    expect(stale).toContain("Incomplete evidence: missing facts are unknown, never approval.");
    const unfocused = render.renderState(
      envelope({
        selection: {
          repository: "o/r",
          agent: null,
          triageRole: "designer",
          identityDiagnostic: "No identity <entry>",
        },
      }),
      false,
    );
    expect(unfocused).toContain("No identity &lt;entry&gt;");
    expect(unfocused).toContain("agent none (unfocused)");
    // The header shows the role the briefing was ranked for, never the identity's configured role.
    expect(render.renderState(envelope(), false)).toContain("o/r · role designer · agent me");
    expect(unfocused).not.toContain("role implementer");
    expect(
      render.renderState(
        { status: "error", error: { code: "REPOSITORY_UNRESOLVED", message: "pick one" } },
        false,
      ),
    ).toContain('<p class="error">REPOSITORY_UNRESOLVED: pick one</p>');
    expect(render.renderState(null, true)).toContain("Loading…");
    // Bounded warnings report what they leave out and link to the full JSON for the same view.
    const many = render.renderState(
      envelope(
        { status: "incomplete" },
        {
          completeness: {
            complete: false,
            warnings: Array.from({ length: 13 }, (_, i) => `w${i}`),
          },
        },
      ),
      false,
    );
    expect(many).toContain('<p class="warn">w9</p>');
    expect(many).not.toContain("w10");
    expect(many).toContain(
      '3 more warning(s) not shown; every warning is in the <a href="/api/v1/briefing?repo=o%2Fr&amp;role=designer&amp;limit=50&amp;agent=me">JSON briefing</a>.',
    );
  });

  it("builds the briefing request from the explicit selection only", () => {
    expect(render.briefingUrl({ repo: "o/r", role: "designer", agent: "" })).toBe(
      "/api/v1/briefing?repo=o%2Fr&role=designer&limit=50",
    );
    expect(
      render.briefingUrl({ repo: "o/r", role: "implementer", agent: "a b", refresh: true }),
    ).toBe("/api/v1/briefing?repo=o%2Fr&role=implementer&limit=50&agent=a+b&refresh=true");
  });
});

describe("dashboard page and script (#374)", () => {
  it("has no inline script or style and loads nothing from another origin", () => {
    const page = dashboardPage();
    expect(page).toContain('<script src="/dashboard.js" defer></script>');
    expect(page).toContain('<link rel="stylesheet" href="/dashboard.css">');
    expect(page).toContain('<a href="/rules">Rules</a>');
    expect(page).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=|https?:\/\//);
    expect(dashboardCss).not.toMatch(/url\(|@import/);
    // Action-kind badge palette (#597) has light and dark variants with a neutral fallback.
    expect(dashboardCss).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*\.kind\.pr-follow-up/,
    );
    expect(dashboardCss).toMatch(/\.kind\.implement \{ color: #1a5fb4;/);
    expect(dashboardSecurityPolicy).toContain("default-src 'none'");
    expect(dashboardSecurityPolicy).toContain("script-src 'self'");
    expect(dashboardSecurityPolicy).not.toContain("unsafe");
  });

  /** A minimal DOM: just what the client uses. */
  function fakeBrowser(search: string, responses: Record<string, unknown>) {
    const listeners = new Map<string, () => void>();
    const element = (id: string) => ({
      id,
      value: "",
      href: "",
      innerHTML: "",
      textContent: "",
      selectedIndex: 0,
      options: [] as { value: string }[],
      classList: { add() {}, remove() {} },
      append(option: { value: string }) {
        this.options.push(option);
        if (this.options.length === 1) this.value = option.value;
      },
      addEventListener(type: string, fn: () => void) {
        listeners.set(`${id}:${type}`, fn);
      },
    });
    const elements = new Map(
      ["repo", "role", "agent", "state", "actions", "selection", "refresh", "rules-link"].map(
        (id) => [id, element(id)],
      ),
    );
    elements.get("role")!.value = "implementer";
    const fetched: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const viewLinks = [
      {
        href: "http://localhost/?repo=other%2Frepo&role=designer",
        getAttribute: () => "role agent",
      },
    ];
    const sandbox = {
      document: {
        getElementById: (id: string) => elements.get(id),
        createElement: () => ({ value: "", textContent: "" }),
        querySelectorAll: () => viewLinks,
      },
      location: {
        href: "http://localhost/",
        search,
        assign: (to: string) => void (shown.assigned = to),
      },
      history: {
        replaceState: (_s: unknown, _t: string, to: string) => {
          shown.url = to;
          sandbox.location.search = to;
        },
        pushState: (_s: unknown, _t: string, to: string) => {
          shown.url = to;
          sandbox.location.search = to;
        },
      },
      URLSearchParams,
      URL,
      AbortController,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      fetch: async (path: string, options?: { signal?: AbortSignal }) => {
        fetched.push(path);
        signals.push(options?.signal);
        const body = responses[path.split("?")[0]!];
        return { json: async () => await body };
      },
    };
    const shown = { url: "", assigned: "" };
    return { sandbox, elements, fetched, shown, listeners, signals, viewLinks };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("defines the __name helper that source runs (tsx keepNames) inject", () => {
    // A function wrapped as tsx emits it must still run in the served context.
    const wrapped = `${dashboardScript().split("\n").slice(0, 2).join("\n")}\nglobalThis.result = __name(() => 7, "f")();`;
    const context: { result?: number } = {};
    runInNewContext(wrapped, context);
    expect(context.result).toBe(7);
  });

  it("runs standalone: reads only the explicitly selected briefing and renders it", async () => {
    const browser = fakeBrowser("?repo=o%2Fr&role=designer", {
      "/api/v1/status": { repositories: [{ repository: "o/r", default: true }] },
      "/api/v1/briefing": envelope(),
    });
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    await settle();
    expect(browser.fetched).toEqual(["/api/v1/briefing?repo=o%2Fr&role=designer&limit=50"]);
    expect(browser.elements.get("actions")!.innerHTML).toContain("#1 Fix &lt;b&gt;bold");
    expect(browser.elements.get("state")!.innerHTML).toContain("Observed");
    expect(browser.shown.url).toBe("?repo=o%2Fr&role=designer");
    // The rules page link (#392) follows the selected project, encoded, on the same origin.
    expect(browser.fetched).not.toContain("/api/v1/status");
    // Refresh asks the server to bypass its cache for this one view.
    browser.listeners.get("refresh:click")!();
    await settle();
    expect(browser.fetched.at(-1)).toContain("refresh=true");
  });

  it("with several projects and none chosen, fetches no briefing until one is selected", async () => {
    const browser = fakeBrowser("", {
      "/api/v1/status": {
        repositories: [
          { repository: "o/a", default: false },
          { repository: "o/b", default: false },
        ],
      },
    });
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    expect(browser.fetched).toEqual([]);
    expect(browser.elements.get("state")!.innerHTML).toContain("No project selected.");
  });

  it("opens the human attention page (#458) for the human role, without fetching a briefing", async () => {
    const browser = fakeBrowser("?repo=o%2Fr&role=human&agent=me", {
      "/api/v1/status": { repositories: [{ repository: "o/r", default: true }] },
    });
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    expect(browser.shown.assigned).toBe("/human?repo=o%2Fr");
    expect(browser.fetched).toEqual([]);
  });
  it("aborts superseded reads, ignores late results and restores the role on history navigation", async () => {
    let resolveOld!: (value: unknown) => void;
    const responses: Record<string, unknown> = {
      "/api/v1/briefing": new Promise((done) => {
        resolveOld = done;
      }),
    };
    const browser = fakeBrowser("?repo=o/r&role=designer&agent=me", responses);
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    responses["/api/v1/briefing"] = envelope(
      {},
      { subjects: [{ url: url(1), title: "New result" }] },
    );
    browser.elements.get("role")!.value = "implementer";
    browser.listeners.get("role:change")!();
    await settle();
    expect(browser.signals[0]?.aborted).toBe(true);
    expect(browser.shown.url).toContain("role=implementer");
    expect(browser.viewLinks[0]!.href).toBe("/?repo=other%2Frepo&role=implementer&agent=me");
    resolveOld(envelope({}, { subjects: [{ url: url(1), title: "Old result" }] }));
    await settle();
    expect(browser.elements.get("actions")!.innerHTML).toContain("New result");
    expect(browser.elements.get("actions")!.innerHTML).not.toContain("Old result");
    browser.sandbox.location.search = "?repo=o/r&role=designer&agent=me";
    browser.listeners.get("popstate")!();
    await settle();
    expect(browser.elements.get("role")!.value).toBe("designer");
    expect(browser.fetched.at(-1)).toContain("role=designer");
  });
  it("does not render an answer from another repository", async () => {
    const browser = fakeBrowser("?repo=o/r", {
      "/api/v1/briefing": envelope({ selection: { repository: "other/repo" } }),
    });
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    expect(browser.elements.get("actions")!.innerHTML).toBe("");
    expect(browser.elements.get("state")!.innerHTML).toContain("SELECTION_MISMATCH");
  });
});
