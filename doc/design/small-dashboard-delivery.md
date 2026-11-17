# Small dashboard and delivery-admission implementation slices

Owner-requested delivery split from the 2026-11-17 design session. This changes
packaging/order of reviewed work, not its policy. The four parents are coordination
and acceptance umbrellas, not monolithic implementation pickups. Their native
GitHub blockers and child links are authoritative; this document is a map.

## Independent feature tickets

| Parent | Child | Deliverable                                                               | Impact | Complexity |
| ------ | ----- | ------------------------------------------------------------------------- | ------ | ---------- |
| #584   | #818  | Configuration page: read-only global and project configuration view       | M      | S          |
| #584   | #819  | Configuration page: edit, save and reset registered configuration values  | M      | M          |
| #576   | #820  | Timing: pickup-to-delivery chart with ticket drill-down                   | M      | M          |
| #576   | #821  | Timing: creation-to-first-pickup chart with ticket drill-down             | M      | S          |
| #576   | #822  | Timing: first impact-assessment latency chart and drill-down              | M      | S          |
| #576   | #823  | Timing: first complexity-assessment latency chart and drill-down          | M      | S          |
| #574   | #824  | Overview: recent project news feed                                        | M      | S          |
| #574   | #825  | Overview: current work and waiting-reason section                         | M      | S          |
| #574   | #826  | Overview: daily delivery and closure counts with evidence drill-down      | M      | M          |
| #574   | #827  | Overview: daily merged-PR counts with evidence drill-down                 | M      | S          |
| #702   | #828  | Human-work admission: submit command integration                          | M      | S          |
| #702   | #829  | Human-work admission: deliverable membership and PR attachment operations | M      | M          |
| #702   | #830  | Human-work admission: deliverable responsibility and recovery operations  | M      | M          |
| #702   | #831  | Human-work admission: completion and attestation operations               | M      | M          |

Each chart includes its own accessible table/help and exact ticket/date drill-down,
not a separate drill-down project. Reuse shared rendering/types where useful;
do not repeat native policy matrices in every chart. Overview closure/delivery
series remain distinct from the PR-merge population. Timing splits impact and
complexity first-assessment latency because each is a separately useful metric.

Configuration #818/#819 use the merged
[configuration layer contract](serve-configuration-layers.md): view first, then
editing over the shared configuration service. #812's project editor depends on
#819; reload #813 and shutdown #814 need #818's page surface, not the entire #584
umbrella. Existing guards stay; new security infrastructure remains deferred.
The standalone config CLI #815 does not depend on the page or application state.

Admission #828–#831 all consume #668's native admission service. Submission,
member/attachment edits, responsibility/recovery edits and completion/attestation
remain separately reviewable. Human ownership, an active claim, continuing
responsibility and verified delivery are distinct. Retain the exact-target,
permission, retry and human-direction requirements of existing merged contracts;
no child authorizes a competing TypeScript workflow-policy implementation.

## Shared metrics work: reuse what shipped

The ledger and bounded closure/label timeline shipped in #628 (`ae4c5dd`). UTC
windows, arithmetic statistics, first-pickup selection and delivery dating shipped
in #811 (`49f6233`). Do not reimplement those components. Some old source comments
and the original design's "not shipped"/"undecided" wording predate owner answers;
[owner metric decisions](dashboard-metric-owner-decisions.md) are authoritative.

Remaining runtime interfaces under #573 are:

| Child | Remaining deliverable                                                        | Complexity |
| ----- | ---------------------------------------------------------------------------- | ---------- |
| #832  | Current valid assessment grouping/provenance for shared chart consumers      | S          |
| #833  | Trusted first-assessment endpoint facts in the shared ledger                 | S          |
| #835  | Chart/news section composition over the shipped helpers and projections      | M          |
| #836  | Read-only metrics API, cache/cancellation and bounded collection integration | M          |

#834 was drafted while #811 landed and closed as a duplicate of its pure delivery
helpers. It is not another required implementation. #835 waits for assessment
facts/groups; #836 waits for composition. Existing chart/page consumers still wait
on #573 until its actual service/API acceptance is delivered. Closing a design
question alone cannot prove that API exists. No page should silently implement
unfinished upstream collection in order to draw one chart.

Use current valid complexity/impact grouping, the earliest reliable pickup source,
30-day history cap, per-group 20-completed percentile threshold and descriptive
metric help as already approved. Missing evidence stays explicit; no new owner
interview is needed on those settled definitions. Sankey/cohort-flow remains last
in #700/#689 and is outside these small sections.

## Readiness and review

Every child is human-assigned and has recorded impact/complexity provenance.
`status:ready` means the reviewed design is actionable, not that native blockers
are waived. Parents #584/#574/#576/#702 retain downstream integration acceptance
and historical work; do not claim those whole scopes as new monolithic work.
Inspect current ownership before pickup. Existing accurate merged contracts can
be reused; changed architecture still needs a separate reviewed docs PR.

#753's existing [Svelte Work spike](svelte-work-spike.md) already permits the
owner-approved read-only secondary `/work-preview`: multiple inline expansions,
retained surviving expansion IDs after refresh and shared native ordering/data.
No ticket mutation or immediate default-page replacement belongs in that demo.
Licensing remains bounded research #787 before #634; it is not an implementation
approval or a reason to ask the same settled GPL-version question again.
