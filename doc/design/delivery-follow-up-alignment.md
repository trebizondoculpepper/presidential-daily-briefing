# Delivery follow-up, waiting responsibility and draft PRs

Documentation-first implementation proposal for #377. It applies the owner's draft
and continuing-responsibility decisions recorded in local-service-and-rule-testing.md.
The BEHIND rule below is an engineering proposal for review, not a claim that the
owner explicitly approved that previously open question. No runtime behavior changes
until this contract is reviewed and implementation ships.

## One set of facts, distinct action and responsibility

Reuse the shared delivery fold, current-head review evidence, PR coverage and native
policy. A submitted obligation remains owned until the definition of done is met or
an authorized explicit release/transfer changes responsibility. An open draft,
review wait or pending check cannot satisfy completion. Human closure stays
unchanged; diagnostics must not reopen or pretend it proves delivery.

Keep the shared `none | waiting | actionable | unknown` follow-up classifications.
Separate the known responsibility from whether a specific action is currently
possible. `waiting` is a truthful state, not a fabricated command to do more work.
An issue with several deliverables aggregates all of them without losing actionable
work because another member is waiting. Preserve deliverable-level explanations.

## Classification precedence

Independent explicit addressed attention remains first and does not depend on PR
readiness. Missing evidence cannot establish acceptance or absence of findings.
Use the shared coverage facts fixed by #497, including comments, reviews, checks
and threads; do not duplicate their pagination checks in each renderer.

For an open required PR:

1. A positively observed failed check on the current head of a non-draft PR is
   actionable even when other evidence is incomplete (#502). Say both facts: the
   check failed and other evidence is incomplete. This is negative evidence to
   investigate, never acceptance, merge permission or completion. Preserve the
   incomplete coverage metadata and unknown acceptance. In all other cases,
   incomplete required evidence yields `unknown` and a read-only inspection route.
   Do not infer absence of findings or a safe waiting state from a truncated page.
2. A draft is progress evidence. Draft status alone yields `waiting` with a reason
   such as “draft work in progress”, not “finish it” as a newly generated obligation.
   An explicit independent review request, addressed feedback, requested changes or
   reported findings can still produce a concrete response/review action. Do not
   promote a draft solely because its normal work-in-progress checks fail or it is
   behind. An existing implementation claim still has its ordinary continue-work
   action; this rule does not suspend it or release ownership.
3. For non-drafts, observed failing checks, requested changes, unresolved findings
   or merge conflicts keep their existing concrete follow-up actions. Pending
   checks mean waiting; absent/unrecognized required checks remain unknown.
4. Once required checks pass, an unaccepted PR that is merely BEHIND remains waiting
   for review, with the behind state available in details. Do not prescribe a branch
   update solely from that flag: the review may request changes anyway. This aligns
   the delivery classifier with the existing accepted-head prerequisite in the
   briefing's S9 integration rule instead of introducing a new action priority.
5. Accepted current-head PRs that are BEHIND or have unknown/refreshable mergeability
   retain S9 integration/inspection follow-up. Current-head acceptance with a clean
   merge state offers inspection then merge consideration under existing authority.
   An update invalidates old-head acceptance as usual; never carry it across a SHA.

Thus the first slice changes the delivery classifier's unaccepted-BEHIND behavior
rather than broadening the ranking's integration rule. It adds no automatic branch
updates, merging, requests for review or new policy permission. A future proposal
can change that trade-off using measured delivery evidence.

## Unified next-step visibility

This section supersedes the older blended-action-queues.md instruction that waiting
items exist only in background context. Put the viewer's submitted waiting
responsibilities in the same action-aware next-step model, after executable and
inspection work. They are not pickup candidates or claims. Unknown responsibilities
remain inspection items, with an explicit evidence gap, not waiting.

Use one stable `wait-delivery` action kind per responsible ticket and include links
to its required members. Include a machine-readable state and reason; its next
command is a focused read/refresh command, never claim/merge/resubmit as a substitute
for waiting. Render “Waiting: …” and keep the row visually distinct from executable
work. No periodic polling or background network requests are introduced.

When a ticket already has an actionable follow-up, suppress its duplicate waiting
row and include waiting siblings in its detail. A PR without a delivery record may
still have existing author-based follow-up; do not manufacture ticket responsibility
or invent membership from authorship. Route rows by the shared responsible identity,
not account login alone. Other agents' waiting work belongs in team/detail views,
not the caller's personal obligations.

The bounded top-ten shortlist still applies. `rankedActions.total` and `omitted`
count all next-step rows including waiting; add explicit actionable, inspection and
waiting counts so consumers do not treat totals as executable capacity. Any new
item-state/count fields are additive and documented in CLI/MCP JSON. Old target-only
projections retain their current action-only meaning. When waiting rows fall outside
the limit, the compact omission notice identifies that owned waiting obligations
were omitted and provides the focused full/team route. This satisfies boundedness
without falsely suggesting responsibility vanished. Do not force waiting rows ahead
of useful work simply to display them.

Datalog selects and ranks waiting rows and supplies their explanations; TypeScript
collects facts and renders them. Extend the TypeScript rollback path consistently.
Use native EDN rules/scenarios and the shared English compiler; no separate
presentation-only policy or per-agent special cases.

## Verification and delivery

Implement #502 as the focused failed-check parity correction, then #377 as the
draft/waiting alignment after #497 (now merged), using the existing
responsibility/coverage services. Test shared read classifier, native decision and
rollback, CLI/MCP role projections, team/who/pr and Ticket Doctor consistently.

Required fixtures:

- Draft alone: waiting progress, no immediate-action recommendation, not delivered.
- Draft with an explicit request: concrete response/review task; still never merge.
- Draft with only failed WIP checks or BEHIND: no invented follow-up action.
- Active claimed draft work still offers its normal continue-implementation action.
- Draft attachment/submission cannot close the issue or satisfy required delivery.
- Non-draft unaccepted BEHIND waits for review; accepted BEHIND retains S9 action.
- Old-head approval is not acceptance after a branch update.
- Truncated comments/reviews/checks/threads cannot establish acceptance or hide a
  finding. A current-head observed failed check on a non-draft remains actionable
  with incomplete coverage; otherwise incomplete evidence is unknown. Native EDN
  and TypeScript agree (#502); stale-head failure does not trigger this exception.
- Waiting review/check responsibilities stay in the shared bounded to-do model;
  actionable sibling wins, no duplicate waiting row, other agents not borrowed.
- More than ten rows expose waiting omissions and a useful full-view route; no
  polling or implicit mutations to make the UI look complete.
- Required merges clear only the satisfied obligation; off-target, partial or
  unknown evidence does not. Human closure remains authoritative.
- Both roles/engines and installed CLI/MCP agree on order, state, reason and counts.

Implementation note (#502): the briefing engines already treated an observed failed check
as follow-up regardless of completeness (Datalog `D-PR-FAIL`; the TypeScript rollback's
`pr-failed-checks`). The briefing's report-level warnings carry the evidence gap. Only the
delivery classifier (`classifyFollowUp`, used by team/who/pr/Ticket Doctor and completion)
answered `unknown` first. It now returns `actionable` for a non-draft with an observed
current-head failure and incomplete evidence. Its reason names both facts and says acceptance
stays unknown. Every other incomplete case is still `unknown`, and drafts are unchanged until
#377. Both of its fact sources read checks from the head commit only, so a failure on an
earlier head cannot trigger this. The tests are the native scenario
`observed-failure-is-actionable-with-incomplete-evidence` (coverage-gaps.edn) and
`src/workflow/followupparity.test.ts`, which compares the classifier with the Datalog
engine on the same snapshot PR.

This does not implement retained active claims (#412/#413), resume transitions,
external question discovery (#491/#414), new review-provider policy (#301) or a new
completion definition. Reuse their shared facts where available without coupling
this correction to unrelated unfinished features.
