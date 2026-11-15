/**
 * Fold one ticket's needs-human questions against explicit resolve/withdraw records (#412,
 * #414). Shared by the open-ticket reader (human.ts) and the closed-source collector
 * (closedquestions.ts), so both bind an outcome to exactly the question it names.
 *
 * A question is its marker: retries and copies by trusted authors are one question whose
 * canonical source is the oldest trusted comment, and an explicit outcome on any of those comments
 * settles it. Only trusted comments join a question, so an untrusted copy can neither hide nor
 * answer the original. The host decides only trust and outcome; the policy decides what is shown.
 */
import type { Comment, Issue } from "../github/types.js";
import type { QuestionRecordFact } from "../rules/datalog/datalog.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { parseQuestionMarker } from "../workflow/claims.js";
import {
  classifyMarkers,
  foldQuestionResolutions,
  parseResolutionComment,
} from "../workflow/claimactivity.js";
import type { ActivityComment } from "../workflow/claimactivity.js";
import { parseQuestionRecord } from "./questionrecord.js";
import type { HumanRecord } from "./questionrecord.js";

/**
 * Labels that keep a legacy v1 question open: the policy's `question-label` set
 * (src/rules/datalog/policy/schema.edn). Used only to choose which records an item lists.
 */
export const legacyQuestionLabels: readonly string[] = ["question", "design:decision-needed"];

export interface QuestionCounts {
  /** Trusted questions with no explicit outcome; a legacy v1 one may still be resolved by labels. */
  noOutcome: number;
  unknown: number;
  resolved: number;
  withdrawn: number;
  untrusted: number;
  unverified: number;
}
export const emptyQuestionCounts = (): QuestionCounts => ({
  noOutcome: 0,
  unknown: 0,
  resolved: 0,
  withdrawn: 0,
  untrusted: 0,
  unverified: 0,
});

/** One question with its explicit outcome. */
export interface FoldedQuestion {
  record: HumanRecord;
  fact: QuestionRecordFact;
}
export interface FoldedSource {
  /** Every readable needs-human record that names this ticket, trusted or not. */
  candidates: number;
  /** Trusted questions, newest first, each with its outcome fact. */
  questions: FoldedQuestion[];
  /** Questions an item may list: not settled, and not a legacy question resolved by labels. */
  open: HumanRecord[];
  /** Addressees of records whose author's authority could not be verified. */
  unverifiedTo: string[];
}

/**
 * Fold the needs-human records of `issue` (whose comments are `comments`). `historyComplete`
 * false, an unverifiable resolution record or a missing comment id make an unsettled outcome
 * `unknown`, never "none". Warnings are `${url}: …` and counts are added to `counts`.
 */
export async function foldSourceQuestions(
  repository: string,
  issue: Issue,
  comments: readonly Comment[],
  historyComplete: boolean,
  trust: TrustDecision | undefined,
  counts: QuestionCounts,
  warnings: string[],
  where: string,
): Promise<FoldedSource> {
  const url = issue.url;
  const candidates: { comment: Comment; record: HumanRecord }[] = [];
  for (const comment of comments) {
    const record = parseQuestionRecord(comment);
    if (!record) continue;
    const marker = parseQuestionMarker(comment.body ?? "");
    // A v2 record copied from another issue never becomes this issue's question (#412).
    if (
      marker?.version === 2 &&
      (marker.repository.toLowerCase() !== repository.toLowerCase() ||
        marker.issue !== issue.number)
    ) {
      warnings.push(
        `${url}: question record ${comment.url} is bound to ${marker.repository}#${marker.issue}; ignored.`,
      );
      continue;
    }
    // A malformed marker is missing evidence, never read as a legacy question.
    if (marker?.version === "malformed") {
      counts.unverified++;
      warnings.push(
        `${url}: question record ${comment.url} has a malformed marker (${marker.why}); ignored.`,
      );
      continue;
    }
    candidates.push({ comment, record });
  }
  const none: FoldedSource = {
    candidates: candidates.length,
    questions: [],
    open: [],
    unverifiedTo: [],
  };
  if (!candidates.length) return none;
  if (!trust) {
    counts.unverified += candidates.length;
    warnings.push(
      `${url}: question record authors' permissions were not read; questions on ${where} are unverified.`,
    );
    return none;
  }
  const ordered = comments.filter(
    (c) => typeof c.databaseId === "number" && typeof c.createdAt === "string",
  ) as ActivityComment[];
  const questionIds = new Map(
    candidates
      .filter((c) => typeof c.comment.databaseId === "number")
      .map((c) => [String(c.comment.databaseId), c.record.opId]),
  );
  const folded = foldQuestionResolutions(
    await classifyMarkers(
      ordered,
      { repository, issue: issue.number },
      trust,
      parseResolutionComment,
    ),
    questionIds,
  );
  for (const gap of folded.unknown)
    warnings.push(`${url}: a question-resolution record could not be verified (${gap}).`);
  const unverifiedTo: string[] = [];
  const byMarker = new Map<string, { record: HumanRecord; ids: (string | null)[] }>();
  for (const { comment, record } of candidates) {
    const authority = await trust(comment);
    if (authority.status === "untrusted") {
      counts.untrusted++;
      continue;
    }
    if (authority.status === "unknown") {
      counts.unverified++;
      unverifiedTo.push(record.to);
      warnings.push(
        `${url}: authority of the question record ${record.url} on ${where} could not be verified (${authority.why}).`,
      );
      continue;
    }
    const id = typeof comment.databaseId === "number" ? String(comment.databaseId) : null;
    const known = byMarker.get(record.marker);
    if (known) known.ids.push(id);
    else byMarker.set(record.marker, { record, ids: [id] });
  }
  if (
    [...byMarker.values()].some((q) => q.record.version === 1) &&
    issue.labels.pageInfo.hasNextPage
  )
    warnings.push(
      `${url}: labels of ${where} are truncated; whether its legacy question is resolved is unknown.`,
    );
  const questions: FoldedQuestion[] = [];
  const open: HumanRecord[] = [];
  for (const { record, ids } of [...byMarker.values()].reverse()) {
    const outcome = ids.map((id) => (id ? folded.outcomes.get(id) : undefined)).find(Boolean);
    const missingId = ids.includes(null);
    const state: NonNullable<QuestionRecordFact["outcome"]> = outcome
      ? outcome.op === "resolve"
        ? "resolved"
        : "withdrawn"
      : missingId || !historyComplete || folded.unknown.length
        ? "unknown"
        : "none";
    if (state === "resolved") counts.resolved++;
    else if (state === "withdrawn") counts.withdrawn++;
    else if (state === "unknown") counts.unknown++;
    else counts.noOutcome++;
    if (state === "unknown" && missingId)
      warnings.push(
        `${url}: question record ${record.url} has no comment id; its resolution is unknown.`,
      );
    const fact: QuestionRecordFact = {
      trust: "trusted",
      to: record.to,
      version: record.version,
      outcome: state,
    };
    questions.push({ record, fact });
    const legacyResolved =
      record.version === 1 &&
      !issue.labels.pageInfo.hasNextPage &&
      !issue.labels.nodes.some((l) => legacyQuestionLabels.includes(l.name));
    if ((state === "none" || state === "unknown") && !legacyResolved) open.push(record);
  }
  return { candidates: candidates.length, questions, open, unverifiedTo };
}
