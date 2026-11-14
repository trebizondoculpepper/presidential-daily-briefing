# Codex MCP client identity implementation (#402)

Continued in the owner's requested fresh worktree on codex/402-mcp-identity after contract PR #429 merged. Recognize only the verified codex-mcp-client initialization name, then resolve the Codex harness through the shared ambiguity guard. Ori metadata still chooses its explicit per-server entry; explicit selection, project boundaries and read-only identity behavior remain covered.

Added focused injected regression coverage for exact versus near-miss names, metadata before inherited environment, saved roles, override precedence, ambiguous/missing/malformed entries and project isolation. Real-client retest evidence will be recorded in the Codex acceptance report. No TODO.md exists in this checkout.

Installed archive from 63b579a passed actual Codex 0.169.0 app-server reads with project-only startup and inherited harness markers removed: source client, persisted name and role. Adding codex.review produced ambiguity, and explicit entry recovered correctly. Identity content/mtime stayed unchanged. Local check/build passed; 1,182 tests passed with one existing skip. The report preserves earlier evidence and clearly separates this identity result from untested model/UI/cancellation behavior.
