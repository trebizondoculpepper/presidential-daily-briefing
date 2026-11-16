# Shared GitHub quota command and visual page

Contract for design #546, CLI/service #547 and serve page #548. Reuse the #293
request evidence contract and #459 diagnostic allowlists. The endpoint/view is an
explicit diagnostic request; default role briefings stay compact and unchanged.
This document does not implement the command, page or refresh behavior.

## One view of observed allowance

GitHub primary quotas have separate resource buckets. Return a versioned typed
`quota-view` with host, safe account/context label, observation time, source,
freshness/coverage and resource rows. Each row contains resource ID, limit, used,
remaining, resetAt and its own observation/source. Nullable evidence stays null;
missing is not zero. Use bounded registered fields, not a spread of API/error objects.

Data comes from the existing authenticated gh transport, without a shell or new
credentials. An explicit quota read may call `GET /rate_limit` once. It makes no
ticket/PR/dependency scan. Reuse the established authenticated-context resolver;
if a CLI invocation requires a separate identity read, allow at most one additional
bounded request and count it. Failure to establish the context prevents cross-call
cache reuse, not a guess about another login. Do not require a successful GraphQL
query merely to inspect exhausted GraphQL allowance: use the existing gh-selected
context or another supported independent boundary. Do not read credential files directly.

Normalize REST core, GraphQL, search and supported additional resource families
returned by GitHub. Keep family units distinct: REST request allowance is not
GraphQL query cost, and specialized search resources need not share a window.
Never sum remaining values into one 'total capacity'. Cap rows at 20, with total/
omitted counts and explicit unsupported-family coverage if a future API exceeds
the registered representation. No silently comprehensive claim from a partial list.

Accept only safe finite nonnegative integers and valid reset timestamps. A zero
limit or unknown/inconsistent counts has no meaningful percentage bar. If `used`
is absent but limit and remaining are valid, an explicitly labelled derived used
value may be `limit - remaining`; it is not a measured request count. Contradictory
values (negative, remaining greater than limit, incompatible totals) preserve safe
source evidence with an inconsistency flag, not a clamped 'healthy' number.

The same-response header observations collected by #293 remain authoritative for
their individual attempts. Aggregate `/rate_limit` and per-response observations
can disagree, including across GitHub regions; do not force monotonic remaining
values, average observations or overwrite a failing request's evidence with a
later aggregate success. Show the aggregate row and a bounded relevant discrepancy
notice, with each source/time. A successful quota lookup never clears the original
failure or proves why it happened.

Usage is for the authenticated host/account context and can include other agents,
machines or applications. PDB sees only the requests it observes; it cannot attribute
all used allowance to this repository, a particular agent or the current command.
Model-provider, Codex and CodeRabbit review quotas are separate and are not part of
these meters. Account labels are focus metadata, not new authorization.

## Secondary limits and recent events

Secondary throttling has no advance remaining meter. Always state `Secondary limits:
unmetered` rather than inventing a percentage, remaining write count or 'all clear'.
Display recent classified throttling/resource-limit events from the existing sanitized
telemetry/error ring for the matching host/auth context. Retain category, observedAt,
safe operation label and known Retry-After/reset timing. Never infer a secondary
refusal merely because a primary meter is low, or classify all 403s as throttling.

Default to the 10 most recent relevant events, with retained/discarded/omitted counts
and the observation window. A new CLI process may have no retained history: say
'no events observed in this process', not 'no throttling'. Do not build a persistent
account-wide audit log. Events from another auth context are not exposed. A stopped/
restarted service loses its memory history and reports that limit honestly.

A known Retry-After is an earliest retry bound for the affected operation, not a
promise that any request will succeed at that time. Existing recovery/mutation
policies keep control. This feature neither schedules a retry nor gates/authorizes
claims, merges, completion, writes or paid quota upgrades.

## Lazy freshness and bounded reuse

Use one in-memory quota service with a 60-second TTL per verified host/auth context.
No file persistence, prefetch, timer polling, startup request, all-project fan-out or
background refresh. A first explicit request fetches; concurrent readers share one
in-flight lookup. Repeated CLI invocations in separate processes may each fetch;
do not claim they share the server cache unless explicitly connected to that service.
Within serve, the web and diagnostic API share the same held view.

A user-requested refresh bypasses fresh cached data but joins an already-running
refresh for that context. Each reader can cancel independently; cancel the underlying
lookup only when no reader remains, and prevent late results from populating another
context/generation. Use the existing transport timeout/cancellation boundaries, at
most five seconds for quota collection and no automatic retries. Cache failed attempts
for ten seconds as failures so repeated page requests do not hammer the endpoint;
that does not make a prior success fresh. A refresh during an observed retry embargo applicable to the quota lookup
returns held evidence plus the known embargo rather than sending early. Exhausted
GraphQL primary allowance alone does not forbid the separate REST quota lookup.

**Owner clarification for the serve page (#548, 2026-11-15), superseding the next paragraph for the page only:** when a page refresh fails, clear the prior quota numbers and show the error; do not leave an older reading visible as if current. The CLI and service may keep the last-good behaviour below. Fetch only on explicit Refresh; the page does not fetch on open.

If refresh fails, retain a matching last-good observation at most five minutes for
explicit stale display, alongside the current failure and its category. After that,
show unavailable/unknown numeric state. Age is measured from the actual observation,
not when HTML or JSON was produced. A reset time crossing invalidates that bucket's
claim to current capacity even inside TTL: show 'reset passed; refresh needed'. Do
not synthesize a fresh full allowance or automatically fetch on countdown expiry.
Clock rollback produces an unknown/stale diagnostic, not negative age or infinite TTL.

Offline requests perform zero API calls and show only held observations as stored/
unvalidated with their age, or unavailable. No quota cache grants fresh mutation
authority. Keep host/auth identity changes isolated, including a switched gh login;
unverified identity means no reuse of another account's last-good result.

## CLI and JSON (#547)

Add `pdb quotas [--json] [--refresh] [--offline]`, with mutually exclusive refresh
and offline. Resolve GitHub host/auth using the same supported runtime selection
as other commands. The command does not require a project or silently scan one;
any existing explicit project selection is used only to resolve that supported
host/context. Reject ambiguous/unavailable context helpfully, never enumerate accounts
or fall back to another credential. Document the actual supported flags in help.

Text has a short host/account/fetched-at header and one compact line per resource:
`GraphQL: 253 / 5000 used (5.1%); 4747 remaining; resets 09:42 UTC` is illustrative,
not a live fixture. Follow with brief deterministic narration for non-normal states,
secondary-unmetered status and material freshness/conflict warnings. No duplicated
per-row boilerplate. JSON uses the shared versioned fields, not parsed narration.
Keep stdout valid; transport/parser errors never leak stderr/query/token contents.

Exit 0 means this diagnostic returned a fresh internally usable primary view, not
permission or safety to issue more work. A known exhausted quota can still be a
successful diagnostic. Exit 2 means partial/stale/unavailable evidence; exit 1 is
invalid arguments or refused context. A new optional quota service cannot change
existing briefing command exits or schemas.

## Serve JSON and visual page (#548)

Add `/quotas` and `GET /api/v1/quotas` through the existing local serve router.
The new quota read API is explicitly allowed to fetch on request; it is **not**
one of `/api/v1/diagnostics/*`, whose existing no-GitHub-fetch contract stays intact.
Use the same selection/registered-project host-context rules as other served reads;
a caller cannot supply an arbitrary host, login, token or filesystem path. Where
selection is needed, use the existing registered project selector and make the
account-wide scope clear. Do not aggregate the same account quota once per repo.

API parameters are `repo` only where needed by that resolver, and explicit Boolean
`refresh`/`offline`; reject unknown/repeated/invalid combinations. Return the shared
quota-view JSON with `Cache-Control: no-store`; the service TTL is independent of
browser caching. Wrong methods return 405. Authentication/access failures remain
safe typed failures/partial views. Preserve existing Host/Origin/loopback handling,
redaction and error conventions; no capability/session ID becomes authentication.

The HTML shell itself makes no GitHub request, and opening the page fetches nothing (owner decision on #548): the quota view is requested only when the human presses Refresh, and before that the page says no reading has been taken. Show loading, manual Refresh, observation time/age and
one card per resource. For valid known limits use a native accessible meter/progress
presentation with text used/remaining/limit, percentage and reset time/countdown.
Default presentation thresholds (owner-confirmed on #548): warning at 20% remaining (80% used) and critical **below** 5% remaining (more than 95% used). The shipped classifier (`rowState` in `src/github/quotas.ts`) rounds usage to one decimal and marks critical at `percentUsed >= 95`, so exactly 5% remaining is critical today. #548 compares unrounded counts instead (`remaining * 100 < limit * 5` for critical, `remaining * 100 <= limit * 20` for warning), because a strict comparison on the rounded value would classify 9,501 of 10,000 used as warning. The rounded percentage remains for display only. Otherwise as before:
100%/zero remaining is exhausted. Label these as PDB display heuristics, not GitHub
limits on burst behavior, forecasts or guaranteed remaining requests.

Unknown, zero-limit, inconsistent, stale and reset-passed readings have visibly
qualified states; no green full-capacity bar for unknown evidence. Preserve raw safe
counts in detail when a bar is not valid. Text/icons accompany color, with keyboard
and screen-reader labels and narrow-screen layout. Counts and reset dates use the
same shared model as CLI; the local countdown may update visually without any API
polling. Escape account/resource/error strings as text; no external chart library,
CDN, credential-bearing links or HTML injection. Switching selection cancels/ignores
old requests so account A's result cannot flash under account B.

**Delivered (#548).**

- `GET /api/v1/quotas` and `/quotas` are implemented in `src/serve/quotas-page.ts`. They use one `QuotaService` per server, keyed by the server's verified gh host and login, and draw the secondary-limit history from the serve cache's sanitized error ring for that login (`quotaTelemetry`).
- The API accepts only `refresh` and `offline` (each `true` or `false`, once, not both).
- The page takes no parameters, reads nothing on open, and draws a native `<meter>` with text counts and a text-and-symbol state only for valid current readings. A failed refresh clears every number.
- `rowState` now compares unrounded counts, so the CLI uses the same thresholds.

## Acceptance and readiness

Use injected gh/clock/telemetry/cache boundaries and synthetic fixture accounts;
no live exhausted-quota tests or credential changes. Cover:

- fresh resource families, units, numeric validation/derived values, zero/unknown
  limit, missing family and bounded unknown/omitted resources;
- aggregate/header disagreement, later larger remaining counts, quota refusal with
  apparent headroom, secondary warning with healthy primary counts, and no fake
  throttle-free claim from an empty local event ring;
- reset/rollover, countdown crossing, stale refresh failure, five-minute last-good
  expiry, failed-attempt cooldown, offline, clock rollback and timestamp provenance;
- auth/host isolation, unverifiable identity, selection change/late result, in-flight
  coalescing, independent abort, deadline and no unrequested/polling API calls;
- CLI text/JSON/status parity, deterministic narration, invalid flags, secret/path/
  raw-error sentinels, existing telemetry/parser compatibility and packaged help;
- serve route/selection security, no fetch from existing passive diagnostics, no request on page open, one request per explicit Refresh, prior numbers cleared on refresh failure, accessible normal/warning/critical/exhausted/
  unknown/stale/error rendering, mobile layout and API/CLI parity.

Record request counts: quota collection makes one quota request plus at most one
necessary context read, no repository scan. A visual screenshot is layout evidence,
not proof of live quota accuracy or that secondary limits can be predicted.

#547 implements the shared service and CLI after this contract merges. #548 then
reuses that delivered service; it must not create a second collector. Merging the
contract completes #546, not either runtime ticket. Initial impact M on all three
remains recorded; implementers estimate runtime complexity independently.

## Primary references

Checked on 2026-11-15; no live snapshot or secret is embedded in this contract.

- [GitHub rate-limit overview](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Rate-limit resource endpoint](https://docs.github.com/en/rest/rate-limit/rate-limit)
- [GraphQL resource limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
