# Required versus advisory check design (#343)

The expanded readiness audit found #343 estimated but without a readiness label.
Prepared a documentation-only contract before runtime changes. Existing collection
has check outcomes but no requiredness/expected-set evidence; treating every pending
job as waiting can hide actionable PR follow-up.

Read current collector, shared evidence coverage, PR status and native adapter, plus
merged collection/review/delivery contracts. Read-only GitHub schema introspection
confirmed the per-PR isRequired fields. Official documentation and one effective
branch-rules request informed the bounded expected-set collection design. No rule,
check setting, credentials, hook or client configuration changed. Temporary raw
research stays outside the repository.

The contract preserves missing expected checks, unknown access/coverage, app identity,
observed failures, current-head reviews and live mutation safeguards. It separates
pending advisory jobs from required waits and requests parity tests and measured
bounded metadata hydration. #343 remains needs-design until this contract passes
review; the attempted ordinary claim correctly refused because design is not ready.
