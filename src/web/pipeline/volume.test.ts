/**
 * Pipeline Health assessment pace (#687): daily new tickets beside first impact and complexity
 * assessments from the real `assessmentQueueView`; unknown days stay unknown, reassessments are
 * events not tickets, and the two metrics are never added together. No server or GitHub.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { assessmentQueueView } from "../../metrics/assessmentqueue.js";
import type { AssessmentQueueTicket } from "../../metrics/assessmentqueue.js";
import { parseAssessmentResponse, seriesMembers, volumeAverage, volumeCell } from "./client.js";
import AssessmentVolume from "./AssessmentVolume.svelte";

const now = "2026-11-20T12:00:00.000Z";
const none = () => ({
  first: { status: "none" },
  revisions: { known: true, value: 0 },
  records: [],
  ignored: [],
  unresolved: [],
});
const first = (at: string, key: string, records: { at: string; previous: string[] }[] = []) => ({
  first: { status: "found", at, key, size: "M", previous: [], recordedAt: null },
  revisions: { known: true, value: records.filter((r) => r.previous.length).length },
  records: [
    { at, key, size: "M", previous: [], recordedAt: null },
    ...records.map((r, i) => ({
      at: r.at,
      key: `${key}-${i}`,
      size: "L",
      previous: r.previous,
      recordedAt: null,
    })),
  ],
  ignored: [],
  unresolved: [],
});
const ticket = (
  n: number,
  created: string,
  assessments: { complexity?: unknown; impact?: unknown },
): AssessmentQueueTicket => ({
  member: `o/r#${n}`,
  ledger: {
    schemaVersion: 1,
    repository: "o/r",
    number: n,
    observedAt: now,
    events: [{ at: created, key: `created:${n}`, kind: "created", source: "issue" }],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    requeues: { known: true, value: 0 },
    reopens: { known: true, value: 0 },
    membership: null,
    requiredPullRequests: null,
    requiredOtherMembers: null,
    currentState: "open",
    stateReason: null,
    coverage: {
      comments: "complete",
      timeline: "complete",
      deliveryRecords: "complete",
      prs: "complete",
    },
    omissions: [],
    ignored: [],
    assessments: {
      complexity: assessments.complexity ?? none(),
      impact: assessments.impact ?? none(),
    },
  } as never,
  assessment: {
    complexity: {
      basis: "current-valid-complexity",
      state: "estimated",
      group: "M",
      size: "M",
      provenance: null,
      authority: "none",
      reasons: [],
    },
    impact: {
      basis: "current-valid-impact",
      state: "estimated",
      group: "M",
      size: "M",
      provenance: null,
      authority: "none",
      reasons: [],
    },
  } as never,
});
const envelope = (tickets: AssessmentQueueTicket[], completeFrom: string) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "metrics",
  status: "complete",
  selection: { repository: "o/r" },
  warnings: [],
  freshness: null,
  error: null,
  result: assessmentQueueView(now, 7, tickets, { completeFrom }),
});
const html = (body: unknown) =>
  render(AssessmentVolume, { props: { response: parseAssessmentResponse(body)! } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><");
const row = (out: string, day: string) =>
  [
    ...new RegExp(`<th scope="row"><time datetime="${day}">${day}</time></th>((?:<td>[^<]*</td>)+)`)
      .exec(out)![1]!
      .matchAll(/<td>([^<]*)<\/td>/g),
  ].map((m) => m[1]);

describe("assessment pace (#687)", () => {
  const tickets = [
    // Created on the 18th, first complexity assessment on the 19th, then one reassessment.
    ticket(1, "2026-11-18T09:00:00.000Z", {
      complexity: first("2026-11-19T10:00:00.000Z", "c1", [
        { at: "2026-11-19T15:00:00.000Z", previous: ["M"] },
      ]),
    }),
    // Created and first impact-assessed on the 19th.
    ticket(2, "2026-11-19T08:00:00.000Z", { impact: first("2026-11-19T11:00:00.000Z", "i2") }),
    // Created today: the partial day.
    ticket(3, "2026-11-20T08:00:00.000Z", {}),
  ];

  it("shows new tickets beside first assessments per day, with today's partial row", () => {
    const out = html(envelope(tickets, "2026-11-01T00:00:00.000Z"));
    // New tickets, first impact, first complexity.
    expect(row(out, "2026-11-18")).toEqual(["1", "0", "0"]);
    expect(row(out, "2026-11-19")).toEqual(["1", "1", "1"]);
    // Today's partial row states its UTC cutoff (#1144 review).
    expect(out).toMatch(
      /2026-11-20<\/time> so far \(through <time datetime="2026-11-20T12:00:00\.000Z">2026-11-20T12:00:00\.000Z<\/time>\)<\/th><td>1<\/td><td>0<\/td><td>0<\/td>/,
    );
    // Reassessments are events, reported apart from the ticket columns.
    expect(out).toContain("Reassessments in this window");
    expect(out).toMatch(/impact 0, complexity 1\./);
    expect(out).toContain("the two metrics are not added together");
    // Each series links its tickets.
    expect(out).toContain(
      "<summary>First complexity assessments: 1 ticket in this window</summary>",
    );
    expect(out).toContain('<a href="/ticket?repo=o%2Fr&amp;n=1">o/r#1</a>');
  });

  it("keeps days before complete history unknown, and averages over known days only", () => {
    const out = html(envelope(tickets, "2026-11-17T00:00:00.000Z"));
    expect(row(out, "2026-11-16")).toEqual([
      "unknown (0 seen)",
      "unknown (0 seen)",
      "unknown (0 seen)",
    ]);
    expect(row(out, "2026-11-18")).toEqual(["1", "0", "0"]);
    expect(out).toContain("events before 2026-11-17T00:00:00.000Z may be missing");
    // The average states the days it rests on (#1144 review).
    expect(out).toContain("Average per known day</th><td>0.7 (3 known, 4 unknown days)</td>");
  });

  it("refuses a result whose volume series is malformed", () => {
    const body = envelope(tickets, "2026-11-01T00:00:00.000Z");
    (body.result.metrics.impact.volume.incoming.series as { days: unknown }).days = [{ day: "x" }];
    expect(parseAssessmentResponse(body)).toBeNull();
  });

  it("keeps the figure logic in typed helpers and validates the window length (#1144 review)", () => {
    const body = envelope(tickets, "2026-11-17T00:00:00.000Z");
    const figure = body.result.metrics.complexity.volume.firstAssessed;
    expect(volumeCell(figure, "2026-11-19")).toBe("1");
    expect(volumeCell(figure, "2026-11-16")).toBe("unknown (0 seen)");
    expect(volumeCell(figure, "1999-01-01")).toBe("—");
    expect(volumeAverage(figure)).toMatch(/^0\.3 \(3 known, 4 unknown days\)$/);
    expect(seriesMembers(figure)).toEqual(["o/r#1"]);
    for (const days of [undefined, "7", 0, 2.5]) {
      const bad = envelope(tickets, "2026-11-01T00:00:00.000Z");
      (bad.result as { days: unknown }).days = days;
      expect(parseAssessmentResponse(bad), String(days)).toBeNull();
    }
  });
});
