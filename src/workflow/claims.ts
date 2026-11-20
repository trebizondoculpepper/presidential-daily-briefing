/**
 * Claim and human-question commands (#2). Contract: doc/design/workflow.md, "One active
 * contribution", "Human questions" and "Actionable refusals".
 *
 * Each command reads live state first, plans its changes, and either refuses with a stable
 * error ID, facts, the failed prerequisite and recovery commands, or applies the plan through
 * the injected `gh` write boundary. Label names come from the registered workflow policy.
 */
import { createHash } from "node:crypto";
import {
  classifyMarkers,
  foldQuestionResolutions,
  parseResolutionComment,
  resolutionMarker,
  resolutionProblem,
} from "./claimactivity.js";
import type { QuestionResolutionRecord } from "./claimactivity.js";
import { evaluateClaimAdmission } from "../rules/datalog/engine.js";
import type { ClaimAdmissionInput } from "../rules/datalog/engine.js";
import { workflow } from "./definition.js";
import { ghQuery, permissionLookup, writePermissions } from "../github/github.js";
import type { PermissionLookup } from "../github/github.js";
import { ghRun } from "../github/dependencies.js";
import { ticketReads } from "../github/service/tickets.js";
import { issueWrites, WRITE, writeCommand } from "../github/service/issuewrites.js";
import type { IssueWrite } from "../github/service/issuewrites.js";
import type { TicketReads } from "../github/service/tickets.js";
import { CommentWriteError } from "../github/commentwrite.js";
import type { CommentCallOptions, CommentRecovery } from "../github/commentwrite.js";

const labelColours: Record<string, string> = {
  agent: "1d76db",
  "design:decision-needed": "d93f0b",
  "status:incomplete": "fbca04",
  "status:awaiting-review": "5319e7",
  "status:ready": "0e8a16",
};

/** Labels these commands use, beyond the briefing's existing policy. */
export const claimPolicy = {
  owner: (agent: string): string => `${workflow.ownerPrefix}${agent}`,
  /** An addressed response request (doc/design/briefings.md); never a claim. */
  attention: (name: string): string => `attention:${name}`,
  /** Deliberate non-pickup states that a stale ready label must not override. */
  held: [workflow.blocked, workflow.parked],
  pickable: [workflow.ready, "status:incomplete"],
  incomplete: "status:incomplete",
  /** A handed-over contribution with an open PR: out of implementation pickup (#62). */
  awaitingReview: "status:awaiting-review",
  /** Release outcomes (#62); parked is a synonym for incomplete, never `status:parked`. */
  outcomes: ["ready", "incomplete", "parked", "done"] as const,
  /** Bounded handoff note length. */
  maxNote: 4000,
  needsDesign: "status:needs-design",
  decisionNeeded: "design:decision-needed",
  question: "question",
  platformPrefix: "platform:",
  questionsHeading: "### Questions for the designer",
  labelColours,
};

export interface PlanStep {
  step: string;
  /** Display form of the write (dry runs, JSON, recovery); generated from the typed write. */
  command: string[];
  /** The typed write this step performs (#942): not serialized. */
  [WRITE]?: IssueWrite;
  status?: string;
  reason?: string;
  /** A comment write that did not end posted: its bounded recovery details (#345). */
  recovery?: CommentRecovery;
}

/** A plan step for one typed write: its display command is generated from the same value. */
export const writeStep = (step: string, op: IssueWrite): PlanStep => ({
  step,
  command: writeCommand(op),
  [WRITE]: op,
});

/** Record a failed write on its step, keeping a comment write's recovery details (#345). */
export function failStep(step: PlanStep, error: unknown): void {
  step.status = "failed";
  step.reason = error instanceof Error ? error.message : undefined;
  if (error instanceof CommentWriteError) step.recovery = error.recovery;
}

/**
 * The retry line for a partial result: when a comment was throttled, say so and when to retry
 * (#345) instead of the generic re-run hint; otherwise the command's own hint.
 */
export function retryLine(steps: readonly PlanStep[], generic: string, retry: string): string {
  const throttled = steps.find((s) => s.recovery?.status === "throttled")?.recovery;
  if (throttled?.retryAt)
    return `Throttled by GitHub: re-run after ${throttled.retryAt}${throttled.defaultDelay ? " (default delay; no retry time was reported)" : ""}; it completes only the missing steps: ${retry}`;
  const uncertain = steps.find((s) => s.recovery?.acceptance === "unknown");
  if (uncertain)
    return `The comment may already be posted: inspect the ticket before re-running: ${retry}`;
  return `${generic}: ${retry}`;
}
/** Facts reported with a plan or refusal; which fields are present depends on the outcome. */
export interface ClaimFacts {
  number: number;
  url?: string;
  title?: string;
  state?: string;
  labels?: string[];
  owners?: string[];
  activeClaims?: { number: number; url: string }[];
  openBlockers?: string[];
  pullRequests?: string[];
  platforms?: string[];
  platform?: string | null;
  /** release: the explicit outcome, deliverable and its verified state. */
  outcome?: string;
  deliverable?: string | null;
  pullRequestState?: string | null;
  target?: string | null;
}
export interface ClaimRefusal {
  ok: false;
  error: string;
  facts: ClaimFacts;
  prerequisite: string;
  recovery: string[];
}
export interface ClaimAccepted {
  ok: true;
  facts: ClaimFacts;
  noop: boolean;
  reason?: string;
  changes: PlanStep[];
  notes?: string[];
  recheck?: {
    agent: string;
    release?: { target: string | null };
    /** Other claims admitted because each was verified waiting (#412); rechecked after writes. */
    waiting?: number[];
  };
  /** Exact command that safely retries or completes this operation. */
  retry?: string;
  /** claim wait/resume: the appended record's operation id, verified after the write (#412). */
  activityOpId?: string;
  /** needs-human: the question's operation id, which a retained wait binds to (#412). */
  questionOpId?: string;
  /** needs-human: whether the caller holds the claim and keeps it (#412). */
  retainsClaim?: boolean;
}
export type ClaimPlan = ClaimRefusal | ClaimAccepted;
export type ClaimResult =
  | (ClaimRefusal & {
      exitCode: number;
      steps?: undefined;
      conflict?: undefined;
      unverified?: undefined;
    })
  | (ClaimAccepted & {
      steps: PlanStep[];
      conflict: string | null;
      /** Writes done but the post-write re-read was missing or truncated: not verified. */
      unverified: string | null;
      exitCode: number;
    });

/** The injected GraphQL read boundary (production: `ghQuery`). */
export type GraphQuery = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<unknown>;
/** The injected `gh` write boundary (production: `ghRun`). */
export type GhRun = (args: string[], call?: CommentCallOptions) => Promise<unknown>;

/**
 * A fresh-state guard for a throttled workflow comment (#345): the issue's state, labels,
 * assignees and comment count, read again through the command's own query. A change between the
 * refusal and the retry (claimed elsewhere, closed, relabelled, a record appeared) stops it.
 */
export function ticketGuard(
  repository: string,
  number: number,
  query: GraphQuery | (Pick<TicketReads, "guardState"> & Partial<TicketReads>),
): () => Promise<string> {
  // The typed, validated guard read (#942): a malformed answer fails the guard.
  return () =>
    typeof query === "function"
      ? ticketReads(query).guardState(repository, number)
      : query.guardState(repository, number);
}

/**
 * The typed ticket capabilities (#942): the application facade's `tickets` group when injected,
 * else the same capability over the caller's executor (compatibility while callers migrate).
 */
const ticketsOver = (source: GraphQuery | TicketReads): TicketReads =>
  typeof source === "function" ? ticketReads(source) : source;

export interface ClaimRequest {
  number: number;
  agent: string;
  branch?: string | null;
  platform?: string | null;
  /**
   * Explicit review-rework reclaim (doc/design/workflow.md "Focused handoff"): accepted only on
   * an awaiting-review issue with an open PR whose latest recorded handoff is the caller's own
   * `done` release. Never makes awaiting-review work generally pickable.
   */
  rework?: boolean;
}
/**
 * How `claim --rework` is authorised (doc/design/delivery-lifecycle.md "Rework authority"),
 * decided from the delivery records by an injected reader: `legacy` when the issue has no trusted
 * delivery record (the v1 done-handoff rule applies), `delivery` when the caller is
 * ticket-responsible on the trusted fold, or a refusal (never a fallback to the v1 rule).
 */
export type ReworkAuthority =
  | { path: "legacy" }
  | { path: "delivery" }
  | { refusal: { error: string; prerequisite: string; recovery: string[] } };

/**
 * Adoption facts for a claim on released work (#1019): read by an injected host reader and
 * passed unchanged to the native claim admission, which alone decides `adoptable`.
 */
export type ClaimAdoptionFacts = Pick<
  ClaimAdmissionInput,
  "release" | "ticketResponsible" | "responsibilityUnknown"
>;

/**
 * The retained-claim admission guard (#412, doc/design/blocked-retained-claims.md), injected so
 * this module needs no activity reader: given the agent's other open claims, either every one is
 * verified waiting (the exception, with a line per claim) or the reasons it is not.
 */
export type Admission = (
  others: { number: number; url: string }[],
) => Promise<{ ok: true; waiting: string[] } | { ok: false; why: string[] }>;

export type ReleaseOutcome = (typeof claimPolicy.outcomes)[number];
export interface ReleaseRequest {
  number: number;
  agent: string;
  outcome: ReleaseOutcome;
  note?: string | null;
  pr?: string | null;
  change?: string | null;
}
export interface NeedsHumanRequest {
  number: number;
  agent: string;
  designer: string;
  why: string;
  questions: string[];
  /** Relinquish the caller's claim after recording the question (#412); kept by default. */
  release?: boolean;
}

type Labels = { nodes: { name: string }[]; pageInfo?: { hasNextPage: boolean } };
export interface TicketIssue {
  __typename: "Issue";
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: Labels;
  issueDependenciesSummary: { blockedBy: number } | null;
  blockedBy: { nodes: { number: number; url: string; state: string }[] };
  closedByPullRequestsReferences: {
    nodes: { number: number; url: string; state: string }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: { nodes: Comment[]; pageInfo?: CommentPageInfo };
  timelineItems?: {
    nodes: LabelEvent[];
    pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  };
}
/**
 * An issue comment. Author and edit evidence (#212) decide whether a marker in it may drive a
 * write; `undefined` means the field was not read, which is missing evidence.
 */
export type Comment = {
  body: string;
  /** Numeric comment id (question/resolution binding, #412). */
  databaseId?: number;
  url?: string;
  createdAt?: string;
  author?: Actor | null;
  lastEditedAt?: string | null;
  includesCreatedEdit?: boolean;
  editor?: Actor | null;
};
export type Actor = { __typename?: string; login?: string };
type CommentPageInfo = { hasPreviousPage?: boolean; startCursor?: string | null };
type LabelEvent = { __typename?: string; createdAt?: string; label?: { name: string } };

/**
 * Whether a marker comment may drive a write (#212, doc/design/triage-efficiency-and-trust.md
 * "Message visibility is distinct from authority"): its author is a user with current write,
 * maintain or admin permission, and any edit was made by such a user. `untrusted` is established
 * as lacking authority (ignored, with a warning); `unknown` could not be established (refused).
 */
export type Authority = { status: "trusted" } | { status: "untrusted" | "unknown"; why: string };
export async function actorAuthority(
  actor: Actor | null | undefined,
  role: string,
  permission: PermissionLookup,
): Promise<Authority> {
  if (actor === undefined) return { status: "unknown", why: `${role} not read` };
  if (actor === null || !actor.login)
    return { status: "untrusted", why: `${role} is a deleted or unknown account` };
  if (actor.__typename === undefined)
    return { status: "unknown", why: `${role} ${actor.login} has no account type` };
  // Apps and bots get no marker authority: a shared integration never speaks for an agent.
  if (actor.__typename !== "User" || actor.login.endsWith("[bot]"))
    return { status: "untrusted", why: `${role} ${actor.login} is an app or bot account` };
  const level = await permission(actor.login);
  if (level === "unknown")
    return {
      status: "unknown",
      why: `${role} ${actor.login}'s repository permission could not be verified`,
    };
  return writePermissions.has(level)
    ? { status: "trusted" }
    : { status: "untrusted", why: `${role} ${actor.login} has ${level} permission, not write` };
}
export async function commentAuthority(
  c: Comment,
  permission: PermissionLookup,
): Promise<Authority> {
  const author = await actorAuthority(c.author, "author", permission);
  if (author.status !== "trusted") return author;
  if (c.lastEditedAt === undefined || c.includesCreatedEdit === undefined)
    return { status: "unknown", why: "edit history not read" };
  if (!c.lastEditedAt && !c.includesCreatedEdit) return { status: "trusted" };
  // Edited: GitHub exposes only the last editor. Only the author or a user with write access can
  // edit a comment, so a trusted author and a trusted last editor leave no untrusted edit.
  if (!c.editor?.login)
    return { status: "unknown", why: "edited, and who edited it cannot be established" };
  if (c.editor.login === c.author?.login) return { status: "trusted" };
  return actorAuthority(c.editor, "editor", permission);
}
/** A marker comment's authority, partitioned for the caller (newest first). */
interface MarkerVerdicts<T> {
  trusted: T | null;
  /** Newer than `trusted` and not established either way: refuse rather than guess. */
  unverified: string[];
  /** Established as lacking authority: ignored and named in a warning. */
  ignored: string[];
}
/**
 * The newest trusted candidate, checking newest first and stopping there, so permission lookups
 * are bounded by the distinct authors (and editors) of the markers newer than it.
 */
export async function newestTrusted<T>(
  candidates: T[],
  comment: (c: T) => Comment,
  permission: PermissionLookup,
): Promise<MarkerVerdicts<T>> {
  const verdicts: MarkerVerdicts<T> = { trusted: null, unverified: [], ignored: [] };
  for (const candidate of [...candidates].reverse()) {
    const c = comment(candidate);
    const authority = await commentAuthority(c, permission);
    if (authority.status === "trusted") {
      verdicts.trusted = candidate;
      break;
    }
    const what = `marker comment${c.createdAt ? ` at ${c.createdAt}` : ""} (${authority.why})`;
    (authority.status === "unknown" ? verdicts.unverified : verdicts.ignored).push(what);
  }
  return verdicts;
}
const ignoredNote = (ignored: string[]): string[] =>
  ignored.length ? [`Ignored marker(s) without write authority: ${ignored.join("; ")}.`] : [];
const markerRecovery = "a maintainer must re-post or confirm the handoff on the ticket";

const markerId = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
const marker = (kind: string, parts: unknown[]): string =>
  `<!-- github-triage:${kind}:${markerId(parts)} -->`;
/** The claim marker `pdb claim` posts for this agent on this ticket (verifies a reported agent). */
export const claimMarkerFor = (repository: string, number: number, agent: string): string =>
  marker("claim", [repository, number, agent]);

/** Prefix of every needs-human question marker, v1 and v2. */
export const questionMarkerPrefix = "<!-- github-triage:needs-human:";
/**
 * The v2 question marker: the operation id, then a JSON binding to the repository and issue and
 * `resolution: "explicit"`. Such a question stays open until an explicit resolve or withdraw,
 * whether its asker kept or released the claim; label removal does not answer it.
 */
export const questionMarker = (opId: string, repository: string, issue: number): string =>
  `${questionMarkerPrefix}${opId} v2 ${JSON.stringify({ v: 2, repository, issue, resolution: "explicit" })} -->`;

export type ParsedQuestionMarker =
  /** Legacy: label removal keeps its compatibility meaning. */
  | { version: 1; opId: string }
  | { version: 2; opId: string; repository: string; issue: number }
  | { version: "malformed"; opId: string | null; why: string };

/**
 * Read a needs-human marker of either version; null when the comment has none. A v2 binding
 * must be complete and exact; anything else is malformed, never read as legacy.
 */
export function parseQuestionMarker(body: string): ParsedQuestionMarker | null {
  const at = body.indexOf(questionMarkerPrefix);
  if (at < 0) return null;
  const rest = body.slice(at + questionMarkerPrefix.length);
  const id = /^([0-9a-f]{16})( -->| v2 )/.exec(rest);
  if (!id) return { version: "malformed", opId: null, why: "marker has no operation id" };
  if (id[2] === " -->") return { version: 1, opId: id[1]! };
  const end = rest.indexOf(" -->", id[0].length);
  if (end < 0) return { version: "malformed", opId: id[1]!, why: "marker is not terminated" };
  let payload: unknown;
  try {
    payload = JSON.parse(rest.slice(id[0].length, end));
  } catch {
    return { version: "malformed", opId: id[1]!, why: "binding is not JSON" };
  }
  const p = payload as Record<string, unknown>;
  const ok =
    typeof p === "object" &&
    p !== null &&
    Object.keys(p).sort().join() === "issue,repository,resolution,v" &&
    p.v === 2 &&
    p.resolution === "explicit" &&
    typeof p.repository === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(p.repository) &&
    typeof p.issue === "number" &&
    Number.isSafeInteger(p.issue) &&
    p.issue > 0;
  return ok
    ? { version: 2, opId: id[1]!, repository: p.repository as string, issue: p.issue as number }
    : {
        version: "malformed",
        opId: id[1]!,
        why: "binding is not {v:2, repository, issue, resolution:explicit}",
      };
}

/** A release's durable intent, recorded in its handoff comment before labels change. */
export interface ReleaseRecord {
  v: 1;
  agent: string;
  outcome: ReleaseOutcome;
  target: string | null;
  remove: string[];
  retained: string[];
  claimedAt: string | null;
  /** The comment's creation time (from GitHub; not serialised). */
  createdAt: string;
  /** The comment carrying the record (not serialised); its author decides its authority. */
  comment?: Comment;
}
/** Marker plus JSON plan; `<`/`>` are escaped so the HTML comment cannot be terminated early. */
const releaseMarker = (op: string, record: ReleaseRecord): string => {
  const { createdAt: _, comment: __, ...plan } = record;
  const json = JSON.stringify(plan).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return op.replace(/ -->$/, ` ${json} -->`);
};
function releaseRecords(comments: Comment[], op: string): ReleaseRecord[] {
  const prefix = op.replace(/ -->$/, " ");
  const records: ReleaseRecord[] = [];
  for (const c of comments) {
    const at = c.body.indexOf(prefix);
    if (at < 0) continue;
    const endAt = c.body.indexOf(" -->", at + prefix.length);
    try {
      const r = JSON.parse(c.body.slice(at + prefix.length, endAt)) as ReleaseRecord;
      if (r.v === 1 && Array.isArray(r.remove) && Array.isArray(r.retained))
        records.push({ ...r, createdAt: c.createdAt ?? "", comment: c });
    } catch {
      // Not a parsable record: never treated as authorisation.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** Every parsable release record on the issue, oldest first, whoever made it. */
export function allReleases(comments: Comment[]): ReleaseRecord[] {
  const records: ReleaseRecord[] = [];
  for (const c of comments) {
    for (const m of c.body.matchAll(/<!-- github-triage:release:[0-9a-f]+ /g)) {
      const start = m.index + m[0].length;
      const end = c.body.indexOf(" -->", start);
      try {
        const r = JSON.parse(c.body.slice(start, end)) as ReleaseRecord;
        if (r.v === 1 && typeof r.agent === "string")
          records.push({ ...r, createdAt: c.createdAt ?? "", comment: c });
      } catch {
        // Not a parsable record: never treated as authorisation.
      }
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** The most recent parsable release record, whoever made it: a hint only, never authority. */
const latestRelease = (comments: Comment[]): ReleaseRecord | null =>
  allReleases(comments).at(-1) ?? null;
function labelSteps(
  repository: string,
  number: number,
  add: string[],
  remove: string[],
  repoLabels: Set<string>,
): PlanStep[] {
  const changes: PlanStep[] = add
    .filter((l) => !repoLabels.has(l))
    .map((name) =>
      writeStep("create-label", {
        kind: "label-create",
        repository,
        name,
        color: claimPolicy.labelColours[name] ?? "ededed",
      }),
    );
  if (add.length || remove.length)
    changes.push(writeStep("labels", { kind: "labels-edit", repository, number, add, remove }));
  return changes;
}

/** Older label-event pages read at most, so a long label history costs a bounded number of requests. */
const claimHistoryPages = 3;
/**
 * When `ownerLabel` was last added: the identity of the caller's current claim. Pages backwards
 * through label history (bounded) when the add event is not in `readTicket`'s window. `since` is
 * null when no add event was found; `complete` says whether the whole history was searched, so a
 * null there is a genuine absence rather than unknown evidence.
 */
export async function claimStart(
  repository: string,
  number: number,
  ownerLabel: string,
  item: TicketIssue,
  query: GraphQuery | TicketReads,
): Promise<{ since: string | null; complete: boolean; events: LabelEvent[] }> {
  const tickets = ticketsOver(query);
  const latestAdd = (events: LabelEvent[]): string | null =>
    events
      .filter(
        (e) => e.__typename !== "UnlabeledEvent" && e.label?.name === ownerLabel && e.createdAt,
      )
      .map((e) => e.createdAt!)
      .sort((a, b) => a.localeCompare(b))
      .at(-1) ?? null;
  let events = item.timelineItems?.nodes ?? [];
  let info = item.timelineItems?.pageInfo;
  let since = latestAdd(events);
  for (
    let pageNo = 0;
    !since && info?.hasPreviousPage && info.startCursor && pageNo < claimHistoryPages;
    pageNo++
  ) {
    const older = await tickets.labelTimelinePage(repository, number, info.startCursor);
    if (!older) break;
    events = [...older.nodes, ...events];
    info = older.pageInfo;
    since = latestAdd(older.nodes);
  }
  return { since, complete: !info?.hasPreviousPage, events };
}

/**
 * One event of a ticket's label and closure history (#573), with the actor whose authority
 * decides whether a label add counts as a pickup. `actor` undefined means it was not read.
 */
export type HistoryEvent =
  | {
      __typename: "LabeledEvent" | "UnlabeledEvent";
      createdAt: string;
      label: { name: string };
      actor?: Actor | null;
    }
  | {
      __typename: "ClosedEvent";
      createdAt: string;
      stateReason?: string | null;
      actor?: Actor | null;
    }
  | { __typename: "ReopenedEvent"; createdAt: string; actor?: Actor | null };
/** A bounded read of a ticket's label and closure timeline. */
export interface TicketHistory {
  /** Oldest first. */
  events: HistoryEvent[];
  /** False when older pages remain past the bound or a page could not be read. */
  complete: boolean;
  /** Requests made, at most 1 + `claimHistoryPages`. */
  pages: number;
}
/**
 * A ticket's label and closure timeline (`LabeledEvent`, `UnlabeledEvent`, `ClosedEvent`,
 * `ReopenedEvent`), newest page first and then backwards within the same bound as `claimStart`.
 * `complete: false` means earlier events may exist unseen: closures and pickups before the
 * oldest event read are unknown, never absent.
 */
export async function ticketHistory(
  repository: string,
  number: number,
  query: GraphQuery | TicketReads,
): Promise<TicketHistory> {
  const tickets = ticketsOver(query);
  const first = await tickets.historyTimelinePage(repository, number, null);
  if (!first) return { events: [], complete: false, pages: 1 };
  let events = first.nodes;
  let info = first.pageInfo;
  let pages = 1;
  for (let pageNo = 0; info?.hasPreviousPage && pageNo < claimHistoryPages; pageNo++) {
    if (!info.startCursor) break;
    const older = await tickets.historyTimelinePage(repository, number, info.startCursor);
    pages++;
    if (!older) return { events, complete: false, pages };
    events = [...older.nodes, ...events];
    info = older.pageInfo;
  }
  return { events, complete: !info?.hasPreviousPage, pages };
}

/** Older comment pages read at most, so a long discussion costs a bounded number of requests. */
const commentHistoryPages = 5;
/**
 * The issue's comments, paged backwards from `readTicket`'s newest window until `enough` holds
 * for the comments read so far (or history starts), within a bounded number of requests.
 * `complete` is false when the bound was hit first: the needed comments may be unseen, so their
 * absence is unknown evidence, never "nothing there".
 */
export async function commentHistory(
  repository: string,
  number: number,
  item: TicketIssue,
  enough: (comments: Comment[]) => boolean | Promise<boolean>,
  query: GraphQuery | TicketReads,
): Promise<{ comments: Comment[]; complete: boolean }> {
  const tickets = ticketsOver(query);
  let comments = item.comments.nodes;
  let info = item.comments.pageInfo;
  for (let pageNo = 0; info?.hasPreviousPage && !(await enough(comments)); pageNo++) {
    if (!info.startCursor || pageNo >= commentHistoryPages) return { comments, complete: false };
    const older = await tickets.commentPage(repository, number, info.startCursor);
    if (!older) return { comments, complete: false };
    comments = [...older.nodes, ...comments];
    info = older.pageInfo;
  }
  return { comments, complete: true };
}
/** Enough history once the oldest comment read predates `since` (the claim start). */
export const reaches =
  (since: string) =>
  (comments: Comment[]): boolean =>
    comments.some((c) => !!c.createdAt && c.createdAt < since);

/** Live read of one ticket plus the agent's open claims. */
export async function readTicket(
  repository: string,
  number: number,
  agent: string,
  query: GraphQuery | TicketReads,
  designer = "",
  target = "",
) {
  return ticketsOver(query).readTicket(repository, number, {
    owner: claimPolicy.owner(agent),
    question: claimPolicy.question,
    decisionNeeded: claimPolicy.decisionNeeded,
    needsDesign: claimPolicy.needsDesign,
    attention: designer ? claimPolicy.attention(designer) : "",
    ...(target ? { target } : {}),
  });
}

/**
 * A refusal: stable ID, current facts, failed prerequisite, recovery commands. Recovery only
 * names implemented commands; anything else is marked as a manual step.
 */
export const refuse = (
  error: string,
  facts: ClaimFacts,
  prerequisite: string,
  recovery: string[] = [],
): ClaimRefusal => ({
  ok: false,
  error,
  facts,
  prerequisite,
  recovery,
});

const label = (item: { labels: Labels }, name: string): boolean =>
  item.labels.nodes.some((l) => l.name === name);
const owners = (item: { labels: Labels }): string[] =>
  item.labels.nodes.map((l) => l.name).filter((n) => n.startsWith(workflow.ownerPrefix));

/**
 * Plan `claim N --agent NAME`. Reads only.
 */
export async function planClaim(
  repository: string,
  request: ClaimRequest,
  query: GraphQuery | TicketReads = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
  reworkAuthority?: () => Promise<ReworkAuthority>,
  admission?: Admission,
  adoption?: () => Promise<ClaimAdoptionFacts | undefined>,
): Promise<ClaimPlan> {
  const exception: { waiting: number[]; notes: string[] } = { waiting: [], notes: [] };
  const plan = await planClaimFor(
    repository,
    request,
    query,
    permission,
    reworkAuthority,
    admission,
    exception,
    adoption,
  );
  if (!plan.ok || !exception.waiting.length) return plan;
  return {
    ...plan,
    notes: [...exception.notes, ...(plan.notes ?? [])],
    ...(plan.recheck ? { recheck: { ...plan.recheck, waiting: exception.waiting } } : {}),
  };
}

async function planClaimFor(
  repository: string,
  request: ClaimRequest,
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
  reworkAuthority: (() => Promise<ReworkAuthority>) | undefined,
  admission: Admission | undefined,
  exception: { waiting: number[]; notes: string[] },
  adoption?: () => Promise<ClaimAdoptionFacts | undefined>,
): Promise<ClaimPlan> {
  const { number, agent, branch = null, platform = null, rework = false } = request;
  const { item, claims, claimsComplete, repoLabels } = await readTicket(
    repository,
    number,
    agent,
    query,
  );
  const triage = `pdb --repo ${repository}`;
  // Subcommands are dispatched on the first argument, so they must precede options.
  const command = (text: string): string => `pdb ${text} --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Only issues can be claimed; a pull request is reviewed or fixed, not claimed.",
      [`${triage} --issue ${number}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  } satisfies ClaimFacts;
  const mine = claimPolicy.owner(agent);
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Only an open ticket can be claimed.", [`${triage}`]);
  // Ownership is decided from the complete label set only.
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; ownership and readiness cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  const others = facts.owners.filter((o) => o !== mine);
  if (others.length)
    return refuse(
      "OWNED_BY_OTHER",
      facts,
      `Already claimed by ${others.join(", ")}; never take over another agent's claim.`,
      [`${triage} --agent ${agent}`],
    );
  const ownOther = claims.filter((c) => c.number !== number);
  // A retained claim admits another only when every other one is verified waiting on fresh,
  // complete evidence (#412); anything else keeps the one-active-claim refusal.
  let verdict: Awaited<ReturnType<Admission>> | null = null;
  if (ownOther.length && admission) {
    verdict = claimsComplete
      ? await admission(ownOther)
      : { ok: false, why: [`${agent}'s open claims could not be read completely`] };
    if (verdict.ok) {
      exception.waiting = ownOther.map((c) => c.number);
      exception.notes = [
        `Admitted while retaining ${ownOther.length === 1 ? "a claim" : "claims"} verified waiting: ${verdict.waiting.join("; ")}.`,
      ];
    }
  }
  if (ownOther.length && !verdict?.ok)
    return refuse(
      "OTHER_ACTIVE_CLAIM",
      { ...facts, activeClaims: ownOther.map((c) => ({ number: c.number, url: c.url })) },
      verdict && !verdict.ok
        ? `${agent} already has a claim that is not verified waiting (${verdict.why.join("; ")}); one active claim per agent.`
        : `${agent} already has an active claim; one active claim per agent.`,
      [
        // Alternatives are separate executable entries: never a shell comment inside a command,
        // which would swallow the trailing --repo.
        ...ownOther.flatMap((c) => [
          command(
            `release ${c.number} --agent ${agent} --as incomplete --note '<what was done and what remains>'`,
          ),
          command(`release ${c.number} --agent ${agent} --as ready`),
          command(`release ${c.number} --agent ${agent} --as done --pr '<pull request URL>'`),
        ]),
        command(
          `claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""}${rework ? " --rework" : ""}`,
        ),
      ],
    );
  const op = marker("claim", [repository, number, agent]);
  const claimComment = (): PlanStep =>
    writeStep("comment", {
      kind: "comment",
      repository,
      number,
      body: `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`pdb claim\`.\n\n${op}`,
    });
  if (label(item, mine)) {
    // Complete only when the explanatory comment exists too: a run whose comment failed is
    // repaired by retrying just that step.
    // This acquisition began when the label was last added; only a claim comment posted since
    // then counts, so an earlier claim's comment (before a release) does not.
    const history = await claimStart(repository, number, mine, item, query);
    const since = history.since;
    const found =
      since || history.complete
        ? await commentHistory(
            repository,
            number,
            item,
            since ? reaches(since) : () => false,
            query,
          )
        : null;
    if (!found?.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `${mine} is on #${number}, but ${found ? "the comments since this claim began" : "when it was added"} cannot be read within the bounded history, so whether its claim comment was posted is unknown; nothing is changed.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    // Only a claim comment with write authority proves the comment step ran (#212): a forged
    // copy of the public marker never suppresses it.
    const posted = await newestTrusted(
      found.comments.filter(
        (c) => c.body.includes(op) && (!since || !c.createdAt || c.createdAt >= since),
      ),
      (c) => c,
      permission,
    );
    const commented = !!posted.trusted;
    if (!commented && posted.unverified.length)
      return refuse(
        "MARKER_UNVERIFIED",
        facts,
        `${mine} is on #${number}, but the authority of its claim comment cannot be verified (${posted.unverified.join("; ")}), so whether the claim comment was posted is unknown; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
        [command(`who ${number}`), `${triage} --issue ${number}`],
      );
    return {
      ok: true,
      noop: commented,
      facts,
      reason: commented
        ? `Already claimed by ${agent}.`
        : `Claimed by ${agent}; posting the missing claim comment.`,
      changes: commented ? [] : [claimComment()],
      ...(commented ? {} : { notes: ignoredNote(posted.ignored) }),
      // Completing a partly failed acquisition gets the same post-write ownership check.
      ...(commented ? {} : { recheck: { agent } }),
    };
  }
  const openPrs = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  // More linked PRs than one page: an open one may be unseen, so "no open PR" is unknown.
  if (!openPrs.length && item.closedByPullRequestsReferences.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 10 linked pull requests; whether one is open cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  // Without --rework, the newest release in the window is only a hint for suggesting --rework;
  // it never authorises anything, so no permission is looked up.
  let lastRelease = rework ? null : latestRelease(item.comments.nodes);
  let claimedSince: string | null = rework ? null : (lastRelease?.claimedAt ?? null);
  let ignored: string[] = [];
  // With delivery records, rework authority comes only from ticket responsibility; the v1 done
  // handoff is consulted only while the issue has no trusted delivery record (#190).
  let deliveryPath = false;
  if (rework && reworkAuthority) {
    const authority = await reworkAuthority();
    if ("refusal" in authority)
      return refuse(
        authority.refusal.error,
        { ...facts, pullRequests: openPrs.map((p) => p.url) },
        authority.refusal.prerequisite,
        authority.refusal.recovery,
      );
    deliveryPath = authority.path === "delivery";
  }
  if (rework && !deliveryPath) {
    // The rework reclaim is authorised only by the caller's own done handoff for the claim it
    // released (#212): that claim began when the caller's label was last added, and its handoff
    // was posted after that, so the comments since then hold every record that can authorise it.
    const history = await claimStart(repository, number, mine, item, query);
    claimedSince = history.since;
    if (!claimedSince && !history.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `When ${mine} was last added to #${number} cannot be established from its label history, so ${agent}'s handoff cannot be tied to the claim it released.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    const releaseHistory = claimedSince
      ? await commentHistory(repository, number, item, reaches(claimedSince), query)
      : { comments: [], complete: true };
    if (!releaseHistory.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `No handoff record found within the bounded comment history of #${number}, so the latest release (and whether it is ${agent}'s own done handoff) cannot be verified.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    // Only a handoff posted by a current writer counts (#212); forged ones are ignored.
    const verdicts = await newestTrusted(
      allReleases(releaseHistory.comments).filter((r) => r.createdAt >= claimedSince!),
      (r) => r.comment ?? { body: "" },
      permission,
    );
    ignored = verdicts.ignored;
    if (verdicts.unverified.length)
      return refuse(
        "MARKER_UNVERIFIED",
        facts,
        `The authority of a handoff on #${number} cannot be verified (${verdicts.unverified.join("; ")}), so the latest release cannot be established; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    lastRelease = verdicts.trusted;
  }
  // Conservative authorisation: awaiting review, an open PR, and the caller's own done handoff
  // for the claim it released is the latest trusted release on this issue.
  const reworkable =
    deliveryPath ||
    (label(item, claimPolicy.awaitingReview) &&
      openPrs.length > 0 &&
      lastRelease?.agent === agent &&
      lastRelease.outcome === "done" &&
      // A handoff with no recorded claim time, or another claim's, is never the caller's claim.
      !!lastRelease.claimedAt &&
      lastRelease.claimedAt === claimedSince);
  const reworkCommand = command(
    `claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""} --rework`,
  );
  if (rework && !reworkable)
    return refuse(
      "REWORK_NOT_AUTHORISED",
      {
        ...facts,
        pullRequests: openPrs.map((p) => p.url),
        ...(lastRelease ? { lastReleasedBy: lastRelease.agent } : {}),
      },
      `Review rework needs ${claimPolicy.awaitingReview}, an open pull request, and ${agent}'s own done handoff, posted by a user with write access and recording the claim time of ${agent}'s last claim${claimedSince ? ` (${claimedSince})` : ""}, as the latest release on #${number}.${ignored.length ? ` ${ignoredNote(ignored)[0]}` : ""}`,
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  const restrictions = facts.labels
    .filter((l) => l.startsWith(claimPolicy.platformPrefix))
    .map((l) => l.slice(claimPolicy.platformPrefix.length));
  // #1019: released work with a preserved open PR is offered for adoption (D-ADOPT); its facts
  // reach the native admission, which alone decides whether the open PR or a held status still
  // refuses the claim. Read only when an open PR could otherwise refuse it.
  let adopting: ClaimAdoptionFacts | undefined;
  // Membership need not close the ticket (delivery-lifecycle.md), so the reader runs whenever an
  // open PR or a held status could refuse the claim, not only for closing references.
  const pickable = claimPolicy.pickable.some((l) => label(item, l));
  if (!rework && adoption && (openPrs.length > 0 || !pickable)) {
    try {
      adopting = await adoption();
    } catch (error) {
      return refuse(
        "EVIDENCE_INCOMPLETE",
        { ...facts, pullRequests: openPrs.map((p) => p.url) },
        `The delivery records of #${number} could not be read (${error instanceof Error ? error.message : "unknown error"}), so whether its open pull request is preserved unowned work is unknown; nothing was written.`,
        [command(`who ${number}`), `${triage} --issue ${number}`],
      );
    }
  }
  const denials = evaluateClaimAdmission({
    ...adopting,
    state: item.state,
    labels: facts.labels,
    labelsComplete: !item.labels.pageInfo?.hasNextPage,
    nativeComplete: Boolean(item.issueDependenciesSummary),
    openBlockers: item.issueDependenciesSummary?.blockedBy ?? 0,
    openPrCount: openPrs.length,
    platform,
    platforms: restrictions,
    ownedClaimsComplete: claimsComplete,
    claimedByOther: others.length > 0,
  });
  if (denials.has("D-DENY-INVENTORY-UNKNOWN") || denials.has("CLAIM-INVENTORY-UNKNOWN"))
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `${agent}'s open claims could not be read completely, so whether ${agent} already holds a claim is unknown; nothing was written.`,
      [
        `pdb team --repo ${repository}`,
        command(
          `claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""}${rework ? " --rework" : ""}`,
        ),
      ],
    );
  if (denials.has("D-DENY-PREREQUISITE")) {
    const held = claimPolicy.held.filter((l) => label(item, l));
    if (
      label(item, claimPolicy.question) ||
      label(item, claimPolicy.needsDesign) ||
      label(item, claimPolicy.decisionNeeded)
    )
      return refuse(
        "NOT_READY",
        facts,
        "The ticket has an outstanding question or design prerequisite.",
        [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
      );
    return refuse(
      "NOT_READY",
      facts,
      `The ticket is ${held.join(" and ")}; resolve that before claiming, even if a ready label remains.`,
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  }
  if (!rework && denials.has("CLAIM-NOT-READY"))
    return refuse(
      "NOT_READY",
      facts,
      `The ticket needs ${claimPolicy.pickable.join(" or ")} to be picked up.${reworkable ? " To fix review feedback on your own pull request, reclaim it explicitly with --rework." : ""}`,
      [...(reworkable ? [reworkCommand] : []), `${triage} --agent ${agent}`],
    );
  if (denials.has("D-DENY-LABELS-UNKNOWN"))
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "Label evidence is incomplete; readiness is unknown.",
      [`${triage} --issue ${number}`],
    );
  if (denials.has("D-DENY-NATIVE-UNKNOWN"))
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "Native blocker evidence is unavailable; readiness is unknown.",
      [command(`deps ${number}`)],
    );
  if (denials.has("D-DENY-BLOCKER"))
    return refuse(
      "BLOCKED",
      {
        ...facts,
        openBlockers: item.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.url),
      },
      "Open native blockers must close first.",
      [command(`deps ${number}`), `${triage} --agent ${agent}`],
    );
  if (!rework && denials.has("D-DENY-OPEN-PR"))
    return refuse(
      "HAS_OPEN_PR",
      { ...facts, pullRequests: openPrs.map((p) => p.url) },
      "An open pull request already addresses this ticket; follow up on it instead.",
      [
        ...(reworkable ? [reworkCommand] : []),
        ...openPrs.map((p) => `gh pr view ${p.number} --repo ${repository}`),
      ],
    );
  if (denials.has("D-DENY-PLATFORM")) {
    if (!platform)
      return refuse(
        "PLATFORM_UNKNOWN",
        { ...facts, platforms: restrictions },
        `The ticket is restricted to ${restrictions.join(", ")}; state your platform with --platform.`,
        [command(`claim ${number} --agent ${agent} --platform ${restrictions[0]}`)],
      );
    return refuse(
      "PLATFORM_MISMATCH",
      { ...facts, platforms: restrictions, platform },
      `The ticket is restricted to ${restrictions.join(", ")}.`,
      [`${triage} --agent ${agent}`],
    );
  }
  const remove = [...claimPolicy.pickable, ...(rework ? [claimPolicy.awaitingReview] : [])].filter(
    (l) => label(item, l),
  );
  // A fresh acquisition (label absent) always explains itself; retries of this acquisition are
  // handled above, where the label is already present.
  const changes: PlanStep[] = [];
  if (!repoLabels.has(mine))
    changes.push(
      writeStep("create-label", {
        kind: "label-create",
        repository,
        name: mine,
        color: claimPolicy.labelColours.agent,
        description: `Claimed by agent ${agent}`,
      }),
    );
  changes.push(
    writeStep("labels", { kind: "labels-edit", repository, number, add: [mine], remove }),
  );
  // Always post the claim comment for a new acquisition.
  changes.push(
    writeStep("comment", {
      kind: "comment",
      repository,
      number,
      body: `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`pdb claim\`${rework ? " for review rework" : ""}. Removed: ${remove.map((l) => `\`${l}\``).join(", ")}.\n\n${op}`,
    }),
  );
  return {
    ok: true,
    noop: false,
    facts,
    changes,
    recheck: { agent },
    ...(ignored.length || deliveryPath || adopting?.release
      ? {
          notes: [
            ...ignoredNote(ignored),
            ...(adopting?.release
              ? [
                  `Adopting preserved work released from ${adopting.release.from}: continue ${adopting.release.preservedPrUrls.join(", ")} rather than opening a duplicate PR, then become responsible with pdb submit ${number} --agent ${agent}${adopting.release.preservedPrUrls.map((u) => ` --pr ${u}`).join("")} --repo ${repository}.`,
                ]
              : []),
            ...(deliveryPath
              ? [
                  `Rework by the ticket-responsible agent: after the claim, a delivery record reopens membership (membership open, reason "rework claim"); finish with pdb submit ${number} --agent ${agent} --repo ${repository}.`,
                ]
              : []),
          ],
        }
      : {}),
  };
}

/** The parts of a needs-human question record comment. */
export interface QuestionRecordParts {
  designer: string;
  agent: string;
  why: string;
  questions: string[];
}
/** The needs-human comment body; parseQuestionRecordBody is its inverse (#457). */
export function questionRecordBody(parts: QuestionRecordParts, op: string): string {
  return [
    claimPolicy.questionsHeading,
    "",
    `Designer: \`${parts.designer}\` · Raised by: \`${parts.agent}\``,
    "",
    `**Why:** ${parts.why}`,
    "",
    ...parts.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    op,
  ].join("\n");
}
/**
 * Parse the text before the marker of a needs-human comment written by questionRecordBody.
 * Multiline values are kept: a question runs until the next line numbered with the next index
 * (`2. ` after question 1), and the reason runs until the blank line before `1. `. Null when
 * the heading or routing line is missing.
 */
export function parseQuestionRecordBody(text: string): QuestionRecordParts | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.indexOf(claimPolicy.questionsHeading);
  if (heading < 0) return null;
  const routing = /^Designer: `([^`]*)` · Raised by: `([^`]*)`$/.exec(lines[heading + 2] ?? "");
  if (!routing) return null;
  const whyAt = heading + 4;
  if (!(lines[whyAt] ?? "").startsWith("**Why:** ")) return null;
  let first = lines.findIndex((l, i) => i > whyAt && l.startsWith("1. ") && lines[i - 1] === "");
  if (first < 0) first = lines.length;
  const why = [lines[whyAt].slice("**Why:** ".length), ...lines.slice(whyAt + 1, first - 1)].join(
    "\n",
  );
  const questions: string[] = [];
  for (const line of lines.slice(first)) {
    const next = `${questions.length + 1}. `;
    if (line.startsWith(next)) questions.push(line.slice(next.length));
    else if (questions.length) questions[questions.length - 1] += `\n${line}`;
  }
  // The writer ends the list with one blank line before the marker.
  if (questions.length) questions[questions.length - 1] = questions.at(-1)!.replace(/\n+$/, "");
  return { designer: routing[1], agent: routing[2], why, questions };
}

/**
 * Plan `needs-human N --agent NAME --designer NAME --why TEXT --question TEXT...`.
 */
export async function planNeedsHuman(
  repository: string,
  request: NeedsHumanRequest,
  query: GraphQuery | TicketReads = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, designer, why, questions } = request;
  const { item, repoLabels } = await readTicket(repository, number, agent, query, designer);
  const triage = `pdb --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Questions are recorded on the issue the pull request addresses.",
      [`gh pr view ${number} --repo ${repository}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  } satisfies ClaimFacts;
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Questions are recorded on open tickets.", [
      `gh issue reopen ${number} --repo ${repository}   # manual, only if it should be open`,
    ]);
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the caller's claim and readiness cannot be verified, so nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const mine = claimPolicy.owner(agent);
  // v2 marker (#412, doc/reports/closed-question-discovery.md): the same 16-hex operation id
  // after the existing prefix, plus a binding to this repository/issue and explicit-resolution
  // semantics. Retries match either version by that id, so a v1 record still suppresses.
  const opId = markerId([repository, number, agent, designer, why, questions]);
  const op = questionMarker(opId, repository, number);
  const opToken = `${questionMarkerPrefix}${opId}`;
  // Page back until a marker WITH authority is found (#214): stopping at any matching marker
  // would let a newer forged copy hide an older genuine one, so a retry would post twice.
  // Permission lookups are cached per run, so re-checking candidates per page costs no requests.
  // Only a record the human view can read counts as already posted: a valid v1 marker, or a
  // v2 marker bound to this repository and issue. A damaged or copied one never suppresses.
  const candidates = (c: Comment[]) =>
    c.filter((x) => {
      const m = parseQuestionMarker(x.body);
      if (m?.opId !== opId || !x.body.includes(opToken)) return false;
      return (
        m.version === 1 ||
        (m.version === 2 &&
          m.repository.toLowerCase() === repository.toLowerCase() &&
          m.issue === number)
      );
    });
  const seen = await commentHistory(
    repository,
    number,
    item,
    async (c) => (await newestTrusted(candidates(c), (x) => x, permission)).trusted !== null,
    query,
  );
  // The bound reached with no trusted marker: an older genuine one may be unseen, so whether
  // the questions were posted is unknown evidence (not unknown authority) and nothing is posted.
  if (!seen.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "The comment history is longer than the bounded read, so whether these questions were already posted is unknown; nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  // Only a marker with write authority suppresses a repeat question (#214): a forged copy is
  // ignored with a warning, and an unverifiable one never suppresses, so the question is posted.
  const posted = await newestTrusted(candidates(seen.comments), (c) => c, permission);
  const already = posted.trusted !== null;
  const readiness = workflow.readiness.filter((l) => label(item, l));
  const swap = claimPolicy.pickable.filter((l) => label(item, l));
  // Exactly one readiness label: replace ready/incomplete with needs-design; add it when there
  // is none; leave another deliberate state (blocked, parked) alone and report it.
  const held = claimPolicy.held.filter((l) => label(item, l));
  // Never add a second readiness state on top of a deliberate blocked/parked one.
  const addNeedsDesign =
    !label(item, claimPolicy.needsDesign) && !held.length && (swap.length || !readiness.length);
  const attention = claimPolicy.attention(designer);
  const add = [
    claimPolicy.question,
    claimPolicy.decisionNeeded,
    attention,
    ...(addNeedsDesign ? [claimPolicy.needsDesign] : []),
  ].filter((l) => !label(item, l));
  // The caller's claim is kept by default (#412: the claim waits on the question); --release
  // relinquishes it explicitly, after the question is durable.
  const remove = [...swap, ...(request.release && label(item, mine) ? [mine] : [])];
  const notes: string[] = ignoredNote(posted.ignored);
  if (!already && posted.unverified.length)
    notes.push(
      `Marker(s) whose authority could not be verified do not suppress the question: ${posted.unverified.join("; ")}.`,
    );
  if (held.length)
    notes.push(`Readiness ${held.join(", ")} kept; not replaced with ${claimPolicy.needsDesign}.`);
  if (!request.release && label(item, mine))
    notes.push(
      `${mine} is kept (#412): after the question is saved, a wait bound to it is recorded before the labels change. Use --release to relinquish the claim instead.`,
    );
  const changes: PlanStep[] = [];
  if (!already)
    changes.push(
      writeStep("comment", {
        kind: "comment",
        repository,
        number,
        body: questionRecordBody({ designer, agent, why, questions }, op),
      }),
    );
  for (const name of add.filter((l) => !repoLabels.has(l)))
    changes.push(
      writeStep("create-label", {
        kind: "label-create",
        repository,
        name,
        color: claimPolicy.labelColours[name] ?? "ededed",
      }),
    );
  if (add.length || remove.length)
    changes.push(writeStep("labels", { kind: "labels-edit", repository, number, add, remove }));
  return {
    ok: true,
    noop: !changes.length,
    facts,
    changes,
    notes,
    questionOpId: opId,
    retainsClaim: !request.release && label(item, mine),
  };
}

/** Live state of a supplied pull request URL; null when it cannot be verified. */
async function readPullRequest(
  url: string,
  query: GraphQuery | TicketReads,
): Promise<string | null> {
  return ticketsOver(query).pullStateByUrl(url);
}

/**
 * The authenticated account and whether it would author a trusted record: every planner that
 * appends a marker checks this first, or its record would be ignored by every reader.
 */
export async function viewerAuthority(
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
): Promise<{ viewer: Actor | null; authority: Authority }> {
  let viewer: Actor | null = null;
  try {
    viewer = await ticketsOver(query).viewer();
  } catch {
    viewer = null;
  }
  const authority: Authority = viewer?.login
    ? await commentAuthority(
        { body: "", author: viewer, lastEditedAt: null, includesCreatedEdit: false, editor: null },
        permission,
      )
    : { status: "unknown", why: "the authenticated account could not be read" };
  return { viewer, authority };
}

/** The question marker of a needs-human comment readable on this issue (v1, or v2 bound here). */
export function readableQuestion(
  body: string,
  repository: string,
  number: number,
): { version: 1 | 2; opId: string } | null {
  const m = parseQuestionMarker(body);
  if (m?.version === 1) return m;
  if (
    m?.version === 2 &&
    m.repository.toLowerCase() === repository.toLowerCase() &&
    m.issue === number
  )
    return m;
  return null;
}

/** A needs-human comment URL on this repository and issue: its comment id, or null. */
export function questionCommentId(url: string, repository: string, number: number): string | null {
  const m =
    /^https:\/\/github\.com\/([^/\s]+\/[^/\s#]+)\/issues\/(\d+)#issuecomment-(\d{1,20})$/.exec(url);
  return m && m[1]!.toLowerCase() === repository.toLowerCase() && Number(m[2]) === number
    ? m[3]!
    : null;
}

export interface QuestionResolutionRequest {
  number: number;
  agent: string;
  op: "resolve" | "withdraw";
  /** The needs-human comment URL: https://github.com/OWNER/NAME/issues/N#issuecomment-ID. */
  question: string;
  why: string;
}

/**
 * Plan `question resolve|withdraw N --agent NAME --question URL --why TEXT` (#412,
 * doc/design/blocked-retained-claims.md). Appends one question-resolution v1 record: a deliberate
 * assertion with a reason, never inferred from a reply, label removal, merge or closure. The
 * question must be a readable needs-human record on this issue (v1, or v2 bound here) by a
 * write-authorised author, with no earlier trusted outcome; unknown evidence refuses. The issue
 * may be closed: a question on a closed source can still be answered (#414).
 */
export async function planQuestionResolution(
  repository: string,
  request: QuestionResolutionRequest,
  query: GraphQuery | TicketReads = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, op, question, why } = request;
  const triage = `pdb --repo ${repository}`;
  const retry = `pdb question ${op} ${number} --agent ${agent} --question ${question} --why ${shellQuote(why)} --repo ${repository}`;
  const questionId = questionCommentId(question, repository, number);
  if (!questionId)
    return refuse(
      "QUESTION_NOT_ON_ISSUE",
      { number },
      `--question must be a needs-human comment on ${repository}#${number} (…/issues/${number}#issuecomment-ID).`,
      [`${triage} --issue ${number}`],
    );
  const { item } = await readTicket(repository, number, agent, query);
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  // The record's author is the authenticated account: it must pass the same authority rule the
  // readers apply, or the posted record would be ignored and the question stay open.
  const { viewer, authority: writer } = await viewerAuthority(query, permission);
  if (writer.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      { number, url: item.url },
      `The authenticated account ${viewer?.login ?? "(unknown)"} must be a user with current write, maintain or admin permission on ${repository} to record a question outcome (${writer.why}); nothing is posted.`,
      [`gh auth status`, retry],
    );
  if (item.__typename !== "Issue")
    return refuse("NOT_AN_ISSUE", { number, url: item.url }, "Questions are recorded on issues.", [
      `gh pr view ${number} --repo ${repository}`,
    ]);
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
  } satisfies ClaimFacts;
  // Every resolution of this question is newer than it, so reading back to it reads them all.
  const history = await commentHistory(
    repository,
    number,
    item,
    (c) => c.some((x) => String(x.databaseId) === questionId),
    query,
  );
  const found = history.comments.find((x) => String(x.databaseId) === questionId);
  if (!found)
    return refuse(
      history.complete ? "QUESTION_NOT_FOUND" : "EVIDENCE_INCOMPLETE",
      facts,
      history.complete
        ? `No comment ${questionId} on #${number}.`
        : "The comment history is longer than the bounded read, so the question could not be found; nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const marker = readableQuestion(found.body, repository, number);
  if (!marker)
    return refuse(
      "NOT_A_QUESTION",
      facts,
      `Comment ${questionId} is not a readable needs-human question record on this issue.`,
      [`${triage} --issue ${number}`],
    );
  const authority = await commentAuthority(found, permission);
  if (authority.status !== "trusted")
    return refuse(
      "QUESTION_UNVERIFIED",
      facts,
      `The question's author authority is not established (${authority.why}); only a write-authorised question is resolved.`,
      [`${triage} --issue ${number}`],
    );
  const questionOpId = marker.opId;
  const opId = createHash("sha256")
    .update(
      JSON.stringify([
        "question-resolution",
        repository.toLowerCase(),
        number,
        questionId,
        op,
        agent,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const ordered = history.comments.filter(
    (c): c is Comment & { databaseId: number; createdAt: string } =>
      typeof c.databaseId === "number" && typeof c.createdAt === "string",
  );
  const classified = await classifyMarkers(
    ordered,
    { repository, issue: number },
    (c) => commentAuthority(c, permission),
    parseResolutionComment,
  );
  const folded = foldQuestionResolutions(classified, new Map([[questionId, questionOpId]]));
  // Unverifiable records could hold an earlier, different first outcome: never settle past them.
  if (folded.unknown.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `An earlier resolution record could not be verified (${folded.unknown.join("; ")}); nothing is posted.`,
      [`${triage} --issue ${number}`],
    );
  const outcome = folded.outcomes.get(questionId);
  if (outcome) {
    const mine = classified.find(
      (c) =>
        String(c.comment.databaseId) === outcome.comment &&
        c.status === "trusted" &&
        c.record.opId === opId,
    );
    if (mine)
      return {
        ok: true,
        facts,
        noop: true,
        reason: `Already recorded: question ${questionId} was ${outcome.op}d (comment ${outcome.comment}).`,
        changes: [],
        retry,
      };
    return refuse(
      "QUESTION_ALREADY_SETTLED",
      facts,
      `Question ${questionId} was already ${outcome.op}d by ${outcome.agent} (comment ${outcome.comment}); the first explicit outcome stands.`,
      [`${triage} --issue ${number}`],
    );
  }
  const record: QuestionResolutionRecord = {
    v: 1,
    op,
    opId,
    repository,
    issue: number,
    questionCommentId: questionId,
    questionOpId,
    agent,
    reason: why,
  };
  // Never post what the reader would reject as malformed: that would report success without a
  // usable outcome and make later attempts refuse on an authoritative malformed record.
  const invalid = resolutionProblem(record);
  if (invalid)
    return refuse(
      "INVALID_ARGUMENT",
      facts,
      `The resolution would not be a valid record (${invalid}); nothing is posted.`,
      [
        `pdb question ${op} ${number} --agent NAME --question ${question} --why TEXT --repo ${repository}`,
      ],
    );
  const body = [
    `Question ${op === "resolve" ? "resolved" : "withdrawn"} by \`${agent}\` with \`pdb question ${op}\`: ${question}`,
    "",
    // Displayed text never carries a marker delimiter: the record is in the marker alone.
    `**Why:** ${why.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`,
    "",
    resolutionMarker(record),
  ].join("\n");
  // The whole comment must read back as exactly this record, or nothing is posted.
  const readBack = parseResolutionComment(body);
  if (readBack.kind !== "record" || JSON.stringify(readBack.record) !== JSON.stringify(record))
    return refuse(
      "INVALID_ARGUMENT",
      facts,
      "The resolution comment would not read back as a single valid record; nothing is posted.",
      [retry],
    );
  return {
    ok: true,
    facts,
    noop: false,
    changes: [writeStep("comment", { kind: "comment", repository, number, body })],
    retry,
  };
}

/**
 * Plan `release N --agent NAME --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL]`
 * (#62, doc/design/workflow.md "Focused handoff"). Reads only.
 *
 * The outcome is always the agent's explicit choice. The handoff comment is posted first and
 * records the whole label plan (target, labels to remove, owners retained, claim time) in a
 * hidden marker; labels change second. A retry is accepted only on that recorded intent: it
 * completes exactly the recorded label plan, or refuses if ownership/readiness changed since.
 */
export async function planRelease(
  repository: string,
  request: ReleaseRequest,
  query: GraphQuery | TicketReads = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, outcome, note = null, pr = null, change = null } = request;
  const triage = `pdb --repo ${repository}`;
  const command = (text: string): string => `pdb ${text} --repo ${repository}`;
  const deliverable = pr ?? change;
  const prState = pr ? await readPullRequest(pr, query) : null;
  const preliminary =
    outcome === "ready" ? workflow.ready : outcome === "done" ? null : claimPolicy.incomplete;
  // Done with an open PR (supplied or linked) awaits review; otherwise contribution-done.
  const { item, repoLabels } = await readTicket(
    repository,
    number,
    agent,
    query,
    "",
    preliminary ?? claimPolicy.awaitingReview,
  );
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Only an issue holds a claim; hand over on the issue the pull request addresses.",
      [`gh pr view ${number} --repo ${repository}`],
    );
  const linkedOpen = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  const linkedUnknown =
    !linkedOpen.length && !!item.closedByPullRequestsReferences.pageInfo?.hasNextPage;
  // A verified open closing PR establishes review whatever state a supplied --pr has.
  const openPr = prState === "OPEN" || linkedOpen.length > 0;
  const target = outcome === "done" ? (openPr ? claimPolicy.awaitingReview : null) : preliminary;
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
    outcome,
    deliverable,
    pullRequestState: pr ? (prState ?? "UNKNOWN") : null,
    target,
    ...(linkedOpen.length ? { pullRequests: linkedOpen.map((p) => p.url) } : {}),
  } satisfies ClaimFacts;
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the caller's claim and readiness cannot be verified, so nothing is changed.",
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  // Done's target depends on whether a PR is open; an unseen linked PR makes that unknown.
  if (outcome === "done" && prState !== "OPEN" && linkedUnknown)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 10 linked pull requests; whether one is open (and so the handoff target) cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  const mine = claimPolicy.owner(agent);
  const args = [
    `release ${number} --agent ${agent} --as ${outcome}`,
    ...(note ? [`--note ${shellQuote(note)}`] : []),
    ...(pr ? [`--pr ${shellQuote(pr)}`] : []),
    ...(change ? [`--change ${shellQuote(change)}`] : []),
  ].join(" ");
  const retry = command(args);
  // The operation identity is the claim being released (when its label was last added). The
  // handoff comment is posted BEFORE any label changes and carries the full label plan, so a
  // retry is authorised only by that durable record of intent, never by label history alone.
  const history = await claimStart(repository, number, mine, item, query);
  const since = history.since;
  if (!since && (!history.complete || label(item, mine)))
    // Without the claim's start time, separate acquisitions by this agent are indistinguishable,
    // so no recorded handoff may be matched (it could belong to an earlier claim).
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `When ${mine} was added to #${number} cannot be established from its label history, so this claim cannot be told apart from earlier ones; nothing is changed. Inspect the ticket's label history and coordinate on the ticket, or remove and re-add ${mine} to start a verifiable claim.`,
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  // Every handoff recorded for this claim was posted after it began: read back to that point.
  const recorded = since
    ? await commentHistory(repository, number, item, reaches(since), query)
    : { comments: item.comments.nodes, complete: true };
  if (!recorded.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `The comments since ${mine} was added at ${since} exceed the bounded read, so a handoff already recorded for this claim may be unseen; nothing is changed.`,
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  const events = history.events.filter((e) => e.label && e.createdAt);
  const removed = (e: (typeof events)[number]): boolean => e.__typename === "UnlabeledEvent";
  const op = marker("release", [repository, number, agent, since]);
  // A record with no claim time can never be tied to a particular claim, so it never matches.
  // The marker's hash is of public values, so only a record posted by a current writer is the
  // recorded intent (#212); a forged one is ignored and named, an unverifiable one refused.
  const verdicts = await newestTrusted(
    since
      ? releaseRecords(recorded.comments, op).filter(
          (r) => r.agent === agent && r.claimedAt !== null && r.claimedAt === since,
        )
      : [],
    (r) => r.comment ?? { body: "" },
    permission,
  );
  if (verdicts.unverified.length)
    return refuse(
      "MARKER_UNVERIFIED",
      facts,
      `A handoff recorded for ${agent}'s claim on #${number} cannot be verified (${verdicts.unverified.join("; ")}), so whether its label plan applies is unknown; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
      [command(`who ${number}`), `${triage} --issue ${number}`],
    );
  const record = verdicts.trusted ?? undefined;
  const ignored = ignoredNote(verdicts.ignored);
  const holds = label(item, mine);
  const others = facts.owners.filter((o) => o !== mine);
  if (record) {
    const recordedRetry = command(`release ${number} --agent ${agent} --as ${record.outcome}`);
    const recorded = { ...facts, outcome: record.outcome, target: record.target };
    const same = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    // The plan removes the caller's own claim label in the same write that applies the rest, so
    // while that label is present the label step is demonstrably unfinished. Once it is gone the
    // step completed, and whatever happened to the labels since (a merged PR's review label
    // removed by a maintainer, say) belongs to others: never restore labels from the plan.
    if (!holds)
      return {
        ok: true,
        noop: true,
        facts: recorded,
        reason: `Handoff already recorded and ${agent}'s claim already released.`,
        changes: [],
        notes: ignored,
      };
    // Anything another party did after the record (a new owner, a readiness label other than
    // the recorded target) means the recorded plan no longer describes the ticket.
    const handoffStates = [...workflow.readiness, claimPolicy.awaitingReview];
    // Additions and removals both count; only changes the plan itself makes are expected.
    const relevant = (n: string): boolean =>
      n.startsWith(workflow.ownerPrefix) || handoffStates.includes(n);
    const later = events
      .filter((e) => e.createdAt! > record.createdAt && relevant(e.label!.name))
      .filter((e) =>
        removed(e) ? !record.remove.includes(e.label!.name) : e.label!.name !== record.target,
      )
      .map((e) => `${removed(e) ? "-" : "+"}${e.label!.name}`);
    if (later.length || !same(others, record.retained))
      return refuse(
        "RELEASE_DIVERGED",
        recorded,
        `A handoff was recorded for ${agent}'s claim at ${record.createdAt}, but ownership or readiness changed afterwards (${[...new Set([...later, ...others.filter((o) => !record.retained.includes(o))])].join(", ") || "retained owners removed"}); the recorded label plan is not applied. Inspect and coordinate on the ticket.`,
        [command(`who ${number}`), `${triage} --issue ${number}`],
      );
    if (outcome !== record.outcome)
      return refuse(
        "RELEASE_PENDING",
        recorded,
        `A ${record.outcome} handoff is already recorded for this claim and its labels are not yet applied; complete it with the recorded outcome.`,
        [recordedRetry],
      );
    const add = record.target && !label(item, record.target) ? [record.target] : [];
    const remove = record.remove.filter((l) => label(item, l));
    return {
      ok: true,
      noop: false,
      facts: recorded,
      reason: "Handoff comment already recorded; applying its recorded label changes.",
      changes: labelSteps(repository, number, add, remove, repoLabels),
      notes: [
        ...ignored,
        ...(record.retained.length ? [`Other owners kept: ${record.retained.join(", ")}.`] : []),
      ],
      recheck: { agent, release: { target: record.target } },
      retry: recordedRetry,
    };
  }
  if (!holds)
    return refuse(
      "NOT_CLAIMED",
      facts,
      `${agent} holds no claim on #${number}${others.length ? ` (owned by ${others.join(", ")})` : ""}; only the caller's own claim can be released.`,
      [command(`who ${number}`), `${triage} --agent ${agent}`],
    );
  if (item.state !== "OPEN" && outcome !== "done")
    return refuse(
      "TICKET_CLOSED",
      facts,
      `#${number} is closed; only --as done can hand over a closed ticket's claim.`,
      [
        command(
          `release ${number} --agent ${agent} --as done${pr ? ` --pr ${shellQuote(pr)}` : ""}`,
        ),
      ],
    );
  const notes: string[] = [...ignored];
  if (!note) notes.push("No handoff note supplied; release proceeds, but a note is expected.");
  if (others.length) notes.push(`Other owners kept: ${others.join(", ")}.`);
  if (pr && !prState)
    notes.push(
      `Pull request state is UNKNOWN (${pr} could not be verified); not treated as open or merged.`,
    );
  if (outcome === "done" && pr)
    notes.push(
      `Deprecated: release --as done --pr writes a release record only, never a delivery record. Use: ${command(`submit ${number} --agent ${agent} --pr ${shellQuote(pr)}`)}`,
    );
  if (outcome === "done" && !deliverable && !linkedOpen.length)
    notes.push("Done without a PR or change link; inspect the ticket to confirm the deliverable.");
  if (outcome === "done" && !target)
    notes.push(
      "Contribution done with no open PR: no readiness label is added, so the ticket is reported for inspection, not returned to pickup or closed.",
    );
  const held = [...claimPolicy.held, claimPolicy.needsDesign].filter((l) => label(item, l));
  if (held.length) notes.push(`Kept unrelated state: ${held.join(", ")}.`);
  // Exactly one handoff readiness state; questions, blockers, attention and others untouched.
  const handoff = [...claimPolicy.pickable, claimPolicy.awaitingReview];
  const remove = [mine, ...handoff.filter((l) => l !== target && label(item, l))];
  const add = target && !label(item, target) ? [target] : [];
  const plan: ReleaseRecord = {
    v: 1,
    agent,
    outcome,
    target,
    remove,
    retained: others,
    claimedAt: since,
    createdAt: "",
  };
  const describe =
    outcome === "done"
      ? target
        ? `done; awaiting review (\`${target}\`)`
        : "done (contribution finished; no open PR, for inspection)"
      : outcome === "parked"
        ? `incomplete (parked; \`${target}\`)`
        : `${outcome} (\`${target}\`)`;
  const changes: PlanStep[] = [];
  changes.push(
    writeStep("comment", {
      kind: "comment",
      repository,
      number,
      body: [
        `Handoff by \`${agent}\` with \`pdb release\`: **${describe}**. Releasing the claim.`,
        "",
        ...(pr
          ? [`Pull request: ${pr}${prState ? ` (${prState})` : " (state unknown)"}`, ""]
          : change
            ? [`Change: ${change}`, ""]
            : []),
        note ? `**Note:** ${note}` : "_No handoff note supplied._",
        "",
        releaseMarker(op, plan),
      ].join("\n"),
    }),
  );
  changes.push(...labelSteps(repository, number, add, remove, repoLabels));
  return {
    ok: true,
    noop: false,
    facts,
    changes,
    notes,
    recheck: { agent, release: { target } },
    retry,
  };
}

/**
 * Apply a plan step by step. The comment comes first for needs-human, so a failed comment
 * leaves nothing changed. After a claim, ownership is re-read and conflicts are reported.
 * Exit: 0 done, 2 partly done or conflict, 1 nothing done.
 */
export async function applyPlan(
  repository: string,
  plan: ClaimPlan,
  {
    run = ghRun,
    query = ghQuery,
    stillWaiting,
  }: {
    run?: GhRun;
    query?: GraphQuery | TicketReads;
    /** Re-verify claims admitted as waiting (#412): the problems found, empty when all still wait. */
    stillWaiting?: (numbers: number[]) => Promise<string[]>;
  } = {},
): Promise<ClaimResult> {
  if (!plan.ok) return { ...plan, exitCode: 1 };
  const steps: PlanStep[] = plan.changes.map((c) => ({ ...c, status: "pending" }));
  let failed = false;
  for (const step of steps) {
    if (failed) {
      step.status = "skipped";
      continue;
    }
    try {
      // The typed write (#942) through the shared gh write boundary; a step without one (a
      // caller-built legacy plan) still dispatches its command.
      const call = { guard: ticketGuard(repository, plan.facts.number, query) };
      const op = step[WRITE];
      if (op) await issueWrites(run).apply(op, call);
      else await run(step.command, call);
      step.status = "done";
    } catch (error) {
      failStep(step, error);
      failed = true;
    }
  }
  const done = steps.filter((s) => s.status === "done").length;
  let conflict: string | null = null;
  let unverified: string | null = null;
  const verify = `Verify with: pdb who ${plan.facts.number} --repo ${repository} (or pdb --repo ${repository} --issue ${plan.facts.number})${plan.retry ? `; the same command is safe to re-run: ${plan.retry}` : ""}.`;
  if (!failed && plan.recheck && done) {
    try {
      const mine = claimPolicy.owner(plan.recheck.agent);
      const ticket = await readTicket(repository, plan.facts.number, plan.recheck.agent, query);
      const { claims, claimsComplete } = ticket;
      // A claim is only ever planned for an issue; anything else cannot hold the claim.
      const item = ticket.item?.__typename === "Issue" ? ticket.item : null;
      const others = item ? owners(item).filter((o) => o !== mine) : [];
      const elsewhere = claims.filter((c) => c.number !== plan.facts.number);
      // GitHub label edits are not a lock: report conflicts rather than resolve them.
      const problems: string[] = [];
      // Missing or truncated evidence is never success: report it as unverified.
      const gaps: string[] = [];
      if (!item) gaps.push(`#${plan.facts.number} could not be re-read as an issue`);
      else if (item.labels?.pageInfo?.hasNextPage)
        gaps.push(
          `#${plan.facts.number} has more than 100 labels, so ${plan.recheck.release ? "a remaining claim label" : "a competing claim"} may be unseen`,
        );
      if (!plan.recheck.release && !claimsComplete)
        gaps.push(`${plan.recheck.agent}'s open claims could not be read completely`);
      if (gaps.length) unverified = `Writes completed, but ${gaps.join("; ")}. ${verify}`;
      else if (plan.recheck.release) {
        const target = plan.recheck.release.target;
        if (owners(item!).includes(mine))
          problems.push(`${mine} is still recorded on #${plan.facts.number}`);
        if (target && !label(item!, target))
          problems.push(`${target} is no longer on #${plan.facts.number}`);
      } else {
        if (item!.state !== "OPEN" || !owners(item!).includes(mine))
          problems.push(
            `the claim is no longer recorded on #${plan.facts.number} (open, labelled ${mine})`,
          );
        if (others.length)
          problems.push(`another claim appeared concurrently: ${others.join(", ")}`);
        // Claims admitted as verified waiting must still be waiting after the write; any other
        // claim of this agent (a concurrent winner) is a conflict, never resolved automatically.
        const admitted = new Set(stillWaiting ? (plan.recheck.waiting ?? []) : []);
        const unexpected = elsewhere.filter((c) => !admitted.has(c.number));
        if (unexpected.length)
          problems.push(
            `${plan.recheck.agent} now also claims ${unexpected.map((c) => `#${c.number}`).join(", ")}; one active claim per agent`,
          );
        const retained = elsewhere.filter((c) => admitted.has(c.number)).map((c) => c.number);
        if (retained.length && stillWaiting) problems.push(...(await stillWaiting(retained)));
      }
      if (problems.length)
        conflict = `${problems.join("; ")}. Coordinate on the tickets; nothing was removed.`;
    } catch (error) {
      // Keep the completed writes; ownership is merely unverified.
      unverified = `Writes completed, but ownership could not be re-checked (${errorMessage(error)}). ${verify}`;
    }
  }
  const exitCode = failed ? (done ? 2 : 1) : conflict || unverified ? 2 : 0;
  return { ...plan, steps, conflict, unverified, exitCode };
}

/** POSIX shell quoting for displayed commands: nothing inside single quotes is expanded. */
export const shellQuote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** Text rendering for plans, refusals and results. */
export function claimText(result: ClaimPlan | ClaimResult, dryRun = false): string {
  if (!result.ok)
    return (
      [
        `REFUSED ${result.error}: ${result.prerequisite}`,
        `Ticket: ${result.facts.url ?? `#${result.facts.number}`}`,
        ...(result.facts.owners?.length ? [`Owners: ${result.facts.owners.join(", ")}`] : []),
        ...(result.facts.activeClaims ?? []).map((c) => `Active claim: ${c.url}`),
        ...(result.facts.openBlockers ?? []).map((b) => `Open blocker: ${b}`),
        ...(result.facts.pullRequests ?? []).map((p) => `Open PR: ${p}`),
        ...(result.recovery.length ? ["Recovery:", ...result.recovery.map((r) => `  ${r}`)] : []),
      ].join("\n") + "\n"
    );
  const lines = [`${result.facts.url} ${result.facts.title}`];
  if (result.facts.outcome)
    lines.push(
      `Handoff: ${result.facts.outcome} -> ${result.facts.target ?? "no readiness label (contribution done, inspect)"}${result.facts.deliverable ? ` · ${result.facts.deliverable}${result.facts.pullRequestState ? ` (${result.facts.pullRequestState})` : ""}` : ""}`,
    );
  if (result.noop) lines.push(result.reason ?? "Nothing to change.");
  if (dryRun) lines.push("DRY RUN: no changes made.");
  for (const c of ("steps" in result ? result.steps : undefined) ?? result.changes)
    lines.push(
      `- ${c.step}${c.status ? `: ${c.status}` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
      ...(dryRun ? [`    gh ${c.command.map(shellQuote).join(" ")}`] : []),
    );
  for (const n of result.notes ?? []) lines.push(`Note: ${n}`);
  if ("conflict" in result && result.conflict) lines.push(`CONFLICT: ${result.conflict}`);
  if ("unverified" in result && result.unverified) lines.push(`UNVERIFIED: ${result.unverified}`);
  if (result.retry && "exitCode" in result && result.exitCode !== 0)
    lines.push(
      retryLine(
        "steps" in result ? (result.steps ?? []) : [],
        "Retry (safe; completes only the missing steps)",
        result.retry,
      ),
    );
  return lines.join("\n") + "\n";
}

/** `error.message` as the JavaScript read it: undefined for a thrown non-Error value. */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
