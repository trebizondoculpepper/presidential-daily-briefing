# #1026 npm onboarding hint

One line, printed by a `postinstall` hook: `node -e "console.log('Run pdb onboard in your project
for onboarding instructions.')"`. The merged contract `doc/design/onboarding-rules-files.md` asks for
exactly that — a literal Node print in the required manifest, no application module, no
devDependency, no checkout, no network — so this is one manifest entry rather than a new installer.

The package test was the obstacle, not the code: `scripts/package-test.ts` asserted that the archive
runs **no** install scripts at all. That guard predated the owner decision and would have blocked the
contract silently. It now permits exactly the approved literal and still refuses `preinstall`,
`install` and any other `postinstall`, so the old protection survives in a narrower form.

Evidence comes from the packed install, not the source tree: `npm run package-test` installs the real
archive into an isolated prefix, and the new `src/install/postinstall.test.ts` checks the manifest
literal, runs the hook, and asserts the published message contains no build artifact, client or
network reference. `npm run check`, `npm test` and `npm run build` are green.
