/**
 * Transport-neutral reads for `team`, `who N` and `pr N` (doc/design/serve.md "Research
 * summary", #373). The CLI and `pdb serve` call these directly; neither runs the other or parses
 * terminal text, so both emit the same versioned JSON for the same facts.
 */
import type { Query, Rest } from "../github/github.js";
import type { Snapshot } from "../github/types.js";
import { diagnoseDelivery } from "./deliverydoctor.js";
import type { TrustDecision } from "./delivery.js";
import {
  deliveryFields,
  deliveryLines,
  deliveryRead,
  omissionLines,
  prDelivery,
  prDeliveryLines,
  readIssuesDelivery,
  reportFollowUpFacts,
  teamResponsibilities,
  teamResponsibilityLines,
  withDeliveryCompleteness,
} from "./deliveryread.js";
import { prStatusText, pullRequestStatus } from "./prstatus.js";
import { pullRequestReviewHistory, reviewHistoryText } from "./reviewhistory.js";
import { teamText, teamView } from "./team.js";
import { ticketOwnership, ticketOwnershipText } from "./who.js";

/** Live delivery boundaries; empty (offline, or not injected) means delivery is not evaluated. */
export interface DeliveryBoundaries {
  trust?: TrustDecision;
  live?: { query: Query; rest: Rest };
  signal?: AbortSignal;
}

/** One read: the versioned report, its text rendering, and whether its evidence is complete. */
export interface ServiceRead<T> {
  report: T;
  text: string;
  complete: boolean;
}

/** Appends lines to a text report that ends with a newline (unchanged when there are none). */
export const appendLines = (text: string, lines: string[]): string =>
  lines.length ? `${text.replace(/\n$/, "")}\n${lines.join("\n")}\n` : text;

/** `team`: each agent's claims, PRs, activity and delivery responsibilities. */
export async function readTeam(
  snapshot: Snapshot,
  options: { staleHours: number; now: Date; offline: boolean },
  boundaries: DeliveryBoundaries,
) {
  const view = teamView(snapshot, options);
  // #192: responsibilities per agent (S18 inventory), including agents with no claim.
  const read = deliveryRead(snapshot, await diagnoseDelivery(snapshot, boundaries));
  const report = withDeliveryCompleteness(
    read.tickets.length || !read.complete
      ? { ...view, agents: teamResponsibilities(view.agents, read), delivery: read }
      : view,
    read,
  );
  const text = appendLines(teamText(view), [
    ...(read.tickets.length ? teamResponsibilityLines(report.agents, read, options.now) : []),
    ...omissionLines(read),
  ]);
  return { report, text, complete: report.completeness.complete };
}

/** `who N`: who is working on one ticket, with delivery and responsibility. */
export async function readWho(
  snapshot: Snapshot,
  number: number,
  options: { staleHours: number; now: Date; offline: boolean },
  boundaries: DeliveryBoundaries,
) {
  const ownership = ticketOwnership(snapshot, number, options);
  // #192: delivery, responsibility and closure from the shared fold and evaluator.
  // Only the requested issue is evaluated, so the evaluation cap can never skip it.
  const scoped = { ...snapshot, issues: snapshot.issues.filter((i) => i.number === number) };
  const read = deliveryRead(scoped, await diagnoseDelivery(scoped, boundaries));
  const view = read.tickets.find((t) => t.number === number) ?? null;
  const issue = scoped.issues[0];
  const report = withDeliveryCompleteness(
    issue ? { ...ownership, ...deliveryFields(issue, view) } : ownership,
    read,
  );
  const text = appendLines(ticketOwnershipText(ownership), [
    ...deliveryLines(view),
    ...omissionLines(read),
  ]);
  return { report, text, complete: report.completeness.complete };
}

/** `pr N --history`: review rounds, findings and recurring files. */
export async function readReviewHistory(
  repository: string,
  number: number,
  query: Query,
  now?: () => Date,
) {
  const report = await pullRequestReviewHistory(repository, number, query, now);
  return { report, text: reviewHistoryText(report), complete: report.completeness.complete };
}

/** `pr N`: every blocker of one pull request, with delivery of the issues it closes. */
export async function readPullRequest(
  repository: string,
  number: number,
  query: Query,
  boundaries: DeliveryBoundaries,
  now?: () => Date,
) {
  const status = await pullRequestStatus(repository, number, query, now);
  // Keep each linked issue's repository: a PR may close an issue elsewhere.
  const linked = status.linkedIssues.map((i) => {
    const m = i.url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+/);
    return { number: i.number, repository: m ? m[1] : "(unknown repository)" };
  });
  const local = linked.filter((i) => i.repository.toLowerCase() === repository.toLowerCase());
  const foreign = linked.filter((i) => i.repository.toLowerCase() !== repository.toLowerCase());
  const delivery =
    boundaries.trust && boundaries.live
      ? prDelivery(
          status.pullRequest.url,
          reportFollowUpFacts(status),
          status.pullRequest.state === "OPEN",
          await readIssuesDelivery(
            repository,
            local.map((i) => i.number),
            { ...boundaries.live, trust: boundaries.trust, signal: boundaries.signal },
          ),
          repository,
          foreign,
        )
      : null;
  const report = withDeliveryCompleteness(delivery ? { ...status, delivery } : status, delivery);
  const text = appendLines(prStatusText(status), delivery ? prDeliveryLines(delivery) : []);
  return { report, text, complete: report.completeness.complete };
}
