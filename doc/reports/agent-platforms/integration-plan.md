# Agent-platform integration plan (#20)

This is the synthesis of the per-platform research under `doc/reports/agent-platforms/` into one plan: a generic MCP and CLI service with opt-in platform adapters. It is documentation only. It authorizes no implementation, installs no hook, runs no model turn and changes no host configuration; each adapter still needs its own reviewed contract and ticket.

## Provenance

- Author: `kavya_sabbagh`, running in Claude Code 2.1.x (model: Claude Opus 5.5) on macOS 27.2.1, Node v26.7.0, on 21 November 2026, against `origin/main` at the commit this document merges onto.
- Method: read-only synthesis. Three delegated reading passes (Claude Code subagents, same harness) extracted capability claims, with citations, from disjoint sets of reports; the author spot-checked claims against the sources (for example the Claude Code eight-continuation cap, the Ori no-stop-hook result, Antigravity's `terminationReason` enum and the Ori prototype's `receivedAction` evidence). No client was launched and no research was repeated.
- Every verification level below is the level the cited report states. This synthesis upgrades none of them.

## Sources

Selected platforms (the owner's coverage on this ticket):

| Platform         | Ticket | Reports                                                                                                                                                                                                                |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | #225   | `claude-code.md`, `claude-code-review-addendum.md`, `claude-code-mcp-acceptance.md`, `claude-code-http-mcp-acceptance.md`, `claude-code-stop-hooks.md`                                                                 |
| Codex            | #224   | `codex.md`, `codex-review-addendum.md`, `codex-mcp-acceptance.md`, `codex-http-mcp-acceptance.md`, `codex-stop-hooks.md`, `codex-stop-hook-prototype.md`, `codex-natural-stop-semantics.md`, `codex-thread-binding.md` |
| OpenCode         | #23    | `opencode-mcp-acceptance.md`, `../opencode-idle-wakeup.md` (#23 closed through that report and PR #1201, not a separate `opencode.md`)                                                                                 |
| Ori / OpenRouter | #24    | `ori-openrouter.md`, `ori-mcp-acceptance.md`, `ori-install-acceptance.md`, `ori-stop-hooks.md`, `ori-stop-hook-prototype.md`                                                                                           |
| Antigravity      | #264   | `antigravity.md`, `antigravity-natural-stop-semantics.md` (replaces Gemini CLI coverage; `gemini-cli.md` is history)                                                                                                   |
| GitHub Copilot   | #227   | `github-copilot.md`                                                                                                                                                                                                    |
| Cursor           | #228   | `cursor.md`                                                                                                                                                                                                            |
| Pi               | #231   | `pi.md`                                                                                                                                                                                                                |

Historical reference only, excluded from active integration by owner decision: Cline (`cline.md`, #229) and Goose (`goose.md`, #230).

## Terms

The reports use overlapping words for different mechanisms. This plan uses one vocabulary:

- **Core MCP**: the PDB MCP server answering tool calls from a client (stdio or HTTP). Interoperability is proven per client; it says nothing about waking a session.
- **Model SDK**: a provider library that starts a new model completion (`@openrouter/sdk`, `@google/genai`, `pi-ai`). It never reaches a user's running agent.
- **Session controller**: a library or protocol that drives sessions it starts itself (Claude Agent SDK, Codex SDK and app-server, `codex-acp`, `copilot --acp`, `cursor-agent acp`, `agy acp`, Pi RPC). "Resume" in these means history loaded into a new process, not attachment to the user's session.
- **Before-stop continuation**: a host hook that runs when a turn is about to end and can make the same turn continue (a veto of the stop). It is not a wake of an idle session.
- **Idle wake**: something that starts a new turn in an existing, idle, user-owned session.
- **Next-turn context**: text attached to the next turn the user starts; it starts nothing.

Delivery states are reported with one vocabulary across adapters: `unsupported`, `queued`, `observed`, `failed`, `unknown` (from `codex-idle-wakeup.md`). "Queued" never means "observed", and only inspection of the specific delivered batch acknowledges it.

## Capability matrix

Verification levels: **real-client** (exercised in the named client), **fixture** (scripted against a harness), **documented** (vendor docs), **source** (source inspection), **help** (CLI help only), **none**.

### Core MCP

| Platform       | Result and level                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | Stdio **real-client, conditional**: large default results exceed the client's MCP output limit unless `MAX_MCP_OUTPUT_TOKENS` is raised, because the client forwards `structuredContent` [claude-code-mcp-acceptance.md § Findings]. HTTP **real-client, conditional** (second repository hit the 500-subject engine bound; cross-project isolation unverified) [claude-code-http-mcp-acceptance.md]. Cancellation observed (`notifications/cancelled`). |
| Codex          | Stdio **real-client (app-server API), conditional**; automatic identity supported after the #402 retest [codex-mcp-acceptance.md]. HTTP **conditional pass** with two isolated clients and restart recovery; cancellation, notifications and UI rendering not tested [codex-http-mcp-acceptance.md].                                                                                                                                                     |
| OpenCode       | **real-client, supported** (v2.3.0) for discovery, reads, identity paths and invalid input; cancellation not run; `opencode mcp add` writes a key the client ignores (#1203) [opencode-mcp-acceptance.md].                                                                                                                                                                                                                                               |
| Ori            | **real-client, conditional**: no `notifications/cancelled` on interrupt, and servers start in the daemon's working directory, so `--project`/`--repo` is required [ori-mcp-acceptance.md § Findings]. Installer verified with `ori mcp test` [ori-install-acceptance.md].                                                                                                                                                                                |
| Antigravity    | stdio and Streamable HTTP **documented**; live attachment not tested [antigravity.md].                                                                                                                                                                                                                                                                                                                                                                   |
| GitHub Copilot | CLI, VS Code agent mode and cloud agent are MCP clients, **documented/help**; no session run; no harness detector [github-copilot.md].                                                                                                                                                                                                                                                                                                                   |
| Cursor         | editor/CLI MCP **documented/help**; resolve `cursor-agent` explicitly (name clash with another `agent` binary) [cursor.md].                                                                                                                                                                                                                                                                                                                              |
| Pi             | built-in MCP **documented/source**; not installed [pi.md].                                                                                                                                                                                                                                                                                                                                                                                               |

### Existing-session continuation and wake

| Platform       | Before-stop continuation                                                                                                                                                                | Idle wake                                                                                                                                                                                                                                           | Natural stop vs user interrupt                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `Stop` hook `decision:block` continues the same turn, hook text reaches the model: **real-client (print mode)**; eight-continuation native cap (documented) [claude-code-stop-hooks.md] | `asyncRewake`, inbox socket, Channels: **documented only**, no wake experiment [claude-code.md]                                                                                                                                                     | Esc/Ctrl-C never fires `Stop`: **documented** (not sendable in print mode)                                                                              |
| Codex          | `Stop` hook `decision:block` continues the same thread/turn, nonce echoed: **real-client (app-server 0.169.0)** after owner trust [codex-stop-hook-prototype.md]                        | `codex queue --thread` **help only**; exit 0 can mean only "queued" [codex.md, codex-review-addendum.md]                                                                                                                                            | `Stop` has no cause field; `Interrupt` also fires on timeout/self-abort, so all interrupts are ineligible: **source** [codex-natural-stop-semantics.md] |
| OpenCode       | none (no native stop hook)                                                                                                                                                              | `session.idle` then `session.prompt`: proven only by an installed mailbox plugin; PDB adapter not built [opencode-idle-wakeup.md]                                                                                                                   | none: idle fires after both completion and interrupt, so an adapter must fail closed                                                                    |
| Ori            | **none**: no before-stop hook [ori-stop-hooks.md]                                                                                                                                       | headless `--resume <id>` starts a new turn in the same session (not a veto): **observed**, owned headless sessions only; attended TUI unverified; late steer at the stop dropped (cause unresolved) [ori-stop-hooks.md, ori-stop-hook-prototype.md] | `turn.succeeded` vs `turn.cancelled` vs `turn.failed`: **source**                                                                                       |
| Antigravity    | `Stop` hook `decision:"continue"` vetoes the stop and injects a system message: **documented** [antigravity-natural-stop-semantics.md]                                                  | `/schedule` (clock-driven self-wake, a model turn per firing); App 2.0 `agentapi send-message`: **documented**, sidecar not exercised [antigravity.md]                                                                                              | `terminationReason` enum (`NO_TOOL_CALL` vs `USER_CANCELED`, and others): **documented**, not observed                                                  |
| GitHub Copilot | none documented                                                                                                                                                                         | SDK `forUri` enqueue / `--connect`: reach into an ordinary terminal session **unverified** [github-copilot.md]                                                                                                                                      | not researched                                                                                                                                          |
| Cursor         | `stop` hook `followup_message` auto-submitted as the next user message, bounded by `loop_limit`: **documented**; CLI hook firing unverified [cursor.md]                                 | unsupported in editor and CLI                                                                                                                                                                                                                       | not documented                                                                                                                                          |
| Pi             | none                                                                                                                                                                                    | in-process extension `pi.sendMessage(..., {triggerTurn})` is the only route into a running session: **source** [pi.md]                                                                                                                              | not documented                                                                                                                                          |

Busy-turn behaviour is mostly unverified. What is documented: Claude Code delivers typed mid-turn messages between tool calls; Ori queues up to 32 pending messages per session (source); Antigravity's TUI queues by default; Copilot's SDK distinguishes `enqueue` from `immediate` (adapters must use `enqueue`). No report shows a wake that safely interrupts a busy turn, and none should be built.

## Contradictions and corrections carried forward

Conclusions are not averaged across reports. Where reports disagree, the later or more direct evidence wins, and the disagreement is recorded:

1. **Claude Code MCP is conditional, not unqualified** (review addendum corrects `claude-code.md`): the output-limit condition must appear in any setup guidance.
2. **Codex delivery proof**: `turn/started` is not proof of delivery (a turn can start for unrelated input, and a steer emits none). Delivery must be correlated with the exact batch [codex-review-addendum.md].
3. **Codex Stop hooks**: `codex-stop-hooks.md` marks every native boundary untested; `codex-stop-hook-prototype.md` later observed natural Stop and same-session continuation. The prototype result supersedes for that path only; interruption, error and cap paths remain unrun.
4. **Ori prototype wording**: its result line says the model answered the briefing's first action, but its evidence section records `receivedAction: false` (the action id was truncated), and the prototype correctly did not acknowledge delivery. Treat Ori continuation as observed but delivery as unacknowledged.
5. **Antigravity payload**: `antigravity.md` requires fixed notices only (no GitHub text in hook or sidecar payloads); `antigravity-natural-stop-semantics.md` proposes the briefing as the Stop `reason`. This plan follows the stricter rule for untrusted ticket text: deliver a fixed instruction to run `pdb` (which applies its own redaction and bounds), not raw ticket text, until a reviewed contract settles it.
6. **Index drift**: `README.md` in this directory lists only Codex, Claude Code and Ori; this PR links every report.

## Recommended architecture

The smallest shared design reuses what already exists and adds only thin adapters:

1. **Generic services stay primary** (#25): `pdb` CLI and `pdb-mcp` (stdio and HTTP) remain the integration for every platform, and must stay fully usable with any adapter disabled or unsupported.
2. **One event source** (#32, `doc/design/polling-events.md`): optional in-process polling producing versioned domain events in a bounded process-local queue, read with `triage_events`. No adapter adds a second collector, webhook, daemon or persistent per-agent store.
3. **One decision core** (`doc/design/shared-rebrief-core.md`, with `approved-continuation-limits.md`): `pdb rebrief` decides `stop | continue | defer` from a fresh bounded read, owns fingerprints, deduplication and acknowledgement, and never ranks or rewrites the queue. Native adapters own only client event decoding, the stop/continue response and session binding.
4. **Thin native adapters**, opt-in and installed through the existing attended installer boundary (`doc/design/attended-installer-delivery.md`; `src/install/*`). Each adapter declares a capability record so clients and docs can discover what it supports. Adapters load lazily; no platform SDK becomes a baseline dependency.
5. **Session controllers (ACP and vendor SDKs)** are reserved for sessions PDB itself is asked to start. They do not reduce the work of reaching an existing interactive session, because none of them attaches to one. ACP is therefore not a shared delivery layer for this plan; it may later serve a separate, explicitly requested "start an agent" feature.

### End-to-end boundary

`detected → queued/notified → observed → turn started → inspected/acknowledged`

- **Detected**: a domain event in the #32 queue, or a natural stop seen by a native hook.
- **Queued/notified**: the adapter handed something to the host. This is not delivery.
- **Observed**: the host reports a turn or continuation for the exact session.
- **Inspected/acknowledged**: only the exact delivered batch, matched by fingerprint, is acknowledged (shared core receipt rules).

Binding: explicit project, persistent agent name, platform and host session, using the existing identity resolver; a GitHub login or session id never grants authority. Unknown stop causes, user interruption, cancellation and failure always allow the stop and send no new turn. Reconnect relies on `triage_briefing(since=…)`, never invented history. Duplicate events and unchanged fingerprints are suppressed by the core. A notification never claims work, grants authority, or turns ticket text into instructions.

## Library comparison

Only libraries an adapter might actually load are compared; the hosts themselves are prerequisites, not dependencies.

| Library                                  | Role                         | Licence                          | Runtime     | Use in this plan                                                  |
| ---------------------------------------- | ---------------------------- | -------------------------------- | ----------- | ----------------------------------------------------------------- |
| `@modelcontextprotocol/server` 2.4.0     | MCP server                   | Apache-2.0                       | Node ≥20    | already the baseline                                              |
| `@agentclientprotocol/sdk` 2.6.0         | ACP                          | Apache-2.0                       | Node        | not needed (see architecture point 5)                             |
| `@anthropic-ai/claude-agent-sdk` 0.3.325 | session controller           | proprietary terms (owner review) | Node ≥18.14 | not needed; spends model turns, does not attach                   |
| `@openai/codex-sdk` 0.169.0              | session controller           | Apache-2.0                       | Node ≥18    | not needed; spends model turns, does not attach                   |
| `@github/copilot-sdk` 1.0.33             | session controller / enqueue | MIT                              | Node ≥20.19 | candidate only if a `forUri` enqueue experiment proves attachment |
| `@cursor/sdk` 1.3.1                      | session controller           | proprietary                      | Node ≥22.13 | not needed                                                        |
| `@openrouter/sdk`, `@google/genai`       | model SDKs                   | Apache-2.0                       | Node        | not needed                                                        |

The native hook adapters (Claude Code, Codex, Antigravity, Cursor) need no library at all: they are small commands that read hook JSON on stdin and call `pdb rebrief`. The OpenCode and Pi adapters are in-process plugins/extensions loaded by the host, again calling `pdb`. This keeps the baseline install unchanged.

## Staged rollout

1. **Stage 0 — generic MCP everywhere (in progress, #25).** Already real-client accepted, with conditions, for Claude Code, Codex, OpenCode and Ori. Fix the recorded conditions before widening: Claude Code output limit guidance, Ori `--project` requirement, OpenCode `mcp add` key (#1203) and project scope (#1204).
2. **Stage 1 — before-stop continuation where it is observed**: Claude Code (#27) and Codex (#26), through the shared rebrief core and the existing installers. Both have a real-client observation of same-session continuation.
3. **Stage 2 — owned-session and plugin adapters**: Ori headless watcher (#29; owned sessions only, never described as preventing a stop) and the OpenCode idle plugin (#28; fail closed because idle cannot distinguish interrupt).
4. **Stage 3 — documented-only platforms after a real-client check**: Antigravity Stop hook, Cursor `stop` follow-up, Pi `nextTurn` extension, Copilot `forUri` enqueue. Each first needs the minimal experiment in its report, run in that client.

### Real-client acceptance matrix

Core MCP interoperability and wake/continuation capability are accepted separately; passing one never implies the other.

| Platform       | Core MCP acceptance               | Continuation/wake acceptance needed                                                                  |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude Code    | stdio and HTTP conditional (done) | interactive-mode Stop continuation; user interrupt never continues; cap reached; receipt at cap      |
| Codex          | stdio and HTTP conditional (done) | interruption, error, unchanged and cap paths; hosting app (not only app-server) runs the hook        |
| OpenCode       | supported, cancellation not run   | the six owner test steps in `opencode-idle-wakeup.md`, including an interrupt that must not wake     |
| Ori            | conditional (done)                | attended TUI behaviour; HTTP MCP transport for the watcher (#390/#399); a full acknowledged delivery |
| Antigravity    | live MCP attachment               | Stop hook with `NO_TOOL_CALL` vs `USER_CANCELED` observed                                            |
| GitHub Copilot | CLI MCP session                   | `forUri` enqueue against an idle and a busy ordinary session                                         |
| Cursor         | editor/CLI MCP session            | logging-only `stop` hook, then one fixed follow-up, in the CLI and editor                            |
| Pi             | MCP from an installed `pi`        | `nextTurn` notice appears only on the next prompt and starts no turn                                 |

No public report or example may contain credentials, private transcripts, session ids or identity files.

## Tickets

Existing tickets are reused; this synthesis unblocks them for design, not implementation:

- **#26 (Codex)**, **#27 (Claude Code)**: proceed with Stage 1 contracts on the shared rebrief core and the existing installers.
- **#28 (OpenCode)**: proceed with the plugin adapter contract from `opencode-idle-wakeup.md`; fail closed on idle-after-interrupt.
- **#29 (Ori)**: proceed with the owned-session watcher; attended TUI stays unverified until tested.

Proposed new tickets (to be filed after this plan is reviewed, each needing owner readiness):

1. **Antigravity Stop-hook acceptance.** Why: the Stop hook and `terminationReason` are documented only. Evidence: `antigravity-natural-stop-semantics.md`. Acceptance: run the report's isolated owner test plan in `agy`; record natural stop vs `USER_CANCELED`; settle the payload question (point 5 above). Prerequisites: #25, shared rebrief core.
2. **Copilot `forUri` enqueue experiment.** Why: the only candidate route into an existing Copilot session is unverified. Evidence: `github-copilot.md` § Disposable-session test plan. Acceptance: idle, busy, burst and two-session cases; report `queued` vs `observed` honestly. No adapter is built here.
3. **Cursor and Pi real-client checks.** Why: both continuation routes are documented or source-only, and neither client was installed. Evidence: `cursor.md`, `pi.md`. Acceptance: each report's disposable test plan in the real client.

Not proposed: any ACP-based delivery layer, any model-SDK-driven "wake", or adapters for Cline and Goose.

## Open items

- The Claude Code `asyncRewake` idle wake, Codex `codex queue` into a TUI-owned thread, and Ori attended steering are all unverified routes into idle sessions; until tested, Stage 1–2 adapters continue a stopping turn or an owned session only.
- Whether the Codex hosting app (not only app-server) runs project hooks is unverified.
- The OpenCode and Copilot reports lack complete researcher provenance (no researcher name, model or date in some sections); later reports must state it.
