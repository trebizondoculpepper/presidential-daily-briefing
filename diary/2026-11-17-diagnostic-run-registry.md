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

PR #786 review found that auxiliary quota refusals could be converted to unknown
permission/delivery evidence before the cache observed them. Reproduced the issue
through real HTTP requests for answered REST, secondary-limit, thrown REST and
GraphQL refusals. Wrapped those boundaries with the existing ReadMeter and notify
the shared cache on the first refusal, before downstream catches. The meter also
stops later scheduling. Preserve the native report but mark the run partial with
a safe quota notice; a quota-stopped refresh cannot fall back to stale success.
An ordinary permission denial is not quota evidence and does not start cooldown.

Review-fix validation passed: check with zero errors/54 existing warnings, all
148 files with 2,714 passing tests and one skip, build and installed-package
validation. Four auxiliary refusal regressions now protect the shared cooldown;
the ordinary-permission-denial control confirms no false cooldown.

Windows CI passed check/tests/build but failed the first packaged native init
assertion without reporting its returned reason. The fixture inherited default
identity/human resolution despite being a credential-free native-adapter smoke.
A controlled local gh shim delayed only the incidental account read: the unchanged
10-second native deadline produced cancelled-or-deadline; explicit context opt-outs
produced initialized and zero gh invocations. No real login/cache was changed.
Made that smoke's context isolation explicit, separated its fake-GitHub read case
from environment-object identity, and included the initialization reason in any
future failure. No application deadline, assertion, retry or required CI is relaxed.

The isolated native-smoke repair passed check, all 148 files/2,714 tests (one
skip), build and the full installed-package validation. The fake-gh successful
native offer/duplicate checks still run explicitly. The unchanged-deadline local
reproduction is retained in /tmp/pdb786-native-init-repro-results.json.
