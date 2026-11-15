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
  selection: {
    repository: "o/r",
    agent: "me",
    triageRole: "implementer",
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
    expect(html).toContain('<span class="kind">implement</span>');
    expect(html).toContain(
      "Eligible implementation: impact M, complexity M. <small>(D-ORDINARY)</small>",
    );
    expect(html).toContain("<code>pdb claim 1 --repo o/r --agent me</code>");
    expect(html).toContain("2 more not shown.");
    expect(html).not.toMatch(/<b>|<script/);
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
    expect(
      render.renderState(
        { status: "error", error: { code: "REPOSITORY_UNRESOLVED", message: "pick one" } },
        false,
      ),
    ).toContain('<p class="error">REPOSITORY_UNRESOLVED: pick one</p>');
    expect(render.renderState(null, true)).toContain("Loading…");
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
    expect(page).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=|https?:\/\//);
    expect(dashboardCss).not.toMatch(/url\(|@import/);
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
      ["repo", "role", "agent", "state", "actions", "selection", "refresh"].map((id) => [
        id,
        element(id),
      ]),
    );
    elements.get("role")!.value = "implementer";
    const fetched: string[] = [];
    const sandbox = {
      document: {
        getElementById: (id: string) => elements.get(id),
        createElement: () => ({ value: "", textContent: "" }),
      },
      location: { search },
      history: { replaceState: (_s: unknown, _t: string, to: string) => void (shown.url = to) },
      URLSearchParams,
      fetch: async (path: string) => {
        fetched.push(path);
        const body = responses[path.split("?")[0]!];
        return { json: async () => body };
      },
    };
    const shown = { url: "" };
    return { sandbox, elements, fetched, shown, listeners };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("defines the __name helper that source runs (tsx keepNames) inject", () => {
    // A function wrapped as tsx emits it must still run in the served context.
    const wrapped = `${dashboardScript().split("\n").slice(0, 2).join("\n")}\nglobalThis.result = __name(() => 7, "f")();`;
    const context: { result?: number } = {};
    runInNewContext(wrapped, context);
    expect(context.result).toBe(7);
  });

  it("runs standalone: reads status, then only the selected briefing, and renders it", async () => {
    const browser = fakeBrowser("?role=designer", {
      "/api/v1/status": { repositories: [{ repository: "o/r", default: true }] },
      "/api/v1/briefing": envelope(),
    });
    runInNewContext(dashboardScript(), browser.sandbox);
    await settle();
    await settle();
    expect(browser.fetched).toEqual([
      "/api/v1/status",
      "/api/v1/briefing?repo=o%2Fr&role=designer&limit=50",
    ]);
    expect(browser.elements.get("actions")!.innerHTML).toContain("#1 Fix &lt;b&gt;bold");
    expect(browser.elements.get("state")!.innerHTML).toContain("Observed");
    expect(browser.shown.url).toBe("?repo=o%2Fr&role=designer");
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
    expect(browser.fetched).toEqual(["/api/v1/status"]);
    expect(browser.elements.get("state")!.innerHTML).toContain("Select a project.");
  });
});
