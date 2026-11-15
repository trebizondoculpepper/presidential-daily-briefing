/**
 * Direct dependency impact for a routine `deps N` (#196). Contract: doc/design/collection-profiles.md,
 * "Direct unlock evidence: #196", and doc/issue-dependencies.md.
 *
 * Pure: it reads only the evidence a `dependency-direct-v1` read attached to the report and
 * reuses the shared pickup gates and the one impact definition (`immediateUnlocks`, #208). It
 * never walks transitively, never treats unread evidence as zero, and does not reorder work:
 * the finish-started-work rule (#182) and the blended queue keep deciding what comes first.
 */
import type {
  DependantFacts,
  DependencyInventory,
  DependencyReport,
} from "../github/dependencies.js";
import type { Issue, NativeNode } from "../github/types.js";
import {
  compareCreatedAt,
  compareImpact,
  immediateUnlocks,
  otherwiseEligible,
  pickupEligibility,
  pickupPolicy,
  rankPickup,
  urgencyBand,
} from "./ranking.js";
import type { Eligibility, PickupContext } from "./ranking.js";

/** One direct dependant, as the impact answer shows it. */
export interface ImpactDependant {
  number: number;
  url: string;
  title: string;
}
export interface DirectImpact {
  schemaVersion: 1;
  subject: ImpactDependant & {
    state: string;
    /** Can the selected ticket be picked up now, by the shared pickup gates. */
    startNow: Eligibility;
    openClosingPrs: number[];
  };
  /**
   * Dependants that become pickable as soon as the subject completes: it is their last open
   * native blocker and every other pickup gate passes. Ordered by urgency, then oldest. A proven
   * lower bound whenever `unknown` is not empty.
   */
  newlyPickable: ImpactDependant[];
  /** Why more dependants might become pickable; empty only when the count is complete. */
  unknown: string[];
  /** Open dependants that stay blocked after the subject completes: other blockers remain. */
  otherBlockersRemain: (ImpactDependant & { otherOpenBlockers: number })[];
  /** Open dependants it is the last blocker for that still fail another pickup gate. */
  lastBlockerNotPickable: (ImpactDependant & { reasons: string[] })[];
  /** Direct dependants already closed: completing the subject changes nothing for them. */
  closedDependants: number;
  /** Transitive reach is optional and was not computed by this read. */
  transitive: { computed: false; how: string };
  nextAction: string;
  policy: string;
}

const identity = (item: { number: number; url: string; title: string }): ImpactDependant => ({
  number: item.number,
  url: item.url,
  title: item.title,
});
const empty = <T>(nodes: T[] = [], more = false) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: null },
});
/** A dependant as an Issue for the shared gates; its own dependants were not read. */
const dependantIssue = (facts: DependantFacts): Issue => ({
  number: facts.number,
  title: facts.title,
  body: "",
  url: facts.url,
  state: facts.state,
  stateReason: facts.stateReason ?? null,
  createdAt: facts.createdAt,
  updatedAt: facts.createdAt,
  labels: facts.labels,
  comments: empty(),
  closedByPullRequestsReferences: facts.closedByPullRequestsReferences,
  issueDependenciesSummary: facts.issueDependenciesSummary,
  // Only counts and identities are needed; these nodes carry no summaries of their own.
  blockedBy: empty(
    facts.blockedBy.nodes.map((n) => ({
      ...n,
      title: "",
      repository: facts.repository,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    })),
    facts.blockedBy.pageInfo.hasNextPage,
  ),
  // Not read: marked truncated so nothing downstream of a dependant is ever counted as zero.
  blocking: empty([], facts.issueDependenciesSummary.totalBlocking > 0),
});

const finishFirst =
  "Finish-first (#182) still decides order: your own PR follow-up and claimed work come before new pickup; the briefing ranks across tickets.";
const transitiveHow =
  "Not computed. Routine questions use direct edges; `deps N --tree` is the explicit, bounded and expensive diagnosis.";

/** The direct impact of completing the report's selected ticket; null without direct evidence. */
/**
 * Why the pickup gates cannot decide an issue from this read, or null: labels beyond the first
 * page (a ready or blocking label may be unseen), or a native blocker closed as not planned
 * (inspect or decide, as the briefing's dependency-not-planned check says), or a blocker list
 * too long to rule that out.
 */
export function undecidable(
  labels: Issue["labels"],
  blockers: { stateReason?: string | null }[],
  blockersTruncated: boolean,
): string | null {
  if (labels.pageInfo.hasNextPage)
    return "labels beyond the first 100 not read; readiness and blocking labels unknown";
  if (blockers.some((b) => b.stateReason === "NOT_PLANNED"))
    return "a native blocker was closed as not planned; a person should verify the dependency before pickup";
  if (blockersTruncated)
    return "blocker list truncated; a blocker closed as not planned may be unseen";
  return null;
}
/** ` --repo owner/name`, so every suggested command keeps its repository context. */
const repoFlag = (repository: string): string => ` --repo ${repository}`;
const repositoryOf = (url: string, fallback: string): string =>
  /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(url)?.[1] ?? fallback;

/**
 * The briefing's claim template, `commandTemplates.claim` in rules/datalog/commands.ts. Kept as
 * a copy because importing that module here splits the lazily loaded evaluator chunk in the
 * package; a test pins the two equal.
 */
export const claimTemplate = "pdb claim {number} --repo {repo} --agent {agent}{platformFlag}";
/** The briefing's claim command, filled the same way (agent NAME when not given). */
export function claimCommand(
  number: number,
  repository: string,
  agent?: string,
  platform?: string,
): string {
  const facts: Record<string, string> = {
    repo: repository,
    number: String(number),
    agent: agent ?? "NAME",
    // As the briefing's adapter: the viewer's stated platform is always carried into the claim.
    platformFlag: platform ? ` --platform ${platform}` : "",
  };
  return claimTemplate.replace(/\{(\w+)\}/g, (_, k: string) => facts[k] ?? "");
}

export function directImpact(
  report: DependencyReport,
  context: PickupContext = { prs: [] },
  agent?: string,
): DirectImpact | null {
  const direct = report.direct;
  const node = report.nodes[0];
  if (!direct || !node || !node.summary) return null;
  const subjectIssue: Issue = {
    number: node.number,
    title: node.title,
    body: "",
    url: node.url,
    state: direct.subject.state,
    stateReason: direct.subject.stateReason,
    createdAt: direct.subject.createdAt ?? "",
    updatedAt: "",
    labels: direct.subject.labels,
    comments: empty(),
    ...(direct.subject.closedByPullRequestsReferences
      ? { closedByPullRequestsReferences: direct.subject.closedByPullRequestsReferences }
      : {}),
    issueDependenciesSummary: node.summary,
    blockedBy: empty(node.upstream),
    // The diagnostic-only `lastOpenBlocker` flag stays out of the shared impact input.
    blocking: empty(
      node.downstream.map((d) => {
        const copy: Partial<typeof d> = { ...d };
        delete copy.lastOpenBlocker;
        return copy as NativeNode;
      }),
    ),
  };
  // A dependant the gates cannot decide is unknown impact, never a proven unlock or a "no".
  const undecided = new Map<string, string>();
  const dependants = direct.dependants
    .filter((facts) => {
      const why = undecidable(
        facts.labels,
        facts.blockedBy.nodes,
        facts.blockedBy.pageInfo.hasNextPage,
      );
      if (why) undecided.set(facts.url, why);
      return !why;
    })
    .map(dependantIssue);
  const byUrl = new Map([subjectIssue, ...dependants].map((issue) => [issue.url, issue]));
  const notRead = new Map([
    ...direct.notRead.map((n): [string, string] => [n.url, `not read (${n.reason})`]),
    ...[...undecided].map(([url, why]): [string, string] => [url, `pickup unknown (${why})`]),
  ]);
  const impact = immediateUnlocks(subjectIssue, byUrl, context);
  // Name why an unread dependant is unknown, rather than "not in this snapshot".
  const unknown = impact.unknown.map((reason) => {
    const url = [...notRead.keys()].find((u) => {
      const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(u);
      return !!m && reason === `dependant ${m[1]}#${m[2]} not in this snapshot`;
    });
    return url ? `dependant ${url} ${notRead.get(url)}` : reason;
  });
  let startNow = pickupEligibility(subjectIssue, context);
  // A read that did not return the subject's closing-PR list cannot prove it has none.
  if (!direct.subject.closedByPullRequestsReferences && startNow.status === "eligible")
    startNow = { status: "unknown", reasons: ["open closing PRs not read"] };
  // Truncated labels or a not-planned blocker: never recommend pickup on this evidence.
  const subjectWhy = undecidable(subjectIssue.labels, node.upstream, false);
  if (subjectWhy && startNow.status === "eligible")
    startNow = { status: "unknown", reasons: [subjectWhy] };
  else if (subjectWhy && startNow.status === "unknown")
    startNow = { status: "unknown", reasons: [...startNow.reasons, subjectWhy] };
  const unlocked = new Set(impact.unlocks.map((d) => d.url));
  const newlyPickable = [...impact.unlocks]
    .sort(
      (a, b) =>
        urgencyBand(a) - urgencyBand(b) ||
        compareCreatedAt(a.createdAt, b.createdAt) ||
        a.number - b.number,
    )
    .map(identity);
  const open = subjectIssue.state === "OPEN";
  const otherBlockersRemain = node.downstream
    .filter((d) => d.state === "OPEN" && (d.issueDependenciesSummary?.blockedBy ?? 0) > 1)
    .map((d) => ({
      ...identity(d),
      otherOpenBlockers: d.issueDependenciesSummary.blockedBy - (open ? 1 : 0),
    }));
  const lastBlockerNotPickable = dependants.flatMap((d) => {
    if (unlocked.has(d.url) || d.state !== "OPEN") return [];
    const gate = otherwiseEligible(d, context);
    return gate.status === "ineligible" ? [{ ...identity(d), reasons: gate.reasons }] : [];
  });
  const openClosingPrs = (direct.subject.closedByPullRequestsReferences?.nodes ?? [])
    .filter((pr) => pr.state === "OPEN")
    .map((pr) => pr.number);
  const result: DirectImpact = {
    schemaVersion: 1,
    subject: { ...identity(node), state: subjectIssue.state, startNow, openClosingPrs },
    newlyPickable,
    unknown,
    otherBlockersRemain,
    lastBlockerNotPickable,
    closedDependants: node.downstream.filter((d) => d.state !== "OPEN").length,
    transitive: { computed: false, how: transitiveHow },
    nextAction: "",
    policy: finishFirst,
  };
  result.nextAction = nextAction(
    result,
    subjectIssue,
    node.upstream,
    report.repository,
    agent,
    context.platform,
  );
  return result;
}

const list = (items: { number: number }[]): string => items.map((i) => `#${i.number}`).join(", ");
function unlockClause(impact: DirectImpact): string {
  const count = impact.newlyPickable.length;
  if (count)
    return `completing it makes ${impact.unknown.length ? "at least " : ""}${count} dependant(s) pickable immediately: ${list(impact.newlyPickable)}`;
  return impact.unknown.length
    ? "no dependant is proven to become pickable when it completes, but that is unknown, not zero"
    : "no dependant becomes pickable when it completes";
}

function nextAction(
  impact: DirectImpact,
  subject: Issue,
  upstream: {
    number: number;
    url: string;
    state: string;
    stateReason?: string | null;
    repository?: { nameWithOwner: string };
  }[],
  repository: string,
  agent?: string,
  platform?: string,
): string {
  const n = `#${subject.number}`;
  const here = repositoryOf(subject.url, repository);
  if (subject.state !== "OPEN")
    return `${n} is closed${subject.stateReason ? ` (${subject.stateReason.toLowerCase().replace("_", " ")})` : ""}; nothing to start.${subject.stateReason === "NOT_PLANNED" ? " Its dependants still list it as a blocker that GitHub counts as closed: a person should check whether those dependencies still make sense." : ""}`;
  const unlocks = unlockClause(impact);
  const { startNow, openClosingPrs } = impact.subject;
  // A not-planned blocker comes first: inspect or decide, never pick up (as the briefing).
  if (
    upstream.some((b) => b.stateReason === "NOT_PLANNED") &&
    !upstream.some((b) => b.state === "OPEN")
  )
    return `A blocker of ${n} was closed as not planned; a person should verify whether the dependency still makes sense before anyone picks it up (pdb ticket ${subject.number}${repoFlag(here)}). When it completes, ${unlocks}.`;
  if (startNow.status === "eligible")
    return `Start ${n}: claim it (${claimCommand(subject.number, here, agent, platform)}) and implement it; ${unlocks}.`;
  if (openClosingPrs.length)
    return `Advance open PR ${openClosingPrs.map((p) => `#${p}`).join(", ")} for ${n} toward merge (PR follow-up, not new pickup); ${n} completes when its whole delivery merges, not at a first PR merge. Then ${unlocks}.`;
  const owners = subject.labels.nodes
    .map((l) => l.name)
    .filter((l) => l.startsWith(pickupPolicy.ownerPrefix));
  if (owners.length)
    return `${n} is claimed (${owners.join(", ")}); do not pick it up. When it completes, ${unlocks}.`;
  const blockers = upstream.filter((b) => b.state === "OPEN");
  if (blockers.length)
    return `${n} is blocked by ${list(blockers)}; start there (pdb deps ${blockers[0].number}${repoFlag(blockers[0].repository?.nameWithOwner ?? repositoryOf(blockers[0].url, here))}). When ${n} completes, ${unlocks}.`;
  if (startNow.status === "unknown")
    return `Inspect ${n} before acting (pdb ticket ${subject.number}${repoFlag(here)}): ${startNow.reasons.join("; ")}. When it completes, ${unlocks}.`;
  return `${n} is not pickable: ${startNow.reasons.join("; ")}. When it completes, ${unlocks}.`;
}

/** Text lines for the impact section of `deps N`. */
export function directImpactText(impact: DirectImpact | null): string[] {
  if (!impact) return [];
  const row = (d: ImpactDependant) => `  #${d.number} ${d.title} ${d.url}`;
  const lines = [
    "",
    `Next action: ${impact.nextAction}`,
    `Start now: ${impact.subject.startNow.status}${impact.subject.startNow.reasons.length ? ` (${impact.subject.startNow.reasons.join("; ")})` : ""}`,
    `Becomes pickable when #${impact.subject.number} completes (${impact.unknown.length ? "at least " : ""}${impact.newlyPickable.length}; urgency, then oldest):`,
    ...(impact.newlyPickable.length ? impact.newlyPickable.map(row) : ["  none proven"]),
    ...impact.unknown.map((u) => `  Unknown: ${u}`),
  ];
  if (impact.otherBlockersRemain.length)
    lines.push(
      "Still blocked after it completes (other blockers remain):",
      ...impact.otherBlockersRemain.map(
        (d) => `${row(d)} — ${d.otherOpenBlockers} other open blocker(s)`,
      ),
    );
  if (impact.lastBlockerNotPickable.length)
    lines.push(
      "Unblocked by it but not pickable:",
      ...impact.lastBlockerNotPickable.map((d) => `${row(d)} — ${d.reasons.join("; ")}`),
    );
  if (impact.closedDependants)
    lines.push(`Closed dependants (no change): ${impact.closedDependants}`);
  lines.push(`Transitive reach: ${impact.transitive.how}`, impact.policy);
  return lines;
}

/** One ranked entry of a repository-wide direct-impact answer. */
export interface RankedImpact extends ImpactDependant {
  /** Dependants that become pickable as soon as this completes (proven lower bound). */
  unlocks: number[];
  /** Why more might; empty when the count is complete. */
  unknown: string[];
}
/** `deps --top`: what can start now and which completion unlocks the most (#196). */
export interface RepositoryImpact {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  /** True when the inventory was partial: the lists rank only what was read. */
  provisional: boolean;
  provisionalReasons: string[];
  limit: number;
  /** Pickable now, in the shared impact order (urgency, unlocks, incomplete, oldest). */
  startNow: (RankedImpact & { urgency: string })[];
  startNowTotal: number;
  /** Open work not pickable now, ordered by the unlocks its completion proves. */
  completionUnlocks: (RankedImpact & { notPickable: string[] })[];
  completionUnlocksTotal: number;
  /** Open issues the pickup gates cannot decide from this read; never offered for pickup. */
  undecided: (ImpactDependant & { reason: string })[];
  undecidedTotal: number;
  nextAction: string;
  policy: string;
  transitive: { computed: false; how: string };
  collection: DependencyInventory["collection"];
}

/** Rank an open-issue inventory by direct impact only, reusing the shared pickup ranking. */
export function repositoryImpact(
  inventory: DependencyInventory,
  limit = 10,
  context: PickupContext = { prs: [] },
  agent?: string,
): RepositoryImpact {
  // Issues the gates cannot decide from this read (truncated labels or blockers, or a blocker
  // closed as not planned) are neither offered for pickup nor counted as proven unlocks.
  const undecidedReason = new Map<string, string>();
  for (const issue of inventory.issues) {
    const why = undecidable(
      issue.labels,
      issue.blockedBy?.nodes ?? [],
      !!issue.blockedBy?.pageInfo.hasNextPage,
    );
    if (why)
      undecidedReason.set(`${repositoryOf(issue.url, inventory.repository)}#${issue.number}`, why);
  }
  const issues = inventory.issues.filter(
    (issue) =>
      !undecidedReason.has(`${repositoryOf(issue.url, inventory.repository)}#${issue.number}`),
  );
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const missing = inventory.complete ? undefined : "dependant not in the partial inventory read";
  const unknownOf = (reasons: string[]) =>
    reasons.map((r) => {
      const m = /^dependant (\S+#\d+) not in this snapshot$/.exec(r);
      const why = m && undecidedReason.get(m[1]);
      if (why) return `dependant ${m[1]} pickup unknown (${why})`;
      return missing ? r.replace("not in this snapshot", missing) : r;
    });
  const ranked = rankPickup(issues, { ...context, order: "impact" });
  const startNow = ranked.slice(0, limit).map((r) => ({
    ...identity(r.issue),
    unlocks: r.unlocks,
    unknown: unknownOf(r.unlocksUnknown),
    urgency: r.urgency,
  }));
  const eligible = new Set(ranked.map((r) => r.issue.url));
  const keyOf = (issue: Issue) =>
    `${repositoryOf(issue.url, inventory.repository)}#${issue.number}`;
  // Only decided issues (complete labels and blockers) reach the gates; an issue whose shared
  // pickup gate is unknown (platform without --platform, unproven closing PRs) is undecided too.
  const gated = issues
    .filter((issue) => !eligible.has(issue.url))
    .map((issue) => ({ issue, gate: pickupEligibility(issue, context) }));
  for (const { issue, gate } of gated)
    if (gate.status === "unknown") undecidedReason.set(keyOf(issue), gate.reasons.join("; "));
  const blocked = gated
    .filter(({ gate }) => gate.status === "ineligible")
    .map(({ issue, gate }) => ({ issue, gate, impact: immediateUnlocks(issue, byUrl, context) }))
    .filter(({ impact }) => impact.unlocks.length || impact.unknown.length)
    .sort(
      (a, b) =>
        compareImpact(a.impact, b.impact) ||
        urgencyBand(a.issue) - urgencyBand(b.issue) ||
        compareCreatedAt(a.issue.createdAt, b.issue.createdAt) ||
        a.issue.number - b.issue.number,
    );
  const completionUnlocks = blocked.slice(0, limit).map(({ issue, impact, gate }) => ({
    ...identity(issue),
    unlocks: impact.unlocks.map((d) => d.number),
    unknown: unknownOf(impact.unknown),
    notPickable: gate.reasons,
  }));
  const undecidedAll = inventory.issues
    .filter((issue) => undecidedReason.has(keyOf(issue)))
    .map((issue) => ({ ...identity(issue), reason: undecidedReason.get(keyOf(issue))! }));
  const undecided = undecidedAll;
  const provisionalReasons = inventory.complete
    ? []
    : [
        `open-issue inventory partial (${inventory.stoppedBy === "quota" ? "stopped after a GitHub quota refusal" : "page cap reached"}): read ${issues.length}${inventory.totalOpen === null ? "" : ` of ${inventory.totalOpen}`} open issues; unread work may rank higher`,
      ];
  const count = (r: RankedImpact) =>
    `${r.unknown.length ? "at least " : ""}${r.unlocks.length}${r.unlocks.length ? ` (${r.unlocks.map((n) => `#${n}`).join(", ")})` : ""}`;
  const top = startNow[0];
  const most = completionUnlocks[0];
  const nextAction = top
    ? `Start #${top.number}: claim it (${claimCommand(top.number, inventory.repository, agent, context.platform)}) and implement it; completing it makes ${count(top)} dependant(s) pickable. Check it first with pdb deps ${top.number}${repoFlag(inventory.repository)}.`
    : most
      ? `Nothing is pickable now. #${most.number} unlocks the most when it completes (${count(most)}); it is not pickable because ${most.notPickable.join("; ")}.`
      : "Nothing is pickable now and no open completion is proven to unlock other work.";
  return {
    schemaVersion: 1,
    repository: inventory.repository,
    startedAt: inventory.startedAt,
    fetchedAt: inventory.fetchedAt,
    provisional: !inventory.complete,
    provisionalReasons,
    limit,
    startNow,
    startNowTotal: ranked.length,
    completionUnlocks,
    completionUnlocksTotal: blocked.length,
    undecided: undecided.slice(0, limit),
    undecidedTotal: undecided.length,
    nextAction: `${inventory.complete ? "" : "Provisional: "}${nextAction}`,
    policy: finishFirst,
    transitive: { computed: false, how: transitiveHow },
    collection: inventory.collection,
  };
}

/** Text for `deps --top`. */
export function repositoryImpactText(impact: RepositoryImpact): string {
  const unlockText = (r: RankedImpact) =>
    `unlocks ${r.unknown.length ? "at least " : ""}${r.unlocks.length}${r.unlocks.length ? ` (${r.unlocks.map((n) => `#${n}`).join(", ")})` : ""}${r.unknown.length ? `; unknown: ${r.unknown.join("; ")}` : ""}`;
  const t = impact.collection.telemetry;
  return (
    [
      `Direct dependency impact: ${impact.repository}`,
      `LIVE ${impact.startedAt}–${impact.fetchedAt}`,
      ...impact.provisionalReasons.map((r) => `PROVISIONAL: ${r}`),
      `Next action: ${impact.nextAction}`,
      "",
      `Can start now (${Math.min(impact.limit, impact.startNowTotal)} of ${impact.startNowTotal}; urgency, unlocks, incomplete, oldest):`,
      ...(impact.startNow.length
        ? impact.startNow.map(
            (r, i) => `${i + 1}. #${r.number} ${r.title} — ${unlockText(r)}; urgency ${r.urgency}`,
          )
        : ["  none"]),
      "",
      `Completion that unlocks the most, not pickable now (${Math.min(impact.limit, impact.completionUnlocksTotal)} of ${impact.completionUnlocksTotal}):`,
      ...(impact.completionUnlocks.length
        ? impact.completionUnlocks.map(
            (r, i) =>
              `${i + 1}. #${r.number} ${r.title} — ${unlockText(r)}; not pickable: ${r.notPickable.join("; ")}`,
          )
        : ["  none"]),
      ...(impact.undecided.length
        ? [
            "",
            `Undecided, inspect before pickup (${impact.undecided.length} of ${impact.undecidedTotal}):`,
            ...impact.undecided.map((r) => `  #${r.number} ${r.title} — ${r.reason}`),
          ]
        : []),
      "",
      `Transitive reach: ${impact.transitive.how}`,
      impact.policy,
      `Read cost: ${t.requests} request(s), ${t.bytes} bytes returned, GraphQL cost ${t.cost ?? `unknown (at least ${t.knownCost})`}, ${t.durationMs} ms.`,
    ].join("\n") + "\n"
  );
}
