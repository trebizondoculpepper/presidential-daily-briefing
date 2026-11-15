# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 04:45 UTC
- **Branch**: feat/197-ticket-view
- **Commit**: based on 50cb49e
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

#197 asks for one bounded, ticket-centred read that combines an issue with its associated pull requests, so an agent no longer needs an issue read plus a `pr N` per PR. The binding contract is doc/design/consolidated-ticket-view.md (#477).

## Our Approach

Compose existing reads under one meter rather than build a new collector. The focused `who N` plan (#367) was split into `readWhoLive` and a reusable `readWhoWith(meter, ...)`, so the ticket view shares the issue, comment, linked-PR, delivery-record and member reads and their quota stop. `collectIssueFocus` gained an opt-in `nativeEdges` flag that selects the direct native edges with the issue (no extra request). One bounded query lists every closing reference including closed and merged PRs, and the shared `pullRequestStatus` service reads at most `--limit-prs` PRs, required members first, three at a time through `hydrate`, which stops scheduling after a quota refusal.

## Implementation

- `src/workflow/ticketstatus.ts`: `readTicketStatus`, `ticketStatusText`, the `ticket-status` v1 document.
- `src/github/readplan.ts`: registered `ticket-status-v1` profile (issue detail plus PR status sources and bounds).
- `src/cli.ts`: `pdb ticket N` with `--limit-prs`, `--max-chars`, `--json`, `--agent`, `--platform`, `--repo`, `ticket --help`.
- Tests in `src/workflow/ticketstatus.test.ts` with injected GraphQL/REST/clock.

## Outcomes

- Live, read-only on this repository: `ticket 197` 3 requests (GraphQL cost 2, 13.6 KB, ~1.2 s); `ticket 367` 4 requests (cost 4, 31.9 KB, ~2.1 s, one merged PR read in detail). For comparison `--issue 367 --json` took 5 requests, cost 61, 728 KB, ~4.1 s.
- Every source that is not complete becomes a warning and exit 2; omitted, failed and not-attempted PRs stay listed as unknown.

## Next Steps

- #454: `GET /api/v1/tickets/{n}` and the dashboard page over `readTicketStatus`, including serve cache and quota cooldown.
- MCP exposure is a later additive wrapper.
