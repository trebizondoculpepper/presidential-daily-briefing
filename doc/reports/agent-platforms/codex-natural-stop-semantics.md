# Codex natural completion and interruption (#636)

2026-11-15, priya_xu. Research performed inside this native Codex task; the running client exposes `CODEX_VERSION=0.169.0`. Separately inspected local `codex-cli 0.169.0`; matching version strings do not prove identical orchestration. Host: macOS 27.2.1 build 26B131, arm64; Node 26.10.0. Desktop bundle version unavailable at the conventional `/Applications/Codex.app` location. Researcher model/provider identity is not reliably exposed; no identity is inferred from a display name. Inspected PDB source revision: `62f2b18f6835ac3a2a8d888b53dcac6862a3a5bd`. No new model trial, trust change, hook installation or private transcript inspection was performed.

This is a focused follow-up to [#387's protocol findings](codex-stop-hooks.md), [#398's observed native prototype](codex-stop-hook-prototype.md), and the shipped [shared rebrief interface](../../rebrief.md). It does not repeat the platform survey. It does not gate #581/#582's attended installers.

## Result and evidence levels

A thin native adapter can forward a proven completion to installed `pdb`; a generic command-hook Stop payload alone cannot prove every cause of stopping. Keep selection policy, session state, duplicate suppression and framing in PDB. Preserve explicit user cancellation even if a briefing fetch is already in flight.

The prior #398 trial observed a trusted hook, fresh unpredictable nonce receipt and same-session continuation after controlled natural completion, followed by a reentry stop. Those observations remain valid for that recorded trial. They did not exercise native cancellation, errors or disconnection; this report adds inspection and a manual plan, not fabricated observations of those paths.

The current [official guide](https://learn.chatgpt.com/docs/hooks#stop) describes Stop continuation through a blocking reason, a reentry flag, separate Interrupt handling, and startup sources. Interrupt output cannot prevent cancellation or restart the turn. Command input includes session/turn context but no general stop-cause discriminator. SessionEnd is advisory. Its wire schemas may differ from unreleased upstream main.

Read-only local commands executed:

```sh
codex --version
codex features list
codex app-server generate-json-schema --out /tmp/pdb636-schema
npx tsx doc/reports/examples/codex-stop-protocol.ts
```

The installed feature table reports hooks stable/enabled. Schema generation and the existing protocol fixture passed without starting an app-server session or model. These are capability/mapping observations, not native event observations.

Small sanitized extract from the locally generated schemas, retaining no session values:

```json
{
  "HookStartedNotification": {
    "properties": ["run", "threadId", "turnId"],
    "runEventNamesInclude": ["sessionStart", "stop", "interrupt"]
  },
  "TurnCompletedNotification": {
    "properties": ["threadId", "turn"],
    "turnStatusValues": ["completed", "interrupted", "failed", "inProgress"]
  }
}
```

These are schema declarations, not captured runtime notifications. A terminal completed notification is generally too late to return a synchronous Stop-hook response. An app-server integration must establish completion provenance in its lifecycle, rather than waiting for a notification and pretending it was available in hook stdin.

Upstream source was inspected at commit `a394ff9cf66e9c17258077e8f8295178ca0c2025`; it is corroborating implementation evidence, not proof of installed-release identity. The [turn loop](https://github.com/openai/codex/blob/a394ff9cf66e9c17258077e8f8295178ca0c2025/codex-rs/core/src/session/turn.rs) calls Stop in its successful no-follow-up path and handles errors separately. The [Stop request type](https://github.com/openai/codex/blob/a394ff9cf66e9c17258077e8f8295178ca0c2025/codex-rs/hooks/src/events/stop.rs) has no cause field. [Interrupt tests](https://github.com/openai/codex/blob/a394ff9cf66e9c17258077e8f8295178ca0c2025/codex-rs/core/tests/suite/interrupt_hooks.rs) cover explicit interruption, timeout, asynchronous execution, idle startup interruption and a self-aborted compaction. Thus an Interrupt event does not uniquely identify a human cancellation. Conservatively treating all interruption as ineligible for continuation preserves user stops without inventing provenance.

## Capability matrix

| Situation                           | Evidence here                                                                    | Recommended handling                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Controlled natural completion       | Prior #398 native nonce receipt; current protocol mapping passes                 | Eligible only with verified native binding and authorized continuation                   |
| Explicit active user stop           | Documented separate Interrupt; upstream tests; not newly exercised here          | Cancel outstanding work, suppress offers and never queue a replacement turn              |
| Internally interrupted/aborted work | Upstream self-abort test; no new native observation                              | Treat as interrupted, not natural completion                                             |
| Provider error or disconnect        | Error branch inspected; release-specific behavior and reconnect races unobserved | No inferred natural flag; leave stopped until native state is known                      |
| Recursive Stop continuation         | Prior native reentry observed; `stop_hook_active` mapped and fixture tested      | Suppress recursive offer; preserve duplicate/event protections                           |
| Fresh session                       | Documented SessionStart plus installed schema capability; no new trial           | Resolve explicit repo/agent/role/session binding; initialize separate state deliberately |
| Resume/compact/fork                 | Documented startup sources, release path untested here                           | Do not reset an existing session's deduplication history merely because a turn changes   |
| Hook trusted                        | Prior owner trust and native execution                                           | Exact-definition trust is necessary but says nothing about this event's cause            |

Trusted context is the native event envelope and an explicitly verified session/project/identity binding. Cwd is a path, not proof of a default HTTP server's repository. The last assistant message is model text, not an authenticated completion cause. Transcript formats are not a stable cause API; do not read private transcripts to guess. Missing fields, reconnect state, model identity and transport receipt remain unknown unless independently established.

## Adapter recommendation and policy mismatch

Retain forwarding-only shell/PowerShell wrappers calling installed `pdb rebrief codex-stop`. No shell queue logic, ticket ranking, transcript interpretation or fabricated `--natural-stop-confirmed` flag. The existing confirmation flag is suitable only for the controlled trial described in #398; do not enable it universally on the basis of hook trust.

Production automatic continuation needs a release-specific native provenance mechanism or a separately reviewed contract that establishes when that host's Stop event is eligible. Until verified, report the uncertainty and keep the attended installation experimental. An Interrupt signal must invalidate an in-flight offer before delivery; process exit, a missing error string, or a delayed successful HTTP response is insufficient evidence to resume.

The owner does not want arbitrary PDB work/spending caps on normal approved continuation. The current shared core still enforces a three-offer session cap, and reentry suppression limits a native chain. Those are current implementation facts, not requirements imposed by this research or unavoidable universal Codex constraints. Resolving the PDB cap needs its own reviewed contract and implementation change; this report does not silently change it. Individual request deadlines and duplicate/reentry protections should remain. No paid trial allowance is renewed.

## Exact isolated owner test plan

Use the already reviewed #398 harness in a disposable project/home/state directory, with synthetic read-only facts. Record client version, OS/runtime, model returned by the client, configuration hash, sanitized session/turn correlation IDs and UTC times. Keep credentials in the supported native auth path; do not copy or commit them. Review/trust the exact temporary definition through the normal native UI. Do not modify the user's existing experimental definition as a side effect.

1. **Preflight without generation:** initialize the app-server and inspect `hooks/list`. Save only handler type, enabled/trust state, source class and errors. Confirm the exact reviewed command points to the intended installed PDB or controlled harness. Untrusted/unavailable ends this case as unsupported or awaiting trust, not passed.
2. **Natural completion:** after explicit trial authorization, start one short turn asking for a fixed harmless response. Require one Stop event with matching session/turn IDs, reentry false, a fresh synthetic briefing nonce and same-session receipt. Record the second Stop's reentry state and ensure it terminates. A hook's stdout alone is not receipt.
3. **Active interruption:** start a deliberately waiting synthetic turn, interrupt through the native UI while active, and record Interrupt plus terminal interrupted status. Expect no continuation request or nonce receipt. A cancellation on an idle thread is a separate negative case, not evidence for active cancellation.
4. **In-flight fetch race:** delay only the local synthetic briefing response, interrupt while it is pending, then let it resolve. Expect suppression even if the server eventually returns success. Fail if any replacement turn is queued. Correlate events without preserving raw user/model text.
5. **Failure/disconnection:** use an isolated, controlled transport failure without changing production credentials. Record actual terminal state and hook sequence. If no safe injection mechanism exists, mark untested; do not infer from a synthetic Stop with an invented cause. Do not repeatedly retry a potentially billed request.
6. **Startup/resume:** inspect SessionStart sources for a fresh disposable session and a resume. Confirm binding initialization and that resume does not reset existing duplicate history. Test unknown/missing binding, wrong session and repeated event IDs using the credential-free fixtures first.
7. **Cleanup:** remove only the exact temporary hook entries and owned state/processes. Reinspect discovery to prove removal. Preserve unrelated user hooks and the original experimental installation. Record remaining untested paths and any native limitations.

No new paid trials are authorized by this plan. The owner must choose a concrete available trial allowance before steps requiring generation; read-only preflight and fixtures remain free of model calls. Stop on the first trust/provenance ambiguity and report it rather than bypassing native trust. Successful attended installation is a separate acceptance boundary from universal event semantics.
