# Agent platform reports

Platform research feeds synthesis #20. Reports distinguish the researcher's actual harness/model from the target platform and documented behavior from live verification.

- [Codex](codex.md) and [independent Codex review addendum](codex-review-addendum.md). Read both: the addendum corrects batch acknowledgment, lazy SDK resume and a table-formatting error while preserving the original report.
- [Codex MCP acceptance result](codex-mcp-acceptance.md) (#252): Real app-server direct reads and automatic Codex identity selection pass after the #402 retest; multiple entries require explicit selection. Model/UI rendering and cancellation remain untested.
- [Claude Code](claude-code.md), its [review addendum](claude-code-review-addendum.md) and the [MCP acceptance result](claude-code-mcp-acceptance.md) (#253). The addendum corrects the MCP setup advice (output limit, project-scope approval) and session-binding notes.
- [Ori / OpenRouter](ori-openrouter.md) (#24): plain MCP is the baseline. Schedules and webhooks start new runs; steering into an idle session is unverified.
- [Ori MCP acceptance result](ori-mcp-acceptance.md) (#255): conditional. Ori sends no MCP cancellation, and needs `--project` because servers start in the daemon's working directory.
- [Ori Code stop hooks](ori-stop-hooks.md) (#388): no native stop hook. Mid-turn `steer` continues a turn; a steer at the natural stop was dropped. The workable adapter is an external watcher that resumes the same session with a new turn after `turn.succeeded`.
- [Ori Code stop-hook prototype](ori-stop-hook-prototype.md) (#400): native continuation observed — a natural `turn.succeeded` → shared `pdb rebrief` core returns the specific briefing → the adapter resumes the **same session** and the model echoes the delivery nonce and the first action. Reuses the shared core; no hook installed.

Other platform report paths are listed in #20; an unmerged report is not represented as delivered by this index.
