# Human-view Unassign: releasing a claim and its GitHub assignment

Status: proposed contract for #588, delivered under #589. Nothing here is implemented by this document. Sections headed "Shipped today" describe current behaviour and cite the implementing file; everything else is a proposal. The read-only human view (#458) does not wait for this feature.

## Human-ownership amendment (#662 / #663)

The proposed [human-assignment contract](human-assignment-safeguard.md) supersedes the earlier coupling of agent claim release and GitHub assignee removal once reviewed and merged. GitHub assignees are human owners; agent labels are independent claims. The later owner explicitly requires preserving human assignment, blockers, questions and workflow state when an agent is unassigned. Existing `release --as` readiness changes are not a state-preserving alias.

If a ticket's human assignees positively exclude the agent's employer, the narrow recovery parks unfinished work, releases only that agent's claim and posts the reason. A transient unreadable assignment is not proof of reassignment. Do not implement the older assignee-removal options below on an agent-facing path; a separate human ownership editor is not part of this mission. The earlier sections below preserve design history and require reconciliation before #588 runtime work.

## Owner decisions (settled)

From #588 and its owner comments, adopted without reopening:

- One reusable **Unassign** control, shown initially only where tickets appear in the **human** view. Designer and implementer editing is later.
- Confirm before mutating, showing exactly whose PDB claim and which GitHub assignment will be removed.
- Ownership only: human-attention questions, waiting reasons, native blockers, assessments and ticket state are preserved. Never close the ticket, resolve a question or mark delivery complete.
- Remove only the GitHub assignee corresponding to the released claim and keep the others. When the mapping is ambiguous, require explicit selection. Shared-account agent names are not GitHub usernames.
- A human role selector is not authentication or authorization.
- Success means claim and assignment are consistent. If either write fails, show which succeeded, the remaining inconsistency and a retry path. Never roll back over newer ownership or remove unrelated assignments.
- Invalidate affected ticket, ownership and briefing views after writes. No bulk release and no automatic stale-work repair.

## Shipped today

- **Claims are labels.** A claim is an `agent:NAME` label (`workflow.ownerPrefix`, `src/workflow/definition.ts`); ownership is read only from those labels (`src/workflow/team.ts`).
- **Release** (`planRelease` and `applyPlan` in `src/workflow/claims.ts`) releases only the caller's own claim (`NOT_CLAIMED` otherwise) with a mandatory outcome `ready|incomplete|parked|done`. It re-reads the ticket live, finds the claim start from the label timeline (`claimStart`, bounded by `claimHistoryPages = 3`), posts a handoff comment carrying `<!-- github-triage:release:<hash> {json} -->` with `ReleaseRecord { v: 1, agent, outcome, target, remove, retained, claimedAt }` **before** changing labels, then removes the owner label and conflicting readiness labels and adds the target. The operation hash is over repository, number, agent and claim start. Retries: record present and label gone is `noop`; record present and label still there re-applies the recorded plan; a different outcome is `RELEASE_PENDING`. Refusals include `TICKET_NOT_FOUND`, `NOT_AN_ISSUE`, `EVIDENCE_INCOMPLETE`, `MARKER_UNVERIFIED`, `RELEASE_DIVERGED`, `RELEASE_PENDING`, `NOT_CLAIMED`, `TICKET_CLOSED`.
- **Trust.** Marker authority comes from `newestTrusted` with `permissionLookup` and `writePermissions` (#212) in `src/workflow/claims.ts`. The CLI does not check the caller's permission; the agent name is an argument.
- **Preservation.** Release leaves `status:blocked`/parked (`claimPolicy.held`), `status:needs-design`, question and attention labels, other agents' claim labels (recorded as `retained`) and question or wait comments untouched (`src/workflow/claims.ts`). Retained and waiting claims (`src/workflow/retained.ts`) never release anything.
- **Assignees.** No code writes GitHub assignees. The only reference is the read in `ticketGuard` (`src/workflow/claims.ts`), whose freshness fingerprint includes assignee logins. No agent-name-to-login mapping exists (`src/config/identity.ts`, `src/workflow/team.ts`).
- **Serve writes.** None exist; the only POST is `/api/v1/refresh` (`src/serve/api.ts`). The edit-enable flag, anti-CSRF session, fresh permission check, `operationId` and `expectedRevision` are proposed in [dashboard-assessment-edits.md](dashboard-assessment-edits.md) (#455), not shipped.

## Service

Proposed `planUnassign` / `applyUnassign` in `src/workflow/unassign.ts`, reusing the release planner's reads, guards and record writer rather than copying them. The CLI gains `pdb unassign N --agent NAME --by HUMAN [--assignee LOGIN ...|--no-assignee] [--json]` so the web control and the CLI share one service.

```ts
interface UnassignRequest {
  repository: string;
  number: number;
  agent: string; // the claim being released
  by: string; // explicit human name: provenance only, never authority
  assignees: string[]; // exact logins chosen to remove; [] means remove none
  expected: { revision: string }; // fingerprint the confirmation was built from
  operationId: string; // client-generated, for idempotent retry
}

interface UnassignPreview {
  ticket: { number: number; title: string; url: string };
  claim: { agent: string; since: string | null };
  assignees: Array<{ login: string; selectable: boolean }>;
  preserved: string[]; // labels and records that will not change
  revision: string; // current ticketGuard fingerprint
}

type UnassignResult = {
  schemaVersion: 1;
  kind: "unassign-result";
  operationId: string;
  status: "applied" | "noop" | "refused" | "partial";
  steps: Array<{
    step: "record" | "claim-label" | "assignee";
    target: string; // e.g. "agent:kavya_sabbagh", "assignee:octocat"
    outcome: "applied" | "already" | "failed" | "not-attempted";
    message: string | null;
  }>;
  remaining: string | null; // the inconsistency left, in words
  retry: string | null; // exact CLI command, also used by the web retry
  code: UnassignErrorCode | null;
};

type UnassignErrorCode =
  | "NOT_CLAIMED" // the agent no longer holds the claim
  | "OWNERSHIP_CHANGED" // revision differs from the confirmation
  | "ASSIGNEE_NOT_PRESENT" // a chosen login is no longer assigned
  | "PERMISSION_DENIED" // host gh credential lacks write/maintain/admin
  | "PERMISSION_UNKNOWN"
  | "EVIDENCE_INCOMPLETE"
  | "TICKET_CLOSED"
  | "OPERATION_CONFLICT"; // same operationId, different request
```

Rules:

1. **Preview** reads the ticket live and returns the claim, the current assignees and what will be preserved. No assignee is preselected: there is no reliable mapping from agent to login. The human chooses zero or more of the listed logins.
2. **Authorization** is the fresh permission of the host's `gh` credential on the repository (write, maintain or admin), checked immediately before applying, as #455 specifies. Unknown permission refuses. `by` is recorded, never trusted.
3. **New-operation preconditions** apply only when no trusted unassign record with this `operationId` exists on the ticket: live re-read; the agent still holds `agent:NAME`; every chosen login is still assigned; the `ticketGuard` fingerprint equals `expected.revision`. Any difference refuses with nothing written and a fresh preview.
4. **Order:** (a) post the release record comment, extended additively with `by`, `kind: "unassign"`, `operationId` and the chosen `assignees`; (b) remove `agent:NAME`; (c) remove each chosen assignee with the REST issue-assignees removal endpoint. Readiness labels are handled per open question 1. Nothing else is touched: other `agent:` labels, `status:blocked`, question, attention and needs-design labels, assessments, native dependencies and comments stay.
5. **Partial failure and retry.** Each step is guarded by `ticketGuard` and reported individually. When a trusted record with this `operationId` already exists, the request is a **retry** and is validated against that durable record, not against `expected.revision` (which the operation's own comment and label changes have already altered):
   - the request must equal the recorded one (agent and assignees), otherwise `OPERATION_CONFLICT`;
   - the claim-label step is complete if `agent:NAME` is absent; if present, it is removed only when the timeline shows no `agent:NAME` label added after the record's `createdAt` (a later add is newer ownership and is reported, never removed);
   - each recorded assignee is complete if absent; if present, it is removed only when no assignment of that login happened after the record's `createdAt` (from the issue timeline's assigned events, bounded like `claimStart`); otherwise reported as newer and kept;
   - if that timeline evidence is incomplete, the step refuses with `EVIDENCE_INCOMPLETE` rather than guess. The result names the remaining inconsistency, for example "claim released; assignee octocat still assigned", and the exact retry command.
6. **Idempotence.** A retry whose steps are all complete is `noop`; same `operationId` with a different request is `OPERATION_CONFLICT`.
7. **Cache.** After any applied step the serve cache invalidates the ticket, team and briefing entries for that repository using the #455 generation guard, so no view shows pre-write ownership as current.
8. Old release-record readers ignore the additive fields; the record version stays 1 because existing parsers accept extra keys (`releaseRecords` and `allReleases` in `src/workflow/claims.ts`).

## HTTP API and control

- `GET /api/v1/tickets/{n}/unassign?repo=R&agent=NAME`: the `UnassignPreview`. Read only.
- `POST /api/v1/tickets/{n}/unassign?repo=R` with `UnassignRequest`, under the #455 write session (edits enabled, same-origin, JSON, session cookie plus `X-PDB-CSRF`). Status: 200 applied or noop, 207 partial, 403 permission or session, 409 `OWNERSHIP_CHANGED`/`NOT_CLAIMED`/`ASSIGNEE_NOT_PRESENT`/`OPERATION_CONFLICT`, 422 `EVIDENCE_INCOMPLETE`/`TICKET_CLOSED`.
- The control appears beside each claimed ticket in the human view only when edits are enabled. Activating it loads the preview into a dialog: "Release `agent:NAME`'s claim on #N", the assignee checkboxes (none ticked), the preserved list, and Confirm/Cancel. Confirm sends the request with the preview's revision. Results list every step's outcome; partial results show the remaining inconsistency and a Retry button that resends the same `operationId`.
- Accessible dialog with focus management, keyboard use, escaped text and no inline script under the dashboard CSP. MCP stays read-only.

## Test matrix (injected GitHub, clock, permission)

One and several assignees; zero assignees; claim absent; chosen assignee no longer present; another agent's claim and other assignees preserved; blocked, question, attention and needs-design labels preserved; owner changed after preview; each step failing in turn, then retry; retry after a newer claim or assignment (no rollback); permission write, read and unknown; same and conflicting `operationId`; concurrent unassigns; cache invalidation; hostile titles and logins escaped; no secrets in output.

## Implementation slices

1. **Service and CLI** (`pdb unassign`), after open question 1. Checks: all rules above with injected boundaries; CLI and JSON output; no behaviour change to `pdb release`.
2. **Preview and POST API** after #455's write session ships. Checks: session, Origin and edits-disabled refusals; status codes; cache invalidation.
3. **Human-view control** after #458 ships. Checks: dialog, no preselection, partial and retry flows, accessibility.

## Open questions for the owner

1. **What happens to readiness when a claim is unassigned?** Claiming removed the ticket's readiness label (for example `status:ready`), and the claim marker does not record which. Options: (a) add `status:ready` unless the ticket is blocked or needs design; (b) let the human choose the readiness in the dialog, as `pdb release --as` requires; (c) add no readiness label, leaving the ticket unpickable until someone triages it. Proposed default: (b), with `ready` preselected only when no blocker, question or needs-design label is present.
