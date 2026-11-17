# Diagnostic run resource contract (#585)

Before implementing the registry, made its bounded-memory and lifecycle behavior
concrete: reuse existing serve result/entry/byte limits, cap waiter handles, expire
or evict terminal data, abort on shutdown/deadline and discard late completions.
Clarified passive latest-auth lookup versus explicit-run auth verification, and
Doctor's ability to diagnose broken auth without sharing a prior login's run.
Host-only skipped groups do not change the CLI LocalDoctorReport schema.

This is a contract clarification only. No runtime implementation, new diagnostics,
write action or #585 completion is claimed here. Check/test/build are required
before commit and automated review/CI before merge.

Validation passed: check with zero errors and 54 existing warnings, all 145 test
files with 2,671 passing tests and one skip, and build. No runtime changes.
