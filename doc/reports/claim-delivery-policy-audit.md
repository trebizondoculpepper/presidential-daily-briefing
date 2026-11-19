# Claim and delivery services: workflow policy outside native rules (#698)

Focused child of #680. Source audit of `src/workflow` and the CLI handlers that call it, at commit `d936b8f5`, against the [#679 rules-engine architecture](../architecture.md): workflow eligibility, denials, next actions and ordering belong to native rules (`src/rules/datalog/policy/*.edn`); TypeScript keeps provenance and trust, GitHub permission, schema validation, deterministic execution and rendering. Read-only: no claim, release, closure or assignment was made to test anything.

Classification: **(a)** workflow policy in TypeScript; **(b)** legitimate host check; **(c)** ambiguous (fact derivation or record semantics with a policy choice inside).

## Does the path consult the native engine?

| Path                                                                                                                                                                                                                                                     | Native engine                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `claims.ts` (claim, release, needs-human, question resolution), `retained.ts` (wait, resume, admission), `deliverables.ts` (submit, deliverables, rework), `completion.ts`, `ticketdoctor.ts`, `deliverydoctor.ts`, `claimactivity.ts`, `issuecreate.ts` | **No**                                                                                                           |
| `deliveryread.ts`                                                                                                                                                                                                                                        | PR checks only (`evaluateCheckPolicy`)                                                                           |
| `ticketdoctor.ts:32-40`                                                                                                                                                                                                                                  | Indirectly, through `snapshotPrReadiness`                                                                        |
| `unassign.ts:320,514`                                                                                                                                                                                                                                    | **Yes**: `evaluateUnassignDecision` over D-UNASSIGN-* rules. This is the model the other mutations should follow |
| `cli.ts:2256-2290`                                                                                                                                                                                                                                       | Claim-rule reminders are rendered after a claim; not used for admission                                          |

Claim, submit, completion and resume eligibility are therefore decided in TypeScript, parallel to `rules.edn`'s `implementation-deny`/`eligible` with no shared source.

## Confirmed divergence: `claim` admits what the briefing denies

`claims.ts:764-779` runs the incomplete-inventory refusal only when another claim by the same agent was **observed** (`ownOther.length && admission`). When the agent's claim inventory could not be read completely and no other claim was seen, the claim is admitted and its label and comment are written; the gap surfaces only afterwards as an "unverified" result (exit 2, `claims.ts:1870`). For the same facts the briefing denies pickup with `D-DENY-INVENTORY-UNKNOWN` (`rules.edn:59`) and offers the `D-INVENTORY-UNKNOWN` inspection. A direct `pdb claim` is a bypass of that denial. Filed separately as a bug (see "Follow-up").

## Claim, admission, resume and release

| #   | Where                                                                                       | Decision                                                                                                               | Class                                                                      |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `claims.ts:764-779`                                                                         | Incomplete inventory refused only when another claim was observed (above)                                              | **(a)**, live divergence                                                   |
| 2   | `retained.ts:297-309` (`admissionFor`), `claims.ts:768-800`                                 | One active claim per agent; a second only when every other is verified waiting                                         | **(a)**: no native admission relation                                      |
| 3   | `claims.ts:955-1025`                                                                        | Pickup denial sequence (question/design/decision, held, pickable label, native blockers, open PR, platform)            | **(a)**: hand-copy of `implementation-deny` with different codes and order |
| 4   | `claims.ts:38-56`, `briefing/ranking.ts:17-33`, `cli.ts:2266-2273`, `ticketdoctor.ts:48-55` | Four host copies of the prerequisite/held/pickable label sets                                                          | **(a)**                                                                    |
| 5   | `claims.ts:930-954`, `deliverables.ts:1375-1447`                                            | Rework eligibility; the delivery path needs only ticket responsibility and skips the pickable-label and open-PR checks | **(a)** (trust/permission parts **(b)**)                                   |
| 6   | `retained.ts:551-700` (`planClaimResume`)                                                   | Resume gate (not waiting, no native blockers, no open question, complete inventory, admission)                         | **(a)**: D-OWN-RESUME says when; TypeScript decides whether                |
| 7   | `retained.ts:~446-497` (`planClaimWait`)                                                    | One named blocker per wait; RESUME_REQUIRED                                                                            | **(c)**                                                                    |
| 8   | `retained.ts:158-283`                                                                       | Claim activity state, including "cleared means resume-required"                                                        | **(c)**                                                                    |
| 9   | `claims.ts:1564-1569`                                                                       | Release outcome to next labels                                                                                         | **(a)**                                                                    |
| 10  | `claims.ts:1729-1740`                                                                       | Closed-ticket and non-holder release refusals                                                                          | **(a)**/**(b)**                                                            |
| 11  | `claims.ts:1210-1226`                                                                       | needs-human label transition                                                                                           | **(a)**                                                                    |
| 12  | `claims.ts:1466-1472`                                                                       | First explicit question outcome stands                                                                                 | **(c)**                                                                    |
| 13  | `claims.ts:728-755, 826-871, 981-987`                                                       | Not found, not an issue, incomplete pagination, unverified marker                                                      | **(b)**                                                                    |
| 14  | `claims.ts:1660-1727`                                                                       | Recorded-handoff replay (RELEASE_DIVERGED, RELEASE_PENDING)                                                            | **(b)**                                                                    |
| 15  | `cli.ts:2280-2290`                                                                          | Reminder input asserts a complete inventory without checking `claimsComplete`                                          | **(c)**; compounds #1                                                      |

## Delivery: submit, deliverables and completion

| #   | Where                                            | Decision                                                                                                                                         | Class                                                   |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 16  | `completion.ts:75-94, 121-165, 175-204`          | A second, TypeScript-hosted Datalog (`deriveDatalog`, completion predicates, rules L3-L5a), outside `policy/*.edn`, `pdb rules` and parity tests | **(a)**, structural                                     |
| 17  | `completion.ts:319-358`                          | Verdict precedence hand-coded                                                                                                                    | **(a)**                                                 |
| 18  | `completion.ts:922-933`                          | Completion refused while anyone holds a claim                                                                                                    | **(a)**                                                 |
| 19  | `completion.ts:1046-1072`                        | Record only when delivered or attested                                                                                                           | **(a)**                                                 |
| 20  | `completion.ts:605-645`                          | Whether a completion is effective                                                                                                                | **(c)**                                                 |
| 21  | `deliverables.ts:1009-1062`, `:307-310`          | Submit needs own claim, open ticket and `--pr`; it sets awaiting-review even with an open `question` or `status:blocked`                         | **(a)**: the briefing would treat that ticket as held   |
| 22  | `deliverables.ts:596-628, 1099-1110, ~1180-1260` | Who may attach, detach, retarget or attest                                                                                                       | **(a)**                                                 |
| 23  | `deliverables.ts:1316-1335`                      | Reset refused while open or unreadable PRs exist                                                                                                 | **(a)**                                                 |
| 24  | `deliverables.ts:677-710`                        | Closed-unmerged PR, target mismatch                                                                                                              | **(b)**/**(c)**                                         |
| 25  | `delivery.ts:489-~780` (`foldDelivery`)          | Record replay, handoff staleness, refusal ranking                                                                                                | **(c)**, leaning **(b)**                                |
| 26  | `delivery.ts:778-795`                            | Attestation applicability                                                                                                                        | **(a)**: duplicates #16                                 |
| 27  | `deliveryread.ts:106-157` (`classifyFollowUp`)   | TypeScript copy of the briefing's D-PR-* follow-up precedence                                                                                    | **(a)**: only `followupparity.test.ts` keeps it aligned |

## Recovery: Ticket Doctor and Delivery Doctor

| #   | Where                       | Decision                                                 | Class                                                          |
| --- | --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| 28  | `ticketdoctor.ts:1084-1135` | Third copy of the admission rule                         | **(a)**                                                        |
| 29  | `ticketdoctor.ts:720-1060`  | Label diagnoses, certainty and correction plans          | **(a)**/**(c)**; unknown-means-inspect (`:601-609`) is **(b)** |
| 30  | `ticketdoctor.ts:45`        | 24-hour staleness, distinct from the briefing's two days | **(c)**: undeclared policy parameter                           |
| 31  | `deliverydoctor.ts:153-300` | Delivery and closed-drift diagnosis over `foldDelivery`  | **(c)**                                                        |
| 32  | `doctorplans.ts:64+`        | Rendering of correction commands                         | **(b)**                                                        |

`issuecreate.ts`, `responsibility.ts`, `retainedfacts.ts` and `ticketstatus.ts` are mostly **(b)**; `ticketstatus.ts:813` explicitly defers pickup to the briefing.

## Multi-step operations and partial outcomes

| Operation                                                 | Write order                                   | Partial outcome                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim` (`claims.ts:1032-1053`, `applyPlan` `:1817-1905`) | label create, labels, comment                 | Later steps skipped after a failure; exit 2 when anything was written; a retry posts only the missing comment; the ownership re-check reports conflict or unverified (exit 2) and never rolls back |
| `claim --rework` (`cli.ts:2231-2241`)                     | claim, then membership record                 | Exit 2 if the record fails; re-running completes it                                                                                                                                                |
| `release` (`claims.ts:1776-1795`)                         | handoff comment (with the label plan), labels | Retry replays the recorded plan; RELEASE_DIVERGED or RELEASE_PENDING on change                                                                                                                     |
| `needs-human` keeping the claim (`cli.ts:2149-2222`)      | question comment, wait record, labels         | Each step reported; combined exit is the maximum                                                                                                                                                   |
| `claim wait`/`resume` (`cli.ts:2087-2097`)                | activity comment, transition check            | Fold rejection is a conflict (exit 2)                                                                                                                                                              |
| `submit`/`deliverables` (`deliverables.ts:1473-1583`)     | record, labels (re-planned before each write) | Exit 2; post-write fold check reports HANDOFF_STALE, never retried                                                                                                                                 |
| `complete` (`completion.ts:1230+`)                        | record, re-evaluate, close, labels            | "record written, close skipped" (exit 2); at most one close; DELIVERY_DIVERGED on reopen; label cleanup resumable                                                                                  |
| `unassign` (`unassign.ts:565-765`)                        | —                                             | Typed WRITE_PARTIAL, WRITE_UNKNOWN, REVISION_CONFLICT                                                                                                                                              |

The partial-outcome reporting is consistently honest (exit 2, no blind retry, resumable). The policy gaps are about _what is admitted_, not about recovery.

## Proposed bounded native migrations

Each reuses the existing adapter facts and test seams, in dependency order:

1. **Claim admission parity** (fixes #1, #3, #4). Add `claim-deny ?t ?code` in `rules.edn`, built from `implementation-deny` plus a `held` relation; `planClaimFor` builds facts through `adapter.ts` (including `owned-claims-complete` and the platform) and asks the engine, keeping only evidence and trust refusals in TypeScript. Test seam: `claims.test.ts`, `parity.test.ts`, and a scenario where an incomplete inventory with no observed claim must refuse.
2. **Single prerequisite label set** (#4). `[1 "prerequisite"]`/`held` from the generated policy become the only source; delete `claimPolicy.held`, the `cli.ts:2266` list and `doctorPolicy.designEvidence`. Test seam: `boundary.test.ts`, `check-policy`.
3. **Retained-claim admission and resume** (#2, #6, #28). `admit-second-claim` and `resume-permit`/`resume-deny` over `claim-activity` and `owned-claims*`, consumed by `admissionFor`, `planClaimResume` and the Ticket Doctor. Reuse #662's ownership work rather than a parallel implementation. Test seam: `retained.test.ts`, `ticketdoctor.test.ts`, `scenarios/`.
4. **Submit and rework guards** (#5, #21). `submit-deny` (no claim, prerequisite or blocked present) and `rework-permit`. Test seam: `deliverables.test.ts`.
5. **Completion into native EDN** (#16-19, #26). Port the completion predicates and L3-L5a into `rules.edn`/`decisions.edn`, feed `deliveryTuples` through the adapter, and delete `deriveDatalog`. Test seam: `completion.test.ts` already pins the predicate text.
6. **Follow-up classification** (#27). `classifyFollowUp` uses the native D-PR-* selection (`evaluatePrReadiness` exists). Test seam: `followupparity.test.ts`.

Migration 1 with 2 comes first: it closes the only confirmed case where `claim` admits a ticket the briefing denies, with one relation and one adapter call.

## Follow-up

The confirmed bypass in "Confirmed divergence" is filed as #1083, so it can be fixed before the broader migrations.
