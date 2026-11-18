# Shared services and explicit state ownership

Owner decision, 2026-11-18, #961. This generalizes the Git/GH lesson to every
shared application capability. It governs new work and reviewed migrations; this
document does not claim all existing code already complies or authorize a broad
runtime rewrite.

## One canonical capability boundary

When several parts of PDB use the same external system, resource or coordinated
capability, define one canonical typed service contract and implementation owner.
Consumers call that service instead of creating parallel clients, executing the
underlying utility directly, parsing its raw output independently, or copying its
cache/retry/lifecycle machinery. Extend the existing capability when appropriate
rather than introducing another access path with similar responsibilities.

The public boundary supplies named asynchronous operations and typed, validated
results where I/O is involved. Keep raw utility arguments, API queries, response
parsing and transport details inside its private implementation/adapters. Preserve
explicit unknown/partial evidence, freshness and established error/recovery
semantics. Workflow policy remains in native rules; owning an adapter does not
make it a second permission, ranking or ownership engine.

Canonical means one owner and public contract, not one enormous source file.
Interfaces, private adapters and focused helpers may span several files within
the capability's owning area. Follow [source layout](source-layout.md): explicit
module imports, no generic shared/utils/services dumping ground, barrel layer or
service-locator registry. Pure formatting, arithmetic and immutable data helpers
may remain ordinary shared functions; they do not need artificial service classes.

## Stateful capabilities have an explicit state-holder wrapper

If a shared capability retains mutable state across calls, provide one named,
scoped state-holder wrapper around its operations. It owns that mutable data and
its synchronization/lifecycle; callers receive the typed facade, not mutable maps
or ad hoc state copies. Keep external execution/domain operations distinct from
state storage and management, even when a small implementation keeps the private
state-holder and factory in the same module.

State includes caches, in-flight requests, cursors, subscriptions, connection pools,
applied-configuration snapshots and long-lived resource handles. Its contract
must name:

- lifetime and scope: invocation, application/process, session, request, project
  or account as appropriate;
- who creates and disposes it, and which consumers share the instance;
- context partitioning, concurrency/cancellation ownership and update rules;
- reset, invalidation, expiration and failure/uncertain-outcome behavior;
- persistence, if any, and the boundary responsible for reading/writing it.

The application composition root creates/injects the required wrapper and shared
service instance once per declared scope. Consumers must not create their own
copy of supposedly shared state. Multiple isolated scopes are legitimate; a
canonical service is not an implicit process-global singleton. Do not mix accounts,
repositories, checkouts or sessions through hidden selected-context variables.

Prefer a stateless operation core where practical, with mutable coordination in
the explicit holder. An existing named stateful component such as ServeCache or
application state can already fulfil that role when its ownership, API and
lifecycle meet this contract; do not wrap a state-holder in another meaningless
state-holder. Do not invent state for a stateless capability.

Expose bounded read-only diagnostics/snapshots only where needed. Inject clocks,
transports, filesystems and state boundaries for focused tests; do not expose
internal mutable collections merely to make tests convenient. A wrapper must not
silently introduce a second cache, polling loop or new persistence format.

## Construction, controllers and dependencies

The application composition root owns dependency construction, injection, explicit
startup and bounded cleanup. Keep factories free of hidden collection or identity
setup; acquire resources through documented startup operations. Feature services
coordinate domain operations through injected capability facades. CLI, HTTP and
MCP controllers validate input and project service results; browser pages consume
backend APIs. Controllers do not construct independent shared clients or hide
state in transport-local globals.

Keep responsibilities separate. Configuration owns values, validation and factual
changes; serve application state owns running/applied snapshots and consequences;
composition wires them. The existing
[configuration-layer contract](serve-configuration-layers.md) and
[application-state contract](serve-application-state.md) retain their semantics.
The [Git/GH composition contract](github-service-composition.md) supplies a concrete
example: one facade of each kind per application lifetime, explicit request
context, and shared read caching rather than independent per-page clients.

## Required design and review guardrail

A change adding or expanding a shared capability must identify its canonical
owner/public entry point, existing consumers and any existing service it reuses.
If state is retained, name the holder, scope, creator, cleanup and invalidation
rules. Reviewers must reject new parallel access paths or hidden shared mutable
state that bypass those boundaries; having a convenient local wrapper does not
satisfy the rule when it recreates an existing capability.

A new implementation boundary or changed state contract requires the separate
reviewed architecture documentation already required by AGENTS.md. Record
approved exceptions narrowly with scope and rationale. Existing direct-use debt
must have an explicit migration plan; do not treat it as an automatic exception
for new callers or mix an unrelated repository-wide cleanup into a feature PR.

The owner's release/standalone-tooling direct-Git exception remains in force.
An application helper is not exempt merely because it sits in scripts/. Test
fixtures and display-only user commands are distinguished from real execution.
This general principle does not silently expand or revoke capability-specific
exceptions.

This guardrail is a design/review requirement now. Focused automated boundary
checks can enforce known concrete access points (for example #953 for Git/GH),
but cannot prove that two services have no overlapping conceptual responsibility.
Do not claim universal automated enforcement from this document alone.
