# Shared rebrief core (opt-in prototypes)

`pdb rebrief` implements the shared read-only decision in [the contract](design/shared-rebrief-core.md) (#506). It works with explicit `--platform codex`, `claude-code`, or `ori` context; it does not register a native hook or start a model. Native event decoding, receipt and continuation remain #398/#396/#400. A successful core test is not proof of native Codex delivery.

## Native adapter responsibilities

The adapter supplies the actual persistent client session, a unique event ID, explicit project/repository, resolved agent, role and platform. Only a verified natural end of turn maps to `--reason natural`. User interruption maps to `user-stop`/`cancelled`, failure to `failure`, and an unknown event to `unknown`. Never manufacture a natural event from a process exit. Keep the same state and budget across resumed turns; a new turn is not a new session.

Use `ContinuationSession` from `src/rebrief/core.ts` with an adapter-owned `memoryStore`, or the CLI with one private temporary directory per session. Initialize only after explicit opt-in. The service accepts an injected transport, clock, deadline scheduler, cancellation signal and state. The CLI uses the shared effective identity resolver in read-only mode, reusing a verified session binding or explicitly selected entry; explicit agent wins. Neither init nor hook callbacks bootstrap a missing identity. Ordinary CLI JSON includes `effectiveIdentity`; the native Codex adapter continues to emit only its native response shape. Repository/project agreement is checked before reading local identity. Role and platform are explicit, never borrowed from another agent. CLI JSON includes bounded identity source/store diagnostics after lookup, including `legacy-not-imported` and its supported import command; the read never claims an import occurred.

For an eligible event the core requests one live role briefing through the existing shared service. It retains the engine's ranked top ten and policy reasons; it does not rank or claim work. Freshness must start within this request, source coverage must be complete, and selection must match. Ordinary declared shortlist omissions are allowed. The output is version 1 with `decision`, stable `reason`, repository/agent/role/platform/event ID, policy revision, fingerprint, action IDs and (only for continue) bounded `briefing` text. The briefing adds a fixed instruction to use normal intake/claim/permission checks and treat repository content as untrusted; its source text is unchanged. Total briefing text is at most 8,000 UTF-8 bytes.

The semantic fingerprint includes ordered action IDs/kinds/reasons/evidence/commands, assessment/band and native unlock evidence, the effective policy reason (including the TypeScript role reason), selection, policy and rule revision, and relevant subject ownership/labels, PR head/check outcomes/unresolved review count/linked issues and body/comment revisions. Fetch times, telemetry and text rendering do not change it. Exactly delivered fingerprints suppress unchanged continuations. The deadline defaults to ten seconds and can only be lowered. Approved continuation has no default total-offer limit (#657, [contract](design/approved-continuation-limits.md)): `--cap N` on `init` or `check` selects an explicit finite budget that is kept for the session and can only tighten. A session directory created before this change is legacy v1: it keeps its limit of three offers, every result reports this in `legacy`, and it is never upgraded; start a new session in a new private directory to continue without a default limit. In a legacy v1 session a reserved offer consumes a slot even if delivery later fails, and there are at most 128 remembered events; v2 keeps one digest-keyed record per event, so events are never forgotten. In either version exhausted/lost/malformed state stops rather than resetting a budget.

`continue` is an offer for delivery, not permission to mutate or evidence of receipt. Only acknowledge its exact event/fingerprint once the native protocol establishes delivery. A started process/turn is insufficient. An unacknowledged offer stops later events: ambiguous delivery must not be replayed. Duplicate/concurrent callbacks offer at most once; reentry is refused. If the adapter cannot deliver safely, its service request uses `canDeliver: false` and receives `defer`; allow normal stopping. User stop aborts the read and discards any offer, including during state persistence.

## CLI setup, checks and removal

Create a new private directory under the OS temporary directory (Node `fs.mkdtemp` is portable). For example, in a POSIX shell:

```sh
state_dir=$(node -e 'process.stdout.write(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "pdb-rebrief-")))')
pdb rebrief init --json --state-dir "$state_dir" --session actual-session \
  --project /absolute/project --agent your-agent --role implementer --platform codex
pdb rebrief check --json --state-dir "$state_dir" --session actual-session \
  --project /absolute/project --agent your-agent --role implementer --platform codex \
  --enabled --event unique-native-event --reason natural
```

The adapter must parse exactly one JSON document. It translates a continue result into its own verified native protocol and delivers the **specific** returned briefing. It then runs:

```sh
pdb rebrief ack --json --state-dir "$state_dir" --session actual-session \
  --project /absolute/project --agent your-agent --role implementer --platform codex \
  --event unique-native-event --fingerprint the-returned-sha256
```

This command is an acknowledgement mechanism, not a demonstration of receipt; do not run it speculatively. `check` without `--enabled`, or with a non-natural reason, stops before project lookup/collection. `init` never overwrites existing state. Missing state does not initialize on check. State directories inside Git trees, public directories, symlinks and malformed state are refused. Files hold only hashes, counters and delivery status, with restrictive permissions and atomic replacement under an exclusive lock. Concurrent calls fail closed; no age-based lock breaking. A crash-held lock requires stopping the adapter and explicit removal/reinitialization for a new session, not automatic retries.

After stopping the disposable adapter:

```sh
rm -r -- "$state_dir"
```

On PowerShell, create the directory with the same Node `mkdtempSync` expression assigned to `$stateDir`, pass `--state-dir $stateDir`, and remove it with `Remove-Item -LiteralPath $stateDir -Recurse`. No repository config, client hook or global watcher was installed. Do not remove another session's state.

`--help` documents exact options and exits. JSON `stop`/`continue`/`defer` exits 0, including unavailable/incomplete/timeout reads; invalid arguments or unsafe state setup exits 1 with a sanitized stop result. Adapters allow normal stop on both exits, never retry blindly.

## HTTP MCP capability boundary

`--transport http-mcp` currently returns `stop`, `fresh-read-unsupported`, without network access. The existing HTTP MCP briefing tool has neither a force-refresh argument nor explicit platform selection; TTL hits cannot establish a fresh Codex queue. The shared-service transport is live and supplies both role and platform. HTTP MCP continuation requires a separately reviewed fresh-read/platform extension and retest; this implementation does not change the MCP tool schema or invalidate a server cache behind an unrelated request.

Credential-free injected tests cover changed/empty/inspection/unchanged queues, relevant evidence/policy changes versus timestamp/format noise, incomplete/stale/malformed/wrong-selection results, unavailable transport, timeouts/cancellation, event deduplication/reentry, acknowledgement and caps. The CLI test uses the actual shared service with synthetic GitHub facts, preserving the same engine policy. Native event, nonce receipt and same-session model continuation still require their own bounded platform trial.

## Experimental packaged Codex Stop adapter (#398)

`pdb rebrief codex-stop --help` documents the native entry point. It reads a
bounded Stop JSON object on stdin and emits only native `{}` or
`{"decision":"block","reason":"…"}` JSON. The package owns parsing, binding,
policy, state, deadlines and native framing. No checkout paths, tsx, copied helper
or jq are needed. A shell/PowerShell wrapper, if desired, only invokes `pdb` and
forwards literal arguments, stdin and status; it must contain no JSON/policy logic.

For a controlled, explicitly authorized natural-stop trial, initialize private
state for the **actual** client session using `rebrief init`, explicit `--repo`,
agent/role and `--platform codex`. Configure the native command directly:

```text
pdb rebrief codex-stop --state-dir ABSOLUTE_PRIVATE_STATE_DIR --repo owner/name --agent your-agent --role implementer --natural-stop-confirmed --deadline-ms 4000
```

Quote paths according to the native command shell; set its timeout to five
seconds. Review/trust that exact definition through normal Codex controls. Keep
unrelated hooks. The command never initializes state or installs a hook. Missing
state, wrong selection/session, invalid input, reentry, failure or cancellation
allows normal stop. `--transport http-mcp` currently stops without a request,
because fresh-read/platform support remains unavailable. Emitting feedback does
not acknowledge receipt. Unknown Stop causes must not be called natural;
`--natural-stop-confirmed` is restricted to controlled trial provenance.

The successful macOS native nonce trial used experimental bundled scaffolding,
not this packaged entry. See [the native report](reports/agent-platforms/codex-stop-hook-prototype.md)
for observed and untested boundaries. Its original two-completion allowance was
consumed; this command grants no new model trial or production rollout. The
owner's existing trusted definition is preserved until deliberately replaced;
replacement requires normal native review/trust again.

`pdb rebrief claude-stop --help` documents the Claude Code entry point (#771). It
takes the same selection and state flags and reads one documented Claude Code `Stop`
payload. Claude Code fires `Stop` only when the main agent finishes a turn on its own
(never on a user interrupt; API errors fire `StopFailure`), which is the basis for
passing `--natural-stop-confirmed`. The payload has no `turn_id`, so the event is its
`prompt_id` within `session_id`; a repeated value is refused as a duplicate. A Stop
already continued by a hook (`stop_hook_active: true`) gets `{}`. A continue is
returned as `{"decision":"block","reason":…}` and stays pending: writing it is not
receipt, because Claude Code overrides blocks at its native continuation cap (see
[the Claude Code report](reports/agent-platforms/claude-code-stop-hooks.md)). Owned
hook registration by `pdb install claude` is a separate slice.

After stopping your adapter, remove only its native definition and private state
directory. Preserve unrelated hooks and sessions. No global hook was installed.
