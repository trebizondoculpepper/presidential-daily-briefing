# Target required checks (#676)

After #679 merged and #605 entered automated review, refreshed full ticket intake
and native dependencies and claimed #676. The existing #343 contract still states
a universal verify floor, contradicting the now-merged #679 contract. This focused
documentation phase removes that obsolete statement and specifies shared native
check reasons, complete evidence even for green/no-check PRs, and the boundary
with #707. Implementation follows the separately reviewed contract.

No root TODO.md exists. No live private repository snapshots or credentials are
included.

Implementation replaces the universal check-name gate with a typed native query
over the same shipped clauses used by briefing. Normalized facts retain expected
app constraints, run identity, explicit coverage and source head/base bindings.
Green/no-check selected PRs now receive requirement reads. Direct PR and ticket
reads share the injected collector; delivery follow-up consumes the native result.
Ticket text/HTML show the required-set state, retaining legacy fields only for
compatibility. Native reason IDs and rules revision are exposed in PR JSON.

The native query introduces shared generated runtime chunks; the package allowlist
includes the exact helper families and package smoke follows actual imports to
prove every referenced helper ships. No new runtime dependency was added.

Added native scenarios, pure query and identity/coverage cases and direct-read /
briefing parity. Existing positive fixtures now explicitly declare their synthetic
requirements. Golden inputs remain unchanged: old snapshots lacking coverage stay
unknown; outputs and witnesses intentionally change with the target-check policy.
Golden regeneration passed with a one-off 180-second test budget (latest regeneration: 44 seconds),
without raising ordinary test timeouts. Bounded injected direct-read evidence is
four requests: selected PR plus one effective-rules REST read, one legacy protection
read and one head-bound requiredness read. Two PRs sharing a base coalesce both
policy reads. No live private repository probe or snapshot was used.

The #676 check-related part of the delivery audit is migrated here to avoid a
shadow verify gate; #708 still owns the remaining delivery follow-up policy and
#707 owns the other imperative PR diagnostic blockers.

A full parallel run exposed timing-only transport parity failures: one cold
engine evaluation exceeded its soft 2-second budget and the other did not. The
parity fixtures now inject the existing fixed engine clock, as intended by that
boundary, rather than comparing real CPU scheduling. No production timeout or
performance diagnostic was relaxed. Focused CLI/MCP/serve parity passed.

The larger response-budget fixtures exposed expensive repeated expansion of the
new required-check relation under load. The engine now materializes the native
`check-ready` relation once and transacts its returned tuples for dependent rules,
just as it already materializes other native relations. Hosts cannot provide that
private result attribute. The focused response-budget, parity and engine suites
passed without increasing their timeout. The optional engine clock is threaded
through CLI and serve adapters for deterministic parity testing.

Final pre-commit validation: checks passed (zero errors), all 130 test files passed (2,457 tests, one skipped), and build passed. Installed-package smoke is rerun against the final materialized-query build before merge.

Codex review of #726 found that the standalone adapter fallback omitted normalized
missing requirements, allowing a clean-looking PR with a never-reported required
check to receive merge consideration. Added a regression reproducing the failure
without a host classification map, then made every required-check field project
from the same normalized evidence. The direct report already blocked that case.

The review correction passed all 130 files (2,458 tests, one skipped), checks and build. The original head passed Ubuntu/FreeBSD but Windows hit the existing separate-process JSON writer fixture: one child exhausted its explicit lock wait. The final head receives fresh CI; that failure is not a check-policy result.
