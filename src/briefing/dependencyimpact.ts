/**
 * Direct dependency impact for a routine `deps N` (#196). Contract: doc/design/collection-profiles.md,
 * "Direct unlock evidence: #196", and doc/issue-dependencies.md.
 *
 * Pure: it reads only the evidence a `dependency-direct-v1` read attached to the report and
 * reuses the shared pickup gates and the one impact definition (`immediateUnlocks`, #208). It
 * never walks transitively, never treats unread evidence as zero, and does not reorder work:
 * the finish-started-work rule (#182) and the blended queue keep deciding what comes first.
 */
import type { DependantFacts, DependencyReport } from "../github/dependencies.js";
import type { Issue, NativeNode } from "../github/types.js";
import {
  compareCreatedAt,
  immediateUnlocks,
  otherwiseEligible,
  pickupEligibility,
  pickupPolicy,
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
export function directImpact(
  report: DependencyReport,
  context: PickupContext = { prs: [] },
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
  const dependants = direct.dependants.map(dependantIssue);
  const byUrl = new Map([subjectIssue, ...dependants].map((issue) => [issue.url, issue]));
  const notRead = new Map(direct.notRead.map((n) => [n.url, n.reason]));
  const impact = immediateUnlocks(subjectIssue, byUrl, context);
  // Name why an unread dependant is unknown, rather than "not in this snapshot".
  const unknown = impact.unknown.map((reason) => {
    const url = [...notRead.keys()].find((u) => {
      const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(u);
      return !!m && reason === `dependant ${m[1]}#${m[2]} not in this snapshot`;
    });
    return url ? `dependant ${url} not read (${notRead.get(url)})` : reason;
  });
  let startNow = pickupEligibility(subjectIssue, context);
  // A read that did not return the subject's closing-PR list cannot prove it has none.
  if (!direct.subject.closedByPullRequestsReferences && startNow.status === "eligible")
    startNow = { status: "unknown", reasons: ["open closing PRs not read"] };
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
  result.nextAction = nextAction(result, subjectIssue, node.upstream);
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
  upstream: { number: number; state: string; stateReason?: string | null }[],
): string {
  const n = `#${subject.number}`;
  if (subject.state !== "OPEN")
    return `${n} is closed${subject.stateReason ? ` (${subject.stateReason.toLowerCase().replace("_", " ")})` : ""}; nothing to start.${subject.stateReason === "NOT_PLANNED" ? " Its dependants still list it as a blocker that GitHub counts as closed: a person should check whether those dependencies still make sense." : ""}`;
  const unlocks = unlockClause(impact);
  const { startNow, openClosingPrs } = impact.subject;
  if (startNow.status === "eligible")
    return `Start ${n}: claim it (pdb claim ${subject.number}) and implement it; ${unlocks}.`;
  if (openClosingPrs.length)
    return `Advance open PR ${openClosingPrs.map((p) => `#${p}`).join(", ")} for ${n} toward merge (PR follow-up, not new pickup); ${n} completes when its whole delivery merges, not at a first PR merge. Then ${unlocks}.`;
  const owners = subject.labels.nodes
    .map((l) => l.name)
    .filter((l) => l.startsWith(pickupPolicy.ownerPrefix));
  if (owners.length)
    return `${n} is claimed (${owners.join(", ")}); do not pick it up. When it completes, ${unlocks}.`;
  const blockers = upstream.filter((b) => b.state === "OPEN");
  if (blockers.length)
    return `${n} is blocked by ${list(blockers)}; start there (pdb deps ${blockers[0].number}). When ${n} completes, ${unlocks}.`;
  if (upstream.some((b) => b.stateReason === "NOT_PLANNED"))
    return `A blocker of ${n} was closed as not planned; a person should inspect before anyone picks it up.`;
  if (startNow.status === "unknown")
    return `Inspect ${n} before acting (pdb ticket ${subject.number}): ${startNow.reasons.join("; ")}. When it completes, ${unlocks}.`;
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
