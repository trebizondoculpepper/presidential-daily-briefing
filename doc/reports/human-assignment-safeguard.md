# Human-assignment safeguard: research and owner refinements

Research for #663, parent #662. Source baseline: `abcee7c452f25beb64683e61a2b4699f8f4b7506` (main, 2026-11-16). This report documents findings and recommendations; it does not implement eligibility, change configuration, or transfer existing human assignments.

## Current decision record

The owner refined the initial strict-assignment proposal through scenario review. The reconciled [draft contract](../design/human-assignment-safeguard.md) is the single current proposal and remains held for owner review. Historical recommendations below have been replaced rather than silently left contradictory.

Human assignment and agent claims are separate. Normal work is scoped to the employing human; trusted explicit human instructions override workflow defaults. New managed PDB issues default to the creating/employing human at creation. Unassigned issues are routed first using CONTRIBUTORS.md; missing guidance creates human attention on the original ticket, not another issue. Multiple human owners are valid but permit one active implementation claim, not competing claims.

An eligible owner-side agent may take over a wrong-human claim and records the reason. The displaced agent saves/pushes useful work and ideally supplies a draft PR assigned to the current owner; leave the issue open and the new claim intact. It need not explain the takeover again. Human removal of an agent within the same domain is also respected, without automatic reclaim. Technical failures are actual errors, not a reason to fabricate successful handoff.

On GitHub failure, continue from last-known context-bound facts and synchronize on return. Without definitive facts, PDB reports that limitation and defers to human instructions instead of inventing defaults. Real permissions, API availability and operation outcomes remain factual boundaries. These decisions supersede the earlier automatic pause, separate routing-question issue, no-takeover and duplicate-explanation proposals.

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

## Policy boundary and unresolved implementation mechanics

The native engine is the definitive workflow-policy source. TypeScript gathers facts, validates data and executes operations. #679 defines this general architectural principle. #676 removes the universal verify assumption; #675 is now coordination for separate review-fact, native review-policy and responsible-agent follow-up slices (#694–#696). #680 coordinates focused PR, lifecycle and queue/transport audits (#697–#699), rather than a single broad runtime rewrite.

The existing ticketGuard fingerprint has a limited role: it is compared for throttled-comment recovery, not an ownership-admission check before ordinary first/label writes. Shared admission requires new integration, and fresh reads still cannot create an atomic GitHub ownership lock. Record claim-to-human bindings rather than infer every agent's employer from one shared gh account. Unknown bindings cannot prove a claim belongs to the wrong human.

Contributor guidance remains approximate human-readable areas/subtrees and GitHub humans/defaults. Its focused interface must expose source/digest/coverage and reject unrelated or untrusted sources; it must not become a second hidden policy system or require a speculative owner when no route is known. Root-checkout identity and remote reporting fallback are explicit creation boundaries.

The reviewed contract and focused runtime work must still verify exact record compatibility, operation boundaries, concurrency/partial outcomes and supported command syntax. No caller parameter or issue prose becomes trusted human authority by assertion. PDB cannot police arbitrary external GitHub/git operations. Draft documentation does not advertise these features as shipped.

## Focused delivery map

| Ticket      | Focus                                                        |
| ----------- | ------------------------------------------------------------ |
| #663        | Reconciled contract/research, held for owner review          |
| #664        | Human identity resolution                                    |
| #665        | Complete assignment/linked PR facts                          |
| #666 / #674 | One creator-assigned creation service and its tracked report |
| #667        | Native ordinary human-work eligibility                       |
| #668        | Shared processing admission integration                      |
| #669        | Visible dashboard human context                              |
| #670        | Packaged activation/parity acceptance                        |
| #672        | Contributor guidance evidence                                |
| #673        | Routing-first assignment and original-ticket attention       |
| #690        | Claim-to-employing-human bindings                            |
| #691        | Invalid-claim takeover                                       |
| #692        | Work-preserving displaced/removed-agent handoff              |
| #693        | Last-known continuity and explicit-human precedence          |

Each runtime slice has acceptance criteria, native prerequisites and impact provenance. The parent is coordination, not a competing omnibus implementation. Pipeline Health is separately split into #682–#688, then final cohort-flow data #700 and Sankey chart #689. Its simpler features do not depend on the chart.

## Scenario coverage

Rules-only decision fixtures and injected operation tests must cover normal human membership, multiple owners/one active claim, assignment/routing races, missing contributor guidance and deduplicated original attention, human-owned creation and dropped assignment, wrong-human takeover and valid-claim protection, preserved-work handoff with open issue, technical failure, explicit agent removal, cached/no-cache outages, human overrides, PR ownership conflicts and cross-surface parity. The draft contract supplies the detailed expectations; publishing the report alone does not unblock implementation.
