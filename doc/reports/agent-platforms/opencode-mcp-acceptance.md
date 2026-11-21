# OpenCode MCP acceptance (#254)

Status: **supported**, with one configuration defect and one environment limitation recorded below.
This is the OpenCode result for parent #25; it does not implement a wake-up adapter and changes no
runtime behaviour.

## Environment

| Item                  | Value                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Target client         | OpenCode `v2.3.0` (shared background service, `opencode service status` → `http://127.0.0.1:49374`)                   |
| OS / runtime          | macOS 27.2.1 (arm64), Node `v26.7.0`                                                                                  |
| PDB artifact          | this checkout's built `dist/mcp.mjs` (835,225 bytes), package `0.1.0`, source `f572f6d9`                              |
| Executable resolution | `node /Users/salimfadhley/workspace/github_triage/dist/mcp.mjs` (absolute path, no global install)                    |
| Researcher harness    | this OpenCode session; the model is recorded separately from the target client and is not inferred from an agent name |
| GitHub access         | existing authenticated `gh` session; read-only calls only                                                             |

## Checklist and results

| #   | Check                                   | Result        | Evidence                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Server startup and discovery            | **supported** | `opencode mcp list` → `✓ pdb connected`; the tool catalog gained `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_discussion`, `triage_events`                                                                                                          |
| 2   | Briefing (actions)                      | **supported** | `triage_briefing {repo, limit: 3}` → `status: complete`, `view: briefing`, 3 ranked actions, `presentation.bytes` 16,383 of a 16,384 budget with explicit `omitted` counts                                                                                               |
| 3   | Issue intake                            | **supported** | `triage_issue {number: 23}` → `status: complete`, `subject: {type: issue, number: 23}`, 5,331 bytes, no truncated fields                                                                                                                                                 |
| 4   | Dependencies                            | **supported** | `triage_dependencies {number: 23}` → `status: complete`, 4,343 bytes, `presentation.next: null`                                                                                                                                                                          |
| 5   | Discussion view                         | **supported** | `triage_discussion {limit: 3}` → `status: complete`, 4,711 bytes                                                                                                                                                                                                         |
| 6   | Repository briefing mode                | **supported** | `triage_briefing {mode: "briefing", last: "24h"}` → `view: repository-briefing`, `status: complete`, 16,040 bytes                                                                                                                                                        |
| 7   | Missing identity diagnostic             | **supported** | server launched without `--project`: `identitySource: "unresolved"`, `identityDiagnostic: "No local project is selected; the server launch directory was not consulted. Select a local startup project with --project PATH, or use an explicit local --agent override."` |
| 8   | Explicit agent override                 | **supported** | `triage_briefing {agent: "sandra_lopes", role: "implementer"}` → `identitySource: "tool"`, `agent: "sandra_lopes"`, no diagnostic                                                                                                                                        |
| 9   | Persistent local name and `triage_role` | **supported** | server launched with `--project <checkout> --entry opencode` → `identitySource: "entry"`, `entry: "opencode"`, `agent: "sandra_lopes"`, `triageRole: "implementer"`, `identityStore: "pdb"`                                                                              |
| 10  | Invalid input diagnostic                | **supported** | `triage_briefing {repo: "not-a-repo"}` → `Input validation error: … repo must be owner/name`                                                                                                                                                                             |
| 11  | Cancellation / protocol cleanliness     | **not run**   | this harness exposes no way to abort an in-flight MCP tool call; the server's own cancellation path is covered by its protocol tests, not by this client                                                                                                                 |

## Technical finding: `opencode mcp add` writes a shape this client ignores

`opencode mcp add pdb -- node …/dist/mcp.mjs --repo …` reports success and writes:

```json
{ "mcp": { "servers": { "pdb": { "type": "local", "command": ["node", "…/dist/mcp.mjs", "…"] } } } }
```

but the client reads the flat shape used by its own working entries (`mcp.<name>`), so
`opencode mcp list` still answered **"No MCP servers configured"** and no tools appeared. Moving the
entry to `mcp.pdb` made the server connect immediately and the tool catalog update in the running
session. This is a client-side defect worth a focused follow-up ticket; the workaround is to write
the flat shape.

## Environment limitation: the shared service is bound to one location

The background service reports `location.directory: /Users/salimfadhley`, so a project-scoped
`opencode.json` in another directory (a disposable `/tmp` checkout) is not loaded by it, and
`opencode api get /api/mcp --standalone` in that directory returned `data: []` even with a valid
config. The acceptance therefore used the global configuration temporarily, then restored it
byte-for-byte (`jq -S` diff identical) and confirmed the extra entries were gone from the file.

## Reproduce

```sh
# 1. Build the artifact this checkout ships
npm run build

# 2. Register the server in the flat shape the client reads
#    (mcp.<name>, not mcp.servers.<name>)
#    global config: ~/.config/opencode/opencode.json
#    { "mcp": { "pdb": { "type": "local",
#        "command": ["node", "<checkout>/dist/mcp.mjs", "--repo", "owner/name"] } } }

# 3. Confirm discovery
opencode mcp list            # expect: ✓ pdb connected

# 4. In a session, call the tools
#    triage_briefing {repo, limit: 3}
#    triage_issue {repo, number: 23}
#    triage_dependencies {repo, number: 23}
#    triage_discussion {repo, limit: 3}
#    triage_briefing {repo, mode: "briefing", last: "24h"}

# 5. Identity: launch with --project <checkout> --entry <key> and expect
#    identitySource "entry" with the recorded name and triageRole.
```

## Verdict

OpenCode is a **supported** MCP client for PDB's read-only surface: discovery, briefing, issue,
dependency, discussion and repository-briefing calls all returned complete, bounded results, and
identity resolution behaves as documented for unresolved, explicit and persisted cases. Two
follow-ups are worth filing: the `opencode mcp add` shape defect, and the fact that a project-scoped
config is not loaded by the shared service when it is bound to another location. Cancellation was
not exercised because this harness offers no abort surface for an in-flight tool call.
