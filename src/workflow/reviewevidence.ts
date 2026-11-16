/** Attributable review evidence shared by prstatus and both briefing engines (#182). */
import { selected } from "../github/github.js";
import type { PullRequest } from "../github/types.js";

/** Codex's machine-readable review state, embedded in its summary comment. */
export type CodexReviewState = {
  status?: string;
  commit_sha?: string;
  has_unresolved_findings?: boolean;
};
export type CodexMarker = { code_review?: CodexReviewState };

/** Codex's standalone review-receipt comment (`<!-- codex-review-receipt:v1 -->`, #647). */
export type CodexReceipt = {
  commitSha: string | null;
  clean: boolean;
};

/** Codex's machine-readable review state embedded in a comment body, if any. */
export function codexMarker(body: string | null | undefined): CodexMarker | null {
  const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(body ?? "");
  try {
    const parsed: unknown = m ? JSON.parse(m[1]) : null;
    return selected<CodexMarker>(parsed);
  } catch {
    return null;
  }
}

/**
 * Conservative parser for Codex's standalone review-receipt comment (#647).
 * Recognizes only the `codex-review-receipt:v1` marker, an explicit 7-40 hex `Reviewed commit`,
 * and the exact clean phrase; ambiguous prose remains `clean: false`.
 */
export function codexReviewReceipt(body: string | null | undefined): CodexReceipt | null {
  const text = body ?? "";
  if (!/<!--\s*codex-review-receipt:v1\s*-->/.test(text)) return null;
  const commitMatch = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i.exec(text);
  const commitSha = commitMatch ? commitMatch[1].toLowerCase() : null;
  const clean = Boolean(commitSha && /Codex Review: Didn't find any major issues\b/.test(text));
  return { commitSha, clean };
}

/** Match a full 40-char head SHA against a full SHA or a 7-40 char receipt commit prefix. */
export function codexCommitMatches(head: string, sha: string | null | undefined): boolean {
  if (!sha) return false;
  if (sha === head) return true;
  return (
    /^[0-9a-f]{7,39}$/i.test(sha) &&
    /^[0-9a-f]{40}$/i.test(head) &&
    head.toLowerCase().startsWith(sha.toLowerCase())
  );
}

/** The account whose Codex review-state marker is attributable review evidence (#182). */
export const codexReviewer = "chatgpt-codex-connector";
/**
 * Attributable review evidence bound to the current head (#182 S9 acceptance): an APPROVED
 * review whose commit is the head, or a completed Codex review-state marker or clean review
 * receipt (#647) posted by the Codex account for the head with findings explicitly false.
 * Missing, pending, stale or unattributed evidence is not acceptance, and a Codex receipt
 * reporting findings on the head vetoes it.
 */
export function headReviewed(pr: PullRequest): boolean {
  return headAccepted(
    pr.headRefOid,
    (pr.reviews?.nodes ?? []).map((r) => ({ state: r.state, commit: r.commit?.oid ?? null })),
    (pr.comments?.nodes ?? []).map((c) => ({
      by: c.author?.login ?? "",
      state: codexMarker(c.body)?.code_review,
    })),
    (pr.comments?.nodes ?? []).map((c) => ({
      by: c.author?.login ?? "",
      receipt: codexReviewReceipt(c.body),
    })),
  );
}

/**
 * The same acceptance rule over plain review facts, so reports that do not hold a snapshot PR
 * (`pr N`'s status report) apply it identically rather than re-deriving it (#192).
 */
export function headAccepted(
  head: string,
  reviews: { state: string; commit: string | null }[],
  codexStates: { by: string; state: CodexReviewState | undefined }[],
  codexReceipts: { by: string; receipt: CodexReceipt | null }[] = [],
): boolean {
  const codex = codexStates
    .filter((c) => c.by.replace(/\[bot\]$/, "") === codexReviewer)
    .map((c) => c.state);
  // As in prstatus.ts: Codex findings on the current head block, whatever else approves it.
  if (codex.some((s) => s?.commit_sha === head && s.has_unresolved_findings === true)) return false;
  return (
    reviews.some((r) => r.state === "APPROVED" && r.commit === head) ||
    codex.some(
      (s) =>
        s?.commit_sha === head && s.status === "completed" && s.has_unresolved_findings === false,
    ) ||
    codexReceipts.some(
      (c) =>
        c.by.replace(/\[bot\]$/, "") === codexReviewer &&
        c.receipt?.clean === true &&
        codexCommitMatches(head, c.receipt.commitSha),
    )
  );
}

/** A Codex receipt by the Codex account on the current head reports unresolved findings. */
export function headCodexFindings(
  head: string,
  codexStates: { by: string; state: CodexReviewState | undefined }[],
): boolean {
  return codexStates.some(
    (c) =>
      c.by.replace(/\[bot\]$/, "") === codexReviewer &&
      c.state?.commit_sha === head &&
      c.state.has_unresolved_findings === true,
  );
}
