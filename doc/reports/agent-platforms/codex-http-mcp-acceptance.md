# Codex HTTP MCP acceptance (#397)

2026-11-15 UTC, priya_xu, actual Codex implementer session on macOS. **Result:
conditional pass for the tested CLI/app-server HTTP surface.** Connection,
discovery, selection, role/identity, focused detail, shared-cache reuse and
same-client restart recovery were observed. Model/UI rendering, cancellation and
notifications remain untested; this is not a claim about every Codex surface.

## Target and isolation

| Item            | Observed target                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Build           | Source `635034f`, installed archive, package version `0.1.0`                                               |
| Archive SHA-256 | `a23ae0cb0695bdebffdee709139d1d164629d97664ab41fa3e66d362dbc07f96`                                         |
| Server          | Installed `pdb serve`, two explicit disposable `--project` roots, loopback, ephemeral port, 300-second TTL |
| Native client   | Real Codex CLI/app-server `0.169.0`, two isolated `CODEX_HOME` directories with HTTP URL registration only |
| OS/runtime      | macOS `27.2.1`, arm64, Node `26.10.0`                                                                      |
| Model           | Target thread metadata reported `gpt-6.1-sol`; no model invoked. Researcher's model identifier unavailable |
| Cost boundary   | Zero `turn/start` requests, model turns or live mutations; bounded GitHub reads only                       |

The archive was packed and installed globally into a disposable npm prefix. No
source loader was used by the server. Each client home contained only a temporary
`config.toml` naming the `/mcp` URL; no personal client config, authentication file
or hook was copied or changed. Inherited `CODEX_*` and `CLAUDE*` variables were
removed before launching clients and server. The existing authenticated `gh` was
used by the server for public-repository reads; credentials were never copied into
MCP configuration or results.

Two disposable Git projects had explicit origins:
`trebizondoculpepper/presidential-daily-briefing` (A) and
`octocat/git-consortium` (B). Installed `pdb config set` created ignored local
`pdb.toml` entries `codex`, with synthetic names `http_probe_a`/`http_probe_b` and
roles implementer/designer. These names were not registered or used to claim work.

An initial attempt used Hello-World as B. Its full collection was too large for a
bounded acceptance probe, so the server was deliberately stopped to abort it. The
resulting transport failures are not restart-recovery evidence. The completed
matrix below comes from a fresh bounded run with git-consortium (35 open issues,
14 open PRs at preflight). No model was used in either run.

## Observed matrix

Bytes are `Buffer.byteLength(JSON.stringify(response.result))`, including MCP
`content` and `structuredContent`, excluding the outer app-server response.

| Check                                                     | Outcome                                                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP connection and discovery, both native clients        | Connected; all four tools: `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_events`                                          |
| Startup cache                                             | Zero entries, hits, misses and MCP sessions; no eager collection                                                                              |
| A implementer briefing                                    | Complete, 15,796 bytes; `agent: http_probe_a`, `identitySource: client`, `entry: codex`, `triageRole: implementer`, rendered role implementer |
| A repeat briefing                                         | Complete, 15,798 bytes; `freshness.cache.source: cached`; same observation `17:51:22.821Z`, age four seconds, TTL 300 seconds                 |
| Focused issue #397                                        | Complete, 3,654 bytes; subject issue 397, correct project/identity, live cache entry                                                          |
| B designer briefing from second client                    | Complete, 15,493 bytes; repository B, `http_probe_b`, source client, persisted and rendered designer role                                     |
| Second client selects A with tool agent and designer role | Complete, 14,774 bytes; source tool, `http_tool_probe`, rendered designer, cached A facts                                                     |
| First client returns to A                                 | Complete, 15,800 bytes; still `http_probe_a`, source client, implementer; second caller's projection did not leak                             |
| Unserved repository                                       | Tool error, 960 bytes; `repository-not-served`, no fallback to a served project                                                               |
| Missing repo with two projects                            | Tool error, 989 bytes; `repository-unresolved`, no arbitrary default                                                                          |
| Cache after matrix                                        | Three entries, three hits, three misses, two MCP sessions, no in-flight reads; A briefing facts shared across clients/roles                   |
| Server restart at same URL, existing first client/thread  | First `triage_issue` call succeeded without caller retry or reconfiguration; complete, 3,654 bytes, live observation `17:51:45.725Z`          |
| Cache after restart                                       | One entry, zero hits, one miss, one MCP session; second repository unobserved, confirming memory reset                                        |
| Framing and cleanup                                       | Zero non-JSON app-server stdout lines; both clients and server stopped, no trial server/gh child remained                                     |

Restart observations were made in the same loaded Codex thread: no replacement
client, new thread, model turn or manual MCP reload was used. The two client homes
were separate; both talked to the same server. This checks projection/session
isolation, not authorization between machine users: `pdb serve` intentionally has
no authentication on loopback and the served-set guard is its repository boundary.

All nine completed native calls fit the 16,384-byte envelope. Briefing source
coverage was complete while presentation omissions were explicit: A returned six
ranked actions and declared four omitted; B returned eight and declared two
omitted. Other omitted lists were named in `presentation.omitted`; no truncated
fields or malformed JSON were observed. Focused detail had no presentation
omissions. Cache source is specifically `freshness.cache.source`; the underlying
collection's `freshness.source` remains `live` when those live facts are reused.
Do not mistake that collection field for a cache miss.

Project identity content remained the configured synthetic name/role and its
modification timestamp remained before server startup. Returned envelopes did not
contain either disposable project path or match GitHub-token/API-key/Bearer-token
patterns. This is a bounded exposure check, not a proof about every possible
repository payload. Raw results, session identifiers, private configuration and
local absolute paths are not published.

## Reproduction

1. At the named commit, run `npm ci`, `npm run build`, `npm pack --json
   --pack-destination ABSOLUTE_SCRATCH --ignore-scripts`. Install the exact archive
   with `npm install -g --prefix ABSOLUTE_PREFIX ARCHIVE --ignore-scripts`. Record
   its hash. This is not an npm publication.
2. Create two disposable Git roots with the explicit origins above. Use the
   installed binary in each root to set `identity.triage_role` and `identity.name`
   with `--entry codex`. Record identity content/hash and modification time; keep
   the generated files ignored. Choose bounded public repositories before reading.
3. Start installed `pdb serve --project ABSOLUTE_A --project ABSOLUTE_B --port 0`.
   Parse the actual port from its stable first banner line; check
   `GET /api/v1/status` for empty startup cache. Do not reuse a personal server.
4. In each fresh private client home, write only:

   ```toml
   [mcp_servers.acceptance]
   url = "http://127.0.0.1:ACTUAL_PORT/mcp"
   ```

   Launch real `codex app-server --stdio` with that `CODEX_HOME` and inherited
   harness variables removed. Generate its current protocol types locally with
   `codex app-server generate-ts --out ABSOLUTE_SCHEMA` before relying on fields.

5. Send JSON-RPC `initialize` with client info and `experimentalApi: true`, then
   `initialized`, then `thread/start` with a disposable cwd, `ephemeral: true`,
   `approvalPolicy: never`, `sandbox: read-only`. Save the returned thread ID
   privately. Never send `turn/start` for this matrix. Wait for
   `mcpServerStatus/list` on that thread to expose the four connected tools.
6. Use `mcpServer/tool/call` with the native `threadId`, `server: acceptance`, tool
   name and tool arguments. For example:

   ```json
   {
     "method": "mcpServer/tool/call",
     "id": 4,
     "params": {
       "threadId": "PRIVATE_ACTUAL_ID",
       "server": "acceptance",
       "tool": "triage_briefing",
       "arguments": {
         "repo": "trebizondoculpepper/presidential-daily-briefing",
         "role": "implementer"
       }
     }
   }
   ```

   Repeat A, request `triage_issue` with `number: 397`, select B/designer from the
   second client, then A/designer with `agent: http_tool_probe`. Return to
   A/implementer in the first client. Check structured selection, actual rendered
   role, completeness, omissions, encoded bytes and cache observation identity.
   Try an unserved repository and no repository; require structured refusals.

7. Read status counters. Gracefully SIGTERM the server, wait for exit, restart the
   same installed command on the same port. Call focused issue 397 through the
   existing first thread. Require a successful fresh observation and empty/new
   memory-cache counters, not merely a connection notification.
8. Stop both disposable app servers and the server; verify exits and no remaining
   trial children. Compare identity files. Retain sanitized outcomes only and
   remove the temporary client homes, projects, prefix and raw response files.

## Compatibility and limits

The existing full test suite and installed `npm run package-test` separately check
CLI, stdio MCP SDK round trips and CLI/MCP role parity. The earlier
[codex-mcp-acceptance.md](codex-mcp-acceptance.md) records actual Codex stdio
acceptance; this HTTP run neither replaces it nor claims a new stdio native run.

Not tested: model-visible text versus structured content, UI rendering/truncation,
model token cost, explicit native cancellation, notification/event delivery,
network interruption distinct from graceful server restart, TTL expiry/stale
fallback, multiple authentication contexts, Windows/Linux clients, or the human
role. Human-role schema exposure is not a native pass. Tools were discovered, but
this matrix invokes briefing and focused issue only; dependency/event execution
retains its separate acceptance evidence. Direct app-server calls do not supply a
native MCP-call cancel operation, so disconnect/transport failure is not called
cancellation. These explicit limits do not negate the observed base HTTP result.

Validation on the tested source: `npm run check` passed (zero errors, 51 existing
warnings), `npm test -- --maxWorkers=2` passed (2,232 tests, one existing skip),
`npm run build` passed, and `npm run package-test` passed, including installed CLI
smoke, stdio MCP round trip and role parity. These compatibility checks use
credential-free fixtures; they are distinct from the native live HTTP matrix.
