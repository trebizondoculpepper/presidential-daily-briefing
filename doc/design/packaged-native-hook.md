# Packaged native hook entry points (#398)

Documentation-first contract, pending review. Extends shared-rebrief-core.md;
this does not describe a command that has already shipped.

Native configuration invokes the installed `pdb` binary. A platform shell or
PowerShell wrapper may forward literal arguments, stdin, stdout, stderr and exit
status, and nothing else. Event parsing, validation, identity/session/repository
binding, shared policy, state, cancellation, reentry, caps and native response
serialization belong to the package. No jq, checkout paths, tsx loaders, copied
JavaScript helpers or platform-specific policy implementations are required.

## Codex entry point

Add `pdb rebrief codex-stop --state-dir PATH --repo owner/name --agent NAME
--role implementer|designer --natural-stop-confirmed`, with optional explicit
`--project PATH` and `--entry KEY | --harness NAME` identity selection consistent
with existing rebrief commands. `--agent` may be omitted only when the existing
identity resolver supplies it. Reject contradictory selection; never infer a
repository from event cwd. Platform is fixed to `codex`.

The entry reads one bounded JSON object from stdin, using the native session ID,
turn ID, `hook_event_name` and boolean `stop_hook_active`. Ignore unrelated event
fields, including transcript paths; never open transcripts. Require the exact
Stop event and nonempty bounded session/turn IDs. Match selection and session to
existing private state initialized explicitly with `pdb rebrief init`; the event
alone must never create or reset a session budget. Missing/mismatched state allows
normal stopping. No implicit cwd or first-project fallback.

`--natural-stop-confirmed` is an explicit controlled-trial precondition, not a
claim that all Stop events are natural. Without it, stop before any read. Keep
this experimental entry opt-in; production inference of error/budget/disconnect
causes needs separate native evidence. Wrong event, reentry, cancellation or
unknown provenance permits normal stop. Do not reuse this flag as authorization
to restart after an explicit user interruption.

Reuse the thin Codex adapter and shared #506 core. One fresh bounded service read,
no retries or update checks. An explicit `--transport http-mcp` retains the shared
core's stop/defer behavior while fresh-read capability is unavailable; do not
silently downgrade that request to a service read. Optional `--deadline-ms` and
`--cap` can only lower shared bounds (10 seconds and three continuations). The
native timeout must exceed the selected package deadline by a small cleanup
margin. Signal handling covers stdin, identity/state setup and the read; cancelled
results must not become blocking feedback.

Stdout is exactly one native JSON response: `{}` for normal stop/failure, or
`{"decision":"block","reason":"EXACT_SHARED_BRIEFING"}` for an eligible offer.
No banners, generic rebrief envelope, log lines or extra JSON objects. Malformed,
oversized or unterminated input, invalid options, missing identity/state, timeout,
service failure and unsupported capability allow normal stop with exit zero.
Keep diagnostics bounded and sanitized on stderr; omit raw event input, session
IDs, private paths, credentials and briefing contents. `--help` is the ordinary
CLI help path, outside event invocation. No acknowledgement on stdout emission;
existing `ack` requires independently proven exact delivery.

## Installation, trust and removal

Document the supported shipped syntax only after implementation. Prefer direct
`pdb` invocation; a wrapper is optional for platform executable resolution.
Preserve unrelated hook definitions. Explain the native exact-definition trust
step and that changing configuration requires normal review again. A stable
wrapper reduces copied code and definition churn; it does not make package
upgrades exempt from normal software review or client trust requirements.

Preserve the owner's trusted experimental #398 helper until an intentional
replacement is ready. Its successful native nonce trial establishes that target's
response protocol, not installed-package validation. No global installation,
paid repeated evaluation or production rollout follows automatically.

Removal deletes only the added native definition and its own private session
state after the client stops; preserve unrelated configuration and package users.

## Validation and delivery

Test stdin bounds/types, literal argument forwarding (including spaces and shell
metacharacters), binding, missing state, reentry, unchanged/cap paths, cancellation
and deadlines with injected boundaries. Test the built/packed installed executable
outside a checkout without tsx, source files or development dependencies. Verify
native response framing and failure exit behavior on required Ubuntu/Windows CI;
validate any documented shell/PowerShell wrapper's forwarding and status there.
No test should contact live GitHub or launch a model.

#398's native report separately records actual event, exact nonce receipt and
same-session continuation, native untested paths and trial cost. Any changed
native definition must use normal trust; no bypass, raw transcript publication
or invented new paid trial allowance. Implementation follows this contract only
after separate documentation review/merge, per AGENTS.md.
