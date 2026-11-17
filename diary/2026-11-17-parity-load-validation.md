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
