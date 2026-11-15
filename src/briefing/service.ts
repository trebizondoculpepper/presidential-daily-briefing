import {
  BriefingEngineError,
  resolveEngineSetting,
  defaultEngine,
} from "../config/engine-setting.js";
import type { EngineSetting, DecisionEngineMetadata } from "../config/engine-setting.js";
/**
 * Transport-neutral read service shared by the CLI and the MCP adapter (doc/design/mcp.md).
 *
 * Both front ends call these functions directly; neither runs the other in a subprocess or
 * parses terminal text. Only read operations live here: mutation planning and application stay
 * in their own modules and are never reachable through this service.
 */
import { collect, IssueUnavailable, permissionLookup } from "../github/github.js";
import type { IssueDiagnosis, Query, Rest } from "../github/github.js";
import { diagnoseDelivery } from "../workflow/deliverydoctor.js";
import { deliveryRead } from "../workflow/deliveryread.js";
import type { DeliveryRead } from "../workflow/deliveryread.js";
import { markerTrust } from "../workflow/delivery.js";
import { readSnapshotResponsibility } from "../workflow/responsibility.js";
import type { TrustDecision } from "../workflow/delivery.js";
import { ReadMeter } from "../github/readplan.js";
import { impactMetric } from "../estimation/metrics.js";
import { dependencyReport, dependencyText } from "../github/dependencies.js";
import type { DependencyReport } from "../github/dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
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
import type { HumanBriefing } from "./human.js";
import type { BriefingProcess, GuideRuntime } from "./process.js";

/** Presentation options for a collected snapshot, as the CLI's briefing flags express them. */
/** Decision-engine view when --role is omitted; `pdb rules` reports it as a declared default. */
export const defaultEngineRole = "implementer";

export interface PresentOptions extends Omit<BriefingOptions, "estimation" | "assessments"> {
  /** Expanded version-1 report instead of the compact briefing. */
  full?: boolean;
  engineSetting?: EngineSetting;
  /** Compact text budget. */
  maxChars: number;
  /**
   * Expanded compact text: background sections, totals and evaluator metadata (#355). Off by
   * default, when the text holds only the next steps; never changes the JSON or the actions.
   */
  context?: boolean;
  /** Registered role view (#1) shaping the compact briefing. */
  role?: string;
  /** Workflow guide (#71) for the compact briefing; omitted means no `process` object. */
  process?: BriefingProcess;
  /**
   * Monotonic milliseconds for the Datalog soft time-budget diagnostic only
   * (doc/design/rules-component.md); defaults to `performance.now`. Tests inject a fixed one.
   */
  engineClock?: () => number;
}

/** The versioned briefing report and its text rendering. */
export interface PresentedBriefing {
  report: (ReturnType<typeof compactBriefing> | ReturnType<typeof briefing>) & {
    decisionEngine: DecisionEngineMetadata;
    /**
     * #192: delivery, responsibility and closure, present only when a collected ticket carries a
     * delivery or v1 release record (or its history is truncated). Absent means none in scope.
     */
    delivery?: DeliveryRead;
  };
  text: string;
  complete: boolean;
}

/** Build the briefing (compact unless `full`) for an already collected snapshot. */
export async function presentBriefing(
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
    query: Query;
    rest: Rest;
    /** Rebuilds `trust` over a metered REST boundary, so an intake counts its lookups (#367). */
    trustWith?: (rest: Rest) => TrustDecision;
  },
): Promise<PresentedBriefing> {
  if (options.role === humanRole && !options.full && !options.issue)
    return presentHuman(snapshot, options, now, trust, signal, loadEngine);
  // #367: an issue intake's cost is the whole command's, so the reads made while presenting it
  // (permission lookups and delivery evidence) are metered after its snapshot read.
  const intakeMeter =
    options.issue && snapshot.collection
      ? new ReadMeter("compatibility-full-v1", "issue-intake", () => now, undefined, signal)
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
  // Full issue intake is outside the experimental next-action slice.
  if (selection.requested === "datalog" && !options.full && !options.issue) {
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
        responsible: responsibility.responsible,
        responsibilityUnknown: responsibility.unknown.map((u) => u.issue),
        limit: Number.MAX_SAFE_INTEGER,
        signal,
        now: options.engineClock,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BriefingEngineError(
        "decision-engine-failed",
        error instanceof Error
          ? error.message
          : "Experimental evaluator failed; no fallback was run.",
      );
    }
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
        source: selection.source,
        role: { used: options.role ?? defaultEngineRole, source: roleSource },
      }
    : {
        requested: selection.requested,
        used: "typescript" as const,
        source: selection.source,
        policyVersion: null,
        rulesHash: null,
        coverage: { scope: options.full || options.issue ? "intake" : "next-actions" },
        diagnostics: [],
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
    // Delivery omissions (the evaluation cap) make the briefing incomplete, never silently clean.
    completeness: delivery.complete
      ? base.completeness
      : {
          ...base.completeness,
          complete: false,
          warnings: [...base.completeness.warnings, ...delivery.omissions],
        },
    decisionEngine,
    ...(delivery.tickets.length || !delivery.complete ? { delivery } : {}),
    // #367: an issue intake reports its compatibility-full-v1 profile, coverage and cost.
    ...(intakeMeter && snapshot.collection
      ? { collection: intakeMeter.collection(snapshot.collection) }
      : {}),
  };
  // The engine banner is evaluator metadata: context only, or the expanded --full report (#355).
  const engineHeader =
    experimental && (options.context || !compact)
      ? `Decision engine: Datalog (policy ${experimental.decisionEngine.policyVersion}; ${experimental.decisionEngine.rulesHash.slice(0, 12)})\n`
      : "";
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
): Promise<PresentedBriefing> {
  const evidence = await readHumanEvidence(snapshot, trust, signal);
  const human = options.agent ?? null;
  let result: Awaited<
    ReturnType<(typeof import("../rules/datalog/datalog.js"))["evaluateDatalog"]>
  >;
  try {
    const { evaluateDatalog } = await loadEngine();
    result = evaluateDatalog(snapshot, new Map(), {
      role: humanRole,
      agent: human ?? undefined,
      questionRecords: evidence.records,
      limit: Number.MAX_SAFE_INTEGER,
      signal,
      now: options.engineClock,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BriefingEngineError(
      "decision-engine-failed",
      error instanceof Error
        ? error.message
        : "Human briefing evaluator failed; no fallback was run.",
    );
  }
  // Freshness and snapshot completeness come from the shared facts, as in every briefing.
  const facts = briefing(
    snapshot,
    { limit: 1, agent: options.agent, offline: options.offline },
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
  dependencyReport: typeof dependencyReport;
  estimation?: LabelEstimationRuntime;
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
  /** Monotonic timer for the Datalog soft-budget diagnostic; defaults to `performance.now`. */
  engineClock?: () => number;
  /** Rewrites locally generated diagnostics (not GitHub evidence) for remote consumers. */
  redactDiagnostic?: (text: string) => string;
  /** Filesystem, git and working directory for the workflow-guide setting (#71). */
  guide?: GuideRuntime;
}

/** Live read request for a briefing or one issue's intake. */
export interface BriefingRequest {
  repository: string;
  agent?: string;
  issue?: number;
  since?: string;
  limit: number;
  maxChars: number;
  /** Registered role view (#260): the same blended queue as CLI --role. */
  role?: string;
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
export async function readBriefing(
  runtime: ReadRuntime,
  request: BriefingRequest,
): Promise<BriefingRead> {
  let snapshot: Snapshot;
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
  const engineSetting = request.issue
    ? undefined
    : await resolveEngineSetting(request.repository, runtime.guide);
  const setting = await resolveGuideSetting(request.repository, undefined, runtime.guide);
  const redact = runtime.redactDiagnostic;
  const process = briefingProcess(
    redact ? { ...setting, diagnostics: setting.diagnostics.map(redact) } : setting,
  );
  const presented = await presentBriefing(
    snapshot,
    {
      limit: request.limit,
      maxChars: request.maxChars,
      context: request.context,
      agent: request.agent,
      issue: request.issue,
      ...(request.role ? { role: request.role } : {}),
      ...(request.order ? { order: request.order } : {}),
      process,
      engineSetting,
      ...(runtime.engineClock ? { engineClock: runtime.engineClock } : {}),
    },
    runtime.estimation,
    runtime.now?.(),
    runtime.redactDiagnostic,
    runtime.rest
      ? markerTrust(permissionLookup(request.repository, runtime.rest, request.signal))
      : undefined,
    request.signal,
    undefined,
    // Delivery requests are bound to the request's cancellation signal, like collection.
    runtime.rest && (runtime.queryWith || runtime.query)
      ? {
          query: runtime.queryWith ? runtime.queryWith(request.signal) : runtime.query!,
          rest: (path, options) =>
            runtime.rest!(path, { ...options, signal: options?.signal ?? request.signal }),
          trustWith: (rest: Rest) =>
            markerTrust(permissionLookup(request.repository, rest, request.signal)),
        }
      : undefined,
  );
  return { kind: "report", ...presented };
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
