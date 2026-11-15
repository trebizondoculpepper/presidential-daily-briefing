/**
 * Human briefing (#457). Contract: doc/design/human-briefing.md.
 *
 * The host half of the `human` role: it reads needs-human question records from the comments
 * already collected, applies the #212 marker trust rule, hands the policy trust and routing facts,
 * and projects the Datalog decisions into human items. Which evidence becomes an item, whether it
 * is explicit or inferred, whether it is addressed and the order are all decided by the policy
 * (src/rules/datalog/policy/decisions.edn, rules D-HUMAN-*). Nothing here grants claim rights or
 * writes anything.
 */
import type { Comment, Issue, PullRequest, Snapshot } from "../github/types.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { cacheWord } from "./briefing.js";
import { parseQuestionMarker, parseQuestionRecordBody } from "../workflow/claims.js";
import type { Comment as MarkerComment } from "../workflow/claims.js";
import type { DatalogAction, QuestionRecordFact } from "../rules/datalog/datalog.js";

export const humanPolicy = {
  /** Prefix of the hidden marker `pdb needs-human` writes (src/workflow/claims.ts). */
  recordMarker: "<!-- github-triage:needs-human:",
  /** Questions shown per item; the rest are counted in the item's warnings. */
  maxQuestions: 5,
  /** Longest question, reason or routing text shown. */
  maxText: 280,
  /** Dependents listed per item. */
  maxBlocks: 5,
  /** Codes on the policy's decisions (D-HUMAN-*, and D-ATTENTION's `addressed`). */
  explicitCodes: ["explicit", "addressed"],
  addressedCode: "addressed",
  excluded: ["closed tickets (#414)", "GitHub review requests (not collected)"],
} as const;

/** One parsed needs-human record. */
export interface HumanRecord {
  /** The record comment's URL: the focused source link. */
  url: string;
  createdAt: string;
  marker: string;
  /** `Designer:` routing name, "" when unreadable. */
  to: string;
  raisedBy: string;
  why: string;
  questions: string[];
  /**
   * Marker version (#412): 1 legacy, 2 bound to its repository/issue with explicit-resolution
   * semantics. Until the explicit resolve/withdraw commands ship, both resolve by labels here.
   */
  version: 1 | 2;
  /** The needs-human operation id that identifies this question. */
  opId: string;
}

const shorten = (text: string): string =>
  text.length > humanPolicy.maxText ? `${text.slice(0, humanPolicy.maxText - 1)}…` : text;

/** Parse a needs-human record comment; null when it carries no record marker. */
export function parseQuestionRecord(comment: Comment): HumanRecord | null {
  const body = comment.body ?? "";
  const at = body.indexOf(humanPolicy.recordMarker);
  if (at < 0) return null;
  const end = body.indexOf("-->", at);
  const marker = body.slice(at, end < 0 ? undefined : end + 3);
  // The same format `pdb needs-human` writes (workflow/claims.ts), multiline values included.
  const parts = parseQuestionRecordBody(body.slice(0, at));
  const parsed = parseQuestionMarker(body);
  return {
    version: parsed?.version === 2 ? 2 : 1,
    opId: parsed?.opId ?? "",
    url: comment.url,
    createdAt: comment.createdAt ?? "",
    marker,
    to: parts?.designer ?? "",
    raisedBy: parts?.agent ?? "",
    why: parts?.why ?? "",
    questions: parts?.questions ?? [],
  };
}

/** Record counts reported in coverage. `resolved` is filled in by the projection. */
export interface RecordCounts {
  current: number;
  superseded: number;
  resolved: number;
  /** Current records whose resolution cannot be decided (truncated labels). */
  unknown: number;
  untrusted: number;
  unverified: number;
}
/** What the host read from the question records of the open issues. */
export interface HumanEvidence {
  /** Facts for the policy, per issue URL. */
  records: Map<string, QuestionRecordFact[]>;
  /** The newest trusted record per issue URL. */
  current: Map<string, HumanRecord>;
  counts: RecordCounts;
  warnings: string[];
}

/**
 * Read every needs-human record on the open issues of a snapshot. The newest trusted record is
 * current and supersedes older trusted ones; repeats of the same marker are one record. Without a
 * trust decision every record is unverified, so it can only support an inferred item.
 */
export async function readHumanEvidence(
  snapshot: Snapshot,
  trust: TrustDecision | undefined,
  signal?: AbortSignal,
): Promise<HumanEvidence> {
  const evidence: HumanEvidence = {
    records: new Map(),
    current: new Map(),
    counts: { current: 0, superseded: 0, resolved: 0, unknown: 0, untrusted: 0, unverified: 0 },
    warnings: [],
  };
  for (const issue of snapshot.issues) {
    signal?.throwIfAborted();
    if (issue.state !== "OPEN") continue;
    if (issue.comments.pageInfo.hasNextPage)
      evidence.warnings.push(
        `${issue.url}: comment history beyond the first page was not read; a newer question record may be unseen.`,
      );
    const parsed = issue.comments.nodes
      .map((comment) => ({ comment, record: parseQuestionRecord(comment) }))
      .filter((r): r is { comment: Comment; record: HumanRecord } => {
        if (r.record === null) return false;
        const marker = parseQuestionMarker(r.comment.body ?? "");
        // A v2 record copied from another issue never becomes this issue's question (#412).
        if (
          marker?.version === 2 &&
          (marker.repository.toLowerCase() !== snapshot.repository.toLowerCase() ||
            marker.issue !== issue.number)
        ) {
          evidence.warnings.push(
            `${issue.url}: question record ${r.comment.url} is bound to ${marker.repository}#${marker.issue}; ignored.`,
          );
          return false;
        }
        // A malformed marker is missing evidence, never read as a legacy question.
        if (marker?.version === "malformed") {
          evidence.counts.unverified++;
          evidence.warnings.push(
            `${issue.url}: question record ${r.comment.url} has a malformed marker (${marker.why}); ignored.`,
          );
          return false;
        }
        return true;
      });
    if (!parsed.length) continue;
    const facts: QuestionRecordFact[] = [];
    if (!trust) {
      evidence.counts.unverified += parsed.length;
      facts.push({ trust: "unverified", to: parsed.at(-1)!.record.to });
      evidence.warnings.push(
        `${issue.url}: question record authors' permissions were not read; records are unverified.`,
      );
    } else {
      const seen = new Set<string>();
      let current: HumanRecord | null = null;
      // Newest first, the order comments are collected in reverse.
      for (const { comment, record } of [...parsed].reverse()) {
        const authority = await trust(comment as unknown as MarkerComment);
        if (authority.status === "untrusted") {
          evidence.counts.untrusted++;
          continue;
        }
        if (authority.status === "unknown") {
          evidence.counts.unverified++;
          // Unknown authority is missing evidence, not a verdict: the view is incomplete.
          evidence.warnings.push(
            `${issue.url}: authority of the question record ${record.url} could not be verified (${authority.why}).`,
          );
          if (!current) facts.push({ trust: "unverified", to: record.to });
          continue;
        }
        if (seen.has(record.marker)) continue;
        seen.add(record.marker);
        if (current) {
          evidence.counts.superseded++;
          continue;
        }
        current = record;
        facts.push({ trust: "trusted", to: record.to });
      }
      if (current) {
        evidence.current.set(issue.url, current);
        evidence.counts.current++;
      }
    }
    if (facts.length) evidence.records.set(issue.url, facts);
  }
  return evidence;
}

export interface HumanItem {
  id: string;
  kind: string;
  target: string;
  title: string;
  explicit: boolean;
  addressed: boolean;
  routedTo: string[];
  raisedBy: string[];
  requested: string[];
  reason: string;
  blocks: { subjects: string[]; unknown: string[] };
  source: string;
  ruleIds: string[];
  why: string;
  nextCommand: string;
  warnings: string[];
}
export interface HumanBriefing {
  schemaVersion: 1;
  human: string | null;
  routing: "named" | "unrouted";
  total: number;
  omitted: number;
  items: HumanItem[];
  notices: string[];
  coverage: {
    complete: boolean;
    warnings: string[];
    records: RecordCounts;
    excluded: string[];
  };
}

const isPr = (s: Issue | PullRequest): s is PullRequest => "headRefOid" in s;

function blocksOf(subject: Issue | PullRequest): HumanItem["blocks"] {
  if (isPr(subject)) {
    const refs = subject.closingIssuesReferences;
    const extra = refs.nodes.length - humanPolicy.maxBlocks;
    return {
      subjects: refs.nodes.map((r) => r.url).slice(0, humanPolicy.maxBlocks),
      unknown: [
        ...(refs.pageInfo.hasNextPage ? ["closing issue references truncated"] : []),
        // Display trimming, not missing evidence: the "omitted" suffix keeps it out of coverage.
        ...(extra > 0 ? [`${extra} more closed issue(s) omitted`] : []),
      ],
    };
  }
  const open = (subject.blocking?.nodes ?? []).filter((n) => n.state === "OPEN");
  const unknown = [
    ...(!subject.blocking || subject.blocking.pageInfo.hasNextPage
      ? ["direct dependents not fully collected"]
      : []),
    ...(open.length > humanPolicy.maxBlocks - 1
      ? [`${open.length - (humanPolicy.maxBlocks - 1)} more dependent(s) omitted`]
      : []),
  ];
  return {
    subjects: [subject.url, ...open.slice(0, humanPolicy.maxBlocks - 1).map((n) => n.url)],
    unknown,
  };
}

function requestedFor(kind: string, subject: Issue | PullRequest, human: string | null): string[] {
  if (kind === "addressed-response")
    return [
      `A response to the attention:${human ?? "NAME"} request on this ${isPr(subject) ? "pull request" : "ticket"}.`,
    ];
  if (kind === "decide") return ["A decision or answer to the question labelled on the ticket."];
  if (kind === "sign-off" && isPr(subject))
    return [`Merge sign-off for head ${subject.headRefOid.slice(0, 12)}.`];
  return [];
}

/**
 * Project the human role's policy decisions (already in policy order) into items. A subject
 * appears once, at its first decision's position, keeping every matched rule.
 */
export function humanBriefing(
  snapshot: Snapshot,
  decisions: readonly DatalogAction[],
  evidence: HumanEvidence,
  options: { human: string | null; limit: number; complete: boolean; warnings: string[] },
): HumanBriefing {
  const subjects = new Map<string, Issue | PullRequest>(
    [...snapshot.issues, ...snapshot.pullRequests].map((s) => [s.url, s]),
  );
  const groups = new Map<string, DatalogAction[]>();
  for (const decision of decisions)
    groups.set(decision.target, [...(groups.get(decision.target) ?? []), decision]);
  const items: HumanItem[] = [];
  /** Per-item missing evidence that must also reach coverage. */
  const evidenceGaps: string[] = [];
  for (const [target, matched] of groups) {
    const subject = subjects.get(target);
    if (!subject) continue;
    const codes = matched.flatMap((d) => d.reasonCodes);
    const kinds = [...new Set(matched.map((d) => d.kind as string))];
    const record = kinds.includes("answer-questions") ? evidence.current.get(target) : undefined;
    const warnings: string[] = [];
    const questions = record?.questions ?? [];
    if (questions.length > humanPolicy.maxQuestions)
      warnings.push(
        `${questions.length - humanPolicy.maxQuestions} more question(s) on the record`,
      );
    if (record && !questions.length)
      evidenceGaps.push(`${target}: the record's questions could not be read.`);
    const requested = [
      ...questions.slice(0, humanPolicy.maxQuestions).map(shorten),
      ...kinds.flatMap((kind) => requestedFor(kind, subject, options.human)),
    ];
    const blocks = blocksOf(subject);
    // Truncated dependent or closing evidence is missing evidence; display bounding is not.
    for (const gap of blocks.unknown.filter((u) => !u.endsWith("omitted")))
      evidenceGaps.push(`${target}: ${gap}; what it blocks is a lower bound.`);
    warnings.push(
      ...evidenceGaps
        .filter((w) => w.startsWith(`${target}:`))
        .map((w) => w.slice(target.length + 2)),
      ...options.warnings
        .filter((w) => w.startsWith(`${target}:`))
        .map((w) => w.slice(target.length + 2)),
    );
    items.push({
      id: `${snapshot.repository} ${target} ${matched[0].kind}`,
      kind: matched[0].kind,
      target,
      title: subject.title,
      explicit: codes.some((c) => (humanPolicy.explicitCodes as readonly string[]).includes(c)),
      addressed: codes.includes(humanPolicy.addressedCode),
      routedTo: [
        ...new Set([
          ...(record?.to ? [record.to] : []),
          ...(kinds.includes("addressed-response") && options.human ? [options.human] : []),
        ]),
      ],
      raisedBy: record?.raisedBy ? [record.raisedBy] : [],
      requested,
      reason: shorten(record?.why || matched[0].why.text),
      blocks,
      source: record?.url ?? target,
      ruleIds: [...new Set(matched.flatMap((d) => d.ruleIds))],
      why: matched[0].why.text,
      nextCommand: isPr(subject)
        ? `pdb pr ${subject.number} --repo ${snapshot.repository}`
        : `pdb --repo ${snapshot.repository} --issue ${subject.number}`,
      warnings,
    });
  }
  // A current trusted record on a ticket the policy did not ask about is resolved (labels removed).
  const asked = new Set(items.filter((i) => i.source !== i.target).map((i) => i.target));
  // Absence of the labels means resolved only when the label evidence is complete; otherwise the
  // record's state is unknown and reported in coverage.
  const unasked = [...evidence.current.keys()].filter((url) => !asked.has(url));
  const labelsComplete = (url: string) =>
    snapshot.issues.find((i) => i.url === url)?.labels.pageInfo.hasNextPage === false;
  const resolved = unasked.filter(labelsComplete).length;
  const unknownState = unasked.filter((url) => !labelsComplete(url));
  for (const url of unknownState)
    evidenceGaps.push(
      `${url}: labels truncated; whether its question record is resolved is unknown.`,
    );
  const records = {
    ...evidence.counts,
    current: evidence.counts.current - resolved - unknownState.length,
    resolved,
    unknown: unknownState.length,
  };
  const warnings = [...options.warnings, ...evidenceGaps];
  const limit = Math.max(0, options.limit);
  return {
    schemaVersion: 1,
    human: options.human,
    routing: options.human ? "named" : "unrouted",
    total: items.length,
    omitted: Math.max(0, items.length - limit),
    items: items.slice(0, limit),
    notices: options.human
      ? []
      : [
          "No human named: nothing is marked as addressed to you. Name the human with --agent NAME (MCP and API: agent), the name used in attention:NAME and needs-human routing.",
        ],
    coverage: {
      complete: options.complete && !warnings.length,
      warnings,
      records,
      excluded: [...humanPolicy.excluded],
    },
  };
}

/** Compact text rendering of a human briefing within `maxChars`. */
export function humanText(
  report: {
    repository: string;
    freshness: { fetchedAt: string; offline?: boolean; source?: string; ageSeconds?: number };
  },
  human: HumanBriefing,
  maxChars: number,
): string {
  const f = report.freshness;
  // #371: say where the facts came from; a quota fallback is STALE, never presented as live.
  const source = f.offline
    ? `; ${cacheWord(f)}${f.ageSeconds === undefined ? "" : ` (${f.ageSeconds}s old)`}, live verification unavailable${f.source === "stale" ? "; refresh before acting" : ""}`
    : "";
  const lines = [
    `HUMAN BRIEFING ${report.repository} for ${human.human ?? "(no human named)"} — fetched ${f.fetchedAt}${source}`,
    "What input of yours is blocking progress? Read-only: no claims, answers or sign-offs are made here.",
    ...human.notices,
  ];
  if (!human.coverage.complete)
    lines.push(
      `INCOMPLETE evidence: ${human.coverage.warnings.length} warning(s); missing evidence is not "nothing needed". Use --json for all warnings.`,
      ...human.coverage.warnings.slice(0, 3).map((w) => `  - ${w}`),
    );
  if (!human.total)
    lines.push(
      human.coverage.complete
        ? "No human input is waiting."
        : "No human input found in the evidence read; coverage is incomplete.",
    );
  human.items.forEach((item, i) => {
    lines.push(
      `${i + 1}. [${item.explicit ? (item.addressed ? "explicit, to you" : "explicit") : "inferred"}] ${item.kind} ${item.target} — ${item.title}`,
      `   Why: ${item.reason}`,
      ...item.requested.map((r) => `   Requested: ${r}`),
      `   Blocks: ${item.blocks.subjects.join(", ") || "nothing known"}${item.blocks.unknown.length ? ` (${item.blocks.unknown.join("; ")})` : ""}`,
      `   Source: ${item.source}`,
      ...item.warnings.map((w) => `   Warning: ${w}`),
    );
  });
  if (human.omitted) lines.push(`${human.omitted} more item(s) omitted; raise --limit.`);
  lines.push(`Excluded: ${human.coverage.excluded.join("; ")}.`);
  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) {
      text += "… output truncated; use --json.\n";
      break;
    }
    text += `${line}\n`;
  }
  return text;
}
