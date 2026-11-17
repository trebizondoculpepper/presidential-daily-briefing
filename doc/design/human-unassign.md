# Human-view Unassign: release an agent claim, preserve human ownership

Implementation contract for #588, reconciled under #751. Supersedes the earlier
proposal to remove a mapped GitHub assignee and to restore a readiness label.
Those earlier proposals are historical, not an alternative implementation path.
The shared [human-assignment contract](human-assignment-safeguard.md) and
[native workflow decision boundary](workflow-policy-boundary.md) remain authoritative.
This document alone implements no control or runtime mutation.

## Owner decisions

- Start with one reusable Unassign control wherever tickets appear in Human mode.
- Confirm which agent claim will be released before any write.
- Release means ending that agent's responsibility for the active claim; it is
  not evidence that work is fixed, ready, delivered or complete.
- Preserve every GitHub human assignee, including multiple assignees. No mapping
  from agent name to a human username is required or permitted for this operation.
- Preserve ticket state, readiness labels as currently observed, native blockers,
  questions, attention, estimates, comments, work links and other agents' claims.
- Do not automatically reclaim the task because the same human still owns it.
  The removed agent follows #692's work-preserving handoff when it observes removal.
- Human ownership editing is a separate feature. Unassign never transfers or
  clears human ownership as a side effect.

## Shared service and native decision

Add one transport-neutral preview/apply service, used by the Human page and any
future CLI/MCP surface. Reuse existing claim/delivery reads, trusted records,
operation IDs and writers. Do not call `release --as ready` or `--as done` as an
alias: those commands have different lifecycle effects.

Preview identifies repository, issue, exact agent and claim-start identity,
current human assignees, observed labels/state, permission evidence and revision.
The native rules receive these facts and trusted human-request context and emit
an Unassign decision, reason and witness set. TypeScript validates literal input,
resource/protocol binding and executes only the approved plan; a role dropdown or
`by` string is never human authorization. Preserve #668/#701/#702 admission rules
and explicit-human-direction precedence rather than invent a page-local policy.

The request contains an unguessable operation ID, the exact selected agent and
claim-start identity, and the revision returned by preview. The shared operation
re-reads the issue and native decision immediately before writes. A newer or
replaced claim is a conflict, not the old claim to be removed. Missing/unknown
claim history is shown in preview and cannot prove an autonomous destructive
operation; any permitted human override remains explicit and separately recorded.

The plan has only two write kinds: a trusted release-intent/outcome record and
removal of the exact `agent:NAME` label. It must never patch the whole label or
assignee set. No readiness/lifecycle field is added or removed. If no selected
claim remains and no replacement appeared, return an idempotent no-op. Never
release another claim that happens to reuse the same label after its start changed.

Submitted contributions and historical delivery records remain visible, not
marked complete or deleted. Human removal is not a reason to auto-claim rework;
follow-up and explicit responsibility handoff use their existing native decisions
and services. This control does not invent a recipient for an unfinished PR.

## Write boundary and result

Reuse [dashboard-assessment-edits.md](dashboard-assessment-edits.md)'s opt-in
served-write session, same-origin/Host guards, CSRF protection, bounded JSON,
verified serving-user permission and literal served repository selection. Shared
session mechanics may be delivered as a small prerequisite service; this control
does not require the entire assessment-edit page to ship first. No GET or page
render performs a release, and read-only mode has no enabled mutation control.

Preview and apply are separate explicit actions. The confirmation names the
claim and states that human owners, blockers and ticket state will not change.
The server returns `applied`, `noop`, `refused` or `partial`, with actual record and
claim-label outcomes, preserved state, sanitized error and a concrete retry or
inspect action. An ambiguous/lost response is not success. Reconcile by operation
ID and exact claim start before retrying; do not blindly repeat a potentially
committed write or roll back over a newer claim. No distributed transaction with
GitHub assignees is necessary because this operation never writes them.

After actual writes invalidate the affected raw claim/ticket and derived briefing,
Human, team and responsibility views through existing services. Preserve partial
facts if the outcome cannot be re-read. The UI explains any remaining inconsistency
instead of silently disappearing the row or reporting it fixed.

## Focused implementation slices

1. Shared native preview/apply service and preserved-state result, with injected
   permission, claim history and write boundaries. Keep the operation independent
   of browser code.
2. Shared protected HTTP binding using the reviewed served-write session, plus
   the reusable Human-mode confirmation and progress/error display.

Tests cover a current/absent/replaced claim; several human assignees preserved;
questions/blockers/state/estimates unchanged; only the chosen label removed;
permission/CSRF refusal; record-only partial failure; lost response and safe retry;
newer claim protection; cache invalidation and human-removal no-auto-reclaim.
Use synthetic facts and focused UI/keyboard/narrow-layout checks. No live release,
assignment, issue closure or new paid agent turn is required for validation.
