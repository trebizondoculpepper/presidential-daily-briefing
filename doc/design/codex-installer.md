# Codex installer: `pdb install codex` and `pdb uninstall codex`

Current delivery clarification: [small attended installer delivery](attended-installer-delivery.md) supersedes the stale product-budget questions and broad platform gating below. Hook availability/provenance remains a factual implementation boundary, not a new owner decision.

Status: proposed contract for #581, delivered under #589. Nothing here is implemented by this document. Sections headed "Shipped today" describe current behaviour and cite the implementing file; everything else is a proposal. #582 (Claude) and #583 (Ori) reuse the shared boundary defined here but verify their own native formats; they never block Codex.

## Owner decisions (settled)

From #581 and its owner comments, adopted without reopening:

- `pdb install codex` configures **both** the thin Stop hook and the PDB MCP connection.
- Default scope is the **current repository**: a nested cwd resolves to the verified Git working-tree root. User-wide scope needs an explicit option (`--global`); it is never inferred from missing project context. Outside a resolvable repository the default refuses helpfully.
- The CLI installer defaults to **STDIO MCP** using the installed executable; HTTP is an explicit alternative. Transport never depends on whether a server happens to be running. (The website setup page defaults to HTTP; see [serve.md](serve.md).)
- Install creates or recovers the repository-local identity through the existing `pdb setup identity` service, preserving a valid name and role, before writing any dependent hook. A user-wide install does not invent a global identity; identity resolves per repository at runtime.
- Reinstall replaces PDB's own older managed entries with the current version, preserving unrelated entries. Ambiguous ownership is not permission to replace.
- `pdb uninstall codex` removes only PDB-managed hook **and** MCP entries in the selected scope. Identity, project settings, the npm package, credentials and other clients' integrations survive. Uninstall when already absent is a no-op.
- Dry-run preview of exact changes; normal apply. Check configuration locally afterwards; never launch an agent or model session to validate. Configured, trusted, executed and receipt-verified are separate states.
- Partial installation is acceptable when reported accurately: successes, failures, exact file path, suggested correction and retry command. A rerun completes missing work without duplicates.
- Finish with "Here's what to do next": concrete native trust or setup steps, or a precise ready/configured status that never claims an unobserved hook run.
- No tokens, auth copying, trust-store edits, bypass flags, remote machines, automatic GitHub actions, permanent background services or committed private config. The owner's existing trusted experimental definition stays until deliberately replaced.

## Shipped today

- **No installer.** Nothing in `src/` writes Codex configuration; no `install` or `uninstall` command exists (`src/cli.ts` routes no such command). The nearest precedent is `pdb onboard --install`, which writes only the managed AGENTS.md section between `COORDINATION_START`/`COORDINATION_END` (`src/briefing/onboardcli.ts`, `src/config/agentsguide.ts`, `src/briefing/onboarding.ts`).
- **Codex Stop adapter.** `pdb rebrief codex-stop` (`src/rebrief/cli.ts`, `runCodexStop`; translation in `src/rebrief/codex.ts`) requires `--state-dir` and `--repo`, accepts `--role`, `--agent`, `--project`, `--entry | --harness`, `--deadline-ms` (1–10000), `--cap` (1–3) and `--transport service|http-mcp`, and requires `--natural-stop-confirmed` or it returns `{}` before any read. It reads at most 8192 bytes of stdin JSON, requires `hook_event_name` `Stop`, bounded `session_id`/`turn_id` and `stop_hook_active === false`, never opens transcripts, and always exits 0 with `{}` or `{"decision":"block","reason":…}`. Defaults (`src/rebrief/core.ts`): deadline 10 s, cap 3.
- **Session state** must already exist: only an explicit `pdb rebrief init --session ID` creates it, keyed by repository, project, agent, role, platform and session; missing state means a normal stop. `withPrivateState` (`src/rebrief/state.ts`) requires an absolute, non-symlink, owner-only 0700 directory under `os.tmpdir()` with no `.git` ancestor.
- **The reviewed hook contract** [packaged-native-hook.md](packaged-native-hook.md) says the event must never create or reset a session budget, never infer a repository from the event cwd, and treat `--natural-stop-confirmed` as a controlled-trial precondition only.
- **Native Codex facts** recorded in [codex-stop-hooks.md](../reports/agent-platforms/codex-stop-hooks.md) and [codex-stop-hook-prototype.md](../reports/agent-platforms/codex-stop-hook-prototype.md): user `~/.codex/hooks.json`, project `.codex/hooks.json`; project hooks need a trusted project layer; non-managed definitions need exact-hash trust through the `/hooks` UI; changing a definition can require renewed trust; the app-server exposes `hooks/list` with `trustStatus` but no trust mutation. Codex 0.169.0 on macOS discovered, trusted (by the owner) and executed a project Stop command and continued the same session.
- **MCP.** `pdb-mcp` is a package `bin` (`package.json`, `dist/mcp.mjs`) serving STDIO with `--project`, `--repo`, `--agent`, `--entry | --harness`, `--poll` (`src/mcp.ts`, `src/mcp/server.ts`). HTTP MCP is `/mcp` on `pdb serve`, default `http://127.0.0.1:4372/mcp` (`src/serve/options.ts`, `src/serve/mcp.ts`). The setup page's verified Codex example is STDIO via `[mcp_servers.pdb]` with `command` and `args` (`clientExamples` in `src/serve/setup-page.ts`); Codex over HTTP is marked unverified (#397). The platform survey records `codex mcp add NAME -- CMD` and the shared `~/.codex/config.toml` ([codex.md](../reports/agent-platforms/codex.md)).
- **Identity.** `pdb setup identity` (`runSetup` in `src/config/configcli.ts`) → `resolveIdentityTarget` (Git `rev-parse --show-toplevel`, no parent or global fallback; `--repo` must match a remote), `setIdentity` (locked write of root `pdb.toml`, `ensureExcluded` into `info/exclude`, one-time legacy `agent-inbox.toml` import) in `src/config/identity.ts`; harness detection with conflict reporting in `src/config/harness.ts` (Codex via `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CODEX_MANAGED_BY_NPM`, `CODEX_CI`).
- **Safe writes.** `updateTextFile` / `updateJsonFile` (`src/config/safejson.ts`: lock, private temp file, `checkUnchanged` re-read, rename, directory fsync; outcomes `written`, `kept`, `not-written`, `committed-with-error`) and `acquireFileLock` (`src/config/filelock.ts`). Symlink refusal lives in callers (`src/config/agentsguide.ts`, `src/config/identity.ts`). TOML is `smol-toml`, whose stringify does **not** preserve comments or layout (`src/config/config.ts`).
- **Doctor** has no hook or MCP check (`src/config/localdoctor.ts`).

## Technical incompatibilities found

The reviewed adapter contract cannot serve an installed hook as it stands. These are recorded on #581 with this evidence; the first two need an owner decision (see [Open questions](#open-questions-for-the-owner)).

1. **Session state cannot exist in advance.** The installer runs before any Codex session exists, but `codex-stop` stops normally unless `pdb rebrief init --session <actual id>` ran first, and [packaged-native-hook.md](packaged-native-hook.md) forbids the event creating a session budget. Installed as-is, the hook would never brief.
2. **Natural-stop provenance.** Without `--natural-stop-confirmed` the adapter stops before any read; the flag is restricted to controlled trials, and Codex's Stop payload has no cause field distinguishing natural completion from budget, error or disconnect ([codex-stop-hooks.md](../reports/agent-platforms/codex-stop-hooks.md)). Installed without it, the hook is inert; installed with it, it contradicts the reviewed contract.
3. **User-wide scope needs runtime repository resolution.** A `--global` hook cannot carry `--repo`, but the adapter contract forbids inferring a repository from event cwd. The owner's #581 decision ("repository-specific identity resolution still applies at runtime") settles this for user-wide installs; this contract narrows it to the verified Git root of the event `cwd`, matched against a remote, through the existing `resolveIdentityTarget`, and otherwise a normal stop.
4. **State directory location.** `withPrivateState` requires a directory under `os.tmpdir()`, which the OS may clean; a fixed path in a trusted hook definition would then fail silently. Proposed: the adapter derives and creates its state directory itself (below), so the definition carries no path.
5. **TOML layout.** `smol-toml` rewrites lose comments and ordering, which would damage a user's `config.toml`. MCP edits therefore use the bounded text edit below, verified by parsing, never a parse-and-stringify rewrite.

The installer **does not write a nonfunctional hook**. The shared manifest/identity/MCP slices proceed independently, while installed binding and native hook availability remain separate technical work under attended-installer-delivery.md. The product decisions are settled; do not ask the owner the same budget questions again.

## CLI contract

```text
pdb install codex   [--global] [--transport stdio|http] [--url URL] [--role implementer|designer]
                    [--entry KEY | --harness NAME] [--repo owner/name] [--dry-run] [--json] [--yes]
pdb uninstall codex [--global] [--dry-run] [--json] [--yes]
```

- **Scope.** Without `--global`: `resolveIdentityTarget(cwd, --repo)`; failure refuses with `NO_PROJECT` and the next command (`cd` into the checkout, or `--global`). With `--global`: the user-wide Codex home (`$CODEX_HOME` when set, else `~/.codex`), and no identity is created.
- **Targets.** Project: `<root>/.codex/hooks.json` and `<root>/.codex/config.toml`. User-wide: `<home>/hooks.json` and `<home>/config.toml`. Slice 1 verifies against the installed Codex that a project `.codex/config.toml` `[mcp_servers]` table is honoured for a trusted project; if it is not, project MCP install refuses with `UNSUPPORTED_SCOPE` and the exact `--global` alternative, and that evidence is recorded on #581.
- **Transport.** `stdio` (default) writes `[mcp_servers.pdb]` with `command` = the absolute path of the installed `pdb-mcp` (resolved from the running package, never a checkout, `tsx` or `.mjs` helper) and `args` = `["--project", "<root>"]` plus `["--entry", "<key>"]` when the identity step resolved or created a named entry, for project scope (without it `resolveReadIdentity` in `src/config/readidentity.ts` falls back to harness detection, and `resolveEntry` in `src/config/harness.ts` stays unresolved when a `codex.*` entry exists, so the MCP server would not use the identity just set up), or none for user-wide (selection then follows [mcp.md](mcp.md): explicit repository per call, never cwd). `http` writes `url` = `--url` or `http://127.0.0.1:4372/mcp`, marked "unverified for Codex (#397)" in output until #397 records acceptance. No probe of a running server decides anything.
- **Identity** (project scope only): if the resolver finds a valid entry for the selected harness/entry, keep it; otherwise run the same code path as `pdb setup identity --role R`. A missing `--role` in a non-interactive shell refuses with `IDENTITY_REQUIRED` and the exact command; a TTY may prompt as `pdb setup identity` does. Harness conflict or several candidate entries refuse with `IDENTITY_AMBIGUOUS`, never picking the first.
- **Confirmation.** Apply shows the preview and asks for confirmation on a TTY; `--yes` skips the prompt; non-TTY without `--yes` behaves as `--dry-run`.
- **Exit codes.** 0 all requested items applied or already current; 2 partial (some applied, some refused or failed); 1 nothing applied.

## Ownership and replacement

Codex's native files must not gain unsupported keys, so ownership is recorded outside them:

- A private **install manifest** per scope: project `<git-dir>/pdb/install/codex.json` (inside `.git`, never committed, resolved with `git rev-parse --git-common-dir`), user-wide `<state>/pdb/install/codex.json`, where `<state>` is `$XDG_STATE_HOME` (default `~/.local/state`) on macOS and Linux and `%LOCALAPPDATA%` on Windows (a new location; PDB has no user-wide state directory today), written with `updateJsonFile` at mode 0600. Each record holds file path, item kind (`hook` or `mcp`), the exact canonical JSON or TOML text written, its SHA-256, PDB version and time.
- **Owned** means: present in the manifest and the native entry is byte-identical (after canonicalisation) to the recorded text. Only owned entries are replaced or removed.
- **Edited** means: manifest record exists but the entry differs. Install and uninstall refuse that item with `OWNED_ENTRY_EDITED`, show both versions and give the recovery: restore it, or remove it by hand and rerun.
- **Foreign** means: an entry that looks like PDB's (a Stop command invoking `pdb rebrief codex-stop` or the trial helper, or an `[mcp_servers.pdb]` table) with no manifest record, including the owner's trusted experimental definition. Never replaced or removed; reported as `FOREIGN_ENTRY` with the exact location and the explicit adoption path `pdb install codex --adopt <kind>`, which records it in the manifest only after the user confirms, and only then lets a later reinstall replace it.
- Any other entry is unrelated and is preserved exactly.

## File edits

- **hooks.json:** parse with the existing JSON reader; refuse malformed JSON (`MALFORMED_CONFIG`) and unknown top-level shapes that are not an object with an optional `hooks` object (`UNSUPPORTED_SCHEMA`). Insert or replace only the owned Stop entry; serialise with stable two-space formatting. JSON has no comments, so formatting changes are acceptable; key order is preserved.
- **config.toml:** a bounded text edit. Install appends (or replaces, for an owned table) exactly one `[mcp_servers.pdb]` table block, preceded by one blank line. Before writing, parse the original and the result with `smol-toml` and require the result to equal the original plus (or minus) exactly that table; otherwise refuse with `UNSAFE_TOML_EDIT`. Malformed TOML refuses without writing.
- Every write goes through `updateTextFile` with `checkUnchanged`, refuses symlinked targets and targets resolving outside the selected scope (`UNSAFE_PATH`), and creates `.codex/` only when the scope is a verified project root. A concurrent change gives `CONFLICT`; nothing is retried automatically.
- Rerun with everything owned and current is `kept` with no write.

## Hook definition (after the open questions are answered)

The installed command carries no paths or session: `pdb rebrief codex-stop --installed`, plus `--role R` and the same `--entry <key>` as the MCP registration for project scope, with native `timeout` 5 and the adapter's `--deadline-ms 4000` default for installed mode. `--installed` mode (an adapter change, specified in its own slice against [packaged-native-hook.md](packaged-native-hook.md)):

- resolves the repository from the event `cwd`'s verified Git root and remote (user-wide) or from the root recorded when installed (project), and the identity through `resolveReadIdentity`; any failure is a normal stop;
- derives its private state directory itself (owner-only, under the existing `withPrivateState` rules) keyed by repository and session;
- initialises a session budget on the first eligible Stop for an unknown session, subject to open question 1;
- applies natural-stop eligibility according to open question 2;
- keeps every other existing guard: reentry, cap, deadline, user stop, bounded stdin, no transcript, exit 0.

A forwarding-only wrapper is used only where the native command shell cannot invoke `pdb` directly (Windows needs its own verified invocation; not part of slice 1).

## Result, partial failure and next steps

```ts
interface InstallResult {
  schemaVersion: 1;
  kind: "install-result";
  client: "codex";
  operation: "install" | "uninstall";
  scope: { kind: "project"; root: string; repository: string } | { kind: "global"; home: string };
  dryRun: boolean;
  items: Array<{
    kind: "identity" | "hook" | "mcp";
    file: string | null;
    action: "create" | "replace" | "remove" | "kept" | "absent" | "skipped";
    outcome:
      | "applied"
      | "committed-with-error"
      | "planned"
      | "refused"
      | "failed"
      | "not-attempted";
    code: InstallErrorCode | null;
    message: string;
    diff: string | null; // exact change, for preview
    retry: string | null; // exact command
  }>;
  status: {
    configured: boolean;
    trusted: "unknown";
    executed: "unknown";
    receiptVerified: "unknown";
  };
  next: string[];
}
```

Error codes: `NO_PROJECT`, `IDENTITY_REQUIRED`, `IDENTITY_AMBIGUOUS`, `UNSUPPORTED_SCOPE`, `UNSUPPORTED_CLIENT_VERSION`, `MALFORMED_CONFIG`, `UNSUPPORTED_SCHEMA`, `UNSAFE_TOML_EDIT`, `UNSAFE_PATH`, `CONFLICT`, `LOCKED`, `OWNED_ENTRY_EDITED`, `FOREIGN_ENTRY`, `HOOK_NOT_AVAILABLE` (hook withheld until the open questions are answered), `WRITE_FAILED`.

A writer result of `committed-with-error` from `updateTextFile` (`src/config/safejson.ts`: the file was replaced but directory fsync or temp-file cleanup failed) is reported as `committed-with-error` with the redacted diagnostic, counts as written for later steps and for uninstall, and makes the overall exit 2; it is never shown as clean success or as not written ([safe-shared-file-writes.md](safe-shared-file-writes.md)).

Order: identity, then MCP, then hook. A failed identity step marks the hook `not-attempted`; MCP does not depend on identity for user-wide scope. Each applied item is reported even when a later one fails, with its file path. Output never includes tokens, environment values or file contents other than PDB's own entries.

`trusted`, `executed` and `receiptVerified` are always `unknown` from the installer. Text output ends with **Here's what to do next**, for example: "Open Codex in /path/to/project, run /hooks, review the PDB Stop hook and trust it. The PDB MCP server is configured for STDIO; Codex starts it on the next session." `pdb doctor` gains read-only checks (slice 4) that report configured/owned/edited/foreign state and, when the Codex CLI is installed, `hooks/list` trust status, without starting a session.

## Uninstall

Removes owned unchanged hook and MCP entries and their manifest records; never identity, `pdb.toml`, `.github/triage.toml`, state directories in use or unrelated entries. Removing the last entry leaves an empty but valid `hooks.json` rather than deleting a file the user may own. Edited and foreign entries refuse with the inspection path. Already absent is `absent` with exit 0. `--global` is required to touch user-wide entries.

## Test matrix (injected filesystem, Git, clock, Codex CLI probe; packed install outside a checkout)

Supported and unsupported client version; missing, nested and ambiguous project; missing, valid and ambiguous identity; first install; rerun (no write); reinstall after PDB upgrade (owned replace); edited owned entry; foreign entry including the trial-helper definition; `--adopt`; unrelated hooks and MCP servers preserved byte-for-byte; malformed and future-shaped JSON/TOML; TOML with comments; concurrent edit; lock held; symlinked file and directory; paths with spaces and quotes; STDIO and HTTP transports; `--global`; partial failure at each step with exact retry; dry-run writes nothing; uninstall after install; repeated uninstall; no credentials or environment in output. Real Codex acceptance uses the normal trust flow and records `hooks/list` and session evidence separately; synthetic tests never stand in for it and no new model allowance is assumed.

## Implementation slices

1. **Native format verification and manifest.** Record installed-Codex evidence for project `config.toml` MCP and both `hooks.json` locations (`hooks/list` against disposable homes, no trust edits). Manifest module and ownership classifier. Checks: owned/edited/foreign/unrelated classification fixtures; evidence report linked from #581.
2. **`pdb install codex` / `pdb uninstall codex` for MCP and identity.** Checks: STDIO default, HTTP explicit, project and `--global` targets, bounded TOML edit with comment preservation, identity reuse and creation, partial-failure reporting, dry-run, rerun idempotence, uninstall preservation.
3. **Installed adapter mode** (after open questions 1–2): `codex-stop --installed`, updating [packaged-native-hook.md](packaged-native-hook.md) in the same docs-first way. Checks: state derivation, first-Stop budget per the decision, eligibility per the decision, all existing guards, cwd resolution for user-wide.
4. **Hook install/uninstall and doctor checks.** Checks: hook entry ownership and replacement, trust shown as unknown or from `hooks/list`, next-step text, native acceptance in a disposable Codex home with normal trust.

#582 and #583 start from slices 1–2's shared manifest, preview and result types, adding their own native-format verification.

## Historical questions, superseded by owner decisions

1. **May the first eligible Stop of an unknown session create its session budget** (cap 3, deadline, reentry rules unchanged) when the hook was installed by `pdb install codex`? The reviewed contract forbids it, and without it an installed hook never briefs.
2. **Which Codex Stop events may an installed hook treat as eligible?** Options: (a) every Stop with `stop_hook_active == false`, relying on Interrupt being a separate event and on the cap and deadline; (b) keep requiring proof of natural completion, which leaves installed hooks inert until Codex exposes a cause; (c) gather native evidence for error/budget/disconnect Stops first, as a bounded trial needing its own allowance.
