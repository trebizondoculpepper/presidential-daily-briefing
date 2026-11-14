# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: docs/388-ori-stop-hooks
- **Contributors**: Ori Code (dalia_okafor) + owner

## Problem Statement

Issue #388: can a stop hook in native Ori Code run a shared script that fetches a fresh PDB role briefing and makes the agent continue? Only an agent running in Ori Code may do it.

## Our Approach

About 50 minutes, run from inside Ori Code. Sources: `--help`, the generated feature SDK, the bundled feature-authoring docs and strings from the installed binary. Bounded headless probes on a disposable directory with a synthetic nonce fixture:

- a `steer` sent mid-tool;
- a `steer` sent during the final answer;
- a `steer` sent after the turn ended;
- `--resume` with the briefing as the next prompt.

Under $0.02 in total.

## Outcomes

- Ori Code has no stop hook or turn-lifecycle feature export.
- A mid-turn `steer` was delivered and continued the turn.
- A `steer` sent during the final answer was dropped (`delivered: false`); the source does not explain why.
- `--resume` continued the same session with its context.

Recommendation: a shared core plus thin adapters. For Ori the adapter is an external watcher on `turn.succeeded` that submits one bounded resumed turn.

## Next Steps

- #400: prototype the watcher on an owned headless session.
- Attended TUI behaviour stays unverified.
- HTTP MCP acceptance waits for #390/#399.
