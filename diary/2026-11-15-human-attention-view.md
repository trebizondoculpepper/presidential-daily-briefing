# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 21:15 UTC
- **Branch**: feat/458-human-attention-view
- **Contributors**: Claude Code + User

## Problem Statement

#458: a read-only human attention view in `pdb serve`, the human mode of the Work page, rendering the shared human briefing. Actionable items come first, then a separate Waiting section.

## Our Approach

The page renders the existing `/api/v1/briefing?role=human` envelope without re-ranking. It is server-rendered per request, so the project is validated before any script runs, which matches the shell seam in served-page-shell.md. Its script reuses the dashboard's escaping and state renderers.

## Implementation

- `src/serve/human-page.ts`: the page, its renderers, and a client with an AbortController, a generation check and a project match.
- `/human` and `/human.js` routes added in `src/serve.ts`.
- The dashboard's Role selector gains `human`, which opens the page.
- Waiting is decided by the projection's own `resolution: "unknown"`.

## Outcomes

- The API parity, route safety, renderer, escaping and sandboxed-script tests pass.
- Headless Chrome on macOS will not lay out narrower than 500px from `--window-size`. The narrow screenshots therefore used DevTools-protocol device-metrics emulation, which also reports scrollWidth: no horizontal overflow at 390px.

## Next Steps

Ask the owner whether the Waiting definition (resolution unknown) is right. Move the page header onto the shared toolbar when #605 lands.
