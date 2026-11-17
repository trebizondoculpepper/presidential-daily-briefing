# Remaining metrics data and consumer readiness

Reconciliation of #835/#836 under #573, following the owner's request to split
remaining work rather than reimplement shipped capabilities. This addendum changes
delivery dependencies, not metric definitions; dashboard-metric-owner-decisions.md
still supersedes the older grouping/open-question wording.

## Shipped capabilities

#837 supplies pure news, daily and timing views; #843 supplies bounded evidence
reads; #851 serves them through GET /api/v1/metrics with shared cache, refresh,
cancellation and coverage. #858/#832 supplies current assessment groups and
#856/#833 trusted assessment endpoints. #811 already supplied UTC windows,
durations and statistics. The original news/daily/timing scope of #835 and the
API integration acceptance of #836 are delivered; record the evidence and close
those tickets after verification. They are not reasons to wait for the Sankey.

Verification for this reconciliation inspected src/metrics/views.ts, read.ts,
assessment.ts and src/serve/api.ts, and passed 22 focused metrics/API tests.
This is evidence for those scopes, not a claim that every Pipeline Health view
already exists or that every historical source is complete.

## Small remaining data slices

| Ticket | Result supplied                                                                                       | UI consumers |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------ |
| #883   | Current native stage/age and no-recorded-progress inventory, explicit unknowns and supporting members | #684, #688   |
| #885   | Current unclaimed backlog by trusted impact and native ready/blocked/not-ready facts                  | #685         |
| #888   | Per-metric assessment queue/age/latency/revisions and created-versus-first-assessed volume            | #686, #687   |

Each slice reuses the existing read/API/cache, ledger/assessment parsers, native
workflow results and freshness/completeness envelope. Supply one additive typed
data capability and its focused tests, not a chart, new collector, duplicate
cache or rule matrix. Current inventory is not historical flow. Native rules
supply stage/eligibility facts; TypeScript aggregates and formats supplied facts.
Keep incomplete/unknown members visible and figure membership inspectable.

#573 remains a coordination umbrella for remaining shared data. It must not be a
technical gate for a consumer whose exact data is already available. News #824,
daily counts #826/#827 and timing #820–#823 depend on delivered #836 rather than
waiting for every inventory or flow result. Their existing unrelated prerequisites
remain. Parent/coordination tickets remain open until their own children finish.
Do not close #573 merely because its news/daily/timing API shipped.

Pipeline Health #684–#688 replace the broad #573 gate with their exact data slice
in the table. Ownership sections #682/#683 retain #665/#667 prerequisites. Overview
current-work #825 must be inspected against its own read-service requirements;
this reconciliation does not silently declare an unverified result available.

Cohort-flow data #700 and final Sankey #689 remain after the simpler feature
slices, with existing native prerequisites unchanged. Do not duplicate them under
#835 or make already-shipped news/daily/timing wait for the Sankey. Reuse existing
small feature tickets; no new umbrella implementation or whole dashboard rewrite.
