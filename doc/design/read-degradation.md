# Useful reads when collection is incomplete

Contract for #369, implemented by #370/#371 under #295. Reuse the collection-profile
coverage boundary, existing explicit offline/cache/checkpoint interfaces, and the
bounded MCP envelope. This document changes no runtime behavior or storage policy.

## Separate sources, separate truth

Current open inventory and all-state change history are independent collection
sources. A failed history query must not discard a successful current inventory.
Conversely, historical changes are not a complete current inventory. Run/track the
sources independently through injected readers; retain their successful outcomes
when another source fails. Stop unscheduled requests on a definitive quota error,
and mark them not attempted instead of manufacturing successful empty responses.

The shared coverage model names each source, requested time/window, observed time,
state (`complete`, `partial`, `not-requested`, `failed`), omitted/continuation data
and a sanitized failure category. Add `current` and `history` source summaries to
the public read coverage without removing existing fields. Overall completeness is
false whenever a source required by the request is incomplete. A history window
that was not requested is out of scope, not a failure. "No changes" is permitted
only for a completely observed requested window containing no changes.

Keep per-source facts and timestamps. Successful current facts can still support
recommendations whose required evidence is complete, even when unrelated history
failed. Missing current ownership/label/PR evidence cannot be filled by assuming
historical data is current. Rule inputs retain their normal unknown gates; no
generic "some data arrived" approval. Detail/omission links explain the unfinished
source. Text leads with useful next actions and a compact scope/failure notice,
not an empty report or a dump of exception text.

## Source/outcome matrix

| Current inventory    | Requested history | Result                                                                               |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| Complete             | Complete          | Full current report and complete changes window                                      |
| Complete             | Partial/failed    | Current report retained; partial history and explicit gaps; incomplete overall       |
| Partial/failed       | Complete          | Observed current facts and history retained; no claim of complete current priorities |
| Partial              | Partial           | Useful observed facts plus both sets of gaps; provisional ranking where relevant     |
| No usable live facts | Failed            | Consider an explicitly compatible available snapshot; otherwise typed failure        |
| Complete             | Not requested     | Ordinary current report; no historical claim                                         |

A source-specific error is not proof that every source failed. All-state discovery
and permission errors remain unknown for affected decisions; they are not zero
unlocks, no work, no questions or acceptance. Retain transferred/unavailable subject
diagnoses and closed-source exclusions rather than deleting them to simplify output.

Implementation note (#370): `collect` reads history after the current inventory and keeps
each history source's observed pages when a later request fails (`--since`/`--checkpoint`
and the catch-up change window alike). The snapshot gains `history` (`since`, `state`
complete/partial/failed, the safe `failure` categories and per-source pages) and the read
coverage a `history` entry; change-window coverage gains a `failure` category. A definitive
quota refusal stops the next history source (`not-attempted`). A failed or partial window adds
a warning, so the read is incomplete (exit 2) and the checkpoint does not advance; the text
heading says the window's changes are unknown, not none. An incomplete history read never
overwrites an explicit `--cache` snapshot (`historyComplete`), and says so. Cancellation still
rejects. Failure categories come from the gh boundary's classification, never raw messages.

## Last-successful snapshots: #371

Reuse the caller's existing explicit `--cache`/offline snapshot or the server's
existing in-memory last-good entry. No new automatic disk store, database, page
cache, background collector or cross-repository fallback is introduced. Without an
explicit compatible disk snapshot or held server entry there is no fallback.

Validate schema, host/repository, authorization context, profile/coverage, requested
focus and data integrity before reuse. A different agent's rendered queue is never
a raw snapshot for another viewer; reproject compatible raw facts with the current
requested role/name/platform/settings and current engine. An old artifact/schema
without required coverage information is unknown or incompatible, not implicitly
complete. Never rotate credentials to evade a limit.

Return an explicit freshness object containing source `stale`/`offline`, original
observation time, current render time, age, compatible coverage, safe live-failure
code/reset information when actually observed, and fallback reason. Do not relabel
stale facts live because rendering succeeded. If current live facts are usable,
keep them source-specific instead of overwriting them wholesale with an older
snapshot. Any combined result identifies each source's actual observation time.

The server's existing 30-minute stale-on-refresh-failure window remains bounded by
serve.md; past it, report a typed failure or other still-usable sources. CLI automatic
quota fallback uses the same initial maximum age when enabled for an explicit
snapshot, and states the effective age limit. An explicitly requested offline read
may inspect an older snapshot with its age and limitations visible; it is not a
successful current refresh. Expired/corrupt/foreign snapshots are distinct diagnoses
from absent cache and from an empty valid inventory. Never silently ignore corruption
and say no work was found.

Stale/offline facts support explanation and inspection only. They never authorize
claim, merge, completion, transfer or other mutation. Mutation commands independently
read fresh evidence and preserve their existing refusals. Generated suggestions
remain conditional on those live gates; where a necessary fact is stale, prefer an
inspection/refresh next step instead of a conclusive actionable permission claim.
No action is automatically performed by this read path.

## Cache and checkpoint safety

An incomplete, failed, stale or offline collection cannot overwrite the whole
last-successful explicit snapshot or advance its successful-window checkpoint.
Validate a complete replacement, write it atomically with the existing boundary,
then advance its checkpoint only when that entire requested window is complete.
On partial write/crash, preserve the previous successful pair or report a recoverable
inconsistency; do not silently skip a history interval. Retrying the same window
may repeat observed events and uses stable source identities for deduplication.

Source-level memory reuse is separate: a genuinely complete current-source result
may be cached under that precise source/profile even when an independent history
source failed. It must not be stored under a key promising a complete combined
snapshot. No cached partial source may masquerade as a complete higher-coverage hit.
Service invalidation and in-flight generation handling follow #453's contract.

## Output, errors and exits

CLI exit 0 means all required evidence for the requested view is complete/live or
the explicitly requested offline view was successfully read under its existing
offline contract. Exit 2 means usable but incomplete/degraded read, including
automatic stale fallback. Exit 1 means invalid arguments or no usable document.
Keep existing command-specific compatibility where an older public command has
documented exits; update help/tests explicitly rather than silently changing them.

HTTP returns the existing `serve-read` envelope with `status: incomplete` for a usable
degraded document and its source freshness/warnings. No usable document uses the
existing typed error response. MCP reuses the versioned bounded-result envelope;
incomplete useful data is not falsely returned as an empty success or a transport
crash. Include source/fallback/completeness notices before low-value detail under
the budget; prune whole rows and report omissions, never cut JSON bytes. Text
truncation states "Truncated due to maximum size" per #379. Do not introduce a
new blanket minimum-size rejection or hide the only evidence-gap notice.

Sanitize failures at the GitHub boundary: safe category, operation/profile/source,
actual observed quota/reset/retry data and useful follow-up. Exclude tokens, headers,
raw exception payloads and private paths. Unknown reset time remains unknown;
aggregate quota from another request cannot manufacture a reset for this failure.
#293 supplies per-operation diagnostics. Repeated speculative retries are not a
fallback strategy.

## Acceptance

Inject readers, clocks and filesystem boundaries. Cover all matrix rows, a valid
empty result, partial pagination, permission failures and a rate limit after one
successful source. Verify the current report survives history failure and no
changes are claimed from an unseen interval. Exercise absent/corrupt/foreign/old
schema/expired/compatible snapshots, role/project/auth separation and policy changes
with reprojected raw facts. Assert original source times and live/stale distinctions.

Fault-inject snapshot/checkpoint writes, cancellation and retries; incomplete reads
must preserve previous successful bytes/checkpoint. Distinguish source-level cache
success from combined-snapshot failure. Verify CLI/API/MCP semantics, exit codes,
bounded omission notices and no mutations, credential rotation or background fetch.
No new paid trial or live GitHub write is needed to verify these contracts.
