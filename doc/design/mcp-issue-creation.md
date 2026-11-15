# Explicit opt-in issue creation through MCP

Documentation-first contract for #204, after CLI/service delivery #199. Reuse
issue-creation.md. This is a deliberate extension to the otherwise read-only MCP
registry, not implicit CLI parity. HTTP briefing delivery retains priority; no
mutation is enabled by this document.

## Activation and local authority

Register a single `triage_create_issue` tool only when the initial operator enables
issue creation explicitly. Use action-specific startup `--allow-issue-create` and,
for serve, registered global `serve.allowIssueCreate` default false. Report the
capability in safe startup/diagnostic metadata. Another registration-only `pdb serve`
invocation, a tool argument, repository body or client root cannot enable writes.
Changes require explicit listener restart. Existing briefing, issue-detail,
dependency and diagnostic tools remain read-only with unchanged schemas.

Stdio is a local operator-owned process. HTTP writes are supported only on the
existing loopback listener and verified registered project selection. Keep strict
Host/Origin and JSON-content-type checks at the HTTP boundary before MCP dispatch.
A browser Origin must be the actual server origin; reject foreign/null origins,
form/text bodies and cross-origin preflights. A native local MCP client without an
Origin can use strict JSON under this deliberately enabled local-process trust
model. Do not add permissive CORS to make a client work. Reject writes on a non-
loopback deployment until a separately reviewed authenticated-access contract exists.

This deliberately lets processes running under the trusted local operator use the
server's existing `gh` account; it is not per-agent authentication. MCP session IDs,
client metadata, reported agent names, tool annotations and successful initialization
are not credentials or permission grants. Do not expose the private instance-control
token, invent a new GitHub token store or reuse browser UI CSRF cookies as MCP
identity. An operator who needs isolation between local clients should leave the
write capability disabled and use the CLI; stronger remote/multi-user authorization
is separate scope. Web dashboard writes retain their own #455 cookie/CSRF gate.

Ordinary GitHub issue creation need not require repository collaborator write
permission: external reporters can legitimately file bugs. Let the shared service
and GitHub enforce actual create/label permissions, while workflow records and
estimates continue to require their own trusted provenance. Creating an issue or
supplying a ready/impact label does not make its prose authoritative.

## Strict tool interface

Inputs are a strict object:

```text
repo: owner/name (required on every write)
title: nonempty string
body?: string
labels?: string[]
agent?: reported persistent name
dryRun?: boolean (default false)
```

Apply the exact title/body/label/identity validators and limits from the CLI service:
256 Unicode title code points, complete body including correlation marker at most
64 KiB UTF-8, at most 20 validated/deduplicated explicit labels. No body-file/stdin,
local file path, arbitrary URL, shell, generic GitHub request or configuration input.
A read-tool's selected repository or daemon cwd is not an implicit write target.
HTTP additionally requires that the requested repository resolve to a registered
project; stdio uses the existing explicit target resolver. Verify canonical target
identity, including redirects, through the same service as CLI before dispatch.

`agent` is optional provenance. Reuse the shared resolver only for an explicitly
verified local project and preserve identity diagnostics; no creation, import,
rename or remote identity registration as a side effect. Missing local identity
never causes borrowing from another connection or a shared GitHub login.

Describe the tool as an external write requiring deliberate intent. Advertise
`readOnlyHint:false`, `destructiveHint:false` (creates, does not delete),
`idempotentHint:false`, `openWorldHint:true`. These are discovery hints, not access
controls or promises that the host will present a confirmation dialog. Disabled
servers neither list nor execute this tool. Unsupported clients receive ordinary
capability/setup guidance; do not silently dispatch a CLI subprocess.

## Shared service, cancellation and uncertain outcomes

Call the same transport-neutral creation service as #199 with injected GitHub,
clock, ID and cancellation boundaries. No duplicate label/POST/recovery logic and
no invocation of an interactive CLI. The service writes only the explicit issue
plus its correlation marker, not a claim, workflow transition or global config.
`dryRun:true` resolves and validates but performs no POST/config write; a preview
operation ID is not a reservation.

Use one generated operation ID and one POST per tool invocation. MCP JSON-RPC IDs
are not durable idempotency keys; do not promise exactly-once behavior across
client retries, disconnection or server restart. Reuse the CLI's target/intent-bound
correlation marker and its read-only recovery guidance. A duplicate marker is not
identity proof, and search absence is not proof the first POST failed.

Cancellation before dispatch prevents the write. Cancellation/timeout after dispatch
may leave a created issue: report `unknown` with operation/target/recovery details
where the transport can still deliver a result; retain only a bounded sanitized
recent-outcome diagnostic otherwise. Do not retry, delete the issue or claim rollback
after a possibly committed POST. The client must inspect before deliberate retry.
Queued duplicate transport callbacks must not redispatch the same in-flight MCP
request; this local guard does not imply cross-session idempotency.

Return the shared versioned creation outcome (`planned | created | partial | unknown
| refused`), canonical target, operation ID, observed number/URL when known, requested/
applied/omitted labels and safe warnings/recovery. Bound the serialized result using
the shared MCP envelope and expose omissions honestly. Default responses do not echo
the issue body, private input or raw GitHub errors. Definitive refusals and ambiguous
writes remain distinguishable; neither a successful HTTP status nor `isError:false`
alone proves creation. The structured outcome is authoritative. Preserve protocol
stdout cleanliness and the existing typed quota/auth/permission diagnostics.

Confirmed or uncertain writes invalidate affected issue-list/queue/dependency caches
through the shared generation guard; an older in-flight read cannot repopulate a
fresh generation. Do not fabricate new queue rankings before the refresh finishes.
Independent CLI/external writes retain TTL/manual-refresh behavior unless a real
notification path exists. No new polling, history index or persistent ticket cache.

## Delivery and acceptance

#199 must first deliver and test the shared CLI service; #204 wraps it after this
contract's review. Keep the native dependency. Add SDK-client tests for both stdio
and supported loopback HTTP using fake GitHub and no live issue creation:

- Default tool absence/refusal, explicit startup activation, restart-only mode and
  no enablement by a second project registration or input property.
- Read-tool schemas/annotations unchanged; write annotations accurate; unknown
  arguments and invalid inputs rejected before GitHub calls.
- Explicit target on every call, canonical redirects, registered HTTP project,
  wrong project, client-root/identity isolation and no cwd inference.
- Reporter creation versus collaborator-only label capabilities, partial labels,
  disabled issues and current permission/auth/quota failures.
- Strict HTTP Host/Origin/JSON checks before dispatch; native no-Origin local client,
  same-origin browser, foreign/null Origin, form body, CORS and non-loopback refusal.
- Planned/created/partial/unknown/refused parity with CLI, exactly one POST per
  invocation, before/after-dispatch cancellation, duplicate in-flight callbacks,
  lost replies, copied markers and safe recovery without blind retry.
- Result budget, body/error redaction, private-token non-disclosure, cache generation
  invalidation and packaged server operation without a checkout.

Actual-client acceptance records client/harness/model/server versions and confirms
discovery/schema/dry-run against a fake service or a deliberately non-writing target.
Do not claim a live write test from SDK parity. A production issue creation or
permanent client setting requires its normal explicit task authorization, not this
acceptance suite. Full CLI mutation parity, arbitrary endpoints, remote deployment,
agent-control messaging and automatic implementation pickup are not part of #204.
