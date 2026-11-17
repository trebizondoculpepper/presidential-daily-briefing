# Presidential Daily Briefing rollout verification (#320)

## Current verification: 2026-11-17

Checked source `b0d580dcc0946d8820cfa040b0b4ea637930f0bd` and the published
`@trebizondoculpepper/presidential-daily-briefing@0.12.0`, whose registry gitHead is
`3309475545177c1cdd2bca0dc097d3f6ec629103`. The earlier 0.9.0 observations below
remain historical. The installation and live-read checks publish nothing and do not change GitHub
work items or permissions. Existing command installations and checkout identities
remain unchanged; verification uses disposable prefixes and Git checkouts.

| Check                    | Observed result                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical repository     | GitHub resolves the canonical slug and immutable repository ID; package repository, homepage and bugs URLs use that slug.                                                                                                                                                                                                                                                              |
| Registry                 | `npm view …@latest` reports 0.12.0, both canonical bins and the two compatibility aliases. Metadata and tarball installation succeed. The npm HTML page returns 403 to automated fetches; no browser-rendering claim is made.                                                                                                                                                          |
| Global installation      | `npm install -g --prefix TEMP …@0.12.0` succeeds; installed CLI and MCP help identify `pdb` and Presidential Daily Briefing. The existing machine installation is untouched.                                                                                                                                                                                                           |
| npx                      | `npx --yes --package …@0.12.0 pdb --help` succeeds. The README now shows the explicit executable form.                                                                                                                                                                                                                                                                                 |
| Published identity flow  | In a disposable matching Git checkout, `pdb setup identity --role implementer --entry codex.rollout-check --repo REPO --json` creates an ignored `pdb.toml`; repeating it preserves the exact name and reports no change. Its emitted next commands use `pdb`.                                                                                                                         |
| Published live briefing  | The installed 0.12.0 executable returns complete schema-2 JSON for this public repository with the disposable identity and explicit role. It also exits 0 inside the current checkout with its real `.github/triage.toml`; the earlier 0.9.0 configuration failure is not reproduced. No claim or assignment is made.                                                                  |
| Source checks            | `npm run check` passes with zero errors (54 existing warnings); all 144 test files pass, 2,649 tests pass and one is skipped. Build, smoke and package tests pass.                                                                                                                                                                                                                     |
| Current source first use | In a separate disposable matching checkout with controlled supported-session signals, a normal live briefing with `--role implementer` creates an identity and reports creation on stderr and in JSON. A second invocation omits agent, entry and role, reuses the exact name and leaves `pdb.toml` byte-identical. Both exit 0 and report the current authenticated human separately. |
| Published MCP            | An SDK client completes a real stdio handshake with installed `pdb-mcp` 0.12.0; the server names itself `pdb`, lists all four read-only tools and returns a version-1 events envelope.                                                                                                                                                                                                 |
| Links                    | All relative links in README (15), practical usage (21), AGENTS (9), release instructions (2), CONTRIBUTING (8) and the CLI proposal (11) resolve. GitHub resolves publicly; `pdb.stodge.org` returns HTTP 200. Example `owner/repository` URLs are placeholders.                                                                                                                      |

Current source has automatic identity (#677), including local server startup and
read-only request boundaries. Published 0.12.0 predates that change and retains
its explicit setup/agent flow. README and practical usage now state that version
boundary instead of implying the registry already contains newer source. The
old 0.9.0 configuration/identity limitations below are not current 0.12.0 findings.
No new release is required or authorized by this audit.

## Current occurrence classification

Applied the eight-category [approved rename map](../design/pdb-rename.md). The
active scan covered application/helpers, package manifests, README, AGENTS,
practical usage, CONTRIBUTING, the CLI design entry point and release guidance. Historical
reports, diary entries and inherited design evidence were reviewed as history,
not mass-replaced. No persisted record, compatibility alias or original
attribution was rewritten.

| Category            | Classification and result                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code symbols        | Neutral `triage` domain/module symbols remain valid. No product symbol rename is required.                                                                                                                                                                                                                                                  |
| Import paths        | Existing module paths and generated `.js` specifiers remain unchanged; all checked documentation links resolve.                                                                                                                                                                                                                             |
| Filesystem paths    | Compatibility configuration/cache locations remain unchanged. Fresh identity checks use ignored `pdb.toml`.                                                                                                                                                                                                                                 |
| Serialized keys     | `github-triage:*` receipts, `triage_*` MCP tools, `triage_role` and schema versions are preserved protocol contracts.                                                                                                                                                                                                                       |
| CLI commands        | `pdb` and `pdb-mcp` are primary. Old bins remain compatibility aliases; uninstall guidance names the old package intentionally.                                                                                                                                                                                                             |
| User-facing strings | Current install/help/recovery guidance uses the canonical names. Stale practical-usage claims that automatic identity and MCP remain planned were corrected. The inherited CLI proposal now points readers to current usage; CONTRIBUTING uses the canonical issue URL and records the existing review gate and completed adaptation audit. |
| Tests and fixtures  | Existing protocol fixtures and alias assertions remain compatibility coverage. Packaged/source checks validate the canonical executables.                                                                                                                                                                                                   |
| Logs and telemetry  | `PDB_NO_UPDATE_CHECK` is primary; `GITHUB_TRIAGE_NO_UPDATE_CHECK` remains an accepted alias. Historical receipts and diagnostics retain their recorded identifiers.                                                                                                                                                                         |

The MIT license's original holder wording remains legal attribution. The owner's
subsequent contributor-name/GPL decision and the DataScript compatibility work are
tracked separately in #634; this branding audit does not settle or implement that
license transition. The previous owner's question on #320 is recorded resolved.

## Historical verification: 2026-11-15

Checked on 2026-11-15 against `main` at 0512f20 and the published package
`@trebizondoculpepper/presidential-daily-briefing` 0.9.0 (gitHead `c36e42c`), following
[the rename contract](../design/pdb-rename.md). Read-only: nothing was published, no GitHub
state was changed, and no credentials were printed.

## Results

| Check                         | Result                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry metadata             | 0.9.0 is `latest`; `repository.url` and `homepage` point at `trebizondoculpepper/presidential-daily-briefing`; bins `pdb`, `pdb-mcp` plus the migration aliases.                                                                                                                                                               |
| Global install                | `npm install -g …@latest` installs `pdb` and `pdb-mcp` (and the two aliases); `pdb --help` leads with `pdb`.                                                                                                                                                                                                                   |
| npx                           | `npx -y -p @trebizondoculpepper/presidential-daily-briefing pdb --help` works. The bare form `npx @trebizondoculpepper/presidential-daily-briefing` fails ("could not determine executable to run") because no bin matches the package name. The README documents only global install, so nothing advertises the failing form. |
| Live read-only briefing       | `pdb --repo trebizondoculpepper/presidential-daily-briefing --agent NAME` (0.9.0, outside a checkout) returns the implementer next steps.                                                                                                                                                                                      |
| Briefing inside this checkout | **Fails with 0.9.0**: `.github/triage.toml` now declares `review.policy` (#301), which 0.9.0 does not know, so it refuses the whole configuration and advises restoring the file from Git (#568). Current source handles it.                                                                                                   |
| Identity flow                 | The README now documents `pdb setup identity` (#314, merged after 0.9.0). The published package does not have it yet; current source does.                                                                                                                                                                                     |
| README links                  | All 13 relative links resolve; external links resolve except an `owner/repository` example placeholder.                                                                                                                                                                                                                        |
| Checks                        | `npm run check`, `npm test`, `npm run build`, `npm run smoke` pass on `main`.                                                                                                                                                                                                                                                  |

The two failures inside a checkout are the same cause: the documentation and repository
configuration on `main` are ahead of the last published release. They are resolved by the next
release, which needs the owner's explicit release request (`npm run release`); a merge does not
publish. #568 additionally tracks making an older `pdb` say that the configuration is newer than
it, instead of advising a revert.

## Remaining legacy references, classified

Every remaining `github-triage` / `GitHub Triage` reference falls into a category the rename
contract preserves or marks historical:

| Where                                                                 | What                                                                                                                                                                                       | Classification                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `package.json` `bin`, `scripts/package-test.ts`                       | `github-triage`, `github-triage-mcp` aliases                                                                                                                                               | Migration aliases, never advertised as primary (contract: CLI commands).                  |
| `src/**`, `doc/design/**`, `doc/usage.md`, `doc/pdb-cli.md`           | hidden `github-triage:*` record markers (`delivery`, `needs-human`, `release`, `claim`, `claim-activity`, `question-resolution`, `impact-estimate`, `complexity-estimate`, `issue-create`) | Serialized protocol identifiers; preserved (contract: serialized keys).                   |
| `src/updates`, README                                                 | `GITHUB_TRIAGE_NO_UPDATE_CHECK`                                                                                                                                                            | Legacy environment alias, still accepted (contract: logs and telemetry).                  |
| README "Upgrading from GitHub Triage"                                 | old package name in the uninstall step                                                                                                                                                     | Migration guidance for old installs.                                                      |
| `HANDOFF.md`, `doc/poker-blocks-process.md`, `diary/`, `doc/reports/` | old product name                                                                                                                                                                           | Historical evidence, already marked historical.                                           |
| `LICENSE`                                                             | "Copyright (c) 2026 GitHub Triage contributors"                                                                                                                                            | Legal holder text: left unchanged; renaming the copyright holder is the owner's decision. |
