# PDB-owned private identity and one-time Agent Inbox import

Contract for #319, coordinated with setup #314, diagnostics #310 and onboarding
#351. This supersedes identity.md's choice to write `agent-inbox.toml` only when
this new store ships. The installed behavior stays as documented by delivered
help until then. No external service, login or registration is required.

## Store and scope

Use `<Git-working-tree-root>/pdb.toml`, a private, non-versioned, Git-ignored file.
It holds per-entry identity, not shared project policy, global serve registrations,
credentials or fetched data. Keep repository settings and global `pdb config` scope
separate. One file per verified working-tree root, including worktrees whose `.git`
is a file; no home/parent/sibling identity fallback or shared Git metadata store.

The initial format is:

```toml
schemaVersion = 1

[agents.codex]
name = "stable-agent-name"
triage_role = "implementer"

[agents."ori.review"]
name = "another-stable-name"
triage_role = "designer"
```

Keep the existing registered name/entry/role validators. Agent `triage_role` remains
implementer or designer; the human view takes its explicit routing name and role
from the request and does not borrow a persisted agent identity. Existing generic
`role` values in legacy configuration are not triage roles. Names are attribution,
not authentication, live presence or proof of which model acted.

Unknown future schema versions refuse reads/writes with recovery guidance rather
than being reinterpreted as v1. Preserve unknown target keys/tables and typed values
when updating a supported document; do not reconstruct the target from a whitelist.
The schema version is new PDB-owned metadata, not written into the legacy file.

## Entry selection and precedence

Use the existing shared entry resolver: explicit `--entry`, explicit supported
`--harness`, then reliable registered harness detection. Do not select by model name,
shared GitHub login, session/process ID or whichever table appears first. Ambiguous
or unsupported detection produces exact explicit-selection guidance. No guessing
or copying another harness's identity.

For the selected entry:

1. A valid existing PDB name is canonical. Preserve it on every ordinary setup or
   read, even if Agent Inbox subsequently changes its copy or becomes unavailable.
2. If no PDB identity exists for that entry, a valid matching Agent Inbox entry may
   supply the initial name and valid `triage_role` for an explicit initializer/write.
   Treat its existing identity as authoritative for import; do not generate a
   replacement name just because the old application is being retired.
3. If neither supplies a name, use the existing local stable-name initializer,
   collision check and explicit-role requirements. Generate once under the target
   lock and preserve the result on retries.

A malformed/invalid selected PDB identity is a repair diagnostic, not permission
to silently fall back and resurrect a different legacy name. Existing target
identity with a missing role keeps its name; an explicit role change supplies that
role without copying an unrelated record. Explicit `config set identity.name NAME`
retains its intentional rename meaning and never rewrites GitHub claims/history.
Duplicate/colliding imported names are reported for explicit resolution, never
silently renamed or merged into another logical entry.

## Read-only behavior and import

`config get/list`, Doctor, briefing and MCP identity lookup never create a file,
import, add ignore rules, register externally or rewrite a legacy file. Until the
selected PDB entry is initialized, read-only lookup may return the matching valid
legacy identity with an additive `legacy-not-imported` source diagnostic and the
supported initialization command. It must not claim that an import happened.
Missing or unsafe legacy data stays unknown with guidance; it cannot replace an
invalid canonical PDB entry. Remote APIs expose a safe source category, not paths
or private configuration contents.

The existing explicit `pdb config set identity.triage_role ROLE` initializer must
work with the new store. #314's planned `pdb setup identity` wrapper calls that same
shared service when delivered; #319 does not depend on an unimplemented convenience
command. Help/onboarding must name actual supported commands. A remote `--repo`
alone cannot choose or write an unrelated local identity file; verify the selected
local project through the existing resolver before mutation.

An import copies only `name` and a valid `triage_role` from the matching legacy
`agents.ENTRY` table. Do not copy hub URLs, tokens, credentials, unrelated keys,
generic `role`, other entries or the entire legacy document. Missing role uses an
explicit supplied role or the existing setup diagnostic; no inferred conversion
from Agent Inbox's `role`. Never write back, rename, remove, untrack or publish
`agent-inbox.toml`. Read-only fallback remains compatibility, not a dependency on
the service being installed or reachable.

If the legacy file exists but is malformed, inaccessible, ambiguous or tracked/
unsafe under the current private-file policy, do not hide that by generating a new
name. Refuse the initializer with a concrete repair/selection path, leaving both
files unchanged. If a valid selected name has already been read but the source is
edited during import, detect the changed source bytes before target commit and
retry explicitly; do not claim to have imported the current source. No lock or
write is taken on another application's legacy file.

## Safe target writes

Reuse maintained TOML parsing and the existing identity write boundary. Establish
repository-local Git exclusion for `/pdb.toml`, `/pdb.toml.lock` and
`/pdb.toml.*.tmp` before creating any private target/lock/temp file. Resolve the
exclude path through Git, including worktrees; append rules so other additions
survive. Do not edit global ignores or automatically untrack an existing target.
Tracked identity is a distinct refusal, not a request to commit personal names.

Refuse symlink/escaped target writes rather than following them outside the
verified project. New files use owner-only permissions where supported; preserve
the existing platform-specific safety diagnostics. Lock the PDB target across
read, resolve/import/generate, validate and atomic rename. Read after locking and
preserve other entries, so concurrent agents adding different tables do not lose
each other's changes. Same-entry writers serialize; the second reuses the first
created name unless explicitly asked to rename it. Reuse the existing bounded lock/
conflict and intervening-edit protections, with target-specific paths; do not add
another unbounded retry loop or alter shared lock semantics as an incidental rename.

Reject parse/serialization loss, unsupported values, target edits outside the lock
and failed source revalidation without replacing the original. A failed initialization
does not leave a second claimed identity. Report serializer normalization honestly;
preserve comments/formatting where practical, not a false byte-preservation promise.
Returned errors/config output never contain raw private TOML, tokens or other entries.

## Integration and rollout

All consumers use one resolver: config/setup, CLI role focus, Doctor, MCP and serve.
New reads prefer PDB; mutating identity operations write only PDB. Do not migrate
every installed project automatically or enumerate other repositories. The first
explicit initializer per selected entry performs a local import; imported names
remain unchanged and users can continue operating without Agent Inbox installed.

Update delivered help and onboarding examples together, including filename/source
diagnostics and private-file exclusion. Existing registered `identity.*` config keys
and `--entry`/`--harness` flags stay compatible. `config convert` for shared repository
policy must not consume identity contents. Global serve configuration is another
store; launching a server cannot import every project's identities or trigger a
new external check-in. Remote identity is focus metadata, never extra authority.

The rename rollout #320 verifies consumer installs/docs after this implementation;
it must not claim the entire rename complete because npm and the binary were renamed.
#351/#391 reuse the actual initializer/help, not a forked migration script. Closed
historical reports/receipt markers remain compatible and are not bulk-renamed.

## Acceptance

Inject filesystem, Git, random generator and clock boundaries. Cover canonical PDB,
one-time matching import, no legacy file, fresh generation, missing role, explicit
rename, rerun stability after legacy edits/removal, invalid canonical file, future
schema, malformed/unsafe legacy file, name collisions and ambiguous harnesses.
Verify other entries/unknown typed values survive and no legacy write/network call
ever occurs. Test ignored/tracked/symlink/worktree/outside-root safety, concurrent
same/different entries, source edits during import, target edits, partial failures,
lock conflicts and temp-file exclusion. Read-only get/Doctor/briefing/MCP calls make
zero filesystem writes. CLI/MCP/serve focus and onboarding diagnostics agree.
Package smoke uses temporary projects/configuration only; no live identity files
or credentials are committed or changed to test the feature.

## Automatic first-use extension (#677)

[effective-identity.md](effective-identity.md) defines the shared preparation service, verified
active-session binding metadata and visible automatic setup for normal commands. It supersedes
this document's session-selection prohibition only for those verified bindings, and its blanket
non-initializing briefing rule only for normal first-use operations. Explicit read-only operations,
dry-run, display selection and remotely supplied identity strings remain non-initializing. The
existing identity store, initializer and safety/unknown-key guarantees remain the foundation.
