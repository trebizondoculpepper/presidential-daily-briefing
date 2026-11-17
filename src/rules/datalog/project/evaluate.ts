/**
 * Native project preferences over the shipped default queue (#515,
 * doc/design/native-project-rules.md). Composes the immutable projection, the bounded worker and
 * exact-action admission. The result is either the whole validated preference ordering or an
 * explicit ProjectEvaluationError; a partial override is never returned. Nothing here enables a
 * project policy, reads configuration or performs mutation checks: callers (#516) decide when a
 * policy applies, and command permission/completion checks stay with their own fresh services.
 */
import type { CompiledProjectPolicy } from "./compile.js";
import { ProjectEvaluationError, projectActions } from "./projection.js";
import type { AdmittedAction, ProjectionSubject, ProjectionViewer } from "./projection.js";
import { admitProjectResult, applyProjectPreferences } from "./admission.js";
import type { ProjectedAction } from "./admission.js";
import { runProjectWorker } from "./worker.js";
import type { WorkerOptions } from "./worker.js";

export { ProjectEvaluationError } from "./projection.js";

export interface ProjectEvaluationOptions extends WorkerOptions {
  /** The effective policy generation this evaluation is for; results for another are refused. */
  generation: string;
  viewer: ProjectionViewer;
}
export interface ProjectEvaluation<A extends AdmittedAction> {
  /** `disabled-by-age-order`: an explicit age order keeps the default order exactly. */
  appliedOrderMode: "impact" | "disabled-by-age-order";
  generation: string;
  effectiveRulesHash: string;
  projectRulesHash: string;
  /** The complete default queue, reordered within adjustable bands and annotated. */
  items: ProjectedAction<A>[];
  /** Matched project preference IDs, in policy order. */
  matchedIds: string[];
}

type Actions = AdmittedAction & { ruleIds?: string[]; why?: { ruleIds: string[] } };

export async function evaluateProjectPreferences<A extends Actions>(
  policy: CompiledProjectPolicy,
  actions: readonly A[],
  subjects: ReadonlyMap<string, ProjectionSubject>,
  options: ProjectEvaluationOptions,
): Promise<ProjectEvaluation<A>> {
  if (policy.phase !== "validated-project-policy" || policy.projectionVersion !== 1)
    throw new ProjectEvaluationError(
      "invalid-policy",
      "only a validated projection v1 policy is evaluated",
    );
  const identity = {
    generation: options.generation,
    effectiveRulesHash: policy.effectiveRulesHash,
    projectRulesHash: policy.projectRulesHash,
  };
  // Explicit age order is the viewer's choice; a project cannot defeat it.
  if (options.viewer.order !== "impact")
    return {
      appliedOrderMode: "disabled-by-age-order",
      ...identity,
      items: [...actions],
      matchedIds: [],
    };
  const projection = projectActions(actions, subjects, options.viewer);
  const raw = projection.identities.size
    ? await runProjectWorker(
        {
          ...identity,
          datoms: projection.datoms,
          schema: projection.schema,
          rules: policy.rules,
          preferences: policy.preferences.map((p) => ({
            id: p.id,
            matchQuery: p.matchQuery,
            query: p.query,
            witnesses: Object.entries(p.witnesses),
          })),
        },
        options,
      )
    : {
        version: 1,
        ...identity,
        preferences: policy.preferences.map((p) => ({ id: p.id, matched: [], rows: [] })),
      };
  const admitted = admitProjectResult(raw, policy, projection, options.generation);
  if (options.isCurrent && !options.isCurrent())
    throw new ProjectEvaluationError("stale-generation", "the policy changed");
  if (options.signal?.aborted)
    throw new ProjectEvaluationError("cancelled", "the evaluation was cancelled");
  const matched = new Set([...admitted.matches.values()].flatMap((m) => m.matchedIds));
  return {
    appliedOrderMode: "impact",
    ...identity,
    items: applyProjectPreferences(actions, admitted),
    matchedIds: policy.preferences.map((p) => p.id).filter((id) => matched.has(id)),
  };
}
