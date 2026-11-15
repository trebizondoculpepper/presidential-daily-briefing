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

## Restart recovery: passed

A second run on `main` at `49ecaf6` (macOS, Claude Code 2.1.325, default settings), with the server on port 4380 and the client configured as `{"type":"http","url":"http://127.0.0.1:4380/mcp"}`. Times are UTC on 2026-11-15.

| Time     | Step                                                        | Result                                                                                              |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 00:21:45 | Server started                                              | Listening                                                                                           |
|          | `triage_issue` with `number: 373`                           | Complete; `freshness.cache.source` `live`, `observedAt` 00:21:52.920Z                               |
| 00:22:25 | SIGINT                                                      | `shutting down`, then `stopped`                                                                     |
| 00:22:26 | A new server process started on the same port               | Listening                                                                                           |
| 00:23:13 | `triage_issue` with `number: 373`, same Claude Code session | Succeeded on the first attempt with no retry; complete; `source` `live`, `observedAt` 00:23:13.641Z |

The client recovered from the restart without being reconfigured or restarted. The second read was `live` as expected: a restart clears the memory-only cache.

## Conclusion

Claude Code connects to `pdb serve` over Streamable HTTP with default settings, calls the read tools, and sees the cache freshness go from `live` to `cached` on a repeat call. It also recovers transparently when the server is stopped and restarted on the same port. The HTTP MCP configuration example in the README and `pdb serve --help` is therefore marked verified.

## Not covered

- Linux, Windows and other MCP clients were not tested.
