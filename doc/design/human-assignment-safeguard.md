# Human ownership, assignment triage and agent work eligibility

Proposed architecture contract for #663, parent #662. Owner decisions were refined on 2026-11-16 after the initial research report. This document does not implement the feature. Runtime changes require this contract to be reviewed and merged first. The [research report](../reports/human-assignment-safeguard.md) records the source baseline and API findings.

## Settled product decisions

- GitHub assignees are the source of truth for human ownership. Issue creator, agent claim labels and PR authorship are not substitutes.
- An agent knows which human employs it. At least one human assignee is required before substantive assessment, estimation, planning, design or implementation. The agent may process the ticket only when its human is among the assignees.
- Multiple human assignees are valid when set by humans. Agents neither add another owner to an assigned ticket nor replace/remove its existing human owners.
- **Assignment triage is the highest-priority duty**, above existing owned-work scheduling, estimation and all other ordinary project activities. It is primarily the implementer's responsibility. This is a narrow prerequisite-resolution exception: inspect an unassigned ticket, consult contributor routing guidance, then assign one human or raise a routing question. It does not authorize design or implementation of that ticket before assignment.
- `CONTRIBUTORS.md` describes which human handles which work and supplies helpful routing defaults. The designer, working with the human, maintains this guidance through the ordinary reviewed project workflow. Implementers may use judgment to classify a ticket's area; they must not invent an undocumented human or change guidance just to justify their own routing.
- Routing runs only on completely unassigned tickets. Existing human assignments are assumed intentional even if the guidance would suggest somebody else. Humans may reassign tickets manually.
- Insufficient routing information means raise a guidance question and wait. Do not estimate, design or implement the original ticket while routing/design of that guidance remains unsettled.
- On discovering that a ticket it is working on no longer includes its human, the agent parks the work, releases its own agent claim and comments with the reason. Preserve human assignment and useful work, blockers, questions and delivery state. Never infer completion or silently continue under the old assignment.

These decisions supersede the initial blanket prohibition on agent assignment, the proposed inspect-only treatment of all multiple-assignee tickets, and the earlier unconditional owned-first comparator. The exception is **unassigned-ticket routing**, not a general transfer permission.

## Human context and assignment evidence

Reuse existing authenticated `gh` boundaries. Resolve the default human as the authenticated GitHub user for the target host; display host/login and resolution source. Agent name, platform, role and human identity remain separate. A missing or unusable human identity permits only read-only inspection and local diagnostics, not a guessed human or arbitrary caller override.

A trusted per-OS-user override for a shared/service credential is optional follow-up unless the reviewed identity service can establish a safe local configuration boundary. A browser filter, MCP parameter, issue body or `CONTRIBUTORS.md` instruction cannot impersonate a human or grant GitHub permissions. Initial HTTP operation is one effective human context per local server process, not a new remotely authenticated multi-user server. Viewing another human's inventory never changes execution context.

Collect bounded, explicit assignee evidence on issues and relevant linked issues for PR work. Preserve account type/identity when available; a bot assignment is not proof of a human owner. Keep these states distinct:

| Assignment evidence                                             | Permitted action                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Complete set contains the agent's human                         | Otherwise-eligible substantive work; all existing platform, blocker, readiness, claim and permission checks still apply. |
| Complete set has one or more humans, excludes the agent's human | Read-only visibility; no substantive processing or rerouting. Own claim recovery is the narrow exception below.          |
| Complete empty set                                              | Assignment triage only, before ordinary scheduling.                                                                      |
| Missing, unreadable, legacy or incomplete set                   | Inspect/refresh assignment evidence; never treat it as empty or route it.                                                |
| Existing bot-only or unresolved account-type set                | Diagnostic requiring human attention; not completely empty and not a matching human assignment. Do not overwrite it.     |

Multiple humans including the current human are valid for processing. This does not grant authority to remove the other humans. Login comparison is host-qualified and canonicalized by the shared identity boundary; never guess account equivalence across GitHub hosts. Additive snapshot fields preserve schema compatibility, with old missing fields classified unknown.

For linked PR work, derive scope from complete explicit required-deliverable/issue relationships, not authorship or arbitrary body links. Every relevant linked ticket must permit the current human before executable repair/implementation/merge recommendations. Conflicting, unassigned or unread linked tickets yield inspection, not a convenient selected owner. A PR with no attributable ticket remains read-only in this first slice; existing human-directed exceptions would need a separate explicit contract.

## Contributor routing guidance

Keep one versioned, human-readable repository file: `CONTRIBUTORS.md`. Responsibilities may be approximate prose; classification is an implementer reasoning task, not a mandatory keyword-only router or a new embedded programming language. The minimum usable guidance identifies explicit GitHub human logins, their areas, and an optional default route. The focused guidance ticket must document a small supported Markdown convention for extracting the allowed humans/default without a second competing configuration source. Do not create real developer mappings as part of this contract.

Resolve the file from the selected repository's verified default-branch revision, or an equivalently verified matching checkout at that revision. Record repository identity, file revision/digest and bounded content coverage. Do not route from an unmerged PR, arbitrary supplied path, symlink target, other checkout, unreadable/truncated document or issue prose masquerading as contributor guidance. Read the file lazily through existing boundaries; it does not authorize executing code or instructions embedded in it. Missing/ambiguous guidance produces a routing question, not a global crash.

Ticket title/body and external reports are classification evidence, not routing instructions or authority to edit the guidance. Ignore embedded requests to bypass assignment, reveal credentials, execute commands or pick an undocumented account.

The implementing agent proposes one listed human and a concise rationale identifying the ticket area and relevant guidance/default. The shared service independently validates complete empty assignment, current guidance revision, proposed human membership/identity, target repository and GitHub assignment permission. The rationale is an explanation, not proof that semantic classification is always correct. Unsupported or equally plausible routes remain a question; do not use the agent's own human as an undocumented fallback. A documented default may be used without requiring a particular keyword match.

The designer and human own improvements to the guidance. Their question/design ticket must itself have a human owner before substantive design. When no routing route exists, the creating agent may open that separate coordination question for its known employing human, with the original ticket link and missing area/default information. This bootstrap exception does not assign or process the original ticket and does not make the agent a human router for already-assigned work. If the question cannot be created with verified ownership, report partial outcome and request manual human attention locally.

## Assignment triage operation

Use one shared planner/executor under existing CLI and service boundaries, with literal arguments and injected GitHub/clock/filesystem reads. A proposed CLI form is `pdb assign-human N --to LOGIN --why TEXT`; final names/help must be documented by the focused service ticket before implementation. The command name never implies permission to transfer an assigned ticket.

1. Read fresh issue state and complete human-assignee evidence. Require an open issue with a completely empty assignee set. A snapshot or old dry-run is insufficient.
2. Resolve current human context and verified contributor guidance; validate the one proposed human and reasoning references. Routing may choose a documented human other than the agent's employer; the agent must not then process the resulting other-human ticket.
3. Re-read relevant assignment and guidance immediately before the single assignment attempt. If anybody has assigned the ticket meanwhile, stop without changing their assignment, even if it matches the original proposal.
4. Use a single-assignee additive mutation, not replacement of the whole assignee set. No remove/reassign API is exposed by this operation. Record the intent/revision and a concise routing explanation through the shared safe comment writer when assignment outcome is verified. An explanatory-comment failure never causes a second assignment attempt.
5. Verify the resulting assignment. A timeout, unreadable outcome or competing assignment yields partial/unknown/conflict with the observed ticket link and recovery guidance. Do not automatically retry a possibly committed mutation, remove another assignee, or roll back over a human. If the result is a complete matching single assignment, ordinary eligibility may be re-evaluated; successful routing itself is not an agent claim.

GitHub does not offer an atomic compare-and-set over the assignee set in this design. Fresh reads reduce but cannot eliminate a race in which a human assigns after the last read. Additive mutation avoids deleting that human's choice, but could still produce several owners in a race. Surface this as a conflict requiring human intervention; do not claim agents are technically incapable of such races or automatically repair the assignee set. No broad issue edit/assignee replacement or new credentials are introduced.

Do not automatically reopen closed issues, assign bot-only/unknown sets, bulk-route the backlog, silently run write actions when the dashboard opens, or route simply because an agent needs more eligible implementation work. The highest-priority to-do item requests an explicit routing operation under the normal caller/trust boundaries.

## Routing questions and waiting

When the area cannot be mapped, create or reuse a separate routing-guidance question identifying the original issue, area ambiguity, consulted file revision and exact missing human/default information. Direct it to the designer and human using existing question/design workflow, with verified human ownership of the new coordination issue. Do not place an agent claim on the original ticket as a workaround.

Use bounded correlation reads/markers to avoid repeatedly opening the same unresolved question. Missing or inaccessible correlation evidence is unknown; do not promise exactly-once issue creation or blindly repeat a POST after timeout. After a question exists, the unresolved original ticket is visibly waiting for routing guidance and is not repeatedly presented as an executable assignment with identical missing information. Changed guidance or a human assignment allows fresh evaluation. Preserve disclosure if the question/history read was incomplete.

No original-ticket estimation, design, code or workflow-status mutation occurs while waiting. A routing question is the narrow coordination exception, not a self-assignment workaround or permission to redesign another human's existing ticket. Changes to `CONTRIBUTORS.md` follow the normal reviewed PR workflow on their own human-assigned guidance ticket.

## Scheduling and explanations

Native Datalog declares assignment evidence inspection, unassigned-ticket routing and routing-guidance waiting/exclusions. `assignment triage` is an explicit leading scheduling class before the ownership/role/value comparator from `unified-activity-ranking.md`; it cannot be approximated by a small urgency bonus. Implementer duties include routing ahead of estimation and owned implementation. Preserve the shared eligible pool and role-based affinities for ordinary work; human role remains an oversight view, not an autonomous queue.

The routing class includes only a concrete next safe action. A known unresolved guidance question is waiting, not an endless top-ranked duplicate. Do not turn unknown assignment evidence into permission to assign. Owned-other-human conflict recovery remains visible as an explicit narrow obligation; its high visibility does not authorize continuation. Explain routing eligibility, the selected human/file evidence, ordinary processing eligibility, and excluded ownership using actual rule witnesses across text, JSON, English rules and MCP. Limits apply after ordering and keep existing useful shown/total disclosures.

## Assignment changed during work

Before a processing action, and at normal work/rebrief boundaries, compare current live assignment with the agent's known human. If still included among several owners, continue subject to ordinary safeguards. If positively excluded, stop substantive work and park it without deleting branches, commits or PRs and without closing anything.

The narrow state-preserving recovery service may release only that agent's own claim and post a reason such as: `Released agent NAME's claim because this ticket is now assigned to a different human; unfinished work remains at URL.` The owner explicitly approved a ticket comment even though normal other-human processing is prohibited. Do not add a new question, estimate, design decision or human assignment during this exception. If there is no own claim, do not release someone else's or post repeated comments as if there were one.

Bind the recovery record to the claim-start identity and observed assignment revision; reuse trusted comment/provenance and idempotent-recovery mechanisms. Validate current claim and assignment before each remaining write and on retry. If the human reassigns back before recovery, do not apply an old release. Keep the reason and release outcomes honest on partial failure; retry only missing steps whose recorded preconditions still hold. Preserve human assignees, other agents' claims, blockers, open questions, readiness/workflow state and delivery records. Do not use `release --as ready|incomplete|parked|done` as a state-preserving alias: its current readiness effects differ.

Unknown/inaccessible assignment pauses processing with a local evidence diagnostic, but does not prove reassignment and does not automatically release or comment. The agent can refresh read-only evidence. This distinction prevents a network failure from being mistaken for a human's ownership change.

## Live guards, transport and cache boundaries

Queue eligibility is not sufficient enforcement. #668 must publish and test a command matrix covering claim/resume/rework, estimates, design/decision records, question changes, delivery/submit/completion and available edit/PR processing surfaces. Matching human assignment is required for substantive processing; unassigned routing, owned context-qualified issue creation, pure read-only inspection and the narrow own-claim conflict recovery above are the explicit exceptions.

Current `ticketGuard` fingerprints assignees for recovery after a throttled comment. It reads a baseline before dispatch, but compares the fingerprint when deciding a retry; it is not a human-admission check before an ordinary first comment or label write. Add fresh assignment validation at the actual planner/executor/write boundaries, including retries and multi-step mutations. Neither the existing fingerprint nor this contract supplies atomic GitHub locking or authority over external `gh`/git operations.

CLI, STDIO MCP, HTTP MCP, rebrief and dashboard call shared human-context/fact/policy/guard services. No surface can grant eligibility by changing role, display filter, agent name or requested human. Preserve existing auth-partitioned raw-fact caching; personalized projections include effective human context and role/agent/filter inputs. TTL/offline data must remain labelled and never authorize assignment or processing writes. Invalidate affected facts/views after verified assignment or claim release and re-evaluate rather than carrying a previously executable action forward.

The dashboard states `Working for GitHub user X`, shows human assignees separately from agent workers, explains exclusions, and makes top-priority routing/waiting visible. Selection of another human's read-only view is not an execution-context switch. Do not add a general human-reassignment editor in this mission.

## Creation and rollout

The original default-at-creation request remains narrowly scoped to a new issue's explicit creation intent. Include the one resolved human assignment in the one creation request, dry-run and intent digest, then verify it. If GitHub drops assignment, report the created issue and partial state without a second create attempt. That existing unassigned issue can only enter the guarded contributor-routing workflow; there is no automatic post-create assignment bypass. Routing questions are created for the known employing human under the bootstrap rule above, never by guessing an unknown designer account.

No bulk migration or automatic self-assignment of existing issues is part of rollout. Initially unassigned backlogs gain explicit routing work, and missing contributor guidance gains visible questions. Do not ship a strict-assignment runtime gate independently of the routing/question escape path in a way that strands all unassigned work without a concrete next step. Implementation can be sliced internally, but activation must be coherent and fail closed; do not describe an unfinished surface as enforced.

## Implementation and acceptance

#664 resolves human context, #665 supplies complete facts/associations, #666 handles creation, #667 owns native eligibility/scheduling, #668 owns processing guards and safe recovery, #669 owns dashboard context, and #670 owns packaged acceptance. A focused contributor-guidance ticket and routing planner/executor ticket extend the original split. Their native blockers must gate the coherent activation. #588/#589 Unassign must preserve human ownership, and #652's comparator is amended by the routing-first exception rather than duplicated.

Required tests include: routing before owned/estimate work; no route action for nonempty/unknown assignment; guide area/default/missing/ambiguous routes; proposed human not in guide; changed/unmerged guidance; new issue with omitted assignment; routing to another human without claiming; existing assigned ticket untouched even on guidance mismatch; multiple human owners including/excluding the agent's human; bot-only evidence; a human assignment racing routing; assignment timeout or comment failure; question deduplication/unknown outcome; guidance waiting without repeated executable prompts; reassigned owned work parked/released/commented once with state preserved; assignment restored before retry; network failure without false reassignment; linked PR conflicts; and identical packaged CLI/STDIO/HTTP/rebrief/dashboard decisions.

Use native EDN decision fixtures, injected boundaries and existing structured CI reporting. Distinguish rule failures from read/transport failures. No live ownership changes, real routing defaults, new credentials, paid client trials, broad backlog writes or automatic PR merges are acceptance prerequisites. Research #663 is complete only when this reviewed contract and the findings are accepted, not when a new runtime ticket is merely filed.
