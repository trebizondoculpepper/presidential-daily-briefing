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
