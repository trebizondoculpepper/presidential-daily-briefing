# Codex MCP acceptance (#252)

Recorded 2026-11-14 UTC against the installed archive built from `c1e56fb` (current main, including #266). **Verdict: conditional.** The real Codex app-server MCP client discovers all four tools and completes representative read calls with bounded results. Configure `--entry codex` or `--harness codex` for persistent identity: automatic selection from this client's metadata is unresolved (#402).

This is a direct-call acceptance run through Codex's app-server API, without a model turn. It establishes actual Codex MCP transport, discovery and read behavior, but does not establish model-visible rendering, token usage, interactive UI behavior, or other clients' acceptance. Parent #25 remains open; this conditional result is not a universal pass.

## Provenance

| Item            | Value                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target          | Codex CLI/app-server `0.169.0`, `/opt/homebrew/bin/codex`; real `mcpServerStatus/list` and `mcpServer/tool/call` API                                                         |
| Researcher      | Codex session, persisted name `priya_xu`; model identifier unavailable to the researcher. No target-client model was invoked                                                 |
| OS/runtime      | macOS 27.2.1, arm64; Node v26.10.0; authenticated `gh`                                                                                                                       |
| Package         | `@trebizondoculpepper/presidential-daily-briefing` 0.1.0; archive built by `npm pack` from `c1e56fb`, SHA-1 `8a9592bcf75ab8b1502f1f65f737f6e7eec17225`                       |
| Resolution      | Archive installed with `npm install --global --prefix` into a disposable prefix; absolute `bin/pdb-mcp` resolves to that prefix's scoped package `dist/mcp.mjs`              |
| Isolation       | Disposable `CODEX_HOME`, project Git directories and local identities. No personal host registration, credentials or auth files copied; no model authentication required     |
| MCP negotiation | Codex sent `initialize`, protocol `2025-06-18`, client name `codex-mcp-client`, title `Codex`, version `0.169.0`; server returned that protocol, name `pdb`, version `0.1.0` |

All acceptance tool calls were read-only. Ticket claims and the ownership correction during orchestration were separate from acceptance calls. Test configs, raw wire logs, session IDs and transcripts are excluded from this report.

## Results

| Check                         | Result                       | Evidence                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup/discovery             | supported                    | Codex reported `runtimeStatus: connected`, `toolsError: null`; exactly `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_events`                                                          |
| Default action briefing       | supported                    | Complete; serialized CallToolResult 15,974 bytes; explicit omission counts; no raised client output limit                                                                                                 |
| Issue #252                    | supported                    | Complete; 3,500 bytes; repository, subject and native dependency evidence returned                                                                                                                        |
| Missing issue #999999         | supported                    | Incomplete; 1,761 bytes; text explicitly warns against treating missing evidence as clean or eligible                                                                                                     |
| Dependencies #25              | supported                    | Complete; 6,360 bytes; ten relationships and an explicit next-page call                                                                                                                                   |
| Dependencies #25, tree        | supported                    | Complete; 6,354 bytes; first ten relationships, explicit next-page call. Full pagination was not traversed                                                                                                |
| Invalid repository `bad`      | supported                    | `isError: true`, 151 bytes; `repo must be owner/name`; no stack trace or local path                                                                                                                       |
| Repository briefing, last 24h | supported                    | Complete; 16,256 bytes; omissions and shortened fields declared                                                                                                                                           |
| Events without polling        | supported                    | Incomplete with explicit polling-disabled guidance; polling was not enabled                                                                                                                               |
| Persistent identity/role      | supported with configuration | `--harness codex`: `acceptance_codex_probe`, source `harness`, entry `codex`, role `implementer`; `--entry codex`: source `entry`, same name/role                                                         |
| Automatic identity            | conditional                  | `--project` alone: source `unresolved`, no supported harness detected. Codex client metadata is not currently recognized; #402 tracks investigation                                                       |
| Project/repository selection  | supported                    | Disposable project's origin selected the intended repository. With startup `--repo octocat/Hello-World`, a tool-level repo override selected this project's repository and its local identity             |
| Startup agent                 | supported                    | `--agent startup_probe`: source `startup`, entry/role null                                                                                                                                                |
| Tool agent precedence         | supported                    | Tool `agent: tool_probe` overrode startup agent; source `tool`                                                                                                                                            |
| Missing identity              | supported                    | Fresh Git directory without identity: unfocused read, missing-file diagnostic with ordinary config/setup recovery                                                                                         |
| Ambiguous identity            | supported                    | `codex` plus `codex.review`: unfocused read; both candidate keys named, no arbitrary selection                                                                                                            |
| Identity read-only            | supported                    | Identity contents and modification time unchanged across a fresh explicit-entry read                                                                                                                      |
| Protocol cleanliness          | supported                    | Captured server stdin/stdout were JSON lines only; no server stderr output observed. No test MCP/`gh api` child remained after normal exit                                                                |
| Cancellation                  | not-run                      | Generated app-server API offers direct tool calls but no corresponding cancel request. No model turn was launched merely to exercise turn interruption; disconnect is not claimed as request cancellation |
| Content visibility/tokens     | not-run for model            | Direct API returned both `content` text and `structuredContent`. No inference about which reaches a model, UI truncation, or model token cost                                                             |

Byte counts are `Buffer.byteLength(JSON.stringify(response.result))`, including text and structured content, without the outer app-server JSON-RPC envelope. All three read tools stayed below the 16,384-byte server budget. `triage_events` retains its separate version-1 envelope. Source completeness and presentation omissions are distinct; a complete response does not mean all rows were presented.

## Reproducible checklist

1. Check out the commit under test; `npm ci`, `npm pack`, then install that exact archive into a disposable global prefix. Record the archive hash and executable resolution. Do not publish it.
2. Create a disposable Git project with this repository as its origin. In it, run the installed `pdb config set identity.triage_role implementer --entry codex` and `pdb config set identity.name acceptance_codex_probe --entry codex`. These commands create the local ignored file; do not hand-edit identity.
3. Create a disposable Codex home and register only the installed MCP bin in its `config.toml`:

   ```toml
   [mcp_servers.acceptance]
   command = "/absolute/disposable-prefix/bin/pdb-mcp"
   args = ["--project", "/absolute/disposable-project", "--entry", "codex"]
   ```

4. Generate the installed client's API types with `codex app-server generate-ts --out /absolute/scratch/schema`. Start `codex app-server --stdio` with the disposable `CODEX_HOME`. Send newline-delimited JSON-RPC requests, matching each response by ID:

   ```json
   {"id":1,"method":"initialize","params":{"clientInfo":{"name":"acceptance_probe","version":"1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
   {"method":"initialized"}
   {"id":2,"method":"thread/start","params":{"cwd":"/absolute/disposable-project","ephemeral":true,"approvalPolicy":"never","sandbox":"read-only"}}
   ```

5. Use the returned thread ID for `mcpServerStatus/list` (`threadId`) and `mcpServer/tool/call` (`threadId`, `server: "acceptance"`, `tool`, `arguments`). Do not call `turn/start`. Run the matrix above, recording only selection/status, result bytes and omissions. A protocol-only tee around the installed server can inspect initialization and framing without replacing the real Codex client.
6. Restart the isolated app server for startup variants: `--project` alone, `--harness codex`, `--entry codex`, explicit `--repo`, and `--agent`. Use a second disposable Git project for the missing identity. Add `codex.review` only with `pdb config set` to exercise ambiguity. Compare the identity's contents and modification time before/after read calls.
7. Close app-server stdin, await exit and inspect for remaining children. Remove disposable registration/config/logs after retaining sanitized evidence. Never publish raw transcripts, private identity/config files or session identifiers.

## Follow-up

[#402](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues/402) records automatic identity selection for `codex-mcp-client`. The existing resolver intentionally recognizes only verified client-name patterns, so any extension needs its own contract and focused implementation. Explicit entry selection is the working registration path today. A future model/UI acceptance run must report its own evidence separately.
