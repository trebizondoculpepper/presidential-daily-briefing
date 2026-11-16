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
