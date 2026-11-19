/**
 * Refinement records and service (#1094, doc/design/estimation-refinement-loop.md "Records").
 *
 * A refinement request is one comment holding a needs-human v2 question record (so the existing
 * `pdb question resolve|withdraw`, folds and human views apply unchanged) plus a refinement v1
 * marker. A refinement v1 resolve record clears one request once its question is settled by a
 * trusted record and no newer trusted request is unsettled. `refinement:needed` indexes
 * tickets with an outstanding request; the records stay authoritative.
 *
 * This module owns the mutation mechanics (planning) and the fold to native facts. It writes
 * through the shared planner shape (`ClaimPlan` + `applyPlan`), so retries, ordered steps and
 * partial receipts are the existing ones. It adds no CLI or browser flow (#1095, #1096).
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
import type { ClaimFacts, ClaimPlan, Comment, GraphQuery, PlanStep } from "./claims.js";
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

const ordered = (comments: readonly Comment[]): ActivityComment[] =>
  comments.filter(
    (c): c is ActivityComment =>
      typeof c.databaseId === "number" && typeof c.createdAt === "string",
  );

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

/**
 * Plan a refinement request (#1094): one comment holding the needs-human v2 question and the
 * refinement v1 marker, then the index label. Preserves assignment, claims, estimates, native
 * edges and every other label. A retry with the same intent finds its trusted comment and only
 * repairs a missing label.
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
  const { viewer, authority } = await viewerAuthority(query, permission);
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      { number },
      `The authenticated account ${viewer?.login ?? "(unknown)"} must have write permission on ${repository} for the request to be trusted (${authority.why}); nothing is posted.`,
      ["gh auth status"],
    );
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
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Refinement is requested on open tickets.", [
      `${triage} --issue ${number}`,
    ]);
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the index label cannot be verified, so nothing is posted.",
      [`${triage} --issue ${number}`],
    );
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
  const mineIn = async (comments: Comment[]) => {
    for (const c of comments) {
      const parsed = parseRefinementComment(c.body ?? "");
      if (parsed.kind !== "record" || parsed.record.opId !== opId) continue;
      if ((await commentAuthority(c, permission)).status === "trusted") return true;
    }
    return false;
  };
  const history = await commentHistory(repository, number, item, mineIn, query);
  if (!history.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "The comment history is longer than the bounded read, so whether this request was already posted is unknown; nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const already = await mineIn(history.comments);
  const hasLabel = item.labels.nodes.some((l) => l.name === refinementLabel);
  // A replay of a recorded request repairs the label only while some request is outstanding:
  // after a resolve, the cleared state (no label) is correct and must not be undone.
  let outstanding = true;
  if (already) {
    const fold = await foldRefinement(repository, number, history.comments, permission);
    if (fold.unknown.length)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `Refinement or question records could not be verified (${fold.unknown.join("; ")}); nothing is changed.`,
        [`${triage} --issue ${number}`],
      );
    outstanding = fold.requests.some((q) => !q.resolved);
  }
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
  const changes: PlanStep[] = [];
  if (!already) {
    changes.push(
      writeStep("comment", {
        kind: "comment",
        repository,
        number,
        body: [
          questionRecordBody(
            { designer, agent, why, questions },
            questionMarker(opId, repository, number),
          ),
          dependencies.length
            ? `\nSuggested dependencies (not applied): ${dependencies.join(", ")}`
            : "",
          "",
          refinementMarker(record),
        ].join("\n"),
      }),
    );
  }
  if (!hasLabel && outstanding) {
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
  }
  return {
    ok: true,
    noop: !changes.length,
    facts,
    changes,
    notes: !already
      ? []
      : outstanding
        ? [`Request ${opId} is already recorded; only the index label is repaired.`]
        : [`Request ${opId} is already recorded and resolved; nothing is changed.`],
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
 * Plan clearing one refinement request (#1094). Refuses unless the evidence was read completely,
 * the request is trusted and its question is settled by a trusted resolve or withdraw, and no
 * newer trusted request is unsettled. Removes the index label only when no other request stays
 * outstanding. Never adds readiness, closes the ticket, or touches assignment, claims, estimates,
 * native edges or other labels: the item returns for estimation.
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
  const { viewer, authority } = await viewerAuthority(query, permission);
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      { number },
      `The authenticated account ${viewer?.login ?? "(unknown)"} must have write permission on ${repository} for the resolve to be trusted (${authority.why}); nothing is posted.`,
      ["gh auth status"],
    );
  const { item } = await readTicket(repository, number, agent, query, "", refinementLabel);
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
      "More than 100 labels; the index label cannot be verified, so nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  // Every request and resolution must be seen: an unseen newer request would make clearing stale.
  const history = await commentHistory(repository, number, item, () => false, query);
  if (!history.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "The comment history is longer than the bounded read, so a newer request or an earlier resolve may be unseen; nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const fold = await foldRefinement(repository, number, history.comments, permission);
  if (fold.unknown.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `Refinement or question records could not be verified (${fold.unknown.join("; ")}); nothing is posted.`,
      [`${triage} --issue ${number}`],
    );
  const target = fold.requests.find((q) => q.opId === request);
  if (!target)
    return refuse(
      "REQUEST_NOT_FOUND",
      facts,
      `No trusted refinement request ${request} on #${number}.`,
      [`${triage} --issue ${number}`],
    );
  const opId = opIdOf(["refinement-resolve", repository.toLowerCase(), number, request]);
  const hasLabel = item.labels.nodes.some((l) => l.name === refinementLabel);
  const othersOutstanding = fold.requests.some((q) => q !== target && !q.resolved);
  // Removed only when nothing stays outstanding: the label always means "some request is open".
  const removeLabel = (): PlanStep[] =>
    hasLabel && !othersOutstanding
      ? [
          writeStep("labels", {
            kind: "labels-edit",
            repository,
            number,
            add: [],
            remove: [refinementLabel],
          }),
        ]
      : [];
  if (target.resolved) {
    const mine = history.comments.find((c) => String(c.databaseId) === target.resolved!.comment);
    const parsed = mine ? parseRefinementComment(mine.body ?? "") : null;
    if (parsed?.kind === "record" && parsed.record.opId === opId) {
      // A retry after a partial write: the resolve is recorded, so only the label is repaired.
      const repair = removeLabel();
      return {
        ok: true,
        noop: !repair.length,
        facts,
        reason: `Already resolved: request ${request} (comment ${target.resolved.comment}).`,
        changes: repair,
        ...(repair.length
          ? { notes: [`The resolve is already recorded; only ${refinementLabel} is removed.`] }
          : {}),
      };
    }
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
  const newerOpen = fold.requests.filter(
    (q) => q !== target && !q.resolved && q.createdAt > target.createdAt,
  );
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
  const changes: PlanStep[] = [
    writeStep("comment", {
      kind: "comment",
      repository,
      number,
      body: [
        `**Refinement resolved** by \`${agent}\`: request \`${request}\`.`,
        "",
        `**Why:** ${why}`,
        "",
        "The ticket returns for estimation; this does not make it ready.",
        "",
        refinementMarker(record),
      ].join("\n"),
    }),
    ...removeLabel(),
  ];
  return {
    ok: true,
    noop: false,
    facts,
    changes,
    notes: othersOutstanding
      ? [`${refinementLabel} is kept: another refinement request is still outstanding.`]
      : [],
  };
}
