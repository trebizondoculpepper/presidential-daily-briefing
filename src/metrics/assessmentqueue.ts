/**
 * Assessment queue and incoming-volume metrics (#888, doc/design/dashboard-pipeline-metrics.md
 * "Assessment queue").
 *
 * Pure over already-collected `MetricTicket` ledgers, `AssessmentGroups`, and coverage: no
 * GitHub access and no clock reads.
 */

import { inWindow } from "../github/changes.js";
import type { EstimateState } from "../estimation/estimation.js";
import { durationStats, median } from "./aggregate.js";
import type { DurationSample, DurationStats } from "./aggregate.js";
import type { AssessmentGroups } from "./assessment.js";
import type { AssessmentEndpoints, TicketLedger } from "./ledger.js";
import { dailyAverage, dailySeries, trailingWindow } from "./windows.js";
import type { DailyAverage, DailySeries, DayCoverage } from "./windows.js";

export type AssessmentMetricName = "complexity" | "impact";

export interface AssessmentQueueTicket {
  member: string;
  ledger: TicketLedger;
  assessment?: AssessmentGroups;
}

export interface AssessmentStateCount {
  count: number;
  members: string[];
}

export interface AssessmentQueueSeriesFigure {
  series: DailySeries;
  average: DailyAverage;
  incomplete: { count: number; members: string[] };
  lowerBound: boolean;
}

export interface AssessmentMetricQueue {
  /** Open tickets with no trusted assessment (`state === "unassessed"`). */
  unassessed: {
    count: number;
    medianAgeMs: number | null;
    oldestAgeMs: number | null;
    unknownAges: number;
    members: string[];
  };
  /** Open tickets whose current assessment is not valid. */
  states: {
    stale: AssessmentStateCount;
    conflict: AssessmentStateCount;
    unknown: AssessmentStateCount;
  };
  /** Open or unknown-state tickets whose state itself could not be verified. */
  stateUnknown: AssessmentStateCount;
  /** Created -> earliest trusted assessment record latency for the window cohort. */
  firstAssessmentLatency: DurationStats;
  /** Trusted assessment records that replaced a prior size (`previous.length > 0`). */
  revisions: {
    total: number;
    inWindow: number;
    unknown: AssessmentStateCount;
    lowerBound: boolean;
  };
  /** Daily incoming (created) vs first-assessed counts; never stacked into one total. */
  volume: {
    incoming: AssessmentQueueSeriesFigure;
    firstAssessed: AssessmentQueueSeriesFigure;
  };
}

export interface AssessmentQueueResult {
  schemaVersion: 1;
  kind: "pipeline-metrics";
  view: "assessment-queue";
  window: { from: string; through: string };
  coverage: { historyCompleteFrom: string | null; note: string | null };
  days: number;
  metrics: Record<AssessmentMetricName, AssessmentMetricQueue>;
}

function createdInstant(ledger: TicketLedger): string | null {
  return ledger.events.find((e) => e.kind === "created")?.at ?? null;
}

function currentClosureAt(ledger: TicketLedger): string | null {
  if (ledger.currentState !== "closed") return null;
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    const e = ledger.events[i]!;
    if (e.kind === "closed") return e.at;
  }
  return null;
}

function noteForCoverage(from: string, coverage: DayCoverage): string | null {
  if (!coverage.completeFrom) return "event history was not read; figures are unknown";
  return Date.parse(coverage.completeFrom) <= Date.parse(from)
    ? null
    : `events before ${coverage.completeFrom} may be missing; earlier days are unknown`;
}

function figureWithGaps(
  events: readonly { at: string; key: string }[],
  window: ReturnType<typeof trailingWindow>,
  coverage: DayCoverage,
  gaps: Set<string>,
): AssessmentQueueSeriesFigure {
  const series = dailySeries(events, window, coverage);
  return {
    series,
    average: dailyAverage(series),
    incomplete: { count: gaps.size, members: [...gaps] },
    lowerBound: gaps.size > 0,
  };
}

function metricQueue(
  metric: AssessmentMetricName,
  nowMs: number,
  trailing: ReturnType<typeof trailingWindow>,
  window: { from: string; through: string },
  tickets: readonly AssessmentQueueTicket[],
  coverage: DayCoverage,
  unread: readonly string[],
): AssessmentMetricQueue {
  const unassessedMembers: string[] = [];
  const unassessedAges: number[] = [];
  let unknownAges = 0;

  const staleMembers: string[] = [];
  const conflictMembers: string[] = [];
  const unknownStateMembers: string[] = [];
  const stateUnknownMembers: string[] = [];

  const latencySamples: DurationSample[] = [];
  const firstAssessedEvents: { at: string; key: string }[] = [];
  const incomingEvents: { at: string; key: string }[] = [];
  const incomingGaps = new Set<string>(unread);
  const assessedGaps = new Set<string>(unread);
  const revisionUnknown = new Set<string>(unread);

  let revisionsTotal = 0;
  let revisionsInWindow = 0;

  for (const t of tickets) {
    const createdAt = createdInstant(t.ledger);
    const createdMs = createdAt === null ? NaN : Date.parse(createdAt);
    if (createdAt !== null && Number.isFinite(createdMs)) {
      incomingEvents.push({ at: createdAt, key: t.member });
    } else {
      incomingGaps.add(t.member);
    }

    const currentState = t.ledger.currentState;
    const assessmentState: EstimateState = t.assessment?.[metric]?.state ?? "unknown";

    if (currentState === "unknown") {
      stateUnknownMembers.push(t.member);
    } else if (currentState === "open") {
      if (assessmentState === "unestimated") {
        unassessedMembers.push(t.member);
        if (Number.isFinite(createdMs)) {
          unassessedAges.push(Math.max(0, nowMs - createdMs));
        } else {
          unknownAges += 1;
        }
      } else if (assessmentState === "stale") {
        staleMembers.push(t.member);
      } else if (assessmentState === "conflicting") {
        conflictMembers.push(t.member);
      } else if (assessmentState === "unknown") {
        unknownStateMembers.push(t.member);
      }
    }

    const endpoints: AssessmentEndpoints = t.ledger.assessments[metric];

    if (endpoints.revisions.known) {
      revisionsTotal += endpoints.revisions.value;
    } else {
      revisionsTotal += endpoints.revisions.observed;
      revisionUnknown.add(t.member);
    }
    for (const r of endpoints.records) {
      if (r.previous.length > 0 && inWindow(r.at, window) === true) {
        revisionsInWindow += 1;
      }
    }

    if (endpoints.first.status === "found") {
      firstAssessedEvents.push({ at: endpoints.first.at, key: t.member });
      if (inWindow(endpoints.first.at, window) === true) {
        const firstMs = Date.parse(endpoints.first.at);
        if (Number.isFinite(createdMs) && Number.isFinite(firstMs) && firstMs >= createdMs) {
          latencySamples.push({ member: t.member, status: "completed", ms: firstMs - createdMs });
        } else {
          latencySamples.push({
            member: t.member,
            status: "unknown",
            reason: "creation or first-assessment instant is missing or out of order",
          });
        }
      }
    } else if (endpoints.first.status === "unknown") {
      assessedGaps.add(t.member);
      const anyInWindow = t.ledger.events.some((e) => inWindow(e.at, window) === true);
      if (currentState !== "closed" || anyInWindow) {
        latencySamples.push({
          member: t.member,
          status: "unknown",
          reason: endpoints.first.reason,
        });
      }
    } else {
      // endpoints.first.status === "none"
      if (currentState === "open") {
        if (Number.isFinite(createdMs)) {
          latencySamples.push({
            member: t.member,
            status: "open",
            elapsedMs: Math.max(0, nowMs - createdMs),
          });
        } else {
          latencySamples.push({
            member: t.member,
            status: "unknown",
            reason: "creation date is unknown",
          });
        }
      } else if (currentState === "closed") {
        const closedAt = currentClosureAt(t.ledger);
        if (closedAt !== null && inWindow(closedAt, window) === true) {
          latencySamples.push({
            member: t.member,
            status: "closed-undelivered",
            reason: t.ledger.stateReason,
          });
        }
      } else {
        latencySamples.push({
          member: t.member,
          status: "unknown",
          reason: "ticket state is unknown",
        });
      }
    }
  }

  unassessedAges.sort((a, b) => a - b);

  return {
    unassessed: {
      count: unassessedMembers.length,
      medianAgeMs: median(unassessedAges),
      oldestAgeMs: unassessedAges.length === 0 ? null : unassessedAges[unassessedAges.length - 1]!,
      unknownAges,
      members: unassessedMembers,
    },
    states: {
      stale: { count: staleMembers.length, members: staleMembers },
      conflict: { count: conflictMembers.length, members: conflictMembers },
      unknown: { count: unknownStateMembers.length, members: unknownStateMembers },
    },
    stateUnknown: { count: stateUnknownMembers.length, members: stateUnknownMembers },
    firstAssessmentLatency: durationStats(latencySamples),
    revisions: {
      total: revisionsTotal,
      inWindow: revisionsInWindow,
      unknown: { count: revisionUnknown.size, members: [...revisionUnknown] },
      lowerBound: revisionUnknown.size > 0,
    },
    volume: {
      incoming: figureWithGaps(incomingEvents, trailing, coverage, incomingGaps),
      firstAssessed: figureWithGaps(firstAssessedEvents, trailing, coverage, assessedGaps),
    },
  };
}

export function assessmentQueueView(
  now: string,
  days: number,
  tickets: readonly AssessmentQueueTicket[],
  coverage: DayCoverage,
  unread: readonly string[] = [],
): AssessmentQueueResult {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RangeError(`not an instant: ${now}`);
  const trailing = trailingWindow(now, days);
  const from = `${trailing.days[0]}T00:00:00.000Z`;
  const window = { from, through: trailing.partial.observedThrough };

  return {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "assessment-queue",
    window,
    coverage: { historyCompleteFrom: coverage.completeFrom, note: noteForCoverage(from, coverage) },
    days,
    metrics: {
      complexity: metricQueue("complexity", nowMs, trailing, window, tickets, coverage, unread),
      impact: metricQueue("impact", nowMs, trailing, window, tickets, coverage, unread),
    },
  };
}
