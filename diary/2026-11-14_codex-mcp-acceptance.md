# Codex MCP acceptance

Recorded #252 against the installed archive from main c1e56fb, using the real Codex 0.169.0 app-server MCP client and direct tool calls without model turns. Discovery, bounded reads, identity overrides and missing/ambiguous diagnostics passed. Automatic Codex identity recognition requires explicit entry/harness configuration; follow-up #402 records the limitation. Cancellation and model/UI rendering remain untested rather than inferred.

The initial orchestration mistakenly borrowed Claude's saved identity and briefly released #335. Restored its original ownership, documented the correction on the ticket, created Codex's local identity through the normal config command, and claimed #252 as priya_xu. No Claude worktree files or PR code were changed.

Report: doc/reports/agent-platforms/codex-mcp-acceptance.md. No TODO.md exists in this checkout.
