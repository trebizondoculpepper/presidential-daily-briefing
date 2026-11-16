# Antigravity natural completion and interruption (#638)

2026-11-16, `jonas_kowalski`. Research performed inside this native Antigravity CLI task (`agy 1.5.9`, `/Users/sal/.local/bin/agy`, `ANTIGRAVITY_LS_VERSION=cli-1.5.9`). Host: macOS 27.2.1, arm64; Node `v26.10.0`. Researcher model/provider API identity is not reliably exposed in the tool environment; no identity is inferred from a UI display name. Inspected PDB source revision: `e1e714d62135c727f8250f2f672cda35ad8e70fe`. No new model trial, trust change, hook installation, or private transcript inspection was performed.

This is a focused follow-up to [#264's Antigravity survey](antigravity.md) and the shipped [shared rebrief interface](../../rebrief.md). It does not repeat the platform survey or gate #581/#582's Codex/Claude Code attended installers.

## Result and evidence levels

A thin native adapter can forward a `Stop` hook event to installed `pdb`, but **documented** Antigravity `Stop` semantics and **live-observed** runtime behavior must be kept strictly separate:

- **Documented in bundled `agy 1.5.9` skill docs** (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`): Unlike Codex's `Stop` hook, Antigravity's `Stop` stdin contract declares an explicit `terminationReason` enum (`"NO_TOOL_CALL"`, `"USER_CANCELED"`, `"ERROR"`, `"MAX_INVOCATIONS"`, `"MAX_FORCED_INVOCATIONS"`, `"MAX_TOKEN_BUDGET_EXCEEDED"`, `"TERMINAL_STEP_TYPE"`, `"TERMINAL_CUSTOM_HOOK"`, `"INJECTED_RESPONSE"`), plus `fullyIdle`, `continuationActive`, `executionNum`, and `error`. It returns `{"decision": "continue", "reason": "..."}` to block stopping and inject a system message, or any other JSON (such as `{}`) to allow stopping.
- **Not live-observed here**: No temporary hook was installed and no paid model turn was run, so whether `agy 1.5.9` (or Antigravity Desktop App 2.0 / IDE) emits every documented field identically in all termination paths—especially `Esc`/`Ctrl+C` cancellation and transport errors—is **unverified at runtime**.

Read-only local commands and inspections executed:

```sh
agy --version          # 1.5.9
agy --help             # verified CLI flags and subcommands
env | awk -F= '/^ANTIGRAVITY_/ {print $1}' | sort
```

Verified presence (names only, no secret values recorded) of `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_AGENTAPI_EXE`, `ANTIGRAVITY_APP_DATA_DIR`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_LS_VERSION`, `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_SOURCE_METADATA`, and `ANTIGRAVITY_TRAJECTORY_ID`.

Small sanitized contract extract from the locally bundled `agy 1.5.9` `hooks.md` (camelCase protojson; **documented schema, not a captured runtime event**):

```json
{
  "StopInput": {
    "commonFields": [
      "conversationId",
      "workspacePaths",
      "transcriptPath",
      "artifactDirectoryPath",
      "modelName",
      "lastUserInput",
      "hookEventName",
      "cwd"
    ],
    "stopFields": ["executionNum", "terminationReason", "error", "fullyIdle", "continuationActive"],
    "documentedTerminationReasons": [
      "NO_TOOL_CALL",
      "MAX_INVOCATIONS",
      "MAX_FORCED_INVOCATIONS",
      "MAX_TOKEN_BUDGET_EXCEEDED",
      "ERROR",
      "USER_CANCELED",
      "TERMINAL_STEP_TYPE",
      "TERMINAL_CUSTOM_HOOK",
      "INJECTED_RESPONSE"
    ]
  },
  "StopOutputContinue": {
    "decision": "continue",
    "reason": "<injected as a system message>"
  }
}
```

## Capability matrix

| Situation                                | Evidence here                                                                                                                                                                    | Recommended handling                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Natural completion                       | Documented `terminationReason: "NO_TOOL_CALL"`, `fullyIdle: true`, `continuationActive: false`                                                                                   | Eligible only when `terminationReason === "NO_TOOL_CALL"`, `continuationActive === false`, `fullyIdle === true`, and native binding is verified |
| Explicit active user stop                | Documented `terminationReason: "USER_CANCELED"`; not live-tested here                                                                                                            | Map to `user-stop`; return `{}` immediately and discard any in-flight offer                                                                     |
| Error or budget/step termination         | Documented `ERROR`, `MAX_INVOCATIONS`, `MAX_FORCED_INVOCATIONS`, `MAX_TOKEN_BUDGET_EXCEEDED`, `TERMINAL_STEP_TYPE`, `TERMINAL_CUSTOM_HOOK`, `INJECTED_RESPONSE`; not live-tested | Map `ERROR` to `failure` and others to `unknown`; never infer natural completion; allow stop (`{}`)                                             |
| Recursive `Stop` continuation            | Documented `continuationActive: true` (and `executionNum > 0`) while continuing a `Stop` hook                                                                                    | Suppress continuation whenever `continuationActive === true`; preserve `pdb rebrief` deduplication                                              |
| Fresh session initialization             | Documented `SessionStart` hook (`conversationId`, `workspacePaths`, `modelName`, paths)                                                                                          | Resolve explicit repo/agent/role/session binding; initialize separate state deliberately                                                        |
| Resume / `--continue` / `--conversation` | `hooks.md` does not document a `SessionStart` `source` field or resume behavior                                                                                                  | Preserve deduplication history keyed by `conversationId`; do not reset state on a new turn or resume                                            |
| Hook limitations                         | Documented: `type: "command"` only (synchronous, 30s default timeout; no HTTP/async hooks)                                                                                       | Keep adapter bounded (e.g., 4–5s deadline); `PreInvocation`/`PostInvocation` are separate channels                                              |

## Trusted context vs. unknown

- **Trusted**: The native `Stop` stdin envelope (`conversationId`, `hookEventName`, `terminationReason`, `continuationActive`, `fullyIdle`, `error`, `cwd`, `workspacePaths`) and explicit CLI/config binding (`--repo`, `--agent`, `--role`, `--state-dir`).
- **Untrusted / insufficient**: `lastUserInput` and `transcriptPath` contents are user/model text, not a stable cause API (never parse transcripts to guess stop cause). `cwd` is a working directory path, not proof of repository identity without explicit verification. `modelName` may be `"auto"` or an alias. Native hook execution proves the user approved the hook definition, not that any particular `Stop` invocation was a natural completion.
- **Unverified**: Whether `agy` Desktop App 2.0 and Antigravity IDE emit identical `Stop` payloads to `agy` CLI `1.5.9`, whether `Stop` fires at all on abrupt disconnect/crash, and whether `SessionStart` fires on `--continue` / `--conversation <id>`.

## Adapter recommendation and policy alignment

If Antigravity `Stop` continuation is prototyped later, add a thin, opt-in `pdb rebrief antigravity-stop` adapter (analogous to `src/rebrief/codex.ts`) rather than placing JSON or queue logic in shell scripts:

1. **Strict eligibility gate**: Evaluate `pdb rebrief` with `--reason natural` **only** when `hookEventName === "Stop"`, `terminationReason === "NO_TOOL_CALL"`, `continuationActive === false`, `fullyIdle === true`, `error` is empty, `conversationId` matches the bound session, and explicit opt-in is enabled.
2. **Fail-closed mapping**: Map `USER_CANCELED` to `user-stop`, `ERROR` to `failure`, and any missing or other `terminationReason` to `unknown`—all returning `{}` immediately without querying GitHub.
3. **Native framing**: Emit `{ "decision": "continue", "reason": result.briefing }` only when `decision === "continue"` and `result.briefing` is non-empty; otherwise emit `{}`. Note that emitting `stdout` is not proof of model-visible receipt.
4. **Policy mismatch note**: The owner does not want arbitrary PDB work/spending caps imposed on normal approved continuation. Current `src/rebrief/core.ts` still enforces `defaults.cap = 3` offers per session; resolving that cap belongs to its own reviewed contract/implementation change (retain individual request deadlines and duplicate/`continuationActive` reentry protections).
5. **Existing-session alternatives**: As established in [#264](antigravity.md), `PreInvocation` (`injectSteps`) remains the synchronous context-on-next-turn channel, `/schedule` handles coarse in-session wait loops, and Desktop App 2.0 Sidecars (`agentapi send-message`) handle external idle wake where available.

## Exact isolated owner test plan

Run in a disposable workspace with a private temporary `--state-dir` (created via Node `fs.mkdtempSync` outside any Git tree), synthetic read-only facts, and normal native hook approval. Do not modify production `~/.gemini/config/hooks.json` or commit credentials/transcripts.

1. **Preflight (no generation)**: Place a temporary `.agents/hooks.json` in the disposable workspace pointing `Stop` at a logging wrapper or `pdb rebrief` dry harness with a 5s timeout. Confirm discovery and native trust prompt behavior without running a model turn.
2. **Natural completion**: With explicit trial authorization, run one short `agy` turn asking for a fixed harmless response. Inspect the sanitized `Stop` stdin keys/values: verify `hookEventName: "Stop"`, `terminationReason: "NO_TOOL_CALL"`, `continuationActive: false`, `fullyIdle: true`, and matching `conversationId`. Return `{"decision":"continue","reason":"<nonce>"}` once and verify the second `Stop` arrives with `continuationActive: true` (and `executionNum > 0`), which must return `{}` and stop cleanly.
3. **Active user interruption**: Start a waiting turn (e.g., running a short sleep command) and press `Esc` / `Ctrl+C` (or Stop in App/IDE) while active. Verify whether `Stop` fires with `terminationReason: "USER_CANCELED"` (or does not fire); confirm `{}` is returned and no continuation turn starts.
4. **In-flight fetch race**: Add an artificial 2s delay to the local synthetic briefing response, trigger a natural stop or interrupt while pending, and verify that `USER_CANCELED` / abort discards any delayed offer before emitting `continue`.
5. **Error / limit stop**: Trigger a controlled local error or `--max` limit in the disposable environment (without touching production auth) and verify `terminationReason` (`"ERROR"`, `"MAX_INVOCATIONS"`, etc.) is mapped to `{}` and never treated as `NO_TOOL_CALL`.
6. **SessionStart vs. resume**: Start a fresh disposable conversation, then resume it with `agy --conversation <id>`. Record whether `SessionStart` fires on resume and confirm existing deduplication state is preserved.
7. **Cleanup**: Remove the disposable workspace, temporary `.agents/hooks.json`, and private `--state-dir`. Verify no residual hooks remain.
