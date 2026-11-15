# Retained claim and owned-work design reconciliation

Research/design outcome for #262, with #412–#414 implementing the result.

## Current behavior and the failure

`src/workflow/claims.ts` owns `needs-human`, claim and release planning. The
needs-human plan posts its question before changing labels, but removes the caller's
claim. Release planning then correctly refuses `NOT_CLAIMED`. Relaxing that owner
check globally would allow unrelated callers to hand off work they do not own.
`claimStart` already reads label-addition history; reuse that boundary to bind future
waiting records to the current claim rather than any historical claim by the name.

The current `submit`/deliverables path records PRs and continuing responsibility
independently of active claims. Preserve that distinction: ordinary PR review waits
do not need an extra retained implementation claim. Human questions and native
blocking work can need retained ownership, but release is also a valid choice.

## Priority hypothesis: tested limit

The earlier credential-free probe used the real native rule engine on main 3350161. The existing 33 rule scenarios and 36 blended-queue tests passed, but eleven
assessment candidates placed an owned M/M continuation at rank 12, outside the
default ten. Adding an open blocker still emitted `continue-implementation`.
Therefore neither ownership nor green existing tests proves that unfinished work
remains visible with a truthful action. This observation is recorded on #413; it
is not a production ranking change or evidence about autonomous agent adherence.

## Chosen direction

The owner approved one designated active claim, evidenced retained waits, and the
alternative of explicitly releasing blocked work for someone else. Multiple retained
claims should raise a prominent review task asking the agent to finish, justify,
release or reassign. The amendment in
[blocked-retained-claims.md](../design/blocked-retained-claims.md) specifies that rule,
its shortlist behavior, the minimal activity/question interfaces, and race/retry
limits. The reviewed #378 single-owned-M/M assessment exception remains intact.

The rule engine decides priority and narration from shared facts. Fresh mutation
guards enforce admissibility; a reason or high priority cannot authorize a claim.
Question resolution is explicit and bound to its source, so closing the source
ticket does not erase the obligation. No automatic closure, release or reassignment
is part of this design. Human closure is respected.

## Readiness

After this amendment is reviewed, the design reconciliation #262 is complete.
#412 can implement the coordinated state/guard interface; #413 remains dependent
on that interface, and #414 extends question discovery without inferring answers.
Those implementation tickets still require their own runtime tests and review.
The exact CLI spellings in the contract are planned and must not be advertised as
installed commands before delivery. No human planning answer remains outstanding.
