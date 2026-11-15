/**
 * Transport-neutral reads for `team`, `who N` and `pr N` (doc/design/serve.md "Research
 * summary", #373). The CLI and `pdb serve` call these directly; neither runs the other or parses
 * terminal text, so both emit the same versioned JSON for the same facts.
 */
import { collectIssueFocus, ghQueryWith } from "../github/github.js";
import type { FocusOptions, Query, Rest } from "../github/github.js";
import { ReadMeter } from "../github/readplan.js";
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
  /**
   * Builds the same trust decision over a given REST boundary, so a focused read can meter its
   * permission lookups (#367). When absent, `trust` is used unmetered.
   */
  trustWith?: (rest: Rest) => TrustDecision;
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
  return { report, text, complete: report.completeness.complete, delivery: read };
}

/**
 * Boundaries whose GitHub reads are recorded by `meter` as `source`. Trust is rebuilt over the
 * metered REST boundary when the caller supplies `trustWith`.
 */
export function meteredBoundaries(
  boundaries: DeliveryBoundaries,
  meter: ReadMeter,
  subject: string,
): DeliveryBoundaries {
  if (!boundaries.live) return boundaries;
  const live = {
    query: meter.query(boundaries.live.query, "delivery-records", subject),
    rest: meter.rest(boundaries.live.rest, "delivery-records", subject),
  };
  return {
    ...boundaries,
    live,
    trust: boundaries.trustWith
      ? boundaries.trustWith(meter.rest(boundaries.live.rest, "permissions", subject))
      : boundaries.trust,
  };
}

/** Record delivery and permission coverage from a delivery read and the metered calls. */
export function coverDelivery(
  meter: ReadMeter,
  subject: string,
  boundaries: DeliveryBoundaries,
  delivery: { complete: boolean; omissions: string[] } | null,
): void {
  if (!boundaries.trust || !boundaries.live || !delivery) {
    meter.cover("delivery-records", subject, "not-requested", {
      omission: "offline or no delivery boundaries; delivery is not evaluated",
    });
    meter.cover("permissions", subject, "not-requested", {
      omission: "no permission lookup; no record author is trusted",
    });
    return;
  }
  meter.cover(
    "delivery-records",
    subject,
    delivery.complete ? "complete" : "partial",
    delivery.complete ? {} : { omission: delivery.omissions.join("; ") },
  );
  const lookups = meter.calls.filter((c) => c.source === "permissions");
  // A lookup GitHub did not answer with 200 leaves that author's authority unknown.
  const unanswered = lookups.filter((c) => c.outcome !== "success" || c.status !== 200).length;
  if (!boundaries.trustWith)
    meter.cover("permissions", subject, "partial", {
      omission: "permission lookups were not metered; their completeness is unknown",
    });
  else
    meter.cover(
      "permissions",
      subject,
      unanswered ? "partial" : "complete",
      unanswered
        ? { omission: `${unanswered} of ${lookups.length} lookups unanswered; authority unknown` }
        : {},
    );
}

/**
 * `who N` live (issue-detail-v1, #367): reads only the ticket and its linked open PRs, then the
 * delivery records of that ticket. CLI and serve share this plan.
 */
export async function readWhoLive(
  repository: string,
  number: number,
  options: {
    staleHours: number;
    now: Date;
    signal?: AbortSignal;
    /** Issue-location diagnosis over a confined boundary (serve); default: gh REST. */
    locate?: FocusOptions["locate"];
  },
  boundaries: DeliveryBoundaries,
  query: Query = ghQueryWith(options.signal),
  clock: () => Date = () => new Date(),
  focus: typeof collectIssueFocus = collectIssueFocus,
) {
  const { locate, signal } = options;
  const meter = new ReadMeter("issue-detail-v1", "who", clock, undefined, signal);
  const snapshot = await focus(
    repository,
    number,
    { meter, signal, ...(locate ? { locate } : {}) },
    query,
    clock,
  );
  const subject = `${repository}#${number}`;
  const metered = meteredBoundaries(boundaries, meter, subject);
  const read = await readWho(
    snapshot,
    number,
    { staleHours: options.staleHours, now: options.now, offline: false },
    metered,
  );
  coverDelivery(meter, subject, metered, metered.trust && metered.live ? read.delivery : null);
  const report = { ...read.report, collection: meter.collection() };
  return { report, text: read.text, complete: read.complete };
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
  // pr-status-v1 (#367): the selected PR, then delivery of the issues it closes; nothing else.
  const meter = new ReadMeter("pr-status-v1", "pr", now, undefined, boundaries.signal);
  const subject = `${repository}#${number}`;
  const status = await pullRequestStatus(repository, number, query, now, meter);
  const metered = meteredBoundaries(boundaries, meter, subject);
  // Keep each linked issue's repository: a PR may close an issue elsewhere.
  const linked = status.linkedIssues.map((i) => {
    const m = i.url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+/);
    return { number: i.number, repository: m ? m[1] : "(unknown repository)" };
  });
  const local = linked.filter((i) => i.repository.toLowerCase() === repository.toLowerCase());
  const foreign = linked.filter((i) => i.repository.toLowerCase() !== repository.toLowerCase());
  const delivery =
    metered.trust && metered.live
      ? prDelivery(
          status.pullRequest.url,
          reportFollowUpFacts(status),
          status.pullRequest.state === "OPEN",
          await readIssuesDelivery(
            repository,
            local.map((i) => i.number),
            { ...metered.live, trust: metered.trust, signal: metered.signal },
          ),
          repository,
          foreign,
        )
      : null;
  coverDelivery(meter, subject, metered, delivery);
  const report = {
    ...withDeliveryCompleteness(delivery ? { ...status, delivery } : status, delivery),
    collection: meter.collection(),
  };
  const text = appendLines(prStatusText(status), delivery ? prDeliveryLines(delivery) : []);
  return { report, text, complete: report.completeness.complete };
}
