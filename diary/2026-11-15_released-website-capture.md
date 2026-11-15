# Release-validated website examples (#601)

Continued from the merged #599 contract and #600 local page implementation. Added strict
publication/site manifests, official run/release/tag verification, bounded registry pinning,
verified tarball installation, isolated configuration, a compiled read-only gh proxy with
shared request/deadline enforcement, and a code-owned real-snapshot/offline-role plan.

Captured text is sanitized, exposure-scanned, hashed and escaped by the renderer. Private
snapshots stay temporary; failures/cancellation produce no new output or deployment.
Release metadata appears in all four HTML routes and is checked against the manifest.
No screenshot output is fabricated; the optional screenshot list is empty. Source helpers
and templates must match the exact released gitHead; old artifacts cannot borrow main.

Local fixture tests exercise policy refusal, literal argv, concurrent limits, cancellation,
registry lag and mismatches, publisher provenance, partial/unsafe output, installed artifact
identity and disabled lifecycle scripts, and final artifact tampering. Live capture requires
a separately supplied repository-scoped read-only token and an official release containing
the generator. No new release, hook/model session, live capture, DNS edit or deployment was
run to develop this feature. #602 retains release workflow/deployment integration. #600's
browser QA remains open because browser/native Chrome access is unavailable.
No TODO.md exists in this checkout.

Validation before commit: npm run check (zero errors; existing 51 warnings), full suite
2,285 passed/one skipped, npm run build, local preview build, capture --help smoke and
npm dry-run package exclusion. The compiled proxy and offline tarball installation were
executed against generated fixtures; they are not presented as real release examples.
