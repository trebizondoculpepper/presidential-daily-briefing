# Windows exclusive-create repair (#729)

The 100-batch reproduction at bea0ef9 failed safe-JSON batch 36 and cache-storage batches 26,
42 and 46 with create-phase EPERM. The shared helper treated that filesystem refusal as
terminal. The observed application failure mode is established; the particular Windows
component causing the refusal is not. PR #746 merged the focused contract as c232f59 before
this production change.

Retry only Windows EPERM from exclusive lock creation, within the original caller budget.
Every attempt retains wx creation; no unowned/replaced/unverified lock is removed. Creation
must succeed and its token must match before work proceeds. Bound sleeping by the remaining
budget, and start no retry at or after the deadline. Permanent denial remains failed/create/EPERM;
other codes and verification failures retain immediate refusal. The legacy wrapper stays usable.

Four injected regressions failed against the old implementation, then passed with the repair.
Coverage includes successful recovery and ownership, permanent denial, zero/short budgets,
alternating contention/refusal without deadline reset, other platforms/error codes, verification
failure and the legacy wrapper. The focused lock/JSON/storage suite passed all 88 tests.

The Windows fixtures retain the temporary 100-batch diagnostic count for the repair experiment
and now count create refusals followed by successful updates. Those counters can distinguish
actual recovery from a passing run with no refusal. Restore ten batches before final merge.
Counts, cleanup checks and per-case limits remain unchanged. No live/private file was touched.
No root TODO.md exists. Windows recovery evidence and final normal-count head validation remain
outstanding at this commit.

Before pushing the repair experiment, check/build passed and the complete local suite passed
135 files / 2,522 tests (one skipped), using one worker and existing per-test limits. The lock
unit suite also passed after the final warning cleanup. Windows recovery counters remain to be
observed; local injected success alone is not the required live Windows evidence.
