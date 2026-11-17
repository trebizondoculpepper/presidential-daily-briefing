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
      "warnings": [],
      "sourceState": "open"
    }
  ],
  "coverage": {
    "complete": true,
    "warnings": [],
    "records": { "current": 1, "superseded": 0, "resolved": 0, "untrusted": 0, "unverified": 0 },
    "excluded": ["GitHub review requests (not collected)"],
    "closedSources": { "read": true, "complete": true, "requests": 1, "…": "see Closed sources" }
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

**v2 questions (#412, #414).** A question written with the v2 marker is answered only by a trusted explicit `pdb question resolve|withdraw` record bound to that exact question comment and operation, on an open ticket as on a closed one. Removing labels, a reply, a merge or closure answers nothing. Each v2 question on a ticket is its own obligation (no supersession; trusted repeats of one marker are one question, settled by an outcome on any of them). An item lists every open v2 question of its ticket. When the ticket's comment history was not fully read, or a resolution record cannot be verified, the outcome is `unknown`: the question is still shown and coverage is incomplete. A resolved or withdrawn v2 question on a ticket that still carries a question label leaves only the inferred `decide` item for the label. The shared fold is `src/briefing/questionfold.ts`; the rules are `asking-record`/`record-pending` in `rules.edn`.

**Legacy v1 records** keep this contract. A question is current only while its ticket is open and still carries `question` or `design:decision-needed`. Removing those labels is how a participant marks it resolved (workflow.md, "Human questions"); a trusted record on a ticket without them is counted as `resolved` and produces no item, but only when the ticket's labels were read completely; with truncated labels the record is counted as `unknown` and coverage is incomplete. Records are parsed with the same format `pdb needs-human` writes (`questionRecordBody`/`parseQuestionRecordBody` in `src/workflow/claims.ts`), so multiline questions and reasons are kept. A record is never treated as resolved because of a later comment, a PR merge or closure of the ticket.

Among legacy v1 records, the newest trusted record on a ticket supersedes older trusted records there: a new needs-human call states the questions still outstanding, which is also how a partial answer is recorded. Older records are counted as `superseded` and stay reachable through the ticket. Exact repeats of a record (the same marker) are one record.

## Ordering

The engine's existing lexicographic keys apply. First match wins:

1. **Band 1, addressed to the human:** `attention:NAME` (`D-ATTENTION`, unchanged) and trusted questions routed to the human (`D-HUMAN-ASK-YOU`). Within the band, issue or PR number ascending.
2. **Band 3, unblock duties,** by preference: trusted questions not routed to the human (`D-HUMAN-ASK`, 0); records with unknown authority (`D-HUMAN-UNVERIFIED`, 1); decision labels without a record (`D-HUMAN-DECIDE`, 2); inferred merge sign-off (`D-HUMAN-SIGNOFF`, 3). Within each preference, more active dependents first (claimed or PR-linked work waiting on it, the designer key), then number.

Explicit items therefore precede inferred ones, and addressed items precede everything. Urgency and impact labels are shown nowhere in this ordering; a later contract may add them. Equal keys tie on numeric identity, so the order is deterministic.

## Bounded output and truthful coverage

`limit` (CLI `--limit`, MCP and API `limit`) applies after ranking, with `total` and `omitted`. The MCP version-2 envelope prunes `human.items` from the end within its byte budget and reports the omission. The text rendering lists the ranked items with their kind, explicit/inferred status, what is requested, what is blocked and the source, and says "No human input is waiting" only when the evidence is complete.

`coverage.complete` is false, with a warning naming the subject, when any of these hold: a ticket's comment history is longer than the collected first page (an unseen newer record could change the questions); labels are truncated; `blocking` or a PR's closing references are truncated; a record's authority is unknown (a failed permission lookup or an unverifiable editor); a current record's questions cannot be read; permissions could not be read (offline, or no REST boundary), which makes every record `unverified`; or the snapshot itself is incomplete. Missing evidence is never read as "nothing needed", "answered" or "approved". Closed tickets are read by the bounded closed-source pass below, whose gaps also make coverage incomplete.

## Closed sources (#414)

A ticket closing (by a merged PR, by hand, or as not planned) does not answer its questions. Contract: doc/reports/closed-question-discovery.md; implementation: `src/briefing/closedquestions.ts`, rules `D-HUMAN-ORPHANED-YOU` (band 1), `D-HUMAN-ORPHANED` (band 3, preference 0) and `D-HUMAN-ORPHANED-UNKNOWN` (band 3, preference 1), all of kind `orphaned-question`.

- **Read.** On a live read, one bounded pass lists closed issues (GraphQL `issues`, which excludes PRs), newest update first, with their labels and first comment page, then hydrates longer comment histories one page per source in rotation, so one long history cannot take the budget. Defaults: at most 13 GitHub requests in all, of which at most 3 inventory pages and 10 comment pages of 100 rows; permission lookups for record authors spend the same budget, and a lookup refused by the bound leaves that record unverified. Issues already read as open in the snapshot keep the open-ticket contract. Nothing is reopened, cloned, labelled or written.
- **Resolution.** Every trusted question record on a closed source is its own obligation (no supersession). A v2 question (#412) is settled only by a trusted explicit `pdb question resolve|withdraw` record bound to that exact question comment and operation; a reply, label removal, merge or the closure itself settles nothing. A legacy v1 question keeps its label meaning: it stays open while the closed ticket still carries `question` or `design:decision-needed`, and is resolved when those labels are gone. The outcome is `unknown`, never answered, when the source's comment history was not fully read, when a resolution record could not be verified, or (v1) when the labels were truncated.
- **Items.** An unsettled or unknown question yields an `orphaned-question` item with `sourceState: "closed"` and `resolution: "unresolved"` or `"unknown"`; the text shows `ticket closed, unanswered` or `ticket closed, resolution unknown`. `requested` lists the questions of every unsettled record on the source, `source` links the newest such record, and `blocks` is the closed source alone (its dependents are not read). Open-ticket items carry `sourceState: "open"`.
- **Coverage.** `coverage.closedSources` reports the bounds, requests spent, inventory pages/rows and whether the inventory finished, discovered and hydrated sources, the sources left with unread comment pages (`pending`), permission gaps, record counts (`noOutcome` (no explicit outcome; a v1 record may still be label-resolved), `unknown`, `resolved`, `withdrawn`, `untrusted`, `unverified`) and any failure. Closed tickets beyond the inventory bound, unread comment pages, unverifiable records, copied (foreign-bound) or malformed markers and failures each add a warning and make coverage incomplete: a truncated pass can still show the questions it verified, but never says nothing is waiting. Offline or cached reads, and front ends without a live GraphQL/REST boundary, report `closedSources.read: false` with a warning instead of showing none.
- **Continuation in `pdb serve`.** A one-off read (CLI, stdio MCP) starts the pass afresh each time. `pdb serve` keeps each served project's and repository's scan in memory (`ClosedQuestionStore`, held by the serve cache; the JSON API and `/mcp` share it), so each request spends its own bound and continues where the last stopped. Nothing is written to disk. `coverage.closedSources.scan` reports the opaque `continuation` (server instance, project/repository, scan start, generation), whether this read started (`fresh`), `continued` or `restarted` the scan and why, the scan start, the `generation` and the `watermark`. Requests on one scan are serialised. A page's cursor advances only after the page is read, so a failure or the bound never skips one; the next read retries it. Questions found so far stay visible while the scan is incomplete.
- **Baseline, then incremental refresh.** The baseline lists every closed issue. When its listing and every comment history are read, the watermark becomes the scan's start time. Each later read runs an overlapping `since` pass from five minutes before the watermark (`overlapSeconds`), refolding every closed issue changed since then from its current state. The watermark advances to the pass's start only after the pass's listing and comment histories are all read; until then coverage is incomplete and the next read continues the pass. This is an observed pass over a mutable API, not a snapshot: the overlap and refolding mitigate concurrent changes without promising exactly-once.
- **Loss and expiry.** A scan idle longer than the cache's stale window (at least the TTL) expires; a manual `POST /api/v1/refresh` for its repository (or all), a gh login change or a server restart discards it. The next read says `restarted` with the reason, warns, and starts a new baseline; it never claims the old coverage.

## Interactions

- **#414:** unresolved questions on closed tickets, read by the bounded closed-source pass above with the same record reader; open-ticket items are unchanged.
- **#262/#412:** today `needs-human` releases the caller's claim; #412 will retain it with waiting evidence. The human view does not depend on claim state, so both behaviours produce the same items. Durable question IDs from #412 later refine resolution.
- **#416:** `pdb rules` renders the policy artifact; the new decisions carry IDs, `why` text and codes (`explicit`, `inferred`, `addressed`) so they appear there without a separate English description.
- **#458 and #390:** the dashboard page and HTTP MCP consume this `human` object through the shared service; neither may add UI-specific inference or its own collector.

## Tests

Unit tests over injected snapshots and trust, plus `rules:test` EDN scenarios: explicit attention and trusted questions; inferred decisions and sign-offs; resolved (labels removed) and superseded (older record) records; named routing versus unrouted; truncated comment history; unknown and untrusted permission; copied records; bounded output; CLI, MCP and API parity; and unchanged golden parity for the implementer and designer roles.

## Human page grouping clarification (#643, #751)

Keep the shipped membership meaning: items whose resolution is unknown appear in
Waiting, below items requiring the selected human's input. Unknown outcome is not
proof that somebody else is handling the item, that the question is answered, or
that the project is healthy. Label the section/help so its uncertainty is clear.
Do not automatically add other humans' tickets to this group; recipient selection
continues through the shared human-briefing rules and completeness model.

Under workflow-policy-boundary.md, the group is a shared native decision/projection,
not an independent predicate in `human-page.ts`. Add an additive presentation
field such as `attentionSection: "input" | "waiting"` with a matched native reason
and evidence. The default rule maps the existing unknown-resolution fact to
Waiting and the existing actionable human item to Input. No new state is inferred
from issue closure, current labels, missing replies or absent history. The host
only normalizes trusted question/outcome evidence; native policy owns membership.

CLI, STDIO/HTTP MCP and the web Human view consume this same grouping when the
field ships. Older consumers may ignore the additive field. The web renderer
formats the supplied section without recomputing workflow policy. Keep explicit
outcome-unknown notices and existing omission/source coverage even when grouping
cannot be fully established; do not manufacture an empty healthy view.

Implement #643 as a small native-rule/projection change plus renderer consumption,
with cases for open unanswered, explicitly resolved/withdrawn, closed unanswered,
untrusted or edited outcome and incomplete history. Verify the same item/reason
across transports and preserve the existing ranked order within each section.
This is not an expansion of ownership, a new notification service or a rule that
silences unanswered questions. No further owner choice is needed to retain the
current meaning while moving its decision to the canonical source.
