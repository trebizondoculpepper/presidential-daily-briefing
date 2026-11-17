/**
 * Current assessment groups for metrics consumers (#832): one shared projection of a ticket's
 * current valid complexity and impact assessments, through the same label reading, provenance
 * decision and classifier as the estimation report.
 *
 * The basis is always explicit (`current-valid-…`): a group says what the ticket's assessment is
 * now, never that it existed at a historical endpoint (doc/design/dashboard-metric-owner-decisions.md).
 */

import { metricSizeReading } from "../estimation/complexitylabels.js";
import { classifyEstimate, metricProvenanceDecision } from "../estimation/estimation.js";
import type { EstimateState, ProvenanceAuthority } from "../estimation/estimation.js";
import { complexityMetric, impactMetric } from "../estimation/metrics.js";
import type { MetricDescriptor } from "../estimation/metrics.js";
import type { Comment } from "../workflow/claims.js";
import type { TrustDecision } from "../workflow/delivery.js";

/** A metric group: a valid size, or an explicit category that is never folded into a size. */
export type AssessmentGroupName = string;

export interface AssessmentGroup {
  basis: "current-valid-complexity" | "current-valid-impact";
  /** The size when valid, else `stale`, `conflict`, `unknown` or `unassessed`. */
  group: AssessmentGroupName;
  state: EstimateState;
  /** The current label size, present even when stale (for drill-down), else null. */
  size: string | null;
  /** The trusted record behind a size, when one was established. */
  provenance: { url: string; recordedAt: string | null; size: string } | null;
  authority: ProvenanceAuthority;
  reasons: string[];
}

/** The facts the projection needs, as the metrics read collects them. */
export interface AssessmentFacts {
  labels: { nodes: { name: string }[]; pageInfo?: { hasNextPage?: boolean } };
  lastEditedAt: string | null;
  comments: readonly Comment[];
  /** Whether the comment history was read in full. */
  commentsComplete: boolean;
}

const groupOf = (state: EstimateState, size: string | null): AssessmentGroupName => {
  switch (state) {
    case "estimated":
      return size ?? "unknown";
    case "stale":
      return "stale";
    case "conflicting":
      return "conflict";
    case "unestimated":
      return "unassessed";
    default:
      return "unknown";
  }
};

async function project(
  d: MetricDescriptor,
  facts: AssessmentFacts,
  trust: TrustDecision,
): Promise<AssessmentGroup> {
  const labels = {
    nodes: facts.labels.nodes,
    // Unknown label completeness is treated as incomplete, never as "no more labels".
    pageInfo: { hasNextPage: facts.labels.pageInfo?.hasNextPage ?? true },
  };
  const reading = metricSizeReading(d, { labels } as Parameters<typeof metricSizeReading>[1]);
  const decision =
    reading.kind === "known" && reading.size !== null
      ? await metricProvenanceDecision(
          d,
          facts.comments as { body: string; url?: string }[],
          !facts.commentsComplete,
          trust,
        )
      : { authority: "none" as const, record: null, ignored: [] };
  const { state, size, reasons } = classifyEstimate(reading, decision, {
    lastEditedAt: facts.lastEditedAt,
    historyIncomplete: !facts.commentsComplete,
    evidence: `${d.metric} size label`,
    guidanceVersion: d.guidance.guidanceVersion,
  });
  return {
    basis: d === impactMetric ? "current-valid-impact" : "current-valid-complexity",
    group: groupOf(state, size),
    state,
    size,
    provenance: decision.record
      ? {
          url: decision.record.url,
          recordedAt: decision.record.recordedAt,
          size: decision.record.size,
        }
      : null,
    authority: decision.authority,
    reasons,
  };
}

export interface AssessmentGroups {
  complexity: AssessmentGroup;
  impact: AssessmentGroup;
}

/** Both metrics' current assessment groups for one ticket. */
export async function assessmentGroups(
  facts: AssessmentFacts,
  trust: TrustDecision,
): Promise<AssessmentGroups> {
  return {
    complexity: await project(complexityMetric, facts, trust),
    impact: await project(impactMetric, facts, trust),
  };
}
