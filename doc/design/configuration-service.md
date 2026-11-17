# Transport-neutral configuration service

Contract for #804, the foundational slice of the owner-approved separation recorded in
[serve-configuration-layers.md](serve-configuration-layers.md). This delivers the configuration
service only; the config CLI (#815), the served application state service (#816) and the
Configuration web page (#584) are separate consumers/tickets. It supersedes the combined
service/CLI scope previously written on #804.

This document changes no runtime behavior. It records the architecture to be reviewed before
implementation; existing accurate contracts remain in force and are not contradicted here.

## Boundary

One transport-neutral configuration service owns reading, listing, setting, typed defaults,
schema/type validation, revisioned snapshots and safe locked atomic writes. "Owns" means
consumers call this shared machinery instead of parsing configuration files themselves.

- It supports **repository scope** (the existing `.github/triage.toml` shared policy) and a new
  **per-OS-user global scope**, without mixing identity settings or project workflow rules.
- It **knows configuration only**. No running-server state, restart-required classification,
  reload/shutdown operations, web rendering or CLI/HTML formatting; the application state
  service (#816) owns runtime consequences, and the config CLI (#815) owns presentation.
- Read-only operations create no files. Unknown scopes/keys are refused; malformed, future or
  concurrent-edited documents are refused rather than overwritten.
- It reuses the reviewed global schema in [serve-startup-configuration.md](serve-startup-configuration.md)
  (`PDB_CONFIG_DIR`/per-user config dir, `schemaVersion = 1`, `serve.port`, `serve.ttl`,
  `serve.projects`) and the existing safe filesystem boundaries in
  [safe-shared-file-writes.md](safe-shared-file-writes.md) and the current repository service
  (`src/config/config.ts`).

## Scopes

| Scope      | Location                                                                                              | Holds                                                                                                                        | Must not hold                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| repository | `<root>/.github/triage.toml` (legacy `.json` readable until `config convert`)                         | shared policy keys (`briefing.engine`, `complexity.*`, `impact.*`, `review.policy`, `rules.project.enabled`, `processGuide`) | identity secrets, global ports, registered projects |
| global     | per-OS-user config dir (`PDB_CONFIG_DIR` override), `config.toml`, per serve-startup-configuration.md | `serve.port`, `serve.ttl`, `serve.projects`                                                                                  | identity keys, repository workflow rules            |

Global scope refuses identity keys and `convert` (there is no repository file to convert).
Repository scope remains the implicit default and keeps existing identity selectors. Global
values never override repo workflow/identity settings. A registered typed service owns
defaults, validation, versioning and writes for both scopes; helper logic may be shared, but
global values are never routed into `.github/triage.toml`, and supporting global value types
does not silently broaden every repository key type.

## Keys, defaults and validation

Maintain one registry of registered keys per scope, each with its type, effective default,
valid value range/choices and help text. Repository keys extend the current `CONFIG_KEYS`;
global keys follow the reviewed global TOML schema:

- `serve.port`: integer 1–65535, default 4372. Port `0` stays an explicit CLI ephemeral
  override for tests, never a saved stable port.
- `serve.ttl`: the existing duration value and range, default `5m`. Preserve current validation;
  owner expects normal settings around five to ten minutes.
- `serve.projects`: an ordered array of tables with `host` (default `github.com`), `repository`
  (owner/name) and an optional absolute verified `localRoot`. An explicit empty array is a
  supported way to clear registrations.

Validation parses the registered value type: decimal for port, duration text for `ttl`, a TOML
array value for projects. Reject extra fields outside the selected value, invalid
records/duplicates and unsupported hosts rather than executing free-form text. `get`/`list`
distinguish defaults from explicit values and include scope; machine output stays JSON. `set`
returns no-op on an equal write.

## Read, list, set and revisions

The service supports explicit snapshot/revision comparisons and reports **factual change
descriptions**: changed keys with old/new values where safe, or a comparison to an explicit
revision/snapshot.

- A **long-lived consumer** (e.g. a running PDB serve process) can keep an initial snapshot and
  ask what changed since it started. That baseline is held **in memory**, not persisted as a
  dirty bit.
- A short-lived CLI does **not** invent a historical baseline and does not persist one.
- There is **no** required background file watcher; this slice does no background work.
- Direct file edits are validated through the same reader. All programmatic reads/writes use the
  shared machinery.

Return named change descriptions and revisions, not only a Boolean. Reverting a setting to its
effective value clears its open change. Failed writes never advance an applied snapshot.

## Safe persistence

Reuse the existing safe locked atomic write machinery from `src/config/config.ts` and the
non-stealing lock contract in [safe-shared-file-writes.md](safe-shared-file-writes.md):

- Read-only operations never create, migrate or rewrite a file.
- Writes validate first, preserve unrelated supported values, refuse malformed/future versions
  and check for intervening edits, then atomically replace under the lock discipline.
- Never break a lock by age; report a stuck lock with an operator recovery path.
- Both scopes share the lock/write boundary; independent target files do not serialize behind a
  global lock.
- Secrets and fetched GitHub data are not configuration. No file is committed automatically and
  no token/config is echoed in output.

## Consumers and delivery order

Per [serve-configuration-layers.md](serve-configuration-layers.md), #804 is the foundation;
#815 and basic #584 editing can follow independently, then #805/#816, then #808, #813, #807.
The application state service (#816) compares saved values to what the process actually applied,
retaining the running baseline for startup-only settings — that is #816's boundary, not #804's.
Registration reuse (#813/#807) saves through #804, notifies the existing instance, waits for its
result and exits; that work is outside this slice.

Tests use injected filesystem, clock, Git resolver and lock boundaries: scope separation,
defaults, revision/change comparisons, no-op and reverted edits, stale saves, malformed and
future TOML, concurrent writes and unrelated-value preservation. Packaged tests use temporary
profiles, never a live user configuration.

## Current state and partial work

`feat/804-config-service` and `feat/452-global-configuration` are currently empty relative to
`main` (no ahead commits), so there is no Omar/local partial implementation to recover on this
branch today; the reviewed global schema in serve-startup-configuration.md and the existing
repository configuration service remain the accurate contracts to build on. #452 remains the
acceptance umbrella; #804 is a focused slice that does not close it.
