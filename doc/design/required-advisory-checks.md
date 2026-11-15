# Required and advisory PR checks

Contract for #343. Extend the existing collection-profiles, declared-review-policy
and delivery-follow-up-alignment contracts; do not replace their review, coverage,
merge-target or mutation safeguards. This is a design contract, not a claim that
the current collector already returns required-check metadata.

## Outcome

Only pending **required** checks make an otherwise actionable non-draft PR wait
for checks. A pending advisory job is context, not a reason to postpone a ready
review or merge consideration. A positively observed failed or cancelled check,
including an advisory check, remains a follow-up finding under the existing
failure policy. The owner still decides whether that failure is acceptable; this
change does not auto-merge or waive it.

Requiredness is independent of outcome, review acceptance and evidence coverage.
Never infer requiredness from a job's name, a green aggregate rollup, how long it
has run, or a bot being rate-limited. The existing registered `verify` policy is
an additional required floor, not a repository-specific special case or proof
that no other checks are required.

## Evidence model

For a selected PR, collect current head SHA, base repository and base branch.
Each check retains its existing identifier, name, outcome and URL plus a
three-state requiredness: required, advisory or unknown. Record the source and
PR/base binding. The same name from another app is not interchangeable with an
app-constrained required context. Preserve check-run app IDs and legacy status
context identity where available; ambiguous duplicates remain unknown.

Also collect the expected required set, with source coverage independently known
or unknown. Visible checks alone cannot prove that an expected check never ran.
Expected requirements bind context name and app/integration identity where the
source specifies one. Normalize equivalent duplicate requirements without losing
source attribution. Missing expected checks are unknown/not-yet-reported, never
passed or advisory. A known empty GitHub-required set does not remove the
registered workflow's required checks.

A pure shared classifier returns observed failures, required pending checks,
advisory pending checks, missing required checks and unknown required evidence.
All engines and read surfaces consume that model rather than independently
matching names or interpreting raw aggregate status. Existing raw snapshot fields
stay compatible; new coverage fields are additive. Old snapshots without the new
metadata have unknown requiredness, not an empty required set.

## Collection and cost

GitHub GraphQL `CheckRun.isRequired` and `StatusContext.isRequired`, explicitly
bound to the selected pull request, classify visible contexts. Verify the selected
API/schema supports the field; a missing/null/error result is unknown. Do not use
an unbound default that might answer for another PR.

Expected-set discovery must cover both active rulesets and legacy branch
protection. The effective branch-rules REST endpoint returns active applicable
rulesets, including higher-level sources; evaluate/disabled rulesets are excluded.
Read its `required_status_checks` requirements. Independently inspect the selected
base ref's legacy `branchProtectionRule.requiresStatusChecks` and
`requiredStatusChecks { context app { databaseId } }`, preserving app identity
constraints. A successfully read null legacy rule establishes no legacy rule;
permission errors, unsupported fields or missing coverage do not. An ambiguous
HTTP 404 is not evidence that the branch has no requirements. The implementation
must demonstrate complete expected-set acquisition with fixtures before setting
that coverage flag; use a bounded targeted legacy read if the selected GraphQL
fields cannot preserve the constraints.

Do not weaken expectations to the subset whose metadata was readable. Conflicting
or unsupported requirement types yield a named unknown gap. Merge queues, required
workflows, deployments or non-check restrictions must not be relabelled advisory:
retain their independent merge-state/acceptance blockers. A complete check set
proves check readiness only, not overall permission to merge.

Hydrate this only for selected PR-status/acceptance candidates, not discovery
rows. Share an in-flight base-policy read across PRs with the same repository,
base ref and authentication context during one collection. Allow at most two
additional bounded reads per distinct base for ruleset/legacy metadata; if that
budget or a required page is exhausted, report incomplete. Do not fetch every
ruleset individually or traverse all branches. Preserve telemetry #293 and
measure requests, GraphQL points, bytes and latency against the current collector.

Any cached classification is bound to head, base and collection generation with
visible fetch time. Retargeting invalidates it. Mutating completion/merge paths
re-read their existing live evidence; a cached expected set never grants authority.
An API outage leaves a useful read with explicit unknown required evidence rather
than silently treating all jobs as advisory.

## Ranking and explanation

Keep the existing draft/negative-evidence/coverage ordering. For non-drafts:

1. Observed failures or requested changes remain actionable, even if other
   evidence is incomplete, as specified by delivery-follow-up-alignment.
2. Incomplete requiredness, expected-set or check coverage produces an inspection
   action and a reason naming the gap. It cannot prove acceptance.
3. Known required pending checks mean waiting; missing expected checks mean
   required evidence unproven. Neither means the ticket's responsibility ended.
4. Advisory pending checks alone do not create waiting. Apply the remaining
   current-head review, unresolved-finding, merge-state and delivery rules normally.

Datalog decisions and reasons come from the same matched rule and normalized
facts. TypeScript compatibility uses the same check classifier and parity fixtures.
A reason may say “Required checks passed; advisory jobs are still running.” Do
not say “ready to merge” when another acceptance condition remains unknown.
Expose required/advisory/unknown groups in focused PR JSON/detail. Default compact
output stays small and omits empty groups; any omission preserves coverage notices.
No GitHub configuration, branch protection or review policy is changed by a read.

## Acceptance

Use injected GitHub/clock boundaries; no live writes or fixed repository identities.
Rules-only fixtures test decisions separately from collector/infrastructure failures.
Cover both check runs and legacy statuses, including:

- required pending, advisory-only pending, all required passed and known empty set;
- required `verify` absent even with unrelated green checks;
- a configured but never-reported check, app-constrained same-name checks, duplicate
  ambiguous runs and mismatched base/head;
- legacy protection only, ruleset only, both, higher-level ruleset, null legacy
  rule, denied/unsupported legacy metadata, partial pagination and unknown fields;
- failure/cancellation in advisory and required checks, including failure with
  incomplete other evidence; draft WIP still follows the existing draft policy;
- pending advisory CodeRabbit/quota job or FreeBSD trial does not block otherwise
  valid follow-up; generic green bot status never substitutes for review approval;
- retargeting, stale/offline snapshots and missing newly introduced fields;
- equal outcomes/reasons across CLI, MCP, serve, delivery and both engines;
- two PRs sharing a base coalesce metadata reads, distinct auth/base keys do not,
  budget exhaustion stays unknown and discovery makes no new metadata request.

Report measured collection cost. Keep `verify` and review gates independent.
Completing #343 requires delivered runtime and these tests; merging this document
only makes that implementation ready.

## Implementation note (#343)

`src/github/requiredchecks.ts` holds the shared model. `hydrateRequiredChecks` runs in `collect`
for open, non-draft PRs with an unfinished check only. It makes one effective-rules REST read
and one legacy `ref.branchProtectionRule` GraphQL read per distinct base, shared across PRs, plus
one `isRequired(pullRequestNumber:)` read per candidate PR, bound to its head and base. Discovery
rows and PRs without unfinished checks make no new request. Any unreadable source, page limit,
or a head/base that moved during the read is a named gap. It becomes a `${pr.url}:` warning,
which both engines already treat as incomplete PR evidence (inspection, never acceptance), and
the expected set is then `null`, not empty. `classifyChecks` is the pure classifier: required,
advisory and unknown pending checks, and expected required checks not yet reported (matched by
context and app). TypeScript `pr-pending` and Datalog `pr-pending` exclude only checks known to be
advisory and add missing required checks; the Datalog host passes the classification in
(`checkRequiredness`) so the lazy engine chunk imports nothing new. A PR without evidence (old
snapshots, an injected collector without a REST boundary) keeps every pending check unknown,
which waits as before. Measured on this repository with two candidate PRs: 6 GraphQL requests
in total, of which the hydration added 3 (one per PR plus one shared legacy read), plus 1 REST
rules read.

## Verified sources and bounded probe

On 2026-11-15, read-only schema introspection confirmed both GraphQL types expose
`isRequired(pullRequestId, pullRequestNumber)`. One effective-rules read for this
repository's main branch returned an active app-constrained `verify` requirement.
This establishes API availability, not cross-platform acceptance or a production
collector implementation. No check settings or branch rules were mutated.

- [GitHub check-run/status GraphQL objects](https://docs.github.com/en/graphql/reference/objects)
- [Effective rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
- [Legacy status-check protection](https://docs.github.com/en/rest/branches/branch-protection#get-status-checks-protection)
