# Agent platform reports

Platform research feeds synthesis #20. Reports distinguish the researcher's actual harness/model from the target platform and documented behavior from live verification.

- [Codex](codex.md) and [independent Codex review addendum](codex-review-addendum.md). Read both: the addendum corrects batch acknowledgment, lazy SDK resume and a table-formatting error while preserving the original report.
- [Codex MCP acceptance result](codex-mcp-acceptance.md) (#252): Real app-server direct reads and automatic Codex identity selection pass after the #402 retest; multiple entries require explicit selection. Model/UI rendering and cancellation remain untested.
- [Codex HTTP MCP acceptance](codex-http-mcp-acceptance.md) (#397): conditional pass for real app-server discovery, project/identity/role selection, shared cache reuse and same-client server-restart recovery. Model/UI rendering, cancellation and notifications remain untested.
- [Claude Code](claude-code.md), its [review addendum](claude-code-review-addendum.md) and the [MCP acceptance result](claude-code-mcp-acceptance.md) (#253). The addendum corrects the MCP setup advice (output limit, project-scope approval) and session-binding notes.
- [Claude Code HTTP MCP acceptance](claude-code-http-mcp-acceptance.md) (#395): conditional real-client pass for role views, unattributed reads, focused detail, cache reuse and same-client restart recovery. Second-project acceptance hit the native 500-subject bound; cross-project/client isolation remains unverified. The client reported about USD 0.175 in list-price usage and eight turns despite a requested six-turn flag.
- [Ori / OpenRouter](ori-openrouter.md) (#24): plain MCP is the baseline. Schedules and webhooks start new runs; steering into an idle session is unverified.
- [Ori MCP acceptance result](ori-mcp-acceptance.md) (#255): conditional. Ori sends no MCP cancellation, and needs `--project` because servers start in the daemon's working directory.
- [Ori Code stop hooks](ori-stop-hooks.md) (#388): no native stop hook. Mid-turn `steer` continues a turn; a steer at the natural stop was dropped. The workable adapter is an external watcher that resumes the same session with a new turn after `turn.succeeded`.
- [Ori Code stop-hook prototype](ori-stop-hook-prototype.md) (#400): native continuation observed — a natural `turn.succeeded` → shared `pdb rebrief` core returns the specific briefing → the adapter resumes the **same session** and the model echoes the delivery nonce and the brief's repo/agent prefix (the full action id echo was not confirmed, so delivery is not over-claimed). Reuses the shared core; no hook installed.

- [Codex Stop hooks](codex-stop-hooks.md), the [Codex Stop-hook prototype](codex-stop-hook-prototype.md), [Codex natural-stop semantics](codex-natural-stop-semantics.md) and [Codex thread binding](codex-thread-binding.md).
- [Claude Code Stop hooks](claude-code-stop-hooks.md): the same-turn continuation observed in print mode.
- [Ori installer acceptance](ori-install-acceptance.md) (#583).
- [OpenCode MCP acceptance](opencode-mcp-acceptance.md) and the [OpenCode idle wake-up report](../opencode-idle-wakeup.md) (#23).
- [Antigravity](antigravity.md) (#264) and [Antigravity natural-stop semantics](antigravity-natural-stop-semantics.md); [Gemini CLI](gemini-cli.md) is history, replaced by Antigravity.
- [GitHub Copilot](github-copilot.md) (#227), [Cursor](cursor.md) (#228) and [Pi](pi.md) (#231): desk research; no session of these clients was run.
- [Cline](cline.md) (#229) and [Goose](goose.md) (#230): historical reference only, excluded from active integration by owner decision.

The cross-platform synthesis is the [integration plan](integration-plan.md) (#20).
