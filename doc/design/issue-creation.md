# CLI issue creation with explicit targeting and honest outcomes

Contract for #199. The owner chose CLI first; #204 is a later explicitly reviewed
MCP mutation wrapper. This document does not implement a command or create a live
ticket as a test. Use the shared authenticated `gh` boundary without a shell or
new credentials, preserving configuration and workflow authority boundaries.

## Human-assignment creation amendment (#666 / #674)

The [human-assignment contract](human-assignment-safeguard.md) (whose owner-review hold was explicitly lifted by the owner on #666/#674) narrows managed creation to a verified checkout/policy context matching the target repository. Default new PDB issues to the creating/employing human at creation, verify assignment alongside labels, and keep agent claims separate. Unmanaged/unfamiliar/no-checkout issue reporting uses ordinary gh rather than another repository's PDB process. This document alone changes no runtime behavior; #666 owns the runtime implementation.

GitHub may drop assignment even on successful creation. Preserve the one-attempt/partial/unknown guarantees below and never report fully assigned success or blindly repeat creation. Any resulting unassigned issue enters explicit guarded routing/original-ticket attention; do not create a separate guidance issue or run an implicit transfer after creation. #666 owns one shared implementation; #674 tracks the user report.

## Command and input

```text
pdb issue create --title TEXT [--body TEXT | --body-file PATH|-]
                 [--label LABEL]... [--repo owner/name] [--agent NAME]
                 [--dry-run] [--json]
```

This is a new command namespace; existing `--issue N`, `pdb ticket N`, briefings,
config and lifecycle commands keep their documented behavior. `issue create --help`
works without a checkout, identity or login. No interactive editor, shell command,
arbitrary API operation or implicit MCP mutation is added.

Require a nonempty title, bounded to 256 Unicode code points. Accept either body
text or a file/stdin, never both; omitted body means empty user text. Limit the
complete UTF-8 body including metadata to 64 KiB as an application bound, not a
claim about every GitHub endpoint limit. Reject unreadable/oversize input before
creation. Labels are explicit repeated strings, deduplicated and validated, at most 20. Use existing target/name validators and argument-array process execution;
input quotes, backticks and dollar syntax are data, never shell interpolation.

Do not add ready/claim/attention/agent labels or infer impact/complexity unless the
caller explicitly supplied those labels and GitHub permitted them. Creation is not
trusted triage, assignment, permission to implement or approval of embedded prose.
An external reporter remains visible but unauthoritative under the existing trust
model. Label and estimate provenance requirements for later workflow actions stay.

## Resolve and show the target

Explicit `--repo` wins. Without it use the existing verified current-checkout
repository resolver, including subdirectories; ambiguity or outside-repository
context without a target fails with guidance, not a guessed directory name. Resolve
canonical host/repository/immutable repository identity through the existing GitHub
boundary and show that target before writing. A redirect is accepted only when it
is verified as the same intended repository identity; never create silently in an
unrelated namespace. No broad repository briefing/history read is needed.

A remote target does not rewrite checkout config, import/rename identities or use
local issue numbers as remote numbers. An optional reported agent is provenance,
not authority. Read local identity only when the selected project is verified to
be that local checkout; otherwise leave the agent unspecified unless explicit.
No identity is generated or registered to create an issue.

Use the existing host's authenticated GitHub user/capability boundary. Verify issues
are available and let GitHub enforce actual creation permissions and organization
policy. Issue creation can legitimately be available to a reporter without repo
write permission; do not impose the collaborator-write rule for trusted workflow
records on ordinary bug-report creation. Requested labels may require greater
permission: verify the result and disclose omissions instead of pretending a label
was applied. Authentication/access errors are distinct from rate limits/timeouts.

`--dry-run` resolves/validates and shows a reviewable target/title/body/labels plan
with no POST or local configuration write. A generated operation ID in a preview
is not a reservation. Normal text may print a short target/operation preflight line
to stderr before POST. JSON stdout is exactly one final versioned document; no
human banner corrupts it. Error paths never echo private body/file contents or raw
GitHub payloads. An explicit dry-run body preview is input the caller asked to inspect.

## Request and observation

Use a transport-neutral creation service and injected REST/clock/ID/input boundaries.
Generate one operation ID before the POST and surface it in preflight diagnostics.
Append a small `github-triage:issue-create v1` body marker binding version, operation
ID, target repository identity and normalized intent digest. The digest covers
title, exact user body and requested labels; do not duplicate private text inside
the marker. This is a receipt for correlation, not a signature or permission grant.
No existing consumer may treat it as a claim, handoff or delivery record.

Make one create attempt. A successful response must identify a real issue (not a
PR), its number/node ID and safe canonical URL, bound to the intended target. Read
back when necessary to verify result identity/labels, within a small declared bound.
If that verification fails after creation, retain the observed issue link and say
partial/unknown; do not create another issue. An issue URL is never constructed from
an unverified response number and assumed namespace.

GitHub does not become an atomic idempotency service because a marker exists.
There is no automatic re-POST after a timeout, cancellation after dispatch, 5xx,
malformed success response or lost reply. A supplied title match or eventually
consistent search is not proof of this operation. Two separately invoked create
commands are separate intents and may create duplicates; make that limitation
explicit in help and recovery. No new durable operation database/journal is required
for this first slice, and no exactly-once guarantee is advertised.

On an uncertain outcome return the operation ID/start time/target and a read-only
recovery hint. For example inspect recent issues using existing briefing/full intake
or the unsupported-operation `gh api` fallback and compare the marker and author.
Bounded lists/search can find a candidate but cannot prove absence; if no unique
authenticated-account/target/intent match is established, keep outcome unknown and
do not recommend an automatic retry. Copied markers, multiple matches and shared
accounts are explicitly limited attribution, not proof of which agent acted.
Do not close/delete duplicates or modify another issue as automatic cleanup.

## Result and exits

Return `schemaVersion: 1`, `kind: "issue-create"`, operation ID, normalized target,
`status`, observed issue identity/URL or null, requested/applied labels, safe warnings
and recovery/source links. Status is `planned` for dry-run, `created` for verified
creation, `partial` for a known issue with unmet requested details, `unknown` for an
ambiguous dispatched write, or `refused` before a successful creation. Do not echo
the full issue body in the default result. JSON/text describe the same outcome.

Exit 0 for planned/verified created, 2 for useful partial/unknown outcome, 1 for
invalid input or a definitive refusal/no create dispatch. A timeout before dispatch
is not the same as one after the request may have committed. Preserve the shared
typed quota/permission/error evidence and safe advice; never rotate credentials
or invent a reset time. Requested labels silently dropped by GitHub produce partial
success, with the real created URL and explicit correction guidance, not a second
creation. Existing supported mutation services may be used for a later deliberate
correction; this command does not hide multi-step repair behind "created".

## Boundaries and later MCP

No claim, delivery, completion, repository setting, global config or local identity
changes occur. The command creates only the requested issue plus correlation marker;
it does not send arbitrary inbox/email messages or execute code. No default status
label makes the issue immediately pickable. Server caches observing independent CLI
writes still use TTL/manual refresh unless a real notification path is delivered.

#204 follows actual CLI/service delivery and a separate MCP mutation/access contract.
That wrapper must reuse this service and explicit target/outcome model; adding it
silently to existing read tools or assuming native-client acceptance from unit tests
is outside this first delivery. HTTP MCP briefings retain priority over full parity.

## Acceptance

Injected tests cover explicit/current/nested/ambiguous/outside-Git targeting, verified
redirect identity, disabled issues, reporter versus collaborator capabilities,
label omissions, and unchanged local config/identity. Exercise empty/oversize title
or body, file/stdin conflicts, quoting/metacharacters, duplicate/invalid labels and
dry-run with zero writes.

Test verified 201, wrong/missing identity, dropped labels, malformed success, access/
quota refusal, timeout/cancellation before and after dispatch, 5xx/lost reply and
read-back failure. Assert exactly one POST per invocation and no automatic cleanup/
retry. Recovery fixtures cover unique and copied markers, stale search, no match,
multiple matches and shared-account limits. Validate stdout/JSON/exit parity, safe
redaction, help and packaged CLI with a fake gh. No live issue creation is acceptance.
