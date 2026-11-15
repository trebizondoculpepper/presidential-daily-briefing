# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 18:30 UTC
- **Branch**: fix/414-orphaned-questions-2
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

Finish #414 after #607: keep the closed-ticket scan's progress in `pdb serve` between requests with an incremental `since` refresh, and stop v2 questions on open tickets resolving by label removal.

## Our Approach

The scan became a small state machine (`ClosedScanState`) held in a per-project/repository slot of a `ClosedQuestionStore` that the serve cache owns, so the JSON API and `/mcp` share it and a manual refresh or login change discards it. The question fold moved to `src/briefing/questionfold.ts` and now serves open tickets too; the policy gained `asking-record`/`record-pending`, so a v2 question asks until an explicit outcome whatever its labels, while facts without a version keep the legacy rule (parity golden unchanged apart from rulesHash/datoms).

## Outcomes

Cursors advance only after a page is read; the watermark advances only after a whole pass, with a five-minute overlap. Requests on one scan are serialised. #413 (idris_ferreira, PR #606) only touches claim ranking, so the open-ticket question semantics were done here and noted in blocked-retained-claims.md.

## Next Steps

None for #414 beyond review. Scan progress is memory-only by contract; a restart begins a new baseline and says so.
