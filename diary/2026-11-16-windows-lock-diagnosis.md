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
files remain. This
bounded diagnostic coverage retains all original assertions and budgets.

Platform hypothesis only: Microsoft documents that opening a path pending deletion
can fail with ERROR_ACCESS_DENIED, and libuv maps that native code to EPERM. This
makes a create-phase EPERM plausible, but does not establish the cause of the
original CI failure. The diagnostic Windows run must supply that evidence.
Sources: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[libuv Windows errors](https://github.com/libuv/libuv/blob/v1.x/src/win/error.c).
