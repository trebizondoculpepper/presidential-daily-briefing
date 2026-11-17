# Global serve configuration and one local instance

See [configuration layers and serve controls](serve-configuration-layers.md) for
the superseding owner-approved layer split, reload/shutdown scope and delivery order.

Contract for design #443 and implementation #452. Implements the owner decisions
in serve-global-dashboard-roadmap.md. This extends the original serve.md startup
contract only when the implementation ships; it does not claim the installed
command already accepts these forms.

## Configuration boundary

Use `env-paths`' per-user configuration directory for application `pdb`, with no
package-name suffix, and `config.toml` inside it. `PDB_CONFIG_DIR` explicitly
overrides that directory for isolated profiles/tests; it is not a repository path.
Use a separate private per-user runtime directory for instance discovery. Tests
inject both locations and never change a real user's home or configuration.

The config command becomes:

```text
pdb config get KEY [--scope repository|global] [--json]
pdb config set KEY VALUE [--scope repository|global] [--json]
pdb config list [--scope repository|global] [--json]
pdb config help [--scope repository|global]
```

Repository remains the implicit scope. Existing identity selectors and convert
behavior remain unchanged; global scope rejects identity keys and `convert`.
No repository discovery is required for global operations. Global keys do not
override repo workflow/identity settings. A registered typed service owns defaults,
validation, versioning and writes for both scopes; share helpers without routing
global values into `.github/triage.toml` or broadening all repo key types silently.

Global TOML schema version 1 contains `schemaVersion = 1` and a `serve` table:

- `serve.port`: integer 1–65535, default 4372. Port 0 remains an explicit CLI
  ephemeral override for tests, never a saved stable port.
- `serve.ttl`: existing duration syntax/range, default `5m`. Preserve current
  validation; owner expects normal settings around five to ten minutes.
- `serve.projects`: ordered array of tables with `host` (default github.com),
  `repository` (owner/name) and optional absolute verified `localRoot`.

`get`/`list` distinguish defaults from explicit values and include scope; machine
output stays JSON. `set` parses the registered value type: decimal for port,
duration text for ttl, a TOML array value for projects. Reject extra fields outside
the selected value, invalid records/duplicates and unsupported hosts rather than
executing text. Help gives copyable examples and the resolved config location.
An empty projects array is a supported way to clear registrations through config.

Read-only config commands never create/migrate files. `serve` may initialize missing
global defaults and register projects; writes validate first, preserve supported
values, refuse malformed/future versions, check intervening edits and atomically
replace under the existing safe lock discipline. Never break a lock by age.
Secrets and fetched GitHub data are not config. No file is committed automatically.

## Resolve and register

Support existing repeatable `--repo` and `--project`, plus positional owner/name
targets and local checkout paths. Distinguish filesystem paths using explicit path
forms/existence and the existing repo validator; ambiguity gets an exact `--repo`
or `--project` recovery hint, never a guessed destination.

Combine validated explicit targets, the verified cwd Git working-tree repository
when one exists, and saved registrations. Resolve subdirectories to their real
Git root. Use the existing repository resolver and canonical host/repository
identity, not a directory-name special case. Identity/authentication metadata reads
are allowed; do not fetch issues, PRs or comments at registration/startup.

Deduplicate by canonical host/repository, preserving saved order and appending new
targets deterministically. An explicit repo-only target does not erase a saved
local root. A verified local root may refine a repo-only entry. Two different
local roots for the same repository must not silently replace one another's
configuration/identity context: explain the conflict and require an explicit
global config update before changing the selected root. Missing or moved saved
roots remain visible diagnostics; never substitute cwd from another project.

No cwd repository is not itself an error if explicit/saved targets exist. If the
combined served set is empty, initialize missing defaults, print “nothing to serve”
with supported registration examples, and exit 2 without a listener or data fetch.
An invalid explicit target or malformed config fails before partial registration;
do not start a smaller set while claiming all requested projects were added.

## One running instance

The normal configuration profile has one foreground service. Its discovery record
is disposable runtime metadata: protocol version, app/version, random instance ID,
actual loopback URL and a fresh control capability. Protect its directory/file for
the user (0700/0600 on Unix; appropriate user-only access on Windows), keep the
capability out of config/help/status/logs, and remove only this instance's record
on shutdown. It is not a GitHub credential or persisted cache. Never trust PID or
file age alone as proof a process is PDB or is dead.

Serialize listener/discovery startup with a short bounded profile lock; serialize
configuration updates with a separate config-file lock. Re-read config/discovery
under the startup lock, then release it before registration HTTP calls. Never hold
a client-side config lock while waiting for a server that needs that same lock.
Probe only the recorded local endpoint with a short timeout; do not scan ports or
kill a conflicting process. Bind failures retain
existing clear exit codes and never silently choose a different stable port.

Verify a recorded server before sending registration or local paths: an instance
probe accepts a fresh nonce and returns instance/protocol identity plus an HMAC
over that nonce/identity using the private capability. Use Node's standard crypto
and constant-time comparison, not a custom signature scheme. An unrelated listener
cannot establish identity merely by returning 200 from healthz. Unknown or
incompatible identity fails with explicit recovery; do not send a bearer capability
or private project paths to it. Protect against malformed/unbounded probe input.

After verification, a narrowly scoped local control request authenticates with the
capability and carries the validated registrations. Preserve Host/Origin checks,
allow only registration/reload operations, bound bodies and verify the peer is
local. A remote bind flag never makes this control API public. No GitHub mutations,
shell commands or arbitrary file reads are exposed. Same-user/root compromise is
outside this local discovery guarantee; do not advertise loopback as user auth.

For an existing instance, ask the verified server to merge/persist valid
registrations through the config service and acknowledge its observed revision/
served set. Registration is idempotent. `config set` writes under the config lock,
releases that lock and then notifies the server to reload. If persistence succeeds
but application/acknowledgment fails, report partial/pending application and give a
retry, not a false success. The next invocation reconciles from config.
The server reuses one registration/config service, not a separate TOML reader.
No registered project is prefetched. Preserve existing cache entries for unchanged
contexts and invalidate a changed selected root/config context safely.

Print “PDB is already running” and its actual URL, then exit 0 once additions are
acknowledged. Do not open a browser, attach a UI/session, spawn another normal
instance or stop the existing service. A changed configured port applies after
an explicit restart; print the live URL and clearly state that the new port is
pending. An explicit `--port` overrides config only when starting a new service;
it does not silently relocate a running one. Existing host/remote opt-in safeguards
remain. Explicit profile-directory isolation is how tests/advanced callers run
separate instances; the default user profile still has one.

If no listener exists, create a fresh instance/capability, bind, publish discovery
atomically and release the startup lock. Resolve a connection-refused stale record
under the lock without deleting unrelated live state; an unresponsive/unknown
listener is not proof of death. Concurrent starters recheck after acquiring the
lock and converge on one service. Crash leftovers have a documented explicit
recovery path, never age-based lock theft.

## Acceptance and implementation plan

Split #452 into config/resolution and live registration implementation PRs if
needed, preserving one coherent versioned control interface. Each has injected
filesystem, clock, Git resolver and HTTP boundaries. Tests cover scope isolation,
default initialization, malformed/future TOML, concurrent config writes, root and
subdir resolution, explicit/saved/nonrepo combinations, duplicates/conflicting
roots, no-project exit, no startup data calls, startup races, compatible reuse,
unrelated listener, invalid proof, incompatible protocol, partial registration,
pending port change and shutdown/restart cleanup. Packaged cross-platform tests
use temporary profiles and fake authenticated gh, not user configuration.

Update serve/config help, startup banner examples and onboarding URLs. Existing
read APIs/MCP and versioned result schemas stay compatible. The human-readable
dashboard does not need to exist for registration reuse to work.
