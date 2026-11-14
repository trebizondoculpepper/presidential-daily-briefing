# `pdb serve` HTTP MCP real-client acceptance (#373)

Real-client verification required by [serve.md "Testing and acceptance"](../design/serve.md#testing-and-acceptance). The coordinator ran it and reported the results; this report records them as they were reported.

## Setup

| Item                 | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Date                 | 2026-11-14                                                                                   |
| Platform             | macOS                                                                                        |
| Build                | `38ea4e4` (docs/373-serve-docs, which contains PRs #435, #438 and #439)                      |
| Client               | Claude Code 2.1.325, default settings                                                        |
| Server               | `node dist/cli.mjs serve --repo trebizondoculpepper/presidential-daily-briefing --port 4372` |
| Client configuration | `{"type":"http","url":"http://127.0.0.1:4372/mcp"}`                                          |

## Results

| Step                                         | Result                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `triage_briefing` with `role: "implementer"` | Succeeded; `freshness.cache.source` `live`, age 0 s                                        |
| The same call again                          | Succeeded; `cached`, age 3 s, same `observedAt`                                            |
| `triage_issue` with `number: 373`            | Succeeded; `live`                                                                          |
| `GET /api/v1/status` afterwards              | Cache `entries: 2`, `hits: 1`, `misses: 2`, `mcpSessions: 1`; `exposed: false`             |
| SIGINT                                       | Printed `pdb serve: shutting down (Ctrl-C again to exit now).`, then `pdb serve: stopped.` |

## Conclusion

Claude Code connects to `pdb serve` over Streamable HTTP with default settings, calls the read tools, and sees the cache freshness go from `live` to `cached` on a repeat call. The HTTP MCP configuration example in the README and `pdb serve --help` is therefore marked verified.

## Not covered

- Recovery after stopping and restarting the server, which the contract's real-client step also names, was not reported in this run.
- Linux, Windows and other MCP clients were not tested.
