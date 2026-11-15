# 2026-11-15: agent setup page (#391)

Added `GET /setup` to `pdb serve`. It renders the #351 onboarding document with the server's own
origin, so the CLI and the page cannot drift.

- Client examples follow the recorded evidence only. Claude Code over HTTP is verified
  (serve-http-mcp-acceptance.md). Codex is verified only for the stdio `pdb-mcp` with absolute
  paths, so the example uses that shape rather than an invented HTTP one. Codex over HTTP (#397)
  and Ori Code (#399) are labelled unverified.
- The origin is the URL bound at startup, normalised with `new URL(...).origin`, so links never
  depend on a request Host header and never contain `//`.
- The copy buttons come from a same-origin `/setup.js`. They are created by the script, so
  without it (or without clipboard access) the page shows only selectable text and no dead
  buttons.
