# Shared-shell follow-ups: project-first context and running-process footer

Reviewed implementation contract for #733 and #730, prepared under #748. This
addendum supersedes the layout and footer details of [served-page-shell.md](served-page-shell.md)
where they differ. It changes no runtime by itself. #605's implementation is
complete; #732 independently fixes selection retention through Quotas.

## Project-first toolbar (#733)

Use the existing `src/serve/shell.ts` registry, selection resolver, link builder,
`ShellContext`, markup and styles. Every shipped HTML page has this order:

1. Product/project context with the project selector, including the current
   project or explicit no-selection state.
2. Page navigation, with current-page indication.
3. The page heading, notices and content.

The selector remains visible on account-wide pages such as Quotas. Its selection
is navigation context only: the quota heading must still say account-wide and no
quota request becomes project-scoped. Never replace a selected project with an
account-wide pseudo-project. Use #732's carry rules for repo, role and agent;
validate the same served allowlist and preserve Back/Forward behaviour. Rendering
or switching the selector does not initiate an unrelated GitHub collection.

Keep one selector and one navigation instance in the shared shell. A project menu
may be collapsed, but its labelled control and selected-project indication remain
visible at the top. At narrow widths the controls wrap in the same logical order;
no duplicate hidden focus targets. Keep the skip link, semantic landmarks, focus
visibility and the existing short-viewport treatment so sticky content cannot
obscure the page. Do not add per-page selection stores or infer cwd defaults.

## Process footer (#730)

Use a shared footer renderer in the same shell, also adopted by any older page
that still assembles its own outer HTML. Existing page-specific safety text may
remain alongside the shared identity, but must not replace it. The fields are:

| Field           | Meaning and source                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| PDB version     | Version already captured into `ServerFacts.version` at startup. Unknown is explicit.                                                  |
| Source revision | Full revision from verified metadata of the executing package/build, displayed shortened with full text available. Otherwise unknown. |
| Dirty build     | `true`, `false` or unknown from that same build provenance; unknown must never display clean.                                         |
| Started         | `ServerFacts.startedAt`, rendered as a labelled absolute UTC time with machine-readable `datetime`.                                   |
| Public IP       | Optional already-known, validated public address supplied by trusted running-server metadata. Omit or mark unavailable when absent.   |
| Doctor          | A link only when the Doctor/Diagnostics page is actually registered as shipped.                                                       |

Capture an immutable process identity once at startup. Add an optional structured
build identity to `ServerFacts` and the existing status document; older clients
may ignore it. Each value carries its source (`package-version`, `build-metadata`
or `unknown`). Existing package `gitHead` may identify a release source only when
it actually belongs to the executing artifact; do not reinterpret it as evidence
of a locally rebuilt dirty checkout. No current source exists for a field is a
supported result, not a reason to infer one. A future build-manifest producer can
fill unknown revision/dirty values through this interface without holding the
initial footer hostage to build-pipeline work.

Do not run Git against the served project or the server's cwd to identify an
already-built executable. Pulling code or replacing files after startup must not
change the displayed running version/revision/start time. For source execution,
report revision/dirty only when a verified executing-source provenance mechanism
provides them; otherwise unknown. Never equate the latest npm release, current
checkout, or selected project revision with this server's build.

The bound URL/loopback address is not a public IP. Do not contact an IP-discovery
service, inspect arbitrary network interfaces, disclose private hostnames/paths,
or add a settings input for an untrusted browser to impersonate process identity.
The footer performs no GitHub/network lookup, polling, Doctor run or mutation.

The Doctor link uses the shared page registry/link builder, retaining valid
project context. It may point to the Doctor tab of `/diagnostics` when that route
ships. Omit it before then: #585 is not a native blocker for #730. A registry
entry alone must not claim the route is served in this build.

## Implementation and verification

Ship #733 and #730 independently. Both reuse the shared shell, require no new
ranking/eligibility logic and retain escaping, CSP and Host/Origin boundaries.
Metadata parsing/formatting is factual presentation; workflow decisions remain
native policy. No global install, running-server restart or release is implied.

For #733, cover Work -> Quotas -> Rules/Work, no selection, malformed/unserved
selection, role/agent carry and Back/Forward using existing route helpers. Verify
selector-before-nav order and visibility on representative short/long pages at
narrow/wide widths, with keyboard focus and reduced-motion preferences respected.

For #730, inject version/start/build values for known and unknown cases; test that
later filesystem/selection changes cannot alter the captured identity. Check
HTML escaping and UTC date rendering, conditional Doctor link/valid context,
public-IP absence and no outbound discovery. Test the shared component once and
representative route integration rather than duplicating every full page snapshot.
A manual visual pass confirms footer wrapping, readable text and no content
occlusion. Do not claim VoiceOver verification without running it; #719 remains
separate. No new default-CI research/soak test is required.
