# Claude Code: natural completion versus user interruption (#637)

Focused follow-up to #386 and the [idle wake-up report](claude-code-idle-wakeup.md), for the shared rebrief core ([doc/rebrief.md](../rebrief.md)) and the [approved continuation contract](../design/approved-continuation-limits.md). It answers one question: can a thin Claude Code adapter call installed PDB for a fresh role briefing only after a **natural** end of turn, and what trusted context does it have?

## Provenance

| Item          | Value                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Native client | Claude Code 2.1.328 (CLI), running this research session                                                                  |
| OS / runtime  | macOS (Darwin 27.2.0), Node 26.7.0                                                                                        |
| Researcher    | agent `kavya_sabbagh` (implementer), inside Claude Code                                                                   |
| Date          | 2026-11-19                                                                                                                |
| Documentation | [Claude Code hooks reference](https://code.claude.com/docs/en/hooks.md), sections cited below                             |
| Observation   | This session runs a user-configured `Stop` hook; its continuation text arrives to the model labelled `Stop hook feedback` |

No hook, settings file, trust decision or ticket state was changed for this research. No paid model trial was run beyond this ordinary working session. Items marked **documented** come from the reference; **observed** items come from this session; **unknown** items are neither.

## Event semantics

| Situation                            | What Claude Code does                                                                                                                                                      | Basis                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Natural end of the main agent's turn | Fires `Stop`                                                                                                                                                               | Documented (`### Stop`: "Runs when the main Claude Code agent has finished responding")                                                    |
| User interrupt (Esc / Ctrl-C)        | **Does not fire `Stop`**                                                                                                                                                   | Documented (`### Stop`: "Does not run if the stoppage occurred due to a user interrupt")                                                   |
| API error ending the turn            | Fires `StopFailure` instead of `Stop`; hook output and exit code are ignored (no decision control)                                                                         | Documented (`### StopFailure`); `error` is one of `rate_limit`, `authentication_failed`, `server_error`, `max_output_tokens`, …, `unknown` |
| Crash or disconnection               | Not described                                                                                                                                                              | Unknown                                                                                                                                    |
| Turn continued by a Stop hook        | The next `Stop` carries `stop_hook_active: true`                                                                                                                           | Documented (`#### Stop input`)                                                                                                             |
| Consecutive hook continuations       | After eight in a row Claude Code overrides the next block and ends the turn; the count resets whenever the model calls a tool; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it | Documented (`#### Stop input`)                                                                                                             |
| Subagent finishing                   | Fires `SubagentStop` (not `Stop`), including some internal agents                                                                                                          | Documented (`### SubagentStop`)                                                                                                            |
| Session start / resume               | Fires `SessionStart` with `source` = `startup`, `resume`, `clear`, `compact` or `fork`                                                                                     | Documented (`### SessionStart`)                                                                                                            |
| Interruption marker in any payload   | None documented                                                                                                                                                            | Unknown                                                                                                                                    |

**Consequence for PDB:** explicit user stops win by construction. An interrupted turn never reaches a Stop hook, so the adapter cannot accidentally continue it. A `Stop` event is therefore the native evidence for `--reason natural`; a `StopFailure` maps to `failure` (and cannot continue anything); there is no event to map to `user-stop`, because none is delivered. The adapter must not infer anything from a missing event.

## Trusted context in the Stop payload

Documented `Stop` input: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` (plus common fields the reference also lists, including `prompt_id`).

- **Session binding:** `session_id` is the native session identity the shared core's `session` needs; `cwd` gives the project checkout for `--project`.
- **Event identity:** the payload carries **no documented per-Stop event ID**. A unique `--event` must be derived from documented fields (for example `session_id` plus `prompt_id`, if present, plus a monotonic per-session counter kept by the adapter). This is the main open item; see "Unknown".
- **Delivery evidence:** returning `decision: "block"` with `reason` (or exit 2 with stderr, or `hookSpecificOutput.additionalContext`) is documented to deliver that text to the model as the reason to continue. Observed in this session: the text appears in the next model turn as `Stop hook feedback`. This is the closest thing to model-visible receipt Claude Code offers; it is synchronous with the hook's own response, not a later acknowledgement.
- **Not trusted:** `last_assistant_message` and the transcript are model output, not authority; `transcript_path` may not yet contain the final message at Stop time (documented). PDB should not read either.
- **Busy versus done:** `background_tasks` and `session_crons` distinguish a session that is paused waiting for background work from one that is finished (documented). A continuation offer while background work is pending would compete with it; the adapter should stop normally then.

## Re-entry and the native cap

`stop_hook_active: true` means the current turn exists because a Stop hook continued it. That is a native re-entry signal, but not a reason to refuse: an approved continuation loop legitimately produces it. PDB's own protections remain the authority: a duplicate event is refused, an unacknowledged offer blocks the next one, an unchanged fingerprint stops, and the session store serializes callbacks (#1074, #1076).

Claude Code's eight-consecutive-continuation cap is a **native constraint, not a PDB budget**. It resets on any tool call, so ordinary work (which calls tools) does not hit it; a loop of text-only continuations does. The contract forbids presenting it as a PDB limit; the adapter should report "native continuation cap reached" when Claude Code overrides a block, and must not raise it silently through the environment variable.

## Session initialization

`SessionStart` with `source: "startup"` (or `"fork"`) is documented native evidence of a new session, which is what `ensureSession` requires (`kind: "session-start", verified: true`). `resume` and `compact` keep the same `session_id` and must reuse the existing binding, never reset it, which `ensureSession` already guarantees. Whether `clear` keeps the same `session_id` is not documented; until observed, treat `clear` as reuse-if-present and never as a reset. `SessionStart` runs before MCP servers are available and should stay fast (documented), which suits a local `ensureSession` call.

## Adapter recommendation

A thin command hook, with all policy in shared PDB:

1. `SessionStart` (`startup`/`fork`) → `ensureSession` with verified session-start evidence; `resume`/`compact`/`clear` → reuse only.
2. `Stop` → `pdb rebrief check --reason natural` with the session binding and a derived unique event ID; on `continue`, return `decision: "block"` with the briefing as `reason`, then acknowledge that exact event/fingerprint; on any other result, exit 0 with no output so Claude Code stops normally.
3. `StopFailure` → no PDB call (no decision control; nothing to deliver).
4. Pending `background_tasks` → stop normally without a PDB read.
5. No hook for interrupts: none is delivered, and none is needed.

Installation, trust and settings writes belong to the attended installer work (#582) and the native-adapter slice of #657, not to this research.

## Unknown, and the exact owner test

Unknown: a documented per-Stop event identifier; whether `Stop` or `StopFailure` fires on a crash or disconnection; whether `/clear` keeps `session_id`; whether the acknowledgement-by-response model holds when the hook process is killed at its timeout.

Exact manual test (attended, disposable project, no live ticket writes):

1. In a scratch checkout, add a project `.claude/settings.local.json` Stop hook that only appends the sanitized payload keys and `stop_hook_active` to a private temp file and exits 0; accept the workspace trust dialog.
2. Ask for a short task and let it finish: expect exactly one `Stop` record with `stop_hook_active: false`.
3. Start a long task and press Esc mid-turn: expect **no** `Stop` record.
4. Run `/clear`, then a task: record whether `session_id` changed.
5. Change the hook to return `decision: "block"` once with a fixed reason: expect the model to see `Stop hook feedback`, and the following `Stop` to carry `stop_hook_active: true`.
6. Remove the hook file and the temp file.
