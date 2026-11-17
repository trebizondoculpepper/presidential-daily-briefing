# Owner-approved metric grouping and implementation handoff

Addendum for Overview #574, Timing #576 and public reuse #633. The owner answered
#573's four questions in the recorded discussion; the decision is
[issuecomment-6901259058](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues/573#issuecomment-6901259058)
and the explicit `pdb question resolve` record on that ticket. This addendum
supersedes conflicting as-of-event grouping, mandatory assignment-history reads
and unanswered-question wording in the earlier metrics contract. It does not
claim #573's active integration work or any chart implementation is complete.

## Settled definitions

- Use the **latest valid complexity assessment** for delivery and throughput
  grouping. State that in the chart help; historical groups may move after a
  reassessment. Use the same current assessment fold/evidence as other views,
  including explicit unassessed, stale, conflicting and unknown categories. Do
  not turn an arbitrary current label into trusted provenance.
- Backlog by impact uses current valid impact. Pickup-delay grouping can likewise
  use current valid impact for a simple, consistent planning view; label it as
  current impact rather than pretending the estimate existed at pickup.
- First pickup uses the simplest reliable existing evidence: a trusted PDB claim
  record, or a trusted agent-assignment timeline event when that is already
  available. Show the source in drill-down. A current label or an issue update
  timestamp is not a historical pickup. Missing/bounded history stays unknown.
  Do not require new exhaustive timeline reads merely to prefer one evidence
  source over the other. Preserve the earliest proven pickup across handoffs.
- Initial history/cohort requests are capped at 30 days. Earlier missing pickup
  or assessment endpoints remain unknown; do not synthesize them at the window
  boundary. Current-inventory views are a separate population from the creation
  date cohort, so older open/stalled tickets remain visible where appropriate.
- Show median first, mean and completed sample count alongside it. Percentiles
  require at least 20 completed members in that displayed group, not 20 across
  unrelated sizes. Use one documented shared method (nearest-rank for p75/p90 is
  sufficient); median of an even count is the mean of its two middle durations.
  State the method in help and test its boundary cases.
- Every metric has concise contextual help: definition/endpoints, time window,
  population, inclusions/exclusions, grouping basis and missing-data limits.
  Clicking a group reveals the supporting tickets and evidenced dates.

These are elapsed durations, including waiting and reviews, not active agent CPU
or model time. First valid pickup to the last required PR merge is delivery time;
agent handoff does not reset it. Incomplete deliverable membership, unknown merge
containment, open work and missing endpoints are reported separately rather than
removed to make averages smaller. Issue closure and PR merge counts are distinct.

## Existing architecture remains

Reuse dashboard-pipeline-metrics.md's ledger, UTC windows, coverage and shared
read API. Native rules decide workflow states/eligibility; TypeScript may fold
validated historical events, aggregate durations by the supplied metric model,
and render the result. Do not add chart-local readiness, a second ranker, live
visitor credentials or an independent public-site collector.

Overview keeps 6h news by default with 1h alternative, and 7d rates with 30d
alternative. Zero-event known days differ from unknown days; exclude the current
partial UTC day from complete-day averages and say how many days are covered.
Keep verified deliveries, unverified completed closures, abandoned work and PR
merges separate. No weighted productivity points or combined misleading total.

The public site consumes the same definitions and release-validated bounded public
snapshots with source/version/capture date, sample counts, coverage and the same
help. It does not relabel a dated example as live or expose private projects.

## Small implementation order

Keep #573's reviewed service/integration prerequisite and its current owner intact.
Its existing ledger/window/API slices remain reusable prerequisites, not a demand
for one omnibus chart PR. #574 and #576 can proceed independently after those
services are available; #633 still waits for its native chart/site prerequisites.
The simpler Pipeline Health sections #682–#688 remain independent, and final
cohort data #700 / Sankey #689 remain last. No new dependency cycle is introduced.

Use injected events/clock for first pickup, release/reclaim, multi-PR membership,
reopen/unknown history, stale assessments, reassessment regrouping, 19/20 sample
threshold, zero versus unknown days, UTC boundaries and complete-day averages.
Prove that displayed group counts and drill-down membership agree. Avoid repeating
whole native-rule matrices through every chart. A narrow/wide accessible visual
pass and one packaged service parity case suffice for the page handoff.
