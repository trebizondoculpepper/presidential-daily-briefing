# Diagnostics service boundaries (#585, first slice)

Started the reviewed #616 Diagnostics contract with optional cancellation and
observed group progress in Doctor. Server callers can explicitly omit project
checks when no registered verified root exists; the CLI's default checks and
report shape remain unchanged. Host-only runs do not infer a checkout from cwd.

Real-child validation exposed that execFile can call its abort callback before
the child exits. The probe now waits for close, terminating its owned process;
cancellation is propagated instead of being reported as a missing dependency or
healthy result. Tests verify the child has exited and no project filesystem or
git read occurs in host-only mode.

Extracted the existing CLI Ticket Doctor composition into transport-neutral
readservices, preserving delivery/trust, closed-window scans, retained-claim
activity, completeness, JSON and text. Both CLI and the upcoming dashboard use
this same path. Added observed delivery counts and phase callbacks with signal
checks. No new checks, findings or repair behavior are introduced.

Focused CLI/service parity, cancellation and import-cycle checks pass. The run
registry, active API and two-tab page remain outstanding; this slice does not
complete #585. Full validation is required before committing.

Validation passed: check (zero errors, 54 existing warnings), all 145 test files
with 2,659 passing tests and one skip, and build. An independent source comparison
against the pre-change CLI at 8de256d matched all six JSON/text cases: empty scan,
findings, and truncated/untrusted evidence. No raw process output or private paths
were included in those synthetic results.
