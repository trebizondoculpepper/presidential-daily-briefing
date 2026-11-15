# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 03:30 UTC
- **Branch**: feat/367-focused-reads (stacked on feat/367-read-telemetry)
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

#367: `--issue N`, `deps N`, `pr N` and `who N` should read only their target and its direct links, with typed source coverage and per-read cost, as doc/design/collection-profiles.md describes.

## Our Approach

Measure first with a logging `gh` shim, then add a shared read meter and coverage map, then change only the commands that actually collected the repository. Reading the code showed `deps N` and `pr N` were already single-target reads, and the contract explicitly keeps `--issue N` as the full compatibility intake. Only `who N` collected the whole open inventory (about 61 GraphQL points and 730 KB on this repository).

## Implementation

- `src/github/readplan.ts`: registered profiles, `ReadMeter` (aliased `rateLimit{cost}` selection, returned bytes, null unknown cost, REST status), `hydrate` (at most three at once, stops after a quota refusal). It imports nothing from the collectors, to avoid a new import cycle.
- Part 1: `collection` on `deps N`, `pr N` and `--issue N`; metered permission lookups through `trustWith`.
- Part 2: `collectIssueFocus` and `readWhoLive`, shared by the CLI and `pdb serve`.

## Outcomes

- `who 500` went from 4 GraphQL requests / 61 points / 731 KB to 3 / 3 / 21 KB with identical JSON apart from `collection`.
- `includeClosedPrs:false` on `closedByPullRequestsReferences` still returned a MERGED PR live, so the open-state filter is load-bearing.
- The `--issue` collection record covers the snapshot read only; the briefing's later delivery reads are not yet metered there.

## Next Steps

#368 (briefing two-phase read), bounded `deps --tree` traversal, and metering the briefing's delivery reads.
