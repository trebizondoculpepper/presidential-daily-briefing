# Diagnostics page validation (#585)

The page implements the accepted [diagnostics contract](../design/serve-diagnostics-page.md)
and the shared shell. Opening it reads retained metadata only. Doctor and Ticket Doctor
start only on explicit Run; the page watches only its own waiter and stops on terminal
status. Cancellation detaches that waiter; navigation discards late responses.

## Boundaries and coverage

The page renders the native LocalDoctorReport and TicketDoctorReport. Service and HTTP
regressions cover complete, incomplete, empty, cancelled, failed and quota-limited runs;
context separation, independent waiters, retention, bounded resources and cancellation
are tested at the registry/API boundary. CLI comparison tests retain the native report.
The page suite exercises the generated browser script with controlled DOM/fetch/timers:
passive opening, explicit Run, terminal polling, cancellation retry, expired handles,
late-response cleanup, keyboard tabs, options and navigation. HTTP checks serve the actual
HTML and external script under the shared Host/Origin/CSP guards.

All report text is escaped. Ticket links use the selected registered repository; external
links are restricted to that GitHub host/repository's issue or PR routes. Suggested commands
remain copyable text, with their original plan preconditions and responsible actor.
No repair, login, configuration change, hook installation or GitHub mutation is offered.

## Browser observation

Chrome 157.0.8103.79 exercised the actual page, registry and HTTP API against synthetic
Doctor probes and a controlled read-only collector. This verifies the interaction rather
than asserting that this Mac or a real repository is healthy. Initial opening and tab
selection made zero diagnostic calls. Explicit Doctor ran its two injected gh probes;
remote-only project scope made no local-checkout read. Two explicit Ticket Doctor runs
produced one completed report and one genuinely aborted collection, with zero GitHub
errors recorded by the server.

Enter started Run and Cancel. ArrowRight selected the adjacent tab. Tab visited limit,
stale-hours and Run in order. Enter opened native finding details. Project navigation
retained the selected tab. Controls measured 40 px high. At 1280×900 and 320×800, document
scroll width equalled viewport width, including a cancelled report. Captures:

- [Doctor progress](assets/585-diagnostics/doctor-running.png)
- [Doctor result](assets/585-diagnostics/doctor-wide.png)
- [Ticket findings at 320 px](assets/585-diagnostics/tickets-narrow.png)
- [Cancelled at 320 px](assets/585-diagnostics/cancelled-narrow.png)

VoiceOver testing is deferred to #719 at the owner's direction. Keyboard and semantic
markup checks here do not claim a screen-reader result.

## Cost and packaging

No paid service or new dependency was used. Browser data is synthetic; no credential,
private snapshot or local browser profile is committed. Package validation installs the
built CLI outside the source tree, serves the page/script, verifies opening starts no run,
and explicitly executes both diagnostic kinds through their installed HTTP API. The
fixture uses fake gh and does not change the user's login or repository settings.

Final local validation: `npm run check` (zero errors, 54 existing warnings),
`npm test -- --maxWorkers 2` (149 files, 2,732 passing tests, one skip),
`npm run build` and `npm run package-test` all pass.
