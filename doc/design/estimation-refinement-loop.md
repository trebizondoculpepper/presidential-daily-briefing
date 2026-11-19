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
