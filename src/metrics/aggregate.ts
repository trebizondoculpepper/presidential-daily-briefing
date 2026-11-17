/**
 * Duration statistics, grouping, first pickup and delivery instants for pipeline metrics
 * (#573 slice 4). Definitions: doc/design/dashboard-pipeline-metrics.md ("Common definitions",
 * "Timing") as amended by doc/design/dashboard-metric-owner-decisions.md.
 *
 * Pure over ticket ledgers and caller-supplied facts. Workflow verdicts (delivered, attested)
 * come from the native rules and completion evaluator, never from here.
 */

import type { PickupSource, TicketLedger } from "./ledger.js";

/** Percentiles appear only when a displayed group has at least this many completed members. */
export const PERCENTILE_MIN_SAMPLE = 20;

/**
 * Nearest-rank percentile of an ascending list: the value at rank ceil(p/100 × n).
 * Returns null for an empty list.
 */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Median of an ascending list; for an even count, the mean of the two middle values. */
export function median(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One ticket's contribution to a duration metric. */
export type DurationSample =
  | { member: string; status: "completed"; ms: number }
  /** Still running: its elapsed time so far is only a lower bound. */
  | { member: string; status: "open"; elapsedMs: number }
  | { member: string; status: "unknown"; reason: string };

export interface DurationStats {
  median: number | null;
  mean: number | null;
  completed: number;
  /** Percentiles, only when `completed >= PERCENTILE_MIN_SAMPLE`; otherwise null. */
  p75: number | null;
  p90: number | null;
  open: { count: number; longestElapsedMs: number | null };
  unknown: number;
  /** Every ticket counted in any figure above, so drill-down membership matches the counts. */
  members: { completed: string[]; open: string[]; unknown: string[] };
}

/** Median first, mean and completed count; open and unknown reported, never dropped. */
export function durationStats(samples: readonly DurationSample[]): DurationStats {
  const seen = new Set<string>();
  const unique = samples.filter((s) => (seen.has(s.member) ? false : (seen.add(s.member), true)));
  const completed = unique.filter((s) => s.status === "completed");
  const open = unique.filter((s) => s.status === "open");
  const unknown = unique.filter((s) => s.status === "unknown");
  const sorted = completed.map((s) => s.ms).sort((a, b) => a - b);
  const enough = sorted.length >= PERCENTILE_MIN_SAMPLE;
  return {
    median: median(sorted),
    mean: sorted.length === 0 ? null : sorted.reduce((a, b) => a + b, 0) / sorted.length,
    completed: sorted.length,
    p75: enough ? nearestRank(sorted, 75) : null,
    p90: enough ? nearestRank(sorted, 90) : null,
    open: {
      count: open.length,
      longestElapsedMs: open.length === 0 ? null : Math.max(...open.map((s) => s.elapsedMs)),
    },
    unknown: unknown.length,
    members: {
      completed: completed.map((s) => s.member),
      open: open.map((s) => s.member),
      unknown: unknown.map((s) => s.member),
    },
  };
}

/**
 * Statistics per displayed group (for example the latest valid complexity, with explicit
 * `unassessed`, `stale`, `conflict` and `unknown` groups supplied by the caller). The sample
 * threshold applies within each group, never across unrelated groups.
 */
export function groupedDurations(
  samples: readonly (DurationSample & { group: string })[],
): Map<string, DurationStats> {
  const groups = new Map<string, DurationSample[]>();
  for (const s of samples) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return new Map([...groups].map(([g, list]) => [g, durationStats(list)]));
}

export type FirstPickup =
  | { status: "found"; at: string; agent: string | null; source: PickupSource; key: string }
  | { status: "none" }
  | { status: "unknown"; reason: string };

/**
 * The earliest proven pickup across both sources (owner decision: a trusted claim record or a
 * trusted agent-label event, whichever is earliest, with its source shown). An event observed
 * in an incomplete source is still proven and counts. With nothing proven, an incomplete source
 * makes the result unknown; `none` needs every source read in full.
 */
export function firstPickup(ledger: TicketLedger): FirstPickup {
  const proven: { at: string; agent: string | null; source: PickupSource; key: string }[] = [];
  const unknownBecause: string[] = [];
  for (const source of ["claim-marker", "label"] as const) {
    const c = ledger.firstPickup[source];
    if (c.status === "found") proven.push({ at: c.at, agent: c.agent, key: c.key, source });
    else if (c.status === "unknown") {
      unknownBecause.push(c.reason);
      if (c.observed) proven.push({ ...c.observed, source });
    }
  }
  if (proven.length > 0) {
    proven.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.source < b.source ? -1 : 1));
    return { status: "found", ...proven[0]! };
  }
  return unknownBecause.length > 0
    ? { status: "unknown", reason: unknownBecause.join("; ") }
    : { status: "none" };
}

/** The completion verdict for a ticket now, as the native rules and evaluator decide it. */
export type CompletionVerdict = "delivered" | "attested" | "none" | "unknown";

export type DeliveryInstant =
  | { status: "dated"; at: string; basis: "last-required-merge" | "attestation" }
  | { status: "undated"; reason: string }
  | { status: "not-delivered" };

/**
 * When a delivered ticket was delivered. PR-only required sets: the latest merge of a required
 * member. Any non-PR member: undated (containment carries no reliable time). Attested: the
 * trusted attestation record's time. No instant is ever taken from `closedAt`.
 */
export function deliveryInstant(ledger: TicketLedger, verdict: CompletionVerdict): DeliveryInstant {
  if (verdict === "none") return { status: "not-delivered" };
  if (verdict === "unknown") return { status: "undated", reason: "completion verdict unknown" };
  if (verdict === "attested") {
    const attest = ledger.events.filter((e) => e.kind === "delivery" && e.op === "attest");
    const last = attest.at(-1);
    return last
      ? { status: "dated", at: last.at, basis: "attestation" }
      : { status: "undated", reason: "no trusted attestation record observed" };
  }
  if (ledger.membership !== "complete") {
    return { status: "undated", reason: `delivery membership ${ledger.membership ?? "absent"}` };
  }
  if (ledger.requiredPullRequests === null || ledger.requiredOtherMembers === null) {
    return { status: "undated", reason: "required members unknown" };
  }
  if (ledger.requiredOtherMembers > 0) {
    return { status: "undated", reason: "a required member is not a pull request" };
  }
  if (ledger.requiredPullRequests.length === 0) {
    return { status: "undated", reason: "no required pull request to date the delivery" };
  }
  let latest: string | null = null;
  for (const pr of ledger.requiredPullRequests) {
    const merge = ledger.events.find(
      (e) =>
        e.kind === "pr-merged" && e.pr.repository === pr.repository && e.pr.number === pr.number,
    );
    if (!merge)
      return { status: "undated", reason: `merge of ${pr.repository}#${pr.number} not observed` };
    if (latest === null || Date.parse(merge.at) > Date.parse(latest)) latest = merge.at;
  }
  return { status: "dated", at: latest!, basis: "last-required-merge" };
}

/**
 * Pickup-to-delivery for one ticket: first proven pickup to the delivery instant. Handoffs and
 * requeues never restart it. Open work reports its elapsed time so far as a lower bound.
 */
export function pickupToDelivery(
  member: string,
  ledger: TicketLedger,
  verdict: CompletionVerdict,
  now: string,
): DurationSample {
  const pickup = firstPickup(ledger);
  if (pickup.status === "unknown") return { member, status: "unknown", reason: pickup.reason };
  if (pickup.status === "none") return { member, status: "unknown", reason: "never picked up" };
  const delivery = deliveryInstant(ledger, verdict);
  if (delivery.status === "undated") return { member, status: "unknown", reason: delivery.reason };
  if (delivery.status === "not-delivered") {
    return {
      member,
      status: "open",
      elapsedMs: Math.max(0, Date.parse(now) - Date.parse(pickup.at)),
    };
  }
  const ms = Date.parse(delivery.at) - Date.parse(pickup.at);
  return ms < 0
    ? { member, status: "unknown", reason: "delivery precedes first pickup" }
    : { member, status: "completed", ms };
}
