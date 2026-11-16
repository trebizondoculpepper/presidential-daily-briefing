/**
 * Human attention view (#458): the page route, its parity with the shared human briefing served
 * by the API, its renderers, and its standalone browser script. Injected facts only; no test
 * touches GitHub.
 */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { TOML_CONFIG_PATH } from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import type { Issue, Page } from "../github/types.js";
import type { Clock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { dashboardRenderers, dashboardSecurityPolicy } from "./dashboard.js";
import { humanRenderers, humanScript } from "./human-page.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";

const repo = "example/parity";
const start = Date.parse("2026-11-12T10:00:00.000Z");
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (n: number, labels: string[], title = `Ticket ${n}`): Issue => ({
  number: n,
  title,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-12T09:00:00.000Z",
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
/** Synthetic facts: one explicit request to the human, two inferred decisions, agent work. */
const issues = (): Issue[] => [
  issue(1, ["status:ready", "impact:L"]),
  issue(2, ["design:decision-needed"], "Pick <b>storage</b>"),
  issue(3, ["attention:owner-name", "status:ready"]),
  issue(4, ["question"]),
];
const query: Query = async (source) => ({
  repository: {
    issues: page(source.includes("issues(first") ? issues() : []),
    pullRequests: page([]),
    issue: null,
  },
});
const root = resolve("/work/parity-checkout");
const files: ConfigFileSystem = {
  readText: async (file) => (file === join(root, TOML_CONFIG_PATH) ? null : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
};
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const clock: Clock = {
  now: () => new Date(start),
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};

async function setup(args = ["--repo", repo]) {
  const collected: string[] = [];
  const serve: ServeRuntime = {
    currentRepository: async () => repo,
    authContext: async () => ({ host: "github.com", login: "octo" }),
    clock,
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
  };
  const read: ServeReadRuntime = {
    collectIssueFocus: async () => {
      throw new Error("not used");
    },
    collect: (repository, options) => {
      collected.push(repository);
      return collect(repository, options, query, () => clock.now());
    },
    dependencyReport: async () => {
      throw new Error("not used");
    },
    now: () => clock.now(),
    env: {},
    git,
    fs: files,
    projectRuntime: () => ({
      estimation: { fs: files, git, cwd: root },
      guide: { fs: files, git, cwd: root },
    }),
  };
  const options = serveArguments(["--port", "0", ...args]);
  const running = await startServe(options, serve, readServices(options, serve, read));
  return { running, collected };
}

function get(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

const base = dashboardRenderers();
const view = humanRenderers(base);

describe("human attention page route (#458)", () => {
  it("renders the shell for a served project with the dashboard CSP and no GitHub read", async () => {
    const s = await setup();
    try {
      const reply = await get(
        s.running.port,
        `/human?repo=${encodeURIComponent(repo)}&agent=owner-name`,
      );
      expect(reply.status).toBe(200);
      expect(reply.headers["content-security-policy"]).toBe(dashboardSecurityPolicy);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).toContain(`data-repo="${repo}"`);
      expect(reply.body).toContain('value="owner-name"');
      expect(reply.body).toContain('<script src="/human.js" defer></script>');
      expect(reply.body).not.toMatch(/<script>|<style|style=/);
      // Work navigation: the agent views drop the human's name.
      expect(reply.body).toContain('href="/?repo=example%2Fparity&amp;role=designer"');
      expect(reply.body).toContain('aria-current="page">Work</a>');
      const script = await get(s.running.port, "/human.js");
      expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(script.body).toBe(humanScript());
      // Rendering the page (and its script) reads nothing from GitHub.
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("fails safely for unserved, malformed, unknown and repeated input, without reading", async () => {
    const s = await setup(["--repo", repo, "--repo", "example/other"]);
    try {
      const cases: [string, number, string][] = [
        ["/human?repo=example%2Fnope", 403, "not served by this server"],
        ["/human?repo=not-a-repo", 400, "repo must be owner/name"],
        ["/human?repo=example%2Fparity&role=human", 400, "Unknown parameter"],
        ["/human?repo=example%2Fparity&repo=example%2Fother", 400, "at most once"],
        ["/human?repo=example%2Fparity&agent=%3Cscript%3E", 400, "agent must be a name"],
      ];
      for (const [path, status, text] of cases) {
        const reply = await get(s.running.port, path);
        expect(reply.status, path).toBe(status);
        expect(reply.body).toContain(text);
        expect(reply.body).toContain('role="alert"');
        expect(reply.body).not.toContain("data-repo=");
        expect(reply.headers["content-security-policy"]).toBe(dashboardSecurityPolicy);
      }
      // No project: a choice, never a guess, even though the API would need one too.
      const none = await get(s.running.port, "/human");
      expect(none.status).toBe(200);
      expect(none.body).toContain("No project selected");
      expect(none.body).not.toContain("data-repo=");
      expect(none.body).toContain('href="/human?repo=example%2Fother"');
      expect((await get(s.running.port, "/human", "POST")).status).toBe(405);
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("does not resolve a missing project even when only one is served", async () => {
    const s = await setup();
    try {
      const reply = await get(s.running.port, "/human");
      expect(reply.body).toContain("No project selected");
      expect(reply.body).not.toContain("data-repo=");
    } finally {
      await s.running.close();
    }
  });
});

describe("human attention page and service parity (#458)", () => {
  it("shows exactly the shared projection's items, in its order, explicit apart from inferred", async () => {
    const s = await setup();
    try {
      const reply = await get(
        s.running.port,
        `/api/v1/briefing?repo=${encodeURIComponent(repo)}&role=human&agent=owner-name&limit=50`,
      );
      const envelope = JSON.parse(reply.body) as { status: string; result: { human: any } };
      const items = envelope.result.human.items as { target: string; explicit: boolean }[];
      expect(items.length).toBe(3);
      const sections = view.renderSections(envelope, 50);
      const shown = [...sections.actionable.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]);
      expect(shown).toEqual(items.map((i) => i.target));
      // #3 is addressed (attention:owner-name) and first; #2 and #4 are inferred candidates.
      expect(items[0]!.target).toBe(url(3));
      expect(sections.actionable).toContain("Addressed to you");
      expect(sections.actionable.match(/Candidate \(inferred/g)?.length).toBe(2);
      expect(sections.actionable).toContain("Pick &lt;b&gt;storage&lt;/b&gt;");
      expect(sections.waiting).toContain("Waiting (0)");
      // Closed tickets are not read without a live boundary: never an all-clear.
      expect(envelope.status).toBe("incomplete");
      expect(view.renderCoverage(envelope)).toContain("Closed tickets were not read");
      expect(view.renderCoverage(envelope)).toContain("Coverage incomplete");
      // Unrouted: the projection's own notice, not a borrowed identity.
      const unrouted = JSON.parse(
        (await get(s.running.port, `/api/v1/briefing?repo=${encodeURIComponent(repo)}&role=human`))
          .body,
      );
      expect(unrouted.selection.agent).toBeNull();
      expect(view.renderNotices(unrouted)).toContain("No human named");
      expect(view.renderSections(unrouted, 50).actionable).not.toContain("Addressed to you");
    } finally {
      await s.running.close();
    }
  });
});

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `${repo} ${url(n)} decide`,
  kind: "decide",
  target: url(n),
  title: `Ticket ${n}`,
  explicit: false,
  addressed: false,
  routedTo: [],
  raisedBy: [],
  requested: [],
  reason: "Labelled question without a trusted record.",
  blocks: { subjects: [url(n)], unknown: [] },
  source: url(n),
  ruleIds: ["D-HUMAN-DECIDE"],
  why: "",
  nextCommand: `pdb --repo ${repo} --issue ${n}`,
  warnings: [],
  sourceState: "open",
  ...over,
});
const humanEnvelope = (
  items: unknown[],
  over: Record<string, unknown> = {},
  human: Record<string, unknown> = {},
) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "briefing",
  status: "complete",
  selection: { repository: repo, agent: null },
  freshness: null,
  warnings: [],
  result: {
    human: {
      schemaVersion: 1,
      human: null,
      routing: "unrouted",
      total: items.length,
      omitted: 0,
      items,
      notices: [],
      coverage: {
        complete: true,
        warnings: [],
        records: { current: 0 },
        excluded: ["GitHub review requests (not collected)"],
        closedSources: { read: true, complete: true, scan: { origin: "continued" } },
      },
      ...human,
    },
  },
  error: null,
  ...over,
});

describe("human attention renderers (#458)", () => {
  it("says nothing is waiting only for a complete, empty projection", () => {
    expect(view.renderSections(humanEnvelope([]), 50).actionable).toContain(
      "No human input is waiting.",
    );
    const incomplete = view.renderSections(humanEnvelope([], { status: "incomplete" }), 50);
    expect(incomplete.actionable).not.toContain("No human input is waiting");
    expect(incomplete.actionable).toContain("not an all-clear");
    expect(incomplete.waiting).toContain("not an all-clear");
    // A failed read renders no list at all, so stale rows cannot look current.
    expect(
      view.renderSections({ status: "error", error: { code: "GITHUB_UNAVAILABLE" } }, 50),
    ).toEqual({ actionable: "", waiting: "" });
  });

  it("puts only items whose resolution is unknown under Waiting, keeping server order", () => {
    const sections = view.renderSections(
      humanEnvelope([
        item(5, {
          kind: "orphaned-question",
          explicit: true,
          sourceState: "closed",
          resolution: "unresolved",
        }),
        item(6, {
          kind: "orphaned-question",
          explicit: true,
          sourceState: "closed",
          resolution: "unknown",
        }),
        item(7),
      ]),
      50,
    );
    expect(
      [...sections.actionable.matchAll(/<li><a href="[^"]+\/issues\/(\d+)"/g)].map((m) => m[1]),
    ).toEqual(["5", "7"]);
    expect(sections.actionable).toContain("Ticket closed, unanswered");
    expect(sections.waiting).toContain("Waiting (1)");
    expect(sections.waiting).toContain("Ticket closed, resolution unknown");
    expect(sections.waiting).toContain("issues/6");
  });

  it("bounds the list and says how many were omitted", () => {
    const bounded = humanEnvelope([item(1)], {}, { total: 120, omitted: 119 });
    expect(view.renderSections(bounded, 50).actionable).toContain("119 more item(s) not shown");
    expect(view.renderSections(bounded, 50).actionable).toContain('id="more"');
    expect(view.renderSections(bounded, 100).actionable).toContain("pdb --role human --limit N");
  });

  it("escapes source text and links only GitHub URLs", () => {
    const sections = view.renderSections(
      humanEnvelope([
        item(8, {
          title: '<img src=x onerror="alert(1)">',
          reason: "<script>x</script>",
          requested: ["1. <b>why</b>?"],
          routedTo: ['"><svg>'],
          source: "javascript:alert(1)",
          blocks: {
            subjects: ["https://evil.example/x"],
            unknown: ["direct dependents not fully collected"],
          },
          warnings: ["<i>gap</i>"],
        }),
      ]),
      50,
    );
    expect(sections.actionable).not.toMatch(/<img|<script|<svg|<b>|<i>|javascript:|evil\.example"/);
    expect(sections.actionable).toContain("&lt;img src=x");
    expect(sections.actionable).toContain("direct dependents not fully collected");
    expect(sections.actionable).toContain('href="/ticket?repo=example%2Fparity&amp;n=8"');
  });

  it("rejects an answer for another project", () => {
    expect(view.matches(humanEnvelope([]), "Example/Parity")).toBe(true);
    expect(
      view.matches(humanEnvelope([], { selection: { repository: "example/other" } }), repo),
    ).toBe(false);
  });
});

describe("human attention browser script (#458)", () => {
  function fakeBrowser(search: string, dataRepo: string | undefined) {
    const listeners = new Map<string, (event?: unknown) => void>();
    const element = (id: string) => ({
      id,
      value: "",
      innerHTML: "",
      dataset: id === "content" && dataRepo ? { repo: dataRepo } : {},
      classList: { add() {}, remove() {} },
      addEventListener(type: string, fn: (event?: unknown) => void) {
        listeners.set(`${id}:${type}`, fn);
      },
    });
    const elements = new Map(
      [
        "content",
        "agent",
        "state",
        "notices",
        "actionable",
        "waiting",
        "coverage",
        "selection",
        "refresh",
      ].map((id) => [id, element(id)]),
    );
    elements.get("agent")!.value = new URLSearchParams(search).get("agent") ?? "";
    const fetched: { path: string; method: string; signal: AbortSignal }[] = [];
    const pending: ((body: unknown) => void)[] = [];
    const pushed: string[] = [];
    const sandbox = {
      document: { getElementById: (id: string) => elements.get(id) ?? null },
      location: { search },
      history: { pushState: (_s: unknown, _t: string, to: string) => void pushed.push(to) },
      addEventListener: (type: string, fn: () => void) => listeners.set(`window:${type}`, fn),
      URLSearchParams,
      AbortController,
      fetch: (path: string, init: { method?: string; signal: AbortSignal }) => {
        fetched.push({ path, method: init.method ?? "GET", signal: init.signal });
        return new Promise((done) => pending.push((body) => done({ json: async () => body })));
      },
    };
    return { sandbox, elements, fetched, pending, pushed, listeners };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("reads only the selected project's human briefing, and nothing without a project", async () => {
    const none = fakeBrowser("", undefined);
    runInNewContext(humanScript(), none.sandbox);
    await settle();
    expect(none.fetched).toEqual([]);

    const b = fakeBrowser("?repo=example%2Fparity&agent=owner-name", repo);
    runInNewContext(humanScript(), b.sandbox);
    await settle();
    expect(b.fetched.map((f) => [f.path, f.method])).toEqual([
      ["/api/v1/briefing?repo=example%2Fparity&role=human&limit=50&agent=owner-name", "GET"],
    ]);
    b.pending.shift()!(humanEnvelope([item(2)]));
    await settle();
    expect(b.elements.get("actionable")!.innerHTML).toContain("issues/2");
    // Refresh asks the server to bypass its cache for this one view.
    b.listeners.get("refresh:click")!();
    await settle();
    expect(b.fetched.at(-1)!.path).toContain("refresh=true");
  });

  it("aborts a superseded read and never renders its late answer", async () => {
    const b = fakeBrowser("?repo=example%2Fparity", repo);
    runInNewContext(humanScript(), b.sandbox);
    await settle();
    b.elements.get("agent")!.value = "someone";
    b.listeners.get("selection:submit")!({ preventDefault() {} });
    await settle();
    expect(b.fetched).toHaveLength(2);
    expect(b.fetched[0]!.signal.aborted).toBe(true);
    expect(b.pushed).toEqual(["?repo=example%2Fparity&agent=someone"]);
    b.pending[1]!(humanEnvelope([item(9)]));
    await settle();
    b.pending[0]!(humanEnvelope([item(1)]));
    await settle();
    expect(b.elements.get("actionable")!.innerHTML).toContain("issues/9");
    expect(b.elements.get("actionable")!.innerHTML).not.toContain('issues/1"');
  });

  it("shows another project's answer as an error, and restores the name on back", async () => {
    const b = fakeBrowser("?repo=example%2Fparity", repo);
    runInNewContext(humanScript(), b.sandbox);
    await settle();
    b.pending.shift()!(humanEnvelope([item(3)], { selection: { repository: "example/other" } }));
    await settle();
    expect(b.elements.get("state")!.innerHTML).toContain("SELECTION_MISMATCH");
    expect(b.elements.get("actionable")!.innerHTML).toBe("");
    b.sandbox.location.search = "?repo=example%2Fparity&agent=back-name";
    b.listeners.get("window:popstate")!();
    await settle();
    expect(b.elements.get("agent")!.value).toBe("back-name");
    expect(b.fetched.at(-1)!.path).toContain("agent=back-name");
  });
});
