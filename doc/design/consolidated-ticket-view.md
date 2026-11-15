# One ticket, one consolidated status view

Contract for #197, reused by #454's read-only dashboard detail. This document
specifies planned behavior, not an installed command. Product direction is in
`triage-efficiency-and-trust.md`; delivery, review and trust retain their current
shared contracts. No new workflow state, percentage-complete estimate or scoring
algorithm is introduced.

## Interface and compatibility

```text
pdb ticket N [--repo owner/name] [--agent NAME] [--platform NAME]
             [--json] [--limit-prs N] [--max-chars N]
```

Use the existing validated positive issue-number/repository/identity boundaries.
`--limit-prs` defaults to 10, accepts 1–100, and bounds detailed PR reads, not the
truth of delivery membership. Text defaults to the ordinary 10000-character budget.
`ticket --help` works without a checkout or credentials. JSON is a new versioned
`ticket-status` document; `--max-chars` is a text presentation budget and never
silently slices valid JSON bytes. MCP byte-budget handling, if exposed later,
uses the existing structured envelope/omission behavior.

Keep `pdb --issue N [--json]` as the compatible full intake including repository
context. Link to that command from the focused view. No implicit redirect, field
removal or renaming of its existing schema. `pdb briefing` owns repository catch-up.
Going to `gh` for unsupported or deeper questions remains legitimate.

CLI exit 0 means complete evidence for the represented view, 2 means useful but
incomplete evidence, and 1 means invalid arguments or no usable read. A closed
ticket is valid intake, not an error. Reuse the existing missing/forbidden/moved
diagnosis and source links; never silently follow a transfer to another repository.

## Collection and linkage

Use a transport-neutral `readTicketStatus` service with injected GitHub, trust,
clock and local configuration boundaries. First read the selected issue and its
native direct dependency summary/edges, current claim and delivery/question records.
Use the same ownership/responsibility and delivery fold as `who`, `team`, `pr`
and Ticket Doctor. Preserve comment/editor authority checks. Do not authorize an
instruction merely because it occurs in a report returned by this read command.

Collect only facts required for this ticket and its actual linked PRs; no repository
briefing or full-tree walk. Reuse discovery/targeted hydration where delivered;
the API contract does not require a new collector implementation. A bounded fallback
must disclose its scope and cost rather than claim targeted collection it did not
perform. Do not block a useful focused status on unrelated repository-history reads.

Distinguish links by provenance:

1. Valid trusted delivery records define required deliverables and responsibility.
2. GitHub's closing/reference relation establishes an associated PR, not required
   delivery membership. Merged closing references alone cannot fill absent membership.
3. Body/comment URL mentions are context only, never automatic required delivery.

Deduplicate by host/repository/PR identity, preserving every relation/source.
List all known required identities even when their detailed reads exceed the cap.
Read required PRs first in deterministic repository/number order, then associated
PRs in that order. A bounded reference list, truncated comment history, unknown
record authority or omitted required PR observation creates an explicit coverage
gap. Never label missing linkage "no PR exists"; say no associated PR was found
within the inspected sources and link to full intake.

Each detailed PR uses the shared PR-status service: actual current head, draft/
open/closed/merged state, intended/live target, check state, current-head review
acceptance, unresolved findings and delivery responsibility. Reuse current-head
either-provider review rules; no separate ticket-level interpretation. Do not
guess that a passing check means accepted or that a stale approval accepts a new
head. Cross-repository required PRs keep their own identity and intended target.
An inaccessible/unserved source is unknown and never skipped as optional success.

Delivery remains evaluated by the shared completion predicate over the full
required set and its intended targets. This read neither completes nor closes
anything. A draft or feature-branch merge is progress, not whole delivery; one
merged PR is partial evidence when other required work is missing. External human
closure stays a separate fact. Explicit non-PR completion evidence is shown through
the existing model, not synthesized from a closed issue label.

## Condensed document

The version-1 JSON contains:

- `kind: "ticket-status"`, `schemaVersion: 1`, repository, ticket number/title/URL,
  issue state and closure reason/actor where known, selected agent/platform and
  identity diagnostics. Reported identity is focus, not authorization.
- `freshness`: request time and per-source observation times/source mode. A fresh
  output timestamp does not imply every underlying observation was fetched now.
- `coverage`: complete flag, source coverage, warnings and counts/links for omitted
  history, PR details, native edges and uncertain linkage/membership. Preserve
  independent read failures in their source entries, not only a generic banner.
- `ownership`: current claims, ticket-responsible contributor, deliverable
  responsibilities and observed waits, using the shared state model. No "online"
  or inactivity-based abandonment inference.
- `delivery`: the unchanged shared evaluation plus required identities and unknowns.
  Keep closure, delivery and next action separate; no percentage done.
- `pullRequests`: bounded detailed PR summaries with relation/provenance and
  individual source timestamps; known-but-unread identities remain in omissions.
- `dependencies`: direct blockers, dependants and coverage; no transitive estimate.
- `discussion`: bounded relevant records, questions, handoff/decision links and
  latest discussion excerpts from already inspected history. Label excerpts as
  excerpts, not semantic summaries; include source authors/times and trust status.
- `assessments`: current/stale/unknown impact and complexity with existing provenance,
  available as detail rather than repeated on every row.
- `nextSteps`: shared rule/classifier results applicable to this ticket, with why,
  rule IDs where available, source evidence and supported commands. No new UI ranker
  or ticket-specific issue-number rules. A waiting state remains visible without
  inventing an immediate action. Incomplete evidence yields inspection, not pickup.
- `links`: full intake, shared PR diagnosis, native dependency read and GitHub URLs.

Text leads with the ticket's state, delivery qualification and most useful next
step, then short linked PR rows and actual blockers/questions. A small footer gives
observation/coverage and deeper commands only when useful. Hide empty sections,
zero unlock counts and repetitive proforma. Render one meaningful why per action;
do not repeat impact/complexity beside the same explanation by default. Fit whole
rows where possible; when the budget omits content, state "Truncated due to maximum
size" and retain a focused detail command when it fits. Missing/partial required
delivery evidence must never be hidden behind a visually conclusive "done" header.

Relevant discussion means known workflow records and bounded actual recent
discussion; it is not a promise to discover every important sentence. Default
collection does not crawl every review round/commit or ask an LLM to summarize
arbitrary comments. Facts already present may be shown, but no XL-plus-many-comments
trouble score or expensive new history crawler is part of this ticket.

## Shared server and dashboard

#454 adds `GET /api/v1/tickets/{n}` with the same served-project/agent/platform
selection and existing `serve-read` envelope, whose result is `ticket-status`.
It calls this service rather than interpreting the large `/issues/{n}` response
again in the browser. Preserve the old issue endpoint and its full-intake semantics.
Reject unknown/repeated arguments and unserved cross-repository reads before
collection; list those gaps with focused CLI/GitHub links. Reuse per-source cache
and caller projection boundaries, with known live/cached/stale times and coverage.

The read-only ticket page links from the ranked dashboard and can be opened directly
with a validated selected project/ticket. It shows loading and errors, the condensed
combined state, PR evidence, ownership, direct dependencies and relevant discussion.
Click-to-expand detail uses existing bounded sources; no automatic history crawl.
Escape all untrusted text and validate external URLs through the existing safe-link
boundary. No claim, edit, urgency, completion or sign-off writes; #455 is separate.
Refreshing details requests explicit fresh reads and does not mutate GitHub.

CLI implementation #197 can ship before the dashboard. #454 depends on #197's
shared service and #374's UI shell. Do not make the CLI depend on a running server.
MCP exposure is a future additive wrapper and not required to complete #197.

## Acceptance

Use injected fixtures and clocks: no PR, one draft, accepted current head, stale
approval, failed/pending checks, multiple required PRs with partial delivery,
feature-branch target mismatch, closed-unmerged, cross-repository/inaccessible PR,
unknown membership/permissions, truncated records/edges, human-closed issue, explicit
non-PR completion, retained/released/submitted responsibility and waiting states.
Assert accurate partial-source recovery and source times, not only golden text.

Test no unrelated repository catch-up/tree fetch, bounded detailed PR requests,
stable deduplication/provenance, required-first ordering and omitted-required unknowns.
Verify text/JSON semantics and budget notices, CLI help/errors, preserved full-intake
schema, API/CLI projection parity and safe HTML/link rendering. Tests never create
live tickets, PRs or comments. The focused result supports investigation; it does
not prove actual agent adherence or authorize a write.
