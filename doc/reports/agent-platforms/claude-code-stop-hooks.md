# Claude Code stop hooks and a shared PDB rebrief/continue script (#386)

## Provenance

| Item               | Value                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Researcher harness | Claude Code 2.1.328 (CLI); agent `kavya_sabbagh`, model Claude Opus 5.5                                                                                                                  |
| Target client      | Claude Code 2.1.328, `claude -p` (print mode) for the trial                                                                                                                              |
| OS / runtime       | macOS (Darwin 27.2.0), Node 26.7.0                                                                                                                                                       |
| Date               | 2026-11-19                                                                                                                                                                               |
| Trial cost         | One `claude -p` invocation, 2 model turns, 8 s wall time, reported cost USD 0.39, within the owner's approved Claude Code trial allowance (#396: at most 15 minutes and two short turns) |
| Primary source     | [Claude Code hooks reference](https://code.claude.com/docs/en/hooks.md)                                                                                                                  |

Event semantics (natural stop, user interrupt, `StopFailure`, re-entry, `SessionStart`) are researched in [claude-code-natural-stop.md](../claude-code-natural-stop.md) (#637). This report adds the observed hook round trip and the shared-script recommendation.

## Result

**Claude Code has a native before-stop hook that genuinely continues the same turn, and the exact hook text reaches the model (observed).** A `Stop` command hook returning `{"decision":"block","reason":TEXT}` kept the session going; the model's next reply followed TEXT exactly. The continued turn's own `Stop` carried `stop_hook_active: true`, and returning nothing then let the session end.

So stop -> fresh role briefing -> continued work is supported natively, with these limits:

- An interrupted turn (Esc / Ctrl-C) never fires `Stop` (documented), so a user stop cannot be continued, and needs no event of its own.
- After eight consecutive hook continuations without a tool call, Claude Code overrides the block (documented). That is a native constraint, not a PDB budget.
- Writing the hook response is not proof of delivery: at that cap the text never reaches the model. Receipt is unresolved (see "Limits").

## Observed trial

A disposable project directory contained only `.claude/settings.json` registering one command hook, `node hook.mjs OUT`, on `SessionStart` and `Stop` (timeout 10 s). The hook logged sanitized fields only (key names, event name, booleans, counts, message length; never IDs, paths or text). On the first `Stop` it wrote a marker and returned a block with a synthetic briefing; it returned nothing afterwards. No PDB read, ticket or credential was involved.

```sh
claude -p "Reply with exactly the single word OK and nothing else. Do not use any tools." --output-format json
```

| Step           | Observed                                                                                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` | keys `cwd`, `hook_event_name`, `session_id`, `source`, `transcript_path`                                                                                                                                                                                                           |
| First `Stop`   | `stop_hook_active: false`; keys `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`; `background_tasks` empty; last message 2 characters ("OK") |
| Hook response  | `{"decision":"block","reason":"PDB-TRIAL synthetic briefing: reply with exactly the single word CONTINUED and nothing else."}`                                                                                                                                                     |
| Second `Stop`  | `stop_hook_active: true`; same key set; last message 9 characters                                                                                                                                                                                                                  |
| Final result   | `"result": "CONTINUED"`, `num_turns: 2`, `is_error: false`                                                                                                                                                                                                                         |

The final answer is the model-visible proof: the model could only produce `CONTINUED` from the hook's `reason`. The four claims are therefore separable as the issue requires: the **script executed** (log lines), the **briefing was delivered** and was **model-visible** (the reply obeyed it), and **continuation was observed** (a second turn and a second `Stop` with `stop_hook_active: true`).

Print mode treats the folder as trusted (documented); in an interactive session, hooks wait for the workspace trust dialog. The trial did not exercise the interactive trust flow.

## Registration, scope and binding

- **Registration:** `hooks.Stop` (and `hooks.SessionStart`) in `~/.claude/settings.json` (user, this machine), `.claude/settings.json` (project, committable) or `.claude/settings.local.json` (project, gitignored). An MCP server cannot register a client hook.
- **Input:** JSON on stdin; output JSON on stdout (`decision`, `reason`), or exit 2 with stderr as the reason. Default command timeout 600 s.
- **Binding:** `session_id` is the native session; `cwd` the checkout. `prompt_id` is present in `Stop`. Whether it differs between the original turn's `Stop` and the continued turn's `Stop` was not recorded, so it is not yet a proven per-event ID.

## Shared adapter contract

The platform-neutral core already exists: `pdb rebrief check` / `ack` over the shared session store (`src/rebrief/core.ts`, `ContinuationSession`, `ensureSession`; #506, #657). Claude Code's translation is thin:

| Contract step       | Claude Code                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Session start       | `SessionStart` `startup`/`fork` -> `ensureSession` with verified start evidence; `resume`/`compact`/`clear` reuse only |
| Trigger             | `Stop` (natural only; interrupts never fire it)                                                                        |
| Event identity      | derived (`session_id` + `prompt_id` + an adapter counter) until a native per-event ID is proven                        |
| Block the stop      | `decision: "block"` with the bounded briefing as `reason`                                                              |
| Model-visible input | the `reason`, shown to the model as `Stop hook feedback`                                                               |
| Receipt             | unresolved: never acknowledge at write time (see "Limits")                                                             |
| Re-entry            | `stop_hook_active` is informational; PDB's duplicate, pending-offer and fingerprint guards decide                      |
| User stop           | no event; nothing to do                                                                                                |
| Error               | `StopFailure`: no decision control; no PDB call                                                                        |

**Recommendation: the shared core plus a thin Claude Code adapter.** This matches the Codex report (#387) and the Ori report (#388). One script cannot serve all three: Ori has no stop hook and needs a watcher that starts a new turn. Claude Code and Codex can both call the same core from a hook, with platform-specific framing of the response.

## Test cases

| Case                      | Behaviour                                                                       | Evidence                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Actionable queue, changed | `continue`: block with the briefing; model follows it                           | observed for the native round trip (synthetic text); core decision covered by `src/rebrief` tests |
| Empty queue               | core `stop`; hook prints nothing; Claude Code ends normally                     | core tests; native "print nothing" observed on the second `Stop`                                  |
| Unchanged briefing        | core `stop` (`unchanged`)                                                       | core tests                                                                                        |
| Unreachable PDB / error   | core `stop`; hook exits 0 with no output (fail open to the user's normal stop)  | core tests; native exit-0 path observed                                                           |
| Hook re-entry             | second `Stop` has `stop_hook_active: true`; core duplicate/pending guards apply | observed flag; core tests                                                                         |
| Explicit user stop        | `Stop` never fires                                                              | documented; not exercised in print mode                                                           |

## What works today versus what needs PDB HTTP MCP

Works today: the native hook round trip (observed), and the shared core through the CLI (`pdb rebrief check --platform claude-code`), which reads the live shared service. Needs work: a packaged Claude Code adapter (the native-adapter slice of #657, with the installer #582), a proven per-event ID, and a receipt rule. HTTP MCP end-to-end delivery waits for that endpoint's fresh-read capability. The core already reports `fresh-read-unsupported` for `--transport http-mcp` rather than reading stale data.

## Reproducible checklist

1. Create an empty directory with `.claude/settings.json` registering a `Stop` command hook that blocks once with a fixed reason naming a codeword, then prints nothing.
2. Run `claude -p "Reply with exactly the single word OK and nothing else. Do not use any tools." --output-format json` in it.
3. Expect `result` to equal the codeword, `num_turns: 2`, and two `Stop` events (`stop_hook_active` false, then true).
4. Delete the directory.

For interrupt behaviour, follow the attended test in [claude-code-natural-stop.md](../claude-code-natural-stop.md).

## Limits

- **Receipt is unresolved.** At the native cap the block is overridden, so the next `Stop` with `stop_hook_active: true` is the only candidate receipt signal; it is unverified at the cap. Until it is proven, the adapter leaves offers pending.
- **Per-event ID is unproven.** It is unknown whether `prompt_id` differs between the original and the continued `Stop`.
- **Interactive mode and trust were not exercised;** only print mode was.
- **Esc/Ctrl-C behaviour** relies on the documentation only, because an interrupt cannot be sent in print mode.
- No production hook was installed; the disposable directory was deleted.

## Sources

- Claude Code hooks reference: `### Stop`, `#### Stop input`, `#### Stop decision control`, `### StopFailure`, `### SessionStart`, `### Workspace trust` — https://code.claude.com/docs/en/hooks.md
- [claude-code-natural-stop.md](../claude-code-natural-stop.md) (#637), [codex-stop-hooks.md](codex-stop-hooks.md) (#387), [ori-stop-hooks.md](ori-stop-hooks.md) (#388), [doc/rebrief.md](../../rebrief.md)
