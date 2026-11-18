import { describe, expect, it } from "vite-plus/test";
import type { EstimateState } from "../estimation/estimation.js";
import type { AssessmentGroup, AssessmentGroups } from "./assessment.js";
import type { AssessmentEndpoints, TicketLedger } from "./ledger.js";
import { assessmentQueueView } from "./assessmentqueue.js";
import type { AssessmentQueueTicket } from "./assessmentqueue.js";

const DAY_MS = 86_400_000;

function endpoints(overrides: Partial<AssessmentEndpoints> = {}): AssessmentEndpoints {
  return {
    first: { status: "none" },
    revisions: { known: true, value: 0 },
    records: [],
    ignored: [],
    unresolved: [],
    ...overrides,
  };
}

function ledger(overrides: Partial<TicketLedger> = {}): TicketLedger {
  return {
    schemaVersion: 1,
    repository: "o/r",
    number: 1,
    observedAt: "2026-06-10T12:00:00.000Z",
    events: [
      { at: "2026-06-08T12:00:00.000Z", key: "created:1", kind: "created", source: "issue" },
    ],
    firstPickup: {
      "claim-marker": { status: "none" },
      label: { status: "none" },
    },
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
      complexity: endpoints(),
      impact: endpoints(),
    },
    ...overrides,
  };
}

function groupEntry(basis: AssessmentGroup["basis"], state: EstimateState): AssessmentGroup {
  return {
    basis,
    state,
    group: state === "unestimated" ? "unassessed" : state === "conflicting" ? "conflict" : state,
    size: null,
    provenance: null,
    authority: "none",
    reasons: [],
  };
}

function ticket(
  member: string,
  state: { complexity?: EstimateState; impact?: EstimateState },
  ledgerOverrides: Partial<TicketLedger> = {},
): AssessmentQueueTicket {
  const c: EstimateState = state.complexity ?? "unestimated";
  const i: EstimateState = state.impact ?? "unestimated";
  const assessment: AssessmentGroups = {
    complexity: groupEntry("current-valid-complexity", c),
    impact: groupEntry("current-valid-impact", i),
  };
  return {
    member,
    ledger: ledger(ledgerOverrides),
    assessment,
  };
}

describe("assessmentQueueView", () => {
  const now = "2026-06-10T12:00:00.000Z";
  const coverage = { completeFrom: "2026-06-01T00:00:00.000Z" };

  it("reports open unassessed ages, non-valid states, latency, revisions, and daily incoming vs first-assessed", () => {
    const tickets: AssessmentQueueTicket[] = [
      // Open unassessed #1: created 2 days ago
      ticket("o/r#1", { complexity: "unestimated", impact: "unestimated" }),
      // Open unassessed #2: created 4 days ago
      ticket(
        "o/r#2",
        { complexity: "unestimated", impact: "stale" },
        {
          events: [
            { at: "2026-06-06T12:00:00.000Z", key: "created:2", kind: "created", source: "issue" },
          ],
        },
      ),
      // Open stale / conflicting / unknown
      ticket("o/r#3", { complexity: "stale", impact: "conflicting" }),
      ticket("o/r#4", { complexity: "unknown", impact: "unknown" }),
      // Assessed in window: created 2026-06-08T12:00Z, first assessed 2026-06-09T12:00Z (1 day latency), 1 revision
      ticket(
        "o/r#5",
        { complexity: "estimated", impact: "estimated" },
        {
          events: [
            { at: "2026-06-08T12:00:00.000Z", key: "created:5", kind: "created", source: "issue" },
          ],
          assessments: {
            complexity: endpoints({
              first: {
                status: "found",
                at: "2026-06-09T12:00:00.000Z",
                key: "comment:10",
                size: "M",
                previous: [],
                recordedAt: "2026-06-09T12:00:00.000Z",
              },
              revisions: { known: true, value: 1 },
              records: [
                {
                  at: "2026-06-09T12:00:00.000Z",
                  key: "comment:10",
                  size: "M",
                  previous: [],
                  recordedAt: null,
                },
                {
                  at: "2026-06-09T18:00:00.000Z",
                  key: "comment:11",
                  size: "L",
                  previous: ["M"],
                  recordedAt: null,
                },
              ],
            }),
            impact: endpoints({
              first: {
                status: "found",
                at: "2026-06-09T12:00:00.000Z",
                key: "comment:12",
                size: "high",
                previous: [],
                recordedAt: null,
              },
            }),
          },
        },
      ),
      // Closed unassessed in window: not in open queue, counted in closedUndelivered
      ticket(
        "o/r#6",
        { complexity: "unestimated", impact: "unestimated" },
        {
          currentState: "closed",
          stateReason: "NOT_PLANNED",
          events: [
            { at: "2026-06-08T12:00:00.000Z", key: "created:6", kind: "created", source: "issue" },
            {
              at: "2026-06-09T12:00:00.000Z",
              kind: "closed",
              source: "issue",
              reason: "NOT_PLANNED",
              key: "close:6",
            },
          ],
        },
      ),
    ];

    const res = assessmentQueueView(now, 7, tickets, coverage);
    expect(res.view).toBe("assessment-queue");

    const cx = res.metrics.complexity;
    expect(cx.unassessed.count).toBe(2);
    expect(cx.unassessed.members).toEqual(["o/r#1", "o/r#2"]);
    expect(cx.unassessed.medianAgeMs).toBe(3 * DAY_MS);
    expect(cx.unassessed.oldestAgeMs).toBe(4 * DAY_MS);
    expect(cx.unassessed.unknownAges).toBe(0);

    expect(cx.states.stale.members).toEqual(["o/r#3"]);
    expect(cx.states.unknown.members).toEqual(["o/r#4"]);
    expect(cx.states.conflict.count).toBe(0);

    expect(cx.firstAssessmentLatency.completed).toBe(1);
    expect(cx.firstAssessmentLatency.median).toBe(DAY_MS);
    expect(cx.firstAssessmentLatency.open.count).toBe(4);
    expect(cx.firstAssessmentLatency.closedUndelivered).toBe(1);

    expect(cx.revisions.total).toBe(1);
    expect(cx.revisions.inWindow).toBe(1);
    expect(cx.revisions.lowerBound).toBe(false);

    const day08Incoming = cx.volume.incoming.series.days.find((d) => d.day === "2026-06-08");
    const day09Assessed = cx.volume.firstAssessed.series.days.find((d) => d.day === "2026-06-09");
    expect(day08Incoming).toMatchObject({ status: "known", count: 5 });
    expect(day09Assessed).toMatchObject({ status: "known", count: 1 });

    const im = res.metrics.impact;
    expect(im.states.stale.members).toEqual(["o/r#2"]);
    expect(im.states.conflict.members).toEqual(["o/r#3"]);
    expect(im.states.unknown.members).toEqual(["o/r#4"]);
  });

  it("marks unknown ages, unknown endpoints, and incomplete revisions as lower bounds", () => {
    const tickets: AssessmentQueueTicket[] = [
      ticket(
        "o/r#10",
        { complexity: "unestimated", impact: "unknown" },
        {
          events: [],
          assessments: {
            complexity: endpoints({
              first: { status: "unknown", reason: "comments truncated", observed: null },
              revisions: { known: false, reason: "comments truncated", observed: 2 },
            }),
            impact: endpoints(),
          },
        },
      ),
    ];

    const res = assessmentQueueView(now, 7, tickets, coverage, ["o/r#99"]);
    const cx = res.metrics.complexity;
    expect(cx.unassessed.count).toBe(1);
    expect(cx.unassessed.unknownAges).toBe(1);
    expect(cx.unassessed.medianAgeMs).toBeNull();
    expect(cx.revisions.total).toBe(2);
    expect(cx.revisions.lowerBound).toBe(true);
    expect(cx.revisions.unknown.members).toEqual(["o/r#99", "o/r#10"]);
    expect(cx.volume.incoming.lowerBound).toBe(true);
    expect(cx.volume.firstAssessed.lowerBound).toBe(true);
  });
});
