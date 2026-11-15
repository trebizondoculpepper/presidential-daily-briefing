# Per-request GitHub evidence and failure classification

Contract for #293. This is documentation before implementation, not new runtime
instrumentation. It supports collection profiles (#366), independent read coverage
(#369) and safe server diagnostics (#459). Review quotas from Codex/CodeRabbit are
separate services and are never added to GitHub's API allowance.

## Current gap

`ghQueryWith` in `src/github/github.ts` invokes `gh api graphql`, then parses stdout
as JSON. Its sanitized error discards response headers; `rateLimitFailure` can
therefore promise a reported reset when none was actually preserved. It recognizes
`RATE_LIMITED`, while an observed failure used `RATE_LIMIT`/`graphql_rate_limit`.
REST and GraphQL errors need one evidence model, not a growing collection of
regexes over entire private responses.

During readiness work a minimal GraphQL quota query returned a structured rate-limit
error while that same response's headers reported a full allowance. This proves
the need to retain conflicting signals; it does not identify the cause, credential
bucket, proxy behavior or a reliable retry time. The synthetic acceptance fixtures
must reproduce the contradiction without committing live snapshots or credentials.

## Transport boundary and compatible adapter

Keep authenticated `gh`, `execFile` without shell, existing cancellation/timeouts and
buffer limits. Add a typed `parseGhResponse` boundary for included HTTP metadata and
the body; preserve GraphQL `Query` returning its existing data object and current
REST answer compatibility. Supply optional injected operation context and a bounded
telemetry observer; old callers can keep their existing signatures. Observers must
not throw into the collector or change successful results.

Use the installed CLI's supported response-header output for both success and
nonzero-exit responses. Parse status/header blocks separately from the JSON body,
including case-insensitive names, CRLF, absent headers and legitimate multiple
HTTP blocks. Reject ambiguous/malformed framing rather than splitting at arbitrary
body text. Select the final applicable API response, not a proxy connection status.
No request header or subprocess argument is logged. Preserve existing NOT_FOUND-only
GraphQL/null-data diagnosis; telemetry does not convert it into a general failure.

## Allowed request evidence

One event per actual gh/API attempt, from an injected clock/monotonic duration:

- schema version, stable request/operation/profile/source IDs, host/repository and
  focused numeric subject when explicitly part of typed operation context;
- method, route category (registered template, not arbitrary URL/query string),
  start/finish time, duration, attempt number and cancellation state;
- HTTP status, gh exit category and bounded registered GraphQL error type/code;
- UTF-8 body byte count when known, distinct from total stdout bytes; do not claim
  compressed wire bytes or network transfer measurement from a decoded body;
- observed GraphQL cost and per-resource limit/remaining/used/reset, plus the
  resource name, Retry-After and safe GitHub request ID from an explicit header
  allowlist. Missing values are null, not zero or inferred from another request.

Parse numeric ranges and timestamps; do not accept arbitrary header strings as
output text. Retry-After may be a valid bounded duration or HTTP date, recorded
with the response time so clock assumptions remain explicit. Malformed values are
unknown plus a safe diagnostic. Reset epoch and GraphQL reset time remain separate
signals when they disagree. Record whether evidence came from this response header,
this response's `rateLimit` object, or another explicitly named observation.

No raw query, variables, body, stderr, auth headers/token, command line, environment,
private local path or repository discussion text survives. Register operation IDs
in code; never let a caller inject arbitrary prose into them. Request IDs are bounded
nonsecret source identifiers, not a new authorization capability. Existing private
file/log boundaries still apply; this work creates no telemetry upload service.

## Classification from source evidence

Keep a typed safe failure category with observed signals and confidence:

| Evidence                                                                              | Classification/advice                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Explicit structured `RATE_LIMIT` / `RATE_LIMITED` or registered rate-limit error code | Rate limited; subtype may remain unknown                                                          |
| Rate-limit refusal plus same-response remaining zero and consistent reset             | Primary quota evidence; report that observed reset as an earliest retry candidate                 |
| Explicit secondary/abuse-rate signal in GitHub's error fields                         | Secondary rate limit; honor observed Retry-After; no guessed quota reset                          |
| Explicit resource/node/query-cost refusal                                             | Resource/query limit; reduce the query/profile; waiting alone is not a proven fix                 |
| HTTP 401 or documented gh authentication-required exit                                | Authentication/access failure; existing auth guidance, not automatic login or credential rotation |
| HTTP 403 without decisive rate metadata, or forbidden structured result               | Access refused/unknown cause; do not call every 403 rate limiting                                 |
| Process timeout, explicit cancellation, network failure, 5xx                          | Their distinct categories, preserving partial source results                                      |
| Unrecognized/malformed failure                                                        | Unknown failure with safe code, not a guessed primary quota                                       |

The allowlist of secondary/resource signals is implemented and tested from the
actual GitHub error envelope, not a search through user content. Unrecognized codes
remain unknown. A repository comment saying "API rate limit" cannot classify a
successful response. Error text is inspected only in the transport's actual GitHub
error fields, with bounded recognized patterns; arbitrary stderr is never echoed.

Contradictory evidence is explicit. For example, a quota refusal with same-response
remaining > 0 is `rate-limited` with `quotaEvidence: inconsistent`; retain both the
error and numeric fields and explain that the cause/retry time is unproven. HTTP,
GraphQL and header disagreement must not be flattened into a confident message.
Do not declare that a different credential was used without evidence. Do not trust
a separate aggregate `/rate_limit` response to override this failing request.

## Reporting, aggregation and retry

Keep existing snapshot `metrics.requestCount`/`durationMs` and public errors
compatible. Add a versioned bounded operation summary: total attempts, completed/
failed/cancelled count, body bytes, known cost sum and unknown-cost count, plus
latest per-resource observations. Cost sums only distinct attempts; retries count
again. Do not sum remaining allowances from different calls/resources or call a
partial known-cost sum the whole request's cost. Per-source coverage links failures
to operation IDs. Budgeted lists report omitted event counts.

Default text remains short: identify the failed source/category and grounded next
step/reset if known. Detailed metadata is available in structured diagnostics, not
repeated on every to-do row. When no reset was observed, say that rather than
"retry after the reported reset". Inconsistent quota says so explicitly. Errors
must remain safe even if the observer or response parser fails.

This ticket does not introduce automatic retries, polling, another credential or
paid quota upgrades. Existing retries/backoff use only the appropriate observed
signal and bounded policy; unknown/inconsistent evidence cannot authorize an
unbounded loop. Current/history degradation and last-successful snapshot behavior
are #369–#371, not a side effect of adding telemetry.

## Acceptance

Use injected gh/clock/observer responses: success with and without headers, header
case/framing variants, nonzero exit with valid body, partial GraphQL errors and
NOT_FOUND-only diagnosis. Cover RATE_LIMIT and RATE_LIMITED, zero/nonzero/missing
remaining, same-response contradiction, conflicting reset values, Retry-After
duration/date, malformed fields, secondary/resource/403/401/5xx/network/timeout/
cancellation, and unknown errors. A successful response containing rate-limit words
in issue content must remain successful.

Assert exact safe schemas and additive old-query/REST/snapshot compatibility;
secret/URL/body/argument/stderr sentinels never appear, even on parser/observer
failure. Verify request/cost/byte aggregation across retries and independent sources,
explicit unknown/omitted counts and bounded event retention. Package tests use a
fake gh, no live snapshots, account changes or GitHub writes. Record actual request
savings only after the separate narrower-collection implementation is measured.
