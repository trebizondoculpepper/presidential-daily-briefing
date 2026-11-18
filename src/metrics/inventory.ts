/**
 * Current-inventory and stalled-work view for pipeline metrics (#883,
 * doc/design/dashboard-pipeline-metrics.md "Pipeline health (#575)").
 *
 * Pure over `MetricTicket[]` and caller-supplied `now` and `InventoryFacts`. Stage and blocker
 * decisions come from the native workflow rules / caller facts; this module only aggregates.
 * Current open inventory is kept strictly separate from historical cohorts.
 */

import { median } from "./aggregate.js";
import type { TicketLedger } from "./ledger.js";
import type { DayCoverage } from "./windows.js";

export const DEFAULT_STALLED_HOURS = 24;

export const INVENTORY_STAGES = [
  "unassessed",
  "ready",
  "blocked",
  "claimed",
  "in-review",
  "unknown",
] as const;

export type InventoryStage = (typeof INVENTORY_STAGES)[number];

/** Caller-supplied native workflow facts for current open inventory. */
export interface InventoryFacts {
  /** Native workflow stage; `"unknown"` when completeness or prerequisites cannot be established. */
  stage: InventoryStage;
  /** Ticket creation time (ISO UTC) for non-claimed/non-blocked stage ages; null/undefined is unknown age. */
  createdAt?: string | null;
  /** Last observed change (ISO UTC) for blocked stage age; null/undefined falls back to latest ledger event. */
  lastObservedChangeAt?: string | null;
  /** Current claim start (ISO UTC) for claimed stage age; falls back to ledger pickup. */
  claimedAt?: string | null;
  /** Native dependency blocker status; null/undefined means unknown. */
  blocked?: boolean | null;
  /** Known wait status from claim-activity `waiting` state; null/undefined means unknown. */
  waiting?: boolean | null;
  /** Whether the ticket currently has an agent claim, independent of its exclusive display stage. */
  claimed?: boolean;
}

export interface StageAgeStats {
  medianMs: number | null;
  oldestMs: number | null;
  knownCount: number;
  unknownCount: number;
  unknownMembers: string[];
}

export interface StageInventory {
  count: number;
  members: string[];
  age: StageAgeStats;
}

export interface StalledBucket {
  count: number;
  members: string[];
}

export interface StalledInventory {
  thresholdHours: number;
  cutoff: string;
  total: StalledBucket;
  knownWait: StalledBucket;
  blocked: StalledBucket;
  noRecordedProgress: StalledBucket;
  unknownActivity: StalledBucket;
}

export interface InventoryResult {
  schemaVersion: 1;
  kind: "pipeline-metrics";
  view: "inventory";
  cohort: "current-open-inventory";
  observedAt: string;
  window: { from: string; through: string };
  coverage: { historyCompleteFrom: string | null; note: string | null };
  totalOpen: number;
  stages: Record<InventoryStage, StageInventory>;
  stalled: StalledInventory;
  stateUnknown: StalledBucket;
}

export interface InventoryTicket {
  member: string;
  ledger: TicketLedger;
  inventory?: InventoryFacts;
}

function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function coverageNote(from: string, coverage: DayCoverage): string | null {
  if (coverage.completeFrom === null) return "event history was not read; figures are unknown";
  if (Date.parse(coverage.completeFrom) > Date.parse(from)) {
    return `events before ${coverage.completeFrom} may be missing`;
  }
  return null;
}

function earliestPickupIso(t: InventoryTicket): string | null {
  const candidates = [t.ledger.firstPickup["claim-marker"], t.ledger.firstPickup.label]
    .filter(
      (c): c is { status: "found"; at: string; agent: string | null; key: string } =>
        c.status === "found",
    )
    .map((c) => c.at)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return candidates[0] ?? null;
}

function createdIsoOf(t: InventoryTicket): string | null {
  if (t.inventory?.createdAt) return t.inventory.createdAt;
  const created = t.ledger.events.find((e) => e.kind === "created");
  return created?.at ?? null;
}

function latestEventIsoOf(t: InventoryTicket): string | null {
  const times = t.ledger.events
    .map((e) => ({ at: e.at, ms: parseMs(e.at) }))
    .filter((x): x is { at: string; ms: number } => x.ms !== null)
    .sort((a, b) => a.ms - b.ms);
  return times.at(-1)?.at ?? null;
}

function stageAgeStartMs(t: InventoryTicket, stage: InventoryStage): number | null {
  if (stage === "claimed") {
    return parseMs(t.inventory?.claimedAt ?? earliestPickupIso(t));
  }
  if (stage === "blocked") {
    return parseMs(t.inventory?.lastObservedChangeAt ?? latestEventIsoOf(t));
  }
  return parseMs(createdIsoOf(t));
}

function emptyStage(): StageInventory {
  return {
    count: 0,
    members: [],
    age: { medianMs: null, oldestMs: null, knownCount: 0, unknownCount: 0, unknownMembers: [] },
  };
}

function hasCompleteActivityEvidence(t: InventoryTicket): boolean {
  const c = t.ledger.coverage;
  return (
    c.timeline === "complete" &&
    c.comments === "complete" &&
    c.deliveryRecords === "complete" &&
    c.prs === "complete"
  );
}

/**
 * Build the current open-ticket inventory by native stage and stalled-work breakdown.
 * Closed tickets are excluded; unknown-state tickets are counted separately in `stateUnknown`.
 */
export function inventoryView(
  now: string,
  tickets: readonly InventoryTicket[],
  coverage: DayCoverage,
  options: { stalledHours?: number } = {},
): InventoryResult {
  const thresholdHours = options.stalledHours ?? DEFAULT_STALLED_HOURS;
  const nowMs = Date.parse(now);
  const observedAt = new Date(nowMs).toISOString();
  const cutoffMs = nowMs - thresholdHours * 3_600_000;
  const cutoff = new Date(cutoffMs).toISOString();

  const stages: Record<InventoryStage, StageInventory> = {
    unassessed: emptyStage(),
    ready: emptyStage(),
    blocked: emptyStage(),
    claimed: emptyStage(),
    "in-review": emptyStage(),
    unknown: emptyStage(),
  };
  const stageAges: Record<InventoryStage, number[]> = {
    unassessed: [],
    ready: [],
    blocked: [],
    claimed: [],
    "in-review": [],
    unknown: [],
  };

  const stateUnknownMembers: string[] = [];
  const stalledTotal: string[] = [];
  const knownWait: string[] = [];
  const blocked: string[] = [];
  const noRecordedProgress: string[] = [];
  const unknownActivity: string[] = [];
  let totalOpen = 0;

  for (const t of tickets) {
    if (t.ledger.currentState === "closed") continue;
    if (t.ledger.currentState === "unknown") {
      stateUnknownMembers.push(t.member);
      continue;
    }
    totalOpen++;
    const stage: InventoryStage = t.inventory?.stage ?? "unknown";
    const bucket = stages[stage];
    bucket.count++;
    bucket.members.push(t.member);

    const startMs = stageAgeStartMs(t, stage);
    if (startMs === null || startMs > nowMs) {
      bucket.age.unknownCount++;
      bucket.age.unknownMembers.push(t.member);
    } else {
      stageAges[stage].push(nowMs - startMs);
    }

    if (t.inventory?.claimed ?? stage === "claimed") {
      const hasRecentEvent = t.ledger.events.some((e) => {
        const ms = parseMs(e.at);
        return ms !== null && ms >= cutoffMs && ms <= nowMs;
      });
      if (!hasRecentEvent) {
        if (!hasCompleteActivityEvidence(t)) {
          unknownActivity.push(t.member);
        } else {
          stalledTotal.push(t.member);
          if (t.inventory?.waiting === true) {
            knownWait.push(t.member);
          } else if (t.inventory?.blocked === true) {
            blocked.push(t.member);
          } else if (t.inventory?.waiting === null || t.inventory?.blocked === null) {
            unknownActivity.push(t.member);
          } else {
            noRecordedProgress.push(t.member);
          }
        }
      }
    }
  }

  for (const stage of INVENTORY_STAGES) {
    const ages = stageAges[stage].sort((a, b) => a - b);
    const s = stages[stage];
    s.age.knownCount = ages.length;
    s.age.medianMs = median(ages);
    s.age.oldestMs = ages.length > 0 ? ages[ages.length - 1]! : null;
  }

  return {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "inventory",
    cohort: "current-open-inventory",
    observedAt,
    window: { from: observedAt, through: observedAt },
    coverage: {
      historyCompleteFrom: coverage.completeFrom,
      note: coverageNote(cutoff, coverage),
    },
    totalOpen,
    stages,
    stalled: {
      thresholdHours,
      cutoff,
      total: { count: stalledTotal.length, members: stalledTotal },
      knownWait: { count: knownWait.length, members: knownWait },
      blocked: { count: blocked.length, members: blocked },
      noRecordedProgress: { count: noRecordedProgress.length, members: noRecordedProgress },
      unknownActivity: { count: unknownActivity.length, members: unknownActivity },
    },
    stateUnknown: { count: stateUnknownMembers.length, members: stateUnknownMembers },
  };
}
