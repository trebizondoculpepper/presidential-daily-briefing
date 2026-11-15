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
Convert file URLs with the platform URL-to-path routine, normalize separators, then
relativize against a trusted PDB installation/source root derived from the executing
module location, never caller cwd or its repository root. Match that relative result
against the known src/ allowlist. Reject escaping, still-absolute, external or unknown
locations. For built frames, retain only verified files under that same installation
root; basename allowlisting must not turn arbitrary private paths into source evidence. Use a fixed exception type/message rather than arbitrary
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

## Packaged stack locations (#629)

Status: implemented by #629 except for the owner's live check and rollout approval, which are listed at the end of this section.

### What the packaged build reported before

The package ships single-file ESM bundles (`dist/cli.mjs`, `dist/mcp.mjs` and a lazy `dist/datalog-*.mjs` chunk) built by `vp pack`. Dependencies such as `@sentry/node` stay external in the installed `node_modules`, and the bundles are not minified. Without maps, a fault in the installed CLI reported frames like `dist/cli.mjs:28952:39` and `dist/cli.mjs:28810:35`. The sanitiser kept those frames, because they are verified files under the installation root, but they name a line in a 30,000-line bundle, not the source file that faulted. The live check on #623 (issue PRESIDENTIAL-DAILY-BRIEFING-1) proved delivery and labels only: its fault came from an external preload, whose frames were correctly filtered out.

### Choice: shipped maps, mapped in-process at report time

Three options were considered. The choice is the third.

1. **Build-time authenticated upload (Sentry debug IDs or release artifacts).** Rejected for this slice for three reasons:
   - It needs a Sentry auth token in a build or release job, and a publication pipeline the project doesn't have (no npm release is in scope).
   - Server-side symbolication needs `debug_meta` or `abs_path` on the event, which the allowlisted event deliberately omits.
   - It can only be verified live, so normal CI couldn't check it.
2. **Shipped maps with Node's own source-map support** (`--enable-source-maps` or `process.setSourceMapsEnabled`). Rejected for two reasons:
   - Node maps only modules loaded after the switch, and the bundle is already loaded when the bootstrap runs. A flag would change every user's process, telemetry or not.
   - Node rewrites stacks to `<install>/src/*.ts` paths that don't exist on disk, which the sanitiser's containment check drops.
3. **Shipped maps, read by the sanitiser.** Chosen. Its properties:
   - The build emits a map beside each bundle (`--sourcemap`). `scripts/sourcemaps.ts` then fails the build if any map names a source outside `../src/` (for example a home or build directory), and it strips `sourcesContent`, so the archive holds positions and public file names only. Together the maps add about 1.2 MB to the unpacked package.
   - At report time, inside `beforeSend`, `mappedFrame` in `src/telemetry/crashes.ts` maps each verified built frame through the map beside that file (`<root>/dist/X.mjs.map`, never a `sourceMappingURL` the file names). It uses Node's `module.SourceMap`.
   - A frame is mapped only on an exact generated-line hit whose origin normalises to the existing `src/` allowlist. Otherwise the built location is kept unchanged.
   - Maps are read only when a fatal event is being reported, at most 32 MB per map, parsed once.
   - Nothing changes for a process with telemetry off.

Boundaries kept:

- **Maps:** they contain only public, package-relative source names already published in the repository. No source text, no local paths.
- **Tokens:** no upload credential exists anywhere: not in the build, not in the package, not on a user's machine.
- **Public package:** the `files` allowlist names the three map paths explicitly, and `scripts/package-test.ts` checks the archive contents and the installed maps.
- **Event data:** frames still carry only file, line and column. There are no function names, context lines or messages.

Sentry displays these frames directly, with no server-side symbolication.

### Verification: injected and packaged cases stay separate

- **Injected source cases** (`src/telemetry/crashes.test.ts`): a handcrafted map in a temporary root covers these cases:
  - an exact hit maps to `src/`;
  - an origin outside `src/`, a line past the bundle, a missing column, a non-built file or a missing map keeps the built location;
  - a malformed map keeps the built location;
  - `sanitizeCrash` emits the mapped frame.

  The existing sanitiser and source-subprocess tests are unchanged.

- **Packaged subprocess cases** (`scripts/package-test.ts`, `npm run package-test`, POSIX):
  - **Setup.** The real archive is packed and installed into an isolated temporary prefix, then run as `node --import scripts/crash-preload.ts <installed>/dist/{cli,mcp}.mjs …` with `SENTRY_DSN=https://public@sentry.example.invalid/1`.
  - **The preload.** It is test-only, not in the package, and not imported by PDB. It replaces `https.request` with a local recorder that refuses every other host, so no network is used. It throws from a builtin that PDB's own listener code calls outside any `try`. `pdb serve` faults in its access-log `finish` listener after a `/healthz` request. `pdb-mcp --poll` faults in its SIGTERM `.finally(() => process.exit(0))`. These are real `uncaughtException` and strict `unhandledRejection` paths through the installed bundles.
  - **Assertions.** The process exits 1. Exactly one envelope with one `event` item is recorded. `level: fatal`, `environment: node`, `release: pdb@<installed package version>`, `tags: { mode }` and the fixed message are set. Every frame is a mapped `src/` frame, and the newest frame's line in `src/` contains the faulting call. The envelope contains none of the thrown text, the fake token, the private path or the install and work directories.
  - **Observed on this branch.** Serve: `src/serve.ts:264 <- src/serve.ts:102`, which are the access-log `runtime.stderr(` call and `stderr: (text) => process.stderr.write(text)`. MCP: `src/mcp.ts:50`, which is `void handle.close().finally(() => process.exit(0))`.
  - **What is not covered.** The `cli` mode label for non-serve commands is covered by the sanitiser unit tests, not by a packaged fault, because no non-serve command has an unguarded listener to fault through.
  - **No live calls.** Normal CI makes no Sentry request: the recorder refuses all network, and no DSN is inherited.

### Opt-in use

Crash reporting is off unless a DSN is supplied. There is no default DSN, no login and no token.

```sh
# One run, for example while reproducing a crash:
SENTRY_DSN='https://<public key>@<org ingest host>/<project id>' pdb serve

# MCP clients: put the variable in that server's environment block, not in shell profiles.
# Turn it off even when a DSN is inherited:
SENTRY_DISABLED=1 pdb serve
```

- Only `https` DSNs with a public key and a numeric project id are accepted. Anything else leaves telemetry off silently.
- The setting is read once at startup, so a running `pdb serve` or `pdb-mcp` must be restarted to start or stop reporting.
- PDB never writes the variable to a profile, `config.toml`, `pdb.toml` or a client configuration. Setting it persistently is the user's own choice.
- **Release evidence:** the event's `release` is `pdb@` plus the installed `package.json` version, read by `installedVersion` (`src/updates/updates.ts`). An unknown version omits `release` rather than guessing.
- **Environment evidence:** `environment` is always the fixed label `node`.
- **Mode evidence:** `tags.mode` is `serve` for `pdb serve`, `cli` for other `pdb` commands and `mcp` for `pdb-mcp`.

  The package test asserts all three for the installed archive.

### App telemetry versus the maintainer's Sentry CLI

- **App telemetry** is the `SENTRY_DSN` described above. A DSN is a public ingest address. It can only send events to the project, cannot read anything, and needs no account.
- **The Sentry CLI** (`sentry-cli`, or the maintainer's `sentry` command-line login) is a maintainer tool, authenticated with the maintainer's own account or an auth token, for reading issues and managing the project. PDB never reads, needs or ships that authentication. Nothing in this design uploads source maps, so no build or CI job needs it either.
- Never paste either a DSN or an auth token into a public issue, PR or commit.

### Remaining owner steps

1. **Optional live check of the packaged mapping.** This sends one event. Run it on the maintainer's machine with the approved DSN, from a checkout of the merged commit:

   ```sh
   npm ci && npm run build
   tmp=$(mktemp -d) && npm pack --pack-destination "$tmp" --ignore-scripts
   npm install --prefix "$tmp/p" --global --no-audit --no-fund "$tmp"/*.tgz
   # Disposable trigger, outside the checkout and the package; deleted with $tmp below.
   cat > "$tmp/trigger.mjs" <<'JS'
   const write = process.stderr.write.bind(process.stderr);
   process.stderr.write = (chunk, ...rest) => {
     if (/^GET \/healthz /.test(String(chunk))) throw new Error("PDB live crash check");
     return write(chunk, ...rest);
   };
   JS
   SENTRY_DSN='<approved DSN>' node --import "$tmp/trigger.mjs" \
     "$tmp/p/lib/node_modules/@trebizondoculpepper/presidential-daily-briefing/dist/cli.mjs" \
     serve --repo <owner/name> --port 0
   # In another shell: curl http://127.0.0.1:<port>/healthz  (the server then exits 1)
   rm -rf "$tmp"
   ```

   This follows the #623 rule: the trigger is a disposable external preload that is never committed. `pdb serve` needs the maintainer's normal `gh` login to start. Expect a new event under the issue titled `Error: Unhandled PDB exception (details withheld)` with tag `mode: serve`, release `pdb@<version>` and in-app frames `src/serve.ts` lines 264 and 102 (as of this commit). No source-map upload or Sentry CLI step is involved.

2. **Rollout approval.** Approval to publish a release whose package contains the `.mjs.map` files, and to mark Sentry onboarding complete. Neither happens automatically. Reporting stays opt-in per process, with no public telemetry default.
