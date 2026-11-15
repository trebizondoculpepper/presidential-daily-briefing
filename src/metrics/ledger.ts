/**
 * Per-ticket event ledger (#573, doc/design/dashboard-pipeline-metrics.md "Event ledger").
 *
 * One fold from already-collected facts (the issue's fields, its comments, its bounded label and
 * closure timeline, and its linked PRs) into an ordered list of typed events plus the coverage
 * of every source. Nothing here reads GitHub: authority is decided through an injected trust
 * boundary, and every parser is reused from the workflow modules.
 *
 * The first-pickup rule is undecided (open question 1), so both candidate sources, the claim
 * marker and a trusted `agent:` label add, are reported side by side and neither is chosen.
 * Evidence that is missing, cut off or unverifiable is reported as unknown with a reason, never
 * as absence or zero.
 */
import { OPERATION_MARKERS, parseOperationMarker } from "../github/changes.js";
import {
  actorAuthority,
  allReleases,
  claimMarkerFor,
  commentAuthority,
} from "../workflow/claims.js";
import type {
  Actor,
  Authority,
  Comment,
  HistoryEvent,
  ReleaseRecord,
  TicketHistory,
} from "../workflow/claims.js";
import { workflow } from "../workflow/definition.js";
import { classifyDeliveryRecords, foldDelivery } from "../workflow/delivery.js";
import type { DeliveryComment, DeliveryOp } from "../workflow/delivery.js";
import type { PermissionLookup } from "../github/github.js";

export const LEDGER_SCHEMA_VERSION = 1;

export interface LedgerIssue {
  repository: string;
  number: number;
  /** null when not read: the `created` event is then unknown, never absent. */
  createdAt: string | null;
  state: string;
  closedAt: string | null;
  stateReason: string | null;
}
export interface LedgerPullRequest {
  repository: string;
  number: number;
  state: string;
  mergedAt: string | null;
}
/** Facts already collected for one ticket. A null source was not read. */
export interface LedgerFacts {
  issue: LedgerIssue;
  comments: { nodes: Comment[]; complete: boolean } | null;
  history: TicketHistory | null;
  pullRequests: { nodes: LedgerPullRequest[]; complete: boolean } | null;
}
/** The injected authority boundary: who may speak through a comment or a label change. */
export interface LedgerTrust {
  comment: (c: Comment) => Promise<Authority>;
  actor: (a: Actor | null | undefined) => Promise<Authority>;
}
/** Production trust: current write permission, as claim and delivery markers already require. */
export const ledgerTrust = (permission: PermissionLookup): LedgerTrust => ({
  comment: (c) => commentAuthority(c, permission),
  actor: (a) => actorAuthority(a, "actor", permission),
});

export type PickupSource = "claim-marker" | "label";
export type LedgerEvent = { at: string; key: string } & (
  | { kind: "created"; source: "issue" }
  | { kind: "closed"; source: "issue" | "timeline"; reason: string | null }
  | { kind: "reopened"; source: "timeline" }
  | { kind: "picked-up"; source: PickupSource; agent: string | null }
  | {
      kind: "released";
      source: "release-marker";
      agent: string;
      outcome: ReleaseRecord["outcome"];
    }
  | { kind: "delivery"; source: "delivery-record"; op: DeliveryOp; agent: string }
  | { kind: "pr-merged"; source: "pull-request"; pr: { repository: string; number: number } }
);
export type CoverageState = "complete" | "partial" | "unavailable";
export interface LedgerCoverage {
  comments: CoverageState;
  timeline: CoverageState;
  deliveryRecords: CoverageState;
  prs: CoverageState;
}
/** A count that is either established from complete evidence or unknown with what was seen. */
export type LedgerCount =
  | { known: true; value: number }
  | { known: false; reason: string; observed: number };
/** The earliest trusted pickup one source shows; `none` only when that source was read in full. */
export type PickupCandidate =
  | { status: "found"; at: string; agent: string | null; key: string }
  | { status: "none" }
  | {
      status: "unknown";
      reason: string;
      observed: { at: string; agent: string | null; key: string } | null;
    };
export interface TicketLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  repository: string;
  number: number;
  observedAt: string;
  /** Oldest first; same-instant ties by comment id, then source order. */
  events: LedgerEvent[];
  /** Both candidate first pickups, by source; the rule choosing between them is undecided. */
  firstPickup: Record<PickupSource, PickupCandidate>;
  /** Releases followed by a later pickup. */
  requeues: LedgerCount;
  reopens: LedgerCount;
  /** Folded delivery membership; `unknown` when the records could not be folded. */
  membership: "complete" | "open" | null | "unknown";
  /** Required PR members of the folded set; null when the fold is unknown. */
  requiredPullRequests: { repository: string; number: number }[] | null;
  coverage: LedgerCoverage;
  /** Why evidence is missing or unknown. */
  omissions: string[];
  /** Records or label changes established as lacking authority: excluded, never unknown. */
  ignored: string[];
}

type Candidate = { at: string; agent: string | null; key: string };
/**
 * Same-instant tie order: records by comment database id (numerically, as the delivery fold
 * orders them), and events without a comment id after them.
 */
const tieOf = (key: string): number => {
  const id = /^comment:(\d+)$/.exec(key)?.[1];
  return id === undefined ? Number.MAX_SAFE_INTEGER : Number(id);
};
const time = (at: string | null | undefined): number | null => {
  if (typeof at !== "string" || !at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
};
const commentKey = (c: Comment): string =>
  typeof c.databaseId === "number" ? `comment:${c.databaseId}` : `comment-url:${c.url ?? "?"}`;
/** The same comment seen through two reads is one comment; first occurrence wins. */
function uniqueComments(comments: Comment[]): Comment[] {
  const seen = new Set<string>();
  return comments.filter((c) => {
    if (typeof c.databaseId !== "number" && !c.url) return true;
    const key = commentKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const coverageOf = (source: { complete: boolean } | null): CoverageState =>
  source === null ? "unavailable" : source.complete ? "complete" : "partial";

/**
 * The earliest trusted candidate, or unknown when an unverified one is earlier (or there is no
 * trusted one), or when the source was cut off and an earlier pickup may be unseen.
 */
function firstOf(
  trusted: Candidate[],
  unverified: { at: number | null; why: string }[],
  coverage: CoverageState,
  sourceName: string,
): PickupCandidate {
  const first =
    [...trusted].sort(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) ||
        tieOf(a.key) - tieOf(b.key) ||
        a.key.localeCompare(b.key),
    )[0] ?? null;
  if (coverage === "unavailable")
    return { status: "unknown", reason: `${sourceName} not read`, observed: first };
  const earlier = unverified.find(
    (u) => first === null || u.at === null || u.at <= Date.parse(first.at),
  );
  if (earlier)
    return {
      status: "unknown",
      reason: `an earlier ${sourceName} pickup could not be verified (${earlier.why})`,
      observed: first,
    };
  if (coverage === "partial")
    return {
      status: "unknown",
      reason: `${sourceName} was cut off, so an earlier pickup may be unseen`,
      observed: first,
    };
  return first ? { status: "found", ...first } : { status: "none" };
}

/** Folds one ticket's collected facts into its event ledger. */
export async function ticketLedger(
  facts: LedgerFacts,
  trust: LedgerTrust,
  now: Date,
): Promise<TicketLedger> {
  const { issue } = facts;
  const events: LedgerEvent[] = [];
  const omissions: string[] = [];
  const ignored: string[] = [];
  const coverage: LedgerCoverage = {
    comments: coverageOf(facts.comments),
    timeline: coverageOf(facts.history),
    deliveryRecords: facts.comments === null ? "unavailable" : "complete",
    prs: "complete",
  };
  if (coverage.comments === "partial") omissions.push("comments were cut off");
  if (coverage.comments === "unavailable") omissions.push("comments not read");
  if (coverage.timeline === "partial") omissions.push("label and closure timeline was cut off");
  if (coverage.timeline === "unavailable") omissions.push("label and closure timeline not read");

  const issueKey = `${issue.repository}#${issue.number}`;
  if (time(issue.createdAt) !== null)
    events.push({
      kind: "created",
      source: "issue",
      at: issue.createdAt!,
      key: `${issueKey}:created:${issue.createdAt}`,
    });
  else omissions.push("creation time not read");

  // Closures and reopens: the timeline when read, plus the issue's latest closure.
  const closedAt = new Set<string>();
  const history = facts.history?.events ?? [];
  const labelTrusted: Candidate[] = [];
  const labelUnverified: { at: number | null; why: string }[] = [];
  for (const e of history) {
    if (e.__typename === "ClosedEvent" || e.__typename === "ReopenedEvent") {
      if (time(e.createdAt) === null) {
        omissions.push(`${e.__typename} without a timestamp`);
        continue;
      }
      if (e.__typename === "ClosedEvent") {
        closedAt.add(e.createdAt);
        events.push({
          kind: "closed",
          source: "timeline",
          at: e.createdAt,
          reason: e.stateReason ?? null,
          key: `${issueKey}:closed:${e.createdAt}`,
        });
      } else
        events.push({
          kind: "reopened",
          source: "timeline",
          at: e.createdAt,
          key: `${issueKey}:reopened:${e.createdAt}`,
        });
      continue;
    }
    if (e.__typename !== "LabeledEvent" || !e.label.name.startsWith(workflow.ownerPrefix)) continue;
    if (time(e.createdAt) === null) {
      labelUnverified.push({ at: null, why: "label event has no timestamp" });
      continue;
    }
    const label = labelPickup(e, issueKey);
    const authority = await trust.actor(e.actor);
    if (authority.status === "trusted") labelTrusted.push(label);
    else if (authority.status === "untrusted")
      ignored.push(`label ${e.label.name} added at ${e.createdAt} (${authority.why})`);
    else labelUnverified.push({ at: time(e.createdAt), why: authority.why });
  }
  if (issue.closedAt && time(issue.closedAt) !== null && !closedAt.has(issue.closedAt))
    events.push({
      kind: "closed",
      source: "issue",
      at: issue.closedAt,
      reason: issue.stateReason,
      key: `${issueKey}:closed:${issue.closedAt}`,
    });
  for (const l of labelTrusted)
    events.push({ kind: "picked-up", source: "label", at: l.at, agent: l.agent, key: l.key });

  // Claim and release markers.
  const comments = uniqueComments(facts.comments?.nodes ?? []);
  const markerTrusted: Candidate[] = [];
  const markerUnverified: { at: number | null; why: string }[] = [];
  for (const c of comments) {
    if (!c.body.includes(OPERATION_MARKERS[0]!)) continue;
    const parsed = parseOperationMarker(c.body);
    if (parsed?.operation !== "claim") continue;
    const authority = await trust.comment(c);
    if (authority.status === "untrusted") {
      ignored.push(`claim marker ${commentKey(c)} (${authority.why})`);
      continue;
    }
    if (authority.status === "unknown" || time(c.createdAt) === null) {
      markerUnverified.push({
        at: time(c.createdAt),
        why: authority.status === "unknown" ? authority.why : "comment has no creation time",
      });
      continue;
    }
    // The reported agent counts only when it reproduces the marker's hash.
    const agent =
      parsed.agent !== null &&
      c.body.includes(claimMarkerFor(issue.repository, issue.number, parsed.agent))
        ? parsed.agent
        : null;
    markerTrusted.push({ at: c.createdAt!, agent, key: commentKey(c) });
  }
  for (const m of markerTrusted)
    events.push({
      kind: "picked-up",
      source: "claim-marker",
      at: m.at,
      agent: m.agent,
      key: m.key,
    });

  const releases: { at: string; key: string }[] = [];
  let releasesUnverified = 0;
  for (const r of allReleases(comments)) {
    const c = r.comment!;
    const authority = await trust.comment(c);
    if (authority.status === "untrusted") {
      ignored.push(`release marker ${commentKey(c)} (${authority.why})`);
      continue;
    }
    if (authority.status === "unknown" || time(r.createdAt) === null) {
      releasesUnverified++;
      omissions.push(
        `release marker ${commentKey(c)} could not be verified (${authority.status === "unknown" ? authority.why : "no creation time"})`,
      );
      continue;
    }
    releases.push({ at: r.createdAt, key: commentKey(c) });
    events.push({
      kind: "released",
      source: "release-marker",
      at: r.createdAt,
      agent: r.agent,
      outcome: r.outcome,
      key: commentKey(c),
    });
  }

  const firstPickup: Record<PickupSource, PickupCandidate> = {
    "claim-marker": firstOf(markerTrusted, markerUnverified, coverage.comments, "claim marker"),
    label: firstOf(labelTrusted, labelUnverified, coverage.timeline, "agent: label"),
  };

  // A requeue is a release followed by a later pickup from either source.
  // Ordered as the ledger orders events: creation time, then numeric comment id.
  const follows = (p: { at: string; key: string }, r: { at: string; key: string }): boolean =>
    (Date.parse(p.at) - Date.parse(r.at) || tieOf(p.key) - tieOf(r.key)) > 0;
  const pickups = [...markerTrusted, ...labelTrusted];
  const requeued = releases.filter((r) => pickups.some((p) => follows(p, r))).length;
  const undecided = releases.length - requeued;
  const requeueGap =
    coverage.comments !== "complete"
      ? "comments were not read in full"
      : releasesUnverified || markerUnverified.length
        ? "some claim or release markers could not be verified"
        : undecided && coverage.timeline !== "complete"
          ? "a release has no later claim marker and the label timeline was not read in full"
          : labelUnverified.some((u) =>
                releases.some((r) => u.at === null || u.at >= Date.parse(r.at)),
              )
            ? "a later label add could not be verified"
            : null;
  const requeues: LedgerCount = requeueGap
    ? { known: false, reason: requeueGap, observed: requeued }
    : { known: true, value: requeued };

  const reopenCount = events.filter((e) => e.kind === "reopened").length;
  const reopens: LedgerCount =
    coverage.timeline === "complete"
      ? { known: true, value: reopenCount }
      : {
          known: false,
          reason:
            coverage.timeline === "unavailable"
              ? "closure timeline not read"
              : "closure timeline was cut off",
          observed: reopenCount,
        };

  // Delivery records, through the existing trust classification and fold.
  let membership: TicketLedger["membership"] = "unknown";
  let requiredPullRequests: TicketLedger["requiredPullRequests"] = null;
  if (facts.comments !== null) {
    const classified = await classifyDeliveryRecords(
      comments as DeliveryComment[],
      { repository: issue.repository, issue: issue.number },
      trust.comment,
    );
    const fold = foldDelivery(classified, facts.comments.complete);
    ignored.push(...fold.ignored);
    const createdById = new Map(comments.map((c) => [String(c.databaseId), c.createdAt] as const));
    for (const a of fold.applied) {
      const at = createdById.get(a.comment);
      if (time(at) === null) continue;
      events.push({
        kind: "delivery",
        source: "delivery-record",
        op: a.op,
        agent: a.agent,
        at: at!,
        key: `comment:${a.comment}`,
      });
    }
    if (fold.recordsUnknown) {
      coverage.deliveryRecords = "partial";
      omissions.push(...fold.unknownBecause);
    } else {
      membership = fold.membership;
      requiredPullRequests = fold.members.flatMap((m) =>
        m.deliverable.kind === "pr"
          ? [{ repository: m.deliverable.repository, number: m.deliverable.number }]
          : [],
      );
    }
  }

  // Merges of required PR members only; each PR once.
  if (facts.pullRequests === null) {
    coverage.prs = "unavailable";
    if (requiredPullRequests?.length) omissions.push("required pull requests not read");
  } else {
    if (!facts.pullRequests.complete) coverage.prs = "partial";
    for (const member of requiredPullRequests ?? []) {
      const pr = facts.pullRequests.nodes.find(
        (p) =>
          p.number === member.number &&
          p.repository.toLowerCase() === member.repository.toLowerCase(),
      );
      const name = `${member.repository}#${member.number}`;
      if (!pr) {
        coverage.prs = "partial";
        omissions.push(`required pull request ${name} not read`);
      } else if (pr.mergedAt && time(pr.mergedAt) !== null)
        events.push({
          kind: "pr-merged",
          source: "pull-request",
          at: pr.mergedAt,
          pr: member,
          key: `${name}:merged`,
        });
    }
  }

  // One event per source identity, then oldest first with a stable tie order.
  const unique = new Map<string, LedgerEvent>();
  for (const e of events) {
    const id = `${e.kind}:${e.source}:${e.key}`;
    if (!unique.has(id)) unique.set(id, e);
  }
  const ordered = [...unique.values()]
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        Date.parse(a.e.at) - Date.parse(b.e.at) || tieOf(a.e.key) - tieOf(b.e.key) || a.i - b.i,
    )
    .map(({ e }) => e);

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    repository: issue.repository,
    number: issue.number,
    observedAt: now.toISOString(),
    events: ordered,
    firstPickup,
    requeues,
    reopens,
    membership,
    requiredPullRequests,
    coverage,
    omissions,
    ignored,
  };
}

function labelPickup(
  e: Extract<HistoryEvent, { __typename: "LabeledEvent" | "UnlabeledEvent" }>,
  issueKey: string,
): Candidate {
  return {
    at: e.createdAt,
    agent: e.label.name.slice(workflow.ownerPrefix.length) || null,
    key: `${issueKey}:labeled:${e.label.name}:${e.createdAt}`,
  };
}
