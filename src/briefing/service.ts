import {
  BriefingEngineError,
  engineFailure,
  resolveEngineSetting,
  defaultEngine,
} from "../config/engine-setting.js";
import type { EngineSetting, DecisionEngineMetadata } from "../config/engine-setting.js";
import { resolveReviewPolicy } from "../config/review-setting.js";
import { resolveProjectRulesSetting } from "../config/project-rules-setting.js";
import type { ProjectRulesSetting } from "../config/project-rules-setting.js";
import { effectivePolicy } from "../rules/datalog/project/effective.js";
import type {
  EffectivePolicyManifest,
  ProjectPolicyRuntime,
} from "../rules/datalog/project/effective.js";
import { datalogReviewFacts } from "../workflow/reviewpolicy.js";
import type { DeclaredReviewPolicy } from "../workflow/reviewpolicy.js";
/**
 * Transport-neutral read service shared by the CLI and the MCP adapter (doc/design/mcp.md).
 *
 * Both front ends call these functions directly; neither runs the other in a subprocess or
 * parses terminal text. Only read operations live here: mutation planning and application stay
 * in their own modules and are never reachable through this service.
 */
import { collect, IssueUnavailable } from "../github/github.js";
import { createGhService } from "../github/service/service.js";
import type { GhService } from "../github/service/service.js";
import { classifyChecks, requiredCheckEvidence } from "../github/requiredchecks.js";
import type { IssueDiagnosis, Query, Rest } from "../github/github.js";
import type { GraphQuery } from "../workflow/claims.js";
import type { readRetained } from "../workflow/retained.js";
import {
  ownedClaims,
  readRetainedFacts,
  type ClaimActivityFact,
} from "../workflow/retainedfacts.js";
import { humanContextText, type HumanContext } from "../config/humancontext.js";
import { diagnoseDelivery } from "../workflow/deliverydoctor.js";
import { deliveryRead } from "../workflow/deliveryread.js";
import type { DeliveryRead } from "../workflow/deliveryread.js";
import { markerTrust } from "../workflow/delivery.js";
import { readSnapshotResponsibility } from "../workflow/responsibility.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { ReadMeter } from "../github/readplan.js";
import { collectShortlist } from "../github/shortlist.js";
import { impactMetric } from "../estimation/metrics.js";
import { dependencyReport, dependencyText } from "../github/dependencies.js";
import type { DependencyReport } from "../github/dependencies.js";
import {
  BriefingArgumentError,
  compactBriefing,
  compactText,
  LabelFilterUnresolved,
} from "./compact.js";
import { normalizeLabelRequest } from "../github/labels.js";
import { briefing, textReport } from "./briefing.js";
import type { BriefingOptions } from "./briefing.js";
import { readSnapshotAssessments, unknownTrust } from "./assessments.js";
import { readComplexityProvenance } from "../estimation/estimation.js";
import { collectLabelEstimationInput, metricStatus } from "../estimation/complexitylabels.js";
import type { LabelEstimationRuntime } from "../estimation/complexitylabels.js";
import type { Snapshot } from "../github/types.js";
import type { PickupOrder } from "./ranking.js";
import { briefingProcess, resolveGuideSetting } from "./process.js";
import { humanBriefing, humanText, readHumanEvidence } from "./human.js";
import { discoverClosedQuestions } from "./closedquestions.js";
import type { ClosedScanSlot } from "./closedquestions.js";
import type { HumanBriefing } from "./human.js";
import type { BriefingProcess, GuideRuntime } from "./process.js";

/** Presentation options for a collected snapshot, as the CLI's briefing flags express them. */
/** Decision-engine view when --role is omitted; `pdb rules` reports it as a declared default. */
export const defaultEngineRole = "implementer";

export interface PresentOptions extends Omit<BriefingOptions, "estimation" | "assessments"> {
  /** The employing human (#664), when the caller resolved it; added to the report. */
  employingHuman?: HumanContext;
  /** Expanded version-1 report instead of the compact briefing. */
  full?: boolean;
  engineSetting?: EngineSetting;
  /** Compact text budget. */
  maxChars: number;
  /** Advancing timer for read durations (#367); default `performance.now`. Not `now`. */
  monotonic?: () => number;
  /**
   * Expanded compact text: background sections, totals and evaluator metadata (#355). Off by
   * default, when the text holds only the next steps; never changes the JSON or the actions.
   */
  context?: boolean;
  /** Registered role view (#1) shaping the compact briefing. */
  role?: string;
  /**
   * #516: whether the repository's native project preferences are enabled, and its verified
   * checkout root. Absent: not read (front ends without a project), reported as disabled.
   */
  projectRules?: ProjectRulesSetting;
  /** #516 test seam: the project policy loader and evaluator. */
  projectRuntime?: ProjectPolicyRuntime;
  /** One registered section of the role view with its row cap lifted (#311). */
  section?: string;
  /** Canonical, already-resolved labels every candidate must carry (#312, AND). */
  labels?: string[];
  /** Workflow guide (#71) for the compact briefing; omitted means no `process` object. */
  process?: BriefingProcess;
  /**
   * Monotonic milliseconds for the Datalog soft time-budget diagnostic only
   * (doc/design/rules-component.md); defaults to `performance.now`. Tests inject a fixed one.
   */
  engineClock?: () => number;
  /**
   * The repository's declared review policy (#301), resolved from local configuration by the
   * front end. Absent: legacy, reported as not read.
   */
  reviewPolicy?: DeclaredReviewPolicy;
}

/** The versioned briefing report and its text rendering. */
export interface PresentedBriefing {
  report: (ReturnType<typeof compactBriefing> | ReturnType<typeof briefing>) & {
    decisionEngine: DecisionEngineMetadata & { effectivePolicy?: EffectivePolicyManifest };
    /**
     * #192: delivery, responsibility and closure, present only when a collected ticket carries a
     * delivery or v1 release record (or its history is truncated). Absent means none in scope.
     */
    delivery?: DeliveryRead;
  };
  text: string;
  complete: boolean;
}

/**
 * Required-check classification per PR (#343) for the Datalog engine, from the same shared
 * classifier the TypeScript rules use, so both engines decide waiting from one model.
 */
export const datalogCheckFacts = (snapshot: Snapshot) =>
  new Map(
    snapshot.pullRequests.map(
      (pr) => [pr.url, { ...classifyChecks(pr), evidence: requiredCheckEvidence(pr) }] as const,
    ),
  );

/** Build the briefing (compact unless `full`) for an already collected snapshot. */
/**
 * Present a briefing, with the employing human (#664) when the caller resolved one: an
 * `employingHuman` field in the report and one leading text line inside the same character budget.
 * Callers that resolve no human (tests, focused reads) get the report unchanged.
 */
export async function presentBriefing(
  ...args: Parameters<typeof presentBriefingFor>
): ReturnType<typeof presentBriefingFor> {
  const employingHuman = args[1].employingHuman;
  if (!employingHuman) return presentBriefingFor(...args);
  const line = `${humanContextText(employingHuman)}\n`;
  const fitsLine = line.length + 31 <= args[1].maxChars;
  const options = fitsLine ? { ...args[1], maxChars: args[1].maxChars - line.length } : args[1];
  const presented = await presentBriefingFor(args[0], options, ...(args.slice(2) as []));
  return {
    ...presented,
    report: { ...presented.report, employingHuman },
    text: (fitsLine ? line : "") + presented.text,
  } as unknown as Awaited<ReturnType<typeof presentBriefingFor>>;
}

async function presentBriefingFor(
  snapshot: Snapshot,
  options: PresentOptions,
  estimationRuntime?: LabelEstimationRuntime,
  now: Date = new Date(),
  redactDiagnostic?: (text: string) => string,
  trust?: TrustDecision,
  signal?: AbortSignal,
  loadEngine: () => Promise<
    Pick<typeof import("../rules/datalog/datalog.js"), "evaluateDatalog">
  > = () => import("../rules/datalog/datalog.js"),
  /** #192: live PR and compare reads for delivery; absent (offline) means not evaluated. */
  live?: {
    gh?: GhService;
    query: Query;
    rest: Rest;
    /** Rebuilds `trust` over a metered REST boundary, so an intake counts its lookups (#367). */
    trustWith?: (rest: Rest) => TrustDecision;
    /** `pdb serve`: the closed-ticket scan continued between requests (#414). */
    closedQuestions?: ClosedScanSlot;
    /** Its uncached GraphQL boundary; absent: `query`. */
    closedQuery?: Query;
  },
): Promise<PresentedBriefing> {
  // #301: every engine and projection below reads the declared policy from the snapshot.
  if (options.reviewPolicy) snapshot = { ...snapshot, reviewPolicy: options.reviewPolicy };
  if (options.role === humanRole && !options.full && !options.issue)
    return presentHuman(snapshot, options, now, trust, signal, loadEngine, live);
  // #367: an issue intake's cost is the whole command's, so the reads made while presenting it
  // (permission lookups and delivery evidence) are metered after its snapshot read.
  const intakeMeter =
    options.issue && snapshot.collection
      ? new ReadMeter(
          "compatibility-full-v1",
          "issue-intake",
          () => now,
          options.monotonic ?? (() => performance.now()),
          signal,
        )
      : undefined;
  if (intakeMeter) {
    const subject = `${snapshot.repository}#${options.issue}`;
    if (live?.trustWith)
      trust = live.trustWith(intakeMeter.rest(live.rest, "permissions", subject));
    if (live)
      live = {
        query: intakeMeter.query(live.query, "delivery-records", subject),
        rest: intakeMeter.rest(live.rest, "delivery-records", subject),
      };
  }
  // Sizes come from the snapshot's labels (#152); only configuration is read here.
  const collected = await collectLabelEstimationInput(snapshot.repository, estimationRuntime);
  // Locally generated configuration diagnostics may name local directories; a remote front end
  // rewrites only these strings, never GitHub-authored evidence. The CLI passes no rewriter.
  const redacted = redactDiagnostic
    ? {
        ...collected,
        unavailable: collected.unavailable && redactDiagnostic(collected.unavailable),
        findings: collected.findings.map((finding) => ({
          ...finding,
          detail: redactDiagnostic(finding.detail),
          next: finding.next.map(redactDiagnostic),
        })),
      }
    : collected;
  // One shared paired-facts read per snapshot (#247); without `trust` provenance is unknown.
  const impactStatus = await metricStatus(impactMetric, snapshot.repository, estimationRuntime);
  const assessments = await readSnapshotAssessments(snapshot, {
    complexity: collected.status,
    impact: impactStatus,
    trust,
    platform: options.platform,
    signal,
  });
  // Complexity provenance trust (#269), after the paired read so the permission cache is warm.
  const estimation =
    collected.status === "available"
      ? {
          ...redacted,
          provenance: await readComplexityProvenance(
            snapshot.issues,
            trust ?? unknownTrust,
            signal,
          ),
        }
      : redacted;
  // Trusted delivery responsibility (#182 over #190 records) from the comments already collected.
  const responsibility = await readSnapshotResponsibility(snapshot, trust, signal);
  options = { ...options, responsible: responsibility.responsible };
  let experimental:
    | Awaited<ReturnType<(typeof import("../rules/datalog/datalog.js"))["evaluateDatalog"]>>
    | undefined;
  const selection = options.engineSetting ?? {
    requested: defaultEngine(),
    source: "default" as const,
  };
  const roleSource = options.role === undefined ? ("default" as const) : ("request" as const);
  const datalogPath = selection.requested === "datalog" && !options.full && !options.issue;
  // #413: the viewer's retained claims and, on a live read, their activity: the same facts for
  // the Datalog rules and the TypeScript rollback ranking.
  // Facts a caller already holds (tests, a future shared read) are used as given.
  const retained =
    options.retained ??
    (!options.full &&
    !options.issue &&
    (datalogPath ? (options.role ?? defaultEngineRole) : options.role) === "implementer"
      ? await readRetainedFacts(
          snapshot,
          options.agent,
          live
            ? {
                query: live.query as GraphQuery,
                permission: (
                  live.gh ?? createGhService({ query: live.query, rest: live.rest })
                ).repos.permissionOf(snapshot.repository, signal),
              }
            : undefined,
        )
      : undefined);
  if (retained) options = { ...options, retained };
  // Full issue intake is outside the experimental next-action slice.
  if (datalogPath) {
    options = { ...options, role: options.role ?? defaultEngineRole };
    if (options.role !== "implementer" && options.role !== "designer")
      throw new BriefingEngineError(
        "decision-engine-role",
        "Datalog next actions require --role implementer or --role designer.",
      );
    try {
      const { evaluateDatalog } = await loadEngine();
      experimental = evaluateDatalog(snapshot, assessments, {
        role: options.role,
        agent: options.agent,
        platform: options.platform,
        order: options.order,
        ...(retained ? { ownedClaims: retained.ownedClaims } : {}),
        ...(retained?.claimActivity ? { claimActivity: retained.claimActivity } : {}),
        responsible: responsibility.responsible,
        responsibilityUnknown: responsibility.unknown.map((u) => u.issue),
        ...datalogReviewFacts(snapshot),
        checkRequiredness: datalogCheckFacts(snapshot),
        limit: Number.MAX_SAFE_INTEGER,
        signal,
        now: options.engineClock,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw engineFailure(error, "Experimental evaluator failed; no fallback was run.");
    }
  }
  // #516: the project's native preferences, applied to the default-admitted queue, or the
  // explicit reason they are not in force. Never a silent fallback to the defaults.
  let effective: { manifest: EffectivePolicyManifest; warnings: string[] } | undefined;
  if (experimental) {
    const applied = await effectivePolicy(
      options.projectRules ?? {
        enabled: "unavailable",
        reason: "project configuration was not read for this briefing",
      },
      experimental.items,
      (await import("../rules/datalog/datalog.js")).projectionSubjects(snapshot),
      {
        base: {
          policyVersion: experimental.decisionEngine.policyVersion,
          rulesHash: experimental.decisionEngine.rulesHash,
        },
        role: options.role ?? defaultEngineRole,
        order: options.order ?? "impact",
        signal,
        ...(options.projectRuntime ? { runtime: options.projectRuntime } : {}),
      },
    );
    experimental = { ...experimental, items: applied.items as typeof experimental.items };
    effective = applied;
  } else if (
    !options.full &&
    !options.issue &&
    options.projectRules &&
    (options.projectRules.enabled === true || options.projectRules.enabled === "unknown")
  ) {
    // Enabled project rules are native Datalog: the TypeScript rollback cannot honour them.
    const reason =
      "project preferences need briefing.engine datalog; the TypeScript rollback engine is in use";
    effective = {
      manifest: {
        schemaVersion: 1,
        state: "error",
        formatVersion: null,
        projectionVersion: null,
        basePolicyVersion: null,
        defaultRulesHash: "",
        projectRulesHash: null,
        effectiveRulesHash: null,
        appliedOrderMode: "error",
        source: "pdb.rules.edn",
        matchedIds: [],
        reason,
        next: [
          "pdb config set briefing.engine datalog",
          "pdb config set rules.project.enabled false",
        ],
      },
      warnings: [
        `Project policy error: ${reason}. The briefing is not the project's effective policy. Run pdb config set briefing.engine datalog, or pdb config set rules.project.enabled false.`,
      ],
    };
  }
  const expanded = briefing(
    snapshot,
    options.full
      ? { ...options, estimation, assessments }
      : {
          ...options,
          estimation,
          assessments,
          limit: Math.max(snapshot.issues.length + snapshot.pullRequests.length, 1) * 20,
        },
    now,
  );
  const built = options.full
    ? null
    : compactBriefing(snapshot, options, expanded, assessments, impactStatus, experimental);
  // Additive: the process object is only present when the front end resolved a guide setting.
  const compact = built && options.process ? { ...built, process: options.process } : built;
  const decisionEngine = experimental
    ? {
        ...experimental.decisionEngine,
        // #516: an active project policy reports the composite effective hash.
        ...(effective?.manifest.state === "active"
          ? { rulesHash: effective.manifest.effectiveRulesHash! }
          : {}),
        source: selection.source,
        role: { used: options.role ?? defaultEngineRole, source: roleSource },
        ...(effective ? { effectivePolicy: effective.manifest } : {}),
      }
    : {
        requested: selection.requested,
        used: "typescript" as const,
        source: selection.source,
        policyVersion: null,
        rulesHash: null,
        coverage: { scope: options.full || options.issue ? "intake" : "next-actions" },
        diagnostics: [],
        ...(effective ? { effectivePolicy: effective.manifest } : {}),
      };
  // #192: one shared fold/evaluator read for CLI and MCP; an issue intake shows its own ticket.
  // An explicit intake evaluates only its own ticket, so the evaluation cap never skips it.
  const scoped = options.issue
    ? { ...snapshot, issues: snapshot.issues.filter((i) => i.number === options.issue) }
    : snapshot;
  const delivery = deliveryRead(scoped, await diagnoseDelivery(scoped, { trust, live, signal }));
  if (intakeMeter)
    intakeMeter.cover(
      "delivery-records",
      `${snapshot.repository}#${options.issue}`,
      !trust || !live ? "not-requested" : delivery.complete ? "complete" : "partial",
      !trust || !live
        ? { omission: "offline or no delivery boundaries; delivery is not evaluated" }
        : delivery.complete
          ? {}
          : { omission: delivery.omissions.join("; ") },
    );
  const base = compact ?? expanded;
  const report = {
    ...base,
    // Delivery omissions (the evaluation cap) and a failed project policy (#516) make the
    // briefing incomplete, never silently clean.
    completeness:
      delivery.complete && !effective?.warnings.length
        ? base.completeness
        : {
            ...base.completeness,
            complete: false,
            warnings: [
              ...base.completeness.warnings,
              ...(effective?.warnings ?? []),
              ...delivery.omissions,
            ],
          },
    decisionEngine,
    ...(delivery.tickets.length || !delivery.complete ? { delivery } : {}),
    // #367: an issue intake reports its compatibility-full-v1 profile, coverage and cost.
    ...(intakeMeter && snapshot.collection
      ? { collection: intakeMeter.collection(snapshot.collection) }
      : {}),
  };
  // The engine banner is evaluator metadata: context only, or the expanded --full report (#355).
  const rawEngineHeader =
    experimental && (options.context || !compact)
      ? // #516: the same resolved identity as the JSON, the composite hash when a project policy ranks.
        `Decision engine: Datalog (policy ${experimental.decisionEngine.policyVersion}; ${(decisionEngine.rulesHash ?? "").slice(0, 12)}${effective?.manifest.state === "active" ? `; project preferences from ${effective.manifest.source}` : effective?.manifest.state === "error" ? "; project policy error, default order" : ""})\n`
      : "";
  const engineHeader =
    !compact || rawEngineHeader.length + 31 <= options.maxChars ? rawEngineHeader : "";
  // Delivery omissions reach the text through the renderers' own bounded INCOMPLETE warnings
  // (a few lines plus "N more warning(s) omitted; use --json"), inside the same budget as the
  // ranked steps. The JSON keeps every warning.
  return {
    report,
    text:
      engineHeader +
      (compact
        ? compactText(
            { ...compact, completeness: report.completeness },
            Math.max(0, options.maxChars - engineHeader.length),
            { context: options.context },
          )
        : textReport({ ...expanded, completeness: report.completeness })),
    complete: report.completeness.complete,
  };
}

/** The human briefing role (doc/design/human-briefing.md, #457). */
export const humanRole = "human";

/**
 * The human briefing for a collected snapshot: rule-derived from the Datalog policy whatever the
 * agent-queue engine setting, with no TypeScript twin and no fallback. Reads only the comments
 * already collected, plus #212 permission lookups for question record authors.
 */
async function presentHuman(
  snapshot: Snapshot,
  options: PresentOptions,
  now: Date,
  trust: TrustDecision | undefined,
  signal: AbortSignal | undefined,
  loadEngine: () => Promise<Pick<typeof import("../rules/datalog/datalog.js"), "evaluateDatalog">>,
  live?: {
    gh?: GhService;
    query: Query;
    rest: Rest;
    trustWith?: (rest: Rest) => TrustDecision;
    closedQuestions?: ClosedScanSlot;
    closedQuery?: Query;
  },
): Promise<PresentedBriefing> {
  const evidence = await readHumanEvidence(snapshot, trust, signal);
  // #414: a question outlives its ticket's closure. Closed sources are read live within a fixed
  // budget; offline or cached reads say they were not read rather than show none.
  evidence.closed = live
    ? await discoverClosedQuestions(
        snapshot.repository,
        {
          closedQuestions: (
            live.gh ??
            createGhService({
              query: live.closedQuery ?? live.query,
              rest: live.rest,
            })
          ).closedQuestions,
          rest: live.rest,
          ...(live.trustWith ? { trustWith: live.trustWith } : {}),
          ...(live.closedQuestions ? { slot: live.closedQuestions } : {}),
          ...(trust ? { trust } : {}),
          ...(signal ? { signal } : {}),
        },
        new Set(snapshot.issues.filter((i) => i.state === "OPEN").map((i) => i.url)),
      )
    : {
        read: false,
        complete: false,
        why: options.offline ? "offline or cached read" : "no live GitHub read",
      };
  const closedSources = evidence.closed.read ? evidence.closed.sources : [];
  const records = new Map(evidence.records);
  for (const source of closedSources) records.set(source.issue.url, source.facts);
  const evaluated: Snapshot = closedSources.length
    ? {
        ...snapshot,
        issues: [
          // A closed issue already in the snapshot (a dependency stub) is replaced by its read.
          ...snapshot.issues.filter((i) => !closedSources.some((c) => c.issue.url === i.url)),
          ...closedSources.map((c) => c.issue),
        ],
      }
    : snapshot;
  const human = options.agent ?? null;
  let result: Awaited<
    ReturnType<(typeof import("../rules/datalog/datalog.js"))["evaluateDatalog"]>
  >;
  try {
    const { evaluateDatalog } = await loadEngine();
    result = evaluateDatalog(evaluated, new Map(), {
      role: humanRole,
      agent: human ?? undefined,
      questionRecords: records,
      ...datalogReviewFacts(snapshot),
      checkRequiredness: datalogCheckFacts(snapshot),
      limit: Number.MAX_SAFE_INTEGER,
      signal,
      now: options.engineClock,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw engineFailure(error, "Human briefing evaluator failed; no fallback was run.");
  }
  // Freshness and snapshot completeness come from the shared facts, as in every briefing.
  const facts = briefing(
    snapshot,
    {
      limit: 1,
      agent: options.agent,
      offline: options.offline,
      // #371: a quota fallback stays labelled stale in the human view too.
      ...(options.stale ? { stale: options.stale } : {}),
    },
    now,
  );
  const labelWarnings = snapshot.issues
    .filter((i) => i.state === "OPEN" && i.labels.pageInfo.hasNextPage)
    .map((i) => `${i.url}: labels truncated; a question or decision label may be unseen.`);
  const view: HumanBriefing = humanBriefing(snapshot, result.items, evidence, {
    human,
    limit: options.limit,
    complete: facts.completeness.complete,
    warnings: [...evidence.warnings, ...labelWarnings],
  });
  const completeness = {
    ...facts.completeness,
    complete: facts.completeness.complete && view.coverage.complete,
    warnings: [...facts.completeness.warnings, ...view.coverage.warnings],
  };
  const report = {
    schemaVersion: 2 as const,
    repository: snapshot.repository,
    freshness: facts.freshness,
    completeness,
    rateLimit: facts.rateLimit,
    human: view,
    decisionEngine: {
      ...result.decisionEngine,
      source: "role" as const,
      role: { used: humanRole, source: "request" as const },
    },
  };
  return {
    report: report as unknown as PresentedBriefing["report"],
    text: humanText(report, view, options.maxChars),
    complete: completeness.complete,
  };
}

/** GitHub-facing boundaries of a live read; tests inject credential-free fakes. */
export interface ReadRuntime {
  collect: typeof collect;
  /**
   * The employing human (#664) for this read; absent: not resolved, and the report carries no
   * \`human\` field. Production front ends resolve it from the signed-in gh account.
   */
  humanContext?: (signal?: AbortSignal) => Promise<HumanContext>;
  /**
   * Routine shortlist collection (#368, briefing-shortlist-v1). Absent: the routine briefing
   * reads the full snapshot, as before.
   */
  collectShortlist?: typeof collectShortlist;
  /** #413: the retained-claim activity reader; default: the claim guard's `readRetained`. */
  claimActivityReader?: typeof readRetained;
  /** Test seam for the lazily loaded Datalog engine; defaults to importing it (#346). */
  loadEngine?: () => Promise<Pick<typeof import("../rules/datalog/datalog.js"), "evaluateDatalog">>;
  dependencyReport: typeof dependencyReport;
  estimation?: LabelEstimationRuntime;
  /** Typed GH service (#902); optional during migration while callers inject `query`/`rest`. */
  gh?: GhService;
  /** Typed GH service bound to a request's cancellation signal (#902). */
  ghWith?: (signal?: AbortSignal) => GhService;
  /**
   * Read-only REST boundary for provenance authors' permissions (#212, #247), cached per run.
   * Absent means no permission requests: trusted provenance is then reported as unknown.
   */
  rest?: Rest;
  /** #192: live GraphQL reads for delivery evidence; absent means delivery is not evaluated. */
  query?: Query;
  /** #192: GraphQL bound to a request's cancellation signal (production: `ghQueryWith`). */
  queryWith?: (signal?: AbortSignal) => Query;
  /** Clock for freshness ages; defaults to the system clock. */
  now?: () => Date;
  /**
   * `pdb serve` (#414): this project's and repository's closed-ticket scan, continued between
   * requests. Absent: each human briefing starts the bounded closed-ticket read afresh.
   */
  closedQuestions?: ClosedScanSlot;
  /**
   * `pdb serve`: an uncached (still confined) GraphQL boundary for that scan. Memoised pages
   * could be older than the watermark the scan advances, so its reads bypass the cache (#414).
   */
  closedQueryWith?: (signal?: AbortSignal) => Query;
  /** Monotonic timer for the Datalog soft-budget diagnostic; defaults to `performance.now`. */
  engineClock?: () => number;
  /** Rewrites locally generated diagnostics (not GitHub evidence) for remote consumers. */
  redactDiagnostic?: (text: string) => string;
  /** Filesystem, git and working directory for the workflow-guide setting (#71). */
  guide?: GuideRuntime;
  /**
   * #516: the project-rules setting when the front end already knows it (`pdb serve --repo`
   * states that no local checkout is selected). Absent: resolved from `guide`, and without one
   * reported as unavailable, never read from the working directory.
   */
  projectRules?: ProjectRulesSetting;
  /**
   * The declared review policy when the front end already knows it (#301): pdb serve with only
   * --repo states it is undeclared rather than reading any directory (#271). Absent: resolved
   * from `guide`.
   */
  reviewPolicy?: DeclaredReviewPolicy;
}

/** Live read request for a briefing or one issue's intake. */
export interface BriefingRequest {
  /** Explicit platform for the shared rebrief read (#506); never inferred. */
  platform?: string;
  repository: string;
  agent?: string;
  issue?: number;
  since?: string;
  limit: number;
  maxChars: number;
  /** Registered role view (#260): the same blended queue as CLI --role. */
  role?: string;
  /** One registered section, every row (#311): the same as CLI --section. */
  section?: string;
  /** Requested label filter (#312, AND), resolved against the repository before projection. */
  labels?: string[];
  /** Pickup order (#260), as CLI --order. */
  order?: PickupOrder;
  /** Expanded compact text (#355), as CLI --context; never changes the report. */
  context?: boolean;
  /** Cancellation: stops collection and terminates running gh child processes. */
  signal?: AbortSignal;
}

/** A live briefing read: either a report, or a diagnosis of an unavailable issue. */
export type BriefingRead =
  | ({ kind: "report" } & PresentedBriefing)
  | { kind: "unavailable"; diagnosis: IssueDiagnosis; text: string };

/** Text for an issue that is transferred, missing or inaccessible (shared with the CLI). */
export function unavailableText(d: IssueDiagnosis): string {
  return `Issue #${d.number} in ${d.repository}: ${d.state.toUpperCase()}\n${d.detail}\n${d.state === "moved" ? `Destination: ${String(d.destination.url)} (use --include-transferred to read it)\n` : ""}Next: ${d.next}\n`;
}

/** Collect live evidence and present the compact briefing, focused on `issue` if given. */
/**
 * Resolve a requested label filter to canonical repository labels (#312), shared by the CLI,
 * MCP and HTTP front ends: an unknown label is an argument error naming it, and a failed
 * lookup is an unresolved filter; neither yields a silently empty queue.
 */
export async function resolveLabelFilter(
  repository: string,
  labels: readonly string[],
  query: Query | GhService,
): Promise<string[]> {
  const normalized = normalizeLabelRequest(labels);
  if (!normalized.ok) throw new BriefingArgumentError(normalized.why);
  const service = typeof query === "function" ? createGhService({ query }) : query;
  const resolution = await service.labels.resolve(repository, normalized.labels);
  if (resolution.status === "unknown")
    throw new BriefingArgumentError(
      `Unknown label(s) in ${repository}: ${resolution.missing.join(", ")}. No label is created; check the name with gh label list --repo ${repository}.`,
    );
  if (resolution.status === "unresolved")
    throw new LabelFilterUnresolved(
      `The label filter could not be resolved: ${resolution.why}. This is not proof the label is absent; retry when GitHub is reachable.`,
    );
  return resolution.labels;
}

export async function readBriefing(
  runtime: ReadRuntime,
  request: BriefingRequest,
): Promise<BriefingRead> {
  // #368: the routine briefing discovers, ranks, then hydrates only its shortlist. An issue
  // intake, a history window and the human briefing keep the full snapshot.
  const shortlisted =
    !!runtime.collectShortlist && !request.issue && !request.since && request.role !== humanRole;
  let snapshot: Snapshot | undefined;
  if (!shortlisted)
    try {
      snapshot = await runtime.collect(request.repository, {
        issue: request.issue,
        since: request.since,
        signal: request.signal,
      });
    } catch (error) {
      if (!(error instanceof IssueUnavailable)) throw error;
      return {
        kind: "unavailable",
        diagnosis: error.diagnosis,
        text: unavailableText(error.diagnosis),
      };
    }
  // #312: resolve the label filter once, through the same read boundary, before projecting.
  const labels = request.labels?.length
    ? await resolveLabelFilter(
        request.repository,
        request.labels,
        runtime.ghWith?.(request.signal) ??
          runtime.gh ??
          createGhService({
            ...(runtime.queryWith || runtime.query
              ? { query: runtime.queryWith?.(request.signal) ?? runtime.query }
              : {}),
            ...(runtime.rest ? { rest: runtime.rest } : {}),
          }),
      )
    : undefined;
  const engineSetting = request.issue
    ? undefined
    : await resolveEngineSetting(request.repository, runtime.guide);
  // #516: program-mediated enablement and the verified checkout the policy file is read from.
  const projectRules = request.issue
    ? undefined
    : (runtime.projectRules ??
      (await resolveProjectRulesSetting(request.repository, runtime.guide)));
  const reviewPolicy =
    runtime.reviewPolicy ?? (await resolveReviewPolicy(request.repository, runtime.guide));
  const setting = await resolveGuideSetting(request.repository, undefined, runtime.guide);
  const redact = runtime.redactDiagnostic;
  const process = briefingProcess(
    redact ? { ...setting, diagnostics: setting.diagnostics.map(redact) } : setting,
  );
  const employingHuman = runtime.humanContext
    ? await runtime.humanContext(request.signal)
    : undefined;
  const options: PresentOptions = {
    ...(employingHuman ? { employingHuman } : {}),
    limit: request.limit,
    maxChars: request.maxChars,
    context: request.context,
    agent: request.agent,
    platform: request.platform,
    issue: request.issue,
    ...(request.role ? { role: request.role } : {}),
    ...(request.section !== undefined ? { section: request.section } : {}),
    ...(labels ? { labels } : {}),
    ...(request.order ? { order: request.order } : {}),
    process,
    engineSetting,
    ...(projectRules ? { projectRules } : {}),
    reviewPolicy,
    ...(runtime.engineClock ? { engineClock: runtime.engineClock } : {}),
  };
  // #368: one meter for the shortlist read, its permission lookups and delivery evidence, so a
  // quota refusal anywhere stops every later send and the telemetry is the whole command's.
  const meter = snapshot
    ? undefined
    : new ReadMeter("briefing-shortlist-v1", "briefing", runtime.now, undefined, request.signal);
  const rest =
    meter && runtime.rest
      ? meter.rest(runtime.rest, "permissions", request.repository)
      : runtime.rest;
  const baseQuery = runtime.queryWith ? runtime.queryWith(request.signal) : runtime.query;
  const liveQuery =
    meter && baseQuery ? meter.query(baseQuery, "delivery-records", request.repository) : baseQuery;
  const gh = runtime.ghWith?.(request.signal) ?? runtime.gh;
  const permissionService = gh ?? (rest ? createGhService({ rest }) : undefined);
  // One permission cache for every ranking pass and the final presentation.
  const trust = permissionService
    ? markerTrust(permissionService.repos.permissionOf(request.repository, request.signal))
    : undefined;
  // #413: claim activity is read live, before the first shortlist ranking, so every selection
  // pass and the final presentation rank the same retained-claim rows: hydration then covers
  // whatever those rows bring into view. The inventory is recomputed per snapshot; a claim
  // first revealed by hydration (an ownership label discovery did not see) is read then, so a
  // waiting or resume-required claim is never treated as active legacy work.
  let activity: ReadonlyMap<string, ClaimActivityFact> | undefined;
  let activityReadFor = new Set<string>();
  const retainedFor = async (collected: Snapshot): Promise<PresentOptions["retained"]> => {
    if (!request.agent || (request.role ?? defaultEngineRole) !== "implementer") return undefined;
    const owned = ownedClaims(collected, request.agent);
    const fresh = owned.urls.filter((url) => !activityReadFor.has(url));
    if (fresh.length && permissionService && liveQuery) {
      const facts = await readRetainedFacts(
        { ...collected, issues: collected.issues.filter((i) => fresh.includes(i.url)) },
        request.agent,
        {
          query: liveQuery as GraphQuery,
          permission: permissionService.repos.permissionOf(request.repository, request.signal),
        },
        runtime.claimActivityReader,
      );
      for (const url of fresh) activityReadFor.add(url);
      if (facts?.claimActivity) activity = new Map([...(activity ?? []), ...facts.claimActivity]);
    }
    return {
      ownedClaims: {
        ...owned,
        urls: owned.urls.filter((u) => activity?.get(u)?.state !== "not-owned"),
      },
      ...(activity ? { claimActivity: activity } : {}),
    };
  };
  const present = async (collected: Snapshot, live: boolean, reserve = 0) =>
    presentBriefing(
      collected,
      {
        ...options,
        maxChars: Math.max(0, options.maxChars - reserve),
        ...(options.issue ? {} : { retained: await retainedFor(collected) }),
      },
      runtime.estimation,
      runtime.now?.(),
      runtime.redactDiagnostic,
      trust,
      request.signal,
      runtime.loadEngine,
      // Delivery requests are bound to the request's cancellation signal, like collection.
      live && rest && liveQuery
        ? {
            ...(gh ? { gh } : {}),
            query: liveQuery,
            rest: (path, options) =>
              rest(path, { ...options, signal: options?.signal ?? request.signal }),
            trustWith: (other: Rest) =>
              markerTrust(
                createGhService({ rest: other }).repos.permissionOf(
                  request.repository,
                  request.signal,
                ),
              ),
            ...(runtime.closedQuestions ? { closedQuestions: runtime.closedQuestions } : {}),
            ...(runtime.closedQueryWith
              ? { closedQuery: runtime.closedQueryWith(request.signal) }
              : {}),
          }
        : undefined,
    );
  if (!snapshot)
    snapshot = await runtime.collectShortlist!(
      request.repository,
      {
        select: async (candidates) => shownSubjects((await present(candidates, false)).report),
        signal: request.signal,
        ...(runtime.rest ? { rest: runtime.rest } : {}),
        ...(meter ? { meter } : {}),
      },
      runtime.queryWith?.(request.signal) ?? runtime.query,
      runtime.now,
    );
  const line = shortlistLine(snapshot, request.maxChars);
  return {
    kind: "report",
    ...withShortlist(await present(snapshot, true, line.length), snapshot, meter, line),
  };
}

/**
 * The PROVISIONAL notice line of a shortlist snapshot, clipped to `maxChars`; empty when every
 * item was hydrated. Callers reserve its length from the presentation's text budget.
 */
export function shortlistLine(snapshot: Snapshot, maxChars: number): string {
  const notice = snapshot.shortlist?.notice;
  if (!notice || maxChars < 60) return "";
  const line = `PROVISIONAL: ${notice}\n`;
  if (line.length + 31 <= maxChars) return line;
  const budget = maxChars - 31;
  return `${line.slice(0, Math.max(0, budget - 2))}…\n`;
}

/** The URLs a presented briefing shows (its subjects), in order; the shortlist to hydrate. */
export function shownSubjects(report: PresentedBriefing["report"]): string[] {
  const subjects = (report as { subjects?: { url: string }[] }).subjects;
  return (subjects ?? []).map((subject) => subject.url);
}

/**
 * Attach the routine shortlist record (#368) and the collection telemetry to a presented
 * briefing. A shown subject that was not hydrated would be unread evidence presented as empty:
 * the collector withdraws such stubs, and this check makes any that remain an explicit
 * incompleteness rather than a clean row.
 */
export function withShortlist(
  presented: PresentedBriefing,
  snapshot: Snapshot,
  /** The read's shared meter: its record then includes the presentation's lookups. */
  meter?: ReadMeter,
  /** The notice line from `shortlistLine`, whose length the presentation reserved. */
  line = "",
): PresentedBriefing {
  const shortlist = snapshot.shortlist;
  if (!shortlist) return presented;
  const collection =
    meter && snapshot.collection
      ? { ...meter.collection(), bounds: snapshot.collection.bounds }
      : snapshot.collection;
  const unread = new Set(shortlist.notHydrated.map((item) => item.url));
  const shownUnread = shownSubjects(presented.report).filter((url) => unread.has(url));
  // Delivery records on an item that was not hydrated were not read: the delivery view covers
  // the hydrated tickets only, and says so rather than reading as "no other delivery".
  const unreadIssues = shortlist.notHydrated.filter((item) => item.kind === "issue").length;
  const priorDelivery = presented.report.delivery;
  // An absent delivery view means "none in scope", so it is present whenever records went unread.
  const delivery = unreadIssues
    ? {
        tickets: priorDelivery?.tickets ?? [],
        guidance:
          priorDelivery?.guidance ??
          "Read-only. Unknown or not-evaluated is never 'not delivered' or 'nobody responsible'.",
        // Unread records are disclosed; the view is complete only for the hydrated tickets.
        complete: false,
        omissions: [
          ...(priorDelivery?.omissions ?? []),
          `delivery records on ${unreadIssues} open issue(s) that were not hydrated are unknown; inspect one with pdb --issue N`,
        ],
      }
    : priorDelivery;
  const completeness = shownUnread.length
    ? {
        ...presented.report.completeness,
        complete: false,
        warnings: [
          ...presented.report.completeness.warnings,
          `Shown but not hydrated (evidence unknown): ${shownUnread.join(", ")}.`,
        ],
      }
    : presented.report.completeness;
  return {
    ...presented,
    // The notice leads, inside the text budget the presentation reserved for it.
    text:
      line +
      presented.text +
      (shownUnread.length
        ? `INCOMPLETE: shown but not hydrated (evidence unknown): ${shownUnread.join(", ")}\n`
        : ""),
    report: Object.assign({}, presented.report, {
      completeness,
      ...(delivery ? { delivery } : {}),
      shortlist,
      ...(collection ? { collection } : {}),
    }),
    complete: completeness.complete,
  };
}

/** Read native dependencies of one issue, with its text rendering. */
export async function readDependencies(
  runtime: ReadRuntime,
  repository: string,
  number: number,
  tree: boolean,
  signal?: AbortSignal,
): Promise<{ report: DependencyReport; text: string }> {
  const report = await runtime.dependencyReport(repository, number, { tree, signal });
  return { report, text: dependencyText(report) };
}
