# Claude Code HTTP MCP acceptance — 19 November 2026

Result for #395: **conditional, not full acceptance**. Real Claude Code consumed
the HTTP tools, both role briefings, issue detail and cached reads, and recovered
after the same endpoint's server restarted. The second public repository failed
because it exceeded the native engine's subject bound. Successful cross-project
and cross-client isolation therefore remain unverified.

## Environment and authority

- Native client: Claude Code **2.1.328**, macOS, first-party OAuth, reported model
  **claude-sonnet-5-5**. This was the actual CLI and its MCP tools, not an SDK
  substitute or a claim that Codex is Claude Code.
- Coordinator/report author: Codex. Claude Code executed the model/tool trial and
  supplied the native response evidence; the coordinator performed setup, one
  credential-free HTTP reproduction and cleanup.
- Server: source **6b89467670c142d42648dbe3d4a3e8a631e12cbf**, run with tsx on
  Node, bound to `127.0.0.1` and an OS-selected free port. This verifies that source
  service, not an npm installed-artifact acceptance claim.
- Two explicitly configured public repositories: this PDB repository and
  `cli/cli`. No local project/agent identity was fabricated.
- Owner explicitly authorized the bounded trial, approximately six short turns
  and no more than **USD 3 total**. Connection-only evidence from the earlier
  zero-model-turn test was not treated as tool acceptance.
- Disposable `CLAUDE_CONFIG_DIR`, `PDB_CONFIG_DIR`, strict per-invocation MCP
  configuration and no session persistence. Reused existing OAuth authentication
  through the child process environment; no credentials appear in this report or
  repository. Normal client settings and global serve registrations were not used
  as the test configuration or modified for it.

## Native procedure

Configure an isolated Claude MCP server named `acceptance`, type `http`, pointing
to the private server's `/mcp` endpoint. Use `--strict-mcp-config`, empty
`--setting-sources`, `--no-session-persistence`, `--output-format stream-json`,
`--max-budget-usd 3` and the existing authenticated native client. Only read tools
and an exact helper to restart the owned disposable server were allowed. No
permission bypass, GitHub mutation or change to the normal client config was used.

The requested `--max-turns 6` did **not** produce a six-turn result: Claude's
receipt reported **8 turns**, and eight assistant message events were recorded.
Do not describe that flag as a proven hard turn-count bound for this version.
No additional paid trial or blind retry was performed. The dollar receipt was
well below the separate authorized ceiling.

The actual native calls, in order, were:

1. `triage_briefing`: PDB repository, `role=implementer`, `limit=3`, `maxChars=3000`.
2. The same briefing for `role=designer`.
3. `triage_issue`: PDB repository, issue **1083**, `limit=2`, `maxChars=3000`.
4. `triage_briefing`: `cli/cli`, implementer, with the same small bounds.
5. Repeat call 1 with identical arguments.
6. Restart only the owned server, preserving its loopback address/port and
   explicit repository configuration. This was an allowed local helper call, not
   an MCP GitHub write or a restart of the user's normal PDB instance.
7. Repeat call 1 through the same still-running Claude client after restart.

## Results and limits

| Check                      | Observed result                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native discovery           | Claude reported the `acceptance` MCP server connected and discovered `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_discussion` and `triage_events`. Only the first two were exercised.                                                                      |
| Role selection             | Both implementer and designer calls succeeded and reported the requested used role.                                                                                                                                                                                             |
| Unattributed human read    | Agent remained null/unresolved; the GitHub human context was retained. No arbitrary configured agent was borrowed. The output disclosed that agent-focused attention/owned work was unavailable.                                                                                |
| Focused detail             | Issue 1083 returned as closed/completed, with bounded detail/section information and native dependency counts. No write occurred.                                                                                                                                               |
| Cache reuse                | Identical repeat returned the same ranked actions. The outer cache metadata reported `cached`, age 29 seconds, TTL 300 seconds. Nested report freshness still said `live`, age 0; do not read that inner field as evidence that GitHub was fetched again.                       |
| Restart recovery           | After the owned server restarted, the same native client successfully called the tool again without manual reconnect/configuration. The new response reported a live cache and observation after restart. Changes in live queue counts are not a deterministic fixture failure. |
| Second repository          | `cli/cli` returned `decision-engine-failed`, not a successful second-project view. No primary-project content was observed in that error, but this is insufficient to prove cross-project isolation.                                                                            |
| Cross-client isolation     | Not tested by this single-client run.                                                                                                                                                                                                                                           |
| Cancellation/notifications | Not tested.                                                                                                                                                                                                                                                                     |

Every briefing hit the existing **16 KB MCP response budget**; the action list was
limited to three and some sections were counts-only. The underlying PDB shortlist
was provisional (107 of 137 items not hydrated in the initial response). Do not
represent that as complete project intake. Project `pdb.rules.edn` was not loaded
because no local project was selected; custom local-rule resolution is not proved
by this run.

## Second-project failure diagnosis

One additional plain HTTP read, with **no model turn**, reproduced the error after
the native trial:

`GET /api/v1/briefing?repo=cli%2Fcli&role=implementer&limit=3`

It returned HTTP **500** with an `INTERNAL` error containing the actionable cause:
`experimental-scope-exceeded: at most 500 subjects are supported`. No fallback
scheduler ran. The native MCP error had hidden that specific limit behind generic
Datalog/dependency-diagnostic advice. This is an engine capacity limitation plus
an error-projection usability gap, not evidence that Claude failed to authenticate
or that ordinary reads should require an agent identity.

Complete the missing isolation acceptance using another explicitly selected,
supported-size project and separate client context, or deliberately change the
engine's capacity in its own reviewed scope. Do not raise the bound, silently
fallback, fabricate an agent or claim success merely to turn this trial green.

## Measured usage and cleanup

Claude's result was `success` for completing its requested test/report, with
`total_cost_usd=0.1746464`, **8 reported turns** and model usage:

- input: 12 tokens;
- cache creation: 36,044 tokens;
- cache read: 109,964 tokens;
- output: 1,945 tokens.

The model receipt identifies this as **list-price usage cost**, not an invoice or
proof of an incremental cash charge on the user's subscription. Preserve that
distinction when quoting the roughly USD 0.175 result.

The owned server was stopped after the HTTP reproduction. Private raw stream,
response and temporary settings artifacts stay outside the public repository;
this report contains selected outcomes and reproducible parameters, not a live
snapshot, credential or normal user configuration. The allowance question is
resolved, but #395 remains open for its unverified acceptance; this report must
not close it automatically.
