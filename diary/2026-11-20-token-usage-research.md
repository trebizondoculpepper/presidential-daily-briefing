# Development Diary Entry - 2026-11-20

## Context

- **Date**: 2026-11-20 18:45 UTC
- **Branch**: research/802-token-usage
- **Contributors**: Claude Code (kavya_sabbagh)

## Problem Statement

#802 asked whether an agent's token usage can be attributed to a ticket between claim and submit, with one real trial in the researcher's own client.

## Our Approach

I used this Claude Code session as the trial client. I checked what a PDB subprocess can see (the session ID), surveyed the usage fields in the local transcript (metadata only), checked them against the Agent SDK cost-tracking documentation, and measured two spans with a small harness.

## Outcomes

- `CLAUDE_CODE_SESSION_ID` reaches subprocesses and names the session transcript, so no wrapper is needed for Claude Code.
- Responses repeat across records: deduplicate by message ID, as the SDK documentation says.
- A time window over-attributes when one session works on several tickets; the #706 window included review fixes on other PRs.
- The transcript can lag the live session; reconcile later.
- Output counts look real here, but the SDK documents them as placeholders; marked uncertain.

## Next Steps

After review, file per-platform verification tickets for the untested matrix rows, and a contract ticket for span boundaries at claim, wait, resume, release and submit.
