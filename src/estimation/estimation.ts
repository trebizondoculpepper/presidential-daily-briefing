/**
 * Optional implementer estimation queue and briefing visibility (#122, labels-only since #152/#153).
 * Contract: doc/design/complexity-estimation.md "Estimation as implementer work".
 *
 * Estimation eligibility is separate from implementation eligibility: a blocked ticket can be
 * sized while staying ineligible for pickup. The queue holds unestimated and meaningfully stale
 * estimates; it is presented after higher-priority work unless explicitly requested, acquires
 * no claim and reserves nothing. Disabled complexity suppresses it. Sizes come from the
 * `complexity:` labels already in the snapshot (complexitylabels.ts); incomplete label evidence
 * is unknown, never "unestimated" or queued. Missing labels or label definitions are not setup
 * errors. Provenance comes from v2 marker comments already in the snapshot; only a marker whose
 * author and any editor are verified (#269, doc/design/complexity-provenance-trust.md) counts as
 * recorded. `readComplexityProvenance` makes those trust decisions asynchronously, before the pure
 * report builder runs.
 */
import { complexityGuidance } from "./complexity.js";
import type { ComplexitySize } from "./complexity.js";
import { parseLabelProvenance, scanProvenance } from "./estimate.js";
import { complexityMetric } from "./metrics.js";
import { classifyComplexityLabels } from "./complexitylabels.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { pickupEligibility } from "../briefing/ranking.js";
import type { PickupContext } from "../briefing/ranking.js";
import type { Issue } from "../github/types.js";

export type EstimationStatus = "available" | "disabled" | "unknown";

export interface EstimationFinding {
  rule: string;
  detail: string;
  /** Delivered commands only. */
  next: string[];
}

/** Bound on conflicting-size inspection lines in text output. */
export const MAX_CONFLICT_LINES = 10;

/** "conflicting" (#151, additive): several recognized size labels; inspect, never choose one. */
export type EstimateState = "estimated" | "unestimated" | "stale" | "conflicting" | "unknown";

export interface RecordedEstimate {
  size: ComplexitySize;
  rationale: string;
  assumptions: readonly string[];
  estimator: string | null;
  recordedAt: string | null;
  guidanceVersion: number | null;
  url: string;
}

export interface EstimateEntry {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  /**
   * Size from the complexity label; null when unset, conflicting or unreadable. Kept when only the
   * provenance authority is unknown (state `unknown`), so the label size is still shown.
   */
  size: ComplexitySize | null;
  state: EstimateState;
  /** Newest trusted provenance marker in the comment history, if any (#269). */
  recorded: RecordedEstimate | null;
  /**
   * Additive (#269): whether the provenance behind `recorded` was written by a verified author.
   * `none`: no marker; `untrusted`: only confirmed-untrusted markers; `unknown`: the newest
   * relevant marker's authority, or the history, could not be verified.
   */
  provenanceAuthority: ProvenanceAuthority;
  /** Additive (#269): why newer provenance markers were not trusted. */
  ignoredProvenance: string[];
  /** Implementation pickup eligibility, independent of estimation. */
  implementation: "eligible" | "ineligible" | "unknown";
  reasons: string[];
}

export interface EstimationReport {
  status: EstimationStatus;
  /**
   * Deprecated, always null: native-field storage was retired (#153). Kept so the briefing
   * output shape stays compatible with schema versions 1 (expanded) and 2 (compact).
   */
  fieldId: null;
  /** True when the caller asked to estimate (--estimate): the queue is presented first. */
  requested: boolean;
  guidanceVersion: number;
  detail: string;
  findings: EstimationFinding[];
  /** Unestimated and stale tickets, oldest first; null when the queue is unavailable. */
  queue: { total: number; omitted: number; items: EstimateEntry[] } | null;
  /** Open tickets whose size evidence could not be read completely. */
  unknown: number;
  /** Open tickets with conflicting size evidence: inspection candidates, never queued (#151). */
  conflicts: EstimateEntry[];
  /** Per-ticket state for compact visibility, keyed by URL. */
  entries: EstimateEntry[];
  boundaries: string;
}

export type ProvenanceAuthority = "trusted" | "untrusted" | "unknown" | "none";

/** One issue's complexity provenance after trust decisions (#269). */
export interface ProvenanceDecision {
  authority: ProvenanceAuthority;
  /** The newest trusted record; non-null only when `authority` is `trusted`. */
  record: RecordedEstimate | null;
  /** Confirmed-untrusted markers skipped on the way to the decision. */
  ignored: string[];
  /** Why authority is unknown. */
  why?: string;
}

/** A v2 (label-backed) marker comment as a recorded estimate; v1 field-era markers are not. */
function recordOf(comment: { body: string; url: string }): RecordedEstimate | null {
  const p = parseLabelProvenance(comment.body);
  return p
    ? {
        size: p.size,
        rationale: p.rationale,
        assumptions: Array.isArray(p.assumptions) ? p.assumptions : [],
        estimator: typeof p.estimator === "string" ? p.estimator : null,
        recordedAt: typeof p.recordedAt === "string" ? p.recordedAt : null,
        guidanceVersion: typeof p.guidanceVersion === "number" ? p.guidanceVersion : null,
        url: comment.url,
      }
    : null;
}

/**
 * Without a prepared decision nothing is trusted: an issue with no marker has no provenance, and
 * one with a marker has provenance of unknown authority. Untrusted text never becomes a record.
 */
function unevaluated(issue: Issue): ProvenanceDecision {
  return issue.comments.nodes.some((c) => recordOf(c))
    ? { authority: "unknown", record: null, ignored: [], why: "provenance authority not evaluated" }
    : { authority: "none", record: null, ignored: [] };
}

/**
 * Trust decisions for complexity provenance (#269), made once per snapshot before the pure report
 * builder runs: the shared newest-first scanner with the run's `TrustDecision` (the per-run
 * permission cache, so requests stay bounded by distinct marker authors and editors). Only open
 * tickets with exactly one recognized size label are judged; for the rest provenance is not read.
 * Missing newer comments make provenance unknown, even when an older trusted record was found.
 */
export async function readComplexityProvenance(
  issues: readonly Issue[],
  trust: TrustDecision,
  signal?: AbortSignal,
): Promise<Map<string, ProvenanceDecision>> {
  const decisions = new Map<string, ProvenanceDecision>();
  // Sequential, so the permission cache answers repeated authors without a second request.
  for (const issue of issues) {
    signal?.throwIfAborted();
    if (issue.state !== "OPEN" || classifyComplexityLabels(issue).state !== "estimated") continue;
    const scan = await scanProvenance(complexityMetric, issue.comments.nodes, trust);
    const ignored = scan.ignored;
    if (issue.comments.pageInfo.hasNextPage && scan.status !== "unknown")
      decisions.set(issue.url, {
        authority: "unknown",
        record: null,
        ignored,
        why: "newer comment history incomplete",
      });
    else if (scan.status === "unknown")
      decisions.set(issue.url, { authority: "unknown", record: null, ignored, why: scan.why });
    else if (scan.status === "trusted")
      decisions.set(issue.url, {
        authority: "trusted",
        record: recordOf(scan.node as { body: string; url: string }),
        ignored,
      });
    else
      decisions.set(issue.url, {
        authority: ignored.length ? "untrusted" : "none",
        record: null,
        ignored,
      });
  }
  return decisions;
}

/**
 * One issue's current-size evidence, as read by the label reader in complexitylabels.ts.
 * "conflict" is an inspection case: no size is chosen.
 */
export type SizeReading =
  | { kind: "known"; size: ComplexitySize | null }
  | { kind: "unknown"; reason: string }
  | { kind: "conflict"; sizes: ComplexitySize[]; reason: string };

/** Report inputs from the size reader. */
export interface SizeSource {
  status: EstimationStatus;
  unavailable: string | null;
  findings: EstimationFinding[];
  /** Human noun for the authoritative size evidence, e.g. "complexity size label". */
  evidence: string;
  read: (issue: Issue) => SizeReading;
  /** Prepared provenance trust decisions by issue URL (#269); absent ones are unevaluated. */
  provenance?: ReadonlyMap<string, ProvenanceDecision>;
}

/** Shared report builder over any size reader. Pure. */
export function sizeReport(
  issues: Issue[],
  input: SizeSource | undefined,
  options: PickupContext & { limit: number; requested?: boolean },
): EstimationReport {
  const base = {
    fieldId: null,
    requested: !!options.requested,
    guidanceVersion: complexityGuidance.guidanceVersion,
    findings: input?.findings ?? [],
    boundaries:
      "Optional work after PR follow-up, own work and eligible pickup. Estimating acquires no claim, reserves nothing and does not unblock or re-rank.",
  };
  if (!input || input.status === "disabled")
    return {
      ...base,
      status: input ? "disabled" : "unknown",
      detail: input
        ? "Complexity is disabled for this repository (complexity.enabled = false); no estimation queue."
        : "Complexity state was not collected; estimation queue unknown.",
      queue: null,
      unknown: 0,
      conflicts: [],
      entries: [],
    };
  const entries = issues
    .filter((issue) => issue.state === "OPEN")
    .map((issue): EstimateEntry => {
      const reading = input.read(issue);
      const decision =
        reading.kind === "known" && reading.size !== null
          ? (input.provenance?.get(issue.url) ?? unevaluated(issue))
          : { authority: "none" as const, record: null, ignored: [] };
      const recorded = decision.record;
      const reasons: string[] = [];
      let state: EstimateState;
      let size: ComplexitySize | null = null;
      if (reading.kind === "unknown") {
        state = "unknown";
        reasons.push(reading.reason);
      } else if (reading.kind === "conflict") {
        state = "conflicting";
        reasons.push(reading.reason);
      } else if (reading.size === null) {
        // As before #269: an unlabelled ticket with incomplete history is unknown, not unestimated.
        if (issue.comments.pageInfo.hasNextPage) {
          state = "unknown";
          reasons.push("comment history incomplete; provenance unknown");
        } else {
          state = "unestimated";
          reasons.push(`no ${input.evidence}`);
        }
      } else if (decision.authority === "unknown") {
        // The label size stands, but freshness cannot be established: inspect, never re-queue.
        size = reading.size;
        state = "unknown";
        reasons.push(
          ...decision.ignored,
          `provenance authority unknown (${decision.why ?? "unverified"}); freshness not established`,
        );
      } else {
        size = reading.size;
        state = "estimated";
        reasons.push(...decision.ignored);
        if (!recorded)
          reasons.push(
            decision.authority === "untrusted"
              ? "no trusted recorded rationale"
              : "no recorded rationale (value set outside pdb)",
          );
        else {
          if (recorded.size !== size) {
            state = "stale";
            reasons.push(
              `${input.evidence} ${size} differs from recorded estimate ${recorded.size}`,
            );
          }
          if ((recorded.guidanceVersion ?? 0) < complexityGuidance.guidanceVersion) {
            state = "stale";
            reasons.push(
              `guidance version ${recorded.guidanceVersion ?? "unknown"} < ${complexityGuidance.guidanceVersion}`,
            );
          }
          const edited = issue.lastEditedAt ? Date.parse(issue.lastEditedAt) : NaN;
          const at = recorded.recordedAt ? Date.parse(recorded.recordedAt) : NaN;
          if (edited > at) {
            state = "stale";
            reasons.push(`description edited ${issue.lastEditedAt} after the estimate`);
          } else if (!Number.isNaN(edited) && Number.isNaN(at)) {
            // An unparseable or missing recordedAt is unavailable freshness evidence: a later
            // description edit cannot be ruled out, so it never reads as fresh (#281).
            state = "stale";
            reasons.push(
              `description edited ${issue.lastEditedAt}; recorded time unknown, so the estimate cannot be shown fresh`,
            );
          }
        }
      }
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        size,
        state,
        recorded: recorded ?? null,
        provenanceAuthority: decision.authority,
        ignoredProvenance: decision.ignored,
        implementation: pickupEligibility(issue, options).status,
        reasons,
      };
    });
  const unknown = entries.filter((e) => e.state === "unknown").length;
  const conflicts = entries
    .filter((e) => e.state === "conflicting")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  if (input.status !== "available")
    return {
      ...base,
      status: input.status,
      detail: `Estimation queue unavailable: ${input.unavailable ?? "complexity state unknown"}. Unknown is not unestimated.`,
      queue: null,
      unknown,
      conflicts,
      entries,
    };
  const queued = entries
    .filter((e) => e.state === "unestimated" || e.state === "stale")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return {
    ...base,
    status: "available",
    detail: `${queued.length} ticket(s) to estimate (unestimated or stale, blocked included)${conflicts.length ? `; ${conflicts.length} with conflicting size evidence to inspect, not queued` : ""}${unknown ? `; ${unknown} unknown (${input.unavailable ?? "unreadable"}), not queued` : ""}.`,
    queue: {
      total: queued.length,
      omitted: Math.max(0, queued.length - options.limit),
      items: queued.slice(0, options.limit),
    },
    unknown,
    conflicts,
    entries,
  };
}

/** One compact line describing an entry's size, freshness and assumptions. */
export function estimateLine(e: EstimateEntry): string {
  const r = e.recorded;
  const size =
    e.state === "conflicting"
      ? "conflicting sizes"
      : e.state === "unknown"
        ? e.size
          ? `size ${e.size} (provenance unverified)`
          : "size unknown"
        : e.size
          ? `size ${e.size}`
          : "unestimated";
  const facts = [
    `${size} [${e.state}]`,
    `implementation ${e.implementation}`,
    ...(r && e.state !== "unknown"
      ? [
          `recorded ${r.recordedAt ?? "at unknown time"}${r.estimator ? ` by ${r.estimator}` : ""}: ${r.rationale.slice(0, 120)}`,
          ...(r.assumptions.length ? [`assumes ${r.assumptions.join("; ").slice(0, 120)}`] : []),
        ]
      : []),
    ...e.reasons,
  ];
  return facts.join("; ");
}

/** Text section lines, bounded by the queue limit. */
export function estimationText(report: EstimationReport): string[] {
  const lines = [`${report.detail}`];
  for (const f of report.findings)
    lines.push(`  ${f.rule}: ${f.detail} Next: ${f.next.join(" | ")}`);
  if (report.queue) {
    for (const e of report.queue.items)
      lines.push(`#${e.number} ${e.title} — ${estimateLine(e)}\n  pdb estimate --help; ${e.url}`);
    if (report.queue.omitted) lines.push(`${report.queue.omitted} more omitted; increase --limit.`);
  }
  const shown = report.conflicts.slice(0, MAX_CONFLICT_LINES);
  for (const e of shown)
    lines.push(`#${e.number} ${e.title} — inspect: ${estimateLine(e)}\n  ${e.url}`);
  if (report.conflicts.length > shown.length)
    lines.push(`${report.conflicts.length - shown.length} more conflicting ticket(s) omitted.`);
  lines.push(report.boundaries);
  return lines;
}
