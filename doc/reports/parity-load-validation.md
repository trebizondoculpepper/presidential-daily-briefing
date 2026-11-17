# CLI/MCP parity under load (#724)

## Reproduced content mismatch

The reported `rankedActions: differs from the CLI` includes engine metadata, not
only the ranked decision rows. The Datalog adapter deliberately reports an elapsed
wall-time diagnostic above its soft 2,000 ms budget. Its timer is separate from the
injected date used for GitHub facts and freshness. A loaded evaluation can cross
that threshold while the next evaluation over identical facts does not.

The controlled acceptance regression in `src/acceptance/mcpparity.test.ts` advances
only the CLI engine timer from 0 to 2,001 ms. The MCP timer stays fixed. This
reproduces the exact parity failure without sleeping: both transports retain the
same decision rows (allowing the documented bounded MCP prefix), but only the CLI
has `evaluation exceeded soft 2000ms budget (2001ms)`. Fixing both timers restores
complete parity, including diagnostics. No diagnostic or decision is ignored by
the comparison.

The injection boundary was introduced in `1da224022ff0cbba5afe5320ebcfdfcddb971b7d`
for #463. The missing fixed timers in the affected MCP parity and HTTP API fixtures
were supplied by #726, merge `fd0818988d3fd8986d4d831a0bef5540d662776f`, while
validating #676. This regression makes that repair explicit for #724. Production
keeps its real elapsed-time diagnostic; an actual slow evaluation is not concealed.

## Separate timeout evidence

The later #724 comments record unchanged 20-second test deadlines expiring under
parallel load. Those are separate from the content assertion above. An isolated
pass or a successful rerun is not the required 50 consecutive full-suite passes.
Neither test timeouts nor required acceptance have been relaxed.

## Validation status

The controlled reproduction passes, as do all 74 tests in the MCP parity and HTTP
API suites. The repeated full-suite load acceptance is pending; this report does
not claim #724 or #534 complete.

A default parallel full-suite baseline on the fixed fixtures passed 2,650 tests
with zero failures (one skipped) on 2026-11-17. This is a baseline, not 50 runs.

The first repeated-load batch is being stopped before completion after PR #780's
Ubuntu CI run 44013762184 reproduced the separate 20,000 ms section-pruning timeout
at head 3137416. Its 120-subject fixture is larger than the byte-pruning property
requires. A smaller fixture must still demonstrate real row pruning, exact
shown/omitted accounting, nonempty returned rows and the whole-result byte bound.
The repeated acceptance will restart after that repair; earlier passes are retained
as diagnostic evidence and do not count toward the new 50-run sequence.

The stopped batch retained 18 successful full suites on 3137416, with four
concurrent runs capped at two workers each. A nineteenth record is the input-change
guard stopping further launches, not a failed test. These passes are diagnostic
only and are not combined with a new source head to claim acceptance.

The section-pruning regression now uses 64 subjects and the normal 10,000-character
text budget. It still forces genuine row pruning; 32 subjects did not, so that
candidate was rejected. It additionally asserts complete source status, a nonempty
returned section, exact structured and text row counts, presentation omission
accounting, and the 16,384-byte whole-result bound. Its targeted run passed in about
2.5 seconds locally. The 20-second test deadline remains unchanged.
