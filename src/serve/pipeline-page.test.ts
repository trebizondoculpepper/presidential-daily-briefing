/**
 * Pipeline health: current stage inventory (#684). The page route states, the renderers over a
 * synthetic `pipeline-metrics` inventory envelope, and the standalone browser script. Injected
 * data only; no test touches GitHub.
 */
import { describe, expect, it } from "vite-plus/test";
import { dashboardRenderers } from "./dashboard.js";
import { HttpFailure } from "./http.js";
import { pipelinePage, pipelineRenderers, pipelineScript } from "./pipeline-page.js";
import { pageById } from "./shell.js";

const repo = "o/r";
const served = [{ repository: repo }];
const select = (list: readonly { repository: string }[], wanted: string | undefined) => {
  const found = list.find((s) => s.repository === wanted);
  if (!found) throw new HttpFailure(404, "REPOSITORY_NOT_SERVED", "not served", []);
  return found;
};
const hours = (n: number) => n * 3_600_000;
const stage = (members: string[], age: Partial<Record<string, unknown>> = {}) => ({
  count: members.length,
  members,
  age: {
    medianMs: null,
    oldestMs: null,
    knownCount: 0,
    unknownCount: 0,
    unknownMembers: [],
    ...age,
  },
});
const envelope = (stages: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "serve-read",
  status: "complete",
  selection: { repository: repo },
  warnings: [],
  error: null,
  result: {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "inventory",
    observedAt: "2026-11-19T10:00:00.000Z",
    coverage: { historyCompleteFrom: null, note: null },
    stateUnknown: { count: 0, members: [] },
    stages: {
      unassessed: stage([]),
      ready: stage([]),
      blocked: stage([]),
      claimed: stage([]),
      "in-review": stage([]),
      unknown: stage([]),
      ...stages,
    },
    ...extra,
  },
});
const view = pipelineRenderers(dashboardRenderers());

describe("pipeline page route (#684)", () => {
  it("is a registered project page taking only repo", () => {
    expect(pageById("pipeline")).toMatchObject({ path: "/pipeline", scope: "project" });
    expect(pageById("pipeline").parameters).toEqual(["repo"]);
  });
  it("never resolves a missing project, and refuses unknown parameters or unserved repos", () => {
    const none = pipelinePage(new URLSearchParams(), served, select);
    expect(none.status).toBe(200);
    expect(none.html).toContain("No project selected");
    expect(none.html).not.toContain("data-repo");
    expect(pipelinePage(new URLSearchParams({ view: "daily" }), served, select).status).toBe(400);
    expect(
      pipelinePage(
        new URLSearchParams([
          ["repo", repo],
          ["repo", repo],
        ]),
        served,
        select,
      ).status,
    ).toBe(400);
    const unserved = pipelinePage(new URLSearchParams({ repo: "x/y" }), served, select);
    expect(unserved.status).toBe(404);
    expect(unserved.html).toContain("not served by this server");
  });
  it("renders the shell for a served project with the script and no inline data", () => {
    const page = pipelinePage(new URLSearchParams({ repo }), served, select);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`data-repo="${repo}"`);
    expect(page.html).toContain('src="/pipeline.js"');
    expect(page.html).toContain('id="refresh"');
    expect(page.html).not.toMatch(/<script>(?!<\/script>)/);
  });
});

describe("pipeline inventory renderers (#684)", () => {
  it("reads the inventory view of the metrics API, refreshing only on request", () => {
    expect(view.metricsUrl({ repo })).toBe("/api/v1/metrics?repo=o%2Fr&view=inventory");
    expect(view.metricsUrl({ repo, refresh: true })).toContain("refresh=true");
  });
  it("shows ready, blocked and agent-claimed counts with typical and oldest ages", () => {
    const html = view.renderInventory(
      envelope({
        ready: stage(["o/r#1", "o/r#2"], {
          medianMs: hours(30),
          oldestMs: hours(24 * 9),
          knownCount: 2,
        }),
        blocked: stage(["o/r#3"], { unknownCount: 1, unknownMembers: ["o/r#3"] }),
        claimed: stage(["o/r#4"], { medianMs: hours(0.5), oldestMs: hours(0.5), knownCount: 1 }),
      }),
      repo,
    );
    expect(html).toContain("Current inventory (now)");
    expect(html).toMatch(/Ready<\/th><td>2<\/td><td>30 hours<\/td><td>9 days<\/td><td>0<\/td>/);
    // Unknown age is counted and shown as unknown, never as zero or dropped.
    expect(html).toMatch(/Blocked<\/th><td>1<\/td><td>unknown<\/td><td>unknown<\/td><td>1<\/td>/);
    expect(html).toMatch(/Agent-claimed<\/th><td>1<\/td><td>under 1 hour<\/td>/);
    // Drill-down members link to the ticket page for this project only.
    expect(html).toContain('href="/ticket?repo=o%2Fr&amp;n=1"');
    // Overlapping axes are explained, never presented as a conserved flow.
    expect(html).toContain("not a flow");
    expect(html).toContain("can also be blocked");
  });
  it("bounds each drill-down and counts the omitted members", () => {
    const members = Array.from({ length: 60 }, (_, i) => `o/r#${i + 1}`);
    const html = view.renderInventory(envelope({ ready: stage(members) }), repo);
    expect(html).toContain("60 tickets");
    expect(html).toContain("and 10 more");
    expect(html).toContain("n=50");
    expect(html).not.toContain('n=51"');
  });
  it("keeps unknown stage and state visible, and links nothing foreign or unsafe", () => {
    const html = view.renderInventory(
      envelope(
        {
          ready: stage(["other/repo#9", "<img src=x onerror=alert(1)>"]),
          unknown: stage(["o/r#7"]),
        },
        { stateUnknown: { count: 2, members: [] } },
      ),
      repo,
    );
    expect(html).toContain("1 open ticket(s) have a stage that could not be established");
    expect(html).toContain("2 ticket(s) have an unknown open/closed state");
    expect(html).not.toContain("/ticket?repo=other");
    expect(html).not.toContain("<img");
  });
  it("renders nothing old for an error or another view, and reports coverage limits", () => {
    expect(view.renderInventory({ status: "error", error: { code: "X" } }, repo)).toBe("");
    expect(view.renderInventory(envelope({}, { view: "daily" }), repo)).toBe("");
    const coverage = view.renderCoverage({
      ...envelope({}, { limitations: ["history capped"] }),
      warnings: ["partial read"],
    });
    expect(coverage).toContain("partial read");
    expect(coverage).toContain("history capped");
    expect(view.matches(envelope({}), "O/R")).toBe(true);
    expect(view.matches(envelope({}), "x/y")).toBe(false);
  });
});

describe("pipeline script (#684)", () => {
  it("is standalone, parseable JavaScript with no polling", () => {
    const script = pipelineScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/setInterval|setTimeout\(/);
  });
});
