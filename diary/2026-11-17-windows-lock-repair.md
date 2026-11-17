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

The initial repair experiment retained the temporary 100-batch Windows diagnostic count
and now count create refusals followed by successful updates. Those counters can distinguish
actual recovery from a passing run with no refusal. Restore ten batches before final merge.
Counts, cleanup checks and per-case limits remain unchanged. No live/private file was touched.
No root TODO.md exists. At the initial repair push, Windows recovery evidence and final
normal-count head validation were still outstanding.

Before pushing the repair experiment, check/build passed and the complete local suite passed
135 files / 2,522 tests (one skipped), using one worker and existing per-test limits. The lock
unit suite also passed after the final warning cleanup. At that push, Windows recovery counters were still to be
observed; local injected success alone was not the required live Windows evidence.

Repair head 79c5ff6 passed required CI, including all 100 batches per Windows fixture
(5,000 updates), and a completed clean Codex review. The Windows log contains one
"Recovered JSON lock-create EPERM" report: an actual exclusive-create refusal was
followed by successful writes. No storage create refusal occurred in that passing
run; its exact thirty-record assertions still passed in every batch. The specific
Windows component issuing the refusal remains unidentified.
Evidence: https://github.com/trebizondoculpepper/presidential-daily-briefing/actions/runs/43985870064/job/133713796392

Restored the normal ten batches per Windows fixture before the final repair head.
Check/build and all 135 local files passed again (2,522 tests, one skipped), with
one worker and unchanged time limits. The final normal-count head requires fresh
review and verify before merge; see PR #744 for that exact-head evidence.
