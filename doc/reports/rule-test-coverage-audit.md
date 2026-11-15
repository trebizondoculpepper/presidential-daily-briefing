# Rule test coverage audit

The #340 audit, measured on `main` plus this PR on 2026-11-15. The policy is DataScript Datalog in `src/rules/datalog/policy/*.edn`: 23 decision rules and 8 denial rules, policy version 1. Companion reports: [rule-testing-recommendation.md](rule-testing-recommendation.md) (#336, framework) and [embedded-rule-testing-boundaries.md](embedded-rule-testing-boundaries.md) (#339, host boundary).

## Summary

- **Before this audit**, 9 of the 23 decision rules were never selected by any EDN scenario, and 1 of the 8 denials (`D-DENY-OPEN-PR`) was never asserted. Three of those rules (`D-PR-CONFLICT`, `D-PR-INTEGRATE`, `D-DESIGN-REVIEW`) did not appear in the golden parity file either, so nothing exercised them through the real evaluator.
- **This PR** adds `scenarios/coverage-gaps.edn`, 10 scenarios with exhaustive expectations. Every rule now wins at least one scenario and every denial is asserted. Two tests in `rules.test.ts` keep it that way: the list of unselected rules is now empty and must stay empty, and every denial must appear in some scenario.
- **Mutation evidence:** I mutated `decisions.edn` 107 times (bounded run, see below). Deleting any rule (23 mutants) and changing any explanation (23 mutants) were all caught. Dropping one selection clause survived in 26 of 61 cases, almost all of them role or subject-kind guards with no opposite-side scenario. Follow-up: #469.
- Selection counts alone overstate coverage. Fourteen rules are selected by exactly one scenario, and only five decision rules have a scenario where they are overridden. The matrix below records each dimension separately.

## What runs the real evaluator

| Test                                                       | Evaluator                                       | What it pins                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/rules/datalog/rules.test.ts` and `npm run rules:test` | Real engine on engine facts (`scenarios/*.edn`) | Exact actions in order, kind, band, explanation text and bindings, overrides, unlocks, other claims, and the exact denial set |
| `src/rules/datalog/parity.test.ts`                         | Real adapter and engine on `Snapshot` fixtures  | Golden output for 38 fixture snapshots, each under 2 roles × 3 orders (decisions, order, denials, explanations)               |
| `src/rules/datalog/adapter.test.ts`, `boundary.test.ts`    | Real adapter and engine                         | Host facts: completeness, cardinality, types, empty values, projection to commands, engine failure                            |
| `src/rules/datalog/engine.test.ts`                         | Real engine                                     | Import boundary, reserved entities, limits                                                                                    |
| `src/rules/datalog/build.test.ts`                          | Policy build only                               | Source validation; `rules:build --check` keeps the artifact current                                                           |
| `scripts/package-test.ts`                                  | Installed CLI and MCP, both engines             | The packaged `datalog-*.mjs` chunk loads, and CLI equals MCP                                                                  |
| `src/briefing/{ranking,blended,roles,briefing}.test.ts`    | **TypeScript rollback engine**                  | The older TypeScript policy only: evidence about `briefing.engine typescript`, not about the Datalog rules                    |
| `doc/reports/examples/rule-testing/`                       | Real evaluator through an older entry point     | #336's research example; superseded by the native scenarios                                                                   |

Nothing in this list stubs the evaluator. The only tests that do not exercise Datalog at all are the TypeScript-engine tests, which test the rollback policy.

## Rule-to-scenario matrix

Columns:

- **wins:** scenarios where the rule is selected.
- **bound:** scenarios that assert its explanation bindings.
- **over:** scenarios where it is listed as overridden.
- **golden:** occurrences in the parity golden file.
- **mutants:** clause-drop mutants that survived.

| Rule               | wins | bound | over | golden | mutants (dropped guard)           | Where                                   |
| ------------------ | ---: | ----: | ---: | -----: | --------------------------------- | --------------------------------------- |
| D-ATTENTION        |    1 |     1 |    0 |     24 | 0                                 | policy-cases                            |
| D-PR-FAIL          |    5 |     5 |    0 |     30 | 1 (`pr-action`)                   | policy-cases, coverage-gaps             |
| D-PR-REVIEW        |    1 |     1 |    1 |      3 | 1 (`pr-action`)                   | **coverage-gaps** (was overridden only) |
| D-PR-CONFLICT      |    1 |     1 |    0 |      0 | 1 (`pr-action`)                   | **coverage-gaps** (was untested)        |
| D-PR-MERGE         |    3 |     3 |    0 |     18 | 0                                 | policy-cases                            |
| D-PR-INTEGRATE     |    1 |     1 |    0 |      0 | 1 (`pr-action`)                   | **coverage-gaps** (was untested)        |
| D-DECIDE           |    1 |     1 |    0 |     12 | 1 (role)                          | policy-cases                            |
| D-DOCUMENT         |    1 |     1 |    0 |      6 | 1 (role)                          | **coverage-gaps** (golden only)         |
| D-DESIGN-REVIEW    |    1 |     1 |    0 |      0 | 2 (role, `own-follow-up`)         | **coverage-gaps** (was untested)        |
| D-EASY             |    3 |     3 |    0 |     10 | 1 (role)                          | policy-cases, assessment-first          |
| D-OWN-EASY         |    1 |     1 |    0 |      0 | 1 (role)                          | **coverage-gaps** (was untested)        |
| D-COMPLEXITY-BOOST |    5 |     5 |    0 |     36 | 2 (role, `issue`)                 | assessment-first                        |
| D-COMPLEXITY       |    3 |     3 |    5 |     81 | 1 (`issue`)                       | assessment-first                        |
| D-IMPACT-BOOST     |    2 |     2 |    0 |     18 | 3 (role, `issue`, `needs-impact`) | assessment-first                        |
| D-IMPACT           |    1 |     1 |    2 |     60 | 1 (`issue`)                       | assessment-first                        |
| D-BAD-COMPLEXITY   |    1 |     1 |    0 |      0 | 2 (role, `issue`)                 | **coverage-gaps** (was untested)        |
| D-BAD-IMPACT       |    1 |     1 |    0 |      0 | 2 (role, `issue`)                 | **coverage-gaps** (was untested)        |
| D-ORDINARY         |   16 |    16 |    3 |    191 | 0                                 | all files                               |
| D-OWN              |    2 |     2 |    2 |     12 | 1 (role)                          | policy-cases                            |
| D-DESIGN           |    1 |     1 |    0 |     18 | 0                                 | policy-cases                            |
| D-UNFAVORABLE      |    1 |     1 |    0 |      4 | 1 (role)                          | assessment-first                        |
| D-OWN-UNFAVORABLE  |    1 |     1 |    0 |      0 | 1 (role)                          | **coverage-gaps** (was untested)        |
| D-INSPECT          |    5 |     5 |    0 |     60 | 2 (`issue`, `possible`)           | policy-cases                            |

Every selected action in every scenario asserts its full explanation bindings. The runner requires `:facts` and compares them exactly, so the "bound" column always equals "wins".

| Denial                 | asserted | golden |
| ---------------------- | -------: | -----: |
| D-DENY-BLOCKER         |        3 |     18 |
| D-DENY-CLAIM           |        2 |      6 |
| D-DENY-CLOSING-UNKNOWN |        1 |      6 |
| D-DENY-LABELS-UNKNOWN  |        1 |      6 |
| D-DENY-NATIVE-UNKNOWN  |        2 |     12 |
| D-DENY-OPEN-PR         |        1 |      0 |
| D-DENY-PLATFORM        |        3 |     18 |
| D-DENY-PREREQUISITE    |        1 |      6 |

Denials are asserted as an exact set per scenario, so an extra or missing denial fails the scenario.

### Other dimensions

- **Missing evidence:** every unknown-evidence denial (labels, native dependencies, closing PRs, platform) has a scenario, and `D-INSPECT` covers each of its four uncertainty causes. An incomplete PR (`pr-complete false`) is asserted to produce no merge advice.
- **Precedence:**
  - Overrides are asserted for D-COMPLEXITY (5), D-IMPACT (2), D-ORDINARY (3), D-OWN (2) and D-PR-REVIEW (1).
  - Preference ties among the four band-2 PR rules are covered only pairwise (FAIL over REVIEW). A PR that both conflicts and has requested changes, for example, has no scenario.
- **Ordering:** across-subject order is pinned by the exhaustive action lists in multi-subject scenarios and by the golden suite (three orders × two roles). The order keys themselves (urgency, unlocks, own, incomplete, created) are covered through those outputs, not one at a time.
- **Characterisation note:** a ticket with conflicting complexity evidence gets both an inspection (`D-BAD-COMPLEXITY`, band 5) and an ordinary implementation offer (`D-ORDINARY`). This matches the policy's rule that an assessment state never gates pickup, and is recorded as such. If that is not the intent, it is a policy question, not a test gap.

## Detecting deleted rules, weakened predicates and mismatched narration

I generated mutants by editing `decisions.edn` text, building each in memory with `buildPolicy`, and running every scenario with `runScenario`. There was no network or GitHub access, and the run took under a minute:

| Mutation                    | Mutants | Caught | How                                                     |
| --------------------------- | ------: | -----: | ------------------------------------------------------- |
| Delete a decision rule      |      23 |     23 | A scenario expects the rule; the unselected-rules guard |
| Change a rule's `:why` text |      23 |     23 | Exhaustive explanation text in scenarios                |
| Drop one `:when` clause     |      61 |     35 | Survivors are listed in the matrix and in #469          |

Recommendation:

- Keep the two coverage guards in `rules.test.ts`.
- Add #469's role-swap metamorphic check and kind-negative scenarios.
- Rerun the clause-drop mutation as an occasional check when policy changes, not on every CI run.

The script is about 60 lines over `buildPolicy` and `runScenario`, and could become an opt-in `npm run rules:mutate` if the owner wants it maintained. I didn't add it here, because a manual rerun gives the same evidence until the policy grows.

## Update: #469 closes the surviving mutants

#469 adds two things:

- `rules.test.ts` pins each rule's audience: its role (`pr-action` is implementers, plus a designer on a design PR they are responsible for) and its subject kind. It checks the policy's guards against that table, and reruns every scenario under each role and with each subject's kind flipped. A weakened role or kind guard now fails without needing a hand-written scenario.
- `scenarios/guard-negatives.edn` pins the last three guards: a designer's own linked documentation PR, an already assessed impact, and someone else's uncertain ticket.

Rerunning the mutation run against both gives 107 mutants, all killed.

## Follow-ups

- #469: cross-role and cross-kind negatives (the 26 surviving mutants); done, see the update above.
- The precedence combinations among band-2 PR rules fit #469 as well.
- Host-boundary gaps are tracked from #339: #448, #449 and #450 (fixed), plus that report's completeness-flag table and derived-attribute check.
