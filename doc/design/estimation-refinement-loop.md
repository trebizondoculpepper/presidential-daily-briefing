# Estimation review, refinement and the discussion view

Reviewed contract for #1091. It records owner decisions only; the runtime slices are #1092–#1103 (the "Delivery map" on #1091), each implemented separately under the [architecture](../architecture.md). Native rules own every inclusion, admission and ordering decision below; TypeScript supplies facts, records and transport mechanics.

## Estimation review

An estimation review asks one question: **assuming every listed dependency were complete, is there enough information now to begin implementation?**

- **Yes**: record an estimate with a rationale, as today ([complexity](complexity-estimation.md), [impact](impact-estimation.md)).
- **No**: mark the item **needs refinement** and record at least one concrete blocking question.

An outline or an exhaustive dependency audit is not required. Propose a missing dependency only when one is noticed.

## Needs refinement

- Review and refinement may happen before implementation readiness and while dependencies are still open.
- **Needs refinement blocks implementation**, even when an older estimate or a `status:ready` label exists: native admission denies pickup while it is open.
- Resolving refinement **returns the item for estimation**. It never makes the item ready automatically.
- Refinement preserves human assignment, existing agent claims and existing admission. Requesting or resolving it authorizes no takeover and creates no claim.

### Native facts and decisions (#1092)

The native policy (`rules.edn`, `decisions.edn`, scenarios in `scenarios/refinement.edn`) reads these facts. The records service (#1094) supplies them; it adds no parallel question store.

- `[?t "refinement" ?q]`: a refinement request on ticket `?t`, with `"refinement-state"` `open`, `resolved` or `unknown`. Any open or unknown request means **needs refinement**, so a newer open request after an earlier resolution reopens it.
- `[?q "refinement-question" ?r]`: a blocking question, a question record in the existing #414 vocabulary. Only an explicit `record-outcome` `resolved` or `withdrawn` settles it. A request with no question is rejected at the boundary; if one is observed anyway, it is inspected (`D-REFINE-EMPTY`).
- `[?q "refinement-estimated" true]` on a resolved request: an estimate has been recorded since the resolution. If it is `false` or absent, the item awaits re-estimation (fail closed).
- `[?t "refinement-complete" false]`: refinement evidence could not be read completely.

Decisions:

- **Pickup denials:** `D-DENY-REFINEMENT` (needs refinement), `D-DENY-REESTIMATE` (resolved, not yet re-estimated) and `D-DENY-REFINEMENT-UNKNOWN` deny pickup whatever the estimate or `status:ready` label says.
- **Complexity estimates:** not offered while refinement is open.
- **Designer:** `D-REFINE` (questions pending) and `D-REFINE-RESOLVE` (all settled: resolve and return for estimation) are offered.
- **Re-estimation:** `D-REESTIMATE` offers a complexity estimate after resolution. It never grants readiness.
- **Unchanged:** claims, human assignment and native blockers. A blocked item can still be refined.

### Records (#1094)

Refinement is recorded on the ticket as comments, reusing the needs-human question machinery rather than a parallel question store. The comments are authoritative; a label only indexes them.

- **Request.** One comment holds both:
  - A needs-human v2 question record (`questionRecordBody` plus the existing v2 marker bound to this repository and issue), listing at least one non-blank blocking question. Its operation id identifies the question. The existing `pdb question resolve|withdraw`, folds and human views therefore apply unchanged.
  - A refinement marker, `<!-- github-triage:refinement v1 {"v":1,"op":"request","opId":…,"repository":…,"issue":…,"agent":…,"questionOpId":…,"dependencies":[…]} -->`. `dependencies` lists optional suggested blockers as `owner/name#N` references. They are suggestions only and are never applied as native edges.
- **Answers.** A question is answered or withdrawn by the existing trusted question-resolution v1 record. The refinement service adds no answer format.
- **Clearing.** A refinement v1 `op:"resolve"` record names the request `opId`. It is written only when:
  - that request's question is settled by a trusted resolve or withdraw;
  - no newer trusted request on the ticket is unsettled;
  - the evidence was read completely.
- **Return for estimation.** An estimate recorded after the resolve record (a complexity-estimate v2 marker newer than it) sets `refinement-estimated true`. Otherwise the item awaits re-estimation. Clearing never adds `status:ready`, never closes the ticket, and never changes assignment, claims, estimates, native edges or unrelated labels.
- **Index label.** `refinement:needed` is added with a request. A resolve removes it only when no other unresolved trusted request remains on the ticket; while one does, the label stays. This keeps the label equal to "some request is outstanding", so the briefing can find candidates without reading every ticket's comments.
  - The label is compared with _outstanding_ (unresolved trusted) requests, not with history: a disagreement is incomplete evidence (`refinement-complete false`), never a decision on its own. A ticket whose requests are all resolved, with the label removed, is the normal cleared state.
  - Trust is decided by the existing marker rules: only a write-authorised author's request or resolve counts, and an unverifiable author is reported, not obeyed.
- **Writes.** Writes reuse the existing planner shape: one deterministic operation id per request, retry suppression by a trusted marker with the same id, ordered steps, and truthful partial or uncertain receipts. The comment is written first and the label second; a failed label write leaves the records authoritative and is reported.

Native facts come from the fold of these records:

| Fact                        | Source                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refinement`                | one entity per trusted request                                                                                                                                                                                                                                                      |
| `refinement-state`          | `resolved` if a trusted resolve names it, otherwise `open`                                                                                                                                                                                                                          |
| `refinement-question`       | the request's question record                                                                                                                                                                                                                                                       |
| `refinement-estimated`      | from estimates newer than the resolve                                                                                                                                                                                                                                               |
| `refinement-complete false` | incomplete history, unverifiable authors, or an index label that disagrees with the _outstanding_ requests (label without an unresolved trusted request, or an unresolved trusted request without the label); a resolved request with its label removed is the normal cleared state |

## Designer priority

In the designer's queue, refinement work comes **after** direct human requests and the designer's own PR follow-up, and **before** ordinary new design work. Within the refinement bucket, items that unlock the most downstream work come first, using existing native dependency evidence, with deterministic ties.

The designer resolves recorded questions from existing designs and decisions where possible, and escalates only questions that need an unresolved human decision (through `needs-human`).

## Discussion view ("controversial items")

A read-only view of issues that attract discussion:

- **Proxy:** the GitHub issue comment count, descending; ties go to the lower issue number. Only issues with at least one known comment are listed. No LLM classification, question-round detection or filtering of routine comments. The native rules (`discussion-ranked`, `discussion-unknown` in `rules.edn`, #1093) decide inclusion, keys and explanation.
- **Meaning:** being listed is neither a blocker nor proof of disagreement. Answered discussions remain eligible.
- **Scope:** open issues by default; closed issues may be included for historical discussion. The result states the scope queried.
- **Completeness:** pagination and completeness are explicit. A count that could not be read is reported as unknown, never as zero, and its item is not ranked as if it were.
- **One result for every surface:** it reuses existing typed GitHub facts, question records and read services. Native rules decide inclusion and order; one shared result serves the CLI, MCP and the API-first website.

## Boundaries

No agent-attribution or GitHub App feature, paid experiment or unrelated backlog relabelling is part of this work. Filing or estimating a ticket does not mean its implementation is complete.
