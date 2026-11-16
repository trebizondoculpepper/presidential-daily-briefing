# One activity pool, ownership first, role-dependent order

Owner decision, 2026-11-15 (#651); implementation is #652. This reviewed amendment supersedes role-exclusive candidate selection and assessment-over-owned-work ordering in briefings.md, blended-action-queues.md and blocked-retained-claims.md. It changes no runtime until #652 ships. The bounded [native experiment](../reports/unified-role-ranking-spike.md) establishes feasibility, not host integration or this contract's acceptance.

## Membership and authority

Designer and implementer views derive one eligible activity pool from the same normalized facts, identity, platform, configuration and collection scope. Changing only the viewer role changes ordering, never pre-limit activity membership. Generate candidates once; do not evaluate two role policies and union the answers in production. No role-specific fallback queue or separate tier of otherwise hidden work.

The pool includes addressed responses, PR follow-up/review, owned-work management/continuation, complexity estimates, impact assessments, assessment inspection, eligible implementation, and decision/document/review/design preparation. Both roles can see both assessment metrics and design/implementation duties. Metric disablement still removes the corresponding assessment/value classification for both roles; it does not disable ordinary eligible implementation. Human briefing remains a separate audience and policy, never a union of autonomous implementation actions.

Eligibility remains action-specific. Native blockers, outstanding questions, other ownership, open closing PRs, platform restrictions, permission boundaries, freshness and completeness still prevent implementation pickup. An assessment may be possible while implementation is blocked, under its existing assumptions. A role preference cannot manufacture authority or a mutation service. Claim/release/submit/complete retain their explicit checks and the active-claim invariant; membership in a ranked list is not permission to claim a second active ticket.

A genuinely distinct eligible action keeps its stable repository/subject/kind identity even when another action on the same subject ranks higher. Complexity and impact assessments can coexist. If both metrics need inspection, the existing `inspect-assessment` identity combines both sets of findings and repair navigation rather than colliding or silently dropping one metric. Boosted/base variants of the same action collapse through declarative overrides; role changes cannot suppress a competing activity. Linked open PRs continue to suppress duplicate implementation pickup while retaining PR responsibility and useful assessment/inspection actions.

## Ownership scope and blocked obligations

Ownership is positive evidence for the resolved persistent agent, scoped to the collected repository/project:

- the current explicit issue claim, including retained waiting/resume-required work;
- trusted ticket delivery responsibility and required PR responsibility from the known delivery fold, including after submit releases the claim;
- the existing explicit agent linkage for PR follow-up;
- aggregate management/inspection of those positively observed obligations.

Shared GitHub-login authorship, an attention destination, a former claim, queued intention or inactivity does not establish ownership. Unknown delivery/activity evidence remains unknown, with an inspection reason; it cannot prove there are no obligations or authorize an extra claim. Do not infer a cross-repository inventory from one repository's data. Preserve inventory scope, missing members and lower bounds.

Every positively owned unfinished obligation precedes every new/unowned activity, regardless of its value band or the viewer's role. This includes one owned M/M ticket before a boosted assessment: the earlier #378 exception is explicitly superseded. Submitted delivery responsibility is unfinished ownership, not an active-claim slot.

Blocked owned work is represented by a concrete management/inspection activity, never an `implement` or unconditional `continue-implementation` action. Identify the native blocker, unresolved question, wait evidence or uncertainty and offer supported next steps: inspect/advance the blocker, collaborate or answer/escalate the recorded question, hand over delivery responsibility, or explicitly release the claim. Use `pdb ticket N`, `pdb deps N`, `pdb pr N` or `pdb team` for the initial read as appropriate, and include exact supported recovery navigation with the relevant IDs. A generic “continue your ticket” message is insufficient. Missing evidence offers inspection, not invented instructions to remove a blocker.

For owned PRs whose checks/reviews are only pending, do not invent repair or merge work. An owned-responsibility inspection/management row states the specific wait and supported handoff/status navigation; pure waiting details may remain explanatory context. This makes the obligation visible in the same list without claiming pending checks are failures. After inspecting a genuine wait, other admitted work may proceed; rank is not a command to spin on an unchanged status. Rebrief fingerprint suppression remains unchanged.

Multiple-claim review and incomplete-inventory inspection retain #413's aggregate semantics and individual links. One issue is not duplicated merely to inflate the ownership signal. Unassign follows #588: terminate responsibility only, preserving current state, blockers and independent questions. Existing `release --as …` has explicit readiness side effects and must not be advertised as a state-preserving Unassign alias. Until the #588 service is shipped, identify that option as unavailable and offer another supported next step; do not duplicate its workflow in #652. Existing delivery facts survive according to their own contract. No automatic release, reassignment, reopening, closure or switch of active work is introduced.

## Human ownership and routing-first amendment (#662 / #663)

The [draft human-assignment contract](human-assignment-safeguard.md), once owner-reviewed and merged, adds human-scoped workflow defaults and a leading assignment-triage class before the ordinary comparator below. Routing completely unassigned issues using CONTRIBUTORS.md comes before owned work and estimation. Missing guidance produces human attention on the original ticket and waiting, not a new issue or endlessly executable duplicate. The ordinary comparator does not supersede that leading class.

Normal work requires the agent's human among the ticket's human assignees. Multiple human owners permit either human's agent but only one active implementation claim. Eligible owner-side agents may take over verified wrong-human claims with a recorded reason. Displaced/explicitly removed agents preserve work and yield without undoing the handoff, closing the issue or duplicating a takeover explanation. Agent release does not remove human owners.

Trusted explicit human instructions override workflow defaults; native rules express this precedence. On GitHub outages, continue from last-known facts; without definitive facts, report the lack of defaults and defer to human direction. Do not infer reassignment from a failed read. Current/last-known/human-directed evidence and every exception remain explicit in decision reasons. #667 and #673 own ordinary eligibility and routing/scheduling; #690–#693 supply claim binding, takeover, handoff and continuity. These amendments remain gated by the owner's #671 review.

## Explicit comparator

Apply this lexicographic comparison to the complete candidate pool before any display limit. Each earlier key dominates all later ones:

1. **Ownership:** positively owned obligations and required ownership-inventory inspection first; new/unowned actions second. An inventory-inspection row is explicitly uncertain, not a fabricated owned ticket. Otherwise-unknown ownership cannot become confirmed unowned pickup.
2. **Directed attention within that ownership class:** an addressed-response action first. Attention is not ownership and does not move an unowned response above an owned obligation.
3. **Role affinity:** preferred/shared duties before other-role duties. Implementer affinity covers PR delivery follow-up/review, complexity assessment/inspection and implementation. Designer affinity covers impact assessment/inspection, decision/documentation, design review and design/ticket preparation. Ownership management and general evidence inspection are shared. A combined assessment-inspection row is preferred when either affected metric belongs to the viewer's affinity.
4. **Existing lifecycle/value band within the affinity:** actionable PR follow-up (2), active-work-blocking decisions/agreed documentation/design review and ownership management (3), known easy implementation (4), confidence-improving assessment/assessment inspection (5), ordinary eligible continuation/implementation/design/general inspection (6), known unfavorable implementation (7). Directed attention keeps band 1 metadata. Owned-first and affinity are preceding comparison keys, not arithmetic changes to these band values.
5. **Existing within-band preference:** PR failure/review, conflict, merge consideration, then integration refresh; designer decision, documentation, then review; boosted assessment before ordinary assessment/inspection. A current-head clean review and required CI remain prerequisites for merge consideration. Running checks do not create a PR repair action.
6. **Existing discretionary tie keys:** urgency high/unspecified/low, proven immediate-unlock lower bound descending, continuation before otherwise equal new pickup, incomplete before unstarted, creation time ascending, then canonical repository identity, numeric subject identity and registered action kind. Use exact stable rule/identity tie-breaking when the same kind has several matching rules. Conflicting urgency is unspecified with a diagnostic; unknown unlock counts remain lower bounds. Assessments do not receive fictitious unlock credit.

Consequences: own design work precedes new implementation for an implementer; own implementation precedes new impact assessment for a designer. Among unowned work, implementer complexity/implementation duties precede design duties, even an unfavorable implementation before a new design activity. Designer preferred duties precede new implementation. Existing urgent design-unblocking duties still precede discretionary impact assessment within designer affinity; the owner's affinity list does not erase those lifecycle priorities. Own PR repair precedes own ordinary implementation for either viewer. Addressed unowned work remains above other unowned work, while owned obligations remain first.

`--order oldest/newest` changes only unclaimed implementation pickup comparison: coalesce its easy/ordinary/unfavorable bands at band 6 and use requested age direction plus stable identity, ignoring urgency/value/unlock weighting there. It cannot cross ownership or affinity boundaries, reorder PR/design/assessment duties, change eligibility or hide metadata. `--estimate` remains an explicit focused view; equal-membership guarantees compare the two normal role views under identical selection/focus controls, not differently filtered requests.

Native Datalog owns candidate membership, ownership/affinity keys, overrides, comparison declarations, reasons and evidence witnesses. TypeScript supplies normalized facts and executes declared comparison/projection mechanics; it must not introduce role filters or invent explanation text that contradicts the matched rules. Keep the TypeScript rollback behavior aligned with this contract, with explicit parity scenarios; do not silently preserve the superseded scheduler behind the rollback setting.

## Host and output integration audit

Implementation must inspect these concrete boundaries, rather than change a single sort function:

| Boundary                                                           | Required audit/change                                                                                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/decisions.edn`, `rules.edn`, `ordering.edn`, `queries.edn` | Remove viewer-role membership gates for agent activities; declare ownership/affinity comparison and management decisions; preserve human separation and denials |
| `rules/datalog/adapter.ts`, `briefing/blended.ts`                  | Separate activity affinity from viewer role; combine metric inspection witnesses; preserve stable identities and both metrics                                   |
| `briefing/service.ts`, collection shortlist/readplan/hydration     | A role-neutral potential-candidate superset; no missing other-role candidates before rule evaluation; identical hydration scope/budget for a role-only change   |
| `briefing/compact.ts`, role sections, CLI/MCP/serve projections    | Render one ranked list; detail sections do not become hidden candidate sources or another fallback scheduler                                                    |
| Claim admission and command navigation                             | Recheck action-specific readiness/platform/native ownership and active-claim evidence; presentation role adds no bypass                                         |
| TypeScript rollback, help/process/rules explanations               | Same membership/ordering contract and explicit changed policy narration; update former #378 expectations deliberately                                           |

Under a partial collection, describe the candidate/ownership coverage actually known. Do not claim equal global membership from a truncated snapshot, treat unhydrated records as denials, or call an omission evidence of ineligibility. Preserve useful collection notices and fetch budgets. Full-snapshot and bounded-collection tests must separately establish their guarantees.

Keep existing wire schema versions and legacy field types. `rankedActions` remains authoritative; add explanatory ownership/affinity metadata only as an additive, documented projection of native witnesses. Existing `role` remains the requested presentation role; do not silently repurpose it as the activity's responsible role. `band` alone no longer explains global order: ownership and affinity reasons must be visible. Record the changed rules hash and policy revision in the implementation PR.

Limits apply after complete ordering of the known pool. `total`/`omitted` count distinct executable/management/inspection activities, not every raw waiting event or every linked evidence URL. Both roles have the same pre-limit identities/count under identical facts; their bounded visible identities may differ because order differs. Target-only legacy `actions`/`role.next` are stable first-occurrence projections, not an alternative ranking. Keep assessment eligible/ranked/shown counts honest when two metrics coexist. Grouping ownership/linked work must state omitted members. CLI, MCP and serve use the same result and reasons.

## Acceptance and delivery

#651 delivers only this reviewed contract and amendments; do not close #652 from its merge. #652 consumes #413's shared ownership/activity projection rather than implementing a competing fold; its required ranking/projection slices must be merged before runtime integration. Audit current main and implement production changes in a separate PR. Its engine fixtures must extend the seven-scenario spike with:

- exact pre-limit identity-set equality for both roles, including both assessments and combined conflicting-metric inspection;
- own design versus new implementation, own implementation versus boosted impact assessment, one owned M/M versus any new estimate, owned unfavorable versus new easy work;
- owned blocked/question/wait/resume-required and unknown-inventory management, multiple claims, trusted submitted/required-PR responsibility, shared-login non-ownership and explicit release preserving blockers/questions;
- own PR repair/integration versus new work, owned pending CI without fictitious repair, and unowned PR review under both roles;
- platform mismatch/unknown viewer, missing/truncated native/closing/label facts, disabled metrics and unchanged denial sets;
- stable ties and oldest/newest scope, both-role bounded output/omission counts, and more than ten competing assessments;
- role-neutral shortlist/hydration and safe claim admission, plus CLI/MCP/serve parity and TypeScript rollback parity.

Use native EDN rules/scenarios for decision semantics and injected snapshots/clock/gh for host boundaries. Assert identities, order, reasons, witnesses and safe commands rather than exact prose or self-reported compliance. Regenerate the golden parity file only for intentional policy changes and report its new rules hash. Run required checks/build/package smoke as appropriate; no paid model trial or live workflow mutation is part of ranking validation.
