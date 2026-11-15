# Blocked retained claims and the active-work limit

Owner-approved direction for #262, 2026-11-14. This is a proposed implementation
contract; the current single-claim enforcement stays in force until its replacement
ships. It refines the activity invariant in delivery-lifecycle.md without changing
delivery completion or human override.

## Why

`needs-human` currently removes the caller's claim. A subsequent `release --pr`
then refuses with `NOT_CLAIMED`, losing the intended handoff link. Dropping ownership
to wait also hides unfinished responsibility. Conversely, retaining every claim
under the current one-claim rule prevents productive work while a human answers.

Retain ownership while distinguishing active work from an evidenced external wait.
Permit another claim only when every other retained claim is genuinely waiting.
Priority explanations alone are insufficient: mutation commands enforce the rule.

## Activity and responsibility

One issue still has at most one claiming agent. One agent may retain multiple
claims, but at most one is designated active. A waiting retained claim reserves
ownership; it is not released, transferable by silence, delivered or completed.
Existing ticket/deliverable responsibility records retain their present semantics.
Do not infer a delivery record or completion from a waiting record.

Legacy claims without a valid waiting record count as active. Unknown history,
unknown permissions or incomplete blocker evidence never qualify for an exception.
Do not reinterpret every existing decision label as a suspended claim.

## Wait evidence and records

The first slice supports an unresolved human-decision request and a verified open
native dependency. A reason is required, but arbitrary prose such as “busy”, a
draft PR, a parked label, no recent activity or age alone is not sufficient.
Submitted PR review/check waits continue to use `submit`, which releases the active
claim and preserves responsibility; do not add retained claims to submitted work.

Add a versioned append-only claim-activity record, with final parser/schema details
reviewed alongside the claim implementation. It must bind to repository, issue,
agent and the existing claim-start timestamp, identify its operation and state,
and carry the reason and blocker reference for a wait. A human wait references the
concrete question operation/comment; a dependency wait references its native edge
and blocker issue. Reuse current writer/editor authority checks and server comment
chronology. A copied, stale or malformed record cannot suspend another claim.
Do not use the latest arbitrary comment as a resolved-question signal.

Resolution is explicit for a human decision; a new trusted response is attention
requiring inspection, not automatic proof the question is answered. A removed or
closed native blocker is observed freshly. Both produce `resume-required` when
appropriate, not an automatic new active claim. This distinction prevents two
active claims when a wait clears while the agent is working elsewhere.

## Commands and transitions

- `needs-human` keeps the caller's claim by default, writes the question and waiting
  evidence, and applies its decision/routing labels. The question must be durable
  before the wait can authorize another claim. Support explicit `--release` for
  callers intentionally relinquishing the claim; preserve responsibility and make
  its consequences clear. A caller with no claim cannot acquire one through this
  command.
- Provide explicit wait/resume transitions through the claim command family. Exact
  CLI spelling is finalized in the implementation contract and generated help;
  it must not require agents to edit markers or configuration manually.
- A new claim rechecks all of the agent's retained claims and their bound evidence.
  Refuse if another is active, resume-required, or unknown. Allow only if the rest
  are verified waiting, recording the specific exception and reason in the claim
  result. Normal readiness, native blockers, platform and other-owner checks still
  apply to the new ticket.
- Resume requires the blocking condition to be cleared and no other designated
  active work. If another claim is active, surface the resumed obligation and let
  the agent explicitly finish, release or validly suspend that work first. Do not
  silently steal, switch or auto-reclaim.
- `release --pr` still requires the caller's retained claim and existing authority;
  a waiting claim remains sufficient ownership. Preserve verified partial PR links
  and allow the modern deliverables/submit path as appropriate. Do not globally
  permit releases by non-owners merely to work around #262.

Record intent before label changes, read back after partial failures, and make
retries idempotent. Recheck the per-agent active-work condition before committing a
claim and reconcile concurrent winners; do not promise distributed atomicity from
GitHub labels. Existing race safeguards must not weaken. Contradictory active
records produce a diagnostic and block further claims rather than being repaired
by age or deleting another agent's work.

## Ranking and visibility

All retained claims and delivery responsibilities remain visible in the unified
to-do model until satisfied or explicitly released/transferred. Waiting rows show
the reason and what they await without pretending immediate action is possible.
Actionable owned follow-up and resume-required work take precedence over new
implementation, after explicit addressed attention and actionable PR obligations.
The separately accepted #378 assessment-versus-medium-implementation case is not
silently reversed; scenario tests must document how that assessment exception fits
within the owned-work policy.

Datalog decisions/reasons and TypeScript rollback must agree on claim permission,
waiting, unknown and resume-required facts. Ranking does not grant mutation
authority. `who`, `team`, Ticket Doctor, help, CLI and MCP expose the same activity
distinctions. Doctor flags contradictory/missing wait evidence and offers explicit
recovery, never auto-releases by inactivity.

An unresolved question must not disappear solely because its issue closes. Keep
the question as a separate obligation in owner attention until explicitly resolved
or withdrawn, with a focused link to the closed source issue. This does not reopen
an issue or override human closure. A merged PR does not imply its questions were
answered.

## Delivery plan and tests

1. Reconcile the workflow/delivery contracts and finalize the minimal record and
   wait/resume interfaces in a reviewed documentation change.
2. Implement retained-wait transitions and claim/release enforcement together;
   retaining claims without the exception would strand agents under the old guard.
3. Update shared facts, rule decisions/reasons, role projections and diagnostics.
4. Verify installed CLI/MCP parity and update contributor guidance.

Required scenarios: human wait -> second claim -> answer -> resume-required;
dependency wait and removed edge; arbitrary reason rejected; no claim created by
asking a question; legacy/unknown/malformed/copied wait rejected; retained owner
can link a PR; explicit release behaves as documented; submitted PR responsibility
does not consume an active slot; cleared wait cannot auto-create a second active
claim; concurrent attempts and partial retries; platform/other-owner guards;
unchanged assessment exception; closed source issue with an unresolved question;
and Doctor diagnostics without automatic ownership repair.

No fixed number of waiting claims, new scheduler, broad rule override, automatic
takeover or persistent daemon is needed for the first version. A future waiting-
backlog cap can be considered with usage evidence; it is not an owner decision
blocking this proposal.

## Multiple owned claims: explicit review, not automatic cleanup

Owner clarification, 2026-11-15: retaining a blocked claim is optional. Releasing
it while awaiting a human answer is equally valid; the eventual implementer need
not be the original agent. The question remains independently discoverable. The
default retained path above is a convenience, not an instruction to reserve all
blocked work. Neither path completes the ticket or answers the question.

When the viewer has more than one retained implementation claim, the rules emit
one `review-owned-work` action. Count distinct open issue claims held by that
agent across the current repository's complete ownership inventory; do not count
submitted PR responsibility as another claim. Do not silently claim a global
cross-repository view from a repository-scoped collection. Show that scope.

This review is a real action: inspect the listed obligations and either finish
work through normal completion checks, justify a still-valid wait, explicitly
release it, or use an authorized reassignment. It is not an order to close an
unfinished issue, an automatic transfer, or permission to override another owner.
The row links the affected tickets and their individual evidence/recovery commands.
Its initial command is read-only (`pdb team --repo R`); never generate an executable
bulk close/release command. Reassignment suggestions use only actually supported
commands and their existing authority checks.

The Datalog policy emits this action after addressed attention and actionable PR
follow-up, before new implementation and routine assessments. More than one claim
is a stronger review signal than one blocked claim, independent of their estimated
benefit. It must occupy a row inside the default shortlist, even when many quick
assessments compete. Preserve individual obligations in the full queue; waiting
rows do not become implementation actions merely because they are owned. Grouping
must state any omitted members and link to the full inventory. One claim does not
create the aggregate action; its normal continuation/wait row remains.

Priority and explanation come from the same native rules. TypeScript collects
count, member identities, claim/activity evidence and completeness; it neither
decides to add the action nor rewrites its reason. For example: "You retain 3
implementation claims; review which to finish, justify as waiting, release or
reassign before starting more work." An unknown count cannot establish that only
one claim exists. If at least two claims are positively observed, emit the review
with the observed lower bound and an inventory warning; otherwise emit an
ownership-inspection action when the available evidence is incomplete. Missing
history cannot authorize a second claim.

Keep #378's assessment-before-owned-M/M implementation ordering when there is only
one claim and no more urgent obligation. The aggregate review is the explicit
exception for multiple claims; it does not promote every owned implementation
above every estimate. Ticket Doctor uses the same facts to distinguish valid
multiple waiting claims (review reminder) from multiple active or unverified
claims (guard contradiction requiring recovery). No inactivity-based release.

## Minimal claim-activity interface for #412

These are planned commands, not currently installed capabilities:

```text
pdb claim wait N --agent NAME --question URL --why TEXT
pdb claim wait N --agent NAME --blocked-by owner/repo#M --why TEXT
pdb claim resume N --agent NAME
pdb needs-human N --agent NAME --designer NAME --why TEXT --question TEXT... [--release]
```

Use exactly one blocker kind per wait operation. Several blocking conditions may
exist, but removing this named condition only creates `resume-required`; resume
still checks all current native blockers and outstanding human questions. Existing
`claim N` and release/submit spellings stay compatible. `--dry-run`, `--repo` and
versioned JSON apply as for current mutations; dry-run writes nothing. A wait
requires current ownership, does not acquire a claim, and never suspends someone
else's work. Resume cannot succeed with another active/resume-required/unknown
claim, unresolved question or open native blocker. A second new claim requires
every other retained claim to be verified waiting, not merely a low queue rank.

Implementation note (#412, slice 1, `src/workflow/claimactivity.ts`): comment
identities (`previousActivity`, `questionCommentId`) are the comment's numeric
`databaseId` as a decimal string, which collected comments already carry and which
orders delivery records; GraphQL node IDs are not fetched. Records reject unknown
fields, and a reason is at most 1000 characters.

Implementation note (#412, slice 2a): `needs-human` now writes the v2 question
marker from doc/reports/closed-question-discovery.md in place of the v1 marker:
`<!-- github-triage:needs-human:OPID v2 {"v":2,"repository":R,"issue":N,"resolution":"explicit"} -->`,
keeping the same prefix and 16-hex operation id, so retries still match v1 records and
existing readers still find the record. The shared reader (`parseQuestionMarker`)
returns v1, an exact v2 binding, or malformed (never read as legacy); the human view
ignores copied and malformed records with warnings.

Implementation note (#412, slice 2b): `pdb question resolve|withdraw N --agent NAME
--question URL --why TEXT` appends the question-resolution v1 record after checking that
the URL is a readable question on this issue by a write-authorised author with no earlier
trusted outcome (a retry is a no-op; unknown evidence refuses). Consuming these records in
the human view, so that v2 questions stop resolving by label removal, is part of the shared
facts and projections of #413/#414; until then v2 questions keep v1's label-based
resolution, so none becomes unanswerable.

Implementation note (#412, slice 2c, `src/workflow/retained.ts`): `claim wait` and `claim
resume` append the activity records; `claim` takes an injected admission guard that re-reads
each other retained claim (ownership, label generation, activity fold, and for a wait its bound
blocker: a dependency still an open native blocker, a question still without a trusted explicit
outcome). Only verified waiting admits; a cleared blocker is `resume-required`; anything else is
unknown. The post-write recheck re-verifies admitted waits and reports a conflict otherwise.
`needs-human` keeps the claim unless `--release`: the CLI posts the question, reads it back by
operation id, records the bound wait, and only then changes labels; a failed wait leaves the
labels unchanged and the same command retries idempotently. A claim already waiting on another
blocker keeps that wait. A wait's question must be on the same issue. Resume also refuses while
any v2 question recorded during the claim is open; legacy v1 questions keep label resolution.

Use a separate `github-triage:claim-activity v1` JSON marker. Required fields:
`v: 1`, `op: wait|resume`, `opId`, `repository`, `issue`, `agent`, `claimStartedAt`,
`previousActivity` (comment node ID or null), and `reason`. A wait also carries
`blocker`: either `{kind: "human", repository, issue, questionCommentId,
questionOpId}` or `{kind: "dependency", repository, issue}`. IDs and timestamps
are strings; issue numbers are positive safe integers. Repository/agent validation
reuses the existing opaque-identity validators. `claimStartedAt` is the server
timestamp of the latest addition of this agent's claim label, obtained from the
existing `claimStart` boundary, not a caller's clock. No known label start means
unknown binding. The current query records a timestamp rather than an event node
ID; ambiguous history stays unknown rather than inventing a unique generation.

The record binds to the current label generation and preceding valid activity
comment. A removed/re-added claim invalidates old waits. Replay uses GitHub comment
creation order with a stable comment-ID tie-break, never payload time. Apply the
existing author/editor write-access check before trusting any marker. Wrong-ticket,
stale-generation or stale-predecessor records are rejected visibly; unreadable,
unsupported, malformed or unverified potentially authoritative records make activity
unknown. Unknown is never equivalent to waiting. Reuse the delivery parser's
authority-first distinction rather than introducing a weaker marker policy.

The existing `needs-human` operation ID plus its returned GitHub comment node ID
identifies the question. Add explicit `pdb question resolve N --agent NAME
--question URL --why TEXT` and `pdb question withdraw N ...` transitions using an
append-only `github-triage:question-resolution v1` marker with `v`, `opId`,
`repository`, `issue`, `questionCommentId`, `questionOpId`, `op: resolve|withdraw`,
`agent`, and `reason`. Preserve the original record; current write-access authority
is required. Resolution is a deliberate assertion with rationale, not inferred
from a later reply, label removal, PR merge or issue closure. The human view and
closed-source discovery consume these IDs through one shared reader. Legacy
questions without the new resolution marker keep the existing label-based human
projection compatibility, but cannot satisfy a bound wait by guesswork. A migration
or adoption command is separate scope; do not rewrite historical comments.

`needs-human` posts/verifies the durable question first, then appends/verifies the
bound wait, then updates routing/readiness labels. Only the completed wait permits
the extra claim. With `--release`, persist the question first, then use the normal
owner release path; do not write a wait that promises retained ownership after the
claim has been removed. Existing delivery responsibility and PR links are not
silently deleted or created. If partial work needs PR links, use supported
deliverables/submit before release, or keep the claim until its explicit handoff.
The command reports those recovery choices instead of allowing non-owner release.

## Races, retries and implementation readiness

Build operation IDs from normalized intent and the claim generation, so retries
reuse a successful question/activity append rather than posting duplicates. Record
the posted node IDs and verify them by read-back before dependent steps. Distinguish
question-saved/wait-missing, wait-saved/labels-pending and unknown-write outcomes;
never report "waiting" or "released" when only the question post succeeded. A retry
must first inspect the already-recorded intent, ownership and current blocker state.

Before and after a new claim, collect the agent's retained claims and verify their
bound activity using fresh reads, including the current issue. Two simultaneous
requests may still race through GitHub's non-transactional label API. If post-write
verification observes two active winners, report a conflict and block further
admission; do not remove either claim automatically or falsely report exclusive
success. The user/agent resolves the conflict through normal explicit operations.
Use the same first-valid-predecessor fold for competing activity transitions; reject
stale appends rather than retrying against a new predecessor without fresh intent.

#412 implements the records, transitions and fresh admission guard coherently.
#413 implements their shared facts, aggregate review, native decision/explanation
rules, rollback parity and Doctor/team/who/CLI/MCP projections. #414 discovers and
surfaces unresolved questions on closed sources; it never reopens the ticket.
No new owner answer is needed for these engineering interfaces; review this contract
before implementation. The current runtime single-claim rule remains until shipped.

Additional isolated rule scenarios: 0/1/2/3 claims; two verified waits; one active
plus one wait; cleared wait while another is active; unknown inventory with zero,
one or two positively observed claims; 11 competing assessments plus the review
row; repository/viewer separation; submitted PRs excluded from claim count; one
M/M claim preserves #378; both retain and release after a human question. Native
tests assert action kind, ordering and matched reason IDs; integration tests cover
fact extraction and mutations separately. A priority test does not prove admission
safety or distributed atomicity.
