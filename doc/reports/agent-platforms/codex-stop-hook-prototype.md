# Codex Stop prototype (#398)

2026-11-15, priya_xu, actual Codex researcher session; researcher model identifier unavailable. Target: installed Codex CLI/app-server 0.169.0, macOS 27.2.1 arm64, Node 26.10.0. **Native trial status: blocked on hook trust, not supported or unsupported.** Zero model turns used; the approved allowance remains at most fifteen minutes and two short turns on the existing account/model.

## Completed implementation

`src/rebrief/codex.ts` translates a verified natural Codex Stop into the #506 shared core and maps an offered briefing to `decision: block` with that exact briefing as the reason. Wrong session, reentry, Interrupt, unknown natural-stop provenance and cancellation permit normal stop. It does not acknowledge delivery: stdout emission is not model-visible receipt. Synthetic tests reuse the actual shared briefing service and engine; they establish mapping and guards, not native event/receipt/continuation.

`doc/reports/examples/codex-stop-trial.ts` is a disposable entry point over the shared session/state/transport implementation. It uses synthetic read-only facts, an unpredictable receipt nonce, a five-second deadline and private preinitialized session state. It never reads transcripts, invokes models or mutates live tickets. Natural-stop confirmation is off unless the controlled trial explicitly supplies `--natural-stop-confirmed`. Do not enable that flag for unknown Stop causes. No production hook is installed.

## Actual-client preflight

A fresh disposable `CODEX_HOME` contained only a candidate `hooks.json` with one Stop command and timeout five seconds. Called the real app-server's `initialize` and `hooks/list` with the disposable project cwd. It returned one enabled command hook, no discovery warnings/errors, non-managed user source and **trustStatus: untrusted**. No `thread/start` or `turn/start` was sent. No auth/config file was copied, no trust database was edited, and `--dangerously-bypass-hook-trust` was not used.

The installed app-server protocol exposes `hooks/list` but no hook-trust mutation. Normal review/trust is through the client's `/hooks` UI. The [official hook guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) confirms exact-definition trust and the [Stop contract](https://learn.chatgpt.com/docs/hooks#stop). Discovery alone is not execution or receipt.

| Boundary                                             | Outcome                                      |
| ---------------------------------------------------- | -------------------------------------------- |
| Real Codex discovers configured Stop command         | observed                                     |
| Hook trusted/executed on native Stop                 | blocked / not run                            |
| Shared core and thin translation                     | synthetic tests passed                       |
| Fresh briefing delivered to client/model             | not run                                      |
| Same-session nonce receipt/continuation              | not run                                      |
| Native interruption, empty/error/unchanged/cap paths | not run; shared-core synthetic coverage only |

## Reproduction and removal

1. Install dependencies in this checkout. Create private disposable home, project and state directories with Node `fs.mkdtemp`; do not use personal Codex settings.
2. In disposable `hooks.json`, configure one Stop command: `node --import /absolute/checkout/node_modules/tsx/dist/loader.mjs /absolute/checkout/doc/reports/examples/codex-stop-trial.ts /absolute/private-state-dir --natural-stop-confirmed`, timeout 5. The confirmation flag is exclusively for an observed controlled natural-stop trial. Changing the definition changes its trust hash.
3. Inspect the definition in the normal Codex `/hooks` UI under that disposable home and trust that exact candidate. Do not bypass trust or copy auth/configuration. Use the already-approved existing account/model only through the client's supported auth path.
4. Create the actual target session, then initialize its private state with the same session ID: `pdb rebrief init --json --state-dir /absolute/private-state-dir --session ACTUAL_SESSION --repo example/project --agent probe --role implementer --platform codex`. The trial helper uses synthetic `example/project` facts; it does not collect that repository live.
5. Within the existing two-turn/fifteen-minute bound, finish a short synthetic natural turn. Record native hook event, exact offered fingerprint/nonce, model-visible nonce receipt and matching session/turn before any acknowledgement. Do not count merely returning block as delivery. Stop on trust/auth/capability failure rather than spend repeated trials. No native success is claimed by this report.
6. Stop the disposable client, remove only its temporary hooks/home/project/state directories, and retain only sanitized outcome metadata. Raw session IDs, event inputs and transcripts must not be published. Acknowledge only proven delivery, using the shared core's exact event/fingerprint mechanism; ambiguous delivery permits normal stop.

The preflight directories were removed after retaining sanitized trust status. A later trial must create a fresh candidate and review its current definition. #398 stays open: normal trust and actual native evidence are still outstanding. Its existing allowance is sufficient; this is not a request for a renewed budget.
