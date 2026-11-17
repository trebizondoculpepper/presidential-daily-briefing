/**
 * Read-only Activity/Agents view (#456): the page route, window filtering by evidenced activity,
 * renderers over the shared team envelope, and the standalone browser script. Injected facts
 * only; no test touches GitHub.
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
import { activityRenderers, activityScript } from "./activity-page.js";
import { dashboardRenderers, dashboardSecurityPolicy } from "./dashboard.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";

const repo = "example/parity";
const start = Date.parse("2026-11-12T10:00:00.000Z");
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (n: number, labels: string[], updated: string, title = `Ticket ${n}`): Issue => ({
  number: n,
  title,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: updated,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
const hours = (n: number) => new Date(start - n * 3_600_000).toISOString();
/** One active agent (recent), one stale agent (outside any window), one unclaimed ticket. */
const issues = (): Issue[] => [
  issue(1, ["agent:alpha", "status:ready"], hours(2), "Alpha work"),
  issue(2, ["agent:beta", "status:ready"], hours(200), "Beta stale work"),
  issue(3, ["status:ready"], hours(1)),
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
const view = activityRenderers(base);

/** A team `serve-read` envelope shaped like `/api/v1/team`'s result. */
const teamEnvelope = (
  agents: unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "team",
  status: "complete",
  selection: { repository: repo, agent: null, triageRole: null, identityDiagnostic: null },
  freshness: {
    source: "live",
    observedAt: new Date(start).toISOString(),
    ageSeconds: 0,
    ttlSeconds: 300,
    stale: false,
    refreshError: null,
  },
  ...over,
  result: {
    schemaVersion: 1,
    kind: "team-view",
    repository: repo,
    fetchedAt: new Date(start).toISOString(),
    freshness: {},
    staleHours: 24,
    presence: "unknown",
    agents,
    conflicts: [],
    completeness: { complete: true, warnings: [] },
    guidance: "",
    ...(over.result as Record<string, unknown> | undefined),
  },
});

const agent = (name: string, claims: unknown[], extra: Record<string, unknown> = {}) => ({
  agent: name,
  presence: "unknown",
  claims,
  warnings: [],
  ...extra,
});
const claim = (n: number, at: string | null, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Ticket ${n}`,
  url: url(n),
  coOwners: [],
  pullRequests: [],
  latestActivity: at ? { at, source: "ticket updated" } : null,
  candidates: [],
  activity: null,
  ...extra,
});

describe("activity page route (#456)", () => {
  it("renders the shell for a served project with the dashboard CSP and no GitHub read", async () => {
    const s = await setup();
    try {
      const reply = await get(
        s.running.port,
        `/activity?repo=${encodeURIComponent(repo)}&window=3`,
      );
      expect(reply.status).toBe(200);
      expect(reply.headers["content-security-policy"]).toBe(dashboardSecurityPolicy);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).toContain(`data-repo="${repo}"`);
      expect(reply.body).toContain('<script src="/activity.js" defer></script>');
      // Activity is a Work-section page: the Work entry carries the current-page marker.
      expect(reply.body).toContain('aria-current="page">Work</a>');
      expect(reply.body).not.toContain('aria-current="page">Activity</a>');
      expect(reply.body).toContain('value="3" selected');
      expect(reply.body).not.toMatch(/<script>|<style|style=/);
      const script = await get(s.running.port, "/activity.js");
      expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(script.body).toBe(activityScript());
      // Rendering the page (and its script) reads nothing from GitHub.
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("defaults the window to one day when the parameter is omitted", async () => {
    const s = await setup();
    try {
      const reply = await get(s.running.port, `/activity?repo=${encodeURIComponent(repo)}`);
      expect(reply.status).toBe(200);
      expect(reply.body).toContain('value="1" selected');
      const empty = await get(s.running.port, "/activity");
      expect(empty.status).toBe(200);
      expect(empty.body).toContain("No project selected");
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("refuses malformed parameters without a GitHub read", async () => {
    const s = await setup();
    try {
      for (const path of [
        "/activity?repo=example%2Fparity&window=0",
        "/activity?repo=example%2Fparity&window=8",
        "/activity?repo=example%2Fparity&window=abc",
        "/activity?repo=example%2Fparity&extra=1",
        "/activity?repo=example%2Fparity&window=1&window=2",
      ]) {
        const reply = await get(s.running.port, path);
        expect(reply.status).toBe(400);
        expect(reply.body).toContain("error");
      }
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });

  it("shows a choice when no project is selected, never a guess", async () => {
    const s = await setup();
    try {
      const reply = await get(s.running.port, "/activity?window=1");
      expect(reply.status).toBe(200);
      expect(reply.body).toContain("No project selected");
      expect(s.collected).toEqual([]);
    } finally {
      await s.running.close();
    }
  });
});

describe("activity renderers (#456)", () => {
  it("lists only agents with evidenced activity in the window, in server order", () => {
    const html = view.renderAgents(
      teamEnvelope([
        // alpha has an attributed responsibility timestamp in the window; beta only has a claim
        // with an unattributed timestamp, so it is undetermined, never silently dropped;
        // `unlisted` has nothing at all and is not listed.
        agent(
          "alpha",
          [
            claim(1, hours(2), {
              title: "Alpha work",
            }),
          ],
          {
            responsibilities: [
              {
                number: 1,
                url: url(1),
                scope: "ticket",
                deliverable: null,
                delivery: "delivered",
                followUp: "none",
                since: hours(2),
              },
            ],
          },
        ),
        agent("beta", [claim(2, hours(200), { title: "Beta stale work" })]),
        agent("unlisted", []),
      ]),
    );
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).not.toContain("unlisted");
    expect(html).toContain("Participation cannot be determined");
    expect(html).toContain("#1 Alpha work");
  });

  it("separates claimed work from submitted responsibility and shows activity", () => {
    const html = view.renderAgents(
      teamEnvelope([
        agent("alpha", [
          claim(1, hours(2), {
            pullRequests: [
              {
                number: 9,
                url: `https://github.com/${repo}/pull/9`,
                draft: false,
                reviewDecision: "APPROVED",
                unresolvedThreads: 0,
                mergeState: "CLEAN",
                updatedAt: hours(1),
              },
            ],
            activity: { state: "waiting", reason: "needs review" },
          }),
        ]),
      ]),
    );
    expect(html).toContain("PR #9");
    expect(html).toContain("APPROVED");
    expect(html).toContain("waiting: needs review");
    expect(html).toContain("Latest:");
    // Linked PRs are labelled as linked, not as this claimant's responsibility (the canonical
    // responsibility inventory is the separate group).
    expect(html).toContain("Linked PRs: ");
    expect(html).not.toContain("Submitted responsibilities:");
  });

  it("renders the shared model's continuing responsibilities separately from claims", () => {
    const html = view.renderAgents(
      teamEnvelope(
        [
          agent("alpha", [], {
            responsibilities: [
              {
                number: 10,
                url: url(10),
                scope: "ticket",
                deliverable: null,
                delivery: "delivered",
                followUp: "actionable",
                since: hours(3),
              },
              {
                number: 11,
                url: url(11),
                scope: "deliverable",
                deliverable: "final report",
                delivery: "pending",
                followUp: null,
                since: null,
              },
            ],
          }),
        ],
        {
          result: {
            delivery: {
              tickets: [
                {
                  number: 11,
                  url: url(11),
                  deliverables: [
                    {
                      deliverable: "final report",
                      url: `https://github.com/${repo}/pull/99`,
                      target: `${repo}#99`,
                      state: "open",
                      why: "",
                      responsible: "alpha",
                      followUp: "waiting",
                      followUpWhy: "",
                    },
                  ],
                },
              ],
            },
          },
        },
      ),
    );
    // The responsibilities render even with no remaining claim.
    expect(html).toContain("Continuing responsibility");
    expect(html).toContain("#10 ticket");
    expect(html).toContain("#11 final report");
    // The deliverable links to its actual submitted PR, not only the ticket.
    expect(html).toContain(`href="https://github.com/${repo}/pull/99"`);
    expect(html).toContain("follow-up: actionable");
    // The no-follow-up deliverable renders without a follow-up clause.
    expect(html.match(/follow-up:/g)).toHaveLength(1);
  });

  it("lists deliverable-only agents whose participation cannot be determined, with the gap", () => {
    // A responsibility with no event timestamp (deliverable scope carries since: null and no
    // latestActivity in the shared inventory) cannot prove participation, but dropping the
    // agent would present a fake all-clear: it is listed with a note and the coverage gap is
    // reported.
    const html = view.renderAgents(
      teamEnvelope([
        agent("gamma", [], {
          responsibilities: [
            {
              number: 20,
              url: url(20),
              scope: "deliverable",
              deliverable: "audit",
              delivery: "pending",
              followUp: "waiting",
              since: null,
            },
          ],
        }),
      ]),
    );
    expect(html).toContain("gamma");
    expect(html).toContain("Continuing responsibility");
    expect(html).toContain("Participation cannot be determined");
    const coverage = view.renderCoverage(
      teamEnvelope([
        agent("gamma", [], {
          responsibilities: [
            {
              number: 20,
              url: url(20),
              scope: "deliverable",
              deliverable: "audit",
              delivery: "pending",
              followUp: "waiting",
              since: null,
            },
          ],
        }),
      ]),
    );
    expect(coverage).toContain("1 of 1 agent(s) hold recorded work");
    expect(coverage).toContain("Participation cannot be determined");
  });

  it("escapes agent, title and warning text and links only GitHub URLs", () => {
    const html = view.renderAgents(
      teamEnvelope([
        agent('<img src=x onerror="alert(1)">', [
          claim(8, hours(2), { title: "<script>x</script>" }),
        ]),
      ]),
    );
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    const hostile = view.renderAgents(
      teamEnvelope([agent("a", [claim(8, hours(2), { url: "javascript:alert(1)" })])]),
    );
    expect(hostile).not.toContain('href="javascript');
  });

  it("says no agent fits only when none has activity; an error renders no list", () => {
    // A claim with neither attributed state nor an attributed since is undetermined, so it is
    // listed with the note; an agent with nothing at all is not listed.
    const undetermined = view.renderAgents(teamEnvelope([agent("beta", [claim(2, hours(200))])]));
    expect(undetermined).toContain("Participation cannot be determined");
    const none = view.renderAgents(teamEnvelope([agent("gamma", [])]));
    expect(none).toContain("No agent holds recorded claims or responsibilities");
    expect(view.renderAgents({ status: "error" })).toBe("");
  });

  it("rejects an answer for another project and reports coverage", () => {
    expect(view.matches(teamEnvelope([]), "Example/Parity")).toBe(true);
    expect(
      view.matches(teamEnvelope([], { selection: { repository: "example/other" } }), repo),
    ).toBe(false);
    expect(view.renderCoverage(teamEnvelope([]))).toContain("0 of 0 agent(s)");
    const coverage = view.renderCoverage(
      teamEnvelope([
        agent("alpha", [claim(1, hours(2))], {
          responsibilities: [
            {
              number: 1,
              url: url(1),
              scope: "ticket",
              deliverable: null,
              delivery: "delivered",
              followUp: "none",
              since: hours(2),
            },
          ],
        }),
        agent("beta", [claim(2, hours(200))]),
      ]),
    );
    expect(coverage).toContain("2 of 2 agent(s) hold recorded work");
    expect(coverage).toContain("Participation cannot be determined");
    expect(coverage).toContain("Coverage complete.");
  });
});

describe("activity browser script (#456)", () => {
  function fakeBrowser(dataRepo: string | undefined, windowValue: string) {
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
      ["content", "window", "state", "notices", "agents", "coverage", "selection", "refresh"].map(
        (id) => [id, element(id)],
      ),
    );
    elements.get("window")!.value = windowValue;
    const fetched: { path: string; signal: AbortSignal }[] = [];
    const pending: ((body: unknown) => void)[] = [];
    const pushed: string[] = [];
    const location = { search: "" };
    const sandbox = {
      document: { getElementById: (id: string) => elements.get(id) ?? null },
      location,
      history: {
        pushState: (_s: unknown, _t: string, to: string) => void pushed.push(to),
        replaceState: (_s: unknown, _t: string, to: string) => void pushed.push(to),
      },
      addEventListener: (type: string, fn: () => void) => listeners.set(`window:${type}`, fn),
      Date: class extends Date {
        static override now() {
          return start;
        }
      },
      URLSearchParams,
      AbortController,
      fetch: (path: string, init: { signal: AbortSignal }) => {
        fetched.push({ path, signal: init.signal });
        return new Promise((done) => pending.push((body) => done({ json: async () => body })));
      },
    };
    return { sandbox, elements, fetched, pending, pushed, listeners, location };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("fetches the team read once for the page's project and renders agents", async () => {
    const b = fakeBrowser(repo, "2");
    runInNewContext(activityScript(), b.sandbox);
    await settle();
    expect(b.fetched).toHaveLength(1);
    expect(b.fetched[0]!.path).toContain("/api/v1/team?repo=example%2Fparity&staleHours=48");
    b.pending[0]!(
      teamEnvelope([
        agent("alpha", [claim(1, hours(2))], {
          responsibilities: [
            {
              number: 1,
              url: url(1),
              scope: "ticket",
              deliverable: null,
              delivery: "delivered",
              followUp: "none",
              since: hours(2),
            },
          ],
        }),
        agent("beta", [claim(2, hours(200))]),
      ]),
    );
    await settle();
    expect(b.elements.get("agents")!.innerHTML).toContain("alpha");
    // beta is undetermined (no attributed evidence), so it is listed with the note.
    expect(b.elements.get("agents")!.innerHTML).toContain("beta");
    expect(b.elements.get("agents")!.innerHTML).toContain("Participation cannot be determined");
    expect(b.elements.get("coverage")!.innerHTML).toContain("2 of 2 agent(s) hold recorded work");
  });

  it("drops an answer for another project and aborts a superseded read", async () => {
    const b = fakeBrowser(repo, "1");
    runInNewContext(activityScript(), b.sandbox);
    await settle();
    b.pending[0]!(teamEnvelope([], { selection: { repository: "example/other" } }));
    await settle();
    expect(b.elements.get("agents")!.innerHTML).not.toContain("alpha");
  });

  it("restores the window from the URL on history navigation", async () => {
    const b = fakeBrowser(repo, "7");
    runInNewContext(activityScript(), b.sandbox);
    await settle();
    // Change the URL to a window the select does not currently show, then go Back.
    b.location.search = "?repo=example%2Fparity&window=2";
    b.listeners.get("window:popstate")!();
    await settle();
    expect(b.elements.get("window")!.value).toBe("2");
    expect(b.fetched.at(-1)!.path).toContain("staleHours=48"); // 2 days
  });
});
