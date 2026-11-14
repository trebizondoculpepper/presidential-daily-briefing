# Ori Code stop hooks and a shared PDB rebrief/continue script (#388)

Research for #388, in the series with the Claude Code (#386) and Codex (#387) stop-hook tickets. It builds on the [Ori / OpenRouter report](ori-openrouter.md) (#24) and the [Ori MCP acceptance result](ori-mcp-acceptance.md) (#255), and does not repeat their general survey. It is research and documentation only. No hook, feature, schedule, watcher or setting was installed, and no live ticket was claimed, released or changed to run a demonstration.

## Provenance

- **Researcher:** `dalia_okafor`, running **in native Ori Code** `0.17.0-alpha+028abb4` (alpha channel). Built-in runtime harness `ori`, **no wrapped client** (not `ori claude` or `ori codex`), interactive TUI session. Ori shows the session model as `~anthropic/claude-opus-latest`; the exact resolved model is not exposed.
- **Probes:** headless `ori code -p` turns on `google/gemini-2.5-flash` against the same shared daemon (protocol 1), in a disposable Git directory with a synthetic `briefing.txt` fixture. Eight turns, each reporting about $0.001 to $0.0034, **under $0.02 in total**, within the bounded plausibility allowance of [the research-stage instructions](../../design/research-stages.md).
- **Environment:** macOS 27.2.1 (arm64), Node v26.10.0, `gh` 2.102.0, research date 2026-11-14 (UTC), this repository at `origin/main` `9a7631a`.
- **Evidence levels, marked per row:** _observed_ (exercised against the real daemon), _documented_ (`--help` text, Ori's bundled feature-authoring docs, the generated SDK in `~/.ori/global/.ori/sdk`) or _source-inspected_ (strings in the bundled JavaScript of the installed binary; not a public repository). No credentials, daemon tokens or transcripts are reproduced.
- **Time:** about 50 minutes.

## Result

**Native Ori Code has no stop hook.** No configuration, feature export or extension point runs a script when the agent is about to end a turn and lets its output decide whether the turn continues. A shared before-stop script, as Claude Code and Codex hooks would run it, has nothing to attach to in Ori today. This is a negative result for the hook question itself.

Two adjacent mechanisms exist, and the probes separate what each one actually delivers:

1. **Mid-turn steering continues the current turn (observed).** `POST /api/steering/send` with `mode: "steer"`, sent while a tool call was running, was delivered at the next step boundary (`delivered: true`, a `turn.steered` event). The model then read the fixture and echoed its random nonce. That is model-visible instructions and observed continuation in the same turn. The message has to arrive **before** the model's final answer.
2. **Steering at the natural stop point is dropped (observed, twice).** A `steer` sent while the final text-only answer was streaming was held until the turn ended, then answered `delivered: false`. The turn ended normally and the message was not queued. A `steer` sent after the turn had ended got no response within 5 s, and `GET /api/steering/queued/:id` was empty, matching #24. In the source, `queue` messages are taken only at the start of a turn (`take("turn")`). The final-step commit (`commitStep` with `stopUnlessSteered`) also takes pending step messages, so source reading alone would predict delivery. Why the observed late steer was not delivered is **unresolved**: it may be timing (the message arriving after that take) or a path not identified.
3. **A new turn in the same session works after the stop (observed).** `ori code -p <briefing> --resume <sessionId>` returned the same session ID, delivered the briefing as the turn's prompt, and the model answered with both the fixture's nonce and a codeword it had been given in the earlier turn. This continues the **session**, with its context. It does not prevent the original turn from stopping, and it is a new turn submitted from outside.

So the closest Ori equivalent of "stop → fresh role briefing → continued work" is an **external watcher** with these steps:

1. It reads the daemon event stream.
2. It treats `turn.succeeded` as a natural stop.
3. It runs the shared PDB core.
4. When the core says continue, it submits one bounded new turn to the same session with `--resume`.

That is plausible for headless or owned sessions. For an **attended TUI** session it is unverified: nothing was tested about how the TUI shows or races an externally submitted turn. It should not be pointed at a user's live session without an explicit, separately approved trial.

## What happens when the agent would end a turn

Event names are the daemon's runtime events (`AgentRuntimeEventTag` and `AgentSessionLifecycleEvent` in the generated SDK).

| Situation                            | What the event stream shows                                                                                                                               | Evidence                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Natural stop (final text-only step)  | `assistant.text.delta`… `item.completed` (usage) → `turn.succeeded`, then a terminal `result` with `ok: true` and `sessionId` in `--output jsonl`         | observed                        |
| Steered continuation                 | `tool.succeeded` → `turn.steered` → further `reasoning.delta`/`tool.*` steps → `turn.succeeded`                                                           | observed                        |
| User interruption                    | `turn.cancelled`; failure kind `cancelled`, code `ORI_TURN_ABORTED`; headless SIGINT exits 130 with `turn.failed` (#255)                                  | source-inspected; #255 observed |
| Error                                | `turn.failed` with an `AgentFailure` (kinds `upstream`, `timeout`, `unavailable`, …)                                                                      | source-inspected                |
| Exhausted money budget or rate limit | `turn.failed` with `ORI_OPENROUTER_BUDGET_EXHAUSTED`, `ORI_OPENROUTER_KEY_LIMIT_REACHED`, `ORI_OPENROUTER_FREE_LIMIT_REACHED` or `ORI_MODEL_RATE_LIMITED` | source-inspected                |
| Per-turn step budget (`maxTurns`)    | not identified; unverified whether it ends as `turn.succeeded` or a failure                                                                               | unverified                      |
| Session exit (TUI quit)              | no dedicated event identified                                                                                                                             | unverified                      |
| Disconnected transport               | not tested                                                                                                                                                | unverified                      |

A watcher can therefore tell a natural stop from an interruption or error. It must continue **only** on `turn.succeeded`, never on `turn.cancelled` or `turn.failed`.

## Registration, scope and binding

- **No hook registration exists.** `ori help hooks` is an unknown command. The `feature.ts` export set is closed and documented (`harness`, `chat`, `schedule`, `api`, `hooks`, `prompt`, `command(s)`, `tool(s)`, `workflow(s)`, `provisions`), and none of them is a turn lifecycle callback. `hooks` means **feature-to-feature** hooks made with `createHook()`/`createPipelineHook()`, keyed `"<provider>.<hook>"`. The only published extension points in this build are `approval-asker`, `approval-policy` and `unattended-approvals`. `HarnessCallback` is `spawnThread`, `close`, `probe`, `compact`. (Documented: bundled feature contract docs and the generated SDK; extension points source-inspected.)
- **Hook schemas in the binary belong to wrapped clients.** The binary carries Claude Code's `Stop`/`SubagentStop` settings schema and Codex's `hooks` config keys for `ori harness setup` and the launchers. They configure those clients, not Ori Code (source-inspected).
- **A custom harness is not native Ori Code.** `defineHarness` adds a whole new agent loop beside the built-in ones. A stop check written there would be a different client, so it does not meet this ticket's gate.
- **Daemon access for a watcher.** The shared daemon's address is in `~/.ori/code-daemon/daemon.json` (`host`, `port`). The per-port bearer token is in `~/.ori/daemon/<port>.token` (or `ORI_DAEMON_TOKEN` inside feature code). Routes are `internal`: only callers on this machine with the token. No approval prompt is involved, but anything holding the token can steer any session on that daemon, so a watcher is a local-trust component.
- **Session binding.** Every event carries `sessionId`, `runId` and `turnId`. `GET /api/events/stream[?sessionId=…]` streams NDJSON and replayed history from the start in the sample read here (observed). A watcher must bind to one explicit session ID and ignore every other session on the shared daemon.
- **Working directory.** Headless turns run in the `ori code` caller's cwd (observed, `run.started.payload.cwd`). MCP servers do **not**: they start in the daemon's cwd (#255 Finding 2). A shared script must take the repository explicitly (`--repo` or `--project`), never from the daemon.
- **Timeouts.** A steer to a session with no turn in flight holds the HTTP request open (no response in 5 s). The source shows a 5-minute hold timeout and at most 32 pending messages per session. A watcher must use its own short client timeout.
- **Input/output schema.** Steering: `{ sessionId, text, mode: "queue" | "steer" | "interrupt" }` → `{ delivered, sessionId }`, or a refusal while an interaction awaits a response (`mode` other than `queue`). Resume: `ori code -p TEXT --resume ID --output jsonl` exits 0 on success, 1 on failure, 2 when an interactive request must be handed back. The help text warns that the runtime "may continue in a separate session", so the watcher must compare the returned `sessionId` (it matched here).

## Shared adapter contract

The platform-neutral core is the same whichever client calls it:

- **In:** repository (`owner/name`), stable agent identity (the `agent-inbox.toml` name, never a GitHub login or session ID), triage role, platform, the event (`natural-stop` only), the client session ID, and the fingerprint of the last briefing already delivered to that session.
- **Out:** `stop` or `continue`; when continuing, a bounded briefing text labelled as untrusted repository data, and its fingerprint.
- **Rules:**
  - `continue` only when the role queue has an actionable item for this agent and the fingerprint differs from the last delivered one. An unchanged briefing returns `stop`.
  - An unreachable PDB, incomplete evidence or any error returns `stop` (fail open toward the user's normal stop).
  - Allow at most one continuation per natural stop, and a small cap per session.
  - Never continue after an explicit user stop or interruption.
  - The core reads; it never claims, releases or changes tickets. The continued agent still runs the normal `claim`/permission checks itself.

The Ori translation is unavoidable and larger than a thin hook shim:

| Contract step       | Claude Code / Codex (per their reports)                  | Ori Code                                                                                                               |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Trigger             | client-run stop hook                                     | external watcher on `/api/events/stream`, filtered to one `sessionId`, firing on `turn.succeeded`                      |
| Block the stop      | hook decision                                            | **not possible**: the turn has already ended                                                                           |
| Model-visible input | hook output / additional context                         | prompt of a new turn: `ori code -p … --resume <sessionId>`                                                             |
| User stop authority | client distinguishes stop reason                         | skip on `turn.cancelled` / `turn.failed`; the watcher must also stop when the user exits or disables it                |
| Reentry guard       | hook flag such as "already continuing", plus fingerprint | fingerprint plus a per-session counter held by the watcher, because each resumed turn ends in another `turn.succeeded` |

**Recommendation: a shared core plus thin adapters, not one script for all three.** The core (call PDB, decide, fingerprint, bound the text) can be one script shared by all platforms. Claude Code and Codex can call it from their hooks. Ori needs a separate watcher adapter, which is a long-running process rather than a hook invocation. Its semantics also differ: it gives a new turn after a stop, not a prevented stop. The shared core should not assume it can block a stop.

## Test cases

| Case                     | Status in this research                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actionable queue         | Mechanism observed: briefing delivered and acted on via mid-turn `steer` and via `--resume`. PDB was not called by a hook, because no hook exists |
| Empty queue              | Core rule only (`rankedActions.items` empty → `stop`); not run end to end                                                                         |
| Unchanged response       | Core rule only (fingerprint unchanged → `stop`); not run end to end                                                                               |
| Unreachable PDB          | Core rule only (fail open → `stop`); not run end to end                                                                                           |
| Hook reentry             | Not applicable to a hook. For the watcher, each resumed turn emits a new `turn.succeeded`, so a fingerprint and counter are required; not run     |
| Explicit user stop       | Distinguishable as `turn.cancelled` (source-inspected; #255 observed exit 130). Not re-run here                                                   |
| Late steer at stop       | Observed: `delivered: false`, the turn ended, nothing queued                                                                                      |
| Steer to an idle session | Observed: no response in 5 s, nothing queued                                                                                                      |

Executed script, delivered briefing, model-visible instructions and observed continuation are kept apart:

- In the mid-turn and resume probes, the fixture contained a fresh random nonce that the model could only know by reading the file. It appeared in the model's answer text (reasoning text excluded).
- In the late-steer probes, the shell request succeeded (HTTP 200), but the response said `delivered: false` and no nonce appeared. A successful request alone is therefore not proof of delivery.

## What works today versus what needs PDB HTTP MCP

- **Works today:** the CLI path. `pdb --agent NAME --role implementer --platform ori --json` returned a complete briefing (`completeness.complete: true`) whose `rankedActions.items` gives the role queue the core needs. The daemon event stream, steering and `--resume` are all usable locally.
- **Needs the planned endpoint (#390):** an HTTP MCP call from the watcher, or from the continued turn's own MCP client, to a shared PDB service. That end-to-end acceptance belongs to #399. #400 (prototype continuation) should build on this report's watcher shape and not assume a native hook.

## Reproducible checklist

Use a disposable directory and a cheap model. Do not point any step at a session you are using.

```sh
mkdir -p "$S/proj" && cd "$S/proj" && git init -q
printf 'REBRIEF-%s\nSynthetic fixture: no live tickets.\n' "$(openssl rand -hex 4)" > briefing.txt
PORT=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.ori/code-daemon/daemon.json")))["port"])')
TOKEN_FILE=~/.ori/daemon/$PORT.token   # read it; never print it

# 1. Mid-turn steer (continues the turn)
ori code -p 'Use the shell tool to run `sleep 3`. Then write a numbered list of 120 countries and capitals and finish with FIRST-DONE.' \
  --model google/gemini-2.5-flash --output jsonl > mid.jsonl &
#    when a tool.started event for that sessionId appears (read mid.jsonl), send:
curl -s -m 10 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H 'content-type: application/json' \
  -d '{"sessionId":"<id>","mode":"steer","text":"Before you stop, read briefing.txt with a tool and reply with its first line."}' \
  "http://127.0.0.1:$PORT/api/steering/send"
#    expect {"delivered":true}, a turn.steered event and the nonce in assistant.text.delta

# 2. Late steer at the natural stop: repeat 1 but send once assistant.text.delta follows tool.succeeded
#    expect {"delivered":false} after the turn ends, no turn.steered, no nonce

# 3. Steer after the turn ended: expect no response within the client timeout and
#    GET /api/steering/queued/<id> → {"queued":[]}

# 4. Post-stop new turn in the same session
ori code -p 'Remember the codeword CODE-123. Reply only with OK.' --model google/gemini-2.5-flash --output jsonl > first.jsonl
ori code -p 'Read briefing.txt with a tool, then reply with its first line and the codeword I gave you earlier.' \
  --resume "<sessionId from first.jsonl result>" --model google/gemini-2.5-flash --output jsonl > resume.jsonl
#    expect the same sessionId in the result, and both the nonce and CODE-123 in the answer
```

Read `type` from `event.event` where `event.type` is `runtime.event`, and the terminal `result` line for `ok` and `sessionId`. Record only event types, delivery flags and whether the nonce appeared.

## Limits

- Only headless sessions on one model were probed. Attended TUI behaviour for externally submitted (`--resume`) turns, `steer` while a TUI turn is in flight, and session-exit and transport-loss events are unverified.
- The late-steer result is two runs with one model and one timing (sent on the first final-answer delta). The source reading does not explain it (see Result, item 2). A different interleaving, such as a steer landing before the final-step commit, might be delivered and continue the turn. Even then it would be a race, not a hook.
- No watcher process, PDB call from a hook or end-to-end loop was built. The test-case rows marked "core rule only" are design, not observation.
- Windows, Linux and other Ori versions were not tested. The daemon routes are internal APIs of an alpha build and may change without notice.

## Sources

- `ori --help`, `ori code --help` and `ori daemon --help` of `0.17.0-alpha+028abb4`
- Generated SDK `~/.ori/global/.ori/sdk/index.ts` and `enums.ts` (`AgentRuntimeEventTag`, `AgentSessionLifecycleEvent`, `AgentFailure*`, `HarnessCallback`, `createHook`, `definePoint`)
- Bundled feature-authoring docs (Contract, Harnesses, Schedules, Webhooks) shipped in the installed binary
- Installed binary strings: steering delivery (`deliverableAt`, `take("turn")`, `take("step")`, `commitStep`/`stopUnlessSteered`), steering routes and hold limits, extension point names
- [Ori / OpenRouter report](ori-openrouter.md) (#24) and [Ori MCP acceptance result](ori-mcp-acceptance.md) (#255)
