# Testing the embedded rules at the host boundary

Research for #339. Companion to the framework recommendation in [rule-testing-recommendation.md](rule-testing-recommendation.md) (#336). Measured against `main` at `c59befe` on 2026-11-15. The policy is DataScript 1.8.1 Datalog in `src/rules/datalog/policy/*.edn`. There is no Prolog runtime, so nothing here is Prolog advice. A Prolog test framework such as PlUnit could not test this JavaScript embedding unchanged anyway.

## Summary

Correct rules can still produce wrong decisions if the host hands them wrong facts. The native EDN scenarios (`npm run rules:test`) test the rules on engine facts and deliberately skip the host. Most of the host side is reasonably covered by `adapter.test.ts`, `engine.test.ts`, the golden parity suite and the package test. Three things were missing: multi-valued relations, type conversion, and failure and explanation consistency.

Probing those gaps with the real adapter and evaluator found three defects, each reproduced by a maintained example and filed as a narrow bug:

| #    | Defect                                                                                                                                            | Direction                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| #448 | A collection warning about PR 12 marks PR 1 incomplete, because the adapter matches the warning's URL by prefix. PR 1 loses its merge action.     | Conservative, but wrong            |
| #449 | With no agent given, the viewer agent is `""`, and a bare `agent:` label maps to the owner `""`. The ticket is offered as the viewer's own claim. | Unsafe: offers someone else's work |
| #450 | An unparseable `createdAt` becomes `NaN`, so the comparator is no longer a total order. One bad ticket reorders other, valid tickets.             | Non-deterministic order            |

The examples are in `src/rules/datalog/boundary.test.ts`. Each defect is written as the correct expectation under `it.fails`, so the fix PR flips it to `it`.

## The boundary, layer by layer

```
GitHub ─collect→ Snapshot ─adapter.normalize→ datoms ─engine (phases)→ decisions
                                                                    │
CLI/MCP text, JSON ←─ service (engine choice, no fallback) ←─ adapter projection (commands)
```

| Concern                      | Where                                                                                                                                                                                                 | What can go wrong                                                                                | Covered by                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fact normalisation           | `adapter.ts` `normalize`: one entity per issue/PR from id 100, stub entities for blockers, dependents and checks outside the snapshot                                                                 | Facts lost, misnamed or attached to the wrong entity                                             | `adapter.test.ts`, parity suite                                                                                                                 |
| Completeness and unknown     | Flags `labels-complete`, `native-complete`, `reverse-complete`, `blocking-complete`, `pr-complete` and global `forward-complete`. Sentinels: `open-blockers -1`, sizes `"unknown"`, head `"not-a-pr"` | Unknown read as false or absent, so a ticket is permitted                                        | `adapter.test.ts` (native, labels, closing). New: missing assessments stay `unknown`; a PR warning applies only to that PR (prefix defect #448) |
| Multi-valued relations       | `:many` in `policy/schema.edn`                                                                                                                                                                        | A cardinality-one attribute keeps only its last value: a second owner, check or label disappears | New: every attribute the adapter repeats on one entity is declared `:many`                                                                      |
| Host-to-engine types         | `created: Date.parse(...)`, numbers, booleans, strings. String attributes only, because keyword attributes from JavaScript fail at query time (rules-component.md)                                    | `NaN`, `null` or a mixed key type reaches the comparator                                         | New: an unparseable date (defect #450). `invalid-sort-key` for mixed types is still untested                                                    |
| Missing versus false         | Viewer `agent`/`platform` default to `""`. `reviewDecision null` becomes `""`. Absent assessment becomes `"unknown"`                                                                                  | An empty string equals another empty string (defect #449)                                        | New examples                                                                                                                                    |
| Query phases                 | `engine.ts`: about 10 `init_db` rounds, each transacting derived relations (`matched`, `overridden`, `unlocks-dependent`, `unlock-count`, `active-dependent`, keys) before the next query             | A derived attribute declared cardinality-one, or a phase that reads a stale database             | Indirectly, by scenarios and parity. Recommendation 4                                                                                           |
| Effective rule and conflicts | `q0` overrides by preference. `overriddenRuleIds` from `q5`                                                                                                                                           | A losing rule still decides, or a winning rule is hidden                                         | EDN scenarios assert `:overridden` (#336, #348). New: a decision never lists its own rule as overridden                                         |
| Sort keys                    | Policy-emitted keys, `compareKeys`                                                                                                                                                                    | Not a total order (#450). Mixed types throw `invalid-sort-key`                                   | Parity order; #450                                                                                                                              |
| Explanation bindings         | Witness queries per rule. Several values become the first 8, sorted, plus `…Omitted`. A missing placeholder throws `missing-explanation-binding`                                                      | Text explains a different inference, or a partial text with `{key}` is shown                     | New: the rule IDs and explanation agree, no unfilled placeholder, bound facts equal the host input, and a missing binding is an engine error    |
| Configuration selection      | `service.ts`: `engineSetting` (config or default), role required, lazy `datalog-*.mjs` chunk                                                                                                          | An engine failure silently falls back to TypeScript and hides a broken policy                    | New: a thrown evaluator surfaces as `decision-engine-failed`, with no fallback                                                                  |
| CLI/MCP projection           | `commands.ts` templates via the adapter; `rankedActions` JSON; compact text                                                                                                                           | CLI and MCP disagree, or the packaged chunk is missing                                           | `mcpparity.test.ts`, `scripts/package-test.ts` (installed CLI = MCP for both engines)                                                           |

## What belongs where

- **Pure rule tests** (EDN scenarios, `npm run rules:test`) use engine facts in and assert decisions, denials, overrides, unlocks and explanation bindings out. They never import the adapter, and the engine import-boundary test keeps it that way. Use them for policy intent.
- **Host-contract tests** (`adapter.test.ts`, `boundary.test.ts`) take a `Snapshot` in and assert the datoms handed to the engine, or a projection. Use them for completeness flags, sentinels, cardinality, types, empty values and command rendering. Capturing the datoms (`vi.mock` of `engine.js` in `boundary.test.ts`) tests the mapping without restating the policy.
- **Service tests** cover engine selection, failure without fallback, and the order in which assessments and responsibility are read.
- **Installed-package tests** (`npm run package-test`) check that the lazily loaded chunk ships and that the CLI and MCP agree. Only the built artifact can show this.

A fixture or adapter mistake inside a full-`Snapshot` rule test looks like a rule failure (#336 report, "Isolating the layers"). New policy behaviour should therefore be tested in EDN on engine facts, and new adapter behaviour in host-contract tests on datoms.

## Recommendations

1. Fix #448, #449 and #450, each flipping its `it.fails` example. They are small and independent.
2. Decide whether readiness and other policy labels should match case-insensitively. GitHub label names are case-insensitive, but the rules compare exact strings. A ticket labelled `Status:Ready` gets neither an action nor a denial, so it vanishes from the queue without any diagnostic. This is a policy decision, not a defect, so it is left to the owner.
3. Add a table-driven adapter test with one row per completeness flag and sentinel, covering complete, truncated and absent. This fits #340's coverage audit.
4. Add an engine-side check that every derived attribute transacted between phases is either unique per entity or declared many. Add a test for the `invalid-sort-key` path.

Source placement follows doc/design/source-layout.md (#335): the examples sit in `src/rules/datalog/` beside the adapter they test. No new framework, language or production code was added.
