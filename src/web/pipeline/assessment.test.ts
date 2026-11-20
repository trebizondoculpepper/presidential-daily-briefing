/**
 * Pipeline Health assessment health (#686): impact and complexity kept apart, overlap explained
 * rather than summed, stale/conflict/unknown separate from proven absence, bounded links, and the
 * shared one-collection Refresh. Synthetic results in the server's shape; no server or GitHub.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import {
  assessmentLoader,
  assessmentOverlap,
  inventoryLoader,
  parseAssessmentResponse,
  refreshSections,
  waitingLoader,
} from "./client.js";
import type { AssessmentState as State } from "./client.js";
import AssessmentState from "./AssessmentState.svelte";

const day = 86_400_000;
const bucket = (members: string[]) => ({ count: members.length, members });
const metric = (
  unassessed: string[],
  extra: {
    stale?: string[];
    conflict?: string[];
    unknown?: string[];
    ages?: [number | null, number | null, number];
  } = {},
) => ({
  unassessed: {
    count: unassessed.length,
    medianAgeMs: extra.ages?.[0] ?? null,
    oldestAgeMs: extra.ages?.[1] ?? null,
    unknownAges: extra.ages?.[2] ?? 0,
    members: unassessed,
  },
  states: {
    stale: bucket(extra.stale ?? []),
    conflict: bucket(extra.conflict ?? []),
    unknown: bucket(extra.unknown ?? []),
  },
  stateUnknown: bucket([]),
  firstAssessmentLatency: {},
  revisions: { total: 0, inWindow: 0, unknown: bucket([]), lowerBound: false },
  volume: {},
});
const envelope = (impact: ReturnType<typeof metric>, complexity: ReturnType<typeof metric>) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "metrics",
  status: "complete",
  selection: { repository: "o/r" },
  warnings: [],
  freshness: null,
  error: null,
  result: {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "assessment-queue",
    window: { from: "2026-11-14T00:00:00.000Z", through: "2026-11-20T12:00:00.000Z" },
    coverage: { historyCompleteFrom: "2026-01-01T00:00:00Z", note: null },
    days: 7,
    metrics: { impact, complexity },
  },
});
const html = (state: State) =>
  render(AssessmentState, { props: { state } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><");
const row = (out: string, label: string) =>
  [
    ...new RegExp(`<th scope="row">${label}</th>((?:<td>[^<]*</td>)+)`)
      .exec(out)![1]!
      .matchAll(/<td>([^<]*)<\/td>/g),
  ].map((m) => m[1]);

describe("assessment health (#686)", () => {
  it("counts the overlap once instead of summing the two metrics", () => {
    expect(assessmentOverlap(["o/r#1", "o/r#2"], ["o/r#2", "o/r#3", "o/r#4"])).toEqual({
      impactOnly: 1,
      complexityOnly: 2,
      both: 1,
      issues: 4,
    });
  });

  it("shows each metric separately, with stale/conflict/unknown apart from absence", () => {
    const body = envelope(
      metric(["o/r#1", "o/r#2"], { stale: ["o/r#5"], ages: [2 * day, 9 * day, 0] }),
      metric(["o/r#2", "o/r#3"], { conflict: ["o/r#6"], unknown: ["o/r#7"], ages: [day, day, 1] }),
    );
    const out = html({ status: "ready", response: parseAssessmentResponse(body)! });
    // No assessment, Typical, Oldest, Unknown age, Stale, Conflicting, Unknown.
    expect(row(out, "Impact")).toEqual(["2", "2d", "9d", "0", "1", "0", "0"]);
    expect(row(out, "Complexity")).toEqual(["2", "1d", "1d", "1", "0", "1", "1"]);
    expect(out).toContain("the rows are not added up");
    expect(out).toContain("are counted separately and are not treated as absent");
    expect(out).toContain(
      "3 distinct issues have no assessment for at least one metric: 1 missing both, 1 missing impact only and 1 missing complexity only.",
    );
    expect(out).toContain("<summary>Impact: stale assessment: 1 issue</summary>");
    expect(out).toContain("<summary>Complexity: conflicting assessments: 1 issue</summary>");
    expect(out).toContain('<a href="/ticket?repo=o%2Fr&amp;n=2">o/r#2</a>');
  });

  it("bounds the lists, and refuses a malformed result", () => {
    const many = Array.from({ length: 28 }, (_, i) => `o/r#${i + 1}`);
    const out = html({
      status: "ready",
      response: parseAssessmentResponse(envelope(metric(many), metric([])))!,
    });
    expect((out.match(/<li>/g) ?? []).length).toBe(25);
    expect(out).toContain("3 more not listed.");
    const bad = envelope(metric([]), metric([]));
    (bad.result.metrics as Record<string, unknown>).impact = { unassessed: { count: 1 } };
    expect(parseAssessmentResponse(bad)).toBeNull();
    expect(html({ status: "error", message: "<i>down</i>", code: null })).toContain(
      "&lt;i>down&lt;/i>",
    );
  });

  it("joins the one-collection Refresh with the other sections (shared metrics cache key)", async () => {
    const calls: string[] = [];
    const ok = (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // A complete first read lets the others reuse the cache; their bodies are irrelevant here.
      return new Response(
        JSON.stringify(
          url.includes("view=inventory")
            ? { ...envelope(metric([]), metric([])), result: undefined, status: "complete" }
            : envelope(metric([]), metric([])),
        ),
        { status: 200 },
      );
    };
    const fetcher = (async (input: RequestInfo | URL) => ok(input)) as typeof fetch;
    const sections = [
      inventoryLoader("/api/v1/metrics", fetcher, () => {}),
      waitingLoader("/api/v1/metrics", fetcher, () => {}),
      assessmentLoader("/api/v1/metrics", fetcher, () => {}),
    ];
    for (const s of sections) await s.load("o/r");
    expect(calls.at(-1)).toBe("/api/v1/metrics?view=assessment-queue&repo=o%2Fr");
    calls.length = 0;
    await refreshSections(sections);
    // The (malformed) inventory read is not a stored complete read, so the others refresh too.
    expect(calls).toEqual([
      "/api/v1/metrics?view=inventory&repo=o%2Fr&refresh=true",
      "/api/v1/metrics?view=waiting-impact&repo=o%2Fr&refresh=true",
      "/api/v1/metrics?view=assessment-queue&repo=o%2Fr&refresh=true",
    ]);
  });
});
