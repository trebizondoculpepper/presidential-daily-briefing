# Configuration layers and PDB serve controls

Owner decisions from the 2026-11-17 design session, split from #452. This is a
contract amendment, not evidence that the features ship. It supersedes conflicting
layering, delivery ordering and new control-security requirements in
[serve-startup-configuration.md](serve-startup-configuration.md) and
[serve-settings-page.md](serve-settings-page.md). Keep their accurate schema,
scope, safe-write and existing-server requirements.

## Separate services and interfaces

| Slice                          | Owns                                                                                                     | Does not own                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Configuration service #804     | Read/list/set, typed defaults and validation, safe persistence, revisions and factual changes            | Running-server state, restart decisions, CLI/HTML rendering     |
| Config CLI #815                | Argument parsing and text/JSON presentation over the configuration service                               | A running-server dependency or duplicate configuration logic    |
| Application state service #816 | PDB serve's initial/applied snapshots, saved-versus-applied state, live/restart consequences and reasons | Configuration parsing/writing or ordinary config CLI operations |
| Configuration page #584        | Web presentation/editing over the shared services                                                        | A separate reader, writer or restart calculator                 |

Use **configuration service**, **`pdb config`**, and **Configuration** for the
website tab and page heading. Existing routes need not be renamed just to change
the visible label. Preserve compatibility for existing commands and schemas.

The configuration service supports explicit snapshot/revision comparisons and
reports changed keys with safe old/new values. A long-lived consumer can keep an
initial snapshot to ask what changed since it started. There is no invented
historical baseline for a short-lived CLI, no persistent dirty bit and no required
background watcher. Direct file edits are validated through the same reader.
All programmatic reads/writes use this shared machinery.

Only PDB serve needs the application state service. It compares saved values to
what the process actually applied, retaining the running baseline for startup-only
settings. Reverting a saved port to its running value clears its restart notice.
Restart establishes a fresh baseline. Failed application never advances the
applied snapshot. Return named changes/reasons and revisions, not only a Boolean.
Keep configuration facts separate from registered application consequence policy;
workflow decisions continue through the native rules boundary, never a UI-local
or CLI-local policy ladder. Startup port and TTL retain the existing restart
semantics; do not silently invent live support for either.

## Registered projects

Startup registration #805 uses the existing ordered `serve.projects` records:
GitHub host, repository and optional verified absolute `localRoot`. Combine
explicit targets, verified cwd and saved entries with canonical deduplication;
retain conflicting-root and missing-root diagnostics. A repo-only entry is valid.
Populate the selector without fetching issues, PRs or comments.

The separate table #812 extends #584's initial read-only registration list: allow
typing new rows, editing and removing with explicit Save/Cancel. Show project name
(initially derived from the repository), directory and host/repository. A custom
persisted display name is not required. Validate through #804; preserve order,
unrelated configuration and user input after rejected saves. Removal deletes no
files, repositories, tickets, human assignments or agent work.

## Reload, reuse and application

Reload #813 delivers both the endpoint and Configuration-page button over one
operation. The same operation serves repeated `pdb serve`: save through #804,
notify the existing instance, wait for its applied-revision/served-set result,
print its actual URL and exit. Do not start another normal-profile service or open
a browser. #807 depends on #813, so successful registration reuse acknowledges
activation; the earlier pending-restart-only staging is superseded. A saved but
failed activation is explicitly partial, with retry guidance, never success.

Live application #808 uses #816's state boundary. Project additions/removals take
effect in the selector after successful application. If the selected project is
removed, clear it, show a simple no-longer-registered/select-another message and
continue without a crash or silent switch. This is a low-importance edge case;
no elaborate recovery flow is required. Retain safe caches for unchanged contexts;
changed/removed contexts need generation/cancellation and final-response validation
through identity selection and collection. Invalidate cross-repository dependency
facts conservatively when their provenance is affected. No project prefetch.

Invalid live reload keeps the last valid applied configuration, reports the file
and useful existing parser/validator error, and permits retry without partial
application. Invalid fresh startup/restart reports the path and existing error
(line/column when supplied) and exits gracefully before listening. Do not build a
custom parser-error reporting subsystem.

## Shutdown and security scope

Shutdown #814 is a separate endpoint/button ticket, lower priority than reload.
Confirm intent, acknowledge the request before closing the listener, stop only
this instance and perform bounded graceful HTTP/MCP/resource cleanup. Remove only
its own discovery record. Keep configuration and project/agent work. Show a clear
stopping/stopped/unknown result and restart command; a lost connection alone does
not prove completed shutdown. No arbitrary process control or supervisor.

The owner explicitly deferred **new security infrastructure** to a future
comprehensive epic. #806's new discovery/control capability, ACL, proof and
security-session machinery is not a delivery prerequisite for #807/#808/#813/#814.
Do not implement a partial new authentication/CSRF/capability system in these
functional slices. Reuse and preserve existing server controls; this amendment
never authorizes removing shipped guards. Keep credentials/private metadata out
of output. Leave broad security design for its own reviewed work.

## Delivery and validation

#804 is the foundation; #815 and basic #584 editing can follow independently.
#805 and #816 follow #804. #808 follows project registration and application
state; #813 follows the reload mechanics and its page; #807 follows reload.
#812 separately supplies the project editor. Shutdown is independent of reload.
#452 remains the acceptance umbrella; retain historical partial-work notes and
recover the old implementation branch before duplicating it. No new claim is
implied by this amendment.

Use focused injected filesystem/service/clock/transport checks for revisions,
conflicts, no-op/reverted changes, partial application, startup/reload failures,
context invalidation and graceful stop. UI checks cover keyboard/narrow layouts,
feedback and preserved input. No live credentials, machine configuration or
research benchmarks enter normal CI. Estimates on child issues are provisional
scope assessments; a native blocker remains until its real prerequisite finishes.

## Application composition clarification

The application state service does not own construction of unrelated services.
The separate [service-composition contract](github-service-composition.md) assigns
startup wiring/lifecycle extraction to #870 and keeps #816 focused on saved,
running and applied configuration. #816 and existing reload work need not wait
for every GH-service migration.
