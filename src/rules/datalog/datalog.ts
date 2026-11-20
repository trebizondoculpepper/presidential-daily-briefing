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
  rulesFormalText,
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
export { loadProjectPolicy, compileProjectPolicy } from "./project/compile.js";
export { starterProjectRules } from "./project/starter.js";
export { projectionSubjects, projectionLimits, protectedBands } from "./project/projection.js";
export { workerLimits } from "./project/worker.js";
export { projectionVocabulary } from "./project/grammar.js";
export {
  selectClaimRuleReminders,
  formatActionRuleRemindersText,
  claimObligationsHash,
  obligationsHashOf,
  RULE_REMINDERS_SCHEMA_VERSION,
  RULE_REMINDERS_MAX_ITEMS,
  RULE_REMINDERS_MAX_CODE_POINTS,
  type ReminderAction,
  type ClaimOutcome,
  type RuleReminderCategory,
  type RuleReminderSourceKind,
  type ClaimReminderFactInput,
  type SelectClaimRemindersInput,
  type RuleReminderItem,
  type ActionRuleReminders,
} from "./action-reminders.js";
export {
  evaluateUnassignDecision,
  type UnassignDecision,
  type UnassignDecisionCode,
  type UnassignPermission,
  type UnassignRuleFacts,
} from "./unassign.js";
