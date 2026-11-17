# Rule-attached narration (#578)

Implemented the reviewed #759/#760 contract and the separately reviewed #782
compatibility clarification. Purposes travel from native source through the
artifact, English model and shared document into purpose-first web cards. Formal
conditions reuse the CLI renderer and native details/summary controls. Missing
purposes remain visible, including future and project rules.

Kept the legacy bundle hash and exact formal CLI text stable. Added an independent
narration revision; mismatched artifacts fail rather than borrow old prose.
Explicit project format 2 carries optional purposes; format 1 and starter output
remain unchanged. Hash compatibility and identical project queries are tested.

All 99 rule scenarios pass. Focused artifact/project/page tests pass. Headless
Chrome confirmed keyboard expansion and wide/narrow layout; corrected identity
list overflow exposed by the new revision row. VoiceOver is deferred to #719.
See the validation report and captures for scope and evidence. Full checks remain
required before commit; no publication or paid model call is involved.

The full suite passed 2,669 tests (one skipped). Added a further real-worker
format-2 evaluation regression, which passes with identical order and reasons.
Package validation caught a newly shared formal-renderer chunk omitted from the
npm allowlist; added its specific chunk family and import-graph coverage. The
complete installed-package validation now passes. Re-running the required full
checks on these final changes before commit.

Final validation passed: check (zero errors, 54 existing warnings), 145 test files
with 2,670 passing tests and one skip, build, smoke and installed-package tests.
The import-cycle guard caught a temporary renderer-to-document type cycle; the
renderer now accepts structural English-model inputs and the guard passes.
No cycle exception was added. Both renderers use the same pure functions.
