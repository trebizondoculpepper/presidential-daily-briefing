# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: docs/336-rule-testing
- **Contributors**: Claude Code (idris_ferreira) + User

## Problem Statement

Issue #336 asks how to test the workflow rules as production code. The owner's clarification narrows it: test the native DataScript EDN rules with native EDN scenario definitions, find a compatible existing framework if practical, otherwise use a minimal TypeScript runner, and keep wrong decisions apart from parser, loader and framework failures in JUnit-compatible reports.

## Our Approach

We read the primary sources first. Upstream DataScript tests itself with `clojure.test` plus a hand-written JS assertion harness, so it has no Datalog-native test facility. PlUnit is the reference for a future Prolog, but it is SWI-first, needs a native runtime and does not document JUnit output. That left the minimal-runner path, which we hosted inside Vitest so reporting, exit codes and `verify` come for free.

## Implementation

`doc/reports/examples/rule-testing/` holds seven EDN scenarios, a small EDN reader that records line numbers, and a runner over the real `evaluateDatalog`. The runner raises `RuleDecisionFailure` or `RuleInfrastructureError`. The tests are named `id (file:line)` and include category self-tests and a metamorphic property.

## Outcomes

- **Mutations:** two hand-made policy mutations were caught as decision failures at the right scenario and line. A bracket break became an infrastructure error.
- **JUnit:** Vitest 5.1.0's reporter writes every failure as `<failure>` with `errors="0"`, so the category survives only in `type`. #394 needs to know this.
- **Coverage:** only 2 of the 31 rule and denial IDs are named in the rules tests, and no denial is asserted anywhere.

## Next Steps

The follow-ups map onto existing tickets: #348 (policy as input, a real EDN parser, `:given` as boundary facts), #340 (an ID-coverage metric and the 16 unnamed IDs), #339 (adapter tests) and #394 (classify by `type`).
