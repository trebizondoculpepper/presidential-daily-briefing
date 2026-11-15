# Bounded workflow comment-write recovery

Contract for #345. Reuse #293's response-bound telemetry/classification and the
existing mutation plans, trusted record parsers and idempotence checks. Telemetry
alone does not retry writes. This contract adds a shared comment-post recovery
boundary for estimation, claim/release, needs-human/question outcomes, delivery,
submission, completion and correction commands. Do not wrap arbitrary mutations
in a generic retry loop.

## Preserve workflow semantics

Each command keeps its existing ordering, guards, record schema and recovery
semantics. Freeze the target and exact intended comment before the first attempt;
keep its operation identifier, timestamp and body unchanged through this recovery
attempt. Reuse the command's existing operation/semantic identity, not a new random
identifier on retry. Where estimates use semantic provenance identity rather than
an opId, retain that full existing comparison and frozen record. Labels already
written are not rolled back; label writes are not repeated by the comment helper.
A failed comment-first handoff cannot advance dependent label steps.

The caller supplies explicit post, read-back, applicability-check and cancellation
boundaries. The shared helper knows transport outcomes and the budget; the command
owns whether a record is trusted, equivalent, superseded or still applicable.
Never treat a text substring, another author's copied marker or a record on another
ticket as proof this operation succeeded. Retain repository/issue binding and the
existing verified GitHub author/permission checks. Source text is not authority.

No issue lock or global exactly-once guarantee is introduced. GitHub comment POST
is not an idempotent endpoint; a local operation identifier is a receipt key, not a
server-enforced idempotency key. Concurrent processes can still race. Detect and
report duplicate/conflicting receipts through existing folds rather than deleting
history or silently choosing one.

## Classify the individual failed attempt

Reuse the same-response observation from #293, retaining safe request ID, status,
error category and retry metadata. Do not classify a generic 422/403 as secondary
throttling: validation, permission and authentication failures keep their own
categories. An explicit secondary/content-creation throttling refusal can qualify;
the observed 'submitted too quickly' case needs an attributable GitHub API error,
not a phrase in an issue body. A nonzero gh exit alone does not prove rejection.
Partial GraphQL errors require the actual addComment result to be inspected.

Outcomes are:

- Confirmed posted: valid returned comment identity/URL, or a trusted matching
  receipt observed by read-back. Continue using that identity, then run the caller's
  normal final verification.
- Explicitly refused and retryable: attributable GitHub throttling response with
  no successful addComment result. One bounded retry may be considered.
- Definitely refused and not retryable: validation/auth/permission failure. Return
  without a retry and show the specific recovery.
- Acceptance unknown: transport loss, timeout, cancellation after dispatch, malformed
  response, contradictory success/error or an unclassified failure. Read back when
  permitted, but do not repost automatically merely because no receipt was found.

A read-back search uses the command's bounded complete-history/source checks. One
matching trusted receipt proves the post; conflicting or duplicate matches stop for
inspection. An absent receipt in an incomplete history is unknown. Even a complete
read showing absence cannot establish nonacceptance after a transport-loss race;
report the uncertainty and a supported inspect/resume path instead of blind POST.

## Wait, revalidate and retry

For an explicitly refused retryable attempt, inspect for an already-existing matching
receipt before retrying. If it exists, return it without a second POST. Otherwise
honor an observed valid Retry-After. If same-response primary quota is also exhausted,
respect its reset as well: never retry before either applicable lower bound. Without
usable timing on an explicit secondary refusal, wait at least 60 seconds, following
GitHub's guidance. An invalid or contradictory timing header is not permission for
an immediate retry; retain the safe secondary default and explain unknown timing.

Defaults: at most two POST attempts total, at most one automatic retry, and a
90-second overall recovery deadline measured from the first dispatch. Include
post/read-back/revalidation time in that deadline. If the required wait will not fit,
return promptly with throttled/partial/unknown status and the observed earliest
retry time (or the conservative retry delay, labelled as a default). Never cap a
long Retry-After downward and send early. No polling, background queue or scheduled
write continues after the command returns.

Wait through an injected abortable timer, holding no local file lock or server-wide
request lock. Revalidate live operation-specific guards after the wait and immediately
before retry: issue state, ownership/waiting eligibility, relevant labels/provenance,
record supersession and required permissions. If the intended frozen operation is
no longer applicable, stop and report conflict; do not silently regenerate a different
operation. Cancellation prevents any new dispatch, including retry and read-back.
An in-flight dispatched write on cancellation remains potentially accepted.

A second throttling refusal ends automatic recovery; return the newer response's
safe timing evidence. Do not hide it behind the first response's quota. Future
configurable retries would require a separately bounded policy; this slice needs
no new settings or credentials. In a long-running process, serialize this helper's
POST dispatches per authenticated context and space content writes by at least one
second. Independent callers remain cancellable; no cross-machine quota coordination
or permanent credential fingerprint is claimed.

## Results and integration

Preserve public exit-status meanings and existing partial-write fields. Add bounded
structured recovery details: category, attempt count, acceptance state, wait applied,
observed retry-after/reset (when known), default-delay indicator, safe request ID,
matched receipt URL and failed/skipped step. Redact tokens, raw bodies/environment
and headers outside #293's allowlist. Text gives one concrete next command; don't
announce success until the caller's normal verification passes.

Known successful prior steps remain recorded. A write that may have succeeded is
not labelled definitely failed. Estimation preserves the applied size and reports
whether provenance was confirmed, refused or uncertain; rerunning retains existing
trusted semantic deduplication. Comment-first release/needs-human stops label steps
until the receipt is confirmed. Delivery/submission resumes its recorded operation
rather than replanning over newer state. No automatic close, reassignment, rollback,
comment edit/deletion or credential rotation is introduced.

Integrate both existing transports: gh argument-array comment commands and GraphQL
addComment. Share recovery logic and telemetry normalization rather than making the
shell wrapper retry all gh calls. CLI/MCP/serve cancellation and response deadlines
must reach the same service; an HTTP disconnect cannot create an orphan retry.
Current read caches are invalidated only through their existing successful/uncertain
write handling, never marked fresh because a retry was attempted.

## Acceptance

Use injected post/query/clock/timer/auth boundaries with no real waits or GitHub
writes. Run existing mutation suites plus shared helper and representative adapter
integration tests:

- explicit secondary refusal then success, missing Retry-After's 60-second minimum,
  valid seconds/date timing, primary reset plus secondary delay and invalid timing;
- long Retry-After exceeding deadline: prompt return, zero early retry;
- retry refused again, attempt/deadline bounds, cancellation during wait and dispatch;
- generic validation 422, permission 403, auth failure and network 5xx are not
  automatically reclassified/reposted as secondary-limit recovery;
- accepted POST with lost response, successful read-back and exactly one POST;
  missing/incomplete/denied read-back remains unknown with no automatic repost;
- spoofed/copied/wrong-ticket receipt, duplicate or conflicting receipts, changed
  ownership/labels/permissions and superseded estimate during the wait;
- labels-first estimate keeps its label, comment-first handoff skips later labels,
  delivery resumes its original opId, all final verification failures stay visible;
- per-context serialization, queued cancellation, unrelated contexts and JSON/stdout
  safety; every supported comment-posting command actually uses the shared boundary.

An automatic retry test proves only bounded behavior for explicit refusal. It must
not be described as proving exactly-once delivery under arbitrary network failure.
Complete #345 only after runtime integration and these tests, not this docs PR.

## Source

[GitHub's REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately)
were checked on 2026-11-15. They recommend honoring response retry timing, waiting
at least a minute without it, bounded retries and serial/spaced content mutations.
No live throttle was induced for this design.
