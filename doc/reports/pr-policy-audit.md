# Audit: workflow policy in PR checks, review and merge-readiness paths (#697)

Focused child of #680. **Source:** `main` at `28d6649` (2026-11-16). This is a read-only
inventory: no runtime change, live mutation or migration is part of it. The boundary used is the
one #679 states:

- **Policy** (belongs in native rules): what blocks progress, what to do next, precedence and
  project conventions.
- **Mechanics** (stays in TypeScript): fact collection, normalisation, schema, provenance and
  permission checks, and executing approved operations.

Not every conditional is a leak. Where the code only classifies a GitHub fact, it is recorded as
mechanics.

Known fixes are reused, not duplicated:

- #676: the universal `verify` requirement;
- #675: review-feedback coordination;
- #502: delivery-classifier parity, already merged.

## Summary

| ID  | Where                                                                         | Classification                                                      | Priority                |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| P1  | `workflow/prstatus.ts` `prStatus` blockers and verdict                        | **Policy**, outside native rules                                    | 1                       |
| P2  | `rules/datalog/policy/rules.edn` `verified` (`"verify"` literal)              | Policy _in_ native rules, but a universal project convention        | 1 (#676)                |
| P3  | `workflow/deliveryread.ts` `classifyFollowUp`                                 | **Policy**, a second copy of the briefing's PR rules                | 2                       |
| P4  | `workflow/reviewpolicy.ts` `evaluateReviewPolicy` coverage decision           | Mixed: attribution is mechanics; the coverage verdict is **policy** | 2 (#675)                |
| P5  | `briefing/catchup.ts` `verificationWord` / `prStatusWord` / `nextFor`         | **Policy**: precedence and next-step recommendations                | 3                       |
| P6  | `briefing/briefing.ts` PR findings (TypeScript rollback engine)               | **Policy**, a rollback duplicate                                    | 3 (retirement per #679) |
| P7  | `workflow/ticketdoctor.ts` `contributionFinished`                             | Policy (diagnostic)                                                 | 4                       |
| P8  | `workflow/team.ts` `verify` column                                            | Presentation of a convention                                        | 4                       |
| M1  | `github/requiredchecks.ts` `classifyChecks`                                   | **Mechanics** (keep)                                                | none                    |
| M2  | `workflow/prstatus.ts` `classifyCheck`; `workflow/definition.ts` outcome sets | **Mechanics / data** (keep)                                         | none                    |
| M3  | `mcp/polling.ts` event kinds from `changesRequested` / `conflicts`            | **Mechanics** (event normalisation)                                 | none                    |

## Findings

### P1 — `pdb pr N` decides merge readiness in TypeScript

- **Where:** `src/workflow/prstatus.ts`, `prStatus`, lines 241–575: the `blockers` array and the
  `verdict`.
- **Trigger:** any `pdb pr N` (CLI), the MCP `pr` tool and the HTTP PR route. All three call
  `pullRequestStatus` and then `prStatus`.
- **Decision:** about 20 imperative branches decide what blocks merging. They include:
  - a draft, and a closed or merged PR;
  - **a missing, pending or unsuccessful check named `verify`** (lines 261, 402–416);
  - any failed or cancelled check, and a count of pending checks;
  - `CONFLICTING` or `UNKNOWN` mergeability, and merge state outside `currentMergeStates`, with
    `BEHIND` worded as "update it before merging";
  - `CHANGES_REQUESTED` and `REVIEW_REQUIRED`;
  - unresolved threads;
  - the legacy Codex receipt rules (findings, stale head, review in progress), the declared-policy
    coverage and findings, and an unknown policy;
  - review requests with no reaction;
  - a `BLOCKED` fallback.

  Precedence and wording are fixed in code, and so is the verdict text ("No blocker found …
  consider merging").

- **Classification:** workflow policy. The facts (checks, merge state, reviews, receipts) are
  collected correctly; deciding which of them blocks progress is policy. The briefing's native
  `D-PR-*` rules make the same kind of decision independently, so the two can disagree. #676 is
  that disagreement in production: a clean PR is reported blocked by a check its repository
  never required.
- **Native equivalent or gap:** a partial equivalent exists. `D-PR-FAIL`, `D-PR-REVIEW`,
  `D-PR-CONFLICT`, `D-PR-MERGE` and `D-PR-INTEGRATE` decide _follow-up actions_, but no native
  output lists _all current blockers_ for one PR. That's the gap: a diagnostic decision set, like
  denials, rather than ranked actions.
- **Affected surfaces:**
  - `pdb pr` text and JSON, MCP, HTTP and the dashboard ticket page;
  - `reportFollowUpFacts` (P3), which reads `checks.required` from this report, so the `verify`
    convention flows into delivery follow-up too.
- **Regressions for the migration:**
  - `verify` absent and not required gives no blocker;
  - a differently named required CI check;
  - required and missing, pending, failed or successful;
  - unread protection evidence gives `unknown`, never passed;
  - an advisory pending check doesn't block;
  - `BEHIND` on an unaccepted PR waits for review (delivery-follow-up-alignment.md precedence 4);
  - every legacy, declared and unknown review-policy case `prstatus.test.ts` covers today;
  - CLI, MCP and HTTP parity of the blocker list.

### P2 — the native rules hard-code the check name `verify`

- **Where:** `src/rules/datalog/policy/rules.edn:80`
  `[(verified ?t) [?t "check" ?c] [?c "name" "verify"] [?c "outcome" "SUCCESS"]]`, used by
  `clean-pr`, `accepted-pr` and `integrate-pr`, and the `verify` witnesses in `decisions.edn`
  (`D-PR-MERGE`, `D-PR-INTEGRATE`, the human sign-off reason).
- **Decision:** a PR is merge-ready or accepted only if a check literally named `verify`
  succeeded.
- **Classification:** policy correctly placed in native rules, but it encodes _this_ project's
  convention as universal. #679 forbids that: "a check name is not universally required because
  PDB's own project uses it". Target projects without `verify` can never reach `D-PR-MERGE` or
  `D-PR-INTEGRATE`.
- **Gap:** the facts already exist, so derive `verified` from them. `requiredchecks.ts` reads
  expected required checks from rulesets and branch protection, plus `isRequired` per check. The
  rule should become "every expected required check succeeded with complete evidence", or an
  explicit check list from the target project's own rule context. Incomplete requirement
  evidence stays unknown, never passed.
- **Surfaces:**
  - every briefing, CLI, MCP and HTTP queue;
  - the human sign-off view;
  - English rule output (`pdb rules`), which shows the literal.
- **Known fix:** #676; this audit adds that the native half must change too, not only `prstatus`.

### P3 — delivery follow-up repeats the PR rules in TypeScript

- **Where:** `src/workflow/deliveryread.ts`, `classifyFollowUp` (lines 103–155),
  `snapshotFollowUpFacts` and `reportFollowUpFacts` (`verified` from `workflow.verify`, lines
  179 and 200).
- **Trigger:** `team`, `who N`, `pr N` responsibility, Ticket Doctor delivery checks and
  `complete`.
- **Decision:** an ordered cascade of actionable, waiting or unknown, with reasons.
  It covers:
  - draft, incomplete evidence (with the #502 failure exception);
  - failing checks, changes requested, threads, findings, conflict;
  - pending checks, verify missing;
  - `BEHIND`, accepted and refresh, clean merge state.

  Its comment says it mirrors the briefing's PR rules by hand.

- **Classification:** workflow policy, duplicated. #502 shows the drift risk: the two copies
  disagreed until fixed by hand. delivery-follow-up-alignment.md precedence 4 (unaccepted
  `BEHIND` waits) is still unimplemented here; this code returns `actionable` for `BEHIND`.
- **Gap:** no native decision exposes per-PR follow-up classification to non-briefing reads.
- **Regressions:** the #502 scenario, draft states (#377), `BEHIND` accepted versus unaccepted,
  pending advisory versus required, and parity between `pdb team` and the briefing for the same
  PR.

### P4 — review coverage is decided in TypeScript as well as in rules

- **Where:** `src/workflow/reviewpolicy.ts`, `evaluateReviewPolicy` (lines 272–343); the
  `head-reviewed` and `head-findings` rules in `rules.edn` (lines 83–90).
- **What's mechanics (keep):**
  - `observeProvider` and `attribution`: author identity, head binding and receipt parsing.
    These are provenance mechanics.
  - Treating an unauthenticated marker as untrusted is a security fact, not configurable policy.
- **What's policy (move):** the coverage verdict.
  - Which providers count for the effective policy;
  - that incomplete evidence never yields acceptance;
  - that an unknown policy accepts nothing;
  - that a finding vetoes.
- **Why it matters:** `prstatus` and `deliveryread` consume this TypeScript verdict, while the
  briefing re-derives it natively from host-normalised `provider-review` facts. Two encodings of
  one rule.
- **Gap:** native rules already hold coverage. What's missing is exposing that result to
  `pr N` and the delivery reads instead of the TypeScript verdict.
- **Known fix overlap:** #675 (review feedback coordination); this item is the coverage half
  only.
- **Regressions:** every `reviewpolicy.test.ts` case, run against both outputs, must agree:
  legacy, `codex-or-coderabbit`, unknown, incomplete, unattributed marker and stale head.

### P5 — catch-up wording carries its own precedence and next steps

- **Where:** `src/briefing/catchup.ts`, `classifyChecks` (`verified` at 1032–1035),
  `verificationWord`, `prStatusWord` and `nextFor` (1040–1075), and the blocker section
  (667–730).
- **Decision:**
  - it ranks failed over cancelled, then pending, unknown, incomplete, and "verification not
    proven" (no `verify`);
  - it chooses the next-step text ("Fix failing checks", "Wait for checks", "Resolve conflicts").
- **Classification:** policy. It's a recommendation and a precedence, not normalisation. It also
  carries the `verify` convention (P2), so catch-up says "verification not proven" for target
  repositories without that check.
- **Gap:** catch-up could take the native decision and its reason for each PR rather than its
  own word ladder; the wording stays presentation.
- **Regressions:** for each check state, the catch-up word matches the native reason; a target
  without `verify` shows "checks passing".

### P6 — the TypeScript rollback engine's PR findings

- **Where:** `src/briefing/briefing.ts` lines 370–520: `pr-failed-checks`, `clean`, `accepted`
  and the integrate and inspect-merge findings, using `workflow.verify`.
- **Classification:** policy, in the rollback that #679 says must not become a second maintained
  policy.
- **Proposal:** fold into #679's retirement or limited-compatibility plan. Don't fix it
  separately except to keep parity tests passing while it exists.

### P7 — Ticket Doctor's "contribution finished" judgement

- **Where:** `src/workflow/ticketdoctor.ts` `contributionFinished` (lines 29–39). A PR's
  contribution counts as "evidently finished" when it is out of draft, the combined rollup state
  is `SUCCESS`, threads are complete and resolved, and there's no `CHANGES_REQUESTED`. The doctor
  uses this to judge readiness-label drift on the closing issue.
- **Classification:** diagnostic policy (what counts as a healthy open PR). It's low impact,
  since it only affects a candidate finding, but it's a third definition of "PR is fine".
- **Proposal:** consume the P1 native readiness result once it exists.

### P8 — the `team` view's `verify` column

- **Where:** `src/workflow/team.ts:98`: `verify` outcome per linked PR.
- **Classification:** presentation of the P2 convention. Repositories without `verify` show
  `UNKNOWN`.
- **Proposal:** show the required-checks summary (or the native readiness reason) instead.

## Mechanics kept as they are

- **M1** — `requiredchecks.ts` `classifyChecks`:
  - sorts pending checks into required, advisory and unknown from GitHub's own `isRequired`;
  - records rulesets and protection evidence, and missing expected checks.

  It classifies facts and never decides blocking. Consumers decide. Unknown stays unknown. Its
  header comment states the waiting rule; that rule lives in the consumers and the native
  `pr-pending` rule, which is correct.

- **M2** — `prstatus.ts` `classifyCheck` and the outcome sets in `workflow/definition.ts`
  (`pass`, `failure`, `unfinished`): normalising GitHub's check outcome vocabulary. This is data,
  not policy.
  - **Exceptions** in the same definition file, which are policy-flavoured: `verify` (P2) and
    `currentMergeStates` / `refreshMergeStates` (the merge-state precedence the PR rules depend
    on). Their _use_ is already in native rules for the briefing; the TypeScript reuse is covered
    by P1, P3 and P5.
- **M3** — `mcp/polling.ts` maps `CHANGES_REQUESTED` and `CONFLICTING` to event kinds. That's
  notification normalisation of a GitHub fact, not a workflow decision.

## Prioritised migration proposals

These are aligned with #679 (rules decide; TypeScript collects facts and executes), and each is
bounded. Runtime work waits for #679's reviewed architecture. None needs an omnibus rewrite.

1. **#676, extended to the native half (P2, P1 in part).** Replace the `"verify"` literal in
   `rules.edn` with a rule over the required-check facts already collected, plus an explicit
   per-target rule context for projects that declare a check. Remove the universal `verify`
   branch from `prStatus`, and `verified` from `deliveryread` and `catchup`. This is the
   highest-value fix: it corrects false blockers in every surface, including for other
   repositories.
2. **Native PR-readiness diagnostics (P1).** Add a native decision set that emits every current
   blocker for a PR, with witnesses, as `denials` do for pickup. `prStatus` keeps collecting
   facts and presenting, and becomes a projection of that result. Keep the existing blocker
   wording as English templates so output stays stable. Needs a #679 API for diagnostic
   (non-ranked) decisions.
3. **Delivery follow-up from native decisions (P3).** Expose the per-PR follow-up classification
   from the rules (shared with `D-PR-*`) to `team`, `who`, `pr`, Ticket Doctor and `complete`,
   and retire `classifyFollowUp`. This removes the hand-kept mirror that #502 had to repair, and
   delivers alignment precedence 4 in one place.
4. **Review coverage verdict from native rules (P4, with #675).** TypeScript keeps attribution and
   provenance (`observeProvider`); `pr N` and delivery reads use the native `head-reviewed` and
   `head-findings` result instead of `evaluateReviewPolicy`'s verdict.
5. **Catch-up uses native reasons (P5).** Map each PR's native decision and reason to the
   catch-up wording; delete the word ladder.
6. **Low priority:**
   - Ticket Doctor's `contributionFinished` (P7) and the `team` verify column (P8) consume the result
     from step 2;
   - the TypeScript rollback (P6) follows #679's retirement plan.

Order matters: step 1 is independent; steps 2–5 build on the diagnostic-decision API from #679;
step 6 follows step 2. Each step needs:

- rules-only scenarios for the decisions;
- injected fact-collection tests for the mechanics;
- a CLI, MCP and HTTP parity check, so no transport keeps its own fork.
