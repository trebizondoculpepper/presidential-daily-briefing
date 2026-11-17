/**
 * Transport-neutral reads for `team`, `who N` and `pr N` (doc/design/serve.md "Research
 * summary", #373). The CLI and `pdb serve` call these directly; neither runs the other or parses
 * terminal text, so both emit the same versioned JSON for the same facts.
 */
import type { DeclaredReviewPolicy } from "./reviewpolicy.js";
import { collectIssueFocus, ghQueryWith, hydratePullRequests } from "../github/github.js";
import type { FocusOptions, Query, Rest } from "../github/github.js";
import { permissionLookup } from "../github/github.js";
import type { GraphQuery } from "./claims.js";
import { readClaimActivity, readTeamActivity, teamActivityCap } from "./retainedfacts.js";
import { ReadMeter } from "../github/readplan.js";
import type { Snapshot } from "../github/types.js";
import { diagnoseDelivery } from "./deliverydoctor.js";
import type { DeliveryDiagnosis } from "./deliverydoctor.js";
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
  /**
   * The repository's declared review policy (#301), resolved by the front end from its verified
   * project; absent: legacy, reported as not read. Every read using these boundaries applies it.
   */
  reviewPolicy?: DeclaredReviewPolicy;
}

/** The snapshot with the boundaries' declared review policy attached (#301). */
const withPolicy = (snapshot: Snapshot, boundaries: DeliveryBoundaries): Snapshot =>
  boundaries.reviewPolicy ? { ...snapshot, reviewPolicy: boundaries.reviewPolicy } : snapshot;

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
  snapshot = withPolicy(snapshot, boundaries);
  // #413: each claim's activity on a live read, with the claim guard's own reader (bounded).
  const holders = teamView(snapshot, options).agents.map((a) => a.agent);
  const activity =
    boundaries.live && !options.offline && holders.length
      ? await readTeamActivity(snapshot, holders, {
          query: boundaries.live.query as GraphQuery,
          permission: permissionLookup(
            snapshot.repository,
            boundaries.live.rest,
            boundaries.signal,
          ),
        })
      : null;
  const view = teamView(snapshot, {
    ...options,
    ...(activity ? { activity: activity.activity } : {}),
  });
  if (activity?.omitted.length)
    view.completeness = {
      complete: false,
      warnings: [
        ...view.completeness.warnings,
        `Claim activity not read for ${activity.omitted.join(", ")}: more than ${teamActivityCap} claims in this view; read one with pdb who N.`,
      ],
    };
  const unknownActivity = activity
    ? [...activity.activity].flatMap(([agent, claims]) =>
        [...claims.values()]
          .filter((f) => f.state === "unknown")
          .map(
            (f) => `Claim activity for ${agent} on #${f.number} could not be verified: ${f.reason}`,
          ),
      )
    : [];
  if (unknownActivity.length)
    view.completeness = {
      complete: false,
      warnings: [...view.completeness.warnings, ...unknownActivity],
    };
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
  /** A diagnosis of this ticket already made over the same boundaries; read when absent. */
  diagnosis?: DeliveryDiagnosis,
) {
  snapshot = withPolicy(snapshot, boundaries);
  const ownership = ticketOwnership(snapshot, number, options);
  // #192: delivery, responsibility and closure from the shared fold and evaluator.
  // Only the requested issue is evaluated, so the evaluation cap can never skip it.
  const scoped = { ...snapshot, issues: snapshot.issues.filter((i) => i.number === number) };
  const read = deliveryRead(scoped, diagnosis ?? (await diagnoseDelivery(scoped, boundaries)));
  const view = read.tickets.find((t) => t.number === number) ?? null;
  const issue = scoped.issues[0];
  // #413: each recorded owner's claim activity on this ticket, live only (null: not read).
  const claimActivity =
    boundaries.live && !options.offline && ownership.recordedOwners
      ? await Promise.all(
          ownership.recordedOwners.map(async (agent) => {
            const fact = await readClaimActivity(snapshot.repository, number, agent, {
              query: boundaries.live!.query as GraphQuery,
              permission: permissionLookup(
                snapshot.repository,
                boundaries.live!.rest,
                boundaries.signal,
              ),
            });
            return { agent, state: fact.state, reason: fact.reason };
          }),
        )
      : null;
  const unknownActivity = (claimActivity ?? []).filter((f) => f.state === "unknown");
  if (unknownActivity.length)
    ownership.completeness = {
      complete: false,
      warnings: [
        ...ownership.completeness.warnings,
        ...unknownActivity.map(
          (f) =>
            `Claim activity for ${f.agent} on #${number} could not be verified${f.reason ? `: ${f.reason}` : "."}`,
        ),
      ],
    };
  const report = withDeliveryCompleteness(
    issue
      ? { ...ownership, claimActivity, ...deliveryFields(issue, view) }
      : { ...ownership, claimActivity },
    read,
  );
  const text = appendLines(ticketOwnershipText(ownership), [
    ...(claimActivity ?? []).map(
      (a) => `Claim activity: ${a.agent}: ${a.state}${a.reason ? ` (${a.reason})` : ""}`,
    ),
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
  const meter = new ReadMeter("issue-detail-v1", "who", clock, undefined, options.signal);
  const read = await readWhoWith(meter, repository, number, options, boundaries, query, focus);
  const report = { ...read.report, collection: meter.collection() };
  return { report, text: read.text, complete: read.complete };
}

/**
 * The focused `who N` plan over a caller's meter: the ticket, its linked open PRs, its delivery
 * records and the open required members. `pdb ticket N` (#197) builds on the same read; the
 * caller reports `meter.collection()`. Returns the snapshot, the metered boundaries and the
 * delivery diagnosis so a caller reads nothing twice.
 */
export async function readWhoWith(
  meter: ReadMeter,
  repository: string,
  number: number,
  options: {
    staleHours: number;
    now: Date;
    signal?: AbortSignal;
    locate?: FocusOptions["locate"];
    nativeEdges?: boolean;
    /** Total PRs this read may hydrate, linked first, then members (`ticket --limit-prs`). */
    hydrationLimit?: number;
  },
  boundaries: DeliveryBoundaries,
  query: Query,
  focus: typeof collectIssueFocus,
) {
  const { locate, signal } = options;
  const focused = await focus(
    repository,
    number,
    {
      meter,
      signal,
      ...(locate ? { locate } : {}),
      ...(boundaries.live?.rest ? { rest: boundaries.live.rest } : {}),
      ...(options.nativeEdges ? { nativeEdges: true } : {}),
      ...(options.hydrationLimit !== undefined ? { hydrationLimit: options.hydrationLimit } : {}),
    },
    query,
    meter.now,
  );
  const snapshot = withPolicy(focused, boundaries);
  const subject = `${repository}#${number}`;
  // A definitive quota refusal while hydrating linked PRs stops the read: no delivery, permission
  // or legacy-release request is sent after it. Those sources are reported not read, and the
  // answer is incomplete rather than evaluated from a partial read.
  const refused = meter.refused || meter.notAttempted.length > 0;
  const metered = refused ? {} : meteredBoundaries(boundaries, meter, subject);
  let diagnosis: DeliveryDiagnosis | undefined;
  if (!refused && metered.trust && metered.live) {
    // Required members of the ticket's trusted delivery records are read too, not only PRs
    // with a closing reference: a member without "Closes #N" is still this ticket's work. The
    // full snapshot held every open PR; here only open members are hydrated (same bound,
    // concurrency and quota stop). A member not read stays unknown in its follow-up.
    const scoped = { ...snapshot, issues: snapshot.issues.filter((i) => i.number === number) };
    diagnosis = await diagnoseDelivery(scoped, metered);
    // Linked PRs already read count against the hydration limit; members get the rest.
    const attempted = meter.coverage.filter(
      (c) => c.source === "pull-request" && c.state !== "not-requested",
    ).length;
    snapshot.pullRequests.push(
      ...(await hydrateMembers(
        repository,
        diagnosis,
        number,
        snapshot,
        meter,
        options.signal,
        query,
        options.hydrationLimit === undefined
          ? undefined
          : Math.max(0, options.hydrationLimit - attempted),
      )),
    );
  }
  const read = await readWho(
    snapshot,
    number,
    { staleHours: options.staleHours, now: options.now, offline: false },
    metered,
    diagnosis,
  );
  // A refusal during the delivery diagnosis or the member reads: the meter sent nothing after it.
  const quotaLater = !refused && meter.refused;
  if (refused || quotaLater) {
    const omission = "not read: GitHub refused a request for quota earlier in this read";
    if (refused) {
      meter.cover("delivery-records", subject, "not-requested", { omission });
      meter.cover("permissions", subject, "not-requested", { omission });
    } else coverDelivery(meter, subject, metered, read.delivery);
    const warning = refused
      ? `Delivery and permission evidence for #${number} was not read after a rate-limit refusal; delivery is unknown.`
      : `GitHub refused a request of this read of #${number} for quota; delivery, permission or member evidence after it was not read and is unknown.`;
    const report = {
      ...read.report,
      completeness: {
        ...read.report.completeness,
        complete: false,
        warnings: [...read.report.completeness.warnings, warning],
      },
    };
    return {
      report,
      text: appendLines(read.text, [`INCOMPLETE: ${warning}`]),
      complete: false,
      snapshot,
      metered,
      delivery: read.delivery,
    };
  }
  coverDelivery(meter, subject, metered, metered.trust && metered.live ? read.delivery : null);
  return {
    report: read.report,
    text: read.text,
    complete: read.complete,
    snapshot,
    metered,
    delivery: read.delivery,
  };
}

/** States whose follow-up memberView derives from the PR's own checks and review. */
const settledMemberStates = new Set(["merged", "closed-unmerged", "merged-off-target", "unknown"]);
const memberLabel = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * Hydrate the open required members of one ticket's evaluated delivery that the focused read
 * does not already hold. Cross-repository members are never read here (the full snapshot held
 * only this repository's PRs); they are recorded `not-requested` and stay unknown.
 */
async function hydrateMembers(
  repository: string,
  diagnosis: DeliveryDiagnosis,
  number: number,
  snapshot: Snapshot,
  meter: ReadMeter,
  signal: AbortSignal | undefined,
  query: Query,
  /** At most this many members are read; the rest are not-requested and warned about. */
  limit?: number,
) {
  const d = diagnosis.issues.get(number);
  const evaluated = d?.evaluation?.perDeliverable ?? [];
  const held = new Set(snapshot.pullRequests.map((p) => p.number));
  const targets = new Map<number, { number: number; url: string }>();
  (d?.members ?? []).forEach((m, i) => {
    const match = memberLabel.exec(m.deliverable);
    const state = evaluated[i]?.state;
    if (!match || !state || settledMemberStates.has(state)) return;
    if (match[1].toLowerCase() !== repository.toLowerCase()) {
      meter.cover("pull-request", m.deliverable, "not-requested", {
        omission: "delivery member in another repository; its follow-up is unknown",
      });
      return;
    }
    const n = Number(match[2]);
    if (!held.has(n))
      targets.set(n, { number: n, url: `https://github.com/${match[1]}/pull/${n}` });
  });
  if (limit !== undefined)
    for (const t of [...targets.values()].slice(limit)) {
      targets.delete(t.number);
      meter.cover("pull-request", `${repository}#${t.number}`, "not-requested", {
        omission: `beyond the hydration limit`,
      });
      snapshot.warnings.push(
        `${t.url}: delivery member pull request not read (beyond the limit); its evidence is unknown.`,
      );
    }
  if (!targets.size) return [];
  // A refusal during the delivery diagnosis stops here: no member is read after it.
  if (meter.refused) {
    for (const t of targets.values()) {
      meter.notAttempted.push(t.url);
      meter.cover("pull-request", `${repository}#${t.number}`, "not-requested", {
        omission: "not attempted after a quota refusal",
      });
      snapshot.warnings.push(
        `${t.url}: delivery member pull request not read after a rate-limit refusal; its evidence is unknown.`,
      );
    }
    return [];
  }
  return hydratePullRequests(
    repository,
    [...targets.values()],
    { meter, signal, warnings: snapshot.warnings, role: "delivery member" },
    query,
  );
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
  /** Declared review policy (#301); default: the boundaries' policy. */
  reviewPolicy: DeclaredReviewPolicy | undefined = boundaries.reviewPolicy,
) {
  // pr-status-v1 (#367): the selected PR, then delivery of the issues it closes; nothing else.
  const meter = new ReadMeter("pr-status-v1", "pr", now, undefined, boundaries.signal);
  const subject = `${repository}#${number}`;
  const status = await pullRequestStatus(
    repository,
    number,
    query,
    now,
    meter,
    reviewPolicy,
    boundaries.live?.rest,
  );
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
