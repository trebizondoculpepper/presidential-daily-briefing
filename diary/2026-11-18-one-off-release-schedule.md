# Owner-requested 05:00 release

Implemented the reviewed dated controller for 19 November 2026 at 05:00 UTC
(London time that day). GitHub may start the cron late. It selects main's fixed
first-parent timestamp cutoff, waits for that source's CI and required verify,
then calls the existing explicit release helper; publication checks remain in
Publish. It does not publish on main pushes or before the requested date and
self-disables after its one-off attempt. Setup is not a publication receipt.

Validation before commit: full check passed (existing warnings), 3,056 tests
passed with one skip, build passed, and the canonical release helper's help ran
without dispatch. Mocked actual workflow shell blocks covered six date/time
cases, fixed first-parent cutoff, invalid SHA and four CI gate outcomes. No
release request was sent during validation.

Review correction: wait only for the selected source's required verify check,
not the whole CI run, so the optional FreeBSD trial cannot become a publication
gate or consume the controller timeout. Focused probes include pending-then-pass,
failed required verification, API failure and bounded missing-evidence timeout.
