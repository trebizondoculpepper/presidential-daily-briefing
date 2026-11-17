# Immediate Windows lock failure (#729)

While delivering #676, the initial Windows run reported one failed child in the
four-process safe JSON writer regression. The emitted text said held/stuck, but
Vitest measured only 546ms despite a configured 30-second lock wait. The helper
also maps unexpected creation/readback filesystem errors to that generic message.
The actual syscall/error code was not preserved, so a timeout diagnosis is not
supported. Corrected the follow-up issue and the #676 diary note.

Claimed #729 through pdb after full intake. Reuse the merged safe shared-write
contract: preserve factual failure/cleanup diagnostics, bounded waits, ownership
tokens and no automatic lock stealing. Establish the failure phase/code before
changing contention behavior; do not increase a timeout based only on the generic
message. No operator lock, identity file or live cache is touched.

No root TODO.md exists. This documentation correction does not complete #729.

The first runtime patch adds a typed acquisition result (acquired, busy, replaced
or failed with create/verify phase and error code). The old held-lock/null API
remains compatible. Safe JSON writes consume the detailed result and no longer
suggest deleting a stuck lock for an immediate filesystem refusal. Injected tests
preserve the target, unverified/replaced locks, deadlines and diagnostic privacy.
No retry or deadline change is made before observing the Windows failure cause.
The Windows concurrent-writer fixture now runs ten independent batches, each with
four processes and exactly twenty updates, and asserts that no temporary or lock
files remain. This bounded diagnostic coverage retains all original assertions and budgets.

Platform hypothesis only: Microsoft documents that opening a path pending deletion
can fail with ERROR_ACCESS_DENIED, and libuv maps that native code to EPERM. This
makes a create-phase EPERM plausible, but does not establish the cause of the
original CI failure. The diagnostic Windows run must supply that evidence.
Sources: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[libuv Windows errors](https://github.com/libuv/libuv/blob/v1.x/src/win/error.c).

After #722 merged, resumed #729. Its first Windows CI attempt also exposed one
failed write in the separate cache-storage experiment. That worker only reported
aggregate counts, and `toMatchObject({ notWritten: {} })` did not verify an empty
failure map or print its keys. The experiment now consumes typed acquisition facts,
and workers retain failure status, step and detail (including post-commit failures)
for assertion diagnostics. Exact empty-map and fifteen-write assertions remain,
with ten independent two-writer batches on Windows and unchanged per-case budgets.
Injected create/verify errors preserve the prior target and unverified lock.
The #722 run passed on its bounded unchanged-head rerun; that does not identify the
original failure's phase or cause. No production contention retry was added.

Validation of the expanded diagnostic slice: check and build passed; the complete
suite passed 134 files / 2,491 tests (one skipped), using one worker with existing
per-test limits. This is diagnostic evidence, not a claim that the original Windows
cause or its reliability acceptance has been established.

The diagnostic slice merged in #738 as 401a2c3 after a clean exact-head Codex review
and required CI. Windows passed all twenty batches (500 total updates), without
observing the intermittent cause. #729 remains open with delivery membership open.

A separate draft reproduction branch temporarily raises only the Windows batch
counts from ten to one hundred for one bounded CI pass (5,000 total updates).
Measured batches took roughly 0.5–0.7 seconds, so the estimated added Windows test
cost is about two minutes. Existing counts, cleanup checks and per-case deadlines
are unchanged. Restore the normal ten-batch level before any final repair merge;
this temporary repetition increase is investigation, not the proposed production fix.
No paid model calls, new infrastructure or private filesystem data are involved.

Before publishing the bounded reproduction branch, check/build and all 134 test
files passed locally (2,504 tests, one skipped), with one worker and unchanged limits.
The larger repetition count applies only to Windows; this local run is validation
of the branch, not Windows reproduction evidence.
