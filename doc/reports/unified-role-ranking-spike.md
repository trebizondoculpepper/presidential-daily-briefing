# Unified role ranking: bounded experiment

For #651 and #652. Main base: `9e02949`. No production policy change.

## Question and result

Can a shared activity pool preserve ownership-first ordering and prefer the viewer's
role without hiding the other role's activities? Yes in this bounded pure-rules model:
seven existing assessment-first scenarios passed 49 assertions.

The experiment evaluates each existing scenario using the real DataScript decision
engine under both roles, unions its emitted activities by subject and action kind,
and applies `scripts/experiments/unified-role-ranking/rank.edn` to emit ownership and role
sort keys. The runner only compares these keys. It asserts equal membership for both
roles, owned-first ordering, preferred-role ordering for unowned work, and unchanged
implementation denials between roles. Existing facts include the owned-work versus
assessment case and a blocked-but-estimable ticket.

This is a feasibility experiment, not the proposed production architecture. Production
must generate candidates once and rank them declaratively, not run the engine twice.
It uses no GitHub data, credentials, network or mutations. There is no timing benchmark.

## Reproduce

```sh
npm ci
SENTRY_DISABLED=1 npx tsx scripts/experiments/unified-role-ranking/run.ts
```

Expected final line: `49 assertions passed; production policy unchanged.`

## Limits and implementation work

The current policy still puts role predicates in candidate-selection rules and PR
follow-up eligibility. Changing comparison order alone is insufficient. Audit the host
shortlist/hydration and claim paths as well as native candidate generation. The native
implementation must add explicit scenarios for cross-role own design, linked PR
responsibility, blocked owned work, platform restrictions, missing evidence and stable
truncation. This experiment only checks the seven assessment-first fixtures; it does
not establish those missing cases or all denial mechanisms.

An owned blocked ticket must produce an action to resolve/collaborate/ask/hand over or
unassign, not permission to implement through its blocker. Ownership remains high until
explicitly released. Human questions and native blockers survive unassignment. No
automatic transfer, closure or new claim authorization is inferred.

The owner now places owned work above new assessments; this supersedes the earlier
#378 acceptance of assessment above a medium/medium owned ticket. After ownership,
designers prefer impact assessment, design documents and ticket preparation;
implementers prefer PR follow-up, complexity estimation and implementation. Other-role
activities remain lower in the same list, with no fallback heading. Human briefing
remains a separate audience. See #651 for the contract and #652 for runtime acceptance.
