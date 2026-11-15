/**
 * Completeness of one pull request's review and merge evidence (#497), shared by every read
 * surface so the TypeScript and Datalog engines agree on unknown versus proven acceptance.
 */
import type { PullRequest } from "./types.js";

type Connection = {
  pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean } | null;
} | null;

/** A connection that was not requested, or has another page in either direction, is partial. */
const partial = (c: Connection | undefined): boolean =>
  !c || !c.pageInfo || !!c.pageInfo.hasNextPage || !!c.pageInfo.hasPreviousPage;

/**
 * The PR evidence sources not fully read: comments (Codex receipts), reviews, review threads
 * and head check contexts. A clean receipt or approval on a visible page proves nothing about an
 * unseen page, so any gap keeps acceptance unknown. Matching warnings use `${url}:` so /pull/1
 * never matches /pull/12 (#448). A head with no check rollup is left to the verify rule.
 */
export function prEvidenceGaps(pr: PullRequest, warnings: readonly string[]): string[] {
  const gaps: string[] = [];
  if (warnings.some((w) => w.startsWith(`${pr.url}:`))) gaps.push("warnings");
  const sources: [string, Connection | undefined][] = [
    ["comments", pr.comments],
    ["reviews", pr.reviews],
    ["review threads", pr.reviewThreads],
  ];
  for (const [label, connection] of sources) if (partial(connection)) gaps.push(label);
  // Commits not requested: check evidence unread. A null rollup is a head with no checks.
  const rollup = pr.commits?.nodes ? pr.commits.nodes[0]?.commit.statusCheckRollup : undefined;
  if (rollup === undefined ? !pr.commits?.nodes : rollup && partial(rollup.contexts))
    gaps.push("head checks");
  return gaps;
}
