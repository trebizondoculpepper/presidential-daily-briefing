# Ori installer acceptance: packed install (#583)

Recorded 2026-11-21 (UTC) for `pdb install ori` / `pdb uninstall ori` (#772, contract `doc/design/attended-installer-delivery.md`). This is a packed-install check plus a real Ori client connection. No model turns were run (no cost), and the GitHub reads were read-only.

## Provenance

| Item     | Value                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client   | Ori `0.17.0-alpha+e81f15e`, `ori mcp test` (real stdio connection and tool listing; it does not invoke tools)                                                 |
| OS       | macOS 27.2.1 (arm64), Node v26.7.0                                                                                                                            |
| Package  | `npm pack` of `origin/main` `28502b9`, installed with `npm install --global --prefix <scratch>/prefix`, so the user's global npm was not touched              |
| Checkout | A disposable shallow clone of this repository; `PDB_CONFIG_DIR` pointed at a scratch directory; `pdb.toml` and `.ori/` were excluded locally, never committed |

## Results

| Check                                                            | Result      | Evidence                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First install in a fresh checkout, no `--entry`                  | **defect**  | Refused with `IDENTITY_REQUIRED`. Its `retry` (`pdb config set … --entry ori`) created `[agents.ori]`, and the next install refused again with the same retry: a loop. Fixed in this PR (below). |
| Dry run                                                          | supported   | Exact planned `mcpServers.pdb` entry shown; nothing written                                                                                                                                      |
| Apply                                                            | supported   | `.ori/mcp.json` with a `pdb` STDIO entry: packaged `dist/mcp.mjs`, `--project`, `--repo`, `--entry`                                                                                              |
| Rerun                                                            | supported   | `mcp (kept): already owned and current`                                                                                                                                                          |
| Real Ori connection                                              | supported   | `ORI_MCP_CONFIG=<copy outside the repository> ori mcp test pdb`: `outcome: connected`, tools `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_discussion`, `triage_events`      |
| Project file without approval                                    | as designed | `ori mcp test pdb` from the checkout: `skipped`, because a repository-declared server starts only after attended approval (ori-mcp-acceptance.md Finding 4). The installer's next steps say so   |
| Uninstall (dry run, apply) with an unrelated server in the file  | supported   | Only `pdb` removed; the unrelated `other` server and the file kept                                                                                                                               |
| Repeated uninstall                                               | supported   | `mcp (kept): already absent`                                                                                                                                                                     |
| User-edited owned entry (an added `--poll`) on uninstall/install | supported   | Both refused with `OWNED_ENTRY_EDITED`; the file was unchanged                                                                                                                                   |
| Identity and settings on uninstall                               | supported   | `pdb.toml` unchanged                                                                                                                                                                             |
| Native Stop hook                                                 | none        | Ori records no native Stop hook; none is installed or claimed. A watcher/headless-resume adapter is separate work                                                                                |

## Fix: the default Ori entry

The installer writes the server key `pdb`, so Ori's client name is `ori-pdb`, which maps to the identity entry `ori.pdb` (ori-mcp-acceptance.md). Without `--entry`, a project install now uses `ori.pdb` when the checkout has no Ori entry yet, or when `ori.pdb` is one of several. It never picks between other existing entries: it refuses, and the `retry` is a runnable `pdb install ori --entry <entry>`. Without `--role` a missing entry is not created, and the retry is `pdb install ori --entry ori.pdb --role implementer`.

## Not exercised

An attended Ori session approving the project `.ori/mcp.json`, and a model turn calling a tool through the installed entry. Both need a human-attended run, and the earlier real-turn acceptance is in ori-mcp-acceptance.md.
