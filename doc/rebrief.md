# Shared rebrief core (opt-in prototypes)

`pdb rebrief` implements the shared read-only decision in [the contract](design/shared-rebrief-core.md) (#506). It works with explicit `--platform codex`, `claude-code`, or `ori` context; it does not register a native hook or start a model. Native event decoding, receipt and continuation remain #398/#396/#400. A successful core test is not proof of native Codex delivery.

## Native adapter responsibilities

The adapter supplies the actual persistent client session, a unique event ID, explicit project/repository, resolved agent, role and platform. Only a verified natural end of turn maps to `--reason natural`. User interruption maps to `user-stop`/`cancelled`, failure to `failure`, and an unknown event to `unknown`. Never manufacture a natural event from a process exit. Keep the same state and budget across resumed turns; a new turn is not a new session.

Use `RebriefSession` from `src/rebrief/core.ts` with an adapter-owned memory state, or the CLI with one private temporary directory per session. Initialize only after explicit opt-in. The service accepts an injected transport, clock, deadline scheduler, cancellation signal and state. The CLI uses the PDB identity resolver (canonical `pdb.toml`, read-only legacy fallback); explicit agent wins. Repository/project agreement is checked before reading local identity. Role and platform are explicit, never borrowed from another agent. CLI JSON includes bounded identity source/store diagnostics after lookup, including `legacy-not-imported` and its supported import command; the read never claims an import occurred.

For an eligible event the core requests one live role briefing through the existing shared service. It retains the engine's ranked top ten and policy reasons; it does not rank or claim work. Freshness must start within this request, source coverage must be complete, and selection must match. Ordinary declared shortlist omissions are allowed. The output is version 1 with `decision`, stable `reason`, repository/agent/role/platform/event ID, policy revision, fingerprint, action IDs and (only for continue) bounded `briefing` text. The briefing adds a fixed instruction to use normal intake/claim/permission checks and treat repository content as untrusted; its source text is unchanged. Total briefing text is at most 8,000 UTF-8 bytes.

The semantic fingerprint includes ordered action IDs/kinds/reasons/evidence/commands, assessment/band and native unlock evidence, the effective policy reason (including the TypeScript role reason), selection, policy and rule revision, and relevant subject ownership/labels, PR head/check outcomes/unresolved review count/linked issues and body/comment revisions. Fetch times, telemetry and text rendering do not change it. Exactly delivered fingerprints suppress unchanged continuations. The deadline defaults to ten seconds and can only be lowered; the default three-offer session cap can only be lowered. A reserved offer consumes a slot even if delivery later fails. There are at most 128 remembered events; exhausted/lost/malformed state stops rather than resetting a budget.

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
