/**
 * Refinement records and service (#1094, doc/design/estimation-refinement-loop.md "Records").
 *
 * A refinement request is one comment holding a needs-human v2 question record (so the existing
 * `pdb question resolve|withdraw`, folds and human views apply unchanged) plus a refinement v1
 * marker. A refinement v1 resolve record clears one request once its question is settled by a
 * trusted record and no newer trusted request is unsettled. `refinement:needed` indexes
 * tickets with an outstanding request; the records stay authoritative.
 *
 * This module owns the mutation mechanics and the fold to native facts. Each operation writes its
 * record through the shared planner shape (`ClaimPlan` + `applyPlan`), then reconciles the index
 * label from a fresh read, so the label follows the outstanding requests at that moment even when
 * another request lands concurrently or an earlier label write failed. It adds no CLI or browser
 * flow (#1095, #1096).
 */
import { createHash } from "node:crypto";
import {
  classifyMarkers,
  foldQuestionResolutions,
  markerOf,
  parseMarker,
  parseResolutionComment,
} from "./claimactivity.js";
import type { ActivityComment, Classified, Parsed } from "./claimactivity.js";
import {
  applyPlan,
  commentAuthority,
  commentHistory,
  questionMarker,
  questionRecordBody,
  readTicket,
  readableQuestion,
  refuse,
  viewerAuthority,
  writeStep,
} from "./claims.js";
import type {
  ClaimFacts,
  ClaimPlan,
  ClaimRefusal,
  ClaimResult,
  Comment,
  GhRun,
  GraphQuery,
  PlanStep,
} from "./claims.js";
import type { PermissionLookup } from "../github/github.js";
import type { TicketReads } from "../github/service/tickets.js";

/** The index label: present exactly while some trusted request is outstanding. */
export const refinementLabel = "refinement:needed";
export const refinementMarkerPrefix = "<!-- github-triage:refinement ";

export interface RefinementRequestRecord {
  v: 1;
  op: "request";
  opId: string;
  repository: string;
  issue: number;
  agent: string;
  /** The needs-human question in the same comment. */
  questionOpId: string;
  /** Suggested blockers (`owner/name#N`); suggestions only, never applied as native edges. */
  dependencies: string[];
}
export interface RefinementResolveRecord {
  v: 1;
  op: "resolve";
  opId: string;
  repository: string;
  issue: number;
  agent: string;
  /** The request's operation id. */
  request: string;
  reason: string;
}
export type RefinementRecord = RefinementRequestRecord | RefinementResolveRecord;

const hex16 = /^[0-9a-f]{16}$/;
const ownerName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const dependencyRef = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9]\d{0,9}$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]): string | null => {
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  return extra.length ? `unknown field(s) ${extra.join(", ")}` : null;
};

/** Schema problems of a refinement v1 payload, or null when valid. */
export function refinementProblem(v: unknown): string | null {
  if (!isObject(v)) return "payload is not an object";
  if (v.v !== 1) return "payload version is not 1";
  if (typeof v.opId !== "string" || !hex16.test(v.opId)) return "opId is not 16 hex digits";
  if (typeof v.repository !== "string" || !ownerName.test(v.repository))
    return "repository is not owner/name";
  if (typeof v.issue !== "number" || !Number.isSafeInteger(v.issue) || v.issue < 1)
    return "issue is not a positive integer";
  if (typeof v.agent !== "string" || !v.agent.trim()) return "agent is missing";
  if (v.op === "request") {
    if (typeof v.questionOpId !== "string" || !hex16.test(v.questionOpId))
      return "questionOpId is not 16 hex digits";
    if (
      !Array.isArray(v.dependencies) ||
      v.dependencies.some((d) => typeof d !== "string" || !dependencyRef.test(d))
    )
      return "dependencies are not owner/name#N references";
    return only(v, [
      "v",
      "op",
      "opId",
      "repository",
      "issue",
      "agent",
      "questionOpId",
      "dependencies",
    ]);
  }
  if (v.op === "resolve") {
    if (typeof v.request !== "string" || !hex16.test(v.request))
      return "request is not 16 hex digits";
    if (typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 1000)
      return "reason is missing or longer than 1000 characters";
    return only(v, ["v", "op", "opId", "repository", "issue", "agent", "request", "reason"]);
  }
  return "op is neither request nor resolve";
}
export const parseRefinementComment = (body: string): Parsed<RefinementRecord> =>
  parseMarker(body, refinementMarkerPrefix, refinementProblem);
export const refinementMarker = (record: RefinementRecord): string =>
  markerOf(refinementMarkerPrefix, record);

const opIdOf = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
/** Display text never carries a comment delimiter, so it cannot imitate or break a marker. */
const display = (text: string): string =>
  text.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");

/** One trusted request after folding. */
export interface FoldedRequest {
  opId: string;
  /** The request comment, which is also its needs-human question. */
  comment: string;
  createdAt: string;
  questionOpId: string;
  /** The question's first trusted explicit outcome, or none. */
  outcome: "none" | "resolve" | "withdraw";
  /** The first trusted resolve record naming this request. */
  resolved: { comment: string; createdAt: string } | null;
  dependencies: string[];
}
export interface RefinementFold {
  /** Trusted requests in comment order (oldest first). */
  requests: FoldedRequest[];
  /** Potentially authoritative records that could not be verified: the fold is incomplete. */
  unknown: string[];
  /** Records established as not counting (untrusted, foreign, unbound). */
  rejected: string[];
}

/**
 * Every comment goes to marker classification: one whose order cannot be established is reported
 * as unordered (unknown evidence), never silently dropped.
 */
const ordered = (comments: readonly Comment[]): ActivityComment[] =>
  comments as unknown as ActivityComment[];

/**
 * Fold one issue's refinement records against its question resolutions. A request counts only
 * when trusted, bound here, and its own comment is a readable needs-human question with the
 * named operation id. A resolve counts only when trusted, bound here, after the request it names,
 * and the first for that request.
 */
export async function foldRefinement(
  repository: string,
  issue: number,
  comments: readonly Comment[],
  permission: PermissionLookup,
): Promise<RefinementFold> {
  const trust = (c: Comment) => commentAuthority(c, permission);
  const notes = ordered(comments);
  const classified = await classifyMarkers(
    notes,
    { repository, issue },
    trust,
    parseRefinementComment,
  );
  const unknown: string[] = [];
  const rejected: string[] = [];
  const requests: FoldedRequest[] = [];
  const byOp = new Map<string, FoldedRequest>();
  const where = (c: Classified<RefinementRecord>) => `comment ${c.comment.databaseId}`;
  for (const c of classified) {
    if (c.status === "ignored" || c.status === "foreign") {
      rejected.push(`${where(c)}: ${c.why}`);
      continue;
    }
    if (c.status !== "trusted") {
      unknown.push(
        `${where(c)}: ${c.status === "unsupported" ? `unsupported version v${c.version}` : c.why}`,
      );
      continue;
    }
    const r = c.record;
    if (r.op === "request") {
      const question = readableQuestion(c.comment.body, repository, issue);
      if (!question || question.version !== 2 || question.opId !== r.questionOpId) {
        rejected.push(`${where(c)}: request is not bound to its own v2 question ${r.questionOpId}`);
        continue;
      }
      if (byOp.has(r.opId)) continue; // a retry's copy is the same request
      const folded: FoldedRequest = {
        opId: r.opId,
        comment: String(c.comment.databaseId),
        createdAt: c.comment.createdAt,
        questionOpId: r.questionOpId,
        outcome: "none",
        resolved: null,
        dependencies: r.dependencies,
      };
      byOp.set(r.opId, folded);
      requests.push(folded);
    } else {
      const target = byOp.get(r.request);
      if (!target) {
        rejected.push(`${where(c)}: resolves unknown or later request ${r.request}`);
        continue;
      }
      if (target.resolved) {
        rejected.push(`${where(c)}: request ${r.request} was already resolved`);
        continue;
      }
      target.resolved = { comment: String(c.comment.databaseId), createdAt: c.comment.createdAt };
    }
  }
  const resolutions = await classifyMarkers(
    notes,
    { repository, issue },
    trust,
    parseResolutionComment,
  );
  const folded = foldQuestionResolutions(
    resolutions,
    new Map(requests.map((q) => [q.comment, q.questionOpId])),
  );
  unknown.push(...folded.unknown);
  for (const q of requests) q.outcome = folded.outcomes.get(q.comment)?.op ?? "none";
  return { requests, unknown, rejected };
}

/** The native facts one issue's refinement contributes (doc/design/estimation-refinement-loop.md). */
export interface RefinementFacts {
  requests: {
    state: "open" | "resolved";
    estimated: boolean;
    question: { trust: "trusted"; version: 2; outcome: "none" | "resolved" | "withdrawn" };
  }[];
  /** False when evidence is incomplete or the index label disagrees with outstanding requests. */
  complete: boolean;
}

/**
 * Map a fold to native facts. `estimates` are the creation times of trusted complexity estimates;
 * one newer than a resolve sets `estimated`. The index label is compared with outstanding
 * (unresolved) requests only: a resolved request with its label removed is the cleared state.
 */
export function refinementFacts(
  fold: RefinementFold,
  evidence: { historyComplete: boolean; labelPresent: boolean | null; estimates: string[] },
): RefinementFacts {
  const outstanding = fold.requests.some((q) => !q.resolved);
  const labelAgrees =
    evidence.labelPresent === null ? false : evidence.labelPresent === outstanding;
  return {
    requests: fold.requests.map((q) => ({
      state: q.resolved ? "resolved" : "open",
      estimated: !!q.resolved && evidence.estimates.some((t) => t > q.resolved!.createdAt),
      question: {
        trust: "trusted",
        version: 2,
        outcome: q.outcome === "none" ? "none" : q.outcome === "resolve" ? "resolved" : "withdrawn",
      },
    })),
    complete: evidence.historyComplete && !fold.unknown.length && labelAgrees,
  };
}

export interface RefinementRequestInput {
  number: number;
  agent: string;
  /** The designer the questions are routed to (as for needs-human). */
  designer: string;
  why: string;
  /** At least one non-blank, concrete blocking question. */
  questions: string[];
  /** Optional suggested blockers, `owner/name#N`; never applied as native edges. */
  dependencies?: string[];
}

const ticketFacts = (
  number: number,
  item: { url: string; title: string; state: string; labels: { nodes: { name: string }[] } },
): ClaimFacts => ({
  number,
  url: item.url,
  title: item.title,
  state: item.state,
  labels: item.labels.nodes.map((l) => l.name),
});

type Ticket = Awaited<ReturnType<typeof readTicket>>;
type Item = Extract<NonNullable<Ticket["item"]>, { __typename: "Issue" }>;

/** Read the ticket and its complete comment history, or the refusal that applies. */
async function readComplete(
  repository: string,
  number: number,
  agent: string,
  query: GraphQuery | TicketReads,
  designer = "",
): Promise<
  | { ok: true; item: Item; repoLabels: Set<string>; facts: ClaimFacts; comments: Comment[] }
  | ClaimRefusal
> {
  const triage = `pdb --repo ${repository}`;
  const { item, repoLabels } = await readTicket(
    repository,
    number,
    agent,
    query,
    designer,
    refinementLabel,
  );
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse("NOT_AN_ISSUE", { number, url: item.url }, "Refinement is recorded on issues.", [
      `gh pr view ${number} --repo ${repository}`,
    ]);
  const facts = ticketFacts(number, item);
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the index label cannot be verified, so nothing is changed.",
      [`${triage} --issue ${number}`],
    );
  // Every request and resolve must be seen: an unseen one could make a write stale or duplicate.
  const history = await commentHistory(repository, number, item, () => false, query);
  if (!history.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "The comment history is longer than the bounded read, so a request or resolve may be unseen; nothing is changed.",
      [`${triage} --issue ${number}`],
    );
  return { ok: true, item, repoLabels, facts, comments: history.comments };
}
const isRefusal = (r: { ok: boolean }): r is ClaimRefusal => r.ok === false;

async function trustedViewer(
  repository: string,
  number: number,
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
): Promise<ClaimPlan | null> {
  const { viewer, authority } = await viewerAuthority(query, permission);
  return authority.status === "trusted"
    ? null
    : refuse(
        "MARKER_UNVERIFIED",
        { number },
        `The authenticated account ${viewer?.login ?? "(unknown)"} must have write permission on ${repository} for refinement records to be trusted (${authority.why}); nothing is changed.`,
        ["gh auth status"],
      );
}

/**
 * Plan a refinement request's record (#1094): one comment holding the needs-human v2 question and
 * the refinement v1 marker. A retry finds its trusted comment and plans nothing; a matching
 * comment whose authority cannot be established refuses rather than posting a duplicate.
 * The index label is reconciled afterwards (`planRefinementLabel`).
 */
export async function planRefinementRequest(
  repository: string,
  input: RefinementRequestInput,
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
): Promise<ClaimPlan> {
  const { number, agent, designer, why } = input;
  const triage = `pdb --repo ${repository}`;
  const questions = input.questions.map((q) => q.trim());
  if (!questions.length || questions.some((q) => !q))
    return refuse(
      "QUESTION_REQUIRED",
      { number },
      "A refinement request needs at least one non-blank, concrete blocking question.",
      [`${triage} --issue ${number}`],
    );
  if (!why.trim())
    return refuse("REASON_REQUIRED", { number }, "Say why refinement is needed.", [
      `${triage} --issue ${number}`,
    ]);
  const dependencies = [...new Set((input.dependencies ?? []).map((d) => d.trim()))];
  const bad = dependencies.filter((d) => !dependencyRef.test(d));
  if (bad.length)
    return refuse(
      "INVALID_DEPENDENCY",
      { number },
      `Suggested dependencies must be owner/name#N references: ${bad.join(", ")}.`,
      [`${triage} --issue ${number}`],
    );
  const viewerRefusal = await trustedViewer(repository, number, query, permission);
  if (viewerRefusal) return viewerRefusal;
  const read = await readComplete(repository, number, agent, query, designer);
  if (isRefusal(read)) return read;
  const { item, facts, comments } = read;
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Refinement is requested on open tickets.", [
      `${triage} --issue ${number}`,
    ]);
  const opId = opIdOf([
    "refinement-request",
    repository.toLowerCase(),
    number,
    agent,
    designer,
    why,
    questions,
    dependencies,
  ]);
  const record: RefinementRequestRecord = {
    v: 1,
    op: "request",
    opId,
    repository,
    issue: number,
    agent,
    questionOpId: opId,
    dependencies,
  };
  // Never publish a record its own reader would reject.
  const problem = refinementProblem(record);
  if (problem)
    return refuse("INVALID_RECORD", facts, `The request record would be invalid: ${problem}.`, [
      `${triage} --issue ${number}`,
    ]);
  let trusted = false;
  const unverified: string[] = [];
  for (const c of comments) {
    const parsed = parseRefinementComment(c.body ?? "");
    if (parsed.kind !== "record" || parsed.record.opId !== opId) continue;
    const authority = await commentAuthority(c, permission);
    if (authority.status === "trusted") trusted = true;
    else if (authority.status === "unknown")
      unverified.push(`comment ${c.databaseId} (${authority.why})`);
  }
  if (!trusted && unverified.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `A matching request may already be recorded, but its author could not be verified (${unverified.join("; ")}); nothing is posted.`,
      [`${triage} --issue ${number}`],
    );
  if (trusted)
    return {
      ok: true,
      noop: true,
      facts,
      reason: `Request ${opId} is already recorded.`,
      changes: [],
      questionOpId: opId,
    };
  const body = [
    questionRecordBody(
      {
        designer: display(designer),
        agent,
        why: display(why),
        questions: questions.map(display),
      },
      questionMarker(opId, repository, number),
    ),
    dependencies.length ? `\nSuggested dependencies (not applied): ${dependencies.join(", ")}` : "",
    "",
    refinementMarker(record),
  ].join("\n");
  return {
    ok: true,
    noop: false,
    facts,
    changes: [writeStep("comment", { kind: "comment", repository, number, body })],
    questionOpId: opId,
  };
}

export interface RefinementResolveInput {
  number: number;
  agent: string;
  /** The request's operation id. */
  request: string;
  why: string;
}

/**
 * Plan one request's resolve record (#1094). Refuses unless the evidence was read completely, the
 * request is trusted and its question settled by a trusted resolve or withdraw, and no request
 * after it (in comment order) is unsettled. A retry whose resolve is recorded plans nothing.
 * Never adds readiness, closes the ticket, or touches assignment, claims, estimates, native
 * edges or other labels: the item returns for estimation. The label is reconciled afterwards.
 */
export async function planRefinementResolve(
  repository: string,
  input: RefinementResolveInput,
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
): Promise<ClaimPlan> {
  const { number, agent, request, why } = input;
  const triage = `pdb --repo ${repository}`;
  if (!hex16.test(request))
    return refuse("REQUEST_INVALID", { number }, "The request is a 16-hex operation id.", [
      `${triage} --issue ${number}`,
    ]);
  if (!why.trim())
    return refuse("REASON_REQUIRED", { number }, "Say why the refinement is resolved.", [
      `${triage} --issue ${number}`,
    ]);
  const viewerRefusal = await trustedViewer(repository, number, query, permission);
  if (viewerRefusal) return viewerRefusal;
  const read = await readComplete(repository, number, agent, query);
  if (isRefusal(read)) return read;
  const { facts, comments } = read;
  const fold = await foldRefinement(repository, number, comments, permission);
  if (fold.unknown.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `Refinement or question records could not be verified (${fold.unknown.join("; ")}); nothing is posted.`,
      [`${triage} --issue ${number}`],
    );
  const at = fold.requests.findIndex((q) => q.opId === request);
  const target = fold.requests[at];
  if (!target)
    return refuse(
      "REQUEST_NOT_FOUND",
      facts,
      `No trusted refinement request ${request} on #${number}.`,
      [`${triage} --issue ${number}`],
    );
  const opId = opIdOf(["refinement-resolve", repository.toLowerCase(), number, request]);
  if (target.resolved) {
    const mine = comments.find((c) => String(c.databaseId) === target.resolved!.comment);
    const parsed = mine ? parseRefinementComment(mine.body ?? "") : null;
    if (parsed?.kind === "record" && parsed.record.opId === opId)
      return {
        ok: true,
        noop: true,
        facts,
        reason: `Already resolved: request ${request} (comment ${target.resolved.comment}).`,
        changes: [],
      };
    return refuse(
      "REQUEST_ALREADY_RESOLVED",
      facts,
      `Request ${request} was already resolved (comment ${target.resolved.comment}).`,
      [`${triage} --issue ${number}`],
    );
  }
  if (target.outcome === "none")
    return refuse(
      "QUESTIONS_UNSETTLED",
      facts,
      `Request ${request}'s question (comment ${target.comment}) has no trusted resolve or withdraw yet; answer it with pdb question resolve|withdraw first.`,
      [
        `pdb question resolve ${number} --question https://github.com/${repository}/issues/${number}#issuecomment-${target.comment} --why TEXT --repo ${repository}`,
      ],
    );
  // Comment order (creation time, then id), as the fold sorted them: ties are not missed.
  const newerOpen = fold.requests.slice(at + 1).filter((q) => !q.resolved);
  if (newerOpen.length)
    return refuse(
      "NEWER_REQUEST_OPEN",
      facts,
      `A newer refinement request is unresolved (${newerOpen.map((q) => q.opId).join(", ")}); clearing ${request} now would be stale.`,
      [`${triage} --issue ${number}`],
    );
  const record: RefinementResolveRecord = {
    v: 1,
    op: "resolve",
    opId,
    repository,
    issue: number,
    agent,
    request,
    reason: why,
  };
  // Never publish a record its own reader would reject: it would be authoritative yet unusable.
  const problem = refinementProblem(record);
  if (problem)
    return refuse("INVALID_RECORD", facts, `The resolve record would be invalid: ${problem}.`, [
      `${triage} --issue ${number}`,
    ]);
  const body = [
    `**Refinement resolved** by \`${agent}\`: request \`${request}\`.`,
    "",
    `**Why:** ${display(why)}`,
    "",
    "The ticket returns for estimation; this does not make it ready.",
    "",
    refinementMarker(record),
  ].join("\n");
  return {
    ok: true,
    noop: false,
    facts,
    changes: [writeStep("comment", { kind: "comment", repository, number, body })],
  };
}

/**
 * Plan the index label from a fresh, complete fold: `refinement:needed` is present exactly while
 * some trusted request is outstanding. Refuses on incomplete or unverifiable evidence rather than
 * guessing, so a label is never set or cleared on partial knowledge.
 */
export async function planRefinementLabel(
  repository: string,
  number: number,
  agent: string,
  query: GraphQuery | TicketReads,
  permission: PermissionLookup,
): Promise<ClaimPlan> {
  const triage = `pdb --repo ${repository}`;
  const read = await readComplete(repository, number, agent, query);
  if (isRefusal(read)) return read;
  const { item, repoLabels, facts, comments } = read;
  const fold = await foldRefinement(repository, number, comments, permission);
  if (fold.unknown.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `Refinement or question records could not be verified (${fold.unknown.join("; ")}); ${refinementLabel} is left as it is.`,
      [`${triage} --issue ${number}`],
    );
  const outstanding = fold.requests.some((q) => !q.resolved);
  const present = item.labels.nodes.some((l) => l.name === refinementLabel);
  const changes: PlanStep[] = [];
  if (outstanding && !present) {
    if (!repoLabels.has(refinementLabel))
      changes.push(
        writeStep("create-label", {
          kind: "label-create",
          repository,
          name: refinementLabel,
          color: "d4c5f9",
        }),
      );
    changes.push(
      writeStep("labels", {
        kind: "labels-edit",
        repository,
        number,
        add: [refinementLabel],
        remove: [],
      }),
    );
  } else if (!outstanding && present)
    changes.push(
      writeStep("labels", {
        kind: "labels-edit",
        repository,
        number,
        add: [],
        remove: [refinementLabel],
      }),
    );
  return {
    ok: true,
    noop: !changes.length,
    facts,
    changes,
  };
}

export interface RefinementWrites {
  run?: GhRun;
  query: GraphQuery | TicketReads;
  permission: PermissionLookup;
}

/**
 * Apply a planned record, then reconcile the index label from a fresh read. The receipt lists
 * every step in order; a failed or unreconcilable label after a written record is a partial
 * outcome (exit 2), and the record stays authoritative.
 */
async function writeThenIndex(
  repository: string,
  plan: ClaimPlan,
  number: number,
  agent: string,
  { run, query, permission }: RefinementWrites,
): Promise<ClaimResult> {
  if (!plan.ok) return { ...plan, exitCode: 1 };
  const steps: PlanStep[] = [];
  if (!plan.noop) {
    const written = await applyPlan(repository, plan, { ...(run ? { run } : {}), query });
    if (written.exitCode !== 0) return written;
    steps.push(...(written.steps ?? []));
  }
  const label = await planRefinementLabel(repository, number, agent, query, permission);
  let exitCode = 0;
  let unverified: string | null = null;
  if (!label.ok) {
    unverified = `${refinementLabel} could not be reconciled: ${label.prerequisite}`;
    exitCode = steps.length ? 2 : 1;
  } else if (!label.noop) {
    const indexed = await applyPlan(repository, label, { ...(run ? { run } : {}), query });
    steps.push(...(indexed.steps ?? []));
    if (indexed.exitCode !== 0) exitCode = steps.some((s) => s.status === "done") ? 2 : 1;
  }
  return {
    ...plan,
    noop: !steps.length && !unverified,
    changes: [...plan.changes, ...(label.ok ? label.changes : [])],
    steps,
    conflict: null,
    unverified,
    exitCode,
  };
}

/** Request refinement: write the record (if not already recorded), then reconcile the label. */
export async function requestRefinement(
  repository: string,
  input: RefinementRequestInput,
  writes: RefinementWrites,
): Promise<ClaimResult> {
  const plan = await planRefinementRequest(repository, input, writes.query, writes.permission);
  return writeThenIndex(repository, plan, input.number, input.agent, writes);
}

/** Resolve one request: write the resolve (if not already recorded), then reconcile the label. */
export async function resolveRefinement(
  repository: string,
  input: RefinementResolveInput,
  writes: RefinementWrites,
): Promise<ClaimResult> {
  const plan = await planRefinementResolve(repository, input, writes.query, writes.permission);
  return writeThenIndex(repository, plan, input.number, input.agent, writes);
}
