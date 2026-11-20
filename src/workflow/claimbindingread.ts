/**
 * Live read of the employing human bound to one agent's current claim (#690). The binding itself
 * and its trust rules live in `claimbinding.ts`; this module supplies the live evidence: the claim
 * start (when the agent's label was last added) and the comments since then, read with the same
 * bounded helpers `pdb claim` uses, and the #212 authority check.
 */
import type { PermissionLookup } from "../github/github.js";
import { readClaimBinding, type ClaimBinding } from "./claimbinding.js";
import {
  claimMarkerFor,
  claimPolicy,
  claimStart,
  commentAuthority,
  commentHistory,
  reaches,
  readTicket,
  type GraphQuery,
} from "./claims.js";

export async function readLiveClaimBinding(
  repository: string,
  number: number,
  agent: string,
  live: { query: GraphQuery; permission: PermissionLookup },
): Promise<ClaimBinding> {
  try {
    const { item } = await readTicket(repository, number, agent, live.query);
    if (!item || item.__typename !== "Issue")
      return { state: "unknown", reason: "no-claim-comment", why: `#${number} is not an issue.` };
    const start = await claimStart(repository, number, claimPolicy.owner(agent), item, live.query);
    if (!start.since)
      return {
        state: "unknown",
        reason: "incomplete",
        why: start.complete
          ? `No agent:${agent} label event was found, so the claim start is unknown.`
          : "The claim start could not be established from the bounded label history.",
      };
    const history = await commentHistory(
      repository,
      number,
      item,
      reaches(start.since),
      live.query,
    );
    const claim = /github-triage:claim:([0-9a-f]{16})/.exec(
      claimMarkerFor(repository, number, agent),
    )![1]!;
    return await readClaimBinding(
      history.comments,
      { repository, issue: number, agent, claim, since: start.since, complete: history.complete },
      (c) => commentAuthority(c, live.permission),
    );
  } catch (error) {
    return {
      state: "unknown",
      reason: "incomplete",
      why: `The claim could not be read (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
}
