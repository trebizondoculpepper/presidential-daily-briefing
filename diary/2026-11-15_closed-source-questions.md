# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 17:00 UTC
- **Branch**: fix/414-orphaned-questions
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

#414: a needs-human question disappeared from the owner's view as soon as its ticket closed, usually because a merged PR closed it. Closure is not an answer. The contract is doc/reports/closed-question-discovery.md (#491, merged in #508), on top of the v2 question marker and the explicit `pdb question resolve|withdraw` records from #412.

## Our Approach

Keep the host/policy split of the human briefing. A new collector (`src/briefing/closedquestions.ts`) reads closed issues within one fixed request budget, folds explicit outcomes against the exact question they name, and hands the policy trust, marker version and outcome facts. Three new Datalog decisions (`D-HUMAN-ORPHANED-YOU`, `D-HUMAN-ORPHANED`, `D-HUMAN-ORPHANED-UNKNOWN`) decide what is shown. Anything not read is incomplete coverage, never "answered".

## Implementation

- Inventory through GraphQL `issues(states: CLOSED)` (no PRs), newest update first, with the first comment page inline; longer histories are hydrated one page per source in rotation. Default bound: 13 requests, 3 inventory pages, 10 comment pages of 100; permission lookups spend the same budget through a wrapped REST boundary.
- v2 questions settle only by a trusted explicit outcome; v1 keeps label resolution. Unread history, unverifiable resolution records or truncated labels make the outcome `unknown`, which is still shown.
- `D-ATTENTION` now requires an open subject, which is equivalent for every existing input (foreground already did) but stops a closed source's stale attention label from making an addressed-response item.
- `HumanRecord`/`parseQuestionRecord` moved to `src/briefing/questionrecord.ts` to avoid a new import cycle.

## Outcomes

Live on this repository the pass took 4 requests (3 inventory pages, 212 closed issues, 1 permission lookup) and surfaced several real orphaned owner questions (#226, #229, #230, #239, #342), which is exactly the #262 report. The parity golden changed only in rulesHash and datom counts.

## Next Steps

Not delivered, so the PR is "Part of #414": memory-only continuations across `pdb serve` requests, the overlapping `since` refresh after a finished baseline, and explicit resolution of v2 questions on open tickets (#413). On a repository with more closed issues than the bound, coverage stays incomplete until continuations exist.
