# Effective agent identity and automatic first use

Contract for #677, reusing the private identity store, initializer and entry validators in
[pdb-owned-identity.md](pdb-owned-identity.md), [identity.md](identity.md) and the employing-human
resolver from #664. This is the core identity slice; optional Doctor, hook and installation
suggestions belong to #681. This document alone changes no runtime behavior.

## Later owner correction

[Stable harness identity](stable-harness-identity.md) (#1047) supersedes the automatic
session-entry allocation and default binding precedence below once implemented.
Use one canonical default per harness/project across sessions; no presence detection
or independent same-harness multi-session allocation. Other identity safeguards
remain. Earlier paragraphs describe the pre-correction behavior.

## One preparation service

A shared `config/effectiveidentity.ts` service prepares the effective agent, employing human,
selection provenance and setup outcome for normal CLI operations and local server execution.
It composes existing identity selection/read/write services; it does not create another name
registry, infer a human from an agent name, claim a ticket, change assignment or grant permission.
Transport adapters render its result rather than allocating names themselves.

Resolve and validate the target repository/checkout before consulting private identity. Keep
agent name, logical entry, harness/session binding, triage role and human account separate. An
explicit per-call agent override remains possible where that operation already supports it,
with its actual source reported; it neither renames a stored entry nor creates a binding.
Arbitrary MCP/HTTP display arguments remain focus metadata, never trusted execution identity.

Reuse #664's host-bound current/last-known/unresolved human context. An outage is not an account
switch. Missing/refused authentication is not replaced by an older login. Report the actual
remaining authentication action without printing credentials or inventing an account. Workflow
eligibility and human-directed exceptions remain native-rule decisions under #679/#693; identity
preparation must not introduce another ownership policy. Actual authentication and write outcomes
remain truthful technical boundaries.

## Active bindings and existing identities

Generic harness detection establishes a harness, not which of several agents is operating.
Preserve the existing explicit entry/harness validators and ambiguity diagnostics. Never select
by model name, Git author, issue author, shared GitHub account, first table or client-supplied
session text. The following deliberately extends #319's prohibition on session-based selection:
a verified active-session binding may select an existing logical entry; a process ID may not.

Maintain binding metadata inside the existing ignored root `pdb.toml`, alongside the canonical
`agents` entries. It maps a registered harness plus a project-scoped opaque session digest to an
entry key; the entry remains the sole source of name and persisted triage role. Do not store raw
session identifiers, create a global identity store or copy identities between checkouts. Unknown
keys and other entries/bindings survive updates.

Only registered, verified local session evidence may supply a binding. The existing Codex
`CODEX_THREAD_ID` boundary can identify a thread; generic Codex flags or MCP client names identify
only a harness. A thread marker alone is insufficient if the host multiplexes logical agents
inside a thread: the provider needs a verified logical-agent discriminator or a trusted explicit
local entry selection. Never mint/reuse one identity for two agents merely because they share a
thread marker. Register uniqueness providers only with source/fixture evidence; otherwise retain
explicit entry selection. Conflicting/inherited harness evidence remains ambiguous.
HTTP clients cannot impersonate the server's session by passing an identifier.

Selection proceeds as follows:

1. An explicit supported entry selects that entry without renaming it. A trusted local session
   may associate itself with that selection; other sessions' bindings remain intact.
2. A valid existing active binding selects its named entry. Repeated commands reuse its name;
   malformed, missing-target or conflicting bindings produce repair guidance, never fallback to
   someone else's generic entry.
3. An existing unbound generic/legacy entry is not proof that it belongs to a newly observed
   verified session. Require explicit entry selection before associating it. Several unbound
   candidates likewise remain ambiguous. This bounded migration exception requires no identity
   lookup and manual `--agent` echoing.
4. When a verified session genuinely has no identity and no ambiguous unbound candidate, select
   its own deterministic session-scoped entry within the harness namespace. Initialize that
   entry with the existing local name allocator. A generic entry already bound to another
   session is preserved, not borrowed. With no unique binding or explicit entry, give specific
   entry-selection guidance rather than creating a shared identity for unrelated agents.

A returning session reuses its binding. An explicitly selected returning logical agent may
reuse its entry from another session without deleting prior bindings. Normal operation never
silently overwrites a binding to a different entry; an explicit entry override is visible.
Remote repository selection alone cannot select a private file or authorize initialization.

## Initializing once and recovering safely

Normal operations may initialize a safely selected missing identity, then continue the original
operation. Reuse the existing locked initializer, collision checking, one-time matching legacy
import, symlink/tracked-file exclusions, temporary-file discipline and readback verification.
Persist the name, role and binding coherently under the same target ownership protocol; a binding
must never advertise an identity whose persistence failed.

A valid configured name stays unchanged. An explicit command role is a per-call role override,
not permission to rewrite an existing stored default. A new identity needs a supported explicit
or already configured triage role; a human display role and an evaluator's default view are not
bootstrap roles. If that role is materially unknown, stop with the exact identity-specific
selection action. Do not invent `implementer` just to make initialization succeed.

Concurrent first use for the same binding must converge on the winning persisted identity.
Different verified sessions keep separate entries and collision-free names. Re-read under the
lock; do not allocate before that guard and then overwrite the winner. Preserve unrelated edits
and report contention, exclusion, parse, persistence and cleanup failures honestly.

If allocation/import, persistence verification or the original operation fails, report which
steps actually occurred. A persisted identity survives an original-command failure. On retry,
read that result rather than blindly minting another name. Uncertain persistence is a repair or
readback outcome, not permission to overwrite an entry or announce a second allocation.

## Read-only operations and service execution

Owner clarification (#866, implementation #865): an observational read does not require
an agent. A human may request an implementer or designer view without operating an agent;
`--role` selects the view and is not evidence of an execution identity.

Normal first-use initialization remains available for operations requiring agent attribution.
Observational CLI reads instead use the shared non-initializing optional-viewer boundary.
This includes the default role briefing, catch-up/briefing reads, team, who, PR inspection
and dependency inspection, as well as config get/list, Doctor, rules, help and onboarding.
Classify operation capabilities centrally through the existing shared intent boundaries;
do not scatter command-name exceptions or duplicate workflow admission policy in adapters.

An explicit valid agent or verified existing local binding may personalize a read. With
no safe agent selection, continue as an unattributed viewer, preserving requested role and
known human context. No entries, several unbound entries, or an uninitialized detected
session must not trigger agent allocation, import, binding, identity/ignore-file writes,
claims or first-use setup suggestions. Do not select the first configured entry, borrow
another agent, or mint an identity merely to satisfy a read. A missing implicit agent is
not a fatal setup error and must not print an instruction demanding agent initialization.

Explicit malformed agent/entry selectors and corrupt configuration retain useful diagnostics;
optional identity is not permission to silently reinterpret an explicit request. Technical
failures in GitHub facts/authentication retain their ordinary exit and completeness semantics.
Use current/last-known/unresolved human evidence through the existing human resolver; do not
require an agent to resolve a human, or invent a human when offline evidence is absent.

Text and JSON preserve existing schemas and payload fields. Agent attribution is absent or
explicitly unresolved when unavailable, never a fabricated name or a false creation notice.
No agent also means no agent-specific claim/resume action is implied by viewing the list.
Human ownership and permission decisions remain in shared native rules.

Claim, submit and other agent-attributed mutations still require valid effective identity
and normal human-ownership admission. A dry-run of an attributed mutation retains its existing
non-writing identity preview semantics; it is not automatically an unattributed observation.
CLI/MCP/HTTP adapters share preparation services rather than creating transport-specific policy.

A local MCP/HTTP server may prepare its execution identity during explicitly selected local
startup, using the same service and binding. Read-only tool calls, GETs, display filters and
project selection do not themselves initialize identities or switch execution authority. They
resolve existing matching-project bindings where available; an observational read continues
without execution-agent attribution when none exists.
A remotely selected repository without a verified local project remains non-initializing.
A future mutation uses its trusted local execution context and the ordinary operation guards.

Keep the existing one-human execution context of `pdb serve`. Switching a displayed project or
human inventory cannot change it. Namespace derived identity results by verified project,
repository, local binding and human context; do not reuse another project's identity after a
selection/account change. Initialization for one startup project is not bulk setup of every
registered project.

## Visible results without protocol corruption

Report effective agent, human, entry, role and non-secret sources additively in versioned results.
Keep existing `human` attention payloads, `employingHuman` metadata and selection fields compatible.
A separate `effectiveIdentity` result carries setup state and bounded notices; it is not an
assertion of authentication, permission or live presence.

After verified creation/import, say what happened, for example: "While preparing your requested
command, PDB created agent identity NAME and saved it for this session/entry; continuing as NAME."
Distinguish a new allocation, legacy import, existing reuse, proposed setup and failed/uncertain
persistence. Never emit a fresh "created" notice on reuse, dry-run or failed persistence.

Human CLI diagnostics go to stderr; JSON stdout and STDIO MCP framing remain valid. MCP and HTTP
carry the effective identity and setup notice in their actual bounded response projection, not
only an intermediate service object. Startup notices are delivered as identifiable startup
outcomes rather than repeated claims of fresh allocation; later reuse reports reuse. Bound and
redact diagnostics: no private configuration values, raw session IDs or unnecessary absolute paths.
No Doctor, hook installation, MCP installation or external check-in runs as a bootstrap side effect.

## Acceptance

Inject filesystem, Git, environment/session provider, allocator, human reader and clocks. Cover
existing binding without `--agent`, persistent first use, explicit entry override, two agents in
the same harness/checkout, legacy ambiguity, returning sessions, repository/account switches,
missing auth/role, malformed or unwritable config, tracked/unsafe targets, concurrent same- and
different-binding setup, dry-run with zero identity writes and original-command failure after
successful persistence. Verify notices on first success and their absence on reuse/failure.

Exercise actual CLI JSON/stderr, MCP tool responses and HTTP results with disposable projects;
check bounded projection and protocol framing, not just the shared resolver. Preserve read-only
zero-initialization tests. Update onboarding and examples to use the normal command directly.
The implementation PR may close #677 only when the core acceptance is delivered; a contract PR
uses `References #677` and leaves implementation open.

## Agent-optional read regressions (#865)

Inject identity/authentication/filesystem/GitHub boundaries. Exercise actual CLI text and JSON
for implementer and designer briefings with no identity entries and with multiple unbound
entries. Assert the ordinary briefing and preserved human/view context, no identity-store or
ignore writes, no allocation/import/claim, and no bootstrap notice. Cover reuse of an explicit
or verified existing agent, a second observational command using the shared boundary, explicit
invalid selectors, offline unknown-human evidence, and unchanged attributed claim/submit
refusal. Reuse focused fixtures; no live credentials or private configuration snapshots.
