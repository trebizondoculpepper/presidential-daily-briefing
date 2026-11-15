# Temporary background launching for PDB serve

Research #552, 2026-11-15. **Recommendation: prototype a native `pdb serve --bg`
launcher first**, reusing the existing foreground server and single-instance service.
Use detached Node execution with independent standard streams, readiness acknowledgement
and explicit stop/status. Keep native transient supervisors as optional platform
adapters if real-host tests show the simple launcher is insufficient.

This is a research recommendation, not a delivered flag or proof that every IDE
leaves detached processes alone. No production service, autostart configuration,
credentials or running PDB instance was changed.

## Requested lifetime and current product

The owner's latest clarification is a manually started process that survives closing
an IDE/terminal but is not installed to restart after an OS reboot. That supersedes
the earlier boot-start idea for this slice. 'No permanent changes' means no OS
service/login-item/startup registration; runtime logs/metadata would need explicit
implementation documentation. Ordinary PDB configuration/project registration must
retain its existing semantics rather than being silently relocated or copied.

Current PDB already supplies the server, health/status routes, shutdown, global
project registration and single-instance reuse. Source evidence: `src/serve/`,
`doc/design/serve.md`, `serve-startup-configuration.md` and the global-dashboard
roadmap. The launcher should reuse these, not fork a second server implementation.
Collection remains lazy. Existing startup authentication checks are distinct from
prefetching all tickets and should fail visibly when login is unavailable.

## Options

| Option                                              | Advantages                                                                                                | Boundaries / recommendation                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached Node child, unref, independent stdio       | Fits the npm distribution, inherits the current user's supported runtime/auth context, no OS installation | Recommended first prototype. No crash restart; actual IDE/process-tree policy must be tested.                                                                                                                                                                                    |
| macOS transient launchd job                         | Native supervision independent of an IDE, explicit job identity                                           | Optional adapter. Local `launchctl` manual puts `submit` among legacy commands and describes failure restart; do not equate that with a simple detached child. A temporary bootstrap definition needs careful domain, cleanup and environment testing. No installed LaunchAgent. |
| Linux transient user service (`systemd-run --user`) | Managed identity, status and stop without a permanent unit install                                        | Optional where a user manager exists. Service and scope modes differ; do not use interactive/scope behavior as evidence of a detached service. Logout/user-manager policy remains host-specific; do not enable linger automatically.                                             |
| Windows detached Node / local Start-Process         | Native process launch without installing a service/task                                                   | Documentation supports independent local launch. Console, IDE job-object and termination behavior require Windows acceptance; not demonstrated here. Remote PowerShell sessions have different lifetime behavior.                                                                |
| Shell nohup / tmux / platform-specific wrappers     | Useful manual alternatives                                                                                | Extra shell/installation/quoting and lifecycle assumptions. Do not make them required dependencies or call a shell to wrap an already available Node executable.                                                                                                                 |
| Docker                                              | Optional operational isolation                                                                            | Not needed for this request. Adds daemon/network/mount and credential handoff work. A read-only config mount does not export a host keychain or constrain token API permissions. No container was run.                                                                           |

Node documents that `detached` changes process/session behavior, `unref` lets the
parent exit independently, and standard streams must not remain attached to the
parent terminal/pipes for a long-lived child. These are separate requirements;
adding only `&` or only `unref()` is not a lifecycle design.

## Bounded executed probe

Ran `doc/reports/examples/serve-background-probe.ts` on macOS 27.2 arm64, Node
v26.7.0, from the Codex session. The probe contains no GitHub/PDB/network operation:

1. An outer test creates a fresh temporary directory and a synthetic launcher.
2. That launcher creates one detached worker with ignored standard streams and
   calls unref. The worker writes nonce-bound heartbeats, with a five-second cap.
3. The outer test kills **only its own synthetic launcher** with SIGKILL and confirms
   the same worker's heartbeat advances after the parent exits.
4. A nonce-bound stop file asks the worker to exit. The outer test confirms exit and
   removes its temporary directory. It never signals a guessed worker PID.

Five consecutive runs passed. Each reported `parentKilled`, `sameWorker` and
`heartbeatAdvanced` true, followed by confirmed cleanup/exit zero. This supports
one local parent-death case. It does not demonstrate a real IDE closure, process-tree
kill, logout, sleep/wake, reboot, crash restart, keychain access or Windows/Linux.
No IDE or live PDB server was killed, and no launchctl/systemd/service registration ran.

Reproduce on a disposable POSIX host with Node 26+:

```sh
node doc/reports/examples/serve-background-probe.ts
```

The worker is bounded even if the outer probe fails. Windows deliberately refuses
this POSIX-only probe rather than claiming coverage from a skipped execution.

## Suggested minimal launcher semantics

These are proposed follow-up requirements, not an approved implementation contract:

- Keep `pdb serve` foreground behavior unchanged. `--bg` launches the same installed
  entry point via a verified `process.execPath` and argument array, with the flag
  removed to prevent recursive launching. Source execution and packaged entry paths
  need separate smoke coverage; never assume an npm script's cwd or PATH remains.
- Pass the intended project/config selection to the existing resolver. If a verified
  PDB instance already serves that user/configured port, register/reuse it and print
  its URL. Do not open a browser, launch duplicate listeners or adopt any unrelated
  service merely because it answers the port.
- Parent success means bounded acknowledgement of a real ready PDB instance, not just
  receiving a PID. Readiness uses instance/version/context evidence and the existing
  health/status service without a full ticket scan. Capture safe startup errors.
- An initial bounded handshake may use IPC, but disconnect it before parent exit;
  persistent parent pipes/IPC cannot be the child's only output/control path.
  Redirect long-lived output to bounded private logs or an explicit null sink, not
  the IDE's streams. Avoid unbounded logs or raw subprocess/auth errors.
- Preserve the current user's supported gh/auth configuration and required runtime
  environment; do not copy tokens, put them in command arguments, serialize the
  environment or re-login. A background keychain prompt/missing credential should
  become a foreground diagnostic, not an invisible hung startup. No sudo.
- Explicit status/stop should verify the actual instance. Prefer a bounded verified
  control protocol; do not kill a reused/stale PID or arbitrary process on the port.
  Stop uses existing graceful shutdown. Multiple launchers and metadata cleanup
  need race tests, and logout/reboot leave only diagnosable stale runtime metadata.
- No KeepAlive, launch-on-login, boot registration, scheduled task or automatic crash
  restart in this first slice. Reboot ends the process; a user must start it again.
  Sleep is not reboot, but survival/recovery is an acceptance case, not an inference.

A detached process cannot promise survival when an administrator or IDE explicitly
kills that process too. The contract must name the supported host/client events.
If target IDEs enforce descendant cleanup, test a native transient supervisor adapter
rather than hiding a failed detachment behind a longer readiness timeout.

## Lifecycle evidence and proposed follow-ups

| Event                                | Present evidence                                        | Required before claiming support                                                       |
| ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Synthetic launcher SIGKILL, macOS    | Five passing nonce/heartbeat probes                     | Reuse as a low-level regression only                                                   |
| Normal terminal / actual IDE close   | Not executed                                            | Native supported-client test with PDB readiness and later health read                  |
| Explicit PDB stop                    | Foreground shutdown exists; background routing untested | Verify instance-bound control and shutdown completion                                  |
| User logout                          | Not executed                                            | Decide/document supported session boundary for each adapter; do not promise survival   |
| Sleep/wake                           | Not executed                                            | Confirm server/gh recovery on target host                                              |
| Reboot                               | No autostart was installed; reboot not executed         | Verify no startup registration and no automatic restart; do not reboot the user's host |
| Windows/Linux, transient supervisors | Primary documentation only                              | Platform-native disposable tests; no simulated-host acceptance                         |

Recommended next tickets after discussing this report: (1) a reviewed temporary
launcher/lifecycle contract, (2) native Node launch/readiness/status/stop implementation,
(3) real-client/OS acceptance with explicit negative cases, and only if necessary
(4) transient supervisor adapters. Do not implement these from research alone.
No further owner input was needed to execute the bounded probe. The remaining useful
product choice is whether logout survival or automatic crash restart should ever be
added; both are outside the current recommendation and need not block the simple slice.

## Primary references

- [Node child-process detached option and unref](https://nodejs.org/api/child_process.html#optionsdetached)
- [systemd-run transient service/scope reference](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
- [Microsoft Start-Process notes](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process#notes)
- macOS local `man launchctl`, inspected on the host above: domain targeting,
  bootstrap/bootout and legacy submit/remove. This is documentation evidence only.
- [GitHub CLI credential-storage implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/login/login.go)
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
