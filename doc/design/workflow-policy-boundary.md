# Native workflow decisions, explicit human direction, and host mechanics

Owner-approved direction for #679, 2026-11-16. This architecture amendment is documentation first; runtime migrations follow in focused PRs. It extends rules-component.md and workflow.md, and supersedes any interpretation of earlier contracts that permits an independent TypeScript workflow policy or makes every opinionated default unoverrideable. It does not claim those migrations have shipped, change this repository's required CI, authorize unrelated human-assignment activation or bypass its recorded prerequisites, or implement a new override command.

## Later owner decision: no rollback scheduler

[Native ranking only](native-ranking-only.md) (#1050) supersedes any compatibility
projection/rollback-option suggestion below. Remove the old scheduler and its
selection controls entirely; there is no alias or alternative-policy fallback.
Implementation remains separate from this contract.

## The decision boundary

All PDB project/workflow judgments about what an agent may do, where and when, what should happen next, and activity priority belong in the native declarative rules engine. This includes eligibility, denials, required project criteria, ownership/workflow conventions, review acceptance, completion prerequisites, follow-up selection and ordering. Rules own matched reasons and evidence witnesses as well as outcomes. A declarative-looking TypeScript constant table or a second embedded workflow interpreter is still a policy source if it selects those outcomes independently.

TypeScript owns fact collection and normalization, literal/schema validation, evidence provenance and coverage, transport binding, configuration loading, generic evaluation mechanics and execution of approved operations through injected boundaries. It also enforces actual protocol/filesystem/security constraints and reports GitHub's real permission/API outcomes. A workflow default cannot be disguised as a security check merely to keep it in a collector, presenter, CLI, cache, hook adapter or mutation planner.

Use this test: if two valid project policies could choose different workflow outcomes from the same valid observations, that choice is policy. If changing it would falsify an observation, parse invalid input as valid, let data escape its selected resource, trust a forged identity, or claim an API operation succeeded when it did not, it is not a workflow-policy override.

| Native rules decide                                                                           | Host mechanics preserve                                                                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Which checks/reviews the target requires; whether an observed state permits progress          | Target repository/base/head, exact check/app identities, raw outcomes, complete or missing requirements evidence                        |
| Which attributed review evidence satisfies a configured policy; which findings require action | Provider payload decoding, authenticated integration attribution, full reviewed SHA, server ordering and coverage gaps                  |
| Claim/admission/resume/release/completion prerequisites and next steps                        | Literal arguments, exact selected subject, observed claims/records, conditional-write/resource binding, API effects and partial failure |
| Ownership-first/role/routing priorities, shortlist candidates and workflow follow-up          | Normalized identity/platform, discovered objects, fetch/resource budgets, stable sorting by declared keys, omitted evidence             |
| Freshness requirements and behavior on stale/unknown workflow evidence                        | Observation times, scope, source errors and known-false versus unknown distinctions                                                     |
| Continuation eligibility and offered activity                                                 | Native event provenance, cancellation, protocol framing, private-state integrity and bounded individual I/O                             |

The rules cannot grant GitHub permissions, enable an unsupported executor, make a disconnected service reachable, convert arbitrary text to trusted intent, bypass path/Origin/schema validation or change a factual result. Those constraints stay explicit. An execution/binding error is reported as such, not relabeled as a new workflow denial invented by TypeScript.

## Defaults and trusted human direction

PDB supplies opinionated, useful DEFAULT workflow decisions. An explicit instruction from the human developer may override those defaults. Neither an agent's declared role nor the mere absence of definitive facts creates a new prohibition that overrides the human's actual request.

The native decision context distinguishes:

1. observed external facts, with provenance, coverage and freshness;
2. the target's explicitly selected rule context and declared configuration;
3. applicable trusted explicit human directives, with their scope and provenance;
4. the shipped opinionated defaults.

An applicable human directive takes precedence over an overridable default. More specific applicable direction wins within a trusted instruction source; genuine contradictory trusted directions remain explicit for clarification rather than being resolved by a convenient cached value. Direction persists for its stated task/scope until completed, changed or revoked; do not invent an expiry, work cap or extra confirmation ceremony. Target configuration expresses the target's normal policy, not proof that a particular human authorized an exception. Record which default was overridden and why; facts remain unchanged.

A directive is an explicit intent, not a fabricated observation. “Continue from the last known state” cannot become `fresh=true`; “proceed without this optional review” cannot become a forged approval receipt; “work on this ticket” cannot change its GitHub assignees. If the human expressly directs an exception, the rules consider that intent with the actual facts and expose the resulting uncertainty. A generic request to work the queue does not authorize arbitrary takeover, trust bypass, release or publication.

Only a trusted invocation/host boundary may supply human direction. The adapter must be able to establish that it came from the actual authenticated human's explicit instruction or a deliberately trusted human-maintained invocation context. Issue bodies, comments, model output, downloaded project prose and arbitrary caller fields such as `human`, `approved` or `override=true` are not that evidence. A registered provider's review evidence does not authorize that provider to issue arbitrary workflow commands. Trusting a human's separate instruction does not retroactively authenticate a copied or unverifiable historical marker.

For a host that cannot establish directive provenance, report that limitation; do not silently promote an agent assertion into human authority. The precise supported directive-entry interface belongs in a focused reviewed implementation contract. This document introduces no shell syntax, MCP impersonation parameter, new credential, trust-store edit or unattended configuration change. Future HTTP/local entry points must bind any directive to the authenticated invocation, intended operation, repository and subject, rather than trust a caller-chosen display name.

## Unknown facts, outages and reconciliation

Unknown is an explicit input state, not false, approval, an empty inventory or a made-up project convention. With no definitive GitHub or cached facts, disclose the limitation and follow the human's explicit instructions to the extent the available mechanisms can actually perform them. Do not manufacture an ownership prohibition, required check or successful operation just because the evidence is missing.

When GitHub is down and prior facts exist, continue from those facts with their original observation time, scope and uncertainty, in accordance with the human's direction. Existing read-only work, planning and local changes need not stop merely because a refresh failed. Do not silently replace the last known facts with empty arrays or rebrand them current. A cached rendered queue for another identity/project is not interchangeable with cached facts for this context.

A default freshness/ownership workflow gate is evaluated by native policy, including applicable explicit human direction; it must not become an unoverrideable imperative refusal in the host. Conversely, a human instruction does not make an unavailable write API succeed or satisfy an actual conditional-write precondition. The executor may attempt a supported operation when its policy decision and invocation binding permit it, and must report the real outcome. An unavailable API leaves pending intent or incomplete work, never a claimed mutation, completed delivery or speculative receipt. No offline mutation journal or automatic retry scheme is introduced here.

On recovery, collect authoritative current facts and compare them with the retained assumptions and any attempted operations. Native rules emit reconciliation/inspection or a revised recommendation with the changed witnesses. Preserve partial/unknown write outcomes and existing idempotency identities; do not repeat a possibly successful write blindly. Do not automatically remove other owners, rewrite questions, close issues or repair external state to match an old snapshot. Reconciliation may require another human decision when the original directive no longer resolves a material conflict.

The current `pdb.rules.edn` v1 preference extension remains admission-preserving under native-project-rules.md; it does not implement general workflow overrides or human-directive trust. Do not enlarge that untrusted input surface implicitly. A target workflow extension or directive channel needs its own reviewed schema, validation and effective-policy provenance before activation.

## Decision/fact/operation interface

Extend the existing `evaluatePolicy`/`PolicyFacts`/`PolicyResult` boundary through reviewed additive fact and decision schemas. Keep the engine pure: no gh, filesystem, network, secrets, wall-clock lookup or transport-specific policy branch. Supply times, requested operation and supported capability facts explicitly. A future mutation or PR-diagnostic caller must use the same native policy definitions as briefing, not evaluate a handwritten lookalike afterward.

The normalized input contract needs:

- selected target repository/project and subject identity; for PRs the observed full head, base and requirement scope;
- requested operation/selection, actor/context and capability evidence without treating reported identity as authority;
- observations with explicit unknown/false/value, source, observation time and completeness; per-check expected requirements and per-provider evidence remain distinct;
- effective target policy identity/hash and the separately established, scoped trusted directive references, if any.

The decision contract needs stable operation/action and rule IDs, effect (`allow`, `deny`, `inspect` or `defer` as appropriate to the registered operation), ordered recommendations, target/context binding, factual witnesses, effective policy revision and any overridden default/directive references. These are conceptual obligations, not a claim that all names are already public fields. Each focused runtime PR finalizes the narrow typed schema and compatibility projection it needs; preserve existing wire schema versions and field types unless a separately reviewed version change is necessary.

A host validates and binds the decision to the requested resource/version, renders the rule's reason, and executes only the supported operation named by that decision. It does not convert an observation such as `reviewDecision=CHANGES_REQUESTED` into a new private blocking policy. If facts change before a write, return that changed evidence for native reevaluation; an invalid resource binding is a mechanical execution error, not permission to reuse a decision for another head. Report real per-step outcomes and exact supported recovery navigation. A recommendation to merge is never a claim that GitHub accepted a merge.

CLI, STDIO MCP, HTTP MCP, dashboard, `pr` diagnostics, Ticket Doctor and continuation consume the same applicable decisions/reasons. Plain text and JSON are projections of that result. English explanations compile from the effective native definitions; a handwritten status paragraph or transport-only refusal must not become another authority. Physical resource bounds may stop evaluation with an explicit infrastructure error/coverage limitation, but must not silently select or exclude workflow candidates by role or project convention.

## Concrete #676 example: required checks

At this baseline, `workflow.verify` names this project's `verify` check and `prStatus` treats its absence as a universal blocker. That is a policy leak, not a GitHub fact. The target branch's effective requirements may name a different check, require no checks, constrain a check to a particular app, or be unreadable. Do not import PDB's own repository conventions into another target.

Collection must retain the target's observed branch/ruleset/protection requirements, head-bound checks, requiredness/app identity and read completeness. Complete `expected=[]` is different from unknown `expected=null`; a missing named requirement is different from no requirement. The rules determine missing/pending/failed/neutral/advisory consequences and explain the evidence, default or explicit target instruction used. Unknown requirements are reported as unknown, never as a fictional missing `verify`.

An explicit target rule requiring `verify` may continue to require it here; this architecture does not weaken this repository's CI or merge gate. #676 supplies the focused collector/diagnostic/native-decision correction and must exercise direct `pdb pr N` as well as briefing. #675 separately normalizes review evidence and moves acceptance/follow-up decisions into native policy. Neither fix waits for the entire #680 audit, and neither may leave an imperative shadow gate in another transport.

## Representative inventory and staged migration

Inspected source baseline: `abcee7c452f25beb64683e61a2b4699f8f4b7506`. This representative inventory establishes the architecture boundary; #680 supplies the exhaustive source/line inventory and end-to-end audit. Symbols below are audit anchors, not a claim that every line in each module is policy.

| Source/symbol at baseline                                                                                | Boundary finding                                                                                                                       | Focused migration                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workflow/definition.ts: workflow.verify`; `workflow/prstatus.ts: prStatus`                              | Hard-coded required check and imperative blockers/verdict compete with native decisions                                                | #676: collect target requirements; native PR progress/why; preserve factual report fields                                 |
| `github/requiredchecks.ts: classifyChecks`, `hydrateRequiredChecks`                                      | API reads, exact name/app matching and explicit unknownness are mechanics; deciding unknown/advisory outcomes block progress is policy | Retain collection/normalization; pass observations to shared native check decisions                                       |
| `workflow/reviewpolicy.ts: observeProvider`, `evaluateReviewPolicy`                                      | Payload/provenance extraction is distinct from accepted/findings/veto/coverage interpretation                                          | #675: normalized attributed evidence plus native acceptance and follow-up                                                 |
| `workflow/claims.ts` planners; `workflow/retained.ts: admissionFor`, `planClaimResume`                   | Input/record parsing and writes coexist with admission, ownership and resume workflow judgments                                        | #680 inventory, then focused native-operation decisions with the same mutation mechanics                                  |
| `workflow/completion.ts: completionPredicates`, `completionActionRules`, `evaluateDelivery`              | Declarative clauses embedded in TS and a separate decision path are not the maintained native artifact                                 | Migrate definitions/witnesses into the native component; retain generic evaluation/collection/execution seams as reviewed |
| `briefing/briefing.ts: PR findings`; `briefing/blended.ts: classify`, `roleCandidates`, `compareActions` | Independent TypeScript PR failure/clean/accepted/integrate and candidate/ranking policy (audit #697 P6)                                | Retire independent rollback policy; keep compatibility projection over native decisions                                   |
| `github/shortlist.ts` selection/hydration loop; `briefing/service.ts`                                    | Fetch budgets are mechanics; a role/eligibility shortlist can become hidden policy                                                     | Rank through native decisions using explicit provisional facts; expose unread/omitted coverage                            |
| `rebrief/core.ts: evaluate`                                                                              | Cancellation/state/protocol safety and work/freshness/action-selection policy share one path                                           | Native continuation/workflow choices; preserve native cancellation and private-state mechanics; coordinate #657           |
| CLI/MCP/serve render and mutation entry points                                                           | Routing/serialization is mechanical; independent eligibility or follow-up recomputation is a policy fork                               | Direct-command and cross-surface decision parity after each migrated slice                                                |

Sequence:

1. Merge this architecture contract; preserve known runtime limitations honestly. No universal activation or rewrite is bundled here.
2. Deliver #676 and #675 independently against the narrow shared native APIs, after their own recorded prerequisites. Add target requirements/review fixtures and direct-command parity. Do not duplicate their tickets in the audit.
3. #680 traces remaining paths, ranks confirmed leaks, records line-level provenance and creates focused follow-up proposals. Classify uncertainty rather than relabel all TypeScript conditions policy. Explicit human-directive and outage semantics must be covered in the relevant follow-up contracts, not hidden behind a new permanent host veto.
4. Migrate admission/completion/ranking/continuation and transport consumers in focused reviewed slices, with old/new evidence comparisons and negative bypass tests. Respect #662's current recorded readiness and native prerequisites and the separate #652/#657 scopes; this architecture supplies no additional activation authority. The owner has lifted the earlier #662 readiness hold; historical hold wording must not reintroduce it.
5. Retire the independently maintained TypeScript workflow rollback once its consumers migrate, including the PR findings in `briefing/briefing.ts` identified by #697 P6. Track that removal in the focused migration work; do not leave those findings as a permanent compatibility oracle. During transition any retained selector is a clearly disclosed legacy compatibility mode, not a valid destination for new policy; migrate it to a projection/alias of the same native result or remove it under an explicit compatibility change. If native evaluation is unavailable, report an infrastructure failure/unknown decision rather than run a silent alternative policy. Do not maintain two schedulers indefinitely or call matching examples proof of a single decision source.

## Testing boundary and negative acceptance

Native EDN scenarios assert outcomes, denials, precedence, reasons and witness/default/directive references from normalized facts. They run without GitHub, credential/config files, models or transports. Injected TypeScript tests assert API query shapes, target/head binding, pagination/gaps, literal parsing, trustworthy normalization, operation ordering, partial failures and cache reconciliation; they do not encode a second oracle for workflow acceptance. Packaged parity exercises direct CLI, STDIO/HTTP MCP, dashboard/diagnostics and English explanations against the same frozen native result.

Required cases for the migrated slices:

- Target A requires `build`, target B explicitly requires `verify`, target C has a complete empty required set, and target D's requirements are unreadable. No cross-project inheritance or fictional check names.
- Required and advisory checks share names but differ by app; pending/failed/missing/neutral states stay factual, and policy—not the normalizer—selects consequences.
- A trusted completed review on an old head, a current finding plus another provider's clean result, skipped quota and forged provider markers cannot be collapsed to convenient acceptance by host code.
- A direct claim/resume/complete/PR-status path and a transport request cannot bypass a denial or introduce an extra private default compared with the same native decision context.
- No current facts plus explicit trusted human direction: disclose unknowns and follow that direction where mechanisms permit; do not invent ownership or check requirements. Same wording in an issue/comment or arbitrary caller identity field is not a trusted override.
- GitHub outage with prior facts: retain their age/provenance, continue the instructed local/read-only work, report unavailable writes honestly, and reconcile changed ownership/head/partial outcomes on recovery without blind retries.
- An explicit workflow-default exception retains actual failed permission/API outcomes and does not bypass schema, path, Origin, resource binding, native user interruption or forged-record safeguards.
- A policy/context change invalidates only the applicable decision binding; identical effective facts/policy/direction produce identical decisions and reasons across surfaces. Runtime/worker failure is distinct from policy denial.
- English output and action why name the actual matched native policy; the legacy TypeScript selector cannot silently contradict it or introduce another `verify` gate.

This ticket delivers the reviewed contract and representative inventory only. Runtime correctness, the complete audit, human-assignment activation and release remain their own acceptance boundaries.
