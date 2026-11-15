# Human briefing: explicit questions, approvals and unblock actions

Contract for #457 (parent #42). Delivered: `src/briefing/human.ts` (record reading, trust and projection), the `D-HUMAN-*` decisions in `src/rules/datalog/policy/decisions.edn` with scenarios in `scenarios/human-briefing.edn`, and the shared `presentBriefing` path used by the CLI, MCP and `pdb serve`. The dashboard page #458 and the minimal HTTP MCP slice #390 consume the projection defined here; neither may build its own. Unresolved questions on closed tickets are #414 and are deliberately not duplicated here.

## Why

A human owner should be able to ask one question, "what input of mine is blocking progress?", and get the exact decisions, answers and sign-offs that agents are waiting for, with what each blocks and a link to the source. Today that input is buried among agent tasks in the implementer and designer queues, or not shown at all, because those queues rank what an agent can do.

## Role, not a separate scheduler

`human` is a third registered briefing role beside `implementer` and `designer`, selected the same way: CLI `--role human`, MCP `triage_briefing` `role: "human"`, and the `pdb serve` API `role=human`. All three call the shared read service (`readBriefing`/`presentBriefing`), so they return the same projection for the same snapshot, identity, limit and clock.

**The ranking lives in the Datalog policy.** The agent roles are already rule-derived (`src/rules/datalog/policy/*.edn`), and the human view's choices are policy of the same kind: which evidence makes an item, whether it is explicit or inferred, whether it is addressed to the viewer, and the order. Putting them in `decisions.edn` keeps one explainable, testable rule source (`rules:test` EDN scenarios), gives every item a rule ID and `why` text, and lets `pdb rules` (#416) render the human rules with the rest instead of documenting a hidden TypeScript scheduler. The engine's role guard gains `human`; the new decisions are guarded by `[1 "role" "human"]`, and the one existing unguarded agent decision (`D-INSPECT`) gains `(not [1 "role" "human"])` so pickup inspection never appears in the human view. Existing implementer and designer outputs are unchanged; only `rulesHash` changes, and the golden parity file records the new hash.

The host keeps only what it already keeps for delivery responsibility: reading and trusting comment records (I/O and the #212 permission check), turning them into facts, and projecting the engine's decisions into the item fields below. The host makes no ranking or explicit/inferred decision. The human role has no TypeScript-engine twin; `briefing.engine typescript` is a rollback for the agent queues only, and `decisionEngine` reports `used: "datalog"` for this role. If the evaluator fails, the read fails with the existing `decision-engine-failed` error; there is no silent fallback.

## Who the human is

The human is named by the explicit `agent` value of the request (CLI `--agent NAME`, MCP tool argument `agent`, API `agent`): the same name agents use in `attention:NAME` and in the `Designer:` routing of a needs-human record. It is routing focus, not authentication or authority. For the human role only an explicit request-level name is used. A persisted agent identity, harness detection, client metadata or environment detection names an agent, not a human, and is never borrowed; the GitHub login is never used either, because agents share it. Without an explicit name the view is unrouted: every item is still listed, none is marked addressed, and a notice says how to name the human.

## Evidence

The view uses only facts the briefing already collects (issue labels, the first page of comments, PR checks, reviews and Codex receipts, native dependencies). It adds no collector, no background read and no eager history scan. The only extra requests are #212 permission lookups for the authors and editors of needs-human records, cached per read like other marker trust.

| Evidence                                                                                                                                                                          | Item kind            | Explicit or inferred |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------- |
| `attention:NAME` on an open issue or PR, NAME being the human                                                                                                                     | `addressed-response` | explicit, addressed  |
| A trusted needs-human record on an open issue whose `question` or `design:decision-needed` label is still present, routed (`Designer:`) to the human                              | `answer-questions`   | explicit, addressed  |
| The same, routed to someone else or with the human unnamed                                                                                                                        | `answer-questions`   | explicit             |
| A needs-human record whose author's authority could not be established (permission unknown, edit history unread, or no permission boundary), with the labels still present        | `decide`             | inferred             |
| `design:decision-needed` or `question` on an open issue with no trusted record                                                                                                    | `decide`             | inferred             |
| An open, non-draft PR accepted at its current head (the existing `accepted-pr` and `clean-pr` predicates: verify passed, head reviewed, no findings, conflicts or pending checks) | `sign-off`           | inferred             |

A needs-human record is the comment `pdb needs-human` posts: the `### Questions for the designer` heading, `Designer: \`NAME\` · Raised by: \`AGENT\``, the `**Why:**`line, the numbered questions and the`github-triage:needs-human`marker. Trust follows the existing rule (workflow.md, "Comment markers"): a`User`author with current write, maintain or admin permission, and any edit made by such a user. A record established as lacking authority is ignored and counted; one whose authority is unknown can only produce an inferred`decide` item, never an explicit request. Copying a record's text does not copy its authority.

Explicit means a trusted participant explicitly asked for this input. Inferred means the evidence suggests human input is likely needed but nobody with authority asked for it; it is labelled as a candidate, never as a request. GitHub review requests are not collected today, so an explicit sign-off request is expressed with `attention:NAME` on the PR; an accepted PR without one is only an inferred sign-off candidate. Delivery records (`submit`/`complete`) are agent operations and produce no human item.

## Item fields

The compact report for `--role human` carries a `human` object instead of the agent queue:

```json
{
  "schemaVersion": 1,
  "human": "owner-name",
  "routing": "named",
  "total": 3,
  "omitted": 0,
  "items": [
    {
      "id": "owner/repo https://github.com/owner/repo/issues/12 answer-questions",
      "kind": "answer-questions",
      "target": "https://github.com/owner/repo/issues/12",
      "title": "Ticket title",
      "explicit": true,
      "addressed": true,
      "routedTo": ["owner-name"],
      "raisedBy": ["agent-name"],
      "requested": ["1. Which account model…", "2. …"],
      "reason": "Why line from the record",
      "blocks": {
        "subjects": [
          "https://github.com/owner/repo/issues/12",
          "https://github.com/owner/repo/issues/20"
        ],
        "unknown": []
      },
      "source": "https://github.com/owner/repo/issues/12#issuecomment-1",
      "ruleIds": ["D-HUMAN-ASK-YOU"],
      "why": "Trusted question record routed to you: answer the recorded questions on the ticket.",
      "warnings": []
    }
  ],
  "coverage": {
    "complete": true,
    "warnings": [],
    "records": { "current": 1, "superseded": 0, "resolved": 0, "untrusted": 0, "unverified": 0 },
    "excluded": ["closed tickets (#414)", "GitHub review requests (not collected)"]
  }
}
```

- `requested` is the input asked for: the record's questions (each shortened to a bounded length, at most five per item, with the remainder counted in `warnings`), "a response to the attention request", "a design decision recorded on the ticket", or "merge sign-off for head SHA".
- `reason` is the record's `Why:` line, or the rule's explanation for inferred items.
- `blocks` lists the subject itself and its open native dependents (issues it blocks) for an issue, or the issues a PR closes. Truncated `blocking` evidence is reported in `blocks.unknown`, never as "blocks nothing".
- `source` is the focused link: the record comment's URL for a question, otherwise the issue or PR URL.
- Parked tickets are included: parking defers agent work, not a question waiting on the human. When more blocked or closed subjects exist than are listed, `blocks.unknown` says how many were omitted; that is display trimming, not incompleteness.
- One subject appears once. When several rules match a subject (for example `attention:NAME` and a trusted question routed to the human), the item takes the first-ranked position, keeps every rule ID, and is explicit and addressed if any matching rule is.
- No item carries a claim, estimate or merge command. The human view never grants claim rights, reserves work or performs a write; next steps are reading the source link or `pdb --repo R --issue N`/`pdb pr N --repo R`. Answering and signing off through a UI is later scope.

## Resolved and superseded records

A question is current only while its ticket is open and still carries `question` or `design:decision-needed`. Removing those labels is how a participant marks it resolved (workflow.md, "Human questions"); a trusted record on a ticket without them is counted as `resolved` and produces no item. A record is never treated as resolved because of a later comment, a PR merge or closure of the ticket.

The newest trusted record on a ticket supersedes older trusted records there: a new needs-human call states the questions still outstanding, which is also how a partial answer is recorded. Older records are counted as `superseded` and stay reachable through the ticket. Exact repeats of a record (the same marker) are one record. #412 plans durable question IDs and waiting records; when they ship, resolution can bind to IDs instead of labels, and this projection reads them through the same fact boundary.

## Ordering

The engine's existing lexicographic keys apply. First match wins:

1. **Band 1, addressed to the human:** `attention:NAME` (`D-ATTENTION`, unchanged) and trusted questions routed to the human (`D-HUMAN-ASK-YOU`). Within the band, issue or PR number ascending.
2. **Band 3, unblock duties,** by preference: trusted questions not routed to the human (`D-HUMAN-ASK`, 0); records with unknown authority (`D-HUMAN-UNVERIFIED`, 1); decision labels without a record (`D-HUMAN-DECIDE`, 2); inferred merge sign-off (`D-HUMAN-SIGNOFF`, 3). Within each preference, more active dependents first (claimed or PR-linked work waiting on it, the designer key), then number.

Explicit items therefore precede inferred ones, and addressed items precede everything. Urgency and impact labels are shown nowhere in this ordering; a later contract may add them. Equal keys tie on numeric identity, so the order is deterministic.

## Bounded output and truthful coverage

`limit` (CLI `--limit`, MCP and API `limit`) applies after ranking, with `total` and `omitted`. The MCP version-2 envelope prunes `human.items` from the end within its byte budget and reports the omission. The text rendering lists the ranked items with their kind, explicit/inferred status, what is requested, what is blocked and the source, and says "No human input is waiting" only when the evidence is complete.

`coverage.complete` is false, with a warning naming the subject, when any of these hold: a ticket's comment history is longer than the collected first page (an unseen newer record could change the questions); labels are truncated; `blocking` or a PR's closing references are truncated; a record's authority is unknown (a failed permission lookup or an unverifiable editor); a current record's questions cannot be read; permissions could not be read (offline, or no REST boundary), which makes every record `unverified`; or the snapshot itself is incomplete. Missing evidence is never read as "nothing needed", "answered" or "approved". Closed tickets are outside this slice and listed in `coverage.excluded`; #414 owns their unresolved questions.

## Interactions

- **#414:** unresolved questions on closed tickets. This contract stops at open tickets and states the exclusion; #414 extends the same record reading and adds closed-history discovery without changing these items.
- **#262/#412:** today `needs-human` releases the caller's claim; #412 will retain it with waiting evidence. The human view does not depend on claim state, so both behaviours produce the same items. Durable question IDs from #412 later refine resolution.
- **#416:** `pdb rules` renders the policy artifact; the new decisions carry IDs, `why` text and codes (`explicit`, `inferred`, `addressed`) so they appear there without a separate English description.
- **#458 and #390:** the dashboard page and HTTP MCP consume this `human` object through the shared service; neither may add UI-specific inference or its own collector.

## Tests

Unit tests over injected snapshots and trust, plus `rules:test` EDN scenarios: explicit attention and trusted questions; inferred decisions and sign-offs; resolved (labels removed) and superseded (older record) records; named routing versus unrouted; truncated comment history; unknown and untrusted permission; copied records; bounded output; CLI, MCP and API parity; and unchanged golden parity for the implementer and designer roles.
