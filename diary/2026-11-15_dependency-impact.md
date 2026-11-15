# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 UTC
- **Branch**: feat/196-bounded-tree → feat/196-direct-impact → feat/196-dependency-impact (stacked)
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

#196: routine dependency questions ("what can start now?", "what completion unlocks the most?") should be answered from lightweight direct edges, while the full tree stays an explicit, expensive and bounded diagnosis that never reports truncation as completeness. Binding contract: doc/design/collection-profiles.md, "Direct unlock evidence: #196".

## Our Approach

Three stacked PRs. (1) Bound `deps N --tree` with `--max-nodes` (default 50) under a `dependency-tree-v1` profile; a stopped walk returns `treeBounds.complete: false`, the identities not read and a "more not read" notice, in the CLI and the MCP view. (2) Routine `deps N` reads, under `dependency-direct-v1`, the ticket's eligibility facts plus those of at most 50 last-open-blocker dependants, then a pure briefing module reuses `pickupEligibility`, `otherwiseEligible` and `immediateUnlocks` for start-now, newly pickable, still blocked, not pickable, unknown and one next action. (3) `deps --top` ranks a bounded discovery inventory with `rankPickup` and `immediateUnlocks`.

## Outcomes

- Every read goes through the ReadMeter, so a quota refusal stops further requests and the partial result says so.
- Injected 161–189 issue graphs pin request counts (1–3 for routine reads, 50 for a default tree, 4 inventory pages) and output size.
- Live, read-only on #196 (no dependants, one closed blocker): before, `deps 196` 1 request / 4,379 B / 0.99 s and `--tree` 2 requests / 7,646 B / 1.28 s; after, 1 request / 6,582 B / 0.86 s and 2 requests / 7,720 B / 1.22 s (complete tree). `deps --top`: 2 requests, 6,590 B output, 1.92 s.
- Gotcha: GitHub dependants' own `blocking` edges are not read in a direct read, so they are marked truncated to keep anything downstream of them unknown rather than zero.

## Next Steps

MCP `triage_dependencies` still returns the relationship view without the impact section; exposing it there is a follow-up if wanted.
