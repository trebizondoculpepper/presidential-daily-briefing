# Parity determinism and repeated load validation (#724)

Claimed the unblocked bug after completing #677. Traced the content difference to
the Datalog soft-duration diagnostic: the fixture's injected date did not control
the separate monotonic engine timer. The missing fixed fixture timers were already
merged in #726. Added an actual CLI/MCP regression using a synthetic 2,001 ms
engine duration, proving the reported mismatch with unchanged ranked decisions and
restored full parity with fixed timers. No sleep, timeout increase, filtering of
engine diagnostics or production timing change is involved.

The targeted parity and HTTP API suites passed all 74 tests. Full parallel-suite
and repeated-load validation remain in progress; the ticket stays open until its
acceptance is satisfied.

The default parallel full-suite baseline passed 2,650 tests with zero failures and
one skipped. Check and build passed. Repeated full-suite load acceptance remains
pending; no merge or completion claim is based on this single run.

PR #780's Ubuntu CI reproduced the existing 20-second section-pruning timeout at 3137416. Stopped further load launches and let active suites finish: 18 full suites
passed. The guard's final stop record is not a test failure or completion evidence.
Reduced the pruning fixture from 120 to 64 subjects and used the default text
budget, retaining real pruning and strengthening byte/count/content assertions.
A 32-subject candidate was rejected because it did not force row pruning. Full
validation and the 50-run sequence restart on the repaired fixed source.

The repaired fixture passed the full 144-file suite: 2,650 tests passed, one skipped.
Check passed with zero errors and 54 existing warnings; build passed. The new
assertions verify actual text counts and presentation omissions as well as the
whole-result byte bound. Restart acceptance on this repaired committed source.
