# Codex Stop prototype (#398)

2026-11-15, priya_xu, actual Codex researcher session; researcher model identifier unavailable. Target: installed Codex CLI/app-server 0.169.0, macOS 27.2.1 arm64, Node 26.10.0. **Native trial status: natural Stop → fresh nonce → same-session continuation observed.** Resumed after the owner trusted the exact project definition. One `turn/start`, two short model completions (initial and hook continuation), approximately six seconds; no further model trials were run. Target model reported by `thread/start`: `gpt-6.1-sol`.

## Completed implementation

`src/rebrief/codex.ts` translates a verified natural Codex Stop into the #506 shared core and maps an offered briefing to `decision: block` with that exact briefing as the reason. Wrong session, reentry, Interrupt, unknown natural-stop provenance and cancellation permit normal stop. It does not acknowledge delivery: stdout emission is not model-visible receipt. Synthetic tests reuse the actual shared briefing service and engine; they establish mapping and guards, not native event/receipt/continuation.

`doc/reports/examples/codex-stop-trial.ts` is a disposable entry point over the shared session/state/transport implementation. It uses synthetic read-only facts, an unpredictable receipt nonce, a five-second deadline and private preinitialized session state. It never reads transcripts, invokes models or mutates live tickets. Natural-stop confirmation is off unless the controlled trial explicitly supplies `--natural-stop-confirmed`. Do not enable that flag for unknown Stop causes. The owner subsequently requested the project-local experimental installation and trusted it; it remains experimental, with state bound only to the disposable trial session.

## Actual-client preflight

A fresh disposable `CODEX_HOME` contained only a candidate `hooks.json` with one Stop command and timeout five seconds. Called the real app-server's `initialize` and `hooks/list` with the disposable project cwd. It returned one enabled command hook, no discovery warnings/errors, non-managed user source and **trustStatus: untrusted**. No `thread/start` or `turn/start` was sent. No auth/config file was copied, no trust database was edited, and `--dangerously-bypass-hook-trust` was not used.

The installed app-server protocol exposes `hooks/list` but no hook-trust mutation. Normal review/trust is through the client's `/hooks` UI. The [official hook guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) confirms exact-definition trust and the [Stop contract](https://learn.chatgpt.com/docs/hooks#stop). Discovery alone is not execution or receipt.

| Boundary                                             | Outcome                                      |
| ---------------------------------------------------- | -------------------------------------------- |
| Real Codex discovers configured Stop command         | observed                                     |
| Hook trusted/executed on native Stop                 | observed after owner trust                   |
| Shared core and thin translation                     | synthetic tests passed                       |
| Fresh briefing delivered to client/model             | observed: exact unpredictable nonce echoed   |
| Same-session nonce receipt/continuation              | observed; matching thread and turn IDs       |
| Native reentry/normal final completion               | second hook completed without feedback       |
| Native interruption, empty/error/unchanged/cap paths | not run; shared-core synthetic coverage only |

## Reproduction and removal

1. Install dependencies in this checkout. Create private disposable home, project and state directories with Node `fs.mkdtemp`; do not use personal Codex settings.
2. In disposable `hooks.json`, configure one Stop command: `node --import /absolute/checkout/node_modules/tsx/dist/loader.mjs /absolute/checkout/doc/reports/examples/codex-stop-trial.ts /absolute/private-state-dir --natural-stop-confirmed`, timeout 5. The confirmation flag is exclusively for an observed controlled natural-stop trial. Changing the definition changes its trust hash.
3. Inspect the definition in the normal Codex `/hooks` UI under that disposable home and trust that exact candidate. Do not bypass trust or copy auth/configuration. Use the already-approved existing account/model only through the client's supported auth path.
4. Create the actual target session, then initialize its private state with the same session ID: `pdb rebrief init --json --state-dir /absolute/private-state-dir --session ACTUAL_SESSION --repo example/project --agent probe --role implementer --platform codex`. The trial helper uses synthetic `example/project` facts; it does not collect that repository live.
5. For any separately authorized reproduction, finish a short synthetic natural turn within its explicit budget. The original two-completion allowance was consumed by the resumed trial below. Record native hook event, exact offered fingerprint/nonce, model-visible nonce receipt and matching session/turn before any acknowledgement. Do not count merely returning block as delivery. Stop on trust/auth/capability failure rather than spend repeated trials. The resumed trial below records the observed successful path; this recipe alone is not evidence.
6. Stop the disposable client, remove only its temporary hooks/home/project/state directories, and retain only sanitized outcome metadata. Raw session IDs, event inputs and transcripts must not be published. Acknowledge only proven delivery, using the shared core's exact event/fingerprint mechanism; ambiguous delivery permits normal stop.

## Resumed native trial, 15 November 2026

The owner installed/trusted the project definition in the main checkout. Real
`hooks/list` returned enabled, trusted, project-scoped Stop command, with no
warnings/errors. The definition was left unchanged throughout this trial. No
trust bypass or private trust-store modification was used.

An ephemeral actual Codex app-server thread used the existing account/default
model, read-only sandbox and no approvals. Instructions restricted it to synthetic
text replies, with no tools, repository work or live ticket mutations. Initialized
private shared-core state for the actual thread, `example/project`, `probe`,
`implementer`, `codex`; the helper used the synthetic shared service, not a live
GitHub repository or an HTTP MCP read. Sent one prompt requesting `READY` and a
natural finish. Observed:

1. Initial assistant final message `READY`.
2. Native `hook/started` then `hook/completed`, status `blocked`, 368 ms. Its
   feedback contained the fresh role briefing and unpredictable receipt nonce.
3. The next assistant final message exactly equalled that nonce, in the same
   thread and turn. The nonce had not appeared in the initial user input.
4. A second Stop hook completed in 163 ms with no feedback, followed by
   `turn/completed` status `completed`. No replacement session, second
   `turn/start`, tools or live repository mutation occurred.

Raw session/turn identifiers, transcripts and hook inputs are not published. The
retained public evidence is this sanitized event sequence. Native cumulative usage
reported 43,933 tokens: 43,900 input (29,568 cached) and 33 output, including both
completions. Monetary cost was not exposed. The allowance is conservatively treated
as consumed by the initial completion and its continuation; no repeated paid trial
is authorized by this result. No automatic delivery acknowledgement was added.

This establishes natural event, shared-core execution, client feedback, exact
model-visible receipt and same-session continuation for the installed macOS CLI
app-server target. It does not establish the hosting app's own hook execution,
Windows, HTTP MCP freshness, native cancellation/error/empty/unchanged/cap cases,
or a deployable packaged interface. The existing core/adapter tests cover guards
synthetically; do not promote them to native observations.

The owner also directed the final integration to invoke installed `pdb` directly,
with any shell/PowerShell wrapper forwarding only arguments/stdin/status. The
checkout-specific bundled helper remains trial scaffolding, not the final setup.
A separate documentation-first CLI contract and packaged implementation are still
required. Preserve the trusted local definition until deliberately replacing it;
a changed definition must pass normal native trust again. #398 remains open for
these delivery and validation boundaries.
