# Generated action-specific rule reminders

Owner-approved direction, 18 November 2026. Governs separate documentation, native
policy and engineering tickets. This is an architectural contract, not a claim
that action-time obligations are already fully represented in the native engine.
Follow [policy-first delivery](../architecture.md#10-policy-before-integration-and-ticket-types).

The [19 November native-obligation addendum](native-action-obligations.md)
supersedes the separate TypeScript procedural-obligation allowance below. Native
policy must own obligation semantics, applicability and display ordering; the
shared English generator narrates those actual rules. The current hybrid claim
implementation remains migration debt until its policy/integration slices land.
The addendum also defines the early-push/draft-PR duty for pickup guidance.

## Principle and first scope

After a modifying action, where practical, present the applicable current rules in
English so an agent is reminded of its obligations at the point of work. The rules
component selects the content from structured policy and the shared document/English
generator renders it. Commands must not author a second set of policy paragraphs.
Use the effective policy already resolved for the action, not a fresh contradictory
configuration read after a write.

Initial sequence: contract, claim, unclaim/release, then PDB PR submission/attachment.
Each integration is its own ticket. Native policy/obligation gaps come before the
corresponding engineering ticket. Routine work-list reads remain unchanged: their
existing action recommendations/commands suffice. Do not print the whole policy
after every read or add network intake merely to generate reminders.

## Admission reasons versus ongoing obligations

A matched admission rule explains why an action was allowed/denied. A post-action
obligation describes what the agent now needs to do. They are not interchangeable.
Reuse current native decisions and provenance, then author/test only missing
structured obligation coverage. Existing `D-PR-*` follow-up decisions are reused,
not cloned into a new completion/review engine.

The shared rules component accepts action, role, actual outcome and relevant existing
facts and returns stable applicable rule/obligation IDs with source provenance and
coverage. Formal decisions retain their existing hash/validation boundary; authored
purposes and English generation follow [rule-attached narration](rule-attached-narration.md).
If executable selection policy is added, its identity must be included in effective
policy provenance rather than labelled as a narration-only edit. A structured
procedural obligation must be clearly distinguished from a formally validated
admission decision; do not imply prose is an enforced invariant.

Minimal policy data/adapters and decision-matrix scenarios belong in policy tickets.
First establish claim obligations and the shared selector. Reuse that result for
release and submission. Missing purposes/coverage produce an explicit bounded
"not supplied" notice, never an invented sentence or a borrowed rule's explanation.
No runtime LLM translation, rules subprocess, hard-coded renderer role logic or
untrusted issue-body instructions in the generated policy.

## Output contract

After a confirmed successful transition, show a short "Rules for this work" section
with deduplicated applicable IDs and readable English. Bound it to six rules and
2,000 Unicode code points initially; if more apply, show the omitted count and an
exact `pdb rules --rule ID` or full rules reference. The structured result retains
all selected IDs and indicates any text omission. Stable policy-defined ordering,
not command-local priority rules, selects the bounded display.

JSON carries additive versioned `ruleReminders` data: action, actual outcome,
effective rules/narration identity, items (ID, source kind, generated English),
coverage and omissions. Preserve existing mutation receipts and valid stdout JSON.
MCP projections use the same structured result only where that mutation transport
already exists; this contract does not introduce new tools or human authority.
Text is sanitized for terminal controls and treated as plain text by web consumers.

Already-owned/noop results are labelled no-op rather than "you just claimed".
Refused actions retain their actual denial/recovery explanation. Partial/uncertain
writes may show applicable recovery obligations but never claim a successful
transition. A denied action cannot produce newly acquired-owner obligations.
Renderer failure after a successful mutation is a presentation warning; preserve
the successful receipt and never retry the mutation just to repair help text.
If required reminder context/coverage is missing, report that without fabricating
instructions. Admission/infrastructure failures retain their original semantics.

## Claim policy and integration

Use role, actual owner/claim and existing contract facts. Relevant obligations:
follow the ticket acceptance and applicable architecture; respect human ownership
and other agents' claims; surface blockers; preserve/yield work on removal; for an
implementation deliverable, retain responsibility through review/CI/fixes/merging.
These describe the accepted intended content; the policy ticket must bind each to
structured sources and test selection, not paste this list into the handler.

The claim policy ticket supplies the first selector and coverage. Reconcile native
claim admission work (#668 and related #701/#702) rather than duplicating it; adding
reminder selection does not falsely certify those admission migrations complete.
The engineering ticket renders the shared result without changing claim permission.

## Release/unclaim policy and integration

The policy ticket follows/reuses #1018 for explicit human-directed ownership release
and adoption. It supplies only remaining release outcome/obligation coverage, using
the claim selector. Preserve useful unfinished work and share a truthful handoff;
keep GitHub human assignees; distinguish claim removal from submitted deliverable
responsibility; respect human removal without automatic reclaim. Do not reinterpret
existing ready/incomplete/parked/done arguments in this display feature.

Differentiate the agent releasing its own work from a human removing another agent:
the latter must not claim that the tool committed/pushed the displaced agent's files.
A reminder is an instruction, not evidence that preservation happened. Already absent,
failed, partial and human-directed release have distinct expected selections.
Engineering integrates existing release paths and #1019's responsibility operation
when delivered; it does not own their writes/admission.

## Submission policy and integration

PDB `submit` and attaching a required PR are the triggers; creating a GitHub PR is
not itself a PDB command. The policy ticket audits current `D-PR-FAIL`, `D-PR-REVIEW`,
`D-PR-CONFLICT`, `D-PR-MERGE` and `D-PR-INTEGRATE` plus the shared delivery fold.
Only missing submission obligations are added and tested.

Keep explicit ticket/member responsibility through pending review/checks; fix
failed checks, substantive findings and conflicts; merge only with current-head
required CI and accepted review evidence under the configured provider policy;
verify delivery into the intended target before completion. Preserve draft/waiting
states and the accepted distinction between waiting and actionable follow-up.
No busy polling is required. Mere authorship or an issue link does not fabricate
registered membership/responsibility.

The engineering ticket projects actual submit/attach receipts. A partially attached
set, failed label step or unknown write is not a completed submission. Do not infer
that submission grants an unrelated agent ownership or clears all other claims.
No merge bot, PR creation workflow or new admission policy is part of this display.

## Focused acceptance and order

Policy scenarios validate selection by action/role/outcome, rule IDs, provenance,
coverage, ownership/PR responsibility and no new ranking/permission decisions.
Engineering tests validate actual generated output and receipts, omissions,
terminal/JSON framing and failure-after-write behavior with injected boundaries.
No exhaustive native research benchmark is added to routine tests.

Required native order: documentation -> claim policy -> claim display -> unclaim
policy/display -> submission policy/display, with each policy before its display.
Unclaim policy additionally waits for #1018; its integration additionally waits for
#1019. Use native dependencies rather than body text as enforcement. Other future
actions (resume, complete, needs-human, force) get small separate tickets; this
contract supplies the reusable pattern without silently claiming those integrations.

## Ticket map

- #1028: reviewed contract and central principle (documentation only).
- #1029: claim obligations and native reminder selector (policy).
- #1030: claim reminder projection (engineering).
- #1031: release obligations (policy), reusing #1018 admission.
- #1032: release reminder projection (engineering), reusing #1019 writes.
- #1033: submission obligation coverage (policy).
- #1034: submit/attach reminder projection (engineering).

Independent onboarding implementations #1026/#1027 also wait for this documentation
delivery, which includes their focused contract. A closed documentation ticket
does not complete any runtime ticket in this map.
