# Morning handoff: 19 November 2026

Prepared after the owner's evening design discussion. This is a dated handoff,
not a claim that the upcoming scheduled release has already run.

## Decisions and contracts finished

- #1054 merged: stable harness identity (#1047), shared Markdown rule output
  (#1049), and complete removal of the independent TypeScript ranker/options
  (#1050). No alias or fallback was approved. Runtime work remains separate.
- #1023 merged: standard shared logging with configurable seven-day retention,
  audited force overrides, explicit human responsibility release and policy-first
  implementation. Logging dependency choice is delegated after minimal research.
- #1035 merged: minimal npm postinstall hint, generated rules.md and AGENTS.md
  reference, and separate native policy/display slices for action reminders.
- #1027 now depends on #1049 so onboarding does not invent another Markdown renderer.
- The GitHub conflict-editor investigation found no explicit project prohibition;
  the separate Update branch setting must not be confused with Resolve conflicts.

## Release request

The owner requested a one-off official release at 05:00 Europe/London on this date
(05:00 UTC). GitHub Actions can start late and normal publication checks take time.
The dated controller selects main's first-parent timestamp cutoff, requires CI and
verify, calls the existing explicit release helper and disables its own schedule.
It does not publish arbitrary unmerged work or bypass a failed check.

After the scheduled time, inspect the **One-off owner release 2026-11-19** workflow
and the resulting **Publish** run. Record the actual selected SHA, version, npm
latest value and GitHub release. A scheduled/queued/dispatched request is not a
published release. If it fails, retain the exact source and failure evidence; do
not blindly republish or select newer main as a retry. Remove the spent disabled
controller in a small follow-up after the outcome is understood.

## What can proceed without another owner decision

- Stable identity, shared Markdown rendering and legacy-ranker retirement are
  ready after their reviewed contracts; implementation tests/CI are still required.
- Logging #1017 and ownership policy #1018 can start independently. Their native
  dependencies gate force and ownership engineering slices.
- npm hint #1026 and claim reminder policy #1029 have reviewed contracts. Remaining
  action reminders follow the native policy-before-engineering chain.
- Migration ticket closure alone does not prove the final facade audit complete;
  inspect #953/#1052 and their exact verification evidence before declaring that gate done.

## Input useful tomorrow

No unresolved product decision is required for the contracts above. The useful
review is operational: confirm the actual release result and try the merged
identity toolbar, metrics and live configuration behavior. Only raise a new design
question if implementation uncovers a concrete conflict (for example ambiguous
legacy identity records), rather than reopening the accepted one-identity default.
