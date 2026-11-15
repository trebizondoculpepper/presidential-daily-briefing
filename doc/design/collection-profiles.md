# Lightweight discovery and targeted hydration

Contract for #366, implemented by #367/#368 and reused by #453. It reconciles the
owner's direct-dependency scope (#196), focused ticket view (#197), cache research
(#198/#202), current blended policy and strictly lazy service. This document changes
no runtime behavior. The old fixed "estimation last" wording on #196 is superseded
by the merged blended-action/assessment-first contracts; collection does not choose
a different priority order.

## Observed boundary

`src/github/github.ts` currently defines shared issue fields including bodies and
`comments(first:100)` and PR fields including nested review threads/reviews. Thus
request count alone understates the cost of a routine or focused read. Recent
rate-limit failures during focused intake make the separation operationally useful.
The #198 report measured cheap manifests but found timestamps/head SHAs insufficient
to validate check completion and cross-reference changes. Reuse those findings;
do not claim a new performance measurement from this design.

## Typed profiles and coverage

Collectors accept registered profile names, not caller-provided GraphQL strings.
Profiles declare sources, fields, pagination bounds and cost categories. Add a
versioned internal source-coverage map rather than using empty arrays as "not read".
Each source records `state: complete|partial|not-requested|failed`, observation time,
continuation/omission information, safe failure code and profile version. Unknown
is never complete. Public existing schemas retain their fields and gain explicit
coverage; readers must be updated coherently before selective collection is enabled.

Initial profiles:

- **discovery-v1:** issue/PR identity, title, URL, state, created/updated time,
  complete labels, and native dependency summary plus bounded direct identities
  where needed for ranking. PRs include head/base identity and draft state. No
  bodies, comments, review bodies/threads, check runs, commit history or permission
  calls. Discovery establishes candidates and cheap known facts, not readiness.
- **issue-detail-v1:** selected issue body, current labels, direct native blockers/
  dependants, current claim generation and relevant complete workflow-record history
  through the existing bounded readers. Load comments/editor/permission evidence
  when a decision depends on it. Partial history stays partial, including when a
  newer unseen record could supersede one already found.
- **pr-status-v1:** selected PR head/base/draft/state, checks, reviews/threads and
  current-head review receipts required by the shared acceptance classifier, plus
  relevant delivery membership/responsibility evidence. The existing trust boundary
  remains mandatory. No historic review rounds unless explicitly requested.
- **review-history-v1:** the existing explicit PR-history diagnosis, independently
  bounded and labelled; never implicit in a routine role queue.
- **compatibility-full-v1:** the existing full snapshot/intake contract, including
  documented full-history requests. Preserve it for explicit full/offline/checkpoint
  consumers while lightweight commands are rolled out. Do not silently reinterpret
  absent old-schema fields as complete evidence.

Use per-source observations; an overall request timestamp cannot freshen reused
facts. A discovery `updatedAt`/head match may select a candidate for reuse, but does
not revalidate volatile checks, permissions, review state or missing cross-references.
Production manifest/conditional reuse is not authorized merely because the #202
experiment measured it. Enable only the reviewed read-profile/cache behavior here.

## Command read plans

| Consumer                             | Read plan                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routine role briefing / MCP briefing | Discover all open work, rank candidates with explicit unknowns, hydrate the relevant priority frontier, then rerank and apply the requested output limit         |
| `pdb ticket N`                       | Selected issue detail and actual linked PR status profiles, per consolidated-ticket-view.md; no unrelated repository catch-up                                    |
| Existing `--issue N` full intake     | Preserve its promised full machine interface; an explicit compatibility profile may remain broader until equivalent coverage can be delivered without field loss |
| `deps N`                             | Selected native direct dependency report; do not read discussion/reviews unless another requested feature actually requires them                                 |
| `deps N --tree`                      | Explicit bounded traversal, separate telemetry and truthful partial graph/continuations                                                                          |
| `pr N` / `pr N --history`            | Selected PR status / explicit history profiles; no whole-repository discussion                                                                                   |
| `who N`                              | Selected issue/claim/delivery records plus actual linked PR evidence                                                                                             |
| `team`                               | Complete project ownership inventory, then relevant claim/delivery/PR evidence; do not pretend it is a top-ten queue                                             |
| Catch-up `briefing --last/--since`   | Current inventory and all-state history are separate sources; #369 defines failure/degradation rather than making one erase the other                            |
| Health/status/diagnostic REST        | Existing held state only; no profile is invoked by a diagnostic read                                                                                             |

The selective `--issue` implementation #367 must preserve its full-interface promise
or add an explicit new opt-in profile; it cannot reduce completeness by merely
dropping JSON fields. The new ticket command gives the bounded focused answer now.
MCP/HTTP/CLI reuse the same service plan; transport is not another collection policy.

## Ranking before limiting, without pretending unknowns are low priority

Keep every discovered candidate in the shared fact model before output limiting.
Labels/native evidence needed for eligibility are separately complete or unknown.
Comment-backed addressed requests, ownership, delivery and reviews are unknown until
hydrated; absence from discovery is not evidence that such obligations do not exist.
Feed explicit unknown facts to the native rules. Never generate a claim/merge command
for a candidate whose required eligibility/acceptance evidence remains unknown.

Hydrate candidates whose known or possible rule bands could affect the requested
shortlist, including owned work, PR obligations, explicit attention and unknown
ownership/record candidates. Re-evaluate after hydration, expanding the frontier
when a newly discovered obligation can alter ordering. The default output limit
is not a hydration limit and must not hide a higher-priority uninspected candidate.

A fixed request/target budget makes collection bounded; it cannot prove that every
unknown candidate is irrelevant. If the frontier cannot be closed within that
budget, return the useful known actions plus prominent inspection/coverage gaps,
label ordering provisional and disclose the unexamined candidates/count. Do not
call that an authoritative top ten or silently rank all unknowns below known work.
Apply the output limit only after this shared ranking step. Exact-mode tests compare
against the full profile; bounded-mode tests assert qualifications rather than false
parity. Adversarial fixtures put an important record after the initially cheapest
candidate so a naive first-N hydration strategy fails.

## Pagination, concurrency and telemetry

Paginate issue and PR connections independently with stable cursors and actual
`pageInfo`/total counts. Never share a cursor across connections. Separate native
edge, comment, review and history coverage; reading one page is not a complete
inventory. Begin with existing collector page/history bounds where defined, and
declare the chosen bound in the profile. New unbounded loops are prohibited.
The three-page cache experiment is not a global production completeness guarantee.

Run at most three independent hydration requests concurrently, with cancellation
and shared rate-limit backoff. Stop scheduled reads on a definitive quota failure;
retain completed sources and report which targets were not attempted. Retries obey
actual reset/retry evidence when known, not an invented delay. Do not retry through
another token or silently fan out across credentials. The shared #293 telemetry
boundary records operation/profile, source/subject, request count, returned bytes,
duration, observed GraphQL cost/remaining/reset and safe error category. Unknown
cost is null, not zero; source query shape has a stable ID without secret variables.

Make bounds explicit typed options in the collector/service boundary and report
effective values; help/config exposure follows existing validation. The first slice
does not introduce a universal user-facing tuning schema. Inject small bounds in
tests. Runtime request/work budgets may lower coverage, never weaken authorization.

## Direct unlock evidence: #196

Routine prioritization reads direct edges only. Count each distinct otherwise-ready
unclaimed dependant for which completing the candidate removes its last open native
blocker. Reuse existing status/platform/claim and complete-label gates; unknown
conditions contribute to an unknown/lower-bound set, not a proven unlock. Distinguish
dependants with other blockers from immediately newly eligible work.

A delivery with several required PRs is one candidate completion. Do not add the
same downstream count once per PR or claim a first PR merge completes the delivery.
Estimation improves decision confidence and clears no native edge. These facts feed
the current blended rules; they do not reinstate a fixed estimation-last order or
introduce an arithmetic impact/complexity ratio. Preserve explicit oldest/newest
policy modes. `--tree` remains an explicit graph diagnosis with separate bounds and
no false complete-tree claim. Injected graphs verify request volume as well as counts.

## Service cache integration: #453

Cache discovery/issue facts separately from required hydration coverage. Keys include
host, verified auth context, repository, profile/version, focus/coverage and relevant
arguments; never reuse a low-coverage result as a higher-coverage hit. Shared raw
facts are not another agent's rendered role queue. Resolve caller focus and current
project settings per request, then project through shared rules.

All fetching remains demand-driven. No startup/registration/poll/expiry prefetch.
Use five-minute initial TTL, configurable up to ten minutes, and memory-only data.
Expiry makes the next requester wait for a new read; concurrent compatible reads
coalesce. A manual refresh follows the existing explicit invalidation/read behavior.
The existing bounded labelled stale-on-failure window stays governed by serve.md;
it does not authorize stale mutation checks. No independent page-level cache.

Successful or uncertain writes through an implemented service mutation boundary
invalidate affected issue facts and derived role/dependency/ownership views. Reuse
existing mutation outcomes; invalidation must not manufacture an HTTP write API
before #455's contract. Conservatively invalidating the whole affected repository
is a valid initial implementation when precise reverse dependencies are unknown.
Invalidate known affected served cross-repository dependency contexts too; otherwise
declare those contexts subject to TTL/manual refresh. Do not claim global invalidation.

Use an invalidation generation per affected key/context so a fetch started before
a write cannot repopulate a current cache after the write completes. Discard that
cache insertion; its waiting readers receive an explicit stale/invalidated result
or wait for a new generation according to the existing read contract. Independent
CLI/external writes are visible through TTL/manual refresh unless a real supported
notification mechanism has shipped. Restart loses cached facts, not global project
configuration. Mutations always use fresh underlying evidence outside this cache.

## Rollout and verification

Merge this contract before #367/#368. Enable profile-aware fact extraction and
coverage guards before dropping eager fields, not afterward. #367 ships selected
read plans and compatibility; #368 ships bounded frontier hydration/ranking;
#453 integrates the service cache and invalidation without duplicating those readers.
#196 consumes the shared direct-impact facts and current priority policy. Parent
#294 remains open until its actual read implementations and measured cost outcomes
ship; documentation alone does not complete it.

Required fixtures: complete versus truncated discovery, late high-priority comment,
unknown/denied permissions, role/platform separation, missing labels/edges, multi-PR
delivery deduplication, native last-blocker counts, closed/unplanned blockers, head
change during PR hydration, current/history independent failures and offline old
schema coverage. Assert no unrelated hydration for focused ticket/deps/PR reads,
bounded request/concurrency counts, full-profile parity when all relevant facts are
known, and explicit provisional ranking when they are not. Cache tests use fake
clocks for TTL/coalescing, coverage keys, invalidation-generation races and no eager
comment loading. No live mutation, credential rotation or universal speedup claim.
