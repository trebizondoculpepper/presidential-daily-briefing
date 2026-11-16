# Presidential Daily Briefing

Presidential Daily Briefing turns GitHub issues, pull requests, review feedback and dependencies into a compact, evidence-linked action briefing. It helps coding agents and maintainers answer **“What should I do next to move this repository forward?”** without manually piecing together dozens of GitHub searches.

Visit [pdb.stodge.org](https://pdb.stodge.org/) for the story behind PDB, how it works, common use cases and a getting-started guide.

It is a global command-line tool: install it once with `-g`, not as a project dependency.

```sh
npm install -g @trebizondoculpepper/presidential-daily-briefing
```

## Why use it?

Finding work is more than listing open issues. A ready-looking ticket might still be blocked; a completed contribution might need another review fix; an old claim might need inspection. Repeatedly reconstructing that context wastes time and agent tokens, and makes important follow-ups easy to miss.

Presidential Daily Briefing collects the facts and applies explicit workflow rules so you can:

- Surface attention requests, PR follow-ups and active work before starting something new.
- Find eligible work and see which tickets would immediately unblock other work.
- Inspect a ticket, a dependency chain or a stalled PR in one operation.
- Catch inconsistent ticket state and see the evidence behind each finding.
- Get compact text for an agent or versioned JSON for other tools.

The same rules produce repeatable recommendations. Source links, freshness and missing-evidence notices let you check those recommendations rather than trust an unexplained score.

## Install

Install once globally and use the command across repositories. It does not need a separate npm installation in every project.

Requirements: **Node.js 26+**, npm and the [GitHub CLI](https://cli.github.com/). Presidential Daily Briefing reuses your authenticated `gh` session; it does not require a separate token store or hosted service.

```sh
npm install -g @trebizondoculpepper/presidential-daily-briefing

# Sign in if you have not already authenticated GitHub CLI.
gh auth login
gh auth status

pdb --help
```

Run `pdb` inside a repository checkout, or pass `--repo owner/repository` explicitly. Update the global installation with the same `npm install -g` command. Add `@next` to the package name only when you want a development prerelease.

This README describes the current repository version. Published releases may lag behind it; use your installed command's `--help` to confirm which features are available.

## Examples

### Find the next useful action

```sh
pdb --repo owner/repository
```

The briefing groups attention, PR follow-up, active work and eligible pickup. General pickup defaults to urgency and immediate-unlock impact; explicit age ordering is available for backlog cleanup:

```sh
pdb --repo owner/repository --agent your-agent-name
pdb --repo owner/repository --order oldest
```

`--agent` is an explicit workflow identity, not your GitHub login. It highlights attention addressed to that name and recorded ownership; it does not authenticate an agent or claim work.

A new agent gets its own identity once, from the checkout, with:

```sh
pdb setup identity --role implementer        # or --role designer; --dry-run previews
```

It generates a locally unique name for your harness's entry in the checkout's Git-ignored `pdb.toml`, keeps it on later runs, never reuses another harness's entry (under Ori, add `--entry ori.SERVER`), contacts no service and prints the `--agent` to use.

### Inspect a ticket or a blocked PR

```sh
# Full ticket intake, including discussion and dependency evidence.
pdb --repo owner/repository --issue 42

# Native upstream/downstream dependency tree.
pdb deps 42 --repo owner/repository --tree

# Checks, review findings, conflicts and other PR blockers together.
pdb pr 17 --repo owner/repository
```

### Catch up and check repository health

```sh
pdb briefing --repo owner/repository --last 24h
pdb briefing --repo owner/repository --checkpoint ~/.config/pdb/owner-repository.json
pdb --repo owner/repository --since 2026-11-01T09:00:00Z
pdb ticket-doctor --repo owner/repository
pdb team --repo owner/repository
```

`briefing` reports owner attention, completed and disposed work, progress, blockers and current activity for a window (`--last`, `--since` or `--checkpoint`, default 24 hours). A checkpoint advances only after a complete live report is delivered; `--offline --cache PATH` replays a saved window and never advances one. Ticket Doctor reports inconsistencies without repairing them. Team activity reflects recorded claims and recent evidence; it does not prove an agent is online.

### Use structured output

```sh
pdb --repo owner/repository --json
```

Reports include completeness and collection timestamps. For briefing commands, exit `0` means complete evidence, `2` means incomplete evidence, and `1` means invalid arguments or an operation failure. Incomplete evidence never means approval or “nothing to do.”

### Preview a workflow update

```sh
pdb claim 42 --repo owner/repository \
  --agent your-agent-name --dry-run
```

### Hand over finished work

```sh
pdb submit 42 --repo owner/repository \
  --agent your-agent-name --pr https://github.com/owner/repository/pull/17 --dry-run
pdb complete 42 --repo owner/repository --agent your-agent-name --dry-run
```

`submit` records the pull requests the issue requires, then releases only your claim and sets `status:awaiting-review`; you stay responsible for following up on those PRs without holding a claim. `complete` later verifies delivery from fresh evidence before closing the issue.

Briefings and diagnostic commands are read-only. Explicit commands such as `claim`, `submit`, `complete`, `needs-human` and `deps add/remove` change GitHub; inspect their help and dry-run output before applying changes. Claiming means current work, with one active claim per agent.

## MCP server (read-only)

The package also installs `pdb-mcp`, a stdio MCP server exposing read-only tools over the same services as the CLI: `triage_briefing`, `triage_issue`, `triage_dependencies` and `triage_events`. Each returns readable text plus a versioned envelope. `triage_briefing`, `triage_issue` and `triage_dependencies` return a bounded version-2 envelope (#266): the whole result stays within 16,384 bytes, `data` carries a summary selected from the CLI's `--json` report, and `presentation` lists omitted rows, shortened fields and the next page. `triage_issue` takes `section` (`summary`, `body`, `discussion`, `pullRequests`) with `offset`/`limit`; `triage_dependencies` takes `offset`/`limit`. Full intake stays on the CLI (`pdb --issue N --json`, `pdb deps N --tree --json`). `triage_briefing` with `mode: "briefing"` (and `since` or `last`, default 24h) returns the repository-wide `briefing` report; it never reads or advances a checkpoint. It never changes GitHub. Contract: [doc/design/mcp.md](doc/design/mcp.md).

Polling is off by default. `pdb-mcp --repo owner/name --poll [--poll-interval-minutes N]` (default 30) polls that one repository only while the server runs and records deduplicated events (attention requested, review feedback, verification problems, PR follow-up candidates, newly eligible work) that `triage_events` reads with an opaque cursor. The first complete poll is a silent baseline; failed or incomplete polls never replace it. History holds at most 1,000 events or 24 hours, lives only in that process and is lost on exit; each polling process polls separately. Events are inspection candidates, not wake-ups, claims or approval. Contract: [doc/design/polling-events.md](doc/design/polling-events.md).

Generic stdio configuration (install globally first; nothing registers a host automatically):

```json
{ "command": "pdb-mcp", "args": ["--project", "/absolute/project/path"] }
```

`--repo owner/name` and `--agent NAME` set defaults; a tool's own `repo`/`agent` arguments win for that call. Without an agent, the server reads (never writes) the persisted `name` of an `[agents.KEY]` entry in the project's root `pdb.toml` (or, until that entry is imported, a matching legacy `agent-inbox.toml` entry, reported as `selection.identityStore: "legacy-not-imported"`), chosen by `--entry KEY`, else `--harness NAME`, else the MCP client (Ori's `ori-SERVER` client selects `ori.SERVER`), else the harness detected from the environment. `selection.identitySource` reports which of `tool`, `startup`, `entry`, `harness`, `client`, `environment` decided; when none does, the read is unfocused (`unresolved`) and `selection.identityDiagnostic` says why and how to fix it. Client roots remain follow-up work (#25); no external identity service is required.

Claude Code (temporary workaround for #266, kept until the bounded results pass the real-client retest): with older releases, the default `triage_briefing`, `triage_issue` and `triage_dependencies` results can exceed Claude Code's default MCP output limit of 25,000 tokens ([Claude Code documentation](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings), accessed 14 November 2026). Start Claude Code with a larger limit, for example `MAX_MCP_OUTPUT_TOKENS=60000 claude`. This is interim only; the fix is the bounded response contract in [doc/design/mcp-bounded-results.md](doc/design/mcp-bounded-results.md).

## Local server: `pdb serve`

`pdb serve` runs a foreground local HTTP server from the same package: a read-only JSON API and HTTP MCP over one short-lived memory cache, so several agents on one machine share collected GitHub facts instead of each collecting them. It uses your authenticated `gh`, writes nothing to disk and never changes GitHub. Stop it with Ctrl-C; a restart clears the cache.

```sh
pdb serve --project /absolute/project/path        # or --repo owner/name; both repeatable
pdb serve --repo owner/name --port 0 --ttl 10m   # 0 picks a free port; TTL 1m to 10m, default 5m
```

The first stdout line is `pdb serve VERSION listening on http://127.0.0.1:4372/`. At least one `--repo` or `--project` is required: the working directory is never used to choose a repository. It listens on 127.0.0.1 only unless `--host` names another address together with `--allow-remote`, which prints a warning: there is no authentication, and anyone who can reach the server can read what your gh login can see. Loopback binding does not keep out other users of the same machine. Requests whose `Host` or `Origin` does not name this server are refused (DNS-rebinding protection), and a busy port exits 3 instead of picking another one.

| Route                                                                        | Result                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/v1/briefing?role=implementer`                                      | The CLI's `--json` briefing (`agent`, `role`, `order`, `since`, `limit` as on the CLI)               |
| `GET /api/v1/issues/N`, `/issues/N/deps`, `/issues/N/who`, `/prs/N`, `/team` | The CLI's `--issue N`, `deps N`, `who N`, `pr N`, `team` JSON                                        |
| `POST /api/v1/refresh` with `{"repo": "owner/name"}`                         | Drops cached entries; the next read collects live                                                    |
| `GET /api/v1/status`, `GET /healthz`                                         | Server status and cache counters; liveness                                                           |
| `/mcp`                                                                       | HTTP MCP: the same four read-only tools as `pdb-mcp`                                                 |
| `GET /`                                                                      | Read-only dashboard: choose a project and role to see the ranked next steps                          |
| `GET /api/v1/diagnostics/{projects,config,cache,inflight,errors,rules}`      | The server's own state: settings, cache, running collections, recent failures, rules; never collects |

Every data route wraps the unchanged CLI JSON in an envelope with `selection` and `freshness` (`source` is `live`, `cached` or `stale`, with `observedAt` and `ageSeconds`). `refresh=true` on any read bypasses a fresh entry. If GitHub fails, a result observed within the last 30 minutes is served as `stale` and `incomplete`, never as complete; otherwise the route answers 502 with the CLI command that inspects the same read. MCP results of `triage_briefing`, `triage_issue` and `triage_dependencies` carry the same block as `freshness.cache`; `triage_events` keeps its version-1 envelope, with no cache block.

HTTP MCP configuration (verified with Claude Code 2.1.325 on macOS; see [doc/reports/serve-http-mcp-acceptance.md](doc/reports/serve-http-mcp-acceptance.md)):

```sh
claude mcp add --transport http pdb http://127.0.0.1:4372/mcp
```

```json
{ "type": "http", "url": "http://127.0.0.1:4372/mcp" }
```

`pdb-mcp` over stdio is unchanged and needs no server. Contract: [doc/design/serve.md](doc/design/serve.md).

## Repository settings and sizing

Use the configuration commands from the target checkout instead of editing configuration files directly:

```sh
pdb config list
pdb config help
pdb estimate --help
pdb estimate --help --metric impact
```

Complexity is enabled by default, with bundled XS–XXL guidance. Sizes are repository labels `complexity:XS`–`complexity:XXL`: `estimate N --size S --rationale TEXT` creates the requested label if missing, replaces other size labels and records provenance in a comment, and the briefing's estimation queue reads the labels with no setup. Repository calibration remains repository-specific. Disable the feature with `pdb config set complexity.enabled false`.

See the [usage guide](doc/usage.md) for estimates, workflow mutations, caching and offline reports.

## Contribute

Maintained application code is TypeScript. From a source checkout:

```sh
npm ci
npm run pdb -- --repo owner/repository
npm run check
npm test
npm run build
```

The workflow rules are native DataScript EDN files in `src/rules/datalog/policy/`. After editing them, run `npm run rules:test` for a fast rules-only check against the EDN scenarios in `src/rules/datalog/scenarios/`, then `npm run rules:build` and the full checks. [AGENTS.md](AGENTS.md#editing-the-rules) has a worked example and [the rules component contract](doc/design/rules-component.md) the details.

The exhaustive formal-comprehension research validator is manual/local only: `npm run test:manual:formal`. Run it when changing the formal research representation or preparation/scoring, or regenerating experiment inputs after relevant policy changes. It is excluded from normal unit-test/CI discovery and does not replace `rules:test` or the product tests. See the [experiment procedure](doc/reports/formal-rules-comprehension-experiment.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and the [design index](doc/design/README.md) for architectural contracts and planned capabilities. Tests use injected boundaries and fixtures rather than live GitHub credentials.

## License

[MIT](LICENSE).

Complexity is stored in repository labels (`complexity:XS`–`complexity:XXL`); no setup is needed. The native-field `setup complexity` command and the `complexity.fieldId` setting were removed (#153); an old configuration file that still contains the key keeps working, and `config list` shows how to drop it. See the [contract](doc/design/complexity-estimation.md). No field migration or separate field permissions are needed.

### Datalog queues

Datalog is the default read-only next-action engine. The default view is implementer; select designer explicitly for design work:

```sh
pdb --role implementer --json
pdb --role designer
```

Actions and their reasons are derived from the same bundled rules. Structured output includes engine/policy provenance, matched explanation bindings and diagnostics. An omitted role uses the implementer view and reports that choice; explicit roles win. This does not infer identity or change mutation safeguards. TypeScript remains available as an explicit rollback. Roll back with `pdb config set briefing.engine typescript`.

MCP reads the setting only from its explicitly selected matching project (`pdb-mcp --project /path/to/checkout`). A different requested repository does not inherit that project's setting. Full ticket intake and repository catch-up remain on their existing services. Invalid repository configuration or evaluator failure produces a diagnostic rather than a silently substituted Datalog result.

## Upgrading from GitHub Triage

The product and primary commands are now Presidential Daily Briefing, `pdb` and `pdb-mcp`. The old npm package was removed by its owner. If an old global copy remains installed locally, replace it after verifying the new package is available:

```sh
npm uninstall -g @trebizondoculpepper/github-triage
npm install -g @trebizondoculpepper/presidential-daily-briefing
pdb --help
```

Old executable names remain compatibility aliases in the new package. Existing `triage_*` MCP tool names, repository settings, `triage_role` and hidden workflow-receipt identifiers remain compatible. `PDB_NO_UPDATE_CHECK=1` is the primary update-check opt-out; `GITHUB_TRIAGE_NO_UPDATE_CHECK=1` is still accepted. Historical reports retain their original names and references.

For opt-in native continuation prototypes, see [the shared rebrief core](doc/rebrief.md) (`pdb rebrief --help`). It does not install a hook or start a model.

## Crash reporting

PDB reports unhandled Node crashes to the project's Sentry service by default. Reports
contain fixed error text, public PDB source locations, mode and installed version, not
original error messages, ticket content or configuration. The receiving service can see
network metadata such as source IP. Ordinary handled command errors are not reported.

Set `SENTRY_DISABLED=1` to disable immediately, or create `crash-reporting.toml` in the
user configuration directory printed by `pdb --help` with:

```toml
[telemetry.crashes]
enabled = false
```

Restart running PDB processes after changing the file. The setting applies to the whole
process, including shared servers; repository settings cannot override it.
