/**
 * Pipeline-metrics views (#573 slice 5a): pure builders that turn ticket ledgers and their
 * current completion verdicts into the `pipeline-metrics` results the metrics API serves
 * (doc/design/dashboard-pipeline-metrics.md "Typed services and API", amended by
 * doc/design/dashboard-metric-owner-decisions.md).
 *
 * No GitHub access, no clock reads: the caller supplies `now`, the ledgers, each ticket's
 * verdict from the native rules and completion evaluator, and its latest valid complexity group.
 */

import { inWindow } from "../github/changes.js";
import {
  deliveryInstant,
  groupedDurations,
  pickupToDelivery,
  type CompletionVerdict,
  type DurationSample,
  type DurationStats,
} from "./aggregate.js";
import type { LedgerEvent, TicketLedger } from "./ledger.js";
import {
  dailyAverage,
  dailySeries,
  trailingWindow,
  type DailyAverage,
  type DailySeries,
  type DayCoverage,
} from "./windows.js";

export const METRICS_SCHEMA_VERSION = 1;

/** One ticket as the views need it. */
export interface MetricTicket {
  /** Stable drill-down key, for example `owner/repo#12`. */
  member: string;
  ledger: TicketLedger;
  verdict: CompletionVerdict;
  /**
   * Display group for timing: the latest valid complexity assessment (owner decision), or an
   * explicit `unassessed`, `stale`, `conflict` or `unknown` group. Never an untrusted label.
   */
  complexity: string;
}

/** How far back the historical event walk is known to be complete. */
export type HistoryCoverage = DayCoverage;

interface Envelope<V extends string> {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  kind: "pipeline-metrics";
  view: V;
  window: { from: string; through: string };
  coverage: { historyCompleteFrom: string | null; note: string | null };
}

function coverageNote(from: string, coverage: HistoryCoverage): string | null {
  if (coverage.completeFrom === null) return "event history was not read; figures are unknown";
  if (Date.parse(coverage.completeFrom) > Date.parse(from)) {
    return `events before ${coverage.completeFrom} may be missing`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// News: recent ledger events, newest first.

export interface NewsItem {
  at: string;
  kind: LedgerEvent["kind"];
  member: string;
  key: string;
  detail: string | null;
}

export interface NewsResult extends Envelope<"news"> {
  items: NewsItem[];
  /** Events in the window beyond the item limit: counted, never silently dropped. */
  omitted: number;
  /** Tickets with a partly read source: their recent events may be missing from `items`. */
  incomplete: { count: number; members: string[] };
}

function detailOf(e: LedgerEvent): string | null {
  switch (e.kind) {
    case "closed":
      return e.reason;
    case "picked-up":
      return e.agent ? `${e.agent} (${e.source})` : e.source;
    case "released":
      return `${e.agent}: ${e.outcome}`;
    case "delivery":
      return `${e.op} by ${e.agent}`;
    case "pr-merged":
      return `${e.pr.repository}#${e.pr.number}`;
    default:
      return null;
  }
}

/** Ledger events in `[now − hours, now)`, newest first, each event once. */
export function newsView(
  now: string,
  hours: number,
  tickets: readonly MetricTicket[],
  coverage: HistoryCoverage,
  limit = 200,
  /** Tickets in the window the read could not ledger: their events are missing. */
  unread: readonly string[] = [],
): NewsResult {
  const through = new Date(Date.parse(now)).toISOString();
  const from = new Date(Date.parse(now) - hours * 3_600_000).toISOString();
  const window = { from, through };
  const seen = new Set<string>();
  const all: NewsItem[] = [];
  const gaps = new Set<string>(unread);
  for (const t of tickets) {
    if (Object.values(t.ledger.coverage).some((c) => c !== "complete")) gaps.add(t.member);
    for (const e of t.ledger.events) {
      if (inWindow(e.at, window) !== true || seen.has(e.key)) continue;
      seen.add(e.key);
      all.push({ at: e.at, kind: e.kind, member: t.member, key: e.key, detail: detailOf(e) });
    }
  }
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : 1));
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    kind: "pipeline-metrics",
    view: "news",
    window,
    coverage: { historyCompleteFrom: coverage.completeFrom, note: coverageNote(from, coverage) },
    items: all.slice(0, limit),
    omitted: Math.max(0, all.length - limit),
    incomplete: { count: gaps.size, members: [...gaps] },
  };
}

// ---------------------------------------------------------------------------------------------
// Daily: four separate series per UTC day, never stacked into one total.

export interface DailyFigure {
  series: DailySeries;
  average: DailyAverage;
  /**
   * Tickets whose evidence for this figure is missing (unread PRs, unknown verdict or state).
   * When any exist, every count and the average are lower bounds, never known totals.
   */
  incomplete: { count: number; members: string[] };
  lowerBound: boolean;
}

export interface DailyResult extends Envelope<"daily"> {
  days: number;
  figures: {
    /** Tickets whose verdict is delivered now, dated by their last required merge. */
    deliveries: DailyFigure;
    /** Attested tickets, dated by the trusted attestation record; shown separately. */
    attested: DailyFigure;
    /** Closed as completed without verified delivery. */
    closedCompletedUnverified: DailyFigure;
    /** Closed as not planned. */
    closedNotPlanned: DailyFigure;
    /** Pull request merges: a separate unit from tickets, each PR once. */
    prMerges: DailyFigure;
  };
  /** Delivered or attested now, but with no reliable instant: counted, never dated. */
  deliveredDateUnknown: { count: number; members: string[] };
}

/** The latest closure recorded for the ticket, if it is closed now. */
function currentClosure(ledger: TicketLedger): (LedgerEvent & { kind: "closed" }) | null {
  if (ledger.currentState !== "closed") return null;
  const closures = ledger.events.filter(
    (e): e is LedgerEvent & { kind: "closed" } => e.kind === "closed",
  );
  return closures.at(-1) ?? null;
}

export function dailyView(
  now: string,
  days: number,
  tickets: readonly MetricTicket[],
  coverage: HistoryCoverage,
  /** Tickets in the window the read could not ledger: every figure is then a lower bound. */
  unread: readonly string[] = [],
  /**
   * Merges from the pull request walk, when the read supplies them: then the PR-merge series
   * counts every merged PR, standalone ones included, not only required delivery members.
   */
  walkedMerges?: readonly { at: string; key: string }[],
): DailyResult {
  const window = trailingWindow(now, days);
  const deliveries: { at: string; key: string }[] = [];
  const attested: { at: string; key: string }[] = [];
  const unverified: { at: string; key: string }[] = [];
  const notPlanned: { at: string; key: string }[] = [];
  const merges = new Map<string, string>();
  const undated = new Set<string>();
  // Per-figure evidence gaps, so missing evidence is never shown as known zero activity.
  const outcomeGaps = new Set<string>(unread);
  const mergeGaps = new Set<string>(walkedMerges ? [] : unread);

  for (const t of tickets) {
    if (t.verdict === "unknown" || t.ledger.currentState === "unknown") outcomeGaps.add(t.member);
    if (!walkedMerges && t.ledger.coverage.prs !== "complete") mergeGaps.add(t.member);
    if (t.verdict === "delivered" || t.verdict === "attested") {
      const d = deliveryInstant(t.ledger, t.verdict);
      if (d.status === "dated") {
        (t.verdict === "attested" ? attested : deliveries).push({ at: d.at, key: t.member });
      } else undated.add(t.member);
    } else if (t.verdict === "none") {
      const closure = currentClosure(t.ledger);
      if (closure?.reason === "NOT_PLANNED") notPlanned.push({ at: closure.at, key: t.member });
      else if (closure?.reason === "COMPLETED") unverified.push({ at: closure.at, key: t.member });
    }
    for (const e of t.ledger.events) {
      if (e.kind !== "pr-merged") continue;
      const key = `${e.pr.repository}#${e.pr.number}`;
      if (!merges.has(key)) merges.set(key, e.at);
    }
  }

  const figure = (events: { at: string; key: string }[], gaps: Set<string>): DailyFigure => {
    const series = dailySeries(events, window, coverage);
    return {
      series,
      average: dailyAverage(series),
      incomplete: { count: gaps.size, members: [...gaps] },
      lowerBound: gaps.size > 0,
    };
  };
  const from = `${window.days[0]}T00:00:00.000Z`;
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    kind: "pipeline-metrics",
    view: "daily",
    window: { from, through: window.partial.observedThrough },
    coverage: { historyCompleteFrom: coverage.completeFrom, note: coverageNote(from, coverage) },
    days,
    figures: {
      deliveries: figure(deliveries, outcomeGaps),
      attested: figure(attested, outcomeGaps),
      closedCompletedUnverified: figure(unverified, outcomeGaps),
      closedNotPlanned: figure(notPlanned, outcomeGaps),
      prMerges: figure(
        walkedMerges ? [...walkedMerges] : [...merges].map(([key, at]) => ({ at, key })),
        mergeGaps,
      ),
    },
    deliveredDateUnknown: { count: undated.size, members: [...undated] },
  };
}

// ---------------------------------------------------------------------------------------------
// Timing: first pickup to delivery, grouped by the latest valid complexity.

export interface TimingResult extends Envelope<"timing"> {
  /** The population rule, stated so the figures can be read correctly. */
  cohort: string;
  groupBasis: "latest-valid-complexity";
  groups: Record<string, DurationStats>;
}

/** Whether any pickup source proved there was none, rather than being unread. */
function pickupStatus(ledger: TicketLedger): "none" | "other" {
  const c = ledger.firstPickup;
  return c["claim-marker"].status === "none" && c.label.status === "none" ? "none" : "other";
}

/**
 * Timing population, as one explicit table (#573 slice 5a):
 *
 * | Case                                                    | In the population?             |
 * | ------------------------------------------------------- | ------------------------------ |
 * | delivery dated                                          | iff that date is in the window |
 * | delivered/attested but undated, or verdict unknown      | iff any event in the window    |
 * | not delivered and proven never picked up                | never (creation-to-pickup)     |
 * | not delivered and closed                                | iff the closure is in window   |
 * | not delivered, open or state unknown                    | always (open or unknown)       |
 */
function timingMember(
  t: MetricTicket,
  status: DurationSample["status"],
  window: { from: string; through: string },
  anyEventInWindow: boolean,
): boolean {
  const d = deliveryInstant(t.ledger, t.verdict);
  if (d.status === "dated") return inWindow(d.at, window) === true;
  if (t.verdict !== "none") return anyEventInWindow;
  if (pickupStatus(t.ledger) === "none") return false;
  if (status === "closed-undelivered" || t.ledger.currentState === "closed") {
    const closure = currentClosure(t.ledger);
    return closure !== null && inWindow(closure.at, window) === true;
  }
  return true;
}

/**
 * Population: tickets delivered within the window (completed samples), work still open now
 * (lower bounds), tickets closed undelivered within the window, and tickets with unknown
 * endpoints that are still open or had any recorded event in the window. Completed deliveries outside the
 * window are excluded, never counted.
 */
export function timingView(
  now: string,
  days: number,
  tickets: readonly MetricTicket[],
  coverage: HistoryCoverage,
): TimingResult {
  // The same trailing UTC-day window as the daily view: complete days plus the partial day.
  const days_ = trailingWindow(now, days);
  const from = `${days_.days[0]}T00:00:00.000Z`;
  const through = days_.partial.observedThrough;
  const window = { from, through };
  const samples = [];
  for (const t of tickets) {
    const s = pickupToDelivery(t.member, t.ledger, t.verdict, now);
    const anyEventInWindow = t.ledger.events.some((e) => inWindow(e.at, window) === true);
    if (timingMember(t, s.status, window, anyEventInWindow)) {
      samples.push({ ...s, group: t.complexity });
    }
  }
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    kind: "pipeline-metrics",
    view: "timing",
    window,
    coverage: { historyCompleteFrom: coverage.completeFrom, note: coverageNote(from, coverage) },
    cohort: `delivered-in(${from}, ${through}) + open now + closed-undelivered-in + unknown open or with event-in`,
    groupBasis: "latest-valid-complexity",
    groups: Object.fromEntries(groupedDurations(samples)),
  };
}
