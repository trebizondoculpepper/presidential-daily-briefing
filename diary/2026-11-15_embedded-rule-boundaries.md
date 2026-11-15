# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 UTC
- **Branch**: docs/339-embedded-rule-boundaries
- **Contributors**: Claude Code (idris_ferreira) + User

## Problem Statement

#339 asks what can go wrong where the application embeds the DataScript rules. The question is not whether the predicates are correct, but whether the host supplies complete, correctly typed and correctly related facts, and whether it reports failures and explanations faithfully.

## Our Approach

We read the adapter, the engine and the service path, then probed suspected weak points with the real evaluator before writing anything up. Each confirmed defect became a maintained example under `it.fails`, so its fix flips the example. We captured the adapter's datoms with `vi.mock` of `engine.js` instead of exporting internals.

## Outcomes

- Three defects, filed narrowly as #448, #449 and #450.
- Six passing boundary examples: cardinality, missing versus unknown, warning scoping, explanation consistency, missing binding, and no silent fallback.
- An open policy question: label case-sensitivity.

## Next Steps

Fix #448, #449 and #450. The owner should decide on label case. The table-driven completeness test and the derived-attribute check belong with #340.
