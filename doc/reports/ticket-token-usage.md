# Ticket-level agent token usage: initial research (#802)

Source SHA: main at the time of the PR. Research only: no PDB feature, telemetry or launch workflow changes here. The harness in [examples/token-usage](examples/token-usage/) is manual and local, reads only the researcher's own session transcript, and prints counts and provenance, never message content.

## Summary

For **Claude Code (interactive CLI)**, per-ticket token usage can be measured without a wrapper. A `pdb claim` run from the session's shell can see the session's identity in `CLAUDE_CODE_SESSION_ID`, and that session's local transcript records usage for every API response, with model and timestamp. Summing those responses between the claim and the submit or release gives a usage figure for the span. It is useful but not exact:

- **Concurrent work in one session is over-attributed.** One session often moves between tickets (claims retained while waiting, review fixes on another PR). A time window then counts all of them. This happened in the trial below. Exact attribution needs per-ticket span boundaries recorded at every switch, not only at claim and submit.
- **Output tokens are uncertain.** The Agent SDK documentation says per-step `output_tokens` is a placeholder captured at `message_start` and that the real output is reported only on result messages. In this transcript the per-response output counts look real, but that is an observation, not a documented guarantee.
- **Subagents are separate.** Their responses are marked `isSidechain` (and are excluded from SDK `usage` totals). They must be counted separately, never mixed into the main loop silently.
- **Session totals exist but do not give spans.** `cost-state` records carry per-model totals, including subagents and an estimated USD cost, written when the process exits. They can reconcile a whole session, not a ticket span. The USD figure is a client-side estimate, not billing.

Recommendation: a small, optional **Claude Code adapter**, not a launch wrapper. At claim, release, submit and claim-wait/resume, PDB records a span boundary with the session ID, if exposed. A local, opt-in reader then computes each span's usage from that session's own transcript and records only the counts with their provenance and completeness. Other platforms need their own verification tickets (matrix below). Nothing here should be implemented before a reviewed contract.

## Trial: what was exercised

- Platform and client: Claude Code 2.1.329, interactive CLI session (`CLAUDE_CODE_ENTRYPOINT` set, `CLAUDE_CODE_CHILD_SESSION=1` in this run), macOS 27.2.1.
- Model: `claude-opus-5-5` for the main loop. The session's `cost-state` also lists `claude-haiku-5-5` (helper and subagent requests).
- PDB agent `kavya_sabbagh`, employing human the signed-in gh account.
- Not exercised: the Agent SDK `query()` stream, `claude -p`, hooks, or any other platform.

Observations from the session transcript (`~/.claude/projects/<cwd>/<session>.jsonl`):

| Observation                                                                                         | Value                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CLAUDE_CODE_SESSION_ID` visible to a subprocess (the shell PDB runs in) and naming this transcript | yes                                                                       |
| Assistant records with a `usage` object                                                             | 7,187                                                                     |
| Distinct response IDs among them                                                                    | 3,712 (one response is split across several records with identical usage) |
| Records whose top-level counters agree with `usage.iterations[]`                                    | all records with both (0 differ)                                          |
| Output count varying between records of one response                                                | never (0 of 1,960 multi-record responses)                                 |
| Responses with 5 or fewer output tokens                                                             | 66 of 3,720                                                               |
| `cost-state` records (session totals, per model, written on exit or resume)                         | 6                                                                         |

Usage fields per response: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (split into 5-minute and 1-hour TTLs), `output_tokens`, `output_tokens_details.thinking_tokens`, `server_tool_use`, `service_tier` and `inference_geo`, with `requestId`, `message.model`, `timestamp`, `isSidechain` and `sessionId` on the record.

## Trial: a measured span

[`span-usage.ts`](examples/token-usage/span-usage.ts) dedupes responses by `message.id`, sums each response's counters (from `usage.iterations[]` when present) inside an interval, and reports main-loop and sidechain usage separately.

**#706's claim-to-release window** (15:12:44Z to 17:09:09Z on 20 November): 83 distinct main-loop responses, 180 uncached input tokens, 31,165,616 cache-read tokens, 84,383 cache-write tokens and 50,582 output tokens, all `claude-opus-5-5`, with no sidechain responses. **This over-attributes.** During that window the same session also fixed review findings on #1149 and #1157 while #706's probes ran, so the figure is the session's usage during the span, not #706's.

**#802's own span**, measured during the work from the claim (18:42:00Z) to the moment of measuring: 11 distinct main-loop responses, 24 uncached input tokens, 6,158,875 cache-read tokens, 21,934 cache-write tokens and 10,374 output tokens, with no sidechain responses. Fewer responses appeared than the tool calls made in that period, so **the transcript can lag behind the live session**. A reader run at submit time should wait for the transcript to settle, or record the span as incomplete and reconcile it later. It must never treat the shortfall as final.

## Proposed record (not implemented)

One boundary record per lifecycle event, plus a computed span, both append-only, keyed by an idempotent span ID:

```json
{
  "v": 1,
  "span": "<ticket>:<agent>:<claim-marker-id>:<n>",
  "ticket": "owner/repo#802",
  "agent": "kavya_sabbagh",
  "human": "github.com/<login>",
  "platform": { "client": "claude-code", "version": "2.1.329", "mode": "interactive" },
  "session": { "source": "CLAUDE_CODE_SESSION_ID", "present": true },
  "interval": { "start": "2026-11-20T18:42:00Z", "end": "…", "endEvent": "submit" },
  "usage": {
    "source": "claude-code transcript, deduplicated by message.id",
    "models": {
      "claude-opus-5-5": {
        "input": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "output": 0,
        "responses": 0
      }
    },
    "sidechains": { "responses": 0 },
    "outputReliability": "observed-not-documented"
  },
  "complete": false,
  "incomplete": [
    "interleaved work in the same session is included",
    "usage after the end event is excluded"
  ]
}
```

Rules: a missing counter or session ID is `unknown`, never 0. The session ID itself stays local and never goes into a public ticket (record only `present`). A span is reconciled at most once per boundary pair, so a retried submit cannot double-count. Estimated USD, if ever shown, is labelled as an estimate.

## Lifecycle cases

| Case                                      | Measurable?                             | Notes                                                                                                |
| ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claim, then submit in one session         | yes                                     | The trial                                                                                            |
| Release or interruption                   | yes                                     | The span ends at release; later usage belongs to the next span                                       |
| Claim-wait, then other work, then resume  | only with boundaries at wait and resume | Otherwise over-attributed (seen in the trial)                                                        |
| Switching tickets in one session          | only with per-switch boundaries         | The main source of error                                                                             |
| Resumed session (`--resume`)              | likely; not exercised                   | Same transcript; the SDK notes that resumed totals restore earlier spend, so read deltas, not totals |
| Compaction                                | unknown; not exercised                  | Summaries are API calls in the same session                                                          |
| Subagents and reviewers                   | yes, separately                         | `isSidechain`. Child agents in other sessions are unattributable without their own boundaries        |
| Concurrent agents on one account          | per-session only                        | Account-level subtraction is unreliable, as the ticket notes                                         |
| Transcript written after the reader runs  | not handled by a single read            | Seen in the #802 span; reconcile later and mark incomplete until then                                |
| Delayed usage events or duplicate records | handled                                 | Dedupe by message ID; responses timestamped after the end are excluded                               |

## Coverage matrix

| Platform and client | Mode                    | Status                                                              |
| ------------------- | ----------------------- | ------------------------------------------------------------------- |
| Claude Code         | interactive CLI         | **tested** (this trial)                                             |
| Claude Code         | `claude -p` / Agent SDK | untested: the SDK documents result-message `usage` and `modelUsage` |
| Codex               | CLI / `exec --json`     | untested: the ticket links its noninteractive event output          |
| Codex               | app-server              | untested                                                            |
| Antigravity         | interactive             | untested                                                            |
| Ori                 | own client              | untested                                                            |
| Ori                 | wrappers                | untested                                                            |
| Kilo                | interactive             | untested                                                            |
| OpenCode            | interactive             | untested                                                            |

Each untested row needs its own small verification ticket, run in that real client and recording the client, model, version, OS and evidence. Those tickets are filed after this report is reviewed, as #802 requires.

## Sources

- Claude Agent SDK, Track cost and usage: https://code.claude.com/docs/en/agent-sdk/cost-tracking. Deduplicate by message ID; per-step `output_tokens` is a placeholder; `usage` excludes subagents while `total_cost_usd` and `modelUsage` include them; USD is a client-side estimate; resumed sessions restore earlier spend.
- Claude Code session transcripts: https://code.claude.com/docs/en/sessions.md (where transcripts are stored).

## Reproduce

```
npx tsx doc/reports/examples/token-usage/span-usage.ts "$HOME/.claude/projects/<cwd-slug>/$CLAUDE_CODE_SESSION_ID.jsonl" START END
```
