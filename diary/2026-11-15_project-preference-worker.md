# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 06:30 UTC
- **Branch**: feat/515-project-worker (stacked on feat/515-project-priorities)
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

#515: evaluate a validated native project policy (#514) in isolation and admit its priority/reason output only for the exact actions the shipped default policy already admitted, per doc/design/native-project-rules.md. No activation, configuration or model.

## Our Approach

Two stacked slices. Part 1 is pure: `projection.ts` builds the closed read-only action database (protected bands 1 and 2 excluded), `admission.ts` validates an untrusted result as a whole and applies it by a stable within-band sort, then re-checks that every action, band position, command and default explanation is unchanged. Part 2 adds `worker.ts` (a fixed eval-string worker that loads only DataScript from a path the parent resolves) and `evaluate.ts`, which composes them.

## Implementation

- The worker is a source string, not a separate file, so the packaged build keeps its single `dist/datalog-*.mjs` chunk and needs no new allowlisted file. `process.getBuiltinModule` loads worker_threads and module in both CommonJS and ESM eval modes; plain `require` failed when the parent ran with `--input-type=module`.
- Limits (5 s startup, 500 ms evaluation, 128 MiB heap, 5,000 tuples, 256 KiB output) can be lowered by callers but never raised. The parent enforces the output cap and deadlines itself and terminates the worker before settling.
- `projection.ts` declares its own one-attribute schema instead of importing grammar.ts, because grammar.ts pulls in the development-only EDN reader; a test holds the two schemas equal.
- package-test imports the installed chunk in a separate Node process and runs the worker from it.

## Outcomes

- The #499 counterexample is reproduced through the real adapter: another owner, incomplete labels, an open blocker and incomplete blocker evidence stay unadmitted; a catch-all priority-1000 preference only reorders admitted actions, and forged identities are rejected.
- Representative 500-action projection with the schema fixture: about 55 ms including worker startup on an Apple-silicon laptop, well inside the deadlines. Windows CI timing comes from the PR's CI run.
- `[?b "pdb.unlocks" ?x] [?c "pdb.unlocks" ?y] [(+ ?x ?y) ?s]` beside the action relation exhausts a 4 GiB heap on the main thread in about 7 s; in the worker, the 128 MiB heap is reached in roughly 470 ms here, so the deadline and the heap limit race. Tests that need a specific diagnostic lower the deadline (or heap) rather than depend on that race.

## Next Steps

#516: program-mediated enablement, generation/caching, effective English and CLI/MCP/web parity. It must call `evaluateProjectPreferences` on the complete default queue before the display limit is applied.
