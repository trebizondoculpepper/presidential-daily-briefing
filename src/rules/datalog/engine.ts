/**
 * The rules engine (doc/design/rules-component.md, "Component boundary"): normalized facts in,
 * ordered decisions and explanations out. Pure and synchronous: no GitHub objects, no clock,
 * no filesystem or network, no command text. The host adapter (adapter.ts) builds the facts and
 * renders the result; an import-boundary test keeps host modules out of this file.
 */
import ds from "datascript";
import type { Datom, Value, Db } from "datascript";
import bundleJson from "./policy.generated.json" with { type: "json" };
import type { PolicyBundle } from "./bundle.js";
import { rulesHashOf, narrationHashOf } from "./hash.js";

/** The validated policy artifact written by `npm run rules:build` from policy/*.edn. */
// Validated by the build and by `rules:build --check` in npm run check; JSON types are too wide.
const bundle = bundleJson as unknown as PolicyBundle;
const { policyVersion } = bundle;

export const rulesHash = rulesHashOf(bundle);
export const narrationHash = narrationHashOf(bundle);
export { policyVersion };

/** Most datoms one evaluation accepts, including the policy's own constants and rule entities. */
export const maxDatoms = 50000;
/** Most subjects (issues and pull requests) one evaluation accepts. */
export const maxSubjects = 500;
/** Entity ids below this are reserved: 1 is the viewer, 2–99 hold policy rule entities. */
export const firstSubjectId = 100;

export class DatalogError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}. Roll back: pdb config set briefing.engine typescript`);
  }
}

export interface PolicyViewer {
  role: string;
  agent: string;
  platform: string;
  order: string;
}
/**
 * Raw facts about the collected repository. `datoms` may assert global completeness facts on
 * entity 1 and subject facts on entities from `firstSubjectId`; never policy entities 2–99.
 */
export interface PolicyFacts {
  viewer: PolicyViewer;
  datoms: Datom[];
}
export interface PolicyExplanation {
  text: string;
  ruleIds: string[];
  facts: Record<string, Value>;
  overriddenRuleIds: string[];
}
export interface HumanAttentionSection {
  section: "input" | "waiting";
  ruleId: string;
  reason: string;
}
export interface PolicyDecision {
  subject: number;
  ruleId: string;
  kind: string;
  band: number;
  codes: string[];
  why: PolicyExplanation;
  unlocks: number;
  unlocksUnknown: string[];
  /** For implementation decisions: other open issues the viewer already owns. */
  otherClaims: number[];
  /** For human decisions (#643): native section grouping (`input` vs `waiting`) and its reason. */
  attentionSection?: HumanAttentionSection;
}
export interface PolicyResult {
  policyVersion: number;
  rulesHash: string;
  /** Already in policy order. */
  decisions: PolicyDecision[];
  denials: { subject: number; ruleId: string }[];
  datoms: number;
}

/** Fixed comparator executes policy-emitted scalar keys; no policy decisions here. */
export function compareKeys(a: readonly Value[], b: readonly Value[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i],
      y = b[i];
    if (typeof x !== typeof y) throw new DatalogError("invalid-sort-key", "inconsistent key types");
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
export interface PolicyOptions {
  signal?: AbortSignal;
  /**
   * A policy bundle to evaluate instead of the shipped one. The rules-only test runner passes a
   * bundle built in memory from policy/*.edn, so source edits are tested without a build step.
   */
  policy?: PolicyBundle;
}

export function evaluatePolicy(input: PolicyFacts, options: PolicyOptions = {}): PolicyResult {
  options.signal?.throwIfAborted();
  const policy = options.policy ?? bundle;
  const {
    definitions,
    clauses,
    schema,
    constants,
    keyQueries,
    queries,
    commonWitnesses,
    eligibilityWitnesses,
    sortClauses,
  } = policy;
  // Bundle queries are canonical EDN printed by the build, so ":in $ %" has exactly this spelling.
  const query = (db: Db, q: string) => (q.includes(":in $ %") ? ds.q(q, db, clauses) : ds.q(q, db));
  if (!["implementer", "designer", "human"].includes(input.viewer.role))
    throw new DatalogError(
      "unsupported-role",
      "use --role implementer, --role designer or --role human",
    );
  for (const [entity, attribute, value] of input.datoms) {
    if (attribute === "native-checks-satisfied")
      throw new DatalogError(
        "invalid-facts",
        "native check-query results cannot be supplied by the host",
      );
    if (entity !== 1 && entity < firstSubjectId)
      throw new DatalogError("invalid-facts", `entity ${entity} is reserved for the policy`);
    // NaN and infinities are not comparable keys: one would reorder unrelated subjects (#450).
    if (typeof value === "number" && !Number.isFinite(value))
      throw new DatalogError(
        "invalid-facts",
        `entity ${entity} ${attribute} is ${value}, not a finite number`,
      );
  }
  // Subjects are the entities with a "kind" fact; the same limit the adapter applies first.
  const subjects = new Set(input.datoms.filter(([, a]) => a === "kind").map(([e]) => e));
  if (subjects.size > maxSubjects)
    throw new DatalogError(
      "experimental-scope-exceeded",
      `at most ${maxSubjects} subjects are supported`,
    );
  const facts: Datom[] = [
    [1, "role", input.viewer.role],
    // An unknown viewer (empty agent) asserts no agent, so no owner, attention or responsibility
    // fact can match it: an empty `agent:` label stays someone's claim, never the viewer's (#449).
    ...(input.viewer.agent ? [[1, "agent", input.viewer.agent] as Datom] : []),
    [1, "platform", input.viewer.platform],
    [1, "order", input.viewer.order],
  ];
  for (const [key, values] of Object.entries(constants))
    for (const v of values) facts.push([1, key, v]);
  facts.push(...input.datoms);
  for (const [i, r] of definitions.entries())
    for (const [k, v] of Object.entries({
      rule: r.id,
      kind: r.kind,
      band: r.band,
      preference: r.preference,
      affinity: r.affinity,
      owned: r.owned,
      why: r.why,
    }))
      facts.push([10 + i, k, v]);
  if (facts.length > maxDatoms)
    throw new DatalogError(
      "experimental-scope-exceeded",
      `at most ${maxDatoms} datoms are supported`,
    );
  const fullSchema = {
    ...schema,
    ...Object.fromEntries(
      Object.keys(constants).map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
    ),
  };
  const database = () => {
    options.signal?.throwIfAborted();
    if (facts.length > maxDatoms)
      throw new DatalogError(
        "experimental-scope-exceeded",
        `at most ${maxDatoms} datoms are supported`,
      );
    return ds.init_db(facts, fullSchema);
  };
  let db = database();
  // Materialize this native relation once rather than expanding its negative joins in every
  // dependent rule query. This transacts returned tuples only; the policy owns readiness.
  const checkReady = query(db, queries["check-ready"]);
  for (const [subject] of checkReady)
    facts.push([Number(subject), "native-checks-satisfied", true]);
  if (checkReady.length) db = database();
  const denials = query(db, queries.denials).map(([id, rule]) => ({
    subject: Number(id),
    ruleId: String(rule),
  }));
  // Each root query derives a relation; the host only transacts the returned tuples.
  for (const [i, r] of definitions.entries()) {
    const rows = query(db, r.query);
    for (const [t] of rows) facts.push([Number(t), "matched", 10 + i]);
    options.signal?.throwIfAborted();
  }
  db = database();
  // Explicit deny-over-permit: unfavorable beats ordinary; easy wins beat ordinary.
  // Preference resolves overlapping boosted/default assessment rules. All matches remain auditable.
  // Declared exceptions (ordering.edn :overrides) join the generic same-kind comparison; a pair
  // both decide is asserted once, as the single or-join query it replaces did.
  const overridden = new Set<string>();
  const pairs = policy.overrides.map(({ winner, loser }) => [winner, loser]);
  for (const [t, r] of [
    ...ds.q(queries.q0, db),
    ...(pairs.length ? ds.q(queries["declared-overrides"], db, pairs) : []),
  ]) {
    const key = `${t}:${r}`;
    if (overridden.has(key)) continue;
    overridden.add(key);
    facts.push([Number(t), "overridden", r]);
  }
  db = database();
  // Native direct unlocks only: the dependent has exactly one open blocker and is otherwise ready.
  const unlockRows = query(db, queries.q1);
  for (const [t, d] of unlockRows) facts.push([Number(t), "unlocks-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "unlocks-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  const counts = ds.q(queries.q2, db);
  for (const [t, reason] of query(db, queries["unknown-unlocks"]))
    facts.push([Number(t), "unlock-unknown", reason]);
  for (const [t, n] of counts) facts.push([Number(t), "unlock-count", n]);
  for (const [t] of ds.q(queries.q3, database())) facts.push([Number(t), "unlock-count", 0]);
  db = database();
  for (const [t, d] of query(db, queries["active-dependents"]))
    facts.push([Number(t), "active-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "active-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  for (const [t, n] of ds.q(queries["active-count"], db))
    facts.push([Number(t), "active-count", n]);
  db = database();
  for (const [t] of ds.q(queries["missing-active-count"], db))
    facts.push([Number(t), "active-count", 0]);
  // Boolean/order keys are inferred from the raw relations, not precomputed by an adapter.
  db = database();

  for (const [field, q] of keyQueries)
    for (const [t, k] of query(db, q)) facts.push([Number(t), field, k]);
  db = database();

  facts.push(
    [1, "assessment-kind", "estimate-complexity"],
    [1, "assessment-kind", "assess-impact"],
    [1, "assessment-kind", "inspect-assessment"],
  );
  db = ds.init_db(facts, {
    ...fullSchema,
    "assessment-kind": { ":db/cardinality": ":db.cardinality/many" },
  });
  const rows = ds.q(queries.q4, db, sortClauses);
  const humanSections =
    input.viewer.role === "human"
      ? new Map(
          query(db, queries["human-sections"]).map(([subject, section, ruleId, reason]) => [
            Number(subject),
            {
              section: (String(section) === "waiting" ? "waiting" : "input") as "input" | "waiting",
              ruleId: String(ruleId),
              reason: String(reason),
            },
          ]),
        )
      : null;
  options.signal?.throwIfAborted();
  const witnessCache = new Map<string, Value[]>();
  const decisions = rows
    .sort((a, b) => compareKeys(a.slice(2), b.slice(2)))
    .map((row): PolicyDecision => {
      const [t, r] = row;
      const definition = definitions[Number(r) - 10];
      // The row's keys follow :comparison (#652: ownership/attention/affinity precede band); the
      // reported band is the rule's own declared lifecycle band.
      const b = definition?.band;
      if (!definition) throw new DatalogError("invalid-inference", "unknown subject or rule");
      const bindings: Record<string, Value> = {};
      const selectedWitnesses = {
        ...commonWitnesses,
        ...eligibilityWitnesses,
        ...definition.witnesses,
      };
      for (const [key, witnessQuery] of Object.entries(selectedWitnesses)) {
        // A subject's witnesses are pure over this database: several decisions on one subject
        // (one activity pool for both roles, #652) share the same answers, so read each once.
        const cacheKey = `${witnessQuery}\u0000${String(t)}`;
        let values = witnessCache.get(cacheKey);
        if (!values) {
          values = ds.q(witnessQuery, db, clauses, t).flat();
          witnessCache.set(cacheKey, values);
        }
        if (values.length === 1) bindings[key] = values[0];
        else if (values.length > 1) {
          const sorted = values.map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          bindings[key] = sorted.slice(0, 8).join("; ");
          if (values.length > 8) bindings[`${key}Omitted`] = values.length - 8;
        }
      }
      const text = definition.why.replace(/\{(\w+)\}/g, (_, key: string) => {
        if (!(key in bindings)) throw new DatalogError("missing-explanation-binding", key);
        return String(bindings[key]);
      });
      const ruleIds = [definition.id];
      const attentionSection = humanSections?.get(Number(t));
      return {
        subject: Number(t),
        ruleId: definition.id,
        kind: definition.kind,
        band: Number(b),
        codes: definition.codes,
        why: {
          text,
          ruleIds,
          facts: bindings,
          overriddenRuleIds: ds.q(queries.q5, db, t).flat().map(String),
        },
        unlocks: Number(ds.q(queries.q6, db, t)[0]?.[0] ?? 0),
        unlocksUnknown: ds.q(queries.q7, db, t).flat().map(String),
        otherClaims:
          definition.kind === "implement"
            ? query(db, queries["other-claims"])
                .filter(([id]) => Number(id) === Number(t))
                .map(([, id]) => Number(id))
            : [],
        ...(attentionSection ? { attentionSection } : {}),
      };
    });
  options.signal?.throwIfAborted();
  return {
    policyVersion: policy.policyVersion,
    rulesHash: options.policy ? rulesHashOf(policy) : rulesHash,
    decisions,
    denials,
    datoms: facts.length,
  };
}

/** Pure target-check diagnostic seam; all readiness clauses and reasons live in native EDN. */
export function evaluateCheckPolicy(input: import("./check-types.js").CheckEvidence): {
  ready: boolean;
  blockers: string[];
  reasons: { ruleId: string; text: string }[];
  policyVersion: number;
  rulesHash: string;
} {
  const facts: Datom[] = [[100, "required-evidence-complete", input.complete]];
  for (const gap of input.gaps) facts.push([100, "required-evidence-gap", gap]);
  for (const name of input.missing) facts.push([100, "missing-required", name]);
  for (const [i, check] of input.checks.entries()) {
    const id = 101 + i;
    facts.push(
      [100, "check", id],
      [id, "name", check.name],
      [id, "outcome", check.outcome],
      [id, "required", check.required],
    );
  }
  const db = ds.init_db(facts, bundle.schema);
  const ready = ds.q(bundle.queries["check-ready"], db, bundle.clauses) as unknown[][];
  const blockers = ds.q(bundle.queries["check-blockers"], db, bundle.clauses) as [
    number,
    string,
    string,
  ][];
  const reasons = blockers
    .map(([, ruleId, text]) => ({ ruleId, text }))
    .sort((a, b) => a.text.localeCompare(b.text));
  return {
    ready: ready.some(([id]) => id === 100),
    blockers: reasons.map((reason) => reason.text),
    reasons,
    policyVersion,
    rulesHash,
  };
}

export interface PrReadinessInput {
  state: string;
  closedLabel: string;
  draft: boolean;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  unresolvedThreadCount: number;
  pendingCount: number;
  checkEvidence: import("./check-types.js").CheckEvidence;
  noRunTimeChecks?: readonly boolean[];
  policy: {
    effective: string;
    headReviewed: boolean;
    hasFindings: boolean;
    summary: string;
    unknownReason?: string;
    findings: readonly { provider: string; label: string; source: string }[];
  };
  codex: {
    findingsOnHead: boolean;
    staleHead: boolean;
    runningStatus: string | null;
  };
  reviewRequestStatus: string | null;
}

/** Pure PR-readiness diagnostic seam (#707); all blocker rules live in native EDN. */
export function evaluatePrReadiness(input: PrReadinessInput): {
  ready: boolean;
  blockers: string[];
  reasons: { ruleId: string; text: string }[];
  verdict: string;
  policyVersion: number;
  rulesHash: string;
} {
  const facts: Datom[] = [];
  for (const [attr, vals] of Object.entries(bundle.constants)) {
    for (const v of vals) facts.push([1, attr, v]);
  }
  facts.push(
    [100, "state", input.state],
    [100, "closed-label", input.closedLabel],
    [100, "draft", input.draft],
    [100, "base-ref", input.baseRefName],
    [100, "mergeable", input.mergeable],
    [100, "merge-state", input.mergeStateStatus],
    [100, "review-decision", input.reviewDecision ?? ""],
    [100, "unresolved-threads", input.unresolvedThreadCount],
    [100, "pending-count", input.pendingCount],
    [100, "required-evidence-complete", input.checkEvidence.complete],
    [100, "policy-effective", input.policy.effective],
    [100, "policy-head-reviewed", input.policy.headReviewed],
    [100, "policy-has-findings", input.policy.hasFindings],
    [100, "policy-summary", input.policy.summary],
    [100, "codex-findings", input.codex.findingsOnHead],
    [100, "codex-stale", input.codex.staleHead],
  );
  if (input.policy.unknownReason)
    facts.push([100, "policy-unknown-reason", input.policy.unknownReason]);
  if (input.codex.runningStatus) facts.push([100, "codex-running", input.codex.runningStatus]);
  if (input.reviewRequestStatus)
    facts.push([100, "review-request-status", input.reviewRequestStatus]);
  for (const gap of input.checkEvidence.gaps) facts.push([100, "required-evidence-gap", gap]);
  for (const name of input.checkEvidence.missing) facts.push([100, "missing-required", name]);

  let nextId = 101;
  for (const [i, check] of input.checkEvidence.checks.entries()) {
    const id = nextId++;
    facts.push(
      [100, "check", id],
      [id, "name", check.name],
      [id, "outcome", check.outcome],
      [id, "required", check.required],
      [id, "no-run-time", Boolean(input.noRunTimeChecks?.[i])],
    );
  }
  for (const finding of input.policy.findings) {
    const id = nextId++;
    facts.push(
      [100, "provider-finding", id],
      [id, "provider", finding.provider],
      [id, "provider-label", finding.label],
      [id, "finding-source", finding.source],
    );
  }

  const rank = (code: string): number => {
    if (code === "PR-CLOSED") return 0;
    if (code === "PR-DRAFT") return 1;
    if (code.startsWith("RC-")) return 2;
    if (code === "PR-CHECK-FAILED") return 3;
    if (code === "PR-CHECK-CANCELLED") return 4;
    if (code === "PR-CHECK-PENDING") return 5;
    if (code === "PR-CONFLICTS" || code === "PR-MERGEABLE-UNKNOWN") return 6;
    if (code === "PR-BEHIND" || code === "PR-MERGE-STATE") return 7;
    if (code === "PR-CHANGES-REQUESTED") return 8;
    if (code === "PR-REVIEW-REQUIRED") return 9;
    if (code === "PR-UNRESOLVED-THREADS") return 10;
    if (code === "PR-CODEX-FINDINGS" || code === "PR-CODEX-STALE") return 11;
    if (code === "PR-PROVIDER-FINDINGS") return 12;
    if (code === "PR-POLICY-UNSATISFIED" || code === "PR-POLICY-UNKNOWN") return 13;
    if (
      code === "PR-REVIEW-REQUEST-NONE" ||
      code === "PR-REVIEW-REQUEST-PENDING" ||
      code === "PR-CODEX-RUNNING"
    )
      return 14;
    return 15;
  };
  const db = ds.init_db(facts, bundle.schema);
  const raw = ds.q(bundle.queries["pr-blockers"], db, bundle.clauses) as [number, string, string][];
  const seen = new Set<string>();
  const reasons: { ruleId: string; text: string }[] = [];
  for (const [, ruleId, text] of raw.sort(
    (a, b) => rank(a[1]) - rank(b[1]) || a[2].localeCompare(b[2]),
  )) {
    const key = `${ruleId}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ ruleId, text });
  }
  const blockers = reasons.map((r) => r.text);
  return {
    ready: blockers.length === 0,
    blockers,
    reasons,
    verdict: blockers.length
      ? "Blocked: address every listed blocker."
      : "No blocker found in current evidence: inspect the diff and consider merging. This is not approval.",
    policyVersion,
    rulesHash,
  };
}
