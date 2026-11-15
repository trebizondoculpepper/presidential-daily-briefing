# 2026-11-15: agent onboarding (#351)

Implemented the CLI and MCP half of doc/design/agent-onboarding.md: `pdb onboard`, the managed
AGENTS.md section, MCP instructions and the first-use hint. The web page is #391.

- The AGENTS.md writer reuses the #382 locked atomic writer. That writer was JSON-only, so its
  sequence became `updateTextFile`, with `updateJsonFile` a thin parse/serialize wrapper; the
  existing safe-write tests pass unchanged.
- Marker problems (missing, duplicated or out of order) and a hand-written pdb heading without
  markers are refused, never repaired. A lowercase `agents.md` is updated in place; two
  differently cased copies are refused; symbolic links are refused.
- The first test run wrote the hint cache in my real per-user cache directory, because CLI tests
  call `main` without injecting the store. Added `PDB_NO_FIRST_USE_HINT`, set by the Vitest
  config, the smoke runner and the package test, and removed the stray file.
- The hint is keyed by the checkout root when there is no `--repo`. That costs one local
  `git rev-parse` per text briefing, run alongside the briefing.
