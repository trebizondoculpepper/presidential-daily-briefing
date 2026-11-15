/**
 * `pdb ticket N`: one ticket and its associated pull requests in one bounded read (#197).
 * Contract: doc/design/consolidated-ticket-view.md.
 *
 * Transport-neutral: the CLI calls `readTicketStatus` and renders `ticketStatusText`; a later
 * serve route (#454) calls the same service. It composes existing reads only: the focused
 * `who N` plan (issue, native edges, comments, linked open PRs, delivery records and members)
 * under one meter, one bounded read of the issue's closing references including closed PRs,
 * and the shared `pr N` status service for at most `limitPrs` PRs, required members first.
 *
 * Unknown stays unknown: an omitted, failed or not-attempted PR read, a truncated list, an
 * unread delivery record or a quota stop leaves the document incomplete (exit 2), never "no PR",
 * "no blocker" or "done". Read-only: next steps name supported commands, never run them.
 */
import { prop, selected, SubjectUnavailable } from "../github/github.js";
import type { FocusOptions, Query } from "../github/github.js";
import { collectIssueFocus, ghQueryWith } from "../github/github.js";
import { hydrate, quotaRefusal, ReadMeter, readProfiles } from "../github/readplan.js";
import type { ReadCollection, ReadSourceCoverage } from "../github/readplan.js";
import { dependencyFacts, nativeKnown } from "../github/dependencies.js";
import type { Comment, Issue } from "../github/types.js";
import { readAssessment, unknownTrust } from "../briefing/assessments.js";
import type { MetricView } from "../briefing/assessments.js";
import { complexityMetric, impactMetric } from "../estimation/metrics.js";
import { closureOf } from "./deliverydoctor.js";
import type { Closure } from "./deliverydoctor.js";
import { classifyFollowUp, memberFollowUp, reportFollowUpFacts } from "./deliveryread.js";
import type { DeliverableView, DeliveryView, FollowUp } from "./deliveryread.js";
import { excerpt, pullRequestStatus } from "./prstatus.js";
import type { PrStatusReport } from "./prstatus.js";
import { readWhoWith } from "./readservices.js";
import type { DeliveryBoundaries } from "./readservices.js";
import type { TicketOwnership } from "./who.js";

/** Bounds of the default presentation; every omission is counted. */
export const ticketLimits = {
  /** Default and maximum of `--limit-prs`. */
  defaultPullRequests: readProfiles["ticket-status-v1"].bounds.detailedPullRequests,
  maxPullRequests: 100,
  /** Latest discussion excerpts shown, from the already read comment history. */
  excerpts: 3,
  /** Workflow records (claims, handoffs, releases) shown, newest last. */
  records: 5,
  /** Blockers shown per PR row in text (JSON keeps every one). */
  rowBlockers: 2,
};

export type PrRelation = "required" | "closing-reference";
/** One associated PR: its relations to the ticket and, when read, its current-head status. */
export interface TicketPullRequest {
  repository: string;
  number: number;
  url: string;
  /** Every relation the PR has to this ticket (deduplicated by identity). */
  relations: PrRelation[];
  /** `read` complete or partial status; anything else is unknown evidence, never absence. */
  detail: "read" | "omitted" | "failed" | "not-attempted";
  /** Why the detail is not `read` (bound, failure category, quota stop). */
  detailWhy: string | null;
  /** The state GitHub's closing-reference list gave, when the PR came from it. */
  listedState: string | null;
  observedAt: string | null;
  title: string | null;
  state: string | null;
  draft: boolean | null;
  head: string | null;
  branch: string | null;
  base: string | null;
  /** The recorded intended target of a required member (`owner/name:branch`). */
  intendedTarget: string | null;
  /** The live base differs from the intended target's branch; null when not comparable. */
  targetMismatch: boolean | null;
  checks: { verify: string; counts: Record<string, number> } | null;
  review: {
    decision: string | null;
    headReviewed: boolean;
    headFindings: boolean;
    unresolvedThreads: number;
  } | null;
  mergeable: string | null;
  blockers: string[];
  /** Delivery member state from the shared evaluator (required members only). */
  memberState: string | null;
  responsible: string | null;
  followUp: FollowUp | null;
  followUpWhy: string | null;
  complete: boolean;
  warnings: string[];
}

export interface TicketNextStep {
  kind: "inspect" | "follow-up" | "wait" | "none";
  why: string;
  /** A registered rule ID when one decided it; null for the shared classifiers. */
  rule: string | null;
  subject: string;
  command: string | null;
}

export interface TicketStatus {
  schemaVersion: 1;
  kind: "ticket-status";
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  closure: Closure;
  /** The closing actor is not read by this profile; null is unknown, not "nobody". */
  closedBy: string | null;
  identity: { agent: string | null; platform: string | null; note: string };
  freshness: {
    requestedAt: string;
    mode: "live";
    sources: { source: string; subject: string; state: string; observedAt: string | null }[];
    note: string;
  };
  coverage: {
    complete: boolean;
    warnings: string[];
    /** Per-source coverage of this read, including independent failures. */
    sources: ReadSourceCoverage[];
    linkage: { scope: string; complete: boolean };
    omitted: {
      pullRequests: { identity: string; relations: PrRelation[]; why: string }[];
      discussionComments: number;
      records: number;
    };
    limitPullRequests: number;
  };
  ownership: {
    answer: string;
    recordedOwners: string[] | null;
    presence: string;
    ticketResponsible: string | null;
    /** Null when the delivery records are not known: responsibility is then unknown. */
    responsibilityKnown: boolean;
    latestActivity: TicketOwnership["latestActivity"];
  };
  delivery: {
    verdict: DeliveryView["delivery"] | "no-record" | "unknown";
    records: DeliveryView["records"] | "none";
    because: string[];
    required: string[];
    deliverables: DeliverableView[];
  };
  pullRequests: TicketPullRequest[];
  dependencies: {
    known: boolean;
    blockedBy: { url: string; number: number; title: string; state: string; repository: string }[];
    blocking: { url: string; number: number; title: string; state: string; repository: string }[];
    verdict: string;
  };
  discussion: {
    totalComments: number;
    records: { kind: string; at: string | null; url: string; excerpt: string }[];
    excerpts: {
      author: string;
      at: string | null;
      url: string;
      excerpt: string;
      trust: "unverified";
    }[];
    note: string;
  };
  assessments: { impact: MetricView; complexity: MetricView };
  nextSteps: TicketNextStep[];
  links: { intake: string; dependencies: string; issue: string; pullRequests: string[] };
  completeness: { complete: boolean; warnings: string[] };
  collection: ReadCollection;
}

export interface TicketStatusOptions {
  staleHours: number;
  now: Date;
  limitPrs?: number;
  agent?: string;
  platform?: string;
  signal?: AbortSignal;
  locate?: FocusOptions["locate"];
}

const prUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i;
const memberLabel = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const identityOf = (repository: string, number: number) => `${repository.toLowerCase()}#${number}`;

/**
 * Every PR whose closing reference names this issue, closed and merged included: the focused
 * `who` read lists open ones only. Bounded by the profile's linked-PR pages; a continuation left
 * unread is a partial list, never "no other PR".
 */
async function closingReferences(
  repository: string,
  number: number,
  meter: ReadMeter,
  base: Query,
  signal: AbortSignal | undefined,
): Promise<{ refs: { number: number; url: string; state: string }[]; complete: boolean }> {
  const bounds = readProfiles["ticket-status-v1"].bounds;
  const [owner, name] = repository.split("/");
  const subject = `${repository}#${number}`;
  const q = meter.query(base, "linked-pull-requests", `${subject} (closed included)`);
  const refs: { number: number; url: string; state: string }[] = [];
  let cursor: string | null = null;
  let more = true;
  let pagesRead = 0;
  try {
    while (more && pagesRead < bounds.linkedPullRequestPages) {
      signal?.throwIfAborted();
      const data = await q(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:${bounds.linkedPullRequestsPerPage},includeClosedPrs:true,after:$cursor){nodes{number url state} pageInfo{hasNextPage endCursor}}}}}`,
        { owner, name, number, ...(cursor ? { cursor } : {}) },
      );
      const page = selected<{
        nodes: { number: number; url: string; state: string }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      }>(prop(data, "repository", "issue", "closedByPullRequestsReferences"));
      if (!page) throw new Error("closing references not readable");
      pagesRead++;
      refs.push(...page.nodes);
      more = page.pageInfo.hasNextPage;
      if (more && (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)) break;
      cursor = page.pageInfo.endCursor;
    }
  } catch (error) {
    signal?.throwIfAborted();
    const failure = quotaRefusal(error) ? "rate-limited" : "read-failed";
    meter.cover("linked-pull-requests", `${subject} (closed included)`, "failed", { failure });
    return { refs, complete: false };
  }
  if (more)
    meter.cover("linked-pull-requests", `${subject} (closed included)`, "partial", {
      omission: `closing references beyond ${refs.length} (${pagesRead} pages of ${bounds.linkedPullRequestsPerPage}) not read`,
    });
  else meter.cover("linked-pull-requests", `${subject} (closed included)`, "complete");
  return { refs, complete: !more };
}

/** Target branch of a recorded `owner/name:branch` target; null for the default branch. */
const targetBranch = (target: string | null): string | null => {
  const m = target ? /^[\w.-]+\/[\w.-]+:(.+)$/.exec(target) : null;
  return m ? m[1] : null;
};

function prRow(
  id: { repository: string; number: number; url: string; relations: PrRelation[] },
  listedState: string | null,
  member: DeliverableView | null,
): TicketPullRequest {
  return {
    ...id,
    detail: "omitted",
    detailWhy: null,
    listedState,
    observedAt: null,
    title: null,
    state: null,
    draft: null,
    head: null,
    branch: null,
    base: null,
    intendedTarget: member?.target ?? null,
    targetMismatch: null,
    checks: null,
    review: null,
    mergeable: null,
    blockers: [],
    memberState: member && member.state !== "not-evaluated" ? member.state : null,
    responsible: member?.responsible ?? null,
    followUp: member?.followUp ?? null,
    followUpWhy: member?.followUpWhy ?? null,
    complete: false,
    warnings: [],
  };
}

function withStatus(
  row: TicketPullRequest,
  r: PrStatusReport,
  member: DeliverableView | null,
  closure: Closure,
): TicketPullRequest {
  const p = r.pullRequest;
  const intended = targetBranch(row.intendedTarget);
  const open = p.state === "OPEN";
  const facts = reportFollowUpFacts(r);
  // Shared classifiers only: a required member exactly as `pr N` decides it (closure cleanup and
  // settled members keep the delivery view's); an associated PR from its fresh evidence.
  const [followUp, followUpWhy]: [FollowUp | null, string | null] = member
    ? memberFollowUp(member, closure, open, facts)
    : open
      ? classifyFollowUp(facts)
      : [null, null];
  return {
    ...row,
    detail: "read",
    observedAt: r.fetchedAt,
    title: p.title,
    state: p.state,
    draft: p.draft,
    head: p.head,
    branch: p.branch,
    base: p.base,
    targetMismatch: intended === null ? null : intended !== p.base,
    checks: {
      verify: r.checks.required ? r.checks.required.class : "missing",
      counts: r.checks.counts,
    },
    review: {
      decision: p.reviewDecision,
      headReviewed: r.headReviewed,
      headFindings: r.headFindings,
      unresolvedThreads: r.threads.unresolved.length + r.threads.omitted,
    },
    mergeable: p.mergeable,
    blockers: r.blockers,
    followUp,
    followUpWhy,
    complete: r.completeness.complete,
    warnings: r.completeness.warnings,
  };
}

/** Read one ticket and its associated PRs; see the module comment. */
export async function readTicketStatus(
  repository: string,
  number: number,
  options: TicketStatusOptions,
  boundaries: DeliveryBoundaries,
  query: Query = ghQueryWith(options.signal),
  clock: () => Date = () => new Date(),
  focus: typeof collectIssueFocus = collectIssueFocus,
): Promise<{ report: TicketStatus; text: string; complete: boolean }> {
  const { signal } = options;
  const limitPrs = options.limitPrs ?? ticketLimits.defaultPullRequests;
  const meter = new ReadMeter("ticket-status-v1", "ticket", clock, undefined, signal);
  const subject = `${repository}#${number}`;
  const warnings: string[] = [];

  // 1. The ticket, its native edges, comments, open linked PRs, delivery records and members.
  const who = await readWhoWith(
    meter,
    repository,
    number,
    {
      staleHours: options.staleHours,
      now: options.now,
      nativeEdges: true,
      // --limit-prs bounds the first hydration pass too: nothing beyond it is read in detail.
      hydrationLimit: limitPrs,
      ...(signal ? { signal } : {}),
      ...(options.locate ? { locate: options.locate } : {}),
    },
    boundaries,
    query,
    focus,
  );
  const issue = who.snapshot.issues.find((i) => i.number === number) as Issue;
  const ownership = who.report as unknown as TicketOwnership & {
    delivery: DeliveryView | null;
    responsibility: DeliveryView["responsibility"];
  };
  warnings.push(...who.report.completeness.warnings);
  const view = ownership.delivery ?? null;

  // 2. Every closing reference, closed included (one bounded read), unless quota stopped.
  let linkage = { refs: [] as { number: number; url: string; state: string }[], complete: false };
  if (meter.refused) {
    meter.notAttempted.push(`linked-pull-requests ${subject} (closed included)`);
    meter.cover("linked-pull-requests", `${subject} (closed included)`, "not-requested", {
      omission: "not attempted after a quota refusal",
    });
  } else linkage = await closingReferences(repository, number, meter, query, signal);
  if (!linkage.complete)
    warnings.push(
      "Closing references (closed PRs included) were not read completely; other associated PRs may exist.",
    );

  // 3. Identities: required members first, then closing references; deduplicated.
  const ids = new Map<
    string,
    {
      repository: string;
      number: number;
      url: string;
      relations: PrRelation[];
      listed: string | null;
      member: DeliverableView | null;
    }
  >();
  for (const m of view?.deliverables ?? []) {
    const match = memberLabel.exec(m.deliverable);
    if (!match) continue; // A commit deliverable: shown in delivery, not as a PR row.
    const key = identityOf(match[1], Number(match[2]));
    ids.set(key, {
      repository: match[1],
      number: Number(match[2]),
      url: m.url ?? `https://github.com/${match[1]}/pull/${match[2]}`,
      relations: ["required"],
      listed: null,
      member: m,
    });
  }
  for (const ref of linkage.refs) {
    const match = prUrl.exec(ref.url);
    if (!match) continue;
    const key = identityOf(match[1], ref.number);
    const known = ids.get(key);
    if (known) {
      if (!known.relations.includes("closing-reference")) known.relations.push("closing-reference");
      known.listed = ref.state;
    } else
      ids.set(key, {
        repository: match[1],
        number: ref.number,
        url: ref.url,
        relations: ["closing-reference"],
        listed: ref.state,
        member: null,
      });
  }
  // Open linked PRs the who read hydrated: a reference beyond the closed-included read's bound.
  for (const pr of who.snapshot.pullRequests) {
    const key = identityOf(repository, pr.number);
    const linked = (pr.closingIssuesReferences?.nodes ?? []).some(
      (r) => r.url.toLowerCase() === issue.url.toLowerCase(),
    );
    if (!ids.has(key) && linked)
      ids.set(key, {
        repository,
        number: pr.number,
        url: pr.url,
        relations: ["closing-reference"],
        listed: pr.state,
        member: null,
      });
  }
  const byOrder = (a: { repository: string; number: number }, b: typeof a) =>
    a.repository.toLowerCase().localeCompare(b.repository.toLowerCase()) || a.number - b.number;
  const all = [...ids.values()];
  const ordered = [
    ...all.filter((i) => i.relations.includes("required")).sort(byOrder),
    ...all.filter((i) => !i.relations.includes("required")).sort(byOrder),
  ];
  const detailed = ordered.slice(0, limitPrs);
  const omitted = ordered.slice(limitPrs);

  // 4. The shared PR-status service for each detailed PR, at most three at once; a quota
  // refusal stops scheduling and the rest are not attempted.
  const rows: TicketPullRequest[] = ordered.map((i) =>
    prRow(
      { repository: i.repository, number: i.number, url: i.url, relations: i.relations },
      i.listed,
      i.member,
    ),
  );
  const results = meter.refused
    ? detailed.map(() => ({ state: "not-attempted" as const }))
    : await hydrate(
        detailed,
        (i) => pullRequestStatus(i.repository, i.number, query, clock, meter),
        { concurrency: readProfiles["ticket-status-v1"].bounds.hydrationConcurrency, signal },
      );
  results.forEach((outcome, index) => {
    const id = detailed[index];
    const prSubject = `${id.repository}#${id.number}`;
    if (outcome.state === "done")
      rows[index] = withStatus(
        rows[index],
        outcome.value,
        detailed[index].member,
        closureOf(issue.state, issue.stateReason),
      );
    else if (outcome.state === "failed") {
      const failure = quotaRefusal(outcome.error)
        ? "rate-limited"
        : outcome.error instanceof SubjectUnavailable
          ? "unavailable"
          : "read-failed";
      meter.cover("pull-request", `${prSubject} (status)`, "failed", { failure });
      rows[index] = { ...rows[index], detail: "failed", detailWhy: failure };
    } else {
      meter.notAttempted.push(id.url);
      meter.cover("pull-request", `${prSubject} (status)`, "not-requested", {
        omission: "not attempted after a quota refusal",
      });
      rows[index] = {
        ...rows[index],
        detail: "not-attempted",
        detailWhy: "not attempted after a quota refusal",
      };
    }
  });
  omitted.forEach((_, i) => {
    const index = detailed.length + i;
    rows[index] = { ...rows[index], detailWhy: `beyond --limit-prs ${limitPrs}` };
  });
  for (const row of rows) {
    if (row.detail !== "read")
      warnings.push(
        `${row.url} (${row.relations.join(", ")}): status ${row.detail}${row.detailWhy ? ` (${row.detailWhy})` : ""}; its evidence is unknown.`,
      );
    else if (!row.complete) warnings.push(...row.warnings.map((w) => `${row.url}: ${w}`));
  }

  // 5. Assessments from the already read labels and comments; provenance trust is metered.
  const trust = meter.refused ? unknownTrust : (who.metered.trust ?? unknownTrust);
  const assess = async (d: typeof impactMetric): Promise<MetricView> => {
    try {
      const r = await readAssessment(d, issue, { trust });
      return { state: r.state, size: r.size, provenance: r.provenance };
    } catch {
      signal?.throwIfAborted();
      return { state: "unknown", size: null, provenance: null };
    }
  };
  const before = meter.calls.length;
  const assessments = {
    impact: await assess(impactMetric),
    complexity: await assess(complexityMetric),
  };
  // Provenance lookups made here come after the delivery coverage: record them separately, so
  // an unanswered one is a gap rather than an uncounted unknown.
  const lookups = meter.calls.slice(before).filter((c) => c.source === "permissions");
  const unanswered = lookups.filter((c) => c.outcome !== "success" || c.status !== 200).length;
  if (lookups.length)
    meter.cover(
      "permissions",
      `${subject} (assessment provenance)`,
      unanswered ? "partial" : "complete",
      unanswered
        ? { omission: `${unanswered} of ${lookups.length} lookups unanswered; provenance unknown` }
        : {},
    );

  // 6. Dependencies (direct only) from the edges read with the issue.
  const facts = dependencyFacts(issue, repository);
  const edge = (n: {
    url: string;
    number: number;
    title: string;
    state: string;
    repository: { nameWithOwner: string };
  }) => ({
    url: n.url,
    number: n.number,
    title: n.title,
    state: n.state,
    repository: n.repository.nameWithOwner,
  });

  // 7. Discussion: workflow records and the latest excerpts of the already read history.
  const comments: Comment[] = issue.comments.nodes;
  const human = comments.filter((c) => excerpt(c.body).length > 0);
  const latest = human.slice(-ticketLimits.excerpts);
  const records = ownership.commentEvidence ?? [];

  // Coverage: every source that is not complete is a gap, except a PR this view then read in
  // detail (the who plan records cross-repository members `not-requested`).
  const readIds = new Set(
    rows.filter((r) => r.detail === "read").map((r) => `${r.repository}#${r.number}`.toLowerCase()),
  );
  for (const c of meter.coverage)
    if (
      c.state !== "complete" &&
      !(
        c.source === "pull-request" &&
        c.state === "not-requested" &&
        readIds.has(c.subject.toLowerCase())
      )
    ) {
      const line = `${c.source} ${c.subject}: ${c.state}${c.omission ? ` (${c.omission})` : ""}${c.failure ? ` (${c.failure})` : ""}`;
      if (!warnings.includes(line)) warnings.push(line);
    }
  if (meter.refused)
    warnings.push("GitHub refused a request of this read for quota; later sources were not read.");
  const collection = meter.collection();
  if (collection.notAttempted.length)
    warnings.push(`Not attempted after a quota refusal: ${collection.notAttempted.join(", ")}.`);
  const complete = who.complete && warnings.length === 0;

  const intake = `pdb --issue ${number} --json --repo ${repository}`;
  const nextSteps = steps({
    repository,
    number,
    complete,
    closure: closureOf(issue.state, issue.stateReason),
    rows,
    view,
    blockers: facts.known ? facts.upstream.filter((n) => n.state === "OPEN") : null,
    intake,
  });

  const report: TicketStatus = {
    schemaVersion: 1,
    kind: "ticket-status",
    repository,
    number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    closure: closureOf(issue.state, issue.stateReason),
    closedBy: null,
    identity: {
      agent: options.agent ?? null,
      platform: options.platform ?? null,
      note: "Reported identity is focus only, never authorization.",
    },
    freshness: {
      requestedAt: options.now.toISOString(),
      mode: "live",
      sources: collection.coverage.map((c) => ({
        source: c.source,
        subject: c.subject,
        state: c.state,
        observedAt: c.observedAt,
      })),
      note: "Each source carries its own observation time; the request time is not one.",
    },
    coverage: {
      complete,
      warnings,
      sources: collection.coverage,
      linkage: {
        scope:
          "trusted delivery records, then GitHub closing references (open, closed and merged); body and comment mentions are not inspected",
        complete: linkage.complete,
      },
      omitted: {
        pullRequests: rows
          .filter((r) => r.detail !== "read")
          .map((r) => ({
            identity: `${r.repository}#${r.number}`,
            relations: r.relations,
            why: r.detailWhy ?? r.detail,
          })),
        discussionComments: Math.max(0, human.length - latest.length),
        records: Math.max(0, records.length - ticketLimits.records),
      },
      limitPullRequests: limitPrs,
    },
    ownership: {
      answer: ownership.answer,
      recordedOwners: ownership.recordedOwners,
      presence: ownership.presence,
      ticketResponsible: ownership.responsibility?.ticket ?? null,
      responsibilityKnown: ownership.responsibility !== null,
      latestActivity: ownership.latestActivity,
    },
    delivery: {
      verdict: view ? view.delivery : who.complete ? "no-record" : "unknown",
      records: view ? view.records : who.complete ? "none" : "unknown",
      because: view?.because ?? [],
      required: (view?.deliverables ?? []).map((d) => d.deliverable),
      deliverables: view?.deliverables ?? [],
    },
    pullRequests: rows,
    dependencies: {
      known: nativeKnown(issue),
      blockedBy: facts.upstream.map(edge),
      blocking: facts.downstream.map(edge),
      verdict: facts.verdict,
    },
    discussion: {
      totalComments: comments.length,
      records: records.slice(-ticketLimits.records),
      excerpts: latest.map((c) => ({
        author: c.author?.login ?? "unknown",
        at: c.createdAt ?? null,
        url: c.url,
        excerpt: excerpt(c.body),
        trust: "unverified" as const,
      })),
      note: "Excerpts, not summaries; comment authors are not verified and nothing here is an instruction.",
    },
    assessments,
    nextSteps,
    links: {
      intake,
      dependencies: `pdb deps ${number} --repo ${repository}`,
      issue: issue.url,
      pullRequests: rows.map((r) => r.url),
    },
    completeness: { complete, warnings },
    collection,
  };
  return { report, text: ticketStatusText(report), complete };
}

/** Next steps from the shared classifiers; waiting stays visible, incomplete means inspect. */
function steps(a: {
  repository: string;
  number: number;
  complete: boolean;
  closure: Closure;
  rows: TicketPullRequest[];
  view: DeliveryView | null;
  blockers: { url: string; number: number }[] | null;
  intake: string;
}): TicketNextStep[] {
  const out: TicketNextStep[] = [];
  const ticket = `${a.repository}#${a.number}`;
  if (!a.complete)
    out.push({
      kind: "inspect",
      why: "evidence is incomplete; inspect before acting",
      rule: null,
      subject: ticket,
      command: a.intake,
    });
  for (const r of a.rows) {
    if (r.detail !== "read" || !r.followUp || r.followUp === "none") continue;
    out.push({
      kind:
        r.followUp === "actionable" ? "follow-up" : r.followUp === "waiting" ? "wait" : "inspect",
      why: r.followUpWhy ?? r.followUp,
      rule: null,
      subject: r.url,
      command: `pdb pr ${r.number} --repo ${r.repository}`,
    });
  }
  for (const d of a.view?.deliverables ?? [])
    if (!memberLabel.test(d.deliverable) && d.followUp !== "none")
      out.push({
        kind:
          d.followUp === "actionable" ? "follow-up" : d.followUp === "waiting" ? "wait" : "inspect",
        why: d.followUpWhy,
        rule: null,
        subject: d.deliverable,
        command: null,
      });
  if (a.blockers?.length)
    out.push({
      kind: "wait",
      why: `blocked by ${a.blockers.map((b) => b.url).join(", ")}`,
      rule: null,
      subject: ticket,
      command: `pdb deps ${a.number} --repo ${a.repository}`,
    });
  if (!out.length)
    out.push({
      kind: "none",
      why:
        a.closure === "open"
          ? "no follow-up found in the inspected evidence; pickup and ranking are decided by the briefing"
          : `the issue is ${a.closure}; closure is reported, not evidence of delivery`,
      rule: null,
      subject: ticket,
      command: a.closure === "open" ? `pdb --repo ${a.repository}` : null,
    });
  return out;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");

function prLine(r: TicketPullRequest): string {
  const rel = r.relations.join("+");
  if (r.detail !== "read")
    return `  #${r.number} ${r.repository} [${rel}]${r.listedState ? ` ${r.listedState}` : ""} status ${r.detail}${r.detailWhy ? ` (${r.detailWhy})` : ""}: unknown — pdb pr ${r.number} --repo ${r.repository}`;
  const target = r.intendedTarget
    ? ` intended ${r.intendedTarget}${r.targetMismatch ? " (MISMATCH)" : ""}`
    : "";
  const review = r.review
    ? r.review.headReviewed
      ? "head accepted"
      : r.review.headFindings
        ? "head findings"
        : `review ${r.review.decision ?? "none"}`
    : "review ?";
  const threads = r.review?.unresolvedThreads ? `, ${r.review.unresolvedThreads} unresolved` : "";
  const follow = r.followUp ? ` · ${r.followUp}: ${r.followUpWhy}` : "";
  const extra =
    r.state === "OPEN" && r.blockers.length
      ? ` · blockers: ${r.blockers.slice(0, ticketLimits.rowBlockers).join("; ")}${r.blockers.length > ticketLimits.rowBlockers ? ` (+${r.blockers.length - ticketLimits.rowBlockers})` : ""}`
      : "";
  return `  #${r.number} ${r.repository} [${rel}] ${r.state}${r.draft ? " draft" : ""} ${short(r.head)} → ${r.base}${target} · verify ${r.checks?.verify ?? "?"} · ${review}${threads}${r.memberState ? ` · member ${r.memberState}` : ""}${follow}${extra}${r.complete ? "" : " · INCOMPLETE"}`;
}

const metric = (name: string, v: MetricView) =>
  v.state === "current"
    ? `${name} ${v.size}`
    : v.state === "stale"
      ? `${name} ${v.size} (stale)`
      : `${name} ${v.state}`;

/**
 * Text: state, delivery and the next step first, then PR rows, blockers and discussion. Whole
 * rows only; a cut says "Truncated due to maximum size" with the JSON command.
 */
export function ticketStatusText(r: TicketStatus, maxChars = 10_000): string {
  const d = r.delivery;
  const first = r.nextSteps[0];
  const head = [
    `#${r.number} ${r.title} ${r.url}`,
    `${r.state} (${r.closure}) · delivery ${d.verdict} (records ${d.records}) · ${r.completeness.complete ? "evidence complete" : "EVIDENCE INCOMPLETE"}`,
    `Next: ${first.kind} — ${first.why}${first.command ? ` (${first.command})` : ""}`,
  ];
  // Actionable rows first (PRs, follow-ups, blockers, gaps), then optional detail.
  const actionable: string[] = [];
  const optional: string[] = [];
  const read = r.pullRequests.filter((p) => p.detail === "read").length;
  if (r.pullRequests.length) {
    actionable.push(
      `Pull requests (${read} of ${r.pullRequests.length} read, required first; limit ${r.coverage.limitPullRequests}):`,
    );
    actionable.push(...r.pullRequests.map(prLine));
  } else
    actionable.push(
      `Pull requests: none found within the inspected sources (${r.coverage.linkage.complete ? "delivery records and closing references" : "closing references incomplete"}); not proof that none exists — ${r.links.intake}`,
    );
  for (const m of d.deliverables.filter((x) => !memberLabel.test(x.deliverable)))
    actionable.push(
      `  deliverable ${m.deliverable} → ${m.target}: ${m.state}; follow-up ${m.followUp}`,
    );
  for (const s of r.nextSteps.slice(1))
    actionable.push(`  then ${s.kind}: ${s.why}${s.command ? ` (${s.command})` : ""}`);
  if (!r.dependencies.known) actionable.push("Dependencies: unknown (native edges not read)");
  else {
    const open = r.dependencies.blockedBy.filter((b) => b.state === "OPEN");
    if (open.length)
      actionable.push(
        `Blocked by: ${open.map((b) => `${b.repository}#${b.number} ${b.title}`).join("; ")}`,
      );
  }
  for (const w of r.completeness.warnings.slice(0, 5)) actionable.push(`INCOMPLETE: ${w}`);
  if (r.completeness.warnings.length > 5)
    actionable.push(`INCOMPLETE: ${r.completeness.warnings.length - 5} more; use --json`);

  const o = r.ownership;
  optional.push(
    `Owner: ${o.answer}; ticket responsible ${o.responsibilityKnown ? (o.ticketResponsible ?? "nobody") : "unknown"}`,
  );
  const a = r.assessments;
  if (a.impact.state !== "unassessed" || a.complexity.state !== "unassessed")
    optional.push(`${metric("Impact", a.impact)} · ${metric("complexity", a.complexity)}`);
  for (const b of d.because.slice(0, 2)) optional.push(`  delivery: ${b}`);
  if (r.dependencies.known) {
    const deps = r.dependencies.blocking.filter((b) => b.state === "OPEN");
    if (deps.length) optional.push(`Blocking: ${deps.map((b) => `#${b.number}`).join(", ")}`);
  }
  if (r.discussion.records.length)
    optional.push(
      `Records: ${r.discussion.records.map((x) => `${x.kind} ${x.at ?? "?"} ${x.url}`).join("; ")}`,
    );
  if (r.discussion.excerpts.length) {
    optional.push(
      `Latest discussion (excerpts, ${r.discussion.excerpts.length} of ${r.discussion.totalComments} comments, authors unverified):`,
    );
    for (const x of r.discussion.excerpts)
      optional.push(`  ${x.author} ${x.at ?? "?"}: ${x.excerpt.slice(0, 160)} ${x.url}`);
  }
  const t = r.collection.telemetry;
  optional.push(
    `Observed live at ${r.freshness.requestedAt} · ${t.requests} requests, cost ${t.cost ?? `≥${t.knownCost} (some unknown)`} · full intake: ${r.links.intake}`,
  );
  return fitText(
    [...head, ...actionable, ...optional],
    maxChars,
    `pdb ticket ${r.number} --json --repo ${r.repository}`,
  );
}

/**
 * Whole lines in priority order within `maxChars`, counting every character including the
 * header, newlines and the notice (#379): never more than the limit, never a refusal. A cut
 * ends with the longest notice that fits: "Truncated due to maximum size." with the detail
 * command, then without it, then "[truncated]", then "…".
 */
export function fitText(lines: string[], maxChars: number, detail: string): string {
  const all = `${lines.join("\n")}\n`;
  if (all.length <= maxChars) return all;
  const notices = [
    `Truncated due to maximum size. Full detail: ${detail}`,
    "Truncated due to maximum size.",
    "[truncated]",
    "…",
  ];
  const notice = notices.find((n) => n.length + 1 <= maxChars);
  if (!notice) return "…".slice(0, maxChars);
  const out: string[] = [];
  let size = notice.length + 1;
  for (const line of lines) {
    // Whole lines in priority order: stop at the first that does not fit.
    if (size + line.length + 1 > maxChars) break;
    out.push(line);
    size += line.length + 1;
  }
  return `${[...out, notice].join("\n")}\n`;
}
