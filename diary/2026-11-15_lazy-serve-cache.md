# Lazy serve cache and invalidation (#453)

Claimed as priya_xu through PDB after full ticket/dependency intake and reading the
merged collection-profile and serve contracts. Reused the shared shortlist plan;
added separate typed whole-discovery and complete selected-issue fact cache seams,
with profile/coverage keys and original source timestamps. No collector, policy,
page cache or background prefetch was duplicated. Cache hits replay coverage/quota,
not another caller's network telemetry. Selection and rendering remain per caller.

Fixed the invalidation race: an earlier fetch cannot be inserted or labelled live
after invalidation, nor overwrite a newer repository observation. Added a service
mutation wrapper that delegates to an existing live writer and invalidates all
held contexts after applied/uncertain outcomes; no HTTP write API was introduced.
CLI/external mutations remain subject to TTL/manual refresh. Injected tests cover
separate hydration, repeated/shared reads, expiry, partial coverage, bounds,
cancellation, quota propagation and successful/uncertain write races.

No TODO.md exists in this checkout. Work remains subject to full checks and review;
this diary does not claim the ticket delivered before the PR is merged.

Completed per-issue membership for partially overlapping selections while batching
missing records under the declared concurrency bound. Shared cancellation retains
other callers; quota/cooldown refusals retain partial evidence without fabricating
GitHub reset metadata. Final local validation: check (zero errors, 51 existing
warnings), 2,243 tests passed (one existing skip), build and installed package test.
