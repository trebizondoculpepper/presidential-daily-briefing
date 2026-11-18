# Retire the independent TypeScript ranker

Explicit owner compatibility decision for #1050, 18 November 2026. The native
policy is the only ranking implementation. This supersedes earlier rollback and
compatibility-projection suggestions in [workflow policy](workflow-policy-boundary.md)
and any older contract that treats TypeScript ranking as a supported second mode.
The runtime change remains a separate implementation ticket.

## Remove the second scheduler and its controls

Delete independent TypeScript candidate classification, eligibility/ranking and
comparator paths in `briefing/blended.ts` and their actual call sites after an exact
consumer audit. Preserve neutral TypeScript fact collection, parsing, rendering,
clock/filesystem/transport mechanics and data types needed by native execution.
This is not a rewrite of the application out of TypeScript.

Remove `briefing.engine` from supported setting registries, choices, setter/getter
surfaces, public engine selectors, help, rollback commands, examples and recovery
suggestions. Remove hidden environment/test-only switches that activate a second
scheduler. No deprecated alias, projection-mode selector, silent fallback or retained
old ranking oracle. Internal schema provenance may still truthfully identify the
native engine; a JSON field reporting what ran is not a user-selectable engine knob.

Reuse shared native evaluation in CLI, MCP, serve, shortlist and rebrief. Current
role affinity and owned-work-first policy (#652) remain native decisions. Do not
preserve old role-exclusive ordering to keep a legacy parity fixture passing.
If native artifact load, initialization or evaluation fails, report the existing
typed infrastructure failure/unknown result and useful diagnostics. Never turn it
into an empty/approved queue or run another policy.

## Existing configuration and schema compatibility

This is an explicit compatibility change. A saved retired `briefing.engine` key,
including an old value of datalog, is no longer a selection option. Identify the
obsolete key/file and explain how to remove it without losing unrelated settings;
do not silently accept it as an alias or mutate configuration during a read.
Use existing safe configuration machinery for any explicit migration write. If a
small generic key-removal operation is needed, document/test it as recovery, not as
an engine selector or global reset. Do not tell callers to set the removed option
to another value. The actual native policy/project override settings remain valid.

Preserve existing result schemas where their fields remain truthful. If discriminated
engine-specific result types or documented external consumers cannot be kept without
pretending another engine runs, enumerate the precise compatibility change in help,
release notes and fixtures. Never silently reinterpret a stored checkpoint's policy
identity. Existing full/intake, evidence and unknown/freshness guarantees remain.

## Tests and delivery boundary

Remove tests that treat the retired ranker/order as the compatibility oracle.
Replace necessary guarantees with native decision/scenario assertions and actual
cross-surface behavior checks; do not delete useful fault/evidence tests merely
because they once exercised both engines. Parity should compare projections of the
same native result, not two independent schedulers.

Verify the retired option/switch/help paths are absent, stale config has useful
recovery, native failures do not fall back, and current role/ownership behavior is
preserved across entry points. Run normal executable checks/tests/build and the
relevant installed CLI smoke. Keep the runtime diff focused on scheduler retirement.
This is engineering cleanup of existing authoritative policy, not authorization to
change native decisions. Any newly required decision change is its own policy slice.
