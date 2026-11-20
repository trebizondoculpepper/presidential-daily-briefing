/**
 * Delivery responsibility facts for next-action ranking (#182, consuming #190's records).
 * Contract: doc/design/delivery-lifecycle.md ("#182 ranking", rule L1/L2 over `responsible`).
 *
 * Reads only the comments already in the collected snapshot: no request is added beyond the
 * injected #212 trust decision for authors of recognised delivery records. A fold that is unknown
 * (truncated history, unverified, malformed, unsupported or unordered records) contributes no
 * responsibility and is reported, so unknown evidence is never read as "nobody is responsible".
 */
import type { Snapshot } from "../github/types.js";
import type { ReleaseDirectionFact } from "../rules/datalog/adapter.js";
import {
  parseDeliveryComment,
  readDeliveryFold,
  type DeliveryComment,
  type TrustDecision,
} from "./delivery.js";

export interface ResponsibilityFacts {
  /**
   * Deliverable (pull request) URL to every trusted responsible agent. Responsibility is
   * (agent, issue, deliverable): one PR can be required by several issues with different agents.
   */
  responsible: Map<string, string[]>;
  /** Issue URLs whose delivery records exist but could not be folded, with the reasons. */
  unknown: { issue: string; because: string[] }[];
  /**
   * Issue URL to the trusted, applied human-directed releases (#1019 `unassign` records): the
   * released agent and the open member PRs now owned by nobody, which an eligible agent may adopt
   * (#1018 D-ADOPT). Only known folds contribute; an issue absent here had no applied release.
   */
  releaseDirections: Map<string, ReleaseDirectionFact[]>;
}

const pullUrl = (repository: string, number: number): string =>
  `https://github.com/${repository}/pull/${number}`;

/** Folds the delivery records on each snapshot issue that carries any. */
export async function readSnapshotResponsibility(
  snapshot: Snapshot,
  trust: TrustDecision | undefined,
  signal?: AbortSignal,
): Promise<ResponsibilityFacts> {
  const facts: ResponsibilityFacts = {
    responsible: new Map(),
    unknown: [],
    releaseDirections: new Map(),
  };
  const openPrs = new Set(
    snapshot.pullRequests.filter((p) => p.state === "OPEN").map((p) => p.url.toLowerCase()),
  );
  // Records name a repository as written; match it to the collected URL case-insensitively.
  const collected = new Map(snapshot.pullRequests.map((p) => [p.url.toLowerCase(), p.url]));
  for (const issue of snapshot.issues) {
    signal?.throwIfAborted();
    const comments = issue.comments.nodes;
    if (!comments.some((c) => parseDeliveryComment(c.body).kind !== "none")) continue;
    if (!trust) {
      facts.unknown.push({
        issue: issue.url,
        because: ["delivery record authors' permissions were not read"],
      });
      continue;
    }
    const { records, fold } = await readDeliveryFold(
      comments as DeliveryComment[],
      !issue.comments.pageInfo.hasNextPage,
      { repository: snapshot.repository, issue: issue.number },
      trust,
    );
    if (fold.recordsUnknown) {
      facts.unknown.push({ issue: issue.url, because: fold.unknownBecause });
      continue;
    }
    for (const member of fold.members)
      if (member.deliverable.kind === "pr" && member.responsible) {
        const url = pullUrl(member.deliverable.repository, member.deliverable.number);
        const key = collected.get(url.toLowerCase()) ?? url;
        const agents = facts.responsible.get(key) ?? [];
        if (!agents.includes(member.responsible)) agents.push(member.responsible);
        facts.responsible.set(key, agents);
      }
    // #1019: each applied release names its agent; preserved PRs are open, unowned members.
    const preserved = fold.members
      .filter((m) => m.deliverable.kind === "pr" && m.responsible === null)
      .map((m) => {
        const d = m.deliverable as { repository: string; number: number };
        const url = pullUrl(d.repository, d.number);
        return collected.get(url.toLowerCase()) ?? url;
      })
      .filter((url) => openPrs.has(url.toLowerCase()));
    const directions: ReleaseDirectionFact[] = [];
    // Released work is adoptable only when nobody still owns the ticket or any member: a release
    // of one agent never implies a global release (#1149 review).
    const stillOwned =
      fold.ticketResponsible !== null || fold.members.some((m) => m.responsible !== null);
    for (const applied of stillOwned ? [] : fold.applied) {
      if (applied.op !== "unassign") continue;
      const rec = records.find(
        (r) => r.status === "trusted" && String(r.comment.databaseId) === applied.comment,
      );
      const from = rec?.status === "trusted" ? rec.record.from : undefined;
      if (from && !directions.some((d) => d.from === from))
        directions.push({ trust: "trusted", from, preservedPrs: preserved });
    }
    if (directions.length) facts.releaseDirections.set(issue.url, directions);
  }
  // A preserved PR that also closes an issue whose delivery history is unknown may be owned
  // there: unread ownership is never offered for adoption (#1149 review).
  const unknownIssues = new Set(facts.unknown.map((u) => u.issue.toLowerCase()));
  const unread = new Set(
    snapshot.pullRequests
      .filter((p) =>
        p.closingIssuesReferences.nodes.some((i) => unknownIssues.has(i.url.toLowerCase())),
      )
      .map((p) => p.url.toLowerCase()),
  );
  for (const [issueUrl, directions] of facts.releaseDirections) {
    const kept = directions
      .map((d) => ({
        ...d,
        preservedPrs: d.preservedPrs.filter((u) => !unread.has(u.toLowerCase())),
      }))
      .filter((d) => d.preservedPrs.length > 0);
    if (kept.length) facts.releaseDirections.set(issueUrl, kept);
    else facts.releaseDirections.delete(issueUrl);
  }
  return facts;
}
