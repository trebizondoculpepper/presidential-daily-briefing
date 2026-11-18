# Live application with request-context isolation

Contract for #808, child of #452. It refines the "Live application" row of
[serve-configuration-layers.md](serve-configuration-layers.md): actually applying a live saved
change (the served projects set and supported live keys) to a running `pdb serve`, isolating each
request's context so obsolete in-flight reads cannot escape, and reporting the outcome to the
application-state service (#816). Nothing here is implemented by this document.

The reviewed baseline already shipped: the configuration service
([configuration-service.md](configuration-service.md), #804, `src/config/globalconfig.ts`), the
application-state service ([serve-application-state.md](serve-application-state.md), #816,
`src/serve/appstate.ts`), and the startup/registration contract
([serve-startup-configuration.md](serve-startup-configuration.md), #443).

## Boundary

| Layer                       | Owns                                                                                                                   | Does not own                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Config service (#804)       | Reading/validating/writing `config.toml`; `LoadedGlobalConfig` snapshots; `globalChanges`                              | Running-server state, what a change means, applying it           |
| Application state (#816)    | startup/applied/saved snapshots; live-vs-restart consequences; `recordApplication`                                     | Applying projects, request isolation, cache invalidation         |
| **Live application (#808)** | Applying a live saved change to the running serve (projects/contexts, cache epochs) and reporting the applied revision | Deciding whether a change is live or restart-only (#816 decides) |
| Reload (#813), page (#584)  | Triggering reload; presenting state                                                                                    | Their own consequence or application calculation                 |

#808 sits **inside** `pdb serve`: it consumes a fresh `LoadedGlobalConfig` plus the current served
set, computes the new context set, and drives the cache's epoch/generation boundaries. It never
writes configuration itself and never decides consequence policy.

## Live keys, and when application happens

Per #816's consequence table, only `serve.projects` is live in this slice (`serve.ttl` and
`serve.port` remain restart-only and are never applied live). Application is triggered by a reload
operation (#813) after a configuration write; for #808 the application function is the shared
machinery both the reload endpoint and the Configuration page drive.

Given a fresh saved snapshot, the live-application step:

1. Computes the **context set** the saved snapshot implies: each saved registration (repository
   with its optional verified `localRoot`, canonical dedupe). This is the **full membership** the
   server will serve after application. Startup inputs — the server's working directory or
   explicit `--repo`/`--project` targets — applied at process start and are **not** re-derived
   here: live reconciliation never re-adds a startup/cwd target the user removed, so a removal
   (including of the repository containing the working directory, or of `config.toml` entirely)
   is honored as a removal. The **current** context set is the one the server is running with,
   which may be a superset (startup inputs + previously applied registrations) until this
   application takes effect.
2. **Unchanged contexts** (same repository + verified root + host, and no other change to
   the facts they depend on) are reused as-is: their cache entries stay valid and are not
   re-collected. No registered project is prefetched.
3. **Added contexts** become selectable/served immediately (a new project appears in the
   selector/API once applied and acknowledged).
4. **Changed contexts** (same repository, different verified `localRoot`, or a change to the
   identity/configuration context that repository resolves against) are invalidated: their cache
   entries and in-flight reads for the **old** context are rejected, and the new context is
   served fresh.
5. **Removed contexts** are dropped from the served set; their cache entries and in-flight reads
   are invalidated/cancelled. Removing a project deletes no files, repositories, tickets,
   assignments or agent work (#813 requirement).

## Request-context isolation (generations)

The cache already tracks a monotonically increasing **generation** and a per-repository **epoch**
(`src/serve/cache.ts`), and refuses to serve a value a concurrent invalidation superseded
("Facts were invalidated while this read was running"). #808 defines the live-application use of
that machinery as one **context generation pass**:

- Each successful live application advances the server's context generation. Selection, identity
  resolution, cache lookup and the final response all carry the generation they started under.
- An in-flight response that started under an earlier generation and completes after a later
  application is **rejected** (never delivered as fresh facts), matching the existing
  invalidated-while-running guard. Rejection answers the data envelope's error with
  `CONTEXT_CHANGED`. Responses that are still useful as unchanged-context facts survive: the guard
  re-selects the request's repository from the current served set and only rejects when its
  context was actually changed or removed.
- A request may be **cancelled** voluntarily (reload transport) or **rejected** on completion;
  the distinguishing outcome is reported faithfully (cancelled vs complete-but-stale vs fresh).

This keeps "old in-flight responses cannot escape after context invalidation" true, including
across an A → B → A transition (the cache's existing `generation` already refuses to resurrect an
older epoch).

## Cross-repository dependency provenance

A registered project's briefing/dependency facts can reference another registered repository
(native `blockedBy`/`blocking` across repos). When a context is changed or removed, we
**conservatively invalidate** cross-repository dependency facts whose provenance points at the
changed/removed context — re-computation is cheap and correctness beats staleness. Reuse of an
unchanged context does not invalidate its cross-repo facts.

## Verified saved roots

A saved `localRoot` is verified against its repository before it is served, reusing the startup
verified-checkout boundary (`resolveServeProjects`): a root that is missing, or now belongs to
another repository, serves the repository without a local project; a root whose identity cannot
be read right now is kept as saved. A live reload and a fresh start therefore agree on a moved
checkout, and `readApi` never resolves one repository's identity from another checkout.

## Reporting and acknowledgement

- The live-application step reports to #816 through `recordApplication({ revision, applied,
  failed })`: `applied` lists every live key (in practice `serve.projects`) whose new context set
  was applied and acknowledged; `failed` lists keys whose application failed, with the error.
- Only keys that actually applied advance #816's applied snapshot; `appliedRevision` advances only
  when every differing live key succeeded. A failure is **never** reported as success.
- A persisted-but-not-acknowledged outcome is explicitly partial: the config write succeeded but
  live application failed or was rejected, and the caller is told what to retry (reload).
- `config set` releases its configuration lock **before** notify/reload, so the live-application
  step never holds the config lock while waiting on the server.

## Tests

Injected filesystem/clock/transport boundaries, no real user configuration or GitHub:

- added/unchanged/changed/removed project contexts, and an A → B → A transition;
- removed roots/projects are dropped and their entries/flights invalidated;
- identity-before-cache races: a request that resolves identity for context N and finishes after
  context N+1 is rejected;
- cross-repository dependency provenance is invalidated conservatively on changed/removed context
  and preserved for unchanged context;
- partial application: some repositories apply, others fail; retry of the same revision succeeds;
- failure never reports success and never advances `appliedRevision`;
- no-op reload applies nothing and reports nothing new.

## Delivery

One implementation PR after this contract merges: a live-application service in `src/serve/`
driving the served set and the cache's generation/epoch boundaries, wired into reload (#813) and
the Settings page (#584). Preserve schema compatibility, injected boundaries and existing
CLI/MCP behavior. Do not implement restart-only keys live and do not prefetch projects.
