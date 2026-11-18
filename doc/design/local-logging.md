# Shared local logging

Owner-approved direction for #1017, 18 November 2026. This contract authorizes
implementation after review; it does not claim logging is already installed.
The [architecture](../architecture.md) owns shared service/state boundaries.

## Standard package, small integration

Use one ordinary maintained Node logging stack. Begin with Winston and
winston-daily-rotate-file: its documented daily pattern, UTC option, day-based
`maxFiles` and error events match the basic requirements. Adding dependencies is
explicitly authorized. See the [bounded package check](../research/local-logging.md).
A short integration check must establish the acceptance below; an equivalent
standard package may be substituted if these requirements are unmet. Record the
choice and reason, without another broad architecture exercise or lengthy survey.
No custom rotation, file-discovery/pruning engine or logging framework.

One canonical typed facade in `src/logging/` hides the framework. Composition
creates one state-holder per application/invocation lifetime, shared by CLI, MCP
and serve. It owns transports, buffered writes, failure status and close/flush;
callers emit events rather than manage files. Creating an import does no I/O.
This is local operational/audit logging, separate from Sentry/crash telemetry.

## Defaults and configuration

Extend the existing global configuration schema/service with `logging.enabled`
(default true), `logging.retentionDays` (positive integer, default 7),
`logging.level` (`error`, `warn`, `info`, `debug`; default info) and optional
`logging.directory` (absolute path). CLI configuration and eventual Configuration
UI use the same service. Reads of configuration alone do not create log files.
Keep the schema's existing supported-key/version and safe-write conventions.
Logging changes apply at the next CLI invocation or explicit serve reload;
application state reports what is actually applied. No automatic watcher.

Resolve the default directory with existing `env-paths('pdb').log`; do not hardcode
macOS/Linux/Windows paths or make a repository `.pdb/` directory. Keep framework
rotation metadata there too. Missing directories are created lazily when logging
starts. Include repository context on events rather than mixing logs into checkouts.

Write newline-delimited structured JSON, with UTC timestamps and UTC daily file
boundaries. Configure the package for seven **days**, not seven files; a package's
size cap may produce multiple files per day. Use its standard bounded-size option
(20 MiB starting value) and lifecycle. Retention is configurable; no indefinite
archive or upload is added. Expiry is performed by the package during its supported
startup/write/rotation lifecycle, including cleanup after inactivity. Nothing can
delete files while no PDB process runs; do not promise a background OS service.
Demonstrate that the default does not retain expired managed logs after the next
normal cleanup opportunity. Test midnight and inactivity explicitly.

Concurrent CLI processes and serve must not corrupt records or lose the rotation
catalogue. Use supported package concurrency/transport facilities and existing
filesystem boundaries; do not assume independent processes share a JS singleton.
A timestamp/PID filename alone is insufficient if it strands expired files. Verify
this with two writers before accepting the package configuration.

## Events, failures and audit acknowledgement

Use version 1 events with timestamp, event name, correlation/operation ID, action,
outcome and known repository, human, agent and session context. Unknown identity
stays unknown and never triggers identity setup. Version metadata describes PDB,
not private client credentials. Do not emit raw argv, tokens, authentication
headers, full request/response bodies or arbitrary private file contents by default.
Apply existing redaction to free text; preserve accepted reasons except necessary
secret redaction, marking that redaction occurred. Bound fields and event sizes;
reject an oversized forced reason rather than silently truncating its audit entry.

Ordinary events respect verbosity. Audit events cannot be filtered by level. A
disabled/unavailable logger makes the audit-required method fail, not silently
succeed. Ordinary operations continue with a sanitized, rate-limited stderr warning
on logging failure; never corrupt stdout JSON or MCP framing, and never recurse
through the failed logger. Logs do not themselves grant workflow authority.

Expose a typed best-effort event operation, an awaited audit-write result and
bounded flush/close. The audit result means the record reached the local file via
a successful write/drain acknowledgement, not merely an in-memory enqueue or
`logged` event. It does not promise fsync/power-loss durability. A normal Winston
callback alone is insufficient (see research). Use documented transport lifecycle
completion or another standard sink with an actual write acknowledgement; do not
invent a second custom audit-file implementation. Failure/timeout returns a typed
error. Short CLI invocations flush before normal exit; serve closes on shutdown.
No new daemon, broker, telemetry backend or security epic.

## Acceptance and delivery

A short contract/package check precedes #1017 implementation. Focused tests cover
default paths/configuration, UTC rollover, age retention after idle/restart,
concurrent writers, redaction, shutdown flush and real write failures. Specifically
prove audit-required write failure stops the caller before dispatch; ordinary
logging failure does not stop its operation. Use injected clock/filesystem/sink
boundaries and a small disposable-directory integration check, not live secrets
or a large framework benchmark.

#1016 consumes this service. Logging alone neither implements force nor changes
ownership. Retention is seven days by default; unknown package guarantees must be
resolved in the small implementation check rather than described as already proven.
