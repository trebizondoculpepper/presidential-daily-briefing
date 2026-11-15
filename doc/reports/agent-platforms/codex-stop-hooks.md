# Codex Stop hooks: protocol findings and verification boundary (#387)

Research by farhad_taphrale, 15 November 2026. Actual researcher: this Codex task on
macOS Darwin 27.2.0 arm64; `CODEX_VERSION` exposes 0.169.0 and its thread variable
matches this task. The exact model slug and orchestration location are not exposed.
The separately installed **codex-cli 0.167.2** is the inspected target, not claimed
to be the same running app-server build. No user hook/configuration was changed,
no target session was queued/resumed, and no model turn or paid trial was launched.

## What is established

The current official [hook guide](https://learn.chatgpt.com/docs/hooks#stop)
documents a synchronous `Stop` event capable of generating a continuation prompt
from a blocking reason. This is a native client capability, not portable MCP
server registration. Installed CLI help exposes hooks trust controls and
`codex features list` reports `hooks` stable/enabled. These are capability facts,
not proof that a particular configured hook ran or that a model received a nonce.

The guide also documents [MCP tool hooks](https://learn.chatgpt.com/docs/hooks#mcp-tool-hooks):
a host-configured lifecycle hook can call a tool on an already-connected server,
with structured event-field interpolation and the same hook response contract.
This offers a possible all-HTTP path for PDB without a subprocess. It does **not**
mean a server can register itself as a hook or that today's ordinary briefing
envelope already contains the Codex-specific continuation decision.

Recommendation: the reviewed #506 shared core plus a thin Codex adapter, with
command and MCP-tool entry points if verified. Do not create a separate queue
policy, assume a single platform-independent hook response, or use `codex queue`
as evidence that the exact briefing was received. Reuse #398 for the native
prototype and model-visible receipt/continuation evidence.

## Event and response mapping

Common command-hook input is one JSON object on stdin: session ID, cwd, optional
transcript path, model and permission mode; Stop adds turn ID, reentry flag
`stop_hook_active`, and optional last assistant message. Use explicit verified
project/agent/role binding, not cwd as an HTTP-server project default. Do not read
private transcript files merely to infer routing, and never publish their contents.

For Stop, success output must be JSON. A `decision` value of `block` plus a
`reason` requests continuation; the reason becomes another prompt in the same
session. It is not rejection/rollback of a completed turn. Exit code 2 with the
reason on stderr is another documented path. Prefer the JSON path for a typed
adapter; plain stdout text is invalid. A `continue:false` response overrides other
continuation decisions for that event. Empty/no-work handling should allow normal
stopping, not emit a fabricated instruction to keep working.

The guide separates Interrupt from Stop. Interrupt cannot veto cancellation or
restart generation; SessionEnd is advisory and cannot keep the session alive.
Stop has no documented cause field that independently distinguishes every budget,
error or disconnect pathway. Native #398 testing must confirm those event boundaries
rather than treating every synthetically named Stop as verified natural completion.
Use the shared core's fail-to-normal-stop rule when eligibility is uncertain.

The reentry flag says a turn has already been continued by Stop. Respect it plus
#506's event deduplication, last-delivered fingerprint and session cap. A fresh
fetch timestamp alone cannot justify another prompt. User interruption/disablement
wins, including while a PDB request is in flight. Do not start a replacement
session and call it same-agent continuation.

## Configuration and trust

The guide describes user `~/.codex/hooks.json`, project `.codex/hooks.json` and
inline configuration layers. Project hooks require a trusted project layer;
non-managed hook definitions require review/trust of their exact hash. The CLI's
`/hooks` UI manages that trust; changing the definition can require renewed review.
No trust bypass was used in this research. Neither file presence nor successful
JSON validation proves the hook is active.

Conceptual native configuration after #506/#398 deliver a real adapter:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/the-reviewed-codex-adapter.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The path above is deliberately illustrative, not a shipped executable. Pass
repository/name/role through reviewed adapter configuration, never interpolate
untrusted issue text into a shell command. Use the hook's actual session/turn and
registered project binding. The default general hook timeout documented by the
guide is much longer; set an explicit short deadline matching #506 instead of
holding a session for minutes. Windows needs its documented command override or
a separately tested invocation; this macOS research does not establish portability.

For an MCP-tool variant, configure host handler type `mcp_tool`, the already-connected
PDB server, and a _real delivered_ Codex adapter tool. Event templates can carry the
session/turn/reentry fields. The adapter must call the same shared rebrief core and
return the native Stop decision, not just the `triage_briefing` read envelope.
Missing/disconnected tools do not establish delivery; the guide says these hooks
do not start/reconnect their MCP server. Its shorter server/hook timeout governs.
No server-side self-registration or new MCP transport extension is proposed.

The official guide distinguishes local-only orchestration from managed cloud
orchestration: some cloud/local-computer configurations support only managed Global
MCP hooks and not local command hooks. The research task's exposed version/env
alone does not prove which hook-loading path this app session uses. Verify the
actual host/settings surface in the native prototype, rather than borrowing the
installed CLI's support claim for every Codex surface.

## Executed checks and reproducible fixtures

Read-only commands executed:

```text
codex --version
codex --help
codex features list
codex app-server --help
codex app-server generate-json-schema --out /tmp/pdb387-research/schema
```

The generated target protocol includes hook-run status/summary events. No app server
was started and no hook/model was executed by generating these schemas. Raw schemas
and the fetched guide stay outside Git. They are target capability evidence, not
receipt evidence for this running task.

Run the credential-free mapping probe:

```text
npx tsx doc/reports/examples/codex-stop-protocol.ts
```

It exercises the documented response shape with fake shared-core results: actionable
briefing nonce retained in the blocking reason; empty/deferred/unchanged results;
unreachable core; reentry; interruption; wrong session; unknown natural-stop status;
and cap exhaustion. These are **protocol mapping assertions**, not native hook,
HTTP MCP, model visibility or continuation observations. The fake natural-stop flag
is an explicit precondition, not evidence the client actually supplies it.

## What remains unverified (do not close #387 as native proof)

| Boundary                                                     | Result here                 |
| ------------------------------------------------------------ | --------------------------- |
| CLI exposes supported hooks feature                          | Observed                    |
| Official Stop/MCP hook schema and semantics                  | Documented current guide    |
| Local command/MCP adapter output mapping                     | Synthetic fixtures executed |
| Current app session actually loads the proposed hook         | Not tested                  |
| Genuine natural stop versus budget/error/disconnect          | Not tested                  |
| Live PDB HTTP request returns a fresh selected role briefing | Not tested here             |
| Client receives that exact event/fingerprint/nonce           | Not tested                  |
| Model reads nonce and same session continues                 | Not tested                  |
| Native explicit user stop wins during an in-flight request   | Not tested                  |

The original bounded plausibility allowance is recorded as spent in
rules-plausibility.md. This report does not invent another allowance or spend it
on a model-run demonstration. A native disposable trial needs an explicit available
allowance and reviewed/trusted temporary hook setup. #398 supplies the follow-up
prototype scope; #387's native demonstration acceptance remains open until evidence
exists or the actual host is reproducibly shown unsupported. “Not tested” is not
an unsupported result and must not be promoted to success.

Suggested bounded trial once authorized: use a disposable project and synthetic
HTTP PDB/core endpoint; register/review only that project's temporary hook; let
one short natural turn finish; require an unpredictable nonce from the fresh
briefing in the next model-visible response, with matching thread/session and
recorded hook/turn event IDs. Then test no-work/unchanged/unreachable/reentry/cancel
and remove the exact temporary configuration. Preserve user stop and ordinary
claim checks. Record harness/model/cost and stop on the first unsupported boundary;
no repeated paid benchmark or production hook is implied.

This report answers the protocol questions and narrows the native verification
work; it does not install the adapter, complete native acceptance, or claim #398
is unblocked merely because local CLI help lists hooks.
