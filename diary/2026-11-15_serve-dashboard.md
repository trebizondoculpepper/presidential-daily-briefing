# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 UTC
- **Branch**: feat/374-dashboard
- **Contributors**: Claude Code (idris_ferreira) + User

## Problem Statement

#374 replaces the `pdb serve` placeholder page with the minimal read-only dashboard confirmed on 2026-11-15: choose a project, then a role, and see the ranked next steps with reasons and commands, plus freshness, refresh and failure state. The dashboard does no ranking of its own and no background prefetch.

## Our Approach

The page reads only the existing `/api/v1/status` and `/api/v1/briefing`. To keep application code in TypeScript and avoid any inline script under a strict CSP, the browser script is served from the source text of two self-contained TypeScript functions: pure renderers and a client. Tests run the renderers directly and execute the served script in a `vm` context with a fake DOM.

## Pitfall Found

Running from source, tsx wraps inner functions in `__name(fn, "name")` (esbuild `keepNames`), which does not exist in a browser. The built bundle does not. A one-line shim in the served script fixes it. The check was to start both `node dist/cli.mjs serve` and `npx tsx src/cli.ts serve` and run the fetched `/dashboard.js` standalone.
