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
  /**
   * PR URLs whose ownership may be recorded on an issue that could not be folded (they close it,
   * or a parsable record there names them). Unknown, never unowned, for native admission.
   */
  unknownPrs: string[];
  /** Issue URL to its trusted ticket-responsible agent, for native admission only. */
  ticketOwners: Map<string, string>;
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
    unknownPrs: [],
    ticketOwners: new Map(),
  };
  const openPrs = new Set(
    snapshot.pullRequests.filter((p) => p.state === "OPEN").map((p) => p.url.toLowerCase()),
  );
  // Records name a repository as written; match it to the collected URL case-insensitively.
  const collected = new Map(snapshot.pullRequests.map((p) => [p.url.toLowerCase(), p.url]));
  /** Issues whose ownership may be unread, for the PRs that close them (#1149 review). */
  const unreadIssues = new Set<string>();
  /** PR members named by records on unfoldable issues, excluding ignored and foreign ones. */
  const unreadMembers = new Set<string>();
  const memberUrls = (body: string): string[] => {
    const parsed = parseDeliveryComment(body);
    if (parsed.kind !== "record") return [];
    return parsed.record.deliverables.flatMap((d) => {
      if (d.kind !== "pr") return [];
      const url = pullUrl(d.repository, d.number);
      return [collected.get(url.toLowerCase()) ?? url];
    });
  };
  for (const issue of snapshot.issues) {
    signal?.throwIfAborted();
    const comments = issue.comments.nodes;
    if (!comments.some((c) => parseDeliveryComment(c.body).kind !== "none")) {
      // A truncated history may hold an unread record even when none was collected.
      if (issue.comments.pageInfo.hasNextPage) unreadIssues.add(issue.url.toLowerCase());
      continue;
    }
    if (!trust) {
      // Authority unread: every recognised record's members are unknown, never unowned.
      unreadIssues.add(issue.url.toLowerCase());
      for (const c of comments) for (const u of memberUrls(c.body)) unreadMembers.add(u);
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
      unreadIssues.add(issue.url.toLowerCase());
      // Records the contract excludes (no authority, or bound to another ticket) name nothing.
      for (const r of records)
        if (r.status !== "ignored" && r.status !== "foreign")
          for (const u of memberUrls(r.comment.body)) unreadMembers.add(u);
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
    // The ticket's own owner is a fact for the native rules (#1149 review): an issue still held
    // by another agent is not `released-unowned`, so the policy, not this reader, withholds it.
    if (fold.ticketResponsible) facts.ticketOwners.set(issue.url, fold.ticketResponsible);
    for (const applied of fold.applied) {
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
  // A PR whose ownership may be recorded on an issue we could not fully read is unknown, never
  // unowned (#1149 review): it closes such an issue, or an admissible record there names it.
  // The native rules decide with that fact.
  const unknownPrs = new Set<string>(unreadMembers);
  // Issues outside the collected inventory (closed ones, for instance) were never read, and
  // closing an issue does not clear its responsibility records (#1149 review): unknown too.
  const inventory = new Set(snapshot.issues.map((i) => i.url.toLowerCase()));
  for (const p of snapshot.pullRequests)
    if (
      p.closingIssuesReferences.nodes.some(
        (i) => unreadIssues.has(i.url.toLowerCase()) || !inventory.has(i.url.toLowerCase()),
      )
    )
      unknownPrs.add(p.url);
  facts.unknownPrs = [...unknownPrs];
  return facts;
}
