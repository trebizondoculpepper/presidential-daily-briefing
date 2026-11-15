# Presidential Daily Briefing rollout verification (#320)

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
