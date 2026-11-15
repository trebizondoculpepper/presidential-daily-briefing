/**
 * Shared retained-claim facts for ranking and projections (#413,
 * doc/design/blocked-retained-claims.md "Ranking and visibility"). The rules decide; this only
 * collects:
 *
 * - the viewer's open implementation claims in this repository (open issues carrying their
 *   `agent:` label, oldest first) and whether that inventory is complete. Submitted PR
 *   responsibility is not a claim. Read from the snapshot, so it works offline.
 * - each claim's activity (active / waiting / resume-required / unknown), read live with the very
 *   reader the claim guard uses (workflow/retained.ts), so ranking and enforcement cannot
 *   disagree. Without live boundaries no activity is read: the ordinary continuation applies.
 */
import type { Snapshot } from "../github/types.js";
import type { PermissionLookup } from "../github/github.js";
import { claimPolicy, type GraphQuery } from "./claims.js";
import { describeBlocker, readRetained, type RetainedRead } from "./retained.js";

export type ClaimActivityState = "active" | "waiting" | "resume-required" | "unknown" | "not-owned";
export interface ClaimActivityFact {
  state: ClaimActivityState;
  /** What a wait awaits (and why), what cleared, or why the activity is unknown. */
  reason: string;
  number: number;
}
export interface RetainedFacts {
  ownedClaims: { urls: string[]; complete: boolean };
  /** Per claim URL; absent when activity was not read (offline or no viewer). */
  claimActivity?: Map<string, ClaimActivityFact>;
}

const maxReason = 240;
const short = (text: string) =>
  text.length > maxReason ? `${text.slice(0, maxReason - 1)}…` : text;

/** The viewer's open claims in the snapshot, oldest first, and whether the inventory is whole. */
export function ownedClaims(snapshot: Snapshot, agent: string): RetainedFacts["ownedClaims"] {
  const label = claimPolicy.owner(agent);
  const open = snapshot.issues.filter((i) => i.state === "OPEN");
  // Unparked claims first, then oldest: the first one carries the owned-work review row.
  const parked = (i: (typeof open)[number]) =>
    i.labels.nodes.some((l) => l.name === "status:parked") ? 1 : 0;
  const mine = open
    .filter((i) => i.labels.nodes.some((l) => l.name === label))
    .sort(
      (a, b) =>
        parked(a) - parked(b) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.number - b.number,
    );
  // Whole only when every open issue was seen with complete labels: a cut-short label page could
  // hide this agent's claim label, and a routine shortlist read (#368) may have capped discovery
  // or withdrawn issues it could not hydrate, whose claims this snapshot then does not hold.
  const present = new Set(snapshot.issues.map((i) => i.url));
  const shortlist = snapshot.shortlist;
  const inventoryWhole =
    !shortlist ||
    (shortlist.discovered.complete &&
      shortlist.notHydrated.every((n) => n.kind !== "issue" || present.has(n.url)));
  return {
    urls: mine.map((i) => i.url),
    complete: inventoryWhole && open.every((i) => !i.labels.pageInfo.hasNextPage),
  };
}

/** One claim's activity, as the ranking facts state it. */
export function activityFact(number: number, read: RetainedRead): ClaimActivityFact {
  const a = read.activity;
  switch (a.state) {
    case "active":
      return { state: "active", reason: "", number };
    case "waiting":
      return {
        state: "waiting",
        reason: short(`${describeBlocker(a.blocker)} (${a.reason})`),
        number,
      };
    case "resume-required":
      return { state: "resume-required", reason: short(a.cleared), number };
    case "unknown":
      return { state: "unknown", reason: short(a.why.join("; ")), number };
    case "not-owned":
      // Released, transferred or closed since the snapshot: stated, so both engines stop
      // treating the stale label as an active claim (and readRetainedFacts drops it from the
      // inventory).
      return { state: "not-owned", reason: short(a.why), number };
  }
}

/** Collect the retained-claim facts for `agent`. Live activity needs both boundaries. */
export async function readRetainedFacts(
  snapshot: Snapshot,
  agent: string | undefined,
  live?: { query: GraphQuery; permission: PermissionLookup },
  read: typeof readRetained = readRetained,
): Promise<RetainedFacts | undefined> {
  if (!agent) return undefined;
  const owned = ownedClaims(snapshot, agent);
  if (!live) return { ownedClaims: owned };
  const claimActivity = new Map<string, ClaimActivityFact>();
  for (const url of owned.urls) {
    const number = Number(url.slice(url.lastIndexOf("/") + 1));
    try {
      const fact = activityFact(
        number,
        await read(snapshot.repository, number, agent, live.query, live.permission),
      );
      claimActivity.set(url, fact);
    } catch (error) {
      // A failed read is unknown, never waiting and never silently active.
      claimActivity.set(url, {
        state: "unknown",
        reason: short(`its activity could not be read (${(error as Error).message})`),
        number,
      });
    }
  }
  // A claim observed released is no longer in the inventory the review counts.
  const urls = owned.urls.filter((u) => claimActivity.get(u)?.state !== "not-owned");
  return { ownedClaims: { ...owned, urls }, claimActivity };
}
