/**
 * Current open unclaimed waiting backlog grouped by trusted current impact (#885,
 * doc/design/dashboard-pipeline-metrics.md "Pipeline health (#575)").
 *
 * Pure over `MetricTicket` ledgers, `AssessmentGroups`, and caller-supplied `InventoryFacts`.
 * Native rules supply stage/readiness decisions; this module only aggregates. Current open
 * inventory is kept strictly separate from historical cohorts.
 */

import type { AssessmentGroups } from "./assessment.js";
import { median } from "./aggregate.js";
import { createdIsoOf } from "./inventory.js";
import type { InventoryFacts, StageAgeStats } from "./inventory.js";
import type { TicketLedger } from "./ledger.js";
import type { DayCoverage } from "./windows.js";

export interface WaitingImpactBucket {
  count: number;
  members: string[];
}

export interface WaitingImpactGroup {
  total: WaitingImpactBucket;
  /**
   * Waiting age of the group's tickets (#685): time since creation, the inventory's definition
   * for unclaimed work; unknown ages are counted and named, never dropped.
   */
  age: StageAgeStats;
  ready: WaitingImpactBucket;
  blocked: WaitingImpactBucket;
  notReady: WaitingImpactBucket;
  unknown: WaitingImpactBucket;
}

export interface WaitingImpactResult {
  schemaVersion: 1;
  kind: "pipeline-metrics";
  view: "waiting-impact";
  cohort: "current-open-inventory";
  groupBasis: "current-valid-impact";
  observedAt: string;
  window: { from: string; through: string };
  coverage: { historyCompleteFrom: string | null; note: string | null };
  totalUnclaimed: number;
  totals: WaitingImpactGroup;
  /** Valid impact sizes plus explicit `unassessed`, `stale`, `conflict`, `unknown` groups. */
  groups: Record<string, WaitingImpactGroup>;
  /** Open tickets whose claim/ownership or readiness stage could not be verified. */
  claimUnknown: WaitingImpactBucket;
  /** Tickets whose open/closed state could not be established. */
  stateUnknown: WaitingImpactBucket;
}

export interface WaitingImpactTicket {
  member: string;
  ledger: TicketLedger;
  assessment?: AssessmentGroups;
  inventory?: InventoryFacts;
}

function emptyGroup(): WaitingImpactGroup {
  return {
    total: { count: 0, members: [] },
    age: { medianMs: null, oldestMs: null, knownCount: 0, unknownCount: 0, unknownMembers: [] },
    ready: { count: 0, members: [] },
    blocked: { count: 0, members: [] },
    notReady: { count: 0, members: [] },
    unknown: { count: 0, members: [] },
  };
}

function pushToBucket(bucket: WaitingImpactBucket, member: string): void {
  bucket.count += 1;
  bucket.members.push(member);
}

function coverageNote(from: string, coverage: DayCoverage): string | null {
  if (!coverage.completeFrom) return "event history was not read; figures are unknown";
  return Date.parse(coverage.completeFrom) <= Date.parse(from)
    ? null
    : `events before ${coverage.completeFrom} may be missing; earlier days are unknown`;
}

function isClaimed(inventory: InventoryFacts | undefined): boolean {
  if (!inventory) return false;
  return (
    inventory.claimed === true || inventory.stage === "claimed" || inventory.stage === "in-review"
  );
}

export function waitingImpactView(
  now: string,
  tickets: readonly WaitingImpactTicket[],
  coverage: DayCoverage,
): WaitingImpactResult {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RangeError(`not an instant: ${now}`);
  const observedAt = new Date(nowMs).toISOString();
  const totals = emptyGroup();
  const groups = new Map<string, WaitingImpactGroup>([
    ["unassessed", emptyGroup()],
    ["stale", emptyGroup()],
    ["conflict", emptyGroup()],
    ["unknown", emptyGroup()],
  ]);
  const claimUnknown: WaitingImpactBucket = { count: 0, members: [] };
  const stateUnknown: WaitingImpactBucket = { count: 0, members: [] };

  const ages = new Map<WaitingImpactGroup, number[]>([[totals, []]]);
  for (const g of groups.values()) ages.set(g, []);
  const getGroup = (name: string): WaitingImpactGroup => {
    let g = groups.get(name);
    if (!g) {
      g = emptyGroup();
      groups.set(name, g);
      ages.set(g, []);
    }
    return g;
  };

  for (const t of tickets) {
    if (t.ledger.currentState === "closed") continue;
    if (t.ledger.currentState === "unknown") {
      pushToBucket(stateUnknown, t.member);
      continue;
    }
    if (isClaimed(t.inventory)) continue;

    const stage = t.inventory?.stage ?? "unknown";
    if (
      !t.inventory ||
      t.inventory.labelsComplete === false ||
      (t.inventory.labelsComplete === undefined && stage === "unknown")
    ) {
      pushToBucket(claimUnknown, t.member);
      continue;
    }

    const groupName = t.assessment?.impact.group ?? "unknown";
    const group = getGroup(groupName);

    pushToBucket(totals.total, t.member);
    pushToBucket(group.total, t.member);
    const createdMs = Date.parse(createdIsoOf(t) ?? "");
    for (const g of [totals, group]) {
      // As in the inventory, a missing or future creation time is an unknown age, not zero.
      if (Number.isFinite(createdMs) && createdMs <= nowMs) ages.get(g)!.push(nowMs - createdMs);
      else {
        g.age.unknownCount += 1;
        g.age.unknownMembers.push(t.member);
      }
    }

    if (stage === "ready") {
      pushToBucket(totals.ready, t.member);
      pushToBucket(group.ready, t.member);
    } else if (stage === "blocked") {
      pushToBucket(totals.blocked, t.member);
      pushToBucket(group.blocked, t.member);
      pushToBucket(totals.notReady, t.member);
      pushToBucket(group.notReady, t.member);
    } else if (stage === "unassessed") {
      pushToBucket(totals.notReady, t.member);
      pushToBucket(group.notReady, t.member);
    } else {
      pushToBucket(totals.unknown, t.member);
      pushToBucket(group.unknown, t.member);
    }
  }

  for (const [g, list] of ages) {
    const sorted = list.sort((a, b) => a - b);
    g.age.knownCount = sorted.length;
    g.age.medianMs = median(sorted);
    g.age.oldestMs = sorted.length ? sorted[sorted.length - 1]! : null;
  }

  return {
    schemaVersion: 1,
    kind: "pipeline-metrics",
    view: "waiting-impact",
    cohort: "current-open-inventory",
    groupBasis: "current-valid-impact",
    observedAt,
    window: { from: observedAt, through: observedAt },
    coverage: {
      historyCompleteFrom: coverage.completeFrom,
      note: coverageNote(observedAt, coverage),
    },
    totalUnclaimed: totals.total.count,
    totals,
    groups: Object.fromEntries(groups),
    claimUnknown,
    stateUnknown,
  };
}
