/**
 * Claim-activity and question-resolution records (#412, doc/design/blocked-retained-claims.md
 * "Minimal claim-activity interface for #412"). Pure: markers, strict validation, authority-first
 * classification and the fold that decides whether one agent's retained claim is active,
 * waiting or unknown. Writing these records, the wait/resume/resolve commands and the claim
 * admission guard build on this module; nothing here changes any behaviour by itself.
 *
 * Comment identities are the comment's numeric `databaseId` as a string: collected comments
 * carry it (it already orders delivery records), while GraphQL node IDs are not fetched.
 */
import { createHash } from "node:crypto";
import { isAgentName } from "../config/identity.js";

// Structural copies of claims.ts's Comment and delivery.ts's TrustDecision, so claims.ts can
// use this module without an import cycle (src/acceptance/importcycles.test.ts).
type Actor = { __typename?: string; login?: string };
export type Comment = {
  body: string;
  createdAt?: string;
  author?: Actor | null;
  lastEditedAt?: string | null;
  includesCreatedEdit?: boolean;
  editor?: Actor | null;
};
export type TrustDecision = (
  comment: Comment,
) => Promise<{ status: "trusted" } | { status: "untrusted" | "unknown"; why: string }>;

export const activityMarkerPrefix = "<!-- github-triage:claim-activity ";
export const resolutionMarkerPrefix = "<!-- github-triage:question-resolution ";
const version = 1;

export type ActivityComment = Comment & { databaseId: number; createdAt: string; url?: string };

export type WaitBlocker =
  | {
      kind: "human";
      repository: string;
      issue: number;
      /** The needs-human comment that holds the question. */
      questionCommentId: string;
      /** That needs-human operation's ID. */
      questionOpId: string;
    }
  | { kind: "dependency"; repository: string; issue: number };

export interface ClaimActivityRecord {
  v: 1;
  op: "wait" | "resume";
  opId: string;
  repository: string;
  issue: number;
  agent: string;
  /** Server time of the latest addition of this agent's claim label (the claim generation). */
  claimStartedAt: string;
  /** The preceding valid activity comment of this generation, or null for the first. */
  previousActivity: string | null;
  reason: string;
  /** Present exactly for a wait. */
  blocker?: WaitBlocker;
}

export interface QuestionResolutionRecord {
  v: 1;
  op: "resolve" | "withdraw";
  opId: string;
  repository: string;
  issue: number;
  questionCommentId: string;
  questionOpId: string;
  agent: string;
  reason: string;
}

const ownerName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIssue = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isCommentId = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);
const isReason = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 1000;

/** Exactly these keys, so a payload cannot smuggle unreviewed fields past the reader. */
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  return extra.length ? `unknown field(s) ${extra.join(", ")}` : null;
};

function blockerProblem(v: unknown): string | null {
  if (!isObject(v)) return "blocker is not an object";
  if (!isString(v.repository) || !ownerName.test(v.repository))
    return "blocker repository is not owner/name";
  if (!isIssue(v.issue)) return "blocker issue is not a positive integer";
  if (v.kind === "dependency") return onlyKeys(v, ["kind", "repository", "issue"]);
  if (v.kind === "human") {
    if (!isCommentId(v.questionCommentId)) return "human blocker has no question comment id";
    if (!isString(v.questionOpId)) return "human blocker has no question operation id";
    return onlyKeys(v, ["kind", "repository", "issue", "questionCommentId", "questionOpId"]);
  }
  return "blocker kind is neither human nor dependency";
}

/** Schema problems of a claim-activity v1 payload, or null when valid. */
export function activityProblem(v: unknown): string | null {
  if (!isObject(v)) return "payload is not an object";
  if (v.v !== version) return "payload version is not 1";
  if (v.op !== "wait" && v.op !== "resume") return "op is neither wait nor resume";
  if (!isString(v.opId)) return "opId is missing";
  if (!isString(v.repository) || !ownerName.test(v.repository))
    return "repository is not owner/name";
  if (!isIssue(v.issue)) return "issue is not a positive integer";
  if (!isString(v.agent) || !isAgentName(v.agent)) return "agent is not a valid name";
  if (!isString(v.claimStartedAt) || Number.isNaN(Date.parse(v.claimStartedAt)))
    return "claimStartedAt is not a timestamp";
  if (v.previousActivity !== null && !isCommentId(v.previousActivity))
    return "previousActivity is neither null nor a comment id";
  if (!isReason(v.reason)) return "reason is missing or longer than 1000 characters";
  if (v.op === "wait") {
    const problem = blockerProblem(v.blocker);
    if (problem) return problem;
  } else if (v.blocker !== undefined) return "a resume carries no blocker";
  return onlyKeys(v, [
    "v",
    "op",
    "opId",
    "repository",
    "issue",
    "agent",
    "claimStartedAt",
    "previousActivity",
    "reason",
    ...(v.op === "wait" ? ["blocker"] : []),
  ]);
}

/** Schema problems of a question-resolution v1 payload, or null when valid. */
export function resolutionProblem(v: unknown): string | null {
  if (!isObject(v)) return "payload is not an object";
  if (v.v !== version) return "payload version is not 1";
  if (v.op !== "resolve" && v.op !== "withdraw") return "op is neither resolve nor withdraw";
  if (!isString(v.opId)) return "opId is missing";
  if (!isString(v.repository) || !ownerName.test(v.repository))
    return "repository is not owner/name";
  if (!isIssue(v.issue)) return "issue is not a positive integer";
  if (!isCommentId(v.questionCommentId)) return "questionCommentId is not a comment id";
  if (!isString(v.questionOpId)) return "questionOpId is missing";
  if (!isString(v.agent) || !isAgentName(v.agent)) return "agent is not a valid name";
  if (!isReason(v.reason)) return "reason is missing or longer than 1000 characters";
  return onlyKeys(v, [
    "v",
    "op",
    "opId",
    "repository",
    "issue",
    "questionCommentId",
    "questionOpId",
    "agent",
    "reason",
  ]);
}

export type Parsed<T> =
  | { kind: "none" }
  | { kind: "record"; record: T }
  | { kind: "malformed"; why: string }
  | { kind: "unsupported"; version: string };

function parseMarker<T>(
  body: string,
  prefix: string,
  problem: (v: unknown) => string | null,
): Parsed<T> {
  const at = body.indexOf(prefix);
  if (at < 0) return { kind: "none" };
  if (body.indexOf(prefix, at + 1) >= 0)
    return { kind: "malformed", why: "more than one marker in one comment" };
  const rest = body.slice(at + prefix.length);
  const token = /^v(\S*)\s/.exec(rest);
  if (!token) return { kind: "malformed", why: "marker has no version token" };
  if (token[1] !== String(version))
    return /^\d+$/.test(token[1]) && Number(token[1]) > version
      ? { kind: "unsupported", version: token[1] }
      : { kind: "malformed", why: `marker version v${token[1]} is not recognised` };
  const end = rest.indexOf(" -->", token[0].length);
  if (end < 0) return { kind: "malformed", why: "marker is not terminated" };
  let payload: unknown;
  try {
    payload = JSON.parse(rest.slice(token[0].length, end));
  } catch {
    return { kind: "malformed", why: "payload is not JSON" };
  }
  const why = problem(payload);
  return why ? { kind: "malformed", why } : { kind: "record", record: payload as T };
}

const markerOf = (prefix: string, record: object): string =>
  `${prefix}v${version} ${JSON.stringify(record).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")} -->`;

export const parseActivityComment = (body: string): Parsed<ClaimActivityRecord> =>
  parseMarker(body, activityMarkerPrefix, activityProblem);
export const parseResolutionComment = (body: string): Parsed<QuestionResolutionRecord> =>
  parseMarker(body, resolutionMarkerPrefix, resolutionProblem);
export const activityMarker = (record: ClaimActivityRecord): string =>
  markerOf(activityMarkerPrefix, record);
export const resolutionMarker = (record: QuestionResolutionRecord): string =>
  markerOf(resolutionMarkerPrefix, record);

/**
 * Deterministic operation ID from the normalized intent and the claim generation, so a retry
 * finds its earlier successful append instead of posting a duplicate.
 */
export function activityOpId(intent: {
  repository: string;
  issue: number;
  agent: string;
  op: "wait" | "resume";
  claimStartedAt: string;
  /** The predecessor this transition follows: a later wait/resume cycle gets a new id. */
  previousActivity: string | null;
  blocker?: WaitBlocker;
}): string {
  const blocker = intent.blocker
    ? intent.blocker.kind === "human"
      ? ["human", intent.blocker.questionCommentId]
      : ["dependency", intent.blocker.repository.toLowerCase(), intent.blocker.issue]
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "claim-activity",
        intent.repository.toLowerCase(),
        intent.issue,
        intent.agent,
        intent.op,
        intent.claimStartedAt,
        intent.previousActivity,
        blocker,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** A recognized record after authority, ordering and binding checks. */
export type Classified<T> = { comment: ActivityComment; login: string } & (
  | { status: "trusted"; record: T }
  | { status: "malformed"; why: string }
  | { status: "unsupported"; version: string }
  | { status: "unverified"; why: string }
  | { status: "ignored"; why: string }
  | { status: "unordered"; why: string }
  | { status: "foreign"; why: string }
);

const orderingProblem = (c: ActivityComment): string | null =>
  typeof c.createdAt !== "string" || Number.isNaN(Date.parse(c.createdAt))
    ? "comment has no creation time, so its order is unknown"
    : !isIssue(c.databaseId)
      ? "comment has no numeric id to break ties, so its order is unknown"
      : null;
/** Server comment order: creation time, then comment id; payload time is never used. */
const byCommentOrder = (a: ActivityComment, b: ActivityComment): number => {
  const [x, y] = [orderingProblem(a) === null, orderingProblem(b) === null];
  if (!x || !y) return x === y ? 0 : x ? -1 : 1;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.databaseId - b.databaseId;
};

/**
 * Authority first (a verified non-writer's malformed or future record cannot block anything),
 * then ordering, schema and the repository/issue binding, as for delivery records.
 */
export async function classifyMarkers<T extends { repository: string; issue: number }>(
  comments: readonly ActivityComment[],
  binding: { repository: string; issue: number },
  trust: TrustDecision,
  parse: (body: string) => Parsed<T>,
): Promise<Classified<T>[]> {
  const out: Classified<T>[] = [];
  for (const comment of [...comments].sort(byCommentOrder)) {
    const parsed = parse(comment.body);
    if (parsed.kind === "none") continue;
    const login = comment.author?.login;
    if (!isString(login)) {
      out.push({
        comment,
        login: "(author not established)",
        status: "unverified",
        why: "comment author could not be established",
      });
      continue;
    }
    const authority = await trust(comment);
    if (authority.status === "untrusted") {
      out.push({ comment, login, status: "ignored", why: authority.why });
      continue;
    }
    if (authority.status === "unknown") {
      out.push({ comment, login, status: "unverified", why: authority.why });
      continue;
    }
    const unordered = orderingProblem(comment);
    if (unordered) out.push({ comment, login, status: "unordered", why: unordered });
    else if (parsed.kind === "malformed")
      out.push({ comment, login, status: "malformed", why: parsed.why });
    else if (parsed.kind === "unsupported")
      out.push({ comment, login, status: "unsupported", version: parsed.version });
    else if (
      parsed.record.repository.toLowerCase() !== binding.repository.toLowerCase() ||
      parsed.record.issue !== binding.issue
    )
      out.push({
        comment,
        login,
        status: "foreign",
        why: `record is bound to ${parsed.record.repository}#${parsed.record.issue}, not ${binding.repository}#${binding.issue}`,
      });
    else out.push({ comment, login, status: "trusted", record: parsed.record });
  }
  return out;
}

/** One agent's retained claim, as its trusted activity records establish it. */
export type ClaimActivity =
  | {
      state: "active";
      /** The last valid activity comment of this generation, the next record's predecessor. */
      lastActivity: string | null;
      rejected: string[];
    }
  | {
      state: "waiting";
      blocker: WaitBlocker;
      reason: string;
      lastActivity: string;
      rejected: string[];
    }
  | { state: "unknown"; why: string[]; rejected: string[] };

/**
 * Fold one agent's activity for its current claim generation. Legacy claims without records are
 * active. Records of another generation (an earlier claim) or with a stale predecessor are
 * rejected visibly and never suspend the claim; any unreadable, unverified, unsupported or
 * unordered record, an incomplete history, or an unknown generation makes the activity unknown,
 * which is never equivalent to waiting.
 */
export function foldClaimActivity(
  classified: readonly Classified<ClaimActivityRecord>[],
  claim: { agent: string; claimStartedAt: string | null; historyComplete: boolean },
): ClaimActivity {
  const rejected: string[] = [];
  const unknown: string[] = [];
  if (!claim.claimStartedAt) unknown.push("the claim's start could not be established");
  if (!claim.historyComplete) unknown.push("comment history is incomplete");
  let state: "active" | "waiting" = "active";
  let lastActivity: string | null = null;
  let wait: { blocker: WaitBlocker; reason: string } | null = null;
  for (const c of classified) {
    const where = `comment ${c.comment.databaseId}`;
    if (c.status === "ignored" || c.status === "foreign") {
      rejected.push(`${where}: ${c.why}`);
      continue;
    }
    if (c.status !== "trusted") {
      // A potentially authoritative record this reader cannot use: unknown, not ignorable.
      unknown.push(
        `${where}: ${c.status === "unsupported" ? `unsupported version v${c.version}` : c.why}`,
      );
      continue;
    }
    const r = c.record;
    if (r.agent !== claim.agent) continue;
    if (r.claimStartedAt !== claim.claimStartedAt) {
      rejected.push(`${where}: bound to an earlier claim (${r.claimStartedAt})`);
      continue;
    }
    if (r.previousActivity !== lastActivity) {
      rejected.push(`${where}: stale predecessor ${r.previousActivity ?? "none"}`);
      continue;
    }
    if (r.op === "wait" && state === "active") {
      state = "waiting";
      wait = { blocker: r.blocker!, reason: r.reason };
    } else if (r.op === "resume" && state === "waiting") {
      state = "active";
      wait = null;
    } else {
      rejected.push(`${where}: ${r.op} does not apply while ${state}`);
      continue;
    }
    lastActivity = String(c.comment.databaseId);
  }
  if (unknown.length) return { state: "unknown", why: unknown, rejected };
  return state === "waiting"
    ? { state, blocker: wait!.blocker, reason: wait!.reason, lastActivity: lastActivity!, rejected }
    : { state, lastActivity, rejected };
}

/** The explicit outcome of one question: resolved or withdrawn, by its comment id. */
export interface QuestionOutcome {
  op: "resolve" | "withdraw";
  agent: string;
  reason: string;
  /** The resolution comment. */
  comment: string;
}

/**
 * Explicit resolutions by question comment id, checked against the questions the caller read:
 * `questions` maps each needs-human comment id to its operation id. A resolution naming an
 * unknown question, or the right comment with another operation id, is rejected before it can
 * be selected. The first exactly bound trusted resolution wins; later ones are rejected.
 * Unknown potentially authoritative records are reported, so a reader can refuse to call a
 * question unresolved or resolved by guesswork.
 */
export function foldQuestionResolutions(
  classified: readonly Classified<QuestionResolutionRecord>[],
  questions: ReadonlyMap<string, string>,
): { outcomes: Map<string, QuestionOutcome>; unknown: string[]; rejected: string[] } {
  const outcomes = new Map<string, QuestionOutcome & { questionOpId: string }>();
  const unknown: string[] = [];
  const rejected: string[] = [];
  for (const c of classified) {
    const where = `comment ${c.comment.databaseId}`;
    if (c.status === "ignored" || c.status === "foreign") {
      rejected.push(`${where}: ${c.why}`);
      continue;
    }
    if (c.status !== "trusted") {
      unknown.push(
        `${where}: ${c.status === "unsupported" ? `unsupported version v${c.version}` : c.why}`,
      );
      continue;
    }
    const r = c.record;
    const questionOp = questions.get(r.questionCommentId);
    if (questionOp === undefined) {
      rejected.push(`${where}: no question ${r.questionCommentId} on this issue`);
      continue;
    }
    if (questionOp !== r.questionOpId) {
      rejected.push(
        `${where}: bound to operation ${r.questionOpId}, not the question's ${questionOp}`,
      );
      continue;
    }
    const earlier = outcomes.get(r.questionCommentId);
    if (earlier) {
      rejected.push(`${where}: question ${r.questionCommentId} was already ${earlier.op}d`);
      continue;
    }
    outcomes.set(r.questionCommentId, {
      op: r.op,
      agent: r.agent,
      reason: r.reason,
      comment: String(c.comment.databaseId),
      questionOpId: r.questionOpId,
    });
  }
  return {
    outcomes: new Map([...outcomes].map(([id, { questionOpId: _op, ...o }]) => [id, o])),
    unknown,
    rejected,
  };
}
