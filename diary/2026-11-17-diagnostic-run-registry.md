# Explicit diagnostic-run registry and API (#585, second slice)

Implemented the reviewed #616/#784 contract over the #785 shared services. Runs
share only an exact verified host/login/project/kind/options context. Each POST
gets its own random waiter; cancelling one cannot stop another. Last-waiter
cancellation aborts the actual collection/probe, and late results cannot replace
cancelled, timed-out or closed states.

Applied the reviewed concurrency, waiter, retention, byte and deadline bounds.
Expiry/eviction removes result and handle references; shutdown clears owned work
and timers. Unknown errors use safe registered text. Local Doctor diagnostics
redact paths without rewriting GitHub-authored ticket evidence. Passive latest
lookup uses held auth metadata, not a new auth probe; a null-login Doctor run
cannot borrow another login's result. Ticket Doctor requires operational auth.

The active API validates registered selection, exact JSON fields and CLI option
ranges before probing. It preserves passive diagnostics and global HTTP guards.
Ticket Doctor uses the same read pipeline as CLI, through the shared cache and
its collection/cooldown limits. Stale cache fallback is rejected rather than shown
as a fresh successful run.

Focused registry/HTTP tests cover cancellation, late completion, context isolation,
limits, expiry, deadline, redaction, unknown delivery/native evidence, complete/
incomplete/empty CLI parity and no mutation. The real-collector synthetic fixture
uses two GraphQL inventory reads (issues and PRs), zero REST reads, matching the
CLI; latest and passive views add zero requests. This is fixture evidence, not a
constant request budget for arbitrary repositories. The two-tab page remains
outstanding, so #585 is not complete. Full validation is required before commit.

The initial full validation passed all 148 files, 2,708 tests and one skip, plus
check, build, smoke and installed-package checks. Added a further queued-auth
regression before commit: four unrelated cache reads occupy the budget, a
Diagnostic waits, and another explicit run observes an account switch. The queued
run now refuses before collection, rather than reading under a different login
and merely discarding the result afterwards. It uses the cache's structured
CACHE_INVALIDATED failure so it cannot be mislabeled as a GitHub outage. Focused
coverage passes with this additional case; final full validation follows.

Final validation passed: check (zero errors, 54 existing warnings), all 148 test
files with 2,709 passing tests and one skip, build, smoke and installed-package
validation. The queued-auth case confirms no fifth collection starts under the
switched login. Existing passive diagnostic API and import-cycle tests pass.
