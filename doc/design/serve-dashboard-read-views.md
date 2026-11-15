# Read-only activity and human-attention dashboard views

Shared presentation contract for #456 (agent activity) and #458 (human attention).
They remain separate implementation tickets. The read-only shell is #374; ticket
details and later editing are #454/#455. This document does not implement a page or
introduce another collector, scheduler, presence service or mutation API.

## Shared navigation and loading

Add Activity and Human attention links to the project dashboard. `/activity?repo=R`
and `/human?repo=R` are directly addressable views under the same local server.
Resolve the selected project through the existing served-project allowlist; use
the same selector as the main dashboard. Missing/ambiguous selection shows the
selector rather than guessing from the server's launch directory. Unserved input
fails helpfully without GitHub calls. Encode repository/name values in links.

Loading the shell or project list does not fetch every project's facts. Fetch only
the visible requested view. Switching project/view cancels its abandoned HTTP read
where possible and ignores late responses using a request-generation/selection
check. Do not flash project A's response under project B's header. No timer polling,
prefetch, background expiry refresh or cross-project fan-out. The first requested
view may show a loading state while shared collection occurs.

Both views consume the existing `serve-read` envelope and show its actual selection,
source observation time, cache/live/stale state, coverage and errors. Recent page
rendering time is not a fresh GitHub observation. Show an explicit Refresh button
using the existing requested-refresh path; do not write a second cache or force
refresh when navigating to the same fresh shared facts. A failed refresh may keep a
permitted last-good response only with a conspicuous stale/failure notice. Do not
replace unknown/unavailable data with zero rows or "all clear".

Existing source/omission counts stay visible; expand details on request. If a shared
service returns incomplete records, preserve those warnings and links, including a
count when the page bounds their display. No silently hidden warning tail. Compact
default rows emphasize the next action/evidence rather than repeating every label.
Use accessible headings, semantic lists/tables, keyboard-operable controls and
status/error announcements. No external assets or scripts. Escape all source text
and apply the existing safe-link protocol/host boundary; never interpolate GitHub
discussion or agent names into executable HTML.

## Agent activity: #456

Read `GET /api/v1/team?repo=R`, reusing `doc/design/diagnostics.md` and the shared
delivery/ownership model. The browser does not independently parse comments or
infer agent identity from the PR's shared GitHub author. For each recorded agent,
show claimed issues and submitted deliverables for which responsibility continues,
with ticket/PR links and latest observed ticket/PR activity. Preserve unknown
responsibility separately; do not silently assign it to an arbitrary agent.

Claimed work and submitted responsibility are separate groups inside the agent row.
Do not count a pending PR as an extra active claim. Waiting reason and activity state
are shown only when provided by the shared model; until #412/#413 ship, absence of
those fields is "not available", not an inferred wait/active designation. Submitted
PR checks/review waits can use already delivered shared delivery states. Multiple
claims, stale activity and contradictions retain their existing diagnostic severity
and evidence; the page cannot repair them. Source links lead to `who`/ticket/PR
detail where available, with a CLI/GitHub fallback when #454 is not delivered yet.

Keep the server's stable agent/issue ordering rather than inventing a priority
algorithm. Offer expanding an agent's obligations, with explicit list omissions
and a link to the full existing team/CLI report. A complete result with no recorded
work may say "No recorded claims or responsibilities in this project"; an incomplete
result says "No work observed in the available evidence" plus the gaps. Neither
means no agents exist, no one is working, online/offline, or abandoned work.

No private inbox/profile/config file contents are required or displayed. Silence
does not imply availability. The page never releases, reassigns, closes or creates
work; explicit editing and claim controls are outside this ticket.

## Human attention: #458

Read `GET /api/v1/briefing?repo=R&role=human`, with an optional explicit `agent=NAME`
human-routing focus. Reuse the exact `human` projection and ordering in
`doc/design/human-briefing.md`, already shared with CLI/MCP. Never borrow a detected
harness identity, persisted agent entry or shared GitHub login to name the human.
Without a name, show the unrouted notice and all returned items. A user may enter
the routing name explicitly; retain it in the view URL if requested by navigation,
without writing configuration or creating an identity.

Render each returned item once, in server order, with:

- the requested answer, decision or sign-off and source ticket/PR;
- the shared why/reason, actual routed recipient and whether it is addressed to
  the selected human;
- explicit request versus visibly labelled inferred candidate;
- blocked work links and unknown blocking coverage;
- focused question/comment/PR source links and the existing safe detail command.

Trusted questions routed to someone else remain visible with that recipient, not
presented as the viewer's personal obligation. Accepted clean PRs may appear as
inferred sign-off candidates; this does not require human approval or supersede
the existing agent merge policy. No merge, answer, approve, sign-off or automatic
question-resolution controls appear. Opening a source link is the next step.

Respect `total`/`omitted` after shared ranking and request bounded additional rows
only on explicit user action. Do not reorder questions by browser heuristics or
derive resolution from later text. A complete empty projection may show "No human
input is waiting" only within its stated coverage; incomplete/closed-source
exclusions must remain visible. #414 later extends discovery of unresolved questions
on closed tickets; the page displays that service's results, not its own crawler.

## Verification and rollout

Both tickets depend on the delivered #374 shell. #458 also depends on #457's shared
human role; that role is merged. Neither page must wait for dashboard editing,
diagnostic REST or full CLI/MCP parity. Keep existing URLs and JSON schemas working.

Use injected team/human API fixtures and browser rendering tests. Assert exact
projection/order parity, project/name selection, no implicit identity borrowing,
empty/incomplete/stale/failure states, warning omissions, request cancellation and
late-response isolation. Cover claims plus submitted obligations, unknown actors,
shared GitHub login, waiting-state availability, explicit questions and inferred
sign-offs, recipient differences, blocked links and closed-source exclusions.
Test escaping and URL validation with hostile labels/names/comment excerpts.
Assert that opening a shell/selector makes no collection call, only the selected
visible view is read, no hidden polling occurs, and no write endpoint is invoked.
Packaged smoke verifies the routes and existing CLI/API commands remain usable.
