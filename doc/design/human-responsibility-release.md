# Human-directed agent responsibility release

Owner direction for parent #1014; policy #1018 precedes integration #1019.
This addendum supersedes only the blanket open-PR prohibition for this explicit
operation. Ordinary reset/readiness behavior and unrelated ownership guards remain.
It does not implement release by merging this document.

Owner correction, 19 November 2026: clearing ownership does not exclude the former
owner from future work. This supersedes the earlier blanket removed-agent reclaim
restriction; #1018 must update its native scenarios before dependent integration.

## Small user-visible behavior

Clear the selected agent's ownership of the ticket and its required deliverables;
keep the useful PRs and work. A replacement need not be named first. This applies
when the agent still has a claim and when it has only continuing responsibility
from an earlier submission. Human GitHub assignees are a different axis and remain.

Preserve issue/PR open/closed state, branches/commits, deliverable membership and
targets, blockers, questions/attention, estimates, existing readiness/lifecycle
labels and other agents' claims/responsibility. Do not close or unlink a PR, erase
history, mark completion, add a replacement agent or manufacture readiness.
No new ownership flags, special repository cases or large lifecycle framework.

## Native policy and engineering split

#1018 defines typed facts/decisions for an explicit human release: selected agent,
current claim-start (if present), ticket/member responsibility-record revisions,
permission/provenance evidence and existing PR state. Native decisions admit the
human-directed release despite an open PR; ordinary unauthorized release stays
denied. Facts represent explicit direction separately from agent/client strings.
No arbitrary flag or shared GitHub login independently proves human intent.

The same policy recognizes unowned preserved deliverables as adoptable existing
work for an eligible agent. Ordinary new-implementation admission must not duplicate
an open PR. An eligible agent explicitly adopts/reworks the existing member and
becomes responsible. This may be the former owner: release/removal alone creates
no ban, cooldown or requirement for fresh human permission to return. Preserve
any explicit agent-specific exclusion or other applicable human direction; do
not invent an exclusion from a release record. Adoption continues existing work
rather than opening a duplicate PR. Use the native follow-up/admission model,
not a parallel queue or a fake agent named "unassigned".

An agent must not independently take another agent's active claim. Explicit
trusted human direction can authorize reassignment/override of that default.
Represent actual ownership and trusted direction separately, preserve useful work,
and record the direction and truthful handoff. A shared login, model name, issue
text or arbitrary caller field is not proof of that direction. This clarification
does not waive technical, provenance or revision checks or implement generic force.

#1019 gathers/rechecks facts, invokes that decision and performs bounded writes.
Reuse the existing Human Unassign preview/apply path where available; add a CLI
`deliverables N unassign --from AGENT --reason TEXT` through the same service.
A trusted maintainer CLI request records explicit direction/provenance using current
permission checks; the local agent argument attributes execution, not independent
human authorization. HTTP uses the already-reviewed confirmed human write session,
not new authentication machinery. No generic --force prerequisite.

For active claims, reuse exact claim-start checks and release-intent/outcome records.
For continuing responsibility, extend the append-only delivery record vocabulary
with a dedicated `unassign` operation, selected `from` agent, expected ticket/member
responsibility revisions and operation ID. Keep version compatibility explicit:
a reader unaware of the new operation must report unknown rather than skip it.
Do not overload `reset`, whose readiness plan and open-PR semantics remain useful.
Update parsing, fold, trust and schema fixtures together; retain existing records.

The trusted fold clears only responsibility still held by `from` at the guarded
revision, recording the new responsibility revision while keeping members and
membership. Different member owners remain unchanged. Already unowned is a no-op;
a replacement owner is a conflict, never silently removed. Reject mismatched
selected ownership before writes. When ticket and member owners differ, preview
exactly which selected-agent obligations will clear; do not infer a global release.

## Concurrency, visibility and recovery

Preview identifies selected ownership and preserved fields. Re-read full trusted
history, permission and relevant native facts immediately before writes. Record
intent/actual outcome; remove only the selected unchanged agent label, never replace
the entire label/assignee set. Reuse guarded comment/label writers. GitHub does not
provide a distributed transaction: surface partial outcomes and a bounded reconcile
by operation ID; no blind retries or rollback over newer ownership.

No agent label on #891/#930 is not a successful release: their delivery responsibility
must also clear. An open PR does not by itself prohibit this transition. Invalidate
existing ticket/PR/team/briefing views after confirmed/uncertain writes. Expose the
preserved unowned PR follow-up without inventing a new lifecycle label. #1018 must
admit adoption even if status:awaiting-review is preserved; do not make the ticket
unpickable by leaving obsolete admission assumptions in TypeScript.

## Focused acceptance

Policy matrix: active claim, responsibility without claim, already released,
unauthorized direction, replacement owner, other member owner, unowned PR adoption,
former agent eligible to claim/adopt unowned work, an applicable explicit exclusion,
another agent's active claim, and trusted human-directed reassignment. Distinguish
explicit future pickup from falsely retaining responsibility after release.
Engineering checks cover #891/#930 with
open #998/#999, exact record/label outcomes, parser/fold compatibility, all preserved
fields, stale claim-start/revision, partial writes and lost responses/retry.
Policy alone does not complete #1014; only actual release and subsequent adoption
behavior do. The [Human Unassign](human-unassign.md) UI contract and
[delivery owner clarifications](delivery-owner-clarifications.md) are refined by this
addendum only for explicit responsibility release; no unrelated UI work is required.
