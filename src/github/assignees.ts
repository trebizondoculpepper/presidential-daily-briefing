/**
 * Normalized GitHub human-assignment facts for issues and linked PR work (#665).
 * Pure fact normalization only: never decides workflow eligibility, routing, or admission,
 * and never infers human ownership from ticket/PR creators or `agent:` labels.
 */
import type { Assignee, Issue, PullRequest, Snapshot } from "./types.js";

export type AssigneeCompleteness = "complete" | "legacy" | "truncated" | "failed" | "unknown";

export type AssignmentState = "matching" | "other-human" | "unassigned" | "assigned" | "unknown";

export type EffectiveAssignmentState = AssignmentState | "conflicting";

export interface AssignmentFreshness {
  source: "observed" | "current" | "last-known" | "unknown";
  observedAt: string | null;
  ageMs: number | null;
}

export interface SubjectAssignment {
  humans: string[];
  bots: string[];
  untyped: string[];
  completeness: AssigneeCompleteness;
  state: AssignmentState;
  freshness: AssignmentFreshness;
}

export interface LinkedIssueAssignment {
  number: number;
  url: string;
  resolved: boolean;
  assignment: SubjectAssignment | null;
}

export interface AssignmentEvidence {
  subject: SubjectAssignment;
  linkedIssues: LinkedIssueAssignment[];
  linkedComplete: boolean;
  conflict: boolean;
  effective: EffectiveAssignmentState;
}

export interface AssignmentOptions {
  /** Verified employing human's GitHub login (never inferred from agent labels or creators). */
  employingHuman?: string | null;
  /** Snapshot or subject warnings for completeness/failure detection. */
  warnings?: readonly string[];
  /** Freshness source: live/current, cached/last-known, or observed. */
  source?: AssignmentFreshness["source"];
  /** ISO-8601 observation timestamp (e.g. `snapshot.fetchedAt`). */
  observedAt?: string | null;
  /** Reference clock for computing `ageMs`. */
  now?: Date;
}

function computeFreshness(options: AssignmentOptions): AssignmentFreshness {
  const observedAt = options.observedAt ?? null;
  const parsed = observedAt ? Date.parse(observedAt) : Number.NaN;
  const validTime = Number.isFinite(parsed);
  const ageMs = validTime && options.now ? Math.max(0, options.now.getTime() - parsed) : null;
  return {
    source: options.source ?? (validTime ? "observed" : "unknown"),
    observedAt: validTime ? observedAt : null,
    ageMs,
  };
}

function classifyCompleteness(
  subject: Pick<Issue, "url" | "assignees">,
  warnings: readonly string[],
): AssigneeCompleteness {
  const prefix = `${subject.url}:`;
  const related = warnings.filter((w) => w.startsWith(prefix));
  if (related.some((w) => /assignees exceed|assignment evidence incomplete/i.test(w)))
    return "truncated";
  if (
    related.some((w) =>
      /assignees?\b.*\b(could not be read|unavailable|failed|rate limited)|assignment evidence\b.*\b(could not be read|unavailable|failed|rate limited)|(issue|pull request|subject) could not be read/i.test(
        w,
      ),
    )
  )
    return "failed";
  if (!subject.assignees) return "legacy";
  if (!subject.assignees.pageInfo || subject.assignees.pageInfo.hasNextPage) return "truncated";
  return "complete";
}

function partitionAssignees(nodes: readonly Assignee[]): {
  humans: string[];
  bots: string[];
  untyped: string[];
} {
  const humans: string[] = [];
  const bots: string[] = [];
  const untyped: string[] = [];
  for (const a of nodes) {
    if (!a.login) continue;
    if (a.__typename === "User") humans.push(a.login);
    else if (a.__typename === "Bot") bots.push(a.login);
    else untyped.push(a.login);
  }
  return { humans, bots, untyped };
}

/**
 * Normalize one issue or PR's direct GitHub assignee list without workflow decisions.
 */
export function normalizeSubjectAssignment(
  subject: Pick<Issue, "url" | "assignees">,
  options: AssignmentOptions = {},
): SubjectAssignment {
  const completeness = classifyCompleteness(subject, options.warnings ?? []);
  const freshness = computeFreshness(options);
  const { humans, bots, untyped } = partitionAssignees(subject.assignees?.nodes ?? []);
  const employer = options.employingHuman?.trim() || null;

  let state: AssignmentState;
  if (completeness !== "complete") {
    state = "unknown";
  } else if (employer) {
    if (humans.some((login) => login.toLowerCase() === employer.toLowerCase())) state = "matching";
    else if (untyped.length > 0) state = "unknown";
    else if (humans.length > 0) state = "other-human";
    else state = "unassigned";
  } else {
    if (untyped.length > 0) state = "unknown";
    else if (humans.length > 0) state = "assigned";
    else state = "unassigned";
  }

  return { humans, bots, untyped, completeness, state, freshness };
}

function isPullRequest(subject: Issue | PullRequest): subject is PullRequest {
  return "closingIssuesReferences" in subject && "headRefOid" in subject;
}

export interface CollectAssignmentOptions extends AssignmentOptions {
  /** Optional per-subject observation time override (e.g. from cached shortlist coverage). */
  observedAtFor?: (subject: Issue | PullRequest) => string | undefined;
}

/**
 * Collect normalized assignment evidence for an issue or pull request.
 * For pull requests, linked-issue scope uses explicit `closingIssuesReferences` only,
 * preserving missing links, truncated references, and conflicting human ownership.
 */
export function collectAssignmentEvidence(
  subject: Issue | PullRequest,
  issuesByUrl: ReadonlyMap<string, Issue>,
  options: CollectAssignmentOptions = {},
): AssignmentEvidence {
  const observedFor = (item: Issue | PullRequest): AssignmentOptions => ({
    ...options,
    observedAt: options.observedAtFor?.(item) ?? options.observedAt,
  });
  const direct = normalizeSubjectAssignment(subject, observedFor(subject));
  if (!isPullRequest(subject)) {
    return {
      subject: direct,
      linkedIssues: [],
      linkedComplete: true,
      conflict: false,
      effective: direct.state,
    };
  }

  const refs = subject.closingIssuesReferences;
  const linkedComplete =
    Boolean(refs?.pageInfo) &&
    !refs.pageInfo.hasNextPage &&
    !(options.warnings ?? []).some(
      (w) => w.startsWith(`${subject.url}:`) && /closing references/i.test(w),
    );
  const linkedIssues: LinkedIssueAssignment[] = (refs?.nodes ?? []).map((ref) => {
    const issue = issuesByUrl.get(ref.url);
    return {
      number: ref.number,
      url: ref.url,
      resolved: Boolean(issue),
      assignment: issue ? normalizeSubjectAssignment(issue, observedFor(issue)) : null,
    };
  });

  const allResolved = linkedComplete && linkedIssues.every((l) => l.resolved);
  const resolvedStates = linkedIssues
    .map((l) => l.assignment)
    .filter((a): a is SubjectAssignment => a !== null);

  // Detect conflicting human ownership across resolved linked issues (or between PR and issue).
  // Only compare sets whose account types are completely known (state !== "unknown").
  const knownHumanStates = resolvedStates.filter(
    (a) => a.completeness === "complete" && a.untyped.length === 0 && a.humans.length > 0,
  );
  const distinctHumanSets = new Set(
    knownHumanStates.map((a) =>
      a.humans
        .map((h) => h.toLowerCase())
        .sort()
        .join(","),
    ),
  );
  // Only positively established human-unassigned states (unassigned / non-human) conflict with
  // assigned states; missing account-type evidence (state === "unknown") stays unknown.
  const hasAssignedAndUnassigned =
    knownHumanStates.length > 0 && resolvedStates.some((a) => a.state === "unassigned");
  const directVsLinkedConflict =
    direct.completeness === "complete" &&
    direct.untyped.length === 0 &&
    direct.humans.length > 0 &&
    knownHumanStates.some(
      (a) =>
        a.humans
          .map((h) => h.toLowerCase())
          .sort()
          .join(",") !==
        direct.humans
          .map((h) => h.toLowerCase())
          .sort()
          .join(","),
    );
  const conflict = distinctHumanSets.size > 1 || hasAssignedAndUnassigned || directVsLinkedConflict;

  let effective: EffectiveAssignmentState;
  if (conflict) {
    effective = "conflicting";
  } else if (linkedIssues.length === 0) {
    effective = allResolved ? direct.state : "unknown";
  } else if (!allResolved || resolvedStates.some((a) => a.state === "unknown")) {
    effective = "unknown";
  } else if (resolvedStates.some((a) => a.state === "matching")) {
    effective = "matching";
  } else if (resolvedStates.some((a) => a.state === "other-human")) {
    effective = "other-human";
  } else if (resolvedStates.some((a) => a.state === "assigned")) {
    effective = "assigned";
  } else {
    effective = direct.state;
  }

  return {
    subject: direct,
    linkedIssues,
    linkedComplete: allResolved,
    conflict,
    effective,
  };
}

function subjectObservedAt(subject: Issue | PullRequest, snapshot: Snapshot): string {
  const coverage = snapshot.collection?.coverage;
  if (!coverage?.length) return snapshot.fetchedAt;
  const slug = `${snapshot.repository}#${subject.number}`;
  const direct = coverage.findLast(
    (c) => c.observedAt !== null && (c.subject === subject.url || c.subject === slug),
  );
  if (direct?.observedAt) return direct.observedAt;
  const discoverySource = isPullRequest(subject) ? "pullRequests" : "issues";
  const discovery = coverage.findLast(
    (c) =>
      c.observedAt !== null &&
      (c.source === discoverySource || c.source === "discovery") &&
      c.subject === snapshot.repository,
  );
  return discovery?.observedAt ?? snapshot.fetchedAt;
}

/** Convenience index over a collected snapshot. */
export function snapshotAssignmentEvidence(
  snapshot: Snapshot,
  options: Omit<AssignmentOptions, "warnings" | "observedAt"> & {
    source?: AssignmentFreshness["source"];
  } = {},
): Map<string, AssignmentEvidence> {
  const issuesByUrl = new Map(snapshot.issues.map((i) => [i.url, i] as const));
  const opts: CollectAssignmentOptions = {
    ...options,
    warnings: snapshot.warnings,
    observedAt: snapshot.fetchedAt,
    observedAtFor: (s) => subjectObservedAt(s, snapshot),
    source: options.source ?? "observed",
  };
  const result = new Map<string, AssignmentEvidence>();
  for (const subject of [...snapshot.issues, ...snapshot.pullRequests])
    result.set(subject.url, collectAssignmentEvidence(subject, issuesByUrl, opts));
  return result;
}
