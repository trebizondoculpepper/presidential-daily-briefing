/**
 * Retained claims (#412, doc/design/blocked-retained-claims.md): one claim's activity with its
 * bound blocker verified on fresh reads, the admission guard that lets a new claim be taken
 * only while every other retained claim is verified waiting, and the explicit `claim wait` and
 * `claim resume` transitions. Unknown evidence is never waiting, and nothing here acquires,
 * transfers or releases a claim.
 */
import {
  activityMarker,
  activityOpId,
  activityProblem,
  classifyMarkers,
  foldClaimActivity,
  foldQuestionResolutions,
  parseActivityComment,
  parseResolutionComment,
} from "./claimactivity.js";
import type { ActivityComment, ClaimActivityRecord, WaitBlocker } from "./claimactivity.js";
import {
  claimPolicy,
  claimStart,
  commentAuthority,
  commentHistory,
  questionCommentId,
  readTicket,
  readableQuestion,
  refuse,
  viewerAuthority,
} from "./claims.js";
import type { Admission, ClaimPlan, Comment, GraphQuery, TicketIssue } from "./claims.js";
import { writeStep } from "./claims.js";
import type { PermissionLookup } from "../github/github.js";

/** Where a retained claim stands, decided from fresh, complete evidence only. */
export type RetainedState =
  | { state: "not-owned"; why: string }
  | { state: "unknown"; why: string[] }
  | { state: "active"; lastActivity: string | null }
  | { state: "waiting"; blocker: WaitBlocker; reason: string; lastActivity: string }
  /** The bound condition cleared; the claim waits for an explicit resume, never auto-resumes. */
  | {
      state: "resume-required";
      blocker: WaitBlocker;
      reason: string;
      lastActivity: string;
      cleared: string;
    };

export interface RetainedRead {
  activity: RetainedState;
  item: TicketIssue | null;
  claimStartedAt: string | null;
  comments: ActivityComment[];
  /** The agent's other open claims, and whether that list is complete. */
  others: { number: number; url: string }[];
  othersComplete: boolean;
}

const trustWith = (permission: PermissionLookup) => (c: Comment) => commentAuthority(c, permission);

export const describeBlocker = (b: WaitBlocker): string =>
  b.kind === "human"
    ? `question https://github.com/${b.repository}/issues/${b.issue}#issuecomment-${b.questionCommentId}`
    : `${b.repository}#${b.issue}`;

/** A native blocker URL (https://github.com/OWNER/NAME/issues/N) as owner/name and number. */
const blockerOf = (url: string): { repository: string; issue: number } | null => {
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)$/.exec(url);
  return m ? { repository: m[1]!, issue: Number(m[2]) } : null;
};

/** Whether `blocker` is an open native blocker of `item`: true, false, or null when unknown. */
function nativeBlockerOpen(
  item: TicketIssue,
  blocker: { repository: string; issue: number },
): boolean | null {
  const node = item.blockedBy.nodes.find((n) => {
    const b = blockerOf(n.url);
    return (
      b !== null &&
      b.repository.toLowerCase() === blocker.repository.toLowerCase() &&
      b.issue === blocker.issue
    );
  });
  if (node) return node.state === "OPEN";
  // The relationship list is one page of 20: an absent blocker may sit beyond it.
  return item.blockedBy.nodes.length >= 20 ? null : false;
}

/** The outcome of one question, from the explicit resolution records on its issue. */
async function questionOutcome(
  comments: ActivityComment[],
  repository: string,
  number: number,
  questionId: string,
  questionOpId: string,
  permission: PermissionLookup,
): Promise<
  { state: "open" } | { state: "settled"; what: string } | { state: "unknown"; why: string[] }
> {
  const classified = await classifyMarkers(
    comments,
    { repository, issue: number },
    trustWith(permission),
    parseResolutionComment,
  );
  const folded = foldQuestionResolutions(classified, new Map([[questionId, questionOpId]]));
  if (folded.unknown.length) return { state: "unknown", why: folded.unknown };
  const outcome = folded.outcomes.get(questionId);
  return outcome
    ? { state: "settled", what: `question ${questionId} ${outcome.op}d by ${outcome.agent}` }
    : { state: "open" };
}

/**
 * Verify a needs-human question on this issue: present, readable here, write-authorised, and
 * (when `opId` is given) the same operation. Returns its operation id or why it does not verify.
 */
async function verifyQuestion(
  comments: ActivityComment[],
  complete: boolean,
  repository: string,
  number: number,
  questionId: string,
  permission: PermissionLookup,
): Promise<{ ok: true; opId: string } | { ok: false; error: string; why: string }> {
  const found = comments.find((c) => String(c.databaseId) === questionId);
  if (!found)
    return complete
      ? { ok: false, error: "QUESTION_NOT_FOUND", why: `no comment ${questionId} on #${number}` }
      : {
          ok: false,
          error: "EVIDENCE_INCOMPLETE",
          why: `question ${questionId} is beyond the bounded comment history`,
        };
  const marker = readableQuestion(found.body, repository, number);
  if (!marker)
    return {
      ok: false,
      error: "NOT_A_QUESTION",
      why: `comment ${questionId} is not a readable needs-human question record on this issue`,
    };
  const authority = await commentAuthority(found, permission);
  if (authority.status !== "trusted")
    return {
      ok: false,
      error: "QUESTION_UNVERIFIED",
      why: `question ${questionId}'s author authority is not established (${authority.why})`,
    };
  return { ok: true, opId: marker.opId };
}

/**
 * Read one of `agent`'s claims afresh: ownership, the claim generation, its activity records
 * and, for a wait, whether the bound blocker still holds. `questionId` extends the comment read
 * back to a question the caller names.
 */
export async function readRetained(
  repository: string,
  number: number,
  agent: string,
  query: GraphQuery,
  permission: PermissionLookup,
  questionId: string | null = null,
): Promise<RetainedRead> {
  const ticket = await readTicket(repository, number, agent, query);
  const item = ticket.item?.__typename === "Issue" ? ticket.item : null;
  const others = ticket.claims
    .filter((c) => c.number !== number)
    .map((c) => ({ number: c.number, url: c.url }));
  const base = {
    item,
    claimStartedAt: null,
    comments: [],
    others,
    othersComplete: ticket.claimsComplete,
  };
  const mine = claimPolicy.owner(agent);
  if (!item)
    return { ...base, activity: { state: "not-owned", why: `#${number} is not an issue` } };
  if (item.labels.pageInfo?.hasNextPage)
    return {
      ...base,
      activity: { state: "unknown", why: [`#${number} has more than 100 labels`] },
    };
  if (item.state !== "OPEN" || !item.labels.nodes.some((l) => l.name === mine))
    return {
      ...base,
      activity: { state: "not-owned", why: `${agent} has no open claim on #${number}` },
    };
  const start = await claimStart(repository, number, mine, item, query);
  if (!start.since)
    return {
      ...base,
      activity: { state: "unknown", why: [`when ${agent}'s claim on #${number} began is unknown`] },
    };
  const since = start.since;
  const readBack = async (question: string | null) =>
    commentHistory(
      repository,
      number,
      item,
      (c) =>
        c.some((x) => !!x.createdAt && x.createdAt < since) &&
        (!question || c.some((x) => String(x.databaseId) === question)),
      query,
    );
  let history = await readBack(questionId);
  const classify = async () =>
    classifyMarkers(
      history.comments as ActivityComment[],
      { repository, issue: number },
      trustWith(permission),
      parseActivityComment,
    );
  let fold = foldClaimActivity(await classify(), {
    agent,
    claimStartedAt: since,
    historyComplete: history.complete,
  });
  // A wait on an older question needs the history back to that question.
  if (
    fold.state === "waiting" &&
    fold.blocker.kind === "human" &&
    fold.blocker.questionCommentId !== questionId
  ) {
    history = await readBack(fold.blocker.questionCommentId);
    fold = foldClaimActivity(await classify(), {
      agent,
      claimStartedAt: since,
      historyComplete: history.complete,
    });
  }
  const read = {
    ...base,
    claimStartedAt: since,
    comments: history.comments as ActivityComment[],
  };
  if (fold.state === "unknown") return { ...read, activity: { state: "unknown", why: fold.why } };
  if (fold.state === "active")
    return { ...read, activity: { state: "active", lastActivity: fold.lastActivity } };
  const { blocker, reason, lastActivity } = fold;
  const waiting = { state: "waiting" as const, blocker, reason, lastActivity };
  const cleared = (what: string) => ({
    ...read,
    activity: { state: "resume-required" as const, blocker, reason, lastActivity, cleared: what },
  });
  const unknown = (why: string[]) => ({ ...read, activity: { state: "unknown" as const, why } });
  if (blocker.kind === "dependency") {
    const open = nativeBlockerOpen(item, blocker);
    if (open === null)
      return unknown([`whether ${describeBlocker(blocker)} still blocks #${number} is unknown`]);
    return open
      ? { ...read, activity: waiting }
      : cleared(`${describeBlocker(blocker)} no longer blocks #${number}`);
  }
  if (blocker.repository.toLowerCase() !== repository.toLowerCase() || blocker.issue !== number)
    return unknown([`the wait's question is not on #${number}`]);
  const question = await verifyQuestion(
    read.comments,
    history.complete,
    repository,
    number,
    blocker.questionCommentId,
    permission,
  );
  if (!question.ok) return unknown([question.why]);
  if (question.opId !== blocker.questionOpId)
    return unknown([`question ${blocker.questionCommentId} is not the operation the wait names`]);
  const outcome = await questionOutcome(
    read.comments,
    repository,
    number,
    blocker.questionCommentId,
    blocker.questionOpId,
    permission,
  );
  if (outcome.state === "unknown") return unknown(outcome.why);
  return outcome.state === "settled" ? cleared(outcome.what) : { ...read, activity: waiting };
}

const stateText = (number: number, a: RetainedState): string =>
  a.state === "waiting"
    ? `#${number} waits on ${describeBlocker(a.blocker)}`
    : a.state === "resume-required"
      ? `#${number} must be resumed (${a.cleared})`
      : a.state === "active"
        ? `#${number} is active`
        : a.state === "unknown"
          ? `#${number}'s activity is unknown (${a.why.join("; ")})`
          : `#${number}: ${a.why}`;

/**
 * The admission guard: another claim is admitted only while every other retained claim is
 * verified waiting on fresh evidence. Active, resume-required and unknown claims all refuse.
 */
export const admissionFor =
  (repository: string, agent: string, query: GraphQuery, permission: PermissionLookup): Admission =>
  async (others) => {
    const waiting: string[] = [];
    const why: string[] = [];
    for (const c of others) {
      const read = await readRetained(repository, c.number, agent, query, permission);
      const a = read.activity;
      if (a.state === "waiting") waiting.push(`${stateText(c.number, a)} (${a.reason})`);
      else why.push(stateText(c.number, a));
    }
    return why.length ? { ok: false, why } : { ok: true, waiting };
  };

/** After a write, the admitted claims that no longer verify as waiting (empty when all do). */
export const stillWaitingFor =
  (repository: string, agent: string, query: GraphQuery, permission: PermissionLookup) =>
  async (numbers: number[]): Promise<string[]> => {
    const problems: string[] = [];
    for (const n of numbers) {
      const a = (await readRetained(repository, n, agent, query, permission)).activity;
      if (a.state !== "waiting")
        problems.push(`${stateText(n, a)}, so it no longer admits another claim`);
    }
    return problems;
  };

const escapeText = (text: string): string => text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The comment that appends one activity record, refused unless it reads back exactly. */
function activityComment(
  record: ClaimActivityRecord,
  headline: string,
): { body: string } | { problem: string } {
  const invalid = activityProblem(record);
  if (invalid) return { problem: invalid };
  const body = [
    headline,
    "",
    `**Why:** ${escapeText(record.reason)}`,
    "",
    activityMarker(record),
  ].join("\n");
  const back = parseActivityComment(body);
  if (back.kind !== "record" || JSON.stringify(back.record) !== JSON.stringify(record))
    return { problem: "the comment would not read back as a single valid record" };
  return { body };
}

const sameBlocker = (a: WaitBlocker, b: WaitBlocker): boolean =>
  JSON.stringify(
    a.kind === "human"
      ? ["human", a.questionCommentId]
      : ["dependency", a.repository.toLowerCase(), a.issue],
  ) ===
  JSON.stringify(
    b.kind === "human"
      ? ["human", b.questionCommentId]
      : ["dependency", b.repository.toLowerCase(), b.issue],
  );

export interface WaitRequest {
  number: number;
  agent: string;
  /** A needs-human comment URL on this issue (a human wait). */
  question?: string;
  /** An open native blocker of this issue, owner/name#N (a dependency wait). */
  blockedBy?: string;
  why: string;
}

/**
 * Plan `claim wait N --agent NAME (--question URL | --blocked-by owner/name#M) --why TEXT`:
 * append one wait record to the caller's current, active claim. It never acquires a claim or
 * suspends another agent's, and the blocker must be verified to hold now.
 */
export async function planClaimWait(
  repository: string,
  request: WaitRequest,
  query: GraphQuery,
  permission: PermissionLookup,
): Promise<ClaimPlan> {
  const { number, agent, why } = request;
  const triage = `pdb --repo ${repository}`;
  const command = (text: string) => `pdb ${text} --repo ${repository}`;
  if (!!request.question === !!request.blockedBy)
    return refuse(
      "INVALID_ARGUMENT",
      { number },
      "Name exactly one blocker: --question or --blocked-by.",
      [command(`claim wait ${number} --agent ${agent} --question URL --why TEXT`)],
    );
  const questionId = request.question
    ? questionCommentId(request.question, repository, number)
    : null;
  if (request.question && !questionId)
    return refuse(
      "QUESTION_NOT_ON_ISSUE",
      { number },
      `--question must be a needs-human comment on ${repository}#${number} (…/issues/${number}#issuecomment-ID).`,
      [`${triage} --issue ${number}`],
    );
  const dependency = request.blockedBy
    ? /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(request.blockedBy)
    : null;
  if (request.blockedBy && !dependency)
    return refuse("INVALID_ARGUMENT", { number }, "--blocked-by must be owner/name#N.", [
      command(`deps ${number} --tree`),
    ]);
  const read = await readRetained(repository, number, agent, query, permission, questionId);
  const { item, activity } = read;
  const facts = item ? { number, url: item.url, title: item.title, state: item.state } : { number };
  if (activity.state === "not-owned")
    return refuse(
      "NOT_OWNER",
      facts,
      `A wait keeps the caller's current claim; ${activity.why}. It never acquires a claim.`,
      [command(`claim ${number} --agent ${agent}`)],
    );
  if (activity.state === "unknown")
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `The claim's activity is unknown (${activity.why.join("; ")}); nothing is posted.`,
      [command(`who ${number}`)],
    );
  let blocker: WaitBlocker;
  if (questionId) {
    const q = await verifyQuestion(read.comments, true, repository, number, questionId, permission);
    if (!q.ok)
      return refuse(q.error, facts, `${q.why}; nothing is posted.`, [
        `${triage} --issue ${number}`,
      ]);
    const outcome = await questionOutcome(
      read.comments,
      repository,
      number,
      questionId,
      q.opId,
      permission,
    );
    if (outcome.state === "unknown")
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `The question's resolution records cannot be verified (${outcome.why.join("; ")}); nothing is posted.`,
        [`${triage} --issue ${number}`],
      );
    if (outcome.state === "settled")
      return refuse("QUESTION_SETTLED", facts, `There is nothing to wait on: ${outcome.what}.`, [
        command(`claim resume ${number} --agent ${agent}`),
      ]);
    blocker = {
      kind: "human",
      repository,
      issue: number,
      questionCommentId: questionId,
      questionOpId: q.opId,
    };
  } else {
    blocker = { kind: "dependency", repository: dependency![1]!, issue: Number(dependency![2]) };
    const open = item ? nativeBlockerOpen(item, blocker) : null;
    if (open !== true)
      return refuse(
        open === null ? "EVIDENCE_INCOMPLETE" : "BLOCKER_NOT_OPEN",
        facts,
        open === null
          ? `Whether ${describeBlocker(blocker)} blocks #${number} cannot be verified (more than 20 native blockers); nothing is posted.`
          : `${describeBlocker(blocker)} is not an open native blocker of #${number}; record the relationship first.`,
        [
          command(`deps add ${number} --blocked-by ${request.blockedBy}`),
          command(`deps ${number} --tree`),
        ],
      );
  }
  if (activity.state === "waiting") {
    if (sameBlocker(activity.blocker, blocker))
      return {
        ok: true,
        facts,
        noop: true,
        reason: `Already waiting on ${describeBlocker(blocker)}.`,
        changes: [],
      };
    return refuse(
      "ALREADY_WAITING",
      facts,
      `The claim already waits on ${describeBlocker(activity.blocker)}; one named blocker per wait.`,
      [command(`who ${number}`)],
    );
  }
  if (activity.state === "resume-required")
    return refuse(
      "RESUME_REQUIRED",
      facts,
      `The earlier wait cleared (${activity.cleared}); resume the claim before waiting again.`,
      [command(`claim resume ${number} --agent ${agent}`)],
    );
  const { authority, viewer } = await viewerAuthority(query, permission);
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      facts,
      `The authenticated account ${viewer?.login ?? "(unknown)"} must be a user with current write, maintain or admin permission on ${repository} to record a wait (${authority.why}); nothing is posted.`,
      ["gh auth status"],
    );
  const claimStartedAt = read.claimStartedAt!;
  const previousActivity = activity.lastActivity;
  const record: ClaimActivityRecord = {
    v: 1,
    op: "wait",
    opId: activityOpId({
      repository,
      issue: number,
      agent,
      op: "wait",
      claimStartedAt,
      previousActivity,
      blocker,
    }),
    repository,
    issue: number,
    agent,
    claimStartedAt,
    previousActivity,
    reason: why,
    blocker,
  };
  const comment = activityComment(
    record,
    `Claim kept by \`${agent}\`, waiting on ${describeBlocker(blocker)} (\`pdb claim wait\`). The claim is not released; it can be resumed with \`pdb claim resume\` once the blocker clears.`,
  );
  if ("problem" in comment)
    return refuse(
      "INVALID_ARGUMENT",
      facts,
      `The wait would not be a valid record (${comment.problem}); nothing is posted.`,
      [command(`claim wait ${number} --agent ${agent} ...`)],
    );
  return {
    ok: true,
    facts,
    noop: false,
    reason: `${agent} keeps #${number}, waiting on ${describeBlocker(blocker)}.`,
    activityOpId: record.opId,
    changes: [writeStep("comment", { kind: "comment", repository, number, body: comment.body })],
  };
}

/**
 * Plan `claim resume N --agent NAME`: make a waiting claim active again once its bound
 * condition cleared, there are no open native blockers or open questions recorded on it, and no
 * other claim of the agent is active, resume-required or unknown. Never automatic.
 */
export async function planClaimResume(
  repository: string,
  request: { number: number; agent: string },
  query: GraphQuery,
  permission: PermissionLookup,
  admission: Admission,
): Promise<ClaimPlan> {
  const { number, agent } = request;
  const triage = `pdb --repo ${repository}`;
  const command = (text: string) => `pdb ${text} --repo ${repository}`;
  const read = await readRetained(repository, number, agent, query, permission);
  const { item, activity } = read;
  const facts = item ? { number, url: item.url, title: item.title, state: item.state } : { number };
  if (activity.state === "not-owned")
    return refuse("NOT_OWNER", facts, `Resume needs the caller's claim; ${activity.why}.`, [
      command(`claim ${number} --agent ${agent}`),
    ]);
  if (activity.state === "unknown")
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `The claim's activity is unknown (${activity.why.join("; ")}); nothing is posted.`,
      [command(`who ${number}`)],
    );
  if (activity.state === "active")
    return { ok: true, facts, noop: true, reason: `#${number} is already active.`, changes: [] };
  if (activity.state === "waiting")
    return refuse(
      "BLOCKER_OPEN",
      facts,
      `#${number} still waits on ${describeBlocker(activity.blocker)}; resume only once it clears.`,
      activity.blocker.kind === "human"
        ? [
            command(
              `question resolve ${number} --agent ${agent} --question ${describeBlocker(activity.blocker).replace(/^question /, "")} --why TEXT`,
            ),
          ]
        : [command(`deps ${number} --tree`)],
    );
  // Every condition, not only the named one: open native blockers and open questions.
  if (!item!.issueDependenciesSummary)
    return refuse("EVIDENCE_INCOMPLETE", facts, `#${number}'s native blockers could not be read.`, [
      command(`deps ${number} --tree`),
    ]);
  if (item!.issueDependenciesSummary.blockedBy > 0)
    return refuse(
      "BLOCKED",
      facts,
      `#${number} still has ${item!.issueDependenciesSummary.blockedBy} open native blocker(s).`,
      [command(`deps ${number} --tree`)],
    );
  const questions = new Map<string, string>();
  const unverifiable: string[] = [];
  for (const c of read.comments) {
    const marker = readableQuestion(c.body, repository, number);
    // Legacy v1 questions keep label-based resolution; only explicit v2 questions hold a claim.
    if (marker?.version !== 2) continue;
    const authority = await commentAuthority(c, permission);
    if (authority.status === "trusted") questions.set(String(c.databaseId), marker.opId);
    // Unknown authority is missing evidence, never absence of a question.
    else if (authority.status === "unknown")
      unverifiable.push(`question ${c.databaseId} (${authority.why})`);
  }
  if (unverifiable.length)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `Whether these questions are authoritative cannot be established: ${unverifiable.join("; ")}.`,
      [`${triage} --issue ${number}`],
    );
  if (questions.size) {
    const classified = await classifyMarkers(
      read.comments,
      { repository, issue: number },
      trustWith(permission),
      parseResolutionComment,
    );
    const folded = foldQuestionResolutions(classified, questions);
    if (folded.unknown.length)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `Question resolution records cannot be verified (${folded.unknown.join("; ")}).`,
        [`${triage} --issue ${number}`],
      );
    const open = [...questions.keys()].filter((id) => !folded.outcomes.has(id));
    if (open.length)
      return refuse(
        "QUESTION_OPEN",
        facts,
        `Question(s) recorded during this claim are still open: ${open.map((id) => `comment ${id}`).join(", ")}.`,
        open.map((id) =>
          command(
            `question resolve ${number} --agent ${agent} --question https://github.com/${repository}/issues/${number}#issuecomment-${id} --why TEXT`,
          ),
        ),
      );
  }
  if (!read.othersComplete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `${agent}'s open claims could not be read completely, so whether another is active is unknown.`,
      [command(`team`)],
    );
  if (read.others.length) {
    const verdict = await admission(read.others);
    if (!verdict.ok)
      return refuse(
        "OTHER_ACTIVE_CLAIM",
        facts,
        `Resuming would make a second active claim: ${verdict.why.join("; ")}. Finish, release or validly wait on that work first; nothing is switched automatically.`,
        read.others.map((c) => command(`who ${c.number}`)),
      );
  }
  const { authority, viewer } = await viewerAuthority(query, permission);
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      facts,
      `The authenticated account ${viewer?.login ?? "(unknown)"} must be a user with current write, maintain or admin permission on ${repository} to record a resume (${authority.why}); nothing is posted.`,
      ["gh auth status"],
    );
  const claimStartedAt = read.claimStartedAt!;
  const previousActivity = activity.lastActivity;
  const record: ClaimActivityRecord = {
    v: 1,
    op: "resume",
    opId: activityOpId({
      repository,
      issue: number,
      agent,
      op: "resume",
      claimStartedAt,
      previousActivity,
    }),
    repository,
    issue: number,
    agent,
    claimStartedAt,
    previousActivity,
    reason: `Cleared: ${activity.cleared}.`,
  };
  const comment = activityComment(record, `Claim resumed by \`${agent}\` (\`pdb claim resume\`).`);
  if ("problem" in comment)
    return refuse(
      "INVALID_ARGUMENT",
      facts,
      `The resume would not be a valid record (${comment.problem}).`,
      [],
    );
  return {
    ok: true,
    facts,
    noop: false,
    reason: `${agent} resumes #${number}: ${activity.cleared}.`,
    activityOpId: record.opId,
    changes: [writeStep("comment", { kind: "comment", repository, number, body: comment.body })],
  };
}

/**
 * After `needs-human` posted its question on a claim the caller keeps: the plan for the wait
 * bound to that question, found by its operation id among write-authorised comments.
 */
export async function planWaitOnQuestion(
  repository: string,
  request: { number: number; agent: string; questionOpId: string; why: string },
  query: GraphQuery,
  permission: PermissionLookup,
): Promise<ClaimPlan> {
  const { number, agent, questionOpId, why } = request;
  const ticket = await readTicket(repository, number, agent, query);
  const item = ticket.item?.__typename === "Issue" ? ticket.item : null;
  if (!item) return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, []);
  const history = await commentHistory(
    repository,
    number,
    item,
    (c) => c.some((x) => readableQuestion(x.body, repository, number)?.opId === questionOpId),
    query,
  );
  let question: Comment | null = null;
  for (const c of [...history.comments].reverse())
    if (
      readableQuestion(c.body, repository, number)?.opId === questionOpId &&
      (await commentAuthority(c, permission)).status === "trusted"
    ) {
      question = c;
      break;
    }
  if (!question?.databaseId)
    return refuse(
      "QUESTION_NOT_FOUND",
      { number, url: item.url },
      "The question could not be read back as a write-authorised record, so no wait is recorded.",
      [`pdb --repo ${repository} --issue ${number}`],
    );
  const url = `https://github.com/${repository}/issues/${number}#issuecomment-${question.databaseId}`;
  return planClaimWait(repository, { number, agent, question: url, why }, query, permission);
}

/**
 * After appending a wait or resume: whether the transition took effect. A concurrent transition
 * on the same predecessor makes ours stale, so a successful comment write is not success; the
 * appended record must be the one the fold accepted.
 */
export async function verifyTransition(
  repository: string,
  number: number,
  agent: string,
  opId: string,
  query: GraphQuery,
  permission: PermissionLookup,
): Promise<string | null> {
  const read = await readRetained(repository, number, agent, query, permission);
  const a = read.activity;
  if (a.state === "unknown" || a.state === "not-owned")
    return `the transition could not be confirmed (${a.state === "unknown" ? a.why.join("; ") : a.why})`;
  if (a.lastActivity === null) return "the appended record is not the claim's current activity";
  const last = read.comments.find((c) => String(c.databaseId) === a.lastActivity);
  const parsed = last ? parseActivityComment(last.body) : null;
  if (parsed?.kind !== "record" || parsed.record.opId !== opId)
    return `another transition was accepted first (comment ${a.lastActivity}); this one was rejected as stale. Re-read with pdb who ${number} and decide again`;
  return null;
}
