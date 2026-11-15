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
} from "./rules-command.js";
