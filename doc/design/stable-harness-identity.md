# Stable default harness identity

Owner-confirmed correction for #1047, 18 November 2026. This supersedes the automatic
session-derived allocation and default binding precedence in
[effective identity](effective-identity.md) when implemented. Retain its shared
resolver, private store, permissions, role and safe-write safeguards.

## Scope and identity axes

Use one persistent default identity per supported harness in a verified project.
A returning Codex session reuses `agents.codex` and its saved name and triage role;
its thread digest does not become another permanent agent entry. Model/provider
is not identity: a different harness may use the same OpenAI model for another
purpose. No global identity store or copying identities between repositories.

Multiple independent concurrent sessions of one harness are outside this fix.
Two sessions selecting the same default represent the same logical agent. PDB
cannot establish live presence from saved bindings and does not enforce one running
process. Do not introduce leases, heartbeats, collision prompts based on stale
bindings or automatic second-session identities. Preserve explicitly named entries
and existing supported selectors, but do not expand their multi-session features.
Keep Ori's existing explicit server-entry scope and other harness capability limits;
this Codex-default correction is not authorization to invent new detection signals.

## Selection and cross-session reuse

An explicit supported logical entry remains explicit and is never silently merged
into the default. Otherwise a detected registered harness uses its canonical default
entry. Generic client/model/login names are not proof of a particular agent or
human authority. Existing trusted startup context remains distinct from remote
HTTP/MCP display focus. Observational human reads still need no agent identity.

A valid canonical name/role stays unchanged. Session correlation, if retained,
may point at that entry but must not select a new session-derived default ahead of
it. Unsupported/conflicting harness evidence remains unresolved with useful recovery;
no first-table or unrelated-entry fallback. Existing private root `pdb.toml`, exact
entry validators and typed Git/config services remain the only access boundary.

## Recover existing session entries without losing data

On a normal mutating initialization/config path, inspect the valid canonical entry
and only recognized automatic session records/bindings for the same harness/root.
Do not discover candidates by an arbitrary agent name or flatten every codex.* key.
Read-only views may explain the needed correction but never migrate files.

- If a valid canonical entry exists, it is the default; preserve its name and role,
  other explicit entries and unrelated bindings. Report obsolete automatic bindings
  that still name a different identity instead of quietly overwriting their target.
- If no canonical entry exists and the recognized legacy records agree on one
  valid name/role pair, use the existing safe initializer to establish that pair
  as the default. Preserve the old entries and unrelated settings. Retarget only
  the recognized automatic bindings as part of the same guarded write; do not
  silently delete legacy evidence or create another name.
- Different names/roles, invalid records, unknown binding formats or ambiguous
  provenance require explicit resolution through the existing config/setup entry
  commands. Show candidate keys and the exact defaults to set, without exposing
  raw session IDs or private file contents. Never guess, merge names or rename.
- With neither canonical nor legacy identity, existing authorized first-use setup
  creates the canonical entry once; required triage role and explicit per-call role
  override semantics remain unchanged.

Use a single bounded lock, unchanged-file revision checks, atomic replacement and
readback verification. Unknown schemas/keys and explicit identities survive. New
bindings must not advertise a default whose write failed. Concurrent initialization
reconciles the actual winner; it is not evidence of live competing sessions.

## Cross-surface acceptance

One resolver is used by config/setup, normal CLI, MCP, serve and installers; no
transport mints its own name. Focused tests cover fresh canonical setup, a new
thread reusing saved name/role, matching/conflicting legacy entries, existing default,
explicit entry selection, read-only behavior, ambiguous harness signals, lock races
and partial/readback failure. Verify no new session-derived entries are persisted.
Do not commit identity snapshots or change existing human ownership/claim decisions.
The implementation remains #1047; this document does not fix the runtime by itself.
