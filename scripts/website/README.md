# Released-artifact website capture (#601)

Implements `doc/design/public-website.md`. `website:preview:build` remains an explicitly
empty local preview. `website:capture` produces a new static artifact, never an npm
publication or a live deployment. #602 owns the official publisher handoff, workflow,
deployment ordering and hosting setup. Its manifest producer is not shipped by this slice.

## Trusted invocation

Use a **clean checkout of the exact published gitHead**, including these helpers and
the website templates. Install that checkout's dev tools with `npm ci --ignore-scripts`.
The helper refuses a different/dirty checkout. A release predating the generator cannot
build the site: wait for an explicitly requested official release containing it. Do not
borrow helpers from main or publish a package merely to repair documentation.

Supply `PDB_SITE_GITHUB_TOKEN` only in the capture job's environment: a repository-scoped
read-only token, with no publication, Pages, deployment or environment write permission.
The helper does not acquire credentials from `gh auth`, personal files or another token.
The surrounding #602 workflow must enforce permissions and independently validate its
trigger/run before invoking code. The capture additionally verifies the exact publisher
attempt, official release and tag through fixed read-only API requests.

```sh
npm run website:capture -- --publication /path/to/publication-manifest.json --docs-run 12345
```

`--output NEW_DIRECTORY` optionally replaces the default `dist/website-release` destination.
It must not already exist. Arguments select input/output only; they cannot add commands.
A successful build leaves four HTML routes, CSS, compiled copy controls and
`site-manifest.json`. It does not deploy. No output directory is produced on a failed
capture; existing artifacts are never selected as a silent fallback.

Live capture supports POSIX hosts with Node 26+, npm, Git and gh (Linux Actions is the
intended deployment build host; macOS also works). Windows runs the pure policy, manifest,
renderer, sanitizer and process tests; the POSIX proxy/installer integration tests are
explicitly skipped there. No new web runtime dependencies enter the distributed CLI.
The temporary executable `gh` launcher and compiled JS are generated private build
artifacts, not maintained non-TypeScript workflow sources.

## Provenance and capture

`manifest.ts` defines strict versioned publication and site schemas. The publisher input
names the repository ID, workflow ID/path, exact run/attempt/event/ref/SHA, stable channel,
exact package/gitHead/SHA-512 integrity/tarball, official release ID/tag/time and completion.
Unexpected fields, prereleases and conflicting source identities fail. The official
release tag must resolve to the expected commit (one annotated-tag level is supported).

Registry resolution uses at most six probes within 120 seconds, separately reads the exact
version and stable tag, tolerates a missing exact version during propagation, and rejects
an overtaking release. A successful pin is immutable. Tarballs have a 20 MiB bound and are
SHA-512 checked **before** installing with lifecycle scripts disabled. Installed package
name/version/gitHead and the actual CLI version are checked again. The product executes
only from the isolated installed package, never source/tsx or a newly built CLI.

The code-owned plan captures version, help, rules and onboarding help when advertised;
then one live implementer briefing against this public repository into a private snapshot,
then designer and human offline projections of that same snapshot. Required unsupported
commands fail, rather than substituting unshipped syntax. Example focus `website_example`
is synthetic, not a claim. No setup, claims, mutations, hooks, agents or models are run.
No personal or source-checkout project configuration is loaded; `configSha256: null`
records that choice. A rules hash is recorded when the artifact exposes it; otherwise null.

Bounds: one host-local capture at a time; five publication-evidence requests maximum;
50 total gh calls including that evidence; 120 seconds for the live group; 30 seconds per
gh child/local command; 2 MiB combined stdout/stderr per command; 10 MiB sanitized output;
32 MiB private snapshot and site-manifest JSON; bounded registry responses and 120-second npm installation.
The shared proxy counter is locked across concurrent gh children. It allows one fixed
public repository GraphQL query or same-repository GET, with the existing rate-limit
witness. Mutations, alternate targets/roots, extra operations, automatic gh pagination,
field-file expansion and unexpected options fail. Local/offline commands cannot use gh.
Policy/budget refusal is fatal even if the product degrades to a partial report.

The host-local lock never expires or gets stolen automatically. Normal cancellation kills
owned POSIX process groups, cancels downloads and removes the private workspace/lock.
After an uncatchable kill or power failure, an operator must verify that no capture remains
before manually recovering its lock. No raw failed output or private cache is exported.

## Rendering and verification

Terminal OSC/CSI/control effects are stripped, controlled workspace paths visibly redacted,
and credentials/unexpected private paths/identities rejected. The renderer HTML-escapes all
captured text; output cannot create arbitrary links or markup. Each example has literal
safe argv, version/source through the publication identity, capture/observation time,
live/local/offline mode, exit code, completeness, omissions, no-truncation assertion,
control/redaction notices and a SHA-256 of exactly the sanitized displayed text.
Exit 2 is visibly partial. Exit 1, missing/unusable cache, unsafe or over-budget output fails.

The site manifest includes publisher/docs run IDs, template revision, npm integrity, policy/
config identity, example hashes, an explicitly empty screenshots array and static-file
hashes. Screenshots are optional and none are fabricated or accepted from another build.
`artifactSha256` is the SHA-256 of the sorted `[relativePath, sha256]` static-file entries;
it excludes the self-referential manifest. This is a content-tree identity, not a tar-file
checksum. Verification checks those files, all four rendered release metadata tags and
example hashes. #602 must additionally bind the manifest/artifact to its trusted docs run
and enforce deployment ordering before publication.

Tests use injected registry/process/GitHub/clock boundaries and labelled fixture data.
The installer test packs a temporary local fixture and installs it in npm offline mode,
proving lifecycle scripts are disabled without any real npm publication. Transport tests
compile and execute the real proxy against a fake gh binary. No model sessions or real
GitHub reads are needed to run the suite.
