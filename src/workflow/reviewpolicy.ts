/**
 * Declared review policy (#301). Contract: doc/design/declared-review-policy.md, applying
 * doc/design/review-gate.md through registered policy data rather than a repository exception.
 *
 * Three parts, kept apart:
 * - the registry: which policies exist and which providers each one counts (shared data);
 * - provider adapters: normalize attributable GitHub facts to one state per provider, bound to
 *   the full current head; they never decide action priority or grant merge permission;
 * - coverage: whether the declared policy is satisfied on the current head.
 *
 * Positive coverage needs authenticated provider evidence on the exact live head. Copied,
 * unattributed, stale, pending, skipped (quota), errored and unknown evidence never satisfies it.
 * A known finding from any configured provider vetoes coverage; another clean provider is no
 * waiver. CI, conflicts, protections, draft state and authority stay independent requirements.
 */
import { codexMarker, headAccepted, headCodexFindings } from "./reviewevidence.js";
import type { PullRequest } from "../github/types.js";

/** Registered `review.policy` values; absent configuration is "undeclared", never one of these. */
export const reviewPolicyIds = ["legacy", "codex-or-coderabbit"] as const;
export type ReviewPolicyId = (typeof reviewPolicyIds)[number];
export type ProviderId = "codex" | "coderabbit";

/** A registered policy: shared executable data, never selected by repository, issue or agent. */
export interface RegisteredReviewPolicy {
  readonly id: ReviewPolicyId;
  /** `legacy`: the pre-#301 rule (any current-head approval or clean Codex receipt). */
  readonly coverage: "legacy" | "any";
  readonly providers: readonly ProviderId[];
  readonly findings: "codex-receipts" | "all-known-substantive";
}
export const reviewPolicies: Readonly<Record<ReviewPolicyId, RegisteredReviewPolicy>> = {
  legacy: { id: "legacy", coverage: "legacy", providers: [], findings: "codex-receipts" },
  "codex-or-coderabbit": {
    id: "codex-or-coderabbit",
    coverage: "any",
    providers: ["codex", "coderabbit"],
    findings: "all-known-substantive",
  },
};

/**
 * Verified provider adapters' identities. A login only counts when GitHub reports its author as
 * a Bot: a user account with the same name, a copied marker or a reported display name is not
 * the integration. `apps` are the GitHub App slugs whose check runs belong to the provider.
 */
export interface ReviewProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly accounts: readonly string[];
  readonly apps: readonly string[];
  /** A neutral quota/rate-limit notice: a reason the provider skipped, never a review. */
  readonly quota: RegExp;
}
export const reviewProviders: Readonly<Record<ProviderId, ReviewProvider>> = {
  codex: {
    id: "codex",
    label: "Codex",
    accounts: ["chatgpt-codex-connector"],
    apps: ["chatgpt-codex-connector"],
    quota: /usage limits?\b|rate[- ]limit/i,
  },
  coderabbit: {
    id: "coderabbit",
    label: "CodeRabbit",
    accounts: ["coderabbitai"],
    apps: ["coderabbitai"],
    quota:
      /review(?:s)? (?:rate[- ])?limit(?:ed| reached)|rate[- ]limit(?:ed| exceeded)|reviews? paused/i,
  },
};

/** The repository's declared policy as configuration states it. */
export type DeclaredReviewPolicy =
  | { state: "declared"; policy: ReviewPolicyId }
  /** No setting: legacy behavior, reported as such. `scope` says why nothing was read. */
  | { state: "undeclared"; scope: "repository-config" | "no-matching-project" | "not-read" }
  /** Unreadable or ambiguous configuration: neither policy is assumed. */
  | { state: "unknown"; reason: string };

/** Callers that never resolved configuration: legacy behavior, reported as unread. */
export const policyNotRead: DeclaredReviewPolicy = { state: "undeclared", scope: "not-read" };

export function effectivePolicy(d: DeclaredReviewPolicy): ReviewPolicyId | "unknown" {
  return d.state === "declared" ? d.policy : d.state === "undeclared" ? "legacy" : "unknown";
}

type Author = { __typename?: string; login: string } | null | undefined;
/** Raw review facts for one pull request, from either the snapshot or `pr N`'s own read. */
export interface ReviewEvidence {
  /** The live head's full commit SHA. */
  head: string;
  /** In server (connection) order, oldest first. */
  reviews: {
    author: Author;
    state: string;
    commit: string | null;
    at: string | null;
    url: string;
  }[];
  comments: { author: Author; body: string | null; url: string }[];
  /** Head check runs with their publishing app; absent when the read did not collect apps. */
  checks?: {
    app: string | null;
    name: string;
    status: string | null;
    conclusion: string | null;
    url: string;
  }[];
  /** Every source that could hold a finding (comments, reviews, threads) was read in full. */
  complete: boolean;
}

export type ProviderState =
  | "accepted"
  | "findings"
  | "pending"
  | "stale"
  | "skipped"
  | "error"
  | "unknown";
export interface ProviderObservation {
  provider: ProviderId;
  state: ProviderState;
  /** The reviewed head the state refers to; null when no attributable head is known. */
  head: string | null;
  source: string | null;
  detail: string;
}

const login = (a: Author) => (a?.login ?? "").replace(/\[bot\]$/, "");
/** "provider": authenticated integration; "unattributed": its name but no author type. */
function attribution(a: Author, p: ReviewProvider): "provider" | "unattributed" | "other" {
  if (!p.accounts.includes(login(a))) return "other";
  if (a?.__typename === "Bot") return "provider";
  return a?.__typename === undefined ? "unattributed" : "other";
}
const unfinished = ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"];
const errored = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
];
const neutral = ["NEUTRAL", "SKIPPED", "STALE"];

/**
 * One provider's normalized state on the current head. Order of precedence: a known finding,
 * then acceptance, then pending/error/skipped head work, then stale older coverage, else unknown.
 * Only an exact full-SHA match binds evidence to the head; nothing here reads a timestamp from a
 * payload, a branch name or a check name to decide acceptance.
 */
export function observeProvider(
  id: ProviderId,
  e: ReviewEvidence,
  notes: string[] = [],
): ProviderObservation {
  const p = reviewProviders[id];
  const obs = (state: ProviderState, head: string | null, source: string | null, detail: string) =>
    ({ provider: id, state, head, source, detail }) satisfies ProviderObservation;
  for (const c of e.comments)
    if (id === "codex" && codexMarker(c.body) && attribution(c.author, p) !== "provider")
      notes.push(
        `ignored a Codex review-state marker posted by ${login(c.author) || "an unknown author"}${attribution(c.author, p) === "unattributed" ? " (author type unknown)" : " (not the Codex integration)"}`,
      );
  const reviews = e.reviews.filter((r) => attribution(r.author, p) === "provider");
  const headReviews = reviews.filter((r) => r.commit === e.head);
  const own = e.comments.filter((c) => attribution(c.author, p) === "provider");
  const markers = own.flatMap((c) => {
    const m = codexMarker(c.body)?.code_review;
    return id === "codex" && m ? [{ url: c.url, m }] : [];
  });
  const headMarkers = markers.filter(({ m }) => m.commit_sha === e.head);
  const checks = (e.checks ?? []).filter((c) => c.app !== null && p.apps.includes(c.app));

  // Any head receipt with findings vetoes, even beside a clean one: conflicts are not resolved by
  // choosing whichever says clean. A formal review counts by its latest state on the head.
  const latestReview = headReviews.at(-1);
  const finding =
    headMarkers.find(({ m }) => m.has_unresolved_findings === true)?.url ??
    (latestReview?.state === "CHANGES_REQUESTED" ? latestReview.url : undefined);
  if (finding)
    return obs("findings", e.head, finding, "reports unresolved findings on the current head");
  const latest = headMarkers.at(-1);
  if (latest && typeof latest.m.status === "string" && latest.m.status !== "completed")
    return obs("pending", e.head, latest.url, `review in progress (${latest.m.status})`);
  const clean = headMarkers.findLast(
    ({ m }) => m.status === "completed" && m.has_unresolved_findings === false,
  );
  if (clean)
    return obs("accepted", e.head, clean.url, "completed clean review of the current head");
  if (latestReview?.state === "APPROVED")
    return obs("accepted", e.head, latestReview.url, "approved the current head");
  if (latest)
    return obs("unknown", e.head, latest.url, "unrecognised review-state receipt on the head");
  const running = checks.find((c) => unfinished.includes(c.status ?? c.conclusion ?? ""));
  if (running) return obs("pending", e.head, running.url, `check ${running.name} still running`);
  const broken = checks.find((c) => errored.includes(c.conclusion ?? ""));
  if (broken)
    return obs(
      "error",
      e.head,
      broken.url,
      `check ${broken.name} ${broken.conclusion?.toLowerCase()}`,
    );
  const skipped = checks.find((c) => neutral.includes(c.conclusion ?? ""));
  if (skipped)
    return obs(
      "skipped",
      e.head,
      skipped.url,
      `check ${skipped.name} ${skipped.conclusion?.toLowerCase()} (no review)`,
    );
  const quota = own.findLast((c) => p.quota.test(c.body ?? ""));
  if (quota) return obs("skipped", null, quota.url, "review skipped: provider rate or quota limit");
  if (headReviews.length)
    return obs(
      "unknown",
      e.head,
      latestReview!.url,
      `${latestReview!.state.toLowerCase()} review without a passing outcome`,
    );
  const older = [...markers.map((m) => m.url), ...reviews.map((r) => r.url)].at(-1);
  const olderHead = markers.at(-1)?.m.commit_sha ?? reviews.at(-1)?.commit ?? null;
  if (older)
    return obs(
      "stale",
      typeof olderHead === "string" ? olderHead : null,
      older,
      "latest review is for an older commit",
    );
  return obs("unknown", null, null, "no attributable review evidence");
}

/** Versioned `reviewPolicy` detail added to readiness reports (#301). */
export interface ReviewPolicyDetail {
  schemaVersion: 1;
  declared: DeclaredReviewPolicy;
  effective: ReviewPolicyId | "unknown";
  /** `unknown` when the policy is unknown or finding evidence was not read in full. */
  coverage: "satisfied" | "unsatisfied" | "unknown";
  satisfiedBy: { provider: ProviderId; head: string; source: string }[];
  findings: { provider: ProviderId; source: string }[];
  providers: ProviderObservation[];
  unknowns: string[];
}
export interface PolicyReview {
  detail: ReviewPolicyDetail;
  /** Current-head accepted coverage under the effective policy (the public `headReviewed`). */
  headReviewed: boolean;
  /** A known finding on the current head that blocks under the effective policy. */
  headFindings: boolean;
}

/**
 * Evaluate the declared policy over one pull request's evidence. `legacy` keeps the pre-#301
 * result exactly; it is computed here from the same facts so every surface agrees.
 */
export function evaluateReviewPolicy(
  declared: DeclaredReviewPolicy,
  e: ReviewEvidence,
): PolicyReview {
  const codexStates = e.comments.map((c) => ({
    by: login(c.author),
    state: codexMarker(c.body)?.code_review,
  }));
  const legacy = {
    headReviewed: headAccepted(
      e.head,
      e.reviews.map((r) => ({ state: r.state, commit: r.commit })),
      codexStates,
    ),
    headFindings: headCodexFindings(e.head, codexStates),
  };
  const effective = effectivePolicy(declared);
  const unknowns: string[] = [];
  const providers = (Object.keys(reviewProviders) as ProviderId[]).map((id) =>
    observeProvider(id, e, unknowns),
  );
  if (declared.state === "unknown") unknowns.push(`review policy unknown: ${declared.reason}`);
  if (!e.complete)
    unknowns.push("review, comment or thread evidence is incomplete: findings may be unread");
  const counted =
    effective === "unknown"
      ? providers
      : providers.filter((o) => reviewPolicies[effective].providers.includes(o.provider));
  const findings = counted
    .filter((o) => o.state === "findings")
    .map((o) => ({ provider: o.provider, source: o.source ?? "" }));
  let headReviewed: boolean;
  let headFindings: boolean;
  if (effective === "legacy") ({ headReviewed, headFindings } = legacy);
  else {
    // Unknown policy: findings still block; nothing is accepted.
    headFindings = legacy.headFindings || findings.length > 0;
    headReviewed =
      effective !== "unknown" && !headFindings && counted.some((o) => o.state === "accepted");
  }
  const satisfiedBy =
    effective === "unknown" || effective === "legacy" || !headReviewed
      ? []
      : counted
          .filter((o) => o.state === "accepted")
          .map((o) => ({ provider: o.provider, head: e.head, source: o.source ?? "" }));
  return {
    detail: {
      schemaVersion: 1,
      declared,
      effective,
      coverage:
        effective === "unknown" || !e.complete
          ? "unknown"
          : headReviewed
            ? "satisfied"
            : "unsatisfied",
      satisfiedBy,
      findings: effective === "legacy" ? [] : findings,
      providers,
      unknowns,
    },
    headReviewed,
    headFindings,
  };
}

/** Review evidence as the snapshot collects it (check apps are not part of that read). */
export function snapshotReviewEvidence(pr: PullRequest, complete: boolean): ReviewEvidence {
  return {
    head: pr.headRefOid,
    reviews: (pr.reviews?.nodes ?? []).map((r) => ({
      author: r.author,
      state: r.state,
      commit: r.commit?.oid ?? null,
      at: r.submittedAt ?? null,
      url: r.url,
    })),
    comments: (pr.comments?.nodes ?? []).map((c) => ({
      author: c.author,
      body: c.body,
      url: c.url,
    })),
    complete,
  };
}

/** One-line explanation of the policy outcome for text renderings. */
export function reviewPolicyText(d: ReviewPolicyDetail): string {
  const name =
    d.declared.state === "declared"
      ? d.declared.policy
      : d.declared.state === "undeclared"
        ? `undeclared (legacy${d.declared.scope === "repository-config" ? "" : `; ${d.declared.scope}`})`
        : "unknown";
  const by = d.satisfiedBy
    .map((s) => `${reviewProviders[s.provider].label} ${s.source}`)
    .join(", ");
  const states = d.providers
    .map((o) => `${reviewProviders[o.provider].label} ${o.state}`)
    .join(", ");
  return `Review policy ${name}: coverage ${d.coverage}${by ? ` by ${by}` : ""} (${states})`;
}
