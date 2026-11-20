/**
 * Refinement facts for the briefing (#1098, doc/design/estimation-refinement-loop.md): folds the
 * refinement records already in the collected snapshot, with the shared refinement fold and the
 * #212 trust rule, so the native designer actions (D-REFINE, D-REFINE-RESOLVE, D-REFINE-EMPTY,
 * D-REFINE-INCOMPLETE) and pickup denials see the same facts as `pdb refine`. Only facts: the
 * native policy decides priority, ordering and denial.
 *
 * An issue is read when it carries the refinement index label or a refinement record. A truncated
 * comment history or unread labels make its facts incomplete (`refinement-complete false`), never
 * "no refinement".
 */
import type { Snapshot } from "../github/types.js";
import { parseLabelProvenance } from "../estimation/estimate.js";
import type { Comment } from "./claims.js";
import type { TrustDecision } from "./delivery.js";
import {
  foldRefinementTrusted,
  parseRefinementComment,
  refinementFacts,
  refinementLabel,
  type RefinementFacts,
} from "./refinement.js";

export async function readSnapshotRefinements(
  snapshot: Snapshot,
  trust: TrustDecision,
  signal?: AbortSignal,
): Promise<Map<string, RefinementFacts>> {
  const out = new Map<string, RefinementFacts>();
  for (const issue of snapshot.issues) {
    signal?.throwIfAborted();
    if (issue.state !== "OPEN") continue;
    const comments = issue.comments.nodes as unknown as Comment[];
    const labelsComplete = !issue.labels.pageInfo.hasNextPage;
    // A label seen on a partial page is still present; only its absence is unknown then.
    const seen = issue.labels.nodes.some((l) => l.name === refinementLabel);
    const labelPresent = seen ? true : labelsComplete ? false : null;
    const hasRecord = comments.some((c) => parseRefinementComment(c.body ?? "").kind !== "none");
    if (labelPresent === false && !hasRecord) continue;
    if (labelPresent === null && !hasRecord) continue;
    const fold = await foldRefinementTrusted(snapshot.repository, issue.number, comments, trust);
    // A trusted complexity estimate newer than a resolve returns the item from re-estimation.
    const estimates: string[] = [];
    for (const c of comments)
      if (parseLabelProvenance(c.body ?? "") && c.createdAt) {
        const authority = await trust(c);
        if (authority.status === "trusted") estimates.push(c.createdAt);
      }
    out.set(
      issue.url,
      refinementFacts(fold, {
        historyComplete: !issue.comments.pageInfo.hasNextPage,
        labelPresent,
        estimates,
      }),
    );
  }
  return out;
}
