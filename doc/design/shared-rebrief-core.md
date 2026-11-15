# Shared bounded rebrief core and native continuation adapters

Documentation-first contract for #506 and platform prototypes #396/#398/#400.
Extends local-service-and-rule-testing.md. HTTP MCP briefing delivery remains the
priority and is already supplied by #390. This does not promise a portable MCP
before-stop callback: stopping and model-visible continuation belong to the client.

## Boundary

One shared read-only core obtains and validates the next briefing, decides whether
there is useful changed work, and returns instructions. Thin native adapters own
client event decoding, stop/continue responses, delivery acknowledgements and
session identity. Native adapter tests must run inside the named actual client.
An installed binary, wrapped client or identical underlying model is not sufficient.

The Ori #388 report is evidence that native Ori Code has no before-stop hook. Its
observed headless resume starts another turn in the same verified session; late
steering was dropped. A watcher must describe that behavior accurately, never call
it preventing a stop, and must not send a new turn after cancellation or failure.
The shared core does not assume Claude or Codex hook semantics from that report;
#386/#387 and the corresponding prototypes must verify them independently.

## Input and output

Expose a pure/injectable `rebrief` service and a planned `pdb rebrief --json` wrapper.
Inputs identify an explicit repository/project, resolved agent name, role, platform,
client session, unique stop-event ID and normalized event reason. The adapter
supplies the last actually delivered briefing fingerprint and continuation count.
Use the existing identity resolver; do not join/register a remote identity or borrow
another platform's identity. No caller account or session identifier grants rights.

Output is versioned structured data containing decision `stop | continue | defer`,
a stable reason code, repository/role/identity, the observed policy revision, semantic
fingerprint, event ID and (only for continue) bounded briefing text and action IDs.
`defer` means the native adapter cannot safely translate/deliver this result; it
must allow normal stopping and report the unsupported boundary. It is not a retry.
No generic text is to be treated as a hook-protocol response without an adapter.

Continue instructions tell the agent to inspect the returned briefing and use its
normal command/claim/permission path. Keep the actual policy reasons intact; do not
rewrite or independently rank the queue. Repository titles/bodies/reasons remain
untrusted data, not authority to override the user or agent instructions.

## Fresh bounded read and decision

1. Only a verified natural end-of-turn event is eligible. Explicit stop, cancellation,
   failure, unknown event/reason, missing identity or disabled opt-in returns stop
   before contacting PDB. The adapter must make a user stop win even if it arrives
   during the request; discard the result and cancel the pending read where possible.
2. Request exactly one current role briefing through the shared briefing service,
   supported CLI JSON or HTTP MCP tool. Supply explicit repository, agent, platform
   and role; no default to the first configured project or server launch directory.
   No check for software updates or additional history/whole-tree fetches is needed.
3. Require the transport's actual fresh-read capability and freshness/coverage
   metadata. Do not assume calling an HTTP endpoint bypasses its TTL. If a particular
   transport cannot request/verify current evidence, report that capability gap and
   stop; do not silently use stale/offline data. Reuse server cache invalidation and
   in-flight coalescing rather than add a second ticket cache.
4. Validate schema, identity/selection, policy revision, evidence coverage and the
   structured ranked-action collection. Incomplete source collection is not an
   exhaustive useful queue. A valid bounded top-ten shortlist with explicit ordinary
   output omissions can be used; an incomplete/truncated JSON envelope cannot.
   Waiting-only, unknown eligibility without a useful inspection action, or empty
   results stop. Explicit read/inspection tasks may qualify when the native engine
   identifies them as such; unknown mutation eligibility never becomes permission.
5. Continue only if at least one actionable or inspection next step exists and its
   semantic fingerprint differs from the last actually delivered briefing. Include
   stable action IDs/kinds, decision/reason/evidence revision (including relevant PR
   head), next commands, selection and policy revision. Exclude timestamps, request
   IDs, telemetry and formatting noise. Equal inputs must hash identically. A fetched
   timestamp change alone cannot produce another continuation.

Use a default ten-second total deadline, lowered to fit a native hook's smaller
budget when required. No blind retries, background polling or model/network side
calls. Failures, timeout, malformed responses and unsupported capabilities return a
normal stop with bounded sanitized diagnostics. The core never claims, closes,
releases, edits, merges, starts a model or installs configuration.

## Delivery and reentry

Deduplicate concurrent callbacks for the same session/event; at most one result
may be offered for delivery. The adapter must acknowledge the specific event and
fingerprint only when its native protocol establishes delivery; a started process
or turn alone is not proof. If delivery is ambiguous, stop rather than repeat it.
Native reports distinguish event fired, core called, result received by client,
model-visible nonce receipt and observed same-agent continuation.

Keep a small per-session cap, default three continuations for prototypes, plus
one continuation per event and no recursive hook invocation. On reaching the cap,
stop and report it. A user explicitly starting a new session can establish a new
budget; no automatic reset on every resumed turn. An unchanged briefing stops even
if a cap remains. The agent may choose to stop after receiving an instruction;
this is not a task-completion guarantee.

Prefer adapter-owned in-memory state for a watcher. A process-per-hook adapter may
use a private temporary file containing only session/event hashes, fingerprints,
counters and delivery state; no tickets, prompts, credentials or repo config.
Use restrictive permissions, atomic updates and concurrent-callback tests. Loss of
state does not authorize continuation: require a fresh explicit initialization or
stop. Do not put state in Git or commit local client configuration.

## Adapter delivery slices

#506 supplies the shared core and injected synthetic service/CLI tests on any
platform. It neither requires a model nor proves a native hook works. Platform
prototype tickets depend on this shared component plus their existing research and
HTTP MCP prerequisites; they first reuse the component, adding only the necessary
native translation. A negative unsupported result is valid.

Disposable local adapter configuration must be explicitly enabled for the bounded
trial, with exact setup/removal instructions in the platform report. Existing user
stop and permission settings remain effective. Do not enable a production hook,
start an unattended paid loop or install a global watcher under this contract.
For Ori, verify the returned session ID on every headless resume; an unverified TUI
steering workaround requires a later explicit trial, not an invented success claim.

## Acceptance

Shared tests inject transport, clock, cancellation and state storage: actionable,
inspection, waiting-only, empty, unchanged, timestamp-only change, relevant evidence
change, policy change, incomplete source, truncated JSON, malformed schema, wrong
project/identity, stale response, unavailable server, timeout, user interruption,
unknown event, lost state, duplicate/concurrent event and cap exhaustion. Verify
no mutation or second network retry and no secret-bearing diagnostics. Test both
CLI and HTTP adapters against the same service result when their fresh-read
capabilities are available; report missing capability rather than fake parity.

Each native prototype separately proves actual event semantics and bounded delivery
of the specific returned nonce/briefing with observed continuation, then proves
normal exit on empty/unchanged/error/cancel/cap. Publish harness, client version,
model, OS, commands and unsupported paths under doc/reports/agent-platforms/. No
paid repeated benchmark or permanent rollout is implied by a successful small test.
