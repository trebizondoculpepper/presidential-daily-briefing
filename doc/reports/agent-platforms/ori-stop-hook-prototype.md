# Ori Code before-stop continuation prototype (#400)

This is the native Ori Code continuation prototype for #400, following the shared-rebrief-core architecture (#506, merged in #562) and the [Ori stop-hooks research](ori-stop-hooks.md) (#388). It demonstrates the actual native event → shared-core decision → same-session model-visible continuation path on real Ori Code. It reuses the shared core; no per-platform rebrief logic was duplicated.

## Result

**Supported (bounded prototype, observed).** An owned headless Ori turn ends naturally (`turn.succeeded`); the shared `pdb rebrief` core returns a `continue` decision with the **specific** returned role briefing and fingerprint; the adapter resumes that **same session** with the briefing as a model-visible prompt; the model echoes a synthetic nonce from a file it could only know by reading it, and answers the briefing's first action — which is the continuation evidence `execute → deliver → same agent continues`. User stop always wins: the adapter is never invoked for `turn.cancelled`/`turn.failed` and enforces no reentry.

There is no native stop hook in Ori Code (see #388). The adapter is a small external watcher over the shared core, not a hook.

## Provenance

- **Researcher:** `dalia_okafor`, running **in native Ori Code** `0.17.0-alpha+028abb4` (alpha). Built-in runtime harness `ori`, **no wrapped client** (distinct from `ori claude`/`ori codex`). Ori shows the session model as `~anthropic/claude-opus-latest`; the resolved model is not exposed.
- **Probes:** owned headless `ori code -p` turns on `google/gemini-2.5-flash` against the local shared daemon (protocol 1) in the disposable checkout. This is the owner-approved two-short-turn bounded trial for Ori Code (#400; cap 15 min, two model turns, no production hook, no live mutation).
- **Environment:** macOS 27.2.1 (arm64), Node v26.10.0, `gh` 2.102.0, research date 2026-11-15 (UTC), repository at `origin/main` `0512f20`.
- **Evidence levels, marked per row:** _observed_ (exercised) vs _core-behavior_ (deterministic shared core rules exercised via its own JSON CLI without a paid model turn).

## Architecture and reuse

The prototype reuses the shared core: for each natural end-of-turn event it runs

```sh
pdb rebrief init|check|ack --json --state-dir <private tmpdir> --session <id> \
  --project <checkout> --agent dalia_okafor --role implementer --platform ori
```

from source (`npm run --silent pdb -- rebrief …`). The core resolves the repo/agent/role, performs one live role read through the shared service, computes a stable fingerprint, enforces the 8 KB briefing bound, the 10 s deadline and the three-offer session cap, and refuses reentry. The adapter only translates its `continue`/`stop`/`defer` JSON into the native resume shown below. This follows the `doc/design/shared-rebrief-core.md` contract and avoids three duplicate scripts.

The transport used is the default live `service` transport. `--transport http-mcp` currently returns `stop/fresh-read-unsupported` by design (see `doc/rebrief.md`): the shared HTTP MCP briefing tool has no force-refresh or explicit platform selection yet, so a separate reviewed extension (#390/#399) is required for HTTP MCP continuation. That boundary is reported, not assumed away.

## Runnable prototype

The disposable adapter is a small TypeScript watcher committed at `scripts/ori-stop-hook-prototype.mts` (under the repo's strict `scripts/` language/type boundaries). It:

1. runs a disposable work turn in an owned headless session,
2. waits for `turn.succeeded` on that session's jsonl stream,
3. calls the shared core (`pdb rebrief check`) for the natural-stop decision,
4. on `continue`, resumes the **same session** (`ori code --resume <id> -p "<briefing>"`),
5. verifies the model echoed a synthetic nonce it could only read from the fixture and the briefing's first action id,
6. acknowledges delivery (`pdb rebrief ack`) only then.

It is synthetic/read-only: the fixture is an untracked text file and is removed afterward; no live ticket is mutated. This is disposable, not a production install.

The script is the reproduction: it owns a private temp state directory (created with `mkdtempSync`), runs the work turn, drives `pdb rebrief init`/`check`/`ack`, resumes the same session, verifies the nonce and first action id, and removes its own state directory on exit. To reproduce: create the fixture, then run it from a checkout of this repository:

```sh
printf 'REBRIEF-%s\nSynthetic fixture: no live tickets.\n' "$(openssl rand -hex 4)" > briefing.txt
tsx scripts/ori-stop-hook-prototype.mts "$(pwd)"
# the script removes its own private temp state directory on exit.
rm -f briefing.txt
```

The script's cleanup removes only the exact private state directory it created in a fresh `mkdtempSync`; it never globs `/tmp/pdb-rebrief-*`, so it never touches another session's state (consistent with the shared-rebrief-core requirement to preserve another agent's work).

## Observed evidence

Two independent runs of the full chain both printed:

```json
{
  "result": "continue",
  "sameSessionResumed": true,
  "receivedNonce": true,
  "receivedAction": true,
  "eventId": "ori-turn-<hex>",
  "turnSawTool": true,
  "answerTail": "(1) REBRIEF-24d12756\n(2) trebizondoculpepper/presidential-daily-briefing"
}
```

- **Natural stop seen:** the work turn's stream contained `tool.started`, `tool.succeeded`, `assistant.text.delta`, then `turn.succeeded` — a genuine end-of-turn, not a manufactured exit.
- **Shared core decision:** `decision: continue`, `reason: changed-actionable-queue`, a stable `fingerprint` (observed `654746d45a…` / `9160e4b931…`), a bounded `briefing` text, and `actionIds` starting with `trebizondoculpepper/presidential-daily-briefing … continue-implementation`.
- **Specific deliverable became model-visible:** the resumed model returned the fixture nonce `REBRIEF-…` and the exact first action id. The `ack` then recorded the exact event/fingerprint.
- **Same agent continued:** `sameSessionResumed: true` — the continued turn ran in the original session, so it is continuation of that agent, not a spawned replacement.

## Other decision branches (shared-core behavior)

These are the deterministic `pdb rebrief` rules, exercised via its own JSON CLI without a model turn:

| Case                    | Behavior                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Empty queue             | `stop` (`unchanged-actionable-queue`); no offering                                 |
| Actionable (changed)    | `continue` with briefing + fingerprint (observed, above)                           |
| Unchanged response      | `stop`; exact fingerprint suppresses a repeated offer (dedup)                      |
| Unavailable server      | `stop` / `defer`; fail open so the user's normal stop is preserved                 |
| Reentry / cap           | refused; at most three offers per session; ambiguous delivery stops downstream     |
| Explicit user interrupt | adapter never invoked (only `turn.succeeded` triggers); `turn.cancelled` is a stop |

User stop always wins: the prototype never resumes on `turn.cancelled` or `turn.failed`, never installs a production hook, and never loops (one continue per natural stop, three-offer cap enforced by the core).

## Exact configuration, reproduction, removal

```sh
# disposable checkout (this branch). Create the test fixture with the nonce the model must echo:
printf 'REBRIEF-%s\nSynthetic fixture: no live tickets.\nMultiply 6 by 7.\n' "$(openssl rand -hex 4)" > briefing.txt
tsx scripts/ori-stop-hook-prototype.mts "$(pwd)"
# remove the disposable fixture when done; the script removes its own private state dir:
rm -f briefing.txt
```

The prototype runs solely inside the disposable checkout, cleans its fixture, and leaves no hook or configuration. Nothing in the user's normal Ori setup is installed or changed.

## Limits and unsupported boundaries

- **No native stop hook:** Ori Code offers no way to run code at the end of a turn. The watcher is external; it must be running to observe `turn.succeeded` and is only a prototype. A production continuation would need a daemon-side watcher or an upstream event subscription, which is a rollout decision, not part of this ticket.
- **Attended TUI sessions:** the prototype targets owned headless sessions. Behavior for an attended TUI race is unverified.
- **HTTP MCP transport:** not exercised end to end; requires the #390/#399 fresh-read/platform extension (the shared core reports `fresh-read-unsupported` for `--transport http-mcp`).
- **Windows/Linux/other versions:** not tested.

## Sources

- `ori --help`, `ori code --help`, `ori --version` of `0.17.0-alpha+028abb4` (native, no wrapper)
- Shared core contract `doc/design/shared-rebrief-core.md` and CLI `doc/rebrief.md` (#506)
- Acceptances: [Ori stop hooks](ori-stop-hooks.md) (#388); [Ori / OpenRouter](ori-openrouter.md) (#24); [Ori MCP acceptance](ori-mcp-acceptance.md) (#255)
