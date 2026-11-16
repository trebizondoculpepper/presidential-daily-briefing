import { requiredCheckEvidence } from "../../github/requiredchecks.js";
/**
 * Host adapter for the rules engine (doc/design/rules-component.md, "Component boundary").
 * Turns a collected Snapshot, assessments and viewer options into engine facts, runs the engine
 * and projects its decisions onto the shared RankedActions shape with command text. Policy
 * decisions all come from engine.ts; nothing here chooses, orders or explains an action.
 */
import type { Datom, Value } from "datascript";
import type { Snapshot, Issue, PullRequest } from "../../github/types.js";
import type { SubjectAssessments } from "../../briefing/assessments.js";
import type {
  RankedAction,
  RankedActions,
  BlendedRole,
  ActionKind,
  Band,
} from "../../briefing/blended.js";
import type { PickupOrder } from "../../briefing/ranking.js";
import { commandTemplates, commandKinds } from "./commands.js";
import {
  evaluatePolicy,
  DatalogError,
  rulesHash,
  policyVersion,
  maxDatoms,
  maxSubjects,
  firstSubjectId,
} from "./engine.js";

export { DatalogError, rulesHash, policyVersion, compareKeys } from "./engine.js";

/**
 * One needs-human question record as a fact (doc/design/human-briefing.md, #457): its trust and
 * routing only. The host reads and trusts the comment; the policy decides what it means.
 */
export interface QuestionRecordFact {
  trust: "trusted" | "unverified";
  /** The record's `Designer:` routing name; "" when it could not be read. */
  to: string;
  /**
   * Closed sources only (#414): the marker version and the explicit resolve/withdraw outcome
   * the host folded; `unknown` when unverifiable records or unread history leave it open.
   */
  version?: 1 | 2;
  outcome?: "none" | "resolved" | "withdrawn" | "unknown";
}
export interface DatalogOptions {
  /** `human` is the human briefing role (#457); its decisions are not agent actions. */
  role: BlendedRole | "human";
  /** Human role only: question records per issue URL. Absent for the agent roles. */
  questionRecords?: ReadonlyMap<string, readonly QuestionRecordFact[]>;
  agent?: string;
  platform?: string;
  order?: PickupOrder;
  /**
   * Trusted delivery responsibility per deliverable URL (#190 records, read by #182). Additive to
   * `agent:` linkage; a deliverable absent here has no proven responsibility, never "nobody".
   */
  responsible?: ReadonlyMap<string, readonly string[]>;
  /** Issues whose delivery records could not be folded; reported, never treated as absence. */
  responsibilityUnknown?: readonly string[];
  /**
   * Declared review coverage (#301): `legacy` (default, the pre-#301 rule), `any` (either
   * configured provider) or `unknown` (nothing is accepted). The host resolves configuration.
   */
  reviewCoverage?: "legacy" | "any" | "unknown";
  /**
   * Normalized provider review states per PR URL, authenticated and head-bound by the host
   * (workflow/reviewpolicy.ts) so raw provenance checks stay outside the pure engine.
   */
  providerReviews?: ReadonlyMap<
    string,
    readonly { provider: string; state: string; commit: string }[]
  >;
  /**
   * Required-check classification per PR URL (#343), computed by the host's shared classifier
   * (github/requiredchecks.ts) so this lazily loaded chunk does not import it. Absent: every
   * pending check's requiredness is unknown, which keeps the PR waiting (never advisory).
   */
  checkRequiredness?: ReadonlyMap<
    string,
    {
      readonly advisoryPending: readonly string[];
      readonly missingRequired: readonly string[];
      readonly evidence?: import("./check-types.js").CheckEvidence;
    }
  >;
  /**
   * Retained claims (#413): each of the viewer's own claims' activity per issue URL, read by the
   * host with the claim guard's verified reader (workflow/retained.ts). Absent: not read, so the
   * ordinary continuation applies (a legacy claim counts as active).
   */
  claimActivity?: ReadonlyMap<
    string,
    { state: "active" | "waiting" | "resume-required" | "unknown" | "not-owned"; reason: string }
  >;
  /**
   * The viewer's open implementation claims in this repository, oldest first, and whether that
   * inventory is complete. Submitted PR responsibility is not a claim. Absent: not read.
   */
  ownedClaims?: { urls: readonly string[]; complete: boolean };
  limit: number;
  signal?: AbortSignal;
  now?: () => number;
}
export interface Explanation {
  text: string;
  ruleIds: string[];
  facts: Record<string, Value>;
  overriddenRuleIds: string[];
}
export interface DatalogAction extends RankedAction {
  ruleIds: string[];
  why: Explanation;
}
export interface DatalogResult extends RankedActions {
  items: DatalogAction[];
  decisionEngine: {
    requested: "datalog";
    used: "datalog";
    policyVersion: number;
    rulesHash: string;
    coverage: { subjects: number; datoms: number };
    diagnostics: string[];
    denials: { target: string; ruleId: string }[];
  };
}
/**
 * Codex review-state markers as raw facts. Kept local, not imported, so the lazily loaded
 * evaluator stays one self-contained chunk; reviewevidence.ts holds the TypeScript-engine twin
 * and the tests assert both engines agree.
 */
const codexAccount = "chatgpt-codex-connector";
function codexState(
  body: string,
): { status?: unknown; commit_sha?: unknown; has_unresolved_findings?: unknown } | null {
  const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(body);
  try {
    const parsed: unknown = m ? JSON.parse(m[1]) : null;
    const review =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { code_review?: unknown }).code_review
        : null;
    return typeof review === "object" && review !== null ? review : null;
  } catch {
    return null;
  }
}
const emptyMetric = { state: "unknown" as const, size: null, provenance: null };
const subjectsOf = (s: Snapshot) => [...s.issues, ...s.pullRequests];
function normalize(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, SubjectAssessments>,
  options: DatalogOptions,
): { facts: Datom[]; ids: Map<string, number>; objects: Map<number, Issue | PullRequest> } {
  const objects = new Map(subjectsOf(snapshot).map((s, i) => [i + firstSubjectId, s]));
  const ids = new Map([...objects].map(([id, s]) => [s.url, id]));
  let nextId = objects.size + firstSubjectId;
  const facts: Datom[] = [];
  // Bounds memory while collecting; the engine applies the exact limit to the whole database.
  const put = (id: number, key: string, value: Value) => {
    if (facts.length >= maxDatoms)
      throw new DatalogError(
        "experimental-scope-exceeded",
        `at most ${maxDatoms} datoms are supported`,
      );
    return facts.push([id, key, value]);
  };
  put(
    1,
    "forward-complete",
    snapshot.pullRequests
      .filter((p) => p.state === "OPEN")
      .every((p) => !p.closingIssuesReferences.pageInfo.hasNextPage),
  );
  // Absent is legacy (rules.edn legacy-coverage), keeping legacy inputs exactly as before #301.
  if (options.reviewCoverage && options.reviewCoverage !== "legacy")
    put(1, "review-coverage", options.reviewCoverage);
  // #413: the viewer's retained claims; absent means the inventory was not read.
  if (options.ownedClaims) {
    // Entity 1 is the existing viewer/context entity, not a GitHub ticket or a claim.
    put(1, "ownership-inventory", true);
    put(1, "number", 0);
    put(1, "target", `https://github.com/${snapshot.repository}`);
    put(1, "owned-claims", options.ownedClaims.urls.length);
    put(1, "owned-claims-complete", options.ownedClaims.complete);
    const subject = options.ownedClaims.urls
      .map((url) => ids.get(url))
      .find((id) => id !== undefined);
    if (subject !== undefined) put(1, "owned-review-subject", subject);
  }
  for (const [id, s] of objects) {
    // A NaN sort key breaks the comparator's total order (#450): refuse, naming the subject.
    if (!Number.isFinite(Date.parse(s.createdAt)))
      throw new DatalogError(
        "invalid-facts",
        `${s.url} has createdAt ${JSON.stringify(s.createdAt)}, which is not a timestamp`,
      );
    const a = assessments.get(s.url);
    const pr = snapshot.pullRequests.find((p) => p.url === s.url) ?? null;
    for (const [k, v] of Object.entries({
      kind: pr ? "pr" : "issue",
      state: s.state,
      number: s.number,
      target: s.url,
      created: Date.parse(s.createdAt),
      "labels-complete": !s.labels.pageInfo.hasNextPage,
      "reverse-complete":
        !!s.closedByPullRequestsReferences &&
        !s.closedByPullRequestsReferences.pageInfo.hasNextPage,
      "native-complete":
        !!s.blockedBy &&
        !s.blockedBy.pageInfo.hasNextPage &&
        !!s.issueDependenciesSummary &&
        s.blockedBy.nodes.length === s.issueDependenciesSummary.totalBlockedBy,
      "open-blockers": s.issueDependenciesSummary?.blockedBy ?? -1,
      "blocking-complete": !!s.blocking && !s.blocking.pageInfo.hasNextPage,
      "impact-state": a?.impact.state ?? "unknown",
      "impact-size": a?.impact.size ?? "unknown",
      "complexity-state": a?.complexity.state ?? "unknown",
      "complexity-size": a?.complexity.size ?? "unknown",
      head: pr?.headRefOid ?? "not-a-pr",
    }))
      put(id, k, v);
    for (const { name } of s.labels.nodes) {
      put(id, "label", name);
      for (const prefix of ["agent:", "attention:", "platform:"])
        if (name.startsWith(prefix))
          put(id, prefix === "agent:" ? "owner" : prefix.slice(0, -1), name.slice(prefix.length));
    }
    for (const b of s.blockedBy?.nodes ?? []) {
      const linked = ids.get(b.url) ?? nextId++;
      put(id, "blocker", linked);
      if (!ids.has(b.url)) {
        put(linked, "state", b.state);
        put(linked, "target", b.url);
      }
    }
    for (const b of s.blocking?.nodes ?? []) {
      const linked = ids.get(b.url) ?? nextId++;
      put(id, "dependent", linked);
      if (!ids.has(b.url)) {
        put(linked, "state", b.state);
        put(linked, "target", b.url);
      }
    }
    for (const p of s.closedByPullRequestsReferences?.nodes ?? [])
      if (p.state === "OPEN") put(id, "closing", ids.get(p.url) ?? nextId++);
    for (const agent of options.responsible?.get(s.url) ?? []) put(id, "responsible", agent);
    const activity = options.claimActivity?.get(s.url);
    if (activity) {
      put(id, "claim-activity", activity.state);
      if (activity.reason) put(id, "wait-reason", activity.reason);
    }
    for (const record of options.questionRecords?.get(s.url) ?? []) {
      const r = nextId++;
      put(id, "question-record", r);
      put(r, "record-trust", record.trust);
      put(r, "record-to", record.to);
      if (record.version !== undefined) put(r, "record-version", record.version);
      if (record.outcome !== undefined) put(r, "record-outcome", record.outcome);
    }
    if (pr) {
      const rollup = pr.commits?.nodes?.[0]?.commit.statusCheckRollup;
      for (const [k, v] of Object.entries({
        draft: pr.isDraft,
        mergeable: pr.mergeable,
        "merge-state": pr.mergeStateStatus,
        "review-decision": pr.reviewDecision ?? "",
        // Warnings are `${url}: …`; the separator stops /pull/1 matching /pull/12 (#448).
        // Every source must be read in full (#497), mirroring github/previdence.ts, which this
        // lazily loaded chunk does not import; previdence.test.ts holds the two in agreement.
        "pr-complete":
          !snapshot.warnings.some((w) => w.startsWith(`${pr.url}:`)) &&
          rollup !== undefined &&
          [pr.comments, pr.reviews, pr.reviewThreads, ...(rollup ? [rollup.contexts] : [])].every(
            (c) => {
              const info: { hasNextPage?: boolean; hasPreviousPage?: boolean } | undefined =
                c?.pageInfo;
              return !!info && !info.hasNextPage && !info.hasPreviousPage;
            },
          ),
      }))
        put(id, k, v);
      for (const ref of pr.closingIssuesReferences.nodes) {
        const other = ids.get(ref.url);
        if (other !== undefined) put(id, "closes", other);
      }
      const requiredness = options.checkRequiredness?.get(pr.url);
      const checkEvidence = requiredness?.evidence ?? requiredCheckEvidence(pr);
      put(id, "required-evidence-complete", checkEvidence.complete);
      for (const gap of checkEvidence.gaps) put(id, "required-evidence-gap", gap);
      for (const [index, check] of (rollup?.contexts.nodes ?? []).entries()) {
        const c = nextId++;
        const checkName = check.name ?? check.context ?? "unnamed";
        put(id, "check", c);
        put(c, "name", checkName);
        put(c, "outcome", check.conclusion ?? check.state ?? check.status ?? "UNKNOWN");
        // #343: a pending check GitHub reports as not required for this PR does not make it wait.
        put(c, "required", checkEvidence.checks[index]?.required ?? "unknown");
      }
      for (const missing of checkEvidence.missing) put(id, "missing-required", missing);
      // Raw review evidence; the policy decides what binds to the current head (#182).
      for (const review of pr.reviews?.nodes ?? []) {
        const r = nextId++;
        put(id, "review", r);
        put(r, "review-state", review.state);
        if (review.commit?.oid) put(r, "review-commit", review.commit.oid);
      }
      for (const c of pr.comments?.nodes ?? []) {
        if ((c.author?.login ?? "").replace(/\[bot\]$/, "") !== codexAccount) continue;
        const state = codexState(c.body ?? "");
        if (!state) continue;
        const r = nextId++;
        put(id, "receipt", r);
        if (typeof state.commit_sha === "string") put(r, "receipt-commit", state.commit_sha);
        if (typeof state.status === "string") put(r, "receipt-status", state.status);
        if (typeof state.has_unresolved_findings === "boolean")
          put(r, "receipt-findings", state.has_unresolved_findings);
      }
      for (const review of options.providerReviews?.get(pr.url) ?? []) {
        const r = nextId++;
        put(id, "provider-review", r);
        put(r, "provider", review.provider);
        put(r, "provider-state", review.state);
        put(r, "provider-commit", review.commit);
      }
      for (const thread of pr.reviewThreads?.nodes ?? []) {
        const c = nextId++;
        put(id, "thread", c);
        put(c, "resolved", thread.isResolved);
      }
    }
  }
  return { facts, ids, objects };
}

export function evaluateDatalog(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, SubjectAssessments>,
  options: DatalogOptions,
): DatalogResult {
  options.signal?.throwIfAborted();
  const clock = options.now ?? performance.now.bind(performance),
    started = clock();
  if (!["implementer", "designer", "human"].includes(options.role))
    throw new DatalogError(
      "unsupported-role",
      "use --role implementer, --role designer or --role human",
    );
  if (subjectsOf(snapshot).length > maxSubjects)
    throw new DatalogError(
      "experimental-scope-exceeded",
      `at most ${maxSubjects} subjects are supported`,
    );
  const { facts, objects } = normalize(snapshot, assessments, options);
  const result = evaluatePolicy(
    {
      viewer: {
        role: options.role,
        agent: options.agent ?? "",
        platform: options.platform ?? "",
        order: options.order ?? "impact",
      },
      datoms: facts,
    },
    { signal: options.signal },
  );
  const ranked = result.decisions.map((decision): DatalogAction => {
    const subject =
      objects.get(decision.subject) ??
      (decision.subject === 1
        ? { url: `https://github.com/${snapshot.repository}`, number: 0 }
        : undefined);
    if (!subject) throw new DatalogError("invalid-inference", "unknown subject or rule");
    const a = assessments.get(subject.url);
    const commandFacts: Record<string, string> = {
      repo: snapshot.repository,
      number: String(subject.number),
      agent: options.agent ?? "NAME",
      platformFlag: options.platform ? ` --platform ${options.platform}` : "",
      other: "",
    };
    const fillCommand = (key: string) =>
      commandTemplates[key].replace(/\{(\w+)\}/g, (_, k: string) => commandFacts[k]);
    const commandKey = commandKinds[decision.kind] ?? "detail";
    let nextCommand = fillCommand(
      commandKey === "detail" && "headRefOid" in subject ? "pr" : commandKey,
    );
    let thenCommand: string | null = null;
    if (decision.kind === "implement") {
      const others = decision.otherClaims.map((id) => objects.get(id)!.number);
      nextCommand = fillCommand("claim");
      if (others.length === 1) {
        commandFacts.other = String(others[0]);
        thenCommand = nextCommand;
        nextCommand = fillCommand("release");
      } else if (others.length > 1) nextCommand = "";
    }
    return {
      id: `${snapshot.repository} ${subject.url} ${decision.kind}`,
      kind: decision.kind as ActionKind,
      target: subject.url,
      // The human role's decisions are projected by briefing/human.ts, never ranked as agent work.
      role: options.role as BlendedRole,
      band: decision.band as Band,
      reasonCodes: decision.codes,
      evidence: [
        subject.url,
        ...[a?.impact.provenance, a?.complexity.provenance].filter((p): p is string => !!p),
      ],
      nextCommand: nextCommand || null,
      thenCommand,
      inspection: nextCommand
        ? null
        : `Inspect current evidence: pdb --repo ${snapshot.repository} --issue ${subject.number} --json`,
      impact: a?.impact ?? emptyMetric,
      complexity: a?.complexity ?? emptyMetric,
      unlocks: decision.unlocks,
      unlocksUnknown: decision.unlocksUnknown,
      ruleIds: decision.why.ruleIds,
      why: decision.why,
    };
  });
  const elapsed = clock() - started;
  options.signal?.throwIfAborted();
  return {
    policyVersion: 1,
    total: ranked.length,
    omitted: Math.max(0, ranked.length - options.limit),
    items: ranked.slice(0, Math.max(0, options.limit)),
    decisionEngine: {
      requested: "datalog",
      used: "datalog",
      policyVersion,
      rulesHash,
      coverage: { subjects: objects.size, datoms: result.datoms },
      denials: result.denials.map(({ subject, ruleId }) => ({
        target: objects.get(subject)?.url ?? "",
        ruleId,
      })),
      diagnostics: [
        ...(elapsed > 2000
          ? [`evaluation exceeded soft 2000ms budget (${Math.round(elapsed)}ms)`]
          : []),
        ...(options.responsibilityUnknown ?? []).map(
          (issue) => `delivery responsibility unknown for ${issue}; agent: labels only`,
        ),
      ],
    },
  };
}
