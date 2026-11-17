# Diagnostics page (#585)

Added the final shared-shell Doctor/Ticket Doctor page on top of the separately reviewed
service hooks and bounded registry/API. The client performs passive latest lookup on open,
requires an explicit Run to subscribe, follows only its own active waiter and cancels it
on navigation. Failed cancellation remains retryable; late responses cannot change the
new context. Native reports retain uncertainty, coverage warnings, exact suggested
commands, actor/preconditions, timestamps and finding drilldowns.

Added script-level interaction and HTTP regressions, and installed-artifact coverage for
the page, external client and both explicit diagnostic operations. Actual isolated Chrome
keyboard and 320/1280 px layout observations are recorded in the validation report with
synthetic screenshots. VoiceOver remains deferred to #719 as requested by the owner.

Validation: check passes with zero errors and the existing 54 warnings; all 149 test
files pass (2,732 tests, one skip). Build and complete installed-package validation
pass, including both explicit diagnostic runs, the page/script and HTTP MCP. No
new dependency, paid request, private fixture or changed deadline is required.
