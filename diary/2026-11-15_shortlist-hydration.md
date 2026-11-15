# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 15:35 UTC
- **Branch**: feat/368-shortlist-hydration
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

#368 (part of #294): the routine briefing read every open issue and PR with bodies, all comments, reviews, review threads and checks. The PR page alone cost 54 GraphQL points with two open PRs. The contract (doc/design/collection-profiles.md, merged in #481) asks the routine briefing to discover everything cheaply, rank, hydrate only the frontier that could be shown, re-rank, and keep unhydrated facts unknown rather than empty.

## Our Approach

Rank through the briefing itself rather than a second ranking model. Discovery items become ranking candidates (stubs) whose unread sources are empty only so the engine can run. The briefing's own `subjects` (every URL the compact report shows) is the shortlist. Hydrate those subjects plus their closing links and the open issues that mention a shown PR, re-rank, and repeat until every shown subject is hydrated. A stub is never shown: if it cannot be hydrated (bound or quota), it is withdrawn and disclosed.

## Implementation

- `src/github/shortlist.ts`: `briefing-shortlist-v1` collector. Discovery pages for issues and PRs (no bodies, comments, reviews, threads or checks; PRs carry a bounded cross-reference list). Issues are hydrated ten to an aliased request, PRs through the existing `hydratePullRequests`, at most three in flight, through one `ReadMeter`, so a quota refusal stops further sends. The result carries a `shortlist` record and the metered `collection`.
- `src/briefing/service.ts`: `readBriefing` uses the shortlist when the runtime provides it (CLI, MCP and rebrief do; `pdb serve` does not until #453). `withShortlist` attaches the record and makes the delivery view incomplete when records went unread.
- `src/cli.ts`: the plain live briefing uses the shortlist; `--full`, `--issue`, `--cache`, `--since`, `--checkpoint`, `--offline` and `--role human` keep the full snapshot.

## Outcomes

Measured live on this repository (65 issues and 2 PRs open), back to back: the full read was 6 requests, 62 points and 732 KB; the shortlist read was 11 requests (10 GraphQL, 1 REST), 13 points and 442 KB, hydrating 28 of 67 items. Subjects, ranked actions and role sections were identical to the full read. The first live comparison found a real gap: PR #570's responsibility record sits on issue #400, which no closing link names. The fix was to discover issues that cross-reference a PR. Aggregates over unhydrated items (background section totals, the delivery list) are smaller; the delivery view now says it is incomplete.

## Next Steps

The first push marked a provisional briefing incomplete (exit 2). The coordinator chose an interim default pending the owner's answer on #368: unread shortlist items alone are provisional and exit 0; a failed or quota-stopped read is still incomplete (exit 2). #453 should integrate the service cache and move `pdb serve` onto this profile.
