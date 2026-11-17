# Small attended installer delivery: Codex, Claude and Ori

Implementation handoff for #581/#582, with #583 following the same ownership
boundary. Supersedes the unresolved product-budget questions and all-platform
sequencing interpretation in codex-installer.md. Project default, explicit global
scope, identity recovery, hook plus MCP setup, safe removal and manual native
approval are already owner decisions. A generic Stop payload is still not proof
of natural completion; configuration is not verified continuation.

## Shared boundary, not an all-agent framework

Reuse codex-installer.md's scoped private manifest, owned/edited/foreign entry
classification, exact previews, safe atomic/concurrent writes, typed partial
outcomes and uninstall preservation. Implement only the small shared entry/manifest
service needed by the first adapter. No SDK, daemon, platform survey or new login
is a prerequisite. Supported formats are verified by read-only native capability
probes in disposable homes; no model generation or trust-store write is required.
An unknown format is reported as unsupported, never guessed from another client.

Keep workflow/default selection in shared native decisions and facts/mechanics in
TypeScript under workflow-policy-boundary.md. File schema/path validation,
verified package executables, exact entry ownership, actual client capability and
operation outcomes remain factual constraints. Do not let an `--agent`/role string
impersonate a human or treat client configuration as permission to mutate tickets.

The CLI shape remains `pdb install <agent>` / `pdb uninstall <agent>`, with current
repository default and an explicit `--global`. CLI MCP defaults STDIO; web Setup
defaults the running server's HTTP URL. Both transports are explicit options;
no auto-detection silently changes the transport. Require a valid explicit HTTP
URL when the default server address is not known. No server startup/probe/polling
or permanent background service is needed merely to write connection settings.

## Native adapter targets and evidence

| Client      | Project scope                                                                                                                 | User-wide scope and limits                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `.codex/hooks.json`; project MCP table in `.codex/config.toml` only when verified for the installed client                    | Existing Codex home rules from codex-installer.md; never fall back to global when project MCP is unsupported.                                               |
| Claude Code | `.claude/settings.local.json` for PDB-owned Stop entries and `.mcp.json` for the project MCP entry, preserving all other keys | Native user hook/MCP files only through the verified format adapter; the CLI distinguishes local/project/user scopes, so do not assume they share one file. |
| Ori         | `.ori/mcp.json` project MCP entry, using the recorded `mcpServers` shape                                                      | Explicit native user scope only after format verification. Recorded native Ori has no Stop hook; do not invent one.                                         |

These are recorded integration targets, not unconditional support for every future
client version. Reuse the sanitized reports under doc/reports/agent-platforms/,
including claude-code-review-addendum.md, ori-mcp-acceptance.md and the native stop
reports. Recheck installed help/schema before writes when the tested format cannot
be established. Missing client/version/capability gets a clear read-only result
and exact supported recovery, not a launch of the client's agent session.

Resolve installed `pdb`/`pdb-mcp` commands from this running package, not a source
checkout, `tsx`, another PATH version or user-maintained `.mjs` helper. Forward
literal arguments safely on the supported OS. The native hook command contains
no workflow/JSON logic; all event decoding, identity, binding and response framing
live in packaged PDB adapters. A tiny shell wrapper is allowed only where needed
for native invocation. Normal native review/trust remains the human's next step.

Project setup reuses identity resolution/allocation, preserving valid names and
settings; if role/entry is ambiguous, use supported setup/recovery rather than
borrowing another identity. Explicit global setup does not invent a global agent.
Uninstall removes only unchanged manifest-owned PDB hook/MCP entries. It preserves
identities, human assignment, project settings, user edits and unrelated agents.
Foreign/edited entries need explicit inspection/adoption, never a heuristic erase.

## Hook availability versus installation

The installer may complete manifest/identity/MCP work while reporting the hook
item unavailable or not attempted. Preserve that partial outcome and file/retry
syntax; do not report the whole requested integration installed. Do not write a
hook pointing to an entry point that has not shipped or can never bind a session.
The installed-adapter work is a focused technical prerequisite, not another owner
question or a reason to block unrelated MCP/manifest implementation.

Normal approved session initialization follows approved-continuation-limits.md:
ensure one real native binding on supported startup/eligible events; no manually
preinitialized synthetic session, arbitrary default work cap or counter reset.
Legacy capped mode remains explicitly identified until migrated. Do not silently
set `--natural-stop-confirmed` on every Stop or equate exact-hash approval with
completion provenance. Where provenance is unverified, attended setup is labelled
experimental and unknown event causes allow normal stopping. Only explicit user
stops always win; they must not be restarted by a late fetch or error path.

User-directed manual native tests are distinct from configuration proof. The
installer ends with "Here's what to do next", naming the exact native approval
step, available Doctor/setup commands and any remaining unsupported path. Report
configured, trusted, executed and model-visible receipt as separate states. Never
claim a paid trial, approval, nonce receipt or universal interruption support that
was not observed. This design grants no new model-trial allowance.

Ori's watcher/headless-resume behavior belongs to its separately scoped adapter
work; it is not a native before-stop veto. Ori MCP installation can be implemented
and used without promising a nonexistent native hook. Parent #583 retains any
remaining watcher/native acceptance rather than being closed by MCP-only delivery.

## Focused implementation order

1. Shared private manifest/entry ownership and safe edit primitives, with exact
   preview/dry-run and injected conflict/partial/rerun/uninstall cases.
2. Codex project/global identity and MCP command surface using those primitives.
   Project format verification is local/read-only; unsupported scope stays explicit.
3. Claude project/global identity and MCP adapter using the same primitives. It
   depends on shared primitives, not completion of Codex's native-hook trial.
4. Installed session-bound hook entry and native registration for each client,
   independently. Preserve real unsupported/provenance outcomes and owner manual
   test instructions; no serial dependency on every other client's research.
5. Ori's supported MCP adapter, and a separate honest watcher follow-up if wanted.

#581 and #582 remain high priority. Their implementation should be sliced around
these deliverables rather than one multi-agent framework PR. Generic uncapped
core migration #657 is an independent runtime feature; do not add it as a blocker
to every manifest/MCP or attended configuration task. Normal uncapped continuation
cannot be declared delivered before its real core/binding capabilities ship.

Use credential-free native-format fixtures, injected filesystem/Git/clock and a
packed install outside a checkout. Cover missing/multiple projects and identities,
spaces/quotes, dry-run, rerun, upgrade, malformed/future config, symlinks, edits,
foreign entries, write conflict, partial install and safe removal. Native trust,
stop/error/cancel and receipt tests are recorded separately in the actual client;
one platform's pass never substitutes for another's evidence. No real owner config,
trust store, credential, ticket assignment or unattended service is changed as a test.
