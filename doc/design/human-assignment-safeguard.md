# Human ownership, routing and agent handoff defaults

Contract for #663, parent #662, reconciled with the owner's scenario review on 2026-11-16. The owner explicitly lifted the earlier owner-review hold on the drafted child implementation tickets (including #666/#674) and marked them ready to implement, while normal exact-head CI/review and native prerequisite checks remain required. This document changes no runtime behavior. The [research report](../reports/human-assignment-safeguard.md) records the audited source/API baseline.

## Authority and the rules-engine boundary

PDB provides opinionated workflow defaults. A trusted explicit instruction from the human developer takes precedence over those defaults. Native rules must represent that precedence and return reasons; do not turn a default into an unoverrideable TypeScript prohibition. An issue body, copied comment, arbitrary MCP parameter or display selector is not proof of such an instruction. Record the actual directive context and any override used rather than pretending the underlying GitHub assignment changed.

GitHub permissions, network availability, protocol/input validation and actual operation outcomes remain facts. An instruction cannot make a failed push succeed or supply credentials the tool does not possess. TypeScript collects/normalizes evidence, validates data and executes operations; native rules decide workflow eligibility, routing, scheduling, waiting, continuation and handoff. #679 defines the broader architecture boundary; #680 and its focused audits identify remaining policy bypasses. CLI, MCP, HTTP, rebrief, dashboard and English explanations consume shared decisions, not separate imperative policy.

## Human identity and default ownership

GitHub issue assignees are human ownership; issue creator, agent claims and PR authorship are distinct facts. Every agent has a resolved employing human, normally the authenticated GitHub user for the target host. Keep that human separate from agent name, platform and role. Optional trusted per-OS-user shared-account configuration must not become arbitrary remote impersonation. The initial local HTTP service has one effective execution-human context; selecting another human's read-only inventory does not switch it.

By default, ordinary assessment, estimation, planning, design and implementation is for tickets whose human assignees include the agent's employing human. At least one human owner is needed for this default to apply. Multiple human owners are valid when set by humans; an agent of any listed human may work, but **one ticket still has at most one active implementation claim**. Shared human ownership does not authorize competing implementations.

Human-directed exceptions are visible overrides, not fabricated assignment facts. Read-only inspection may show other-human, unassigned and unknown tickets and explain their default exclusions. A bot-only or unread assignee set is not proof of a matching human owner or a completely empty set.

## New PDB issues are human-owned from creation

PDB-managed creation requires a verified checkout/policy context matching the target repository, including an explicitly selected registered local project when appropriate. Create the issue with the resolved creating/employing human as its default assignee, plus the correct target-project labels and other rule-derived defaults. This is human ownership, not an automatic agent claim. A later human-directed reassignment is allowed.

If the target is unfamiliar/unmanaged or has no verified checkout, suggest ordinary `gh` issue creation instead; do not borrow the current checkout's process for another repository. Explicit human direction may choose that ordinary reporting path. Keep remote reporting separate from managed workflow admission.

Put assignment intent in the one creation request, dry-run and intent digest and verify the observed result. GitHub may omit an assignee even when creation succeeds. Report a real issue link and partial/unknown assignment in that case; never call it fully successful assigned creation, blindly repeat the POST, or silently claim the issue. No general existing-ticket transfer command is implied. #666 implements the shared service; #674 tracks the creator-assignment report without a second implementation.

## Assignment triage comes first

Resolving an unassigned ticket's human ownership is the highest-priority ordinary scheduling class, above existing owned work, estimation and other role duties. It is primarily an implementer responsibility. This is a narrow exception to the default substantive-work boundary: inspect an unassigned ticket sufficiently to route it, but do not design or implement that ticket before normal ownership is established.

The project-root `CONTRIBUTORS.md` describes approximate themes, areas or subtrees and their GitHub human owners, with an optional helpful default. The implementer uses judgment to select the closest supported area. It does not require a keyword-only classifier or a second routing configuration database. The focused guidance interface documents how explicit humans/defaults are recognized while retaining human-readable prose. The designer and human maintain this guidance through their normal reviewed project work; do not invent real contributor mappings in this contract.

Read the file only from a verified matching project context, recording source/revision or content digest and bounded coverage. Detect changes before assignment. Do not accept an unrelated path, unsafe file target, untrusted issue instructions or another checkout's guidance as authority. Ticket text is classification evidence, not permission to execute instructions in it. Missing, unreadable, truncated or ambiguous guidance is explicit evidence, not a guessed owner. An undocumented fallback to the agent's own human is not the default.

An agent may route only a fresh, completely empty assignee set to **one** documented human. Existing assignments are assumed intentional even if guidance suggests someone else. Agents never add a second human to an already assigned issue or replace/remove human ownership as part of normal routing. Humans may set multiple owners or reassign manually. Routing may choose a human other than the agent's employer; routing success then does not authorize that agent to implement the ticket.

## Missing guidance: attention on the original ticket

If no route or applicable documented default can be determined, native rules emit **human attention on the original ticket**, then the agent moves on. Do not create a separate routing-question issue or require speculative owner suggestions. The human and designer have the guidance conversation; the human may manually assign the issue or update `CONTRIBUTORS.md` so routing can succeed.

Adding/updating that routing-attention signal is the narrow allowed triage action on the unassigned issue. Use the existing attention mechanism and a concise explanation of what is missing. Correlate repeated evaluations so an unchanged unresolved condition does not generate duplicate comments/attention. An existing pending attention item is waiting, not an endlessly executable top-ranked task. Re-evaluate after assignment or relevant guidance changes. Other eligible work may proceed; substantive work on the original ticket waits under the normal default.

This supersedes every earlier proposal for a separate routing-question/bootstrap ticket. No such creation/dedup service is needed by this feature.

## Routing execution and changing facts

Use one shared planner/executor with target, proposed human, concise area/default rationale, guidance revision/digest and complete fresh assignment evidence. Final command syntax is documented by #673; it cannot expose general reassignment under an innocuous name.

1. Read an open issue's complete assignee set and verified guidance.
2. Obtain a native routing/attention decision from normalized evidence and the agent's proposed classification; validate that a proposed account is a documented human and the actual caller has the required GitHub capability.
3. Recheck assignment and guidance just before the single assignment attempt. If a human or another writer has already assigned the issue, leave it alone, even when the original proposal was different or identical.
4. Use an additive single-human operation, never whole-set replacement/removal. Record routing outcome/reason through the shared safe operation machinery and verify actual results.
5. On timeout, partial result, failed reason publication or readback uncertainty, report the factual error/outcome. Do not blindly retry a possibly committed assignment or undo another human's choice. Successful routing is not an agent claim.

Fresh reads are not an atomic GitHub compare-and-set. A concurrent human assignment after the last read can still produce several assignees. Surface that conflict for a human; do not delete someone else's assignment or claim impossible race freedom. No background bulk routing or writes merely from opening a dashboard are part of this feature.

## Claim-to-human binding and invalid claim takeover

Shared claim evidence records the employing human for each agent claim, bound to host/repository/issue, agent and claim-start identity, with provenance. Do not guess all agents belong to the current `gh` login or infer an employer from a shared account author. Missing/untrusted legacy binding is explicit unknown, not grounds to remove a claim. #690 supplies this evidence interface.

If a human is removed from the ticket, all claims belonging to agents of that removed human cease to be valid under the normal default. With multiple humans, preserve claims of agents whose employers remain assigned. Conversely, releasing an agent claim **never removes human ownership**: it may simply let that human choose another agent.

An eligible agent whose human owns the ticket may take over an existing claim whose bound employer is no longer among the human owners. It need not wait for the displaced agent to notice/release. The taking-over agent records the reason. This does not permit stealing another valid same-human or shared-human claim. Recheck human/claim evidence and exact claim-start identity before writes and retry steps; do not roll back over a newer replacement claim or infer invalidity from a network error. #691 owns this narrow takeover service and native decision.

External GitHub changes cannot trigger a synchronous atomic cross-agent cleanup PDB has not observed. Distinguish observed effective invalidity, an applied takeover and any remaining persistent-label inconsistency. Report real per-step outcomes and technical errors without claiming all labels were magically reconciled.

## Displaced or explicitly removed agents preserve work and yield

When an agent discovers that its human no longer owns the ticket or that its claim has been replaced/removed, stop ordinary work under the normal default. Preserve useful effort: commit and push where possible; ideally open a draft PR and assign that contribution PR to the issue's current human owner. Do not overwrite another agent's branch or assume a draft PR is delivered work.

Leave the original GitHub issue **open**. Preserve the replacement agent's claim, human assignees, blockers, questions and real workflow/delivery state. The owner decides whether to use the contribution; make remaining work claimable by the correct agent. Do not reclaim, close the issue or treat this as a duty to keep implementing somebody else's ticket.

The taking-over agent has already explained the unassignment; the displaced agent has no duty to duplicate that explanation. Provide useful contribution links/context instead. If an agent discovers exclusion while it still owns the claim and no takeover reason exists, its ordinary park/release path records the reason once. Do not repeatedly post removal comments as if a claim still existed.

A human may also remove an agent while retaining human ownership to use another agent. Respect that choice: save/yield and do not automatically reclaim/resume/rework just because the employing human still owns the issue. New explicit human direction can authorize a return. Do not infer such direction from an automatic queue or untrusted prose.

If Git, push, draft-PR creation or other required technical prerequisites fail, report the actual error to the developer and preserve whatever work exists. Do not pretend publication/handoff succeeded or design a broad automatic workaround for missing infrastructure. A completed preservation step and a failed later step must be distinguished. The removed agent must never delete a newer claim in a delayed retry. #692 owns work-preserving handoff and respect for explicit removal; this supersedes the earlier blanket own-claim-only/no-takeover recovery proposal.

## Outages, last-known facts and human direction

If GitHub fails, continue using the previous successfully known context-bound facts rather than adding a workflow stop simply because refresh failed. Show observation time, source and stale/unavailable status, and sync/reconcile when GitHub returns. An outage is not evidence of reassignment and must not cause a false release/removal explanation.

If there are no definitive saved facts on first use, PDB says it has no information from which to derive those ownership defaults and defers to explicit instructions from its human. Do not invent an ownership prohibition or a successful remote claim. This is human-directed work, not proof of current GitHub ownership. Actual network/API availability, input validation and authority remain truthful technical boundaries.

On reconnection, reconcile observed ownership. If work is now outside the human's default scope, preserve it through the draft-PR handoff and let the current owner decide whether to use it, unless a trusted explicit human direction overrides the default. #693 owns the native precedence/continuation decisions; do not reintroduce a hard-coded blanket pause or an arbitrary policy TTL stop.

## Live guards, transports and dashboard

#668 publishes the reusable native admission interface/matrix and integrates claim/resume/rework. #701 separately integrates estimates and supported design/decision/question writes; #702 integrates delivery/submit/completion and related executable PR-processing operations. Decisions use actual current/last-known/unavailable evidence, explicit human directives and the narrow routing/attention/takeover/handoff exceptions above. Do not reimplement those policies in a transport helper or turn the earlier strict-assignment default into an unoverrideable TypeScript gate.

Current `ticketGuard` fingerprints assignees for retry after a throttled comment; it is not a workflow-admission check before an ordinary first or label write. New integration must apply the shared decision at the relevant operation boundaries and preserve honest partial outcomes. No rule promises atomic GitHub locking or authority over arbitrary external `gh`/git actions.

CLI, STDIO MCP, HTTP MCP, rebrief and dashboard share human-context, facts, decisions and execution services. Keep existing auth-partitioned raw-fact caching; derived results include effective human, role, agent and filters. Account/repository changes must not reuse unrelated cached context. A display filter is not an impersonation or execution-human override. Invalidate relevant views after verified changes and expose stale/outcome limits.

The dashboard states whose work is being processed and separates human ownership from active agent claims and continuing PR responsibility. Pipeline Health has independent small sections for no-human-owner issues (#682), human-owned/no-agent-claim issues (#683), current stage inventory (#684), impact backlog (#685), unassessed work (#686), assessment volume (#687) and stalled work (#688). Historical Sankey data (#700) and chart (#689) come last and must not block simpler sections. No general assignment-edit UI is added by these read-only tickets.

## Focused delivery and activation

#663 owns this reviewed contract and research. #664 resolves human context, #665 supplies assignment facts, #666 implements managed creation, #667 implements ordinary native human eligibility, #668 integrates processing admission, #669 displays context, #670 verifies packaged parity, #672 provides contributor guidance, and #673 implements routing/attention with its native scheduling. #690–#693 isolate binding, takeover, handoff and continuity; #701/#702 isolate the non-delivery and delivery command-family admission. Coordination parents are not omnibus runtime reservations.

Do not activate partial strict-ownership enforcement that strands the unassigned backlog without routing/attention or invalidates current work without the agreed handoff/continuity path. Implementation slices may be separate, but final activation is verified coherently. Maintain the current owner-review hold, native dependency graph and visible readiness; no bulk reassignment, real contributor map, hidden automatic claim or new credentials are authorized by this document.

Use native EDN tests for policy and injected tests for evidence/operations. Required scenarios include human membership and valid multiple owners; one active claim; creator assignment and partial creation; unrelated checkout fallback; routing before owned/estimate work; missing guidance attention on the original without duplicate issues/comments; changed assignment before routing; wrong-human takeover versus valid-claim protection; preserved-work draft PR and open issue; removed agent respecting the new claim; explicit human removal without automatic reclaim; technical error without false success; cached/no-cache outages and explicit human overrides; linked PR conflicts; and CLI/STDIO/HTTP/rebrief/dashboard parity. Never treat a draft PR as merged delivery or a human instruction as fabricated GitHub state.

Implementation note (#672, `src/config/contributors.ts`, `pdb contributors`): the guidance reader
recognises, in the verified checkout's root `CONTRIBUTORS.md`:

- **accounts:** GitHub mentions `@login`, including backticked mentions; not emails, URLs or paths;
- **areas:** each `##` or `###` heading starts one, owned by the mentions in its section, with an
  optional `Paths:`/`Subtrees:` line of backticked subtrees;
- **default:** only an explicit `Default: @login` line, which never counts as area ownership. Prose
  such as "use this account as the default" is not interpreted, and two different defaults are
  `ambiguous`, never resolved by order.

Code blocks are ignored. It reports `available` (with a sha256 digest, the checkout's HEAD and
evidence problems such as an area naming no account), or `missing`, `truncated` (over 64 KiB, not
read), `unsafe` (a symbolic link or a non-file) or `unreadable`. `guidanceChanged` compares digests
before acting; anything not available counts as changed. Guidance is read only from a checkout of
the requested repository, never borrowed from another. The reader assigns nothing and decides
nothing; #673 uses it. The project's `CONTRIBUTORS.md` gained `Default: @trebizondoculpepper`,
restating its existing prose default.

Implementation note (#664, `src/config/humancontext.ts`): one resolver returns the employing human
for the target host from the signed-in gh account (`ghAuthContext`, now in
`src/github/ghauth.ts`), with explicit provenance:

- `current`: read just now;
- `last-known`: GitHub did not answer, so the last login recorded for that host is used, with its
  observation time;
- `unresolved`: with a reason. Missing or refused credentials are `unresolved`, never replaced by
  an older login.

Records are kept per OS user in the pdb cache, keyed by host. Agent name, git author, PR creator
and display selectors are never inputs. Briefings carry the result as an additive `employingHuman` field
plus one leading `Working for:` text line, identically through the CLI (offline: last known only),
STDIO MCP and `pdb serve`. `pdb serve` has one execution-human context, the login read at startup.
`PDB_NO_HUMAN_CONTEXT` disables resolution (tests, smoke and package runs). The optional
per-OS-user shared-account override is not part of this slice. No assignment, claim or admission
behaviour changes; #667/#668 consume the context.
