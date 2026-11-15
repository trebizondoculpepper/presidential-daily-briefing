/**
 * Entry point for the lazily loaded Datalog evaluator. It stays at this path so the bundle
 * still emits the single `dist/datalog-*.mjs` chunk that package-test and the `files` allowlist
 * expect. The host adapter is adapter.ts and the pure engine is engine.ts.
 */
export {
  evaluateDatalog,
  DatalogError,
  rulesHash,
  policyVersion,
  compareKeys,
  type DatalogOptions,
  type QuestionRecordFact,
  type DatalogResult,
  type DatalogAction,
  type Explanation,
} from "./adapter.js";
export {
  rulesDocument,
  rulesText,
  rulesHelp,
  RulesArgumentError,
  RulesArtifactError,
  type RulesDocument,
  type RulesContext,
  type EffectiveSettings,
} from "./rules-command.js";
// Bounded native project-preference evaluation (#515), enabled by configuration (#516). Exported
// here so the loader, projection and packaged worker are part of this single evaluator chunk.
export {
  evaluateProjectPreferences,
  ProjectEvaluationError,
  type ProjectEvaluation,
  type ProjectEvaluationOptions,
} from "./project/evaluate.js";
export { loadProjectPolicy } from "./project/compile.js";
export { projectionSubjects } from "./project/projection.js";
