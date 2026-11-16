# Effective identity and first use (#677)

After getting #722 merged and #664 completed, used PDB to intake and claim #677 while #729's
expanded diagnostics awaited CI. Reassessed complexity as L: shared attribution, session binding,
concurrent persistence and partial outcomes span multiple transports and command families.

The current merged identity contracts intentionally prohibit automatic briefing initialization
and session-based selection. Recorded the focused replacement contract before runtime changes,
including safe legacy selection, verified bindings, unchanged read-only guarantees, one-time
visible setup and actual transport-result acceptance. Optional Doctor/install work stays #681.
No private identity was edited and no automatic runtime setup is implemented by this docs phase.

The source/fixture inventory verifies harness detection, but a thread marker alone cannot prove
unique logical-agent identity inside a multiplexed host. The contract keeps that ambiguity
explicit instead of promoting the marker to authority. Validation: check/build passed, and the
complete baseline suite passed 133 files / 2,496 tests (one skipped), with one worker and unchanged
time limits. No root TODO.md exists.
