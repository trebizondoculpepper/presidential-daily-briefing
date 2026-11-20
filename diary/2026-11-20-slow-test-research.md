# Development Diary Entry - 2026-11-20

## Context

- **Date**: 2026-11-20 16:30 UTC
- **Branch**: research/706-slow-tests
- **Commit**: research on f26ab89
- **Contributors**: Claude Code (kavya_sabbagh)

## Problem Statement

#706 asked for evidence-backed ways to shorten the slowest tests without losing fault detection, as a report with manual experiments and small follow-up tickets.

## Our Approach

I measured the full suite locally, compared the CI JUnit artifacts for the ticket's baseline run with today's, profiled one native evaluation by datascript call, compared three shapes of the role/kind metamorphic matrix, and injected three guard deletions in memory to see which shapes still catch them.

## Implementation

`doc/reports/slow-test-redundancy.md`, plus three manual harnesses in `doc/reports/examples/slow-tests/`. No test, CI, policy or runtime change.

## Outcomes

- `rules.test.ts` grew from 131 s to 1157 s on CI Ubuntu in four days, mostly through about 4.5× costlier evaluations as the policy doubled.
- 44% of evaluation time is one query family re-deriving `foreground` per decision query.
- Flipping all subject kinds at once keeps detection for 22% less matrix time. Dropping the role axis loses role-guard detection. Scenario expectations alone catch almost no guard loss.
- Running probes in memory through `buildPolicy`'s reader avoided any worktree or file mutation.

## Next Steps

File the four follow-ups listed in the report after review; the engine materialization needs its own reviewed design.
