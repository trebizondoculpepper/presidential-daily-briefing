# Read-only service diagnostics over REST

Contract for #459, following #390's minimum HTTP MCP briefings. First slice
implemented: `projects`, `cache` and `inflight` (with the envelope, cursors and status links);
`config`, `errors` and `rules` are not installed yet. It extends the existing
`/api/v1/status`; it does not duplicate the collector or expose raw process memory.
The owner wants small curl requests to explain the service's current state, even
when MCP has no equivalent tool. Dashboard editing and full CLI parity come later.

## Shared boundary

All diagnostic reads inspect already held state. They perform no GitHub request,
repository discovery, permission lookup, identity creation, configuration write,
cache refresh, rule evaluation over tickets, or background scheduling. Reading an
expired entry reports that fact without refreshing or promoting it. Startup with
an empty cache is useful and costs zero GitHub requests.

Reuse the server's localhost binding, Host/Origin validation, served-project
allowlist, request cancellation and shutdown handling. No new remote listener,
permissive CORS or privileged diagnostic token. A native curl client without an
Origin may use the existing local API boundary; a hostile browser origin cannot.
These endpoints do not expose the private instance-control capability or permit
registration/reload. Future remote serving needs its own access contract.

Keep `GET /healthz` unchanged: 200 accepting requests, 503 shutting down, no dependency
checks. GitHub failures are diagnostic observations, not proof the process is dead.
Existing `/api/v1/status` fields and version stay compatible. Link to the new views
through additive capability metadata rather than replacing that status schema.

## URLs and selection

All routes below are `GET`; other methods return 405 with `Allow: GET`. They use
JSON UTF-8 and `Cache-Control: no-store`, with no external resources. Unknown or
repeated parameters fail 400. `repo` selects an exact registered opaque repository
identity through the existing resolver; ambiguity requires a selection, an unserved
repository returns the existing unavailable error before any operation. Host/auth
context comes from the running service, never a caller-supplied credential.

| URL                            | Query                     | Existing state exposed                                                          |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------- |
| `/api/v1/status`               | none, as today            | Existing lifecycle, projects, cache totals and last observation                 |
| `/api/v1/diagnostics/projects` | `limit`, `cursor`         | Registered project identities, local-context availability and default selection |
| `/api/v1/diagnostics/config`   | `repo`                    | Effective allowlisted settings and their source scopes                          |
| `/api/v1/diagnostics/cache`    | `repo`, `limit`, `cursor` | Sanitized entry metadata, age, expiry and coverage                              |
| `/api/v1/diagnostics/inflight` | `repo`, `limit`, `cursor` | Shared collector activity and waiter counts                                     |
| `/api/v1/diagnostics/errors`   | `repo`, `limit`, `cursor` | Bounded sanitized recent diagnostic events                                      |
| `/api/v1/diagnostics/rules`    | `repo`                    | Loaded artifact identity, engine setting and existing validation state          |

`limit` defaults to 20 and accepts integers 1–100. List endpoints return `total`,
`omitted` and `nextCursor` with their rows. Filtering is applied before counting.
Sort projects by canonical served identity, cache rows by stable opaque entry ID,
inflight by start time then ID, errors newest first then ID. Never order by a
secret cache-key string. Entity IDs are scoped to one process instance and have no
authority; they are not control tokens or serialized raw cache keys.

Cursors carry an opaque process/list revision and offset. Validate length and
syntax before decoding. If the relevant inventory revision changed or the service
restarted, return 409 `DIAGNOSTIC_CURSOR_EXPIRED` with a first-page retry hint; do
not merge inconsistent pages or start collection to reconstruct an old view.
Changing only request time does not invalidate the inventory revision. No durable
snapshot store is required. Each response states when its metadata was observed.

## Envelope and content allowlists

New endpoints return this versioned envelope; domain rows have their own declared
TypeScript interfaces and are constructed field by field, never by spreading an
internal object and deleting known secrets afterward:

```json
{
  "schemaVersion": 1,
  "kind": "serve-diagnostics",
  "view": "cache",
  "observedAt": "2026-11-15T00:00:00.000Z",
  "instanceId": "public-random-instance-id",
  "selection": { "repository": "owner/repo" },
  "coverage": { "complete": true, "warnings": [] },
  "data": { "total": 0, "omitted": 0, "nextCursor": null, "items": [] }
}
```

The public instance ID is newly generated non-secret metadata, not a private
discovery nonce, capability or credential fingerprint. `selection.repository` may
be null only for views explicitly covering the entire registered set. Unknown
values are null plus a diagnostic, not invented zero/false or an empty successful
inventory. Coverage describes this diagnostic projection, not freshness of GitHub.

- **Projects:** `repository`, `host`, `default`, `hasLocalContext`, registration
  source (`configured`, `explicit`, `cwd`, or `unknown`) if actually tracked. Do not
  include absolute project paths, local file names, remotes with credentials or
  the global configuration's file content. Never infer historical registration
  source merely from the current working directory.
- **Config:** a typed map of `serve.port`, `serve.ttl`, cache capacity/stale window,
  `briefing.engine`, enabled assessment metrics, process-guide visibility and
  declared role defaults only where those settings exist. Each entry has `value`,
  `source` (`default`, `global`, `repository`, `argument`, `unknown`) and `known`.
  Include only keys registered as diagnostic-safe in the typed configuration
  registry. Unknown future keys are excluded until explicitly reviewed. Identity
  file contents, agent names imported from private config, token settings,
  filesystem locations and arbitrary environment variables are excluded. A
  served repo without verified local context reports applicable defaults and
  that repository-local settings were unavailable, not a claimed local read.
- **Cache:** `id`, `repository`, collector/profile name, declared coverage category,
  focused issue/PR number when part of the known typed key, `observedAt`, `storedAt`,
  `expiresAt`, age milliseconds, approximate bytes if measured, state
  (`fresh`, `expired`, `stale`, `invalidated`) and already tracked reuse counters.
  Return no cached payload, discussion text, arbitrary query variables, auth key,
  identity-personalized rendering or raw hash input. An entry removed by eviction
  no longer exists; do not fabricate a persistent invalidation history.
- **Inflight:** `id`, `repository`, collector/profile name, focused subject number
  when known, `startedAt`, elapsed milliseconds, waiter count and cancellation
  state when actually tracked. No raw GraphQL, subprocess arguments, request
  headers, per-agent private queue or stack traces. Collection belongs to the
  shared service, so do not attribute it to an agent merely from one caller.
- **Errors:** `id`, `repository` or null, `at`, registered operation name, safe
  category/code, affected source and a fixed remediation hint. Optional quota
  numbers/reset time are included only when actually observed through the typed
  telemetry boundary. Do not copy raw error messages, stderr, GitHub response
  bodies, URLs containing secrets, stack traces or local paths. Unknown failures
  use a generic diagnostic code. Keep at most 100 events in a memory ring, with
  `discarded` count and collection-start time. This is bounded recent history,
  not a full audit log; restart clears it. Reading errors creates no new events.
- **Rules:** configured engine, actually loaded engine if known, policy schema/
  version/hash, supported roles, known validator result and safe error code/time,
  and whether the compiler/rules page is available. Artifact validation may happen
  at normal load/build; this endpoint reports it without reloading/evaluating.
  It does not contain facts for specific tickets or a private native source path.
  Link to #392's represented rules when installed; otherwise say unavailable.

Existing services may lack some counters or timestamps. Add bounded instrumentation
at their real transition points; until then mark them unavailable. Do not add
background probes just to fill diagnostic columns. Shared raw facts must stay
repository/auth/profile isolated; diagnostic projection exposes only entries for
the selected served context. Unknown authentication isolation cannot justify
combining caches. Lists across projects still exclude any retired/unserved context.

## Failures, budgets and discovery

Argument/access errors reuse the existing typed HTTP error envelope. New cursor
errors are documented above. Construct/redact errors at the boundary; even a bad
query value must not reflect a supplied secret in an error body. If instrumentation
cannot be read, return a bounded incomplete diagnostic with a safe code, or a
typed 500 when no valid document can be produced. Never claim an empty inventory.

List limits and the existing bounded JSON policy apply. Prune whole rows and
increment omission counts rather than cutting JSON bytes; when constrained, keep
the envelope and a truthful size-limit notice. A client can request smaller pages.
Do not introduce a new mandatory minimum-size error for the ordinary briefing;
that output policy remains #379. Diagnostic endpoint schemas do not alter MCP.

Document curl examples using the actual printed server URL:

```sh
curl --get 'http://127.0.0.1:4372/api/v1/diagnostics/cache' --data-urlencode 'repo=owner/repo' --data-urlencode 'limit=10'
curl --get 'http://127.0.0.1:4372/api/v1/diagnostics/errors' --data-urlencode 'repo=owner/repo'
```

These examples perform no collection. To request fresh facts the caller separately
uses an existing read/refresh endpoint and its documented behavior. Diagnostics
must not imply freshness merely because their own `observedAt` is recent.

## Acceptance

Use injected clocks, cache/collector/config boundaries and synthetic safe/secret
sentinels. Prove startup/empty/expired/inflight/error/shutdown reads issue zero
GitHub calls and do not renew expiry, evaluate rules or create work. Assert exact
schemas and positive allowlists, including new unknown internal fields; secrets,
local paths and error payloads must never appear in successful or failed output.
Test project/auth isolation, no-local-context settings, unknown counters, bounded
error-ring eviction, cursor restart/revision changes, bad/repeated parameters,
HTTP methods, Host/Origin checks, cancellation and limits/omission notices.

Packaged smoke: start with fake gh that records every invocation, read all diagnostic
URLs from an empty service, and prove no new gh invocation beyond the documented
startup identity resolution. Existing health/status and HTTP MCP tests remain green.
Native-client acceptance is not required for curl diagnostics and is not implied
by SDK tests. Record what changed in implementation docs without claiming the
whole server epic complete.
