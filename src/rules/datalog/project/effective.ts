/**
 * The effective policy of one briefing (#516, doc/design/native-project-rules.md
 * "Configuration, identity, English and packaging"): the shipped default, plus the project's
 * native preferences when program-mediated configuration enables them.
 *
 * Every outcome is reported in the additive `effectivePolicy` manifest. An enabled policy that
 * cannot be read, validated or evaluated yields `state: "error"` with repair and disable
 * guidance, and the caller marks the briefing incomplete: the default order is then shown as
 * the default order, never presented as the project's. Nothing here caches a previous generation.
 */
import type { ProjectRulesSetting } from "../../../config/project-rules-setting.js";
import type { AdmittedAction, ProjectionSubject } from "./projection.js";
import type { ProjectedAction } from "./admission.js";
import type { WorkerOptions } from "./worker.js";
import type { CompiledProjectPolicy } from "./compile.js";
import type { evaluateProjectPreferences } from "./evaluate.js";

/**
 * The loader and evaluator come from the lazily loaded evaluator chunk, like the default engine,
 * so a briefing with project rules disabled never loads the EDN reader or the worker.
 */
const engine = () => import("../datalog.js");

export const projectRulesSource = "pdb.rules.edn" as const;

export interface EffectivePolicyManifest {
  schemaVersion: 1;
  state: "disabled" | "active" | "error";
  formatVersion: 1 | null;
  projectionVersion: 1 | null;
  basePolicyVersion: number | null;
  defaultRulesHash: string;
  /** Null when disabled or unreadable. */
  projectRulesHash: string | null;
  /** The default hash when disabled; the composite when active; null on error. */
  effectiveRulesHash: string | null;
  appliedOrderMode: "impact" | "disabled-by-age-order" | "disabled" | "error";
  /** The project-relative policy file, never a local path. */
  source: typeof projectRulesSource;
  /** Matched project preference IDs, in policy order. */
  matchedIds: string[];
  /** Why the policy is disabled or failed, with safe recovery commands. */
  reason: string | null;
  next: string[];
}

const repair = [
  `Repair ${projectRulesSource} (pdb rules shows the effective policy), or disable it: pdb config set rules.project.enabled false`,
];

/** What the loader and evaluator need; injectable so tests and front ends share one path. */
export interface ProjectPolicyRuntime {
  loadPolicy?: (
    root: string,
    base: { policyVersion: number; rulesHash: string },
  ) => Promise<CompiledProjectPolicy>;
  evaluate?: typeof evaluateProjectPreferences;
  worker?: WorkerOptions;
}

export interface EffectivePolicyResult<A extends AdmittedAction> {
  items: (A | ProjectedAction<A>)[];
  manifest: EffectivePolicyManifest;
  /** Completeness warnings the caller adds; nonempty exactly when the policy failed. */
  warnings: string[];
}

/** Bounded, path-free detail of a load or evaluation failure. */
function failureDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  // Evaluation errors (ProjectEvaluationError) and source/grammar errors (ProjectSourceError) are
  // built from codes and fixed text, never an absolute path; anything else is not echoed.
  if (typeof code === "string" && message.startsWith("project policy "))
    return message.slice(0, 400);
  if (typeof code === "string" && message.startsWith(`${projectRulesSource}:`))
    return message.slice(0, 400);
  return `${projectRulesSource} could not be loaded`;
}

/**
 * Apply the configured project policy to the default-admitted actions, or report why not.
 * `actions` stay untouched unless the whole evaluation is admitted.
 */
export async function effectivePolicy<A extends AdmittedAction & { why?: { ruleIds: string[] } }>(
  setting: ProjectRulesSetting,
  actions: readonly A[],
  subjects: ReadonlyMap<string, ProjectionSubject>,
  options: {
    base: { policyVersion: number; rulesHash: string };
    role: string;
    order: string;
    signal?: AbortSignal;
    runtime?: ProjectPolicyRuntime;
  },
): Promise<EffectivePolicyResult<A>> {
  const blank = {
    schemaVersion: 1 as const,
    formatVersion: null,
    projectionVersion: null,
    basePolicyVersion: null,
    defaultRulesHash: options.base.rulesHash,
    projectRulesHash: null,
    source: projectRulesSource,
    matchedIds: [] as string[],
    next: [] as string[],
  };
  if (setting.enabled === false)
    return {
      items: [...actions],
      warnings: [],
      manifest: {
        ...blank,
        state: "disabled",
        effectiveRulesHash: options.base.rulesHash,
        appliedOrderMode: "disabled",
        reason:
          setting.source === "no-matching-project"
            ? "no local checkout of this repository was selected, so no project configuration applies"
            : setting.source === "not-read"
              ? "project configuration was not read"
              : "rules.project.enabled is false",
      },
    };
  const failed = (reason: string, partial: Partial<EffectivePolicyManifest> = {}) => ({
    items: [...actions],
    warnings: [
      `Project policy error: ${reason}. The briefing is ranked by the shipped default policy only and is not the project's effective policy. ${repair[0]}.`,
    ],
    manifest: {
      ...blank,
      ...partial,
      state: "error" as const,
      effectiveRulesHash: null,
      appliedOrderMode: "error" as const,
      reason,
      next: repair,
    },
  });
  if (setting.enabled === "unknown")
    return failed(`whether project rules are enabled is unknown (${setting.reason})`);
  const runtime = options.runtime ?? {};
  let policy: CompiledProjectPolicy;
  try {
    const load = runtime.loadPolicy ?? (await engine()).loadProjectPolicy;
    policy = await load(setting.root, options.base);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return failed(failureDetail(error));
  }
  const identity = {
    formatVersion: policy.formatVersion,
    projectionVersion: policy.projectionVersion,
    basePolicyVersion: policy.basePolicyVersion,
    projectRulesHash: policy.projectRulesHash,
  };
  try {
    const evaluate = runtime.evaluate ?? (await engine()).evaluateProjectPreferences;
    const result = await evaluate(policy, actions, subjects, {
      ...runtime.worker,
      ...(options.signal ? { signal: options.signal } : {}),
      // One read is one generation: the policy object loaded above, never a cached older one.
      generation: policy.effectiveRulesHash,
      viewer: { role: options.role, order: options.order },
    });
    return {
      items: result.items,
      warnings: [],
      manifest: {
        ...blank,
        ...identity,
        state: "active",
        effectiveRulesHash: policy.effectiveRulesHash,
        appliedOrderMode: result.appliedOrderMode,
        matchedIds: result.matchedIds,
        reason:
          result.appliedOrderMode === "disabled-by-age-order"
            ? `the explicit ${options.order} order keeps the default order; project preferences apply only under order impact`
            : null,
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return failed(failureDetail(error), identity);
  }
}
