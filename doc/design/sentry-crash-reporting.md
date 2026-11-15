# Optional Node crash reporting

Contract for #623. The owner approved one Node Sentry project for unhandled exceptions
in CLI, serve and STDIO MCP. Browser tracking, normal error reporting, tracing, logs,
profiling and replay are outside this request. Project provisioning is complete;
this document does not publish an npm version or enable telemetry for all users.

## Lifecycle and configuration

A shared module initializes only inside the actual cli.ts or mcp.ts executable guard,
before invoking command/server startup. Imported library functions and tests do not
initialize telemetry. CLI serve uses mode `serve`; other commands `cli`; pdb-mcp `mcp`.
Environment `SENTRY_DSN` explicitly enables it; absent/invalid configuration leaves
normal operation unchanged. No default project DSN is embedded in the package. An
explicit SENTRY_DISABLED=1 disables even a supplied DSN. No token or new login is needed
by an installed user. Sentry CLI authentication is a maintainer tool, not app telemetry.

Use the supported Node SDK with defaults disabled and only its uncaught-exception
and unhandled-rejection integrations. Rejections use strict fatal semantics. No HTTP,
console, child-process, context-lines, user, host, session or breadcrumb integrations.
No tracing/logs/profiling/replay/metrics instrumentation is enabled. SDK debugging is
disabled and cannot write protocol stdout. A failed initialization leaves PDB usable.

Fatal reporting must terminate unsuccessfully rather than resume corrupted execution;
flush is bounded to at most two seconds. SDK shutdown/network failure cannot hang or
replace normal command output. Existing explicit exit codes, EPIPE, cancellations,
validated usage/config/network errors and caught tool failures remain unchanged and
are not separately captured. Top-level command catch blocks still count as handled:
this feature does not reclassify every nonzero command as a crash. Synchronous module
loading before bootstrap and hard process termination are documented limitations.

## Minimal egress

The beforeSend boundary constructs a fresh allowlisted event instead of deleting a
few known fields. Drop any event without an unhandled exception mechanism. Keep only
SDK-generated event ID/timestamp, error level, node platform, fixed exception type and
message, unhandled mechanism, and filtered stack frame locations. Do not copy original
exception messages, function names, source/context lines, locals, arbitrary data,
request URLs/headers/bodies, user, environment contents, argv, breadcrumbs, contexts,
attachments, transactions, tags or extras. Error text may contain tokens or issue bodies.

Keep only known PDB source-relative `src/` paths with safe filename components and
finite positive line/column numbers, or the public built cli.mjs/mcp.mjs/chunk basename.
Drop external/unknown/absolute locations. Windows separators and file URLs must be
normalized before matching; basename allowlisting must not turn arbitrary private paths
into plausible source evidence. Use a fixed exception type/message rather than arbitrary
user-controlled Error.name. Root event labels are fixed mode plus release metadata from
the installed package; unknown release omitted. Environment is a fixed `node` label,
not arbitrary inherited user text. Fingerprinting uses retained stack locations.
No application data is gathered merely for diagnostics. Transport envelopes must be
tested, including automatic SDK metadata, client reports and sessions; disable non-error
send paths. No private configuration or DSN is logged or committed.

## Verification and rollout

Injected sanitizer tests cover handled-event rejection, arbitrary secret-bearing fields,
malicious paths/control characters, unknown frames, mode and numeric bounds. Tests use
a local injected transport and no inherited DSN/network. Subprocess tests exercise an
actual bootstrapped entry with an asynchronous fatal event, failing exit and bounded
flush; normal help/invalid arguments and imported modules remain telemetry-free.

A disposable external preload may schedule a test throw only after the real PDB serve
health endpoint succeeds, then a maintainer supplies the approved DSN for that process.
The preload is outside source and is removed afterwards. No shipped test command,
HTTP crash endpoint, model run, GitHub mutation or captureException-only demo is needed.
Confirm the resulting issue in the agreed Sentry project and show the issue title, fixed
safe message and URL. Record unique event ID/time privately for lookup, never raw event
payloads in public tickets. Normal CI must not emit live events.

Production Node bundles need readable stack locations/source maps. Verify real source
and packaged frames separately; source-local success is not packaged-symbolication
proof. Do not mark onboarding complete if production readability remains unaddressed.
Build-time authenticated source-map upload or shipped maps with Node source-map support
requires an explicit reviewed follow-up if not included in this runtime slice. Record
that limitation and the exact next step; never embed an auth token. No release or global
install is implied by account setup. Document user opt-in and restart requirements.

References: [Node SDK](https://docs.sentry.io/platforms/javascript/guides/node/),
[uncaught exceptions](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/onuncaughtexception/).
