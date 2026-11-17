# Typed GitHub capabilities and application composition

Owner decisions, 2026-11-17: audit #868, GH service foundation #869,
PDB serve composition #870, and application state #816. This is a
contract amendment, not runtime delivery. Existing CLI/MCP/HTTP interfaces,
workflow rules, configuration semantics and recovery guarantees remain in force.

## Application-facing GH service

Application callers use typed asynchronous capabilities for GitHub operations,
not a raw command/API proxy. Group capabilities by purpose: account/context,
issues, pull requests/reviews, dependencies and workflow writes. Exact method
catalogues come from #868's call-site inventory; the audit records inputs,
required fields, pagination and preserved behavior rather than inventing one
universal GitHub object. Reuse existing domain types and error classes where
accurate. A method may combine high-level GH commands with REST or GraphQL;
that choice stays inside its implementation.

The low-level argument-array runner remains an internal, injectable transport.
It owns direct process execution without a shell, explicit execution context,
AbortSignal/deadline handling, bounded output and factual attempt diagnostics.
Distinguish spawn failure, nonzero exit, timeout and cancellation. Do not expose
credentials, private request bodies or unrestricted subprocess stderr in normal
application results. Capability adapters validate responses into typed results;
a TypeScript cast alone is not response validation. Preserve absent/unknown and
partial data rather than manufacturing complete empty results.

A factory receives the transport, clocks and existing shared boundaries. No
process-global selected repository, account or agent may leak between callers.
Repository/host/account context is explicit or resolved by the existing documented
CLI/server selection rules. Continue using authenticated `gh`; do not introduce
new credentials, a competing HTTP client or browser-to-GitHub calls.

The service supplies facts and operations. Native rules remain the source of
workflow eligibility, ordering, ownership and admission decisions. Domain reads,
mutation planning/recovery and presentation do not move into a command runner.

## Typed results and shared caching

Return the smallest existing/proposed typed domain result sufficient for callers.
Preserve current schema versions and transport adapters. Carry or retain access to
observed-at, freshness, coverage/completeness, omissions and error provenance at
the read-service result boundary. Raw JSON is parsed inside the capability; an
opaque passthrough dictionary is not the normal application-facing contract.

A shared read-service/cache adapter may wrap capabilities. Reuse the current
bounded cache, in-flight joining, cancellation ownership and explicit-refresh
machinery; do not stack a second independent cache under already cached reads.
The transport runner itself does not decide freshness or cache workflow policy.
Key results by verified host/account/repository plus capability arguments and
required coverage; never reuse another identity/project's facts. Preserve current
TTL, stale-on-failure and authentication/refusal rules rather than choosing new
values in this refactor. An explicit fresh read cannot silently return stale
facts. Cache provenance must describe the actual observation, not retrieval time.

Mutations are never cached and are not retried blindly. Preserve the existing
comment/write recovery boundary, receipts and uncertain-outcome handling.
Invalidate affected cached facts after confirmed changes; uncertain outcomes
must prevent affected cached data from being presented as confirmed current.
Define invalidation membership in each migrated capability, conservatively when
necessary. No background polling or prefetch is introduced by service creation.

## Composition versus state

PDB serve's application composition service/factory (#870) creates and connects
configuration, application state, existing GH adapters, read services, cache and
HTTP/MCP/lifecycle dependencies. Keep an explicit typed dependency graph rather
than a service locator or new dependency-injection framework. Construction should
not fetch issues or create agent identities as an incidental side effect.
Startup operations retain their existing explicit preparation and authentication.

The configuration service remains independent: read/list/set, validation, safe
writes, revision and factual diffs. The CLI calls it directly. The application
state service (#816) is serve-only: it tracks initial/running, saved and applied
configuration, computes live/restart consequences and explains them. It does not
construct unrelated services. Composition instantiates it, and the Configuration
API/page displays its results. Do not persist a restart dirty bit; returning a
restart-only setting to its running value removes the derived restart reason.

Composition owns startup and shutdown sequencing. Partial startup releases only
resources it actually acquired. Shutdown is bounded and idempotent, respects
in-flight request/subprocess/MCP cancellation, and does not kill another running
instance. Preserve existing Host/Origin/CSP controls; new security infrastructure
remains deferred. The extraction does not change normal `pdb serve` or mandate
application composition for short-lived CLI config operations.

## Separate Git boundary and research gate

Git is distinct from GitHub. #872 compares mature typed Git libraries with the
current injected `GitRunner` against actual PDB operations. A library wrapping the
installed Git executable and a library implementing Git are different choices;
neither is automatically safer merely because its interface is typed.

The report inventories discovery, remotes, revisions, worktree/status and any
actual write consumers, then checks typed results, response interpretation,
worktrees, cancellation/errors, credentials/configuration, supported platforms,
maintenance/license and packaging. Use bounded credential-free disposable probes;
no user's checkout/global settings or live remote writes are research fixtures.

Application callers should eventually use typed Git capabilities independent of
that library choice. Do not adopt a library or migrate callers before the research
recommendation and a focused follow-up contract are reviewed. The initial report
must schedule small estimated service/migration follow-ups, carrying limitations
explicitly; do not invent support for untested operations. Git research is a
high-priority child of #875, but is not a blocker for independent GH audit or
serve configuration/state work. Application composition receives both boundaries
through explicit injection rather than mixing Git and GH into one raw executor.

## Delivery order and focused acceptance

1. #868 produces a concise inventory of modules, direct/indirect GH touchpoints,
   underlying API operations, proposed typed capability methods and caching needs.
   Update it for mixed high-/low-level commands; one CLI command need not equal one
   endpoint. The audit does not implement the service or every migration.
2. #869 supplies the shared injectable transport/factory and initial typed account
   and repository-context capabilities, preserving current wrapper behavior.
   The audit must confirm the initial surface before implementation; remaining
   methods/callers become small follow-on migration tickets, grouped by behavior.
3. Each migration names callers, typed inputs/results, response validation,
   pagination/completeness, cancellation, errors, cache/invalidation and recovery
   checks. Preserve existing injection seams with adapters while consumers migrate.
   Converge on one execution boundary; do not maintain two competing implementations.
4. #870 extracts composition independently using existing adapters. It need not
   wait for every GH migration, and #816 need not wait for this structural cleanup.

Use injected transport/clock/filesystem/configuration boundaries. Focus tests on
literal arguments, context isolation, abort/deadline/error classification, typed
response validation, cache freshness/invalidation and partial-start cleanup.
Retain existing workflow/native tests without cloning their matrix into each
capability. One packed CLI/MCP/serve smoke proves integration outside the checkout.
The docs amendment itself requires formatting only. Implementation tickets remain
open until their own runtime acceptance is delivered.
