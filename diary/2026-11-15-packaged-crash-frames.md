# Development Diary Entry - 2026-11-15

## Context

- **Date**: 2026-11-15 20:40 UTC
- **Branch**: feat/629-sentry-source-maps
- **Contributors**: Claude Code + User

## Problem Statement

#629: crash reports from the installed package named bundle lines (`dist/cli.mjs:28952`), not source files. The #623 live check proved delivery only, because its fault came from an external preload.

## Our Approach

Ship position-only source maps with the bundles and map built frames inside the sanitiser at report time, instead of a build-time authenticated upload or Node's global source-map switch. The upload would need a token, a release pipeline and `debug_meta`, which the allowlisted event omits. The global switch only maps modules loaded after it is enabled, and it produces paths the containment check rejects.

## Implementation

- `--sourcemap` builds plus `scripts/sourcemaps.ts`, which fails on any non-`../src/` source and strips `sourcesContent`.
- `mappedFrame` in `src/telemetry/crashes.ts`: reads only the map beside a verified built file, takes exact line hits only, and keeps the `src/` allowlist.
- `scripts/package-test.ts`: installs the real archive and faults it through PDB's own listener code with a test-only preload (`scripts/crash-preload.ts`) that records envelopes locally and refuses all network.

## Outcomes

The installed serve fault reports `src/serve.ts:264 <- src/serve.ts:102`, and the installed MCP fault reports `src/mcp.ts:50`. Labels, release and environment are asserted, and nothing private leaks. A first attempt to fault MCP through malformed stdin failed: the MCP SDK swallows exceptions from `onerror`. The SIGTERM `process.exit` path in `--poll` mode worked.

## Next Steps

Owner: optional live check with the approved DSN using the commands in the design doc, and rollout approval for a release containing the maps.
