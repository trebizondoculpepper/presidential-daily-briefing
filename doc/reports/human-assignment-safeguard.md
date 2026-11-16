# Human-assignment safeguard: research and owner refinements

Research for #663, parent #662. Source baseline: `abcee7c452f25beb64683e61a2b4699f8f4b7506` (main, 2026-11-16). This report documents findings and recommendations; it does not implement eligibility, change configuration, or transfer existing human assignments.

## Owner decisions

The final discussion supersedes the earlier suggestion to merely lower the priority of unassigned or other-human tickets. Agents must know which human they work for and only process that human's assigned tickets. Assessment, estimation, planning, design and implementation all count as processing. An existing agent claim does not override a different human's assignment. The subsequent owner refinement permits implementers to triage completely unassigned tickets using CONTRIBUTORS.md, ahead of all other scheduling. They may assign one documented human or raise a routing-guidance question; they may not alter existing human assignments. Read-only listings may explain exclusions. Normal assessment/design/implementation still waits for human ownership.

Human ownership is GitHub assignment, not ticket authorship, a new label, an agent name, or delivery responsibility. Ordinary account-per-human use should need no redundant identity setting. The authenticated GitHub account supplies the default context. The owner also requested a visible dashboard statement of whose work is being processed, and originally requested a default human assignment when a new ticket is created. Multiple human assignees are valid when set by humans, and work is permitted when the agent's human is included. On a positive reassignment away from its human, the agent parks work, releases its own claim and posts a reason, preserving human ownership and ticket state. The designer and human maintain helpful contributor guidance and defaults; unclear guidance requires a separate question, not implementation of the original ticket. The proposed contract is in [human-assignment-safeguard.md](../design/human-assignment-safeguard.md).

## Verified findings in the repository

| Boundary                | Current implementation at the baseline                                                                                                                                                    | Consequence                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collected facts         | `src/github/types.d.ts` has no issue assignee field; `common` in `src/github/github.ts` requests labels and comments, not assignees.                                                      | The rules cannot currently distinguish own-human, unassigned, other-human and unread assignment. Adding only a rank key cannot work; unassigned routing also needs positive complete-empty evidence. |
| Agent identity          | `src/config/readidentity.ts` resolves an agent name from explicit selection or local entries. It is not a human-principal resolver.                                                       | Keep agent, human, role and authentication separate. A role or agent argument cannot confer human ownership.                                                                                         |
| Live claim admission    | `readTicket` and `planClaimFor` in `src/workflow/claims.ts` inventory agent labels and enforce claim/readiness conditions.                                                                | Admission needs explicit human-assignment evidence too; an agent claim is insufficient.                                                                                                              |
| Concurrency fingerprint | `ticketGuard` in `src/workflow/claims.ts` includes assignee logins; `src/github/commentwrite.ts` compares the fingerprint on throttled-comment recovery, not ordinary first/label writes. | Reuse its fingerprint shape, but add new human admission checks before first writes, label writes and recovery steps; the existing retry guard is not those checks.                                  |
| Assessments             | `src/estimation/estimate.ts` reads metric labels/provenance without a human-assignee predicate.                                                                                           | Guard estimates directly. Hiding an assessment in a briefing does not prevent an explicit command.                                                                                                   |
| Creation                | `src/workflow/issuecreate.ts` resolves the authenticated `user`, records `viewer`, and verifies creation identity/labels. Its request/help has no assignee intent.                        | Reuse its single-attempt/partial-outcome model and extend intent and verification; do not bolt on an unverified second assignment write.                                                             |
| Shared service          | `src/briefing/service.ts` serves full/focused and bounded-shortlist paths.                                                                                                                | Human eligibility must apply before executable action selection in both paths, while preserving coverage and omission disclosures.                                                                   |
| Cache                   | `src/serve/cache.ts` keys raw collected results by auth host/login, repository, collector and canonical coverage; `AuthContext` in `src/serve/types.ts` is host/login.                    | Authentication isolation already exists. Reuse it; audit personalized projections and any added human override rather than replacing the cache.                                                      |
| Unassign contract       | `doc/design/human-unassign.md` proposes optionally removing GitHub assignees with an agent claim.                                                                                         | That proposal conflicts with the new human-ownership safeguard and needs a reviewed amendment. Agent release must preserve human assignment.                                                         |
| Unified role list       | `doc/design/unified-activity-ranking.md`, #652, puts owned obligations first within a shared role pool.                                                                                   | Add human eligibility and a routing-first exception before ordinary ownership/role scheduling. Changed-owner obligations use only the approved claim-release/comment recovery.                       |

These are source findings, not claims that the new feature is shipped. Current ordinary GitHub authorization and claim checks remain as they were.

## GitHub API findings

GitHub supports reading the authenticated user through its existing REST endpoint. Its documentation distinguishes public identity fields from extra private profile data; this feature needs only identity, not email, a new scope request, or new credentials. An application installation identity may not provide a usable human identity; that case must remain unresolved rather than guessing. See [Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), checked 2026-11-16.

The issue creation API accepts assignees, but its documentation says the requested assignment can be omitted when the caller lacks the relevant repository access. A successful issue creation is therefore not proof of successful ownership assignment. The update endpoint also treats its assignee array as a replacement, making an indiscriminate update dangerous to other owners. See [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue) and [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue), checked 2026-11-16.

GitHub exposes assignment and removal as separate GraphQL mutations. We do not need to expose those mutations to agents merely to read assignment or enforce eligibility. The new categorized GraphQL reference replaces the older all-objects entry point; use the [Issues GraphQL reference](https://docs.github.com/en/graphql/reference/issues), checked 2026-11-16. No live reassignment experiment was performed.

## Recommended design boundaries

### 1. Human context is distinct from permission

Use a host-qualified authenticated login as the initial human principal, preserving a stable account identifier when the collector supplies one. Do not derive it from git author, issue creator, PR author, agent name, browser role or ticket text. Re-resolve on credential/account changes. Missing identity means no executable agent work.

For the first HTTP slice, keep one configured human context per local server process, matching its authenticated account. A dashboard may display another human's read-only inventory without changing who the server's agents work for. Do not introduce arbitrary per-call `human=...` authority or imply that localhost is a multi-user authentication system.

A per-OS-user override for a shared/service account needs a documented trusted local configuration boundary. An override is a coordination declaration, not proof of delegation or an increase in GitHub permissions. Keep that optional path unresolved/ineligible until the reviewed design supplies it; ordinary human-account use need not wait for remote multi-user authentication.

### 2. Assignment has more than two states

Normalize complete matching assignment, complete empty assignment, complete other-human assignment, and unknown evidence separately. Missing legacy fields, failed requests and truncated pages are unknown, never unassigned. Do not infer that a ticket lacks the matching assignee from a partial page. Multiple assignees must be visible explicitly; the owner has now allowed multiple human assignees when set by humans. Membership of the current human permits otherwise-eligible processing; agents never add/remove other owners.

Human eligibility is a prerequisite, not a negative score. Completely unassigned work has the explicit contributor-routing exception, ranked above ordinary owned work and estimation. Role affinity, urgency, existing agent ownership, native dependencies and value scoring run only within the resulting permitted activity classes. A human-owned but otherwise blocked ticket still cannot be implemented. An agent-owned ticket reassigned elsewhere becomes a local conflict with read-only recovery instructions. The owner explicitly permits a reason comment as part of parking and releasing only the agent's own claim after a positive human-ownership change. No broader ticket processing or human reassignment is authorized.

### 3. PR work must not infer its human from the author

Use complete, explicit issue/deliverable relationships. For the minimal conservative slice, require all relevant linked issues to be within the current human's permitted scope. Missing or conflicting ownership stays inspect-only. A PR author or GitHub reviewer does not prove human ownership of the feature. Do not fetch arbitrary prose-linked tickets or guess an owner from a single convenient link.

Separate inspection of checks/review evidence from executable PR repair, implementation or merge consideration. Repository-wide health diagnostics can remain visible without authorizing agents to fix somebody else's work.

### 4. Guard the service boundary as well as the list

Audit claim/resume/rework, complexity and impact estimates, design/decision records, needs-human/question updates, delivery changes/completion, dashboard edits and PR-processing recommendations. Pure read-only inspection is allowed. Substantive work and ticket-changing commands require fresh matching human assignment, regardless of how they were invoked.

Use the same normalized predicate and reason codes in rules and command checks; host code supplies evidence and executes guards. Do not run the production engine twice to construct roles. Preserve native blockers, platform requirements, writer permissions, review checks and explicit evidence completeness.

The existing fingerprint only checks throttled-comment recovery. New first-write/label-write admission integration is required; even that will not provide an atomic GitHub ownership lock. Human assignment may change after validation or outside PDB. On positively changed ownership, park/release the own claim with the approved reason comment. On unknown ownership, pause with a local diagnostic rather than inferring a reassignment. PDB cannot prevent arbitrary external `gh`, git or GitHub UI changes. The state-preserving release exception is now owner-approved, but its reviewed service contract must preserve human assignees and readiness/closure state; current release --as has different readiness effects.

### 5. Creation is not takeover

Propose allowing creation only with explicit intent to create a new issue for the resolved human, including that assignment in the one creation request, intent digest and dry-run. No arbitrary existing-ticket assignment operation follows. Verify the returned assignment. If GitHub creates the issue but omits assignment, return the issue link and a partial result; do not treat it as eligible, repeat the POST, or try to claim it.

This creation recommendation reconciles two owner statements and must be explicit in the reviewed architecture contract; it is not an implementation authorization in this report. If creation assignment is omitted, the created ticket remains unassigned and only the guarded contributor-routing workflow can resolve it automatically; do not add a post-create takeover bypass. No live bulk reassignment is required for rollout.

### 6. Dashboard and caching

Show the effective human and its resolution source alongside project/role context. Label ticket human ownership independently from the agent worker and PR delivery responsibility. Explain why another-human/unassigned/unknown ticket is excluded; do not offer a self-assignment button.

Keep raw fact caching within the existing auth identity partition. Derived results must include effective human context along with existing role/agent/filter inputs. A display filter cannot change execution context. On auth changes, do not reuse another account's personalized result. Cache TTL does not substitute for live pre-write assignment checks.

## Minimum scenario matrix

| Evidence / request                                               | Expected behavior                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Complete assignment to current human                             | Eligible for otherwise-permitted assessment/design/implementation; existing independent guards still apply.       |
| Known empty assignees                                            | Top-priority contributor-routing or guidance question; no estimate/design/claim before human assignment.          |
| Assigned only to another human                                   | Read-only exclusion; no write, planning or implementation.                                                        |
| Missing human context or legacy/truncated/failed assignment read | Unknown diagnostic; no executable work.                                                                           |
| Existing agent commitment now assigned elsewhere                 | Park useful work, release only the own claim, and post the approved reason; no human-assignee change.             |
| Blocked issue assigned to current human                          | Existing blocker semantics still hold; ownership is not permission to implement.                                  |
| Caller changes role/agent/display-human filter                   | No expansion of human eligibility.                                                                                |
| Linked PR spans differently owned or unread tickets              | Inspection only; no inference from PR author.                                                                     |
| Human account changes during cached session                      | Re-resolve context and isolate projections; live guards catch stale ownership.                                    |
| Issue creation succeeds but assignment is omitted                | Partial result with real issue link; no second create attempt, automatic takeover or agent processing.            |
| Agent release/unassign                                           | Human assignment, blockers, open questions and workflow state remain preserved per the reviewed release contract. |
| Direct command bypasses briefing                                 | Same human predicate rejects it before mutation.                                                                  |

Use native EDN decision fixtures for eligibility and injected I/O tests for command admission, races and creation outcomes. Packaged CLI/STDIO/HTTP/dashboard/rebrief acceptance belongs to #670. No live ownership changes or new credentials are needed as tests.

## Delivery split and readiness

| Ticket | Deliverable                                                          | Initial impact / complexity |
| ------ | -------------------------------------------------------------------- | --------------------------- |
| #663   | This research plus a separately reviewed architecture contract       | L / M                       |
| #664   | Human context resolver and shared transport plumbing                 | M / M                       |
| #665   | Assignment facts, linked PR evidence, collection/cache compatibility | M / M                       |
| #666   | Verified default-at-creation intent and honest partial outcomes      | M / M                       |
| #667   | Native human eligibility, exclusions and explanations                | L / M                       |
| #668   | Live service admission and state-preserving claim recovery           | L / L                       |
| #669   | Explicit dashboard human context and personalized result isolation   | M / M                       |
| #670   | Cross-surface packaged acceptance and rollout documentation          | M / M                       |

The refined split also adds #672 (contributor guidance/read/question workflow, L impact / M complexity) and #673 (guarded unassigned-routing executor, L / M). Assignment triage precedes ordinary ownership ranking; these are not generic human-transfer tools.

The umbrella #662 is L impact / XL aggregate complexity, not an extra implementation reservation. Native blockers gate implementation; body prose is not a substitute for those edges. #588/#589 need a reviewed correction to the earlier Unassign plan, and #652 must consume the human prerequisite without duplicating identity or guard services.

## Remaining work on this research ticket

The source/API findings and the proposed architecture contract are submitted together for review. The later owner decisions settle top-priority contributor routing, valid multiple human assignees and comment-backed claim recovery. Review must still verify the shared-account trust boundary, concrete routing evidence/concurrency limits, PR association policy and processing-command matrix. Dependent tickets are refined to reflect those decisions. No runtime ticket is made ready by publishing this report alone.
