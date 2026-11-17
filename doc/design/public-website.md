# Public PDB website and release-driven examples

Design contract for #599; implementation is #600 (pages), #601 (released-artifact
examples) and #602 (post-release deployment). This document does not publish a
site, configure hosting/DNS or request an npm release. Product decisions in #599
are accepted; no new product interview is needed.

## Purpose and four pages

The site at `https://pdb.stodge.org` explains how PDB reduces agent babysitting:
collect repository evidence, apply explicit workflow rules, and answer “what
should I do next?” with a role-shaped list and links. It does not promise autonomous
completion, online presence, permission to mutate, or universal native stop hooks.

| Page                                | Content, in order                                                                                                                                                                                                                                                   | Main action                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Home `/`                            | One-sentence purpose; compact real terminal example; what manual coordination it replaces; implementer/designer/director roles; evidence/freshness/unknowns; link to source and exact documented release                                                            | Copy global npm install, then a simple explicit-repository briefing command |
| How it works `/how-it-works/`       | GitHub facts → registered rules → prioritized role queues; review/own-work/dependency reasoning; the difference between a briefing and acting on it; optional native hook → packaged rebrief core → client continuation; measured platform boundaries and user stop | Inspect real examples and the released rules/help                           |
| Getting started `/getting-started/` | Node/npm/gh prerequisites; install/update/pin; authenticate gh yourself; one briefing; local identity only when needed; CLI and MCP paths; optional served dashboard; supported hook setup only when actually released; help/recovery                               | A short sequence of copyable released commands                              |
| Use cases `/use-cases/`             | Implementer finishes review follow-up before pickup; designer handles decisions and impact; human director finds requested input and blocking work; optional rebrief reduces repeated prompting within the client's verified limits                                 | Choose the relevant role example and open its evidence                      |

Keep each page small: roughly 300–600 words plus expandable examples. Prominent
initial commands are the global package install and `pdb --repo owner/repository`.
They are examples for the visitor's own repository, not commands the website runs.
A package update does not install Node or authenticate gh. Use the current-LTS
policy and released package engines, not an independently invented Node baseline.

Implementer/designer identity setup uses only the released supported setup command,
when present. Human director is a routing view (`--role human` with an explicit
routing name), not a third persistent agent-identity setup role. A name is never
GitHub authority. Do not teach hand editing `pdb.toml` or borrowing another name.

Reuse [onboarding](agent-onboarding.md), [role/rule guidance](blended-action-queues.md),
[human routing](human-briefing.md), [MCP](mcp.md) and [rebrief](shared-rebrief-core.md).
All product claims and runnable snippets must belong to the documented release.
A design contract, source-main help or a prototype report is not a shipped installer.
In particular, never advertise `pdb install codex` merely because #581/#589 define
it, or present a controlled-trial `--natural-stop-confirmed` flag as normal setup.

### Native continuation wording

PDB supplies the shared rebrief decision; the native client owns the event,
response protocol, trust, cancellation and model-visible continuation. Explain
that before-stop integration is optional: CLI/MCP use does not require a hook.
User interruption wins and caps/reentry protection prevent an endless loop.

A release-specific capability table names the actual tested client/version/OS,
what was observed, remaining limitations and its released report link. For example,
#398 observed a nonce and same-session continuation in a Codex CLI/app-server
trial using scaffolding; that is not proof of a production installer, the hosting
app's hook execution, or native interruption/error paths. An Ori watcher starting
a new turn must not be called a before-stop veto. Do not run a model/hook to build
the website. Unsupported/not-tested stays explicit rather than a green checkmark.

## Original visual and interaction system

Use a restrained 1990s terminal/TUI vocabulary: dark canvas, thin panel borders,
monospace headings, one bright accent and readable prose. Suggested starting
palette: `#101418` background, `#e9eee3` text, `#9af0bb` accent, `#84c8ff` links,
`#ffd37a` notices. Validate actual contrast during #600; body text must meet WCAG AA.
No JetBrains assets/layout copying, external fonts, scanlines, blinking text or
large decorative graphics. System fonts and CSS borders suffice.

One four-link navigation, current-page indication, skip link, semantic headings and
footer carrying the documented version. Prose stays around 72 characters wide.
At 320 CSS pixels and 200% zoom, reading and controls remain usable; only terminal
panels may scroll horizontally. Copy buttons act only on user request, copy literal
text, have keyboard focus and announce success/failure. Reading works without JS.

Examples are selectable escaped text in `pre/code`, with source/version/time and
coverage beside them. Optional screenshots are rendered from the same sanitized
captured text and fixed terminal dimensions, never invented with an image model.
Include accessible text equivalents. No analytics, login, user repository input,
private settings or live visitor-side GitHub calls are required.

## Hosting recommendation and observed setup

Recommend GitHub Pages with a custom Actions build: static output, current repo,
no new hosting account/server or publication token. The public repository is an
appropriate host; GitHub supports custom Pages workflows for public repositories.
See [the Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
Cloudflare Pages/Netlify would add an external connection and are unnecessary for
this four-page static site. This is a recommendation, not an assertion that either
external account is connected.

Initial design-time read-only checks on 2026-11-15 (superseded operationally below) found `private: false`, `has_pages: false` and current
GitHub-login repository admin permission. `GET .../pages` returned 404. DNS CNAME
and A queries for `pdb.stodge.org` returned NXDOMAIN. DNS-provider ownership/access
was not established; GitHub admin access does not imply DNS control. No setting
was changed. These missing setup facts do not block this design or offline builds.

For #602, owner/operator setup is: enable Pages with Actions as its source; configure
the deployment environment/allowed workflow; verify the custom domain, configure
it in Pages, then set the subdomain's CNAME to `trebizondoculpepper.github.io` through
the actual DNS provider; validate resolution and HTTPS before calling the custom
URL live. Do not direct the CNAME at a repository URL/path or add a wildcard.
Follow [GitHub's custom-domain setup order](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
to avoid leaving a dangling domain. DNS/Pages changes and live deployment belong
to #602, not this design task.

### Current hosting and domain preservation (#621/#622)

By 2026-11-15 22:46 UTC the owner-authorized manual preview was served from
`gh-pages` `/` with custom domain `pdb.stodge.org`, an approved certificate and
HTTPS enforcement. All four routes/assets and default GitHub redirects were
verified. This is not evidence that #602's released-artifact workflow shipped.

Follow the [deployment runbook](../runbooks/public-website-deployment.md) to preserve
the binding. #602's target remains custom Actions Pages publishing: retain the
Pages API custom-domain setting and HTTPS enforcement, without appending a CNAME
file to #601's already-hashed artifact. Branch mode instead requires its root CNAME
and a reviewed artifact/schema plan if retained. Source-mode migration is explicit;
normal builds/retries do not recreate domains or change DNS. Preflight and post-host
checks verify the custom root, nested routes, actual assets, default GitHub redirects
and the deployed manifest/version. All release/source/order guarantees below remain.

## Release identity and handoff

The existing [explicit npm publication contract](../npm-releases.md) remains
unchanged: only an explicit release request publishes. Main pushes, PR builds,
website failures and documentation retries must never publish or consume versions.

Observed implementation: `.github/workflows/publish.yml` is named `Publish`, runs
only on `workflow_dispatch`, validates channel/ref/full source SHA, publishes to
npm, then creates the official Git tag/release. There is currently no site workflow,
publication handoff artifact or site generator. The package's checked-in `0.1.0`
version is not the published version; the publish job derives the actual version.

#601/#602 add a strict versioned `publication-manifest.json`, uploaded after verified
publication/release completion, including already-published repair runs:

- Repository ID/name; workflow ID/path; run ID and attempt; event, ref and source SHA.
- Channel, exact package/version, published `gitHead`, `dist.integrity` and tarball URL.
- Matching official release/tag identity and explicit completion state.

Resolve metadata for the exact publication; never substitute an unrelated current
`latest` when the requested version is not yet readable. A skipped publish job or
missing manifest is not a successful handoff. Upload failure is a visible partial
outcome; it cannot cause another npm version to be allocated.

Use a separate website workflow on `workflow_run` completion of `Publish`, with an
explicit same-repository/workflow-ID/event/ref/success guard before fetching data.
Require `workflow_dispatch` publisher origin, official `latest` channel, stable
version and matching `release` source SHA. Verify the run independently through
the Actions API; the workflow name or artifact's claimed fields alone are not
trusted. Do not execute a downloaded manifest or arbitrary artifact as code.
A manifest is strict bounded JSON; unexpected fields/schema/conflicting identities
fail safely. Untrusted PR/fork workflows cannot reach a credentialed build/deploy.
[GitHub documents the privilege risks of `workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

Do not rely only on `release: published`: the current publisher creates releases
with `GITHUB_TOKEN`, whose generated events generally do not start more workflows.
The completion handoff avoids that dependency; no new PAT is required.
See [GitHub's workflow triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## One pinned build, bounded registry propagation

1. Verify the triggering run/manifest and exact official release/tag/source SHA.
2. Allow at most six propagation probes over 120 seconds for the expected exact
   version and stable tag to become consistently readable. Older tag visibility
   is propagation lag, not permission to build old docs. An observed newer stable
   version supersedes this candidate. Contradictory/missing metadata at the deadline
   fails; preserve the last successful site.
3. Resolve stable `latest` into the build candidate once, requiring it to equal the
   triggering exact version. Pin package/version, gitHead and integrity for the
   entire build. Later checks may reject it; they never change its identity.
4. Download/install the exact npm artifact with lifecycle scripts disabled in an
   isolated prefix, verify integrity and installed version, and require its gitHead
   to equal the triggering source. An exact-version lookup is supported by
   [npm view](https://docs.npmjs.com/cli/v11/commands/npm-view/).
5. Checkout templates and TypeScript helpers at that same released gitHead. Generate
   examples only by executing the installed npm binary, never `src/cli.ts`, tsx
   source execution of the product, or a freshly built source CLI. Building a
   release-matched static renderer/helper is separate from rebuilding the product.

Thus no unreleased main content supplies commands or product claims. If a stable
release predates the site generator, report that incompatibility and wait for an
explicit official release containing #600/#601; do not silently borrow main's
scripts or publish a new package to make the site work. Offline PR fixtures test
the pipeline without any real npm release or live deployment.

Stable publication updates the stable site. `next` never replaces it. Initially,
prereleases may produce clearly labelled downloadable build artifacts only: no
live preview host is required. A later isolated preview must use a separate path/
origin, no stable CNAME/default redirect, the same version proof and no stable
promotion. Omit prerelease installation from the main quick start; link opt-in
`@next` guidance with its meaning.

## Real read-only capture and safe rendering

#601 defines one code-owned argument-array allowlist, not commands taken from issue
text or interpolated into a shell. Local reads include version, help, rules and
onboarding help only when supported by the exact artifact. Live examples target
only this public repository. Capture one real snapshot into private temporary
storage, then reuse that same snapshot for other role examples through supported
offline CLI commands. Label those projections OFFLINE/from the captured snapshot;
never describe them as a new live read. Generated help/command assertions must
pass against the exact artifact, including unsupported-capability tests.

Initial bounds: one capture group at a time, at most 50 gh requests and 120 seconds
for live capture, 2 MiB stdout per command and 10 MiB sanitized output total. A
TypeScript budget/transport adapter may forward to the real installed gh, enforcing
the shared counter/deadline under a private lock across concurrent child reads.
It permits only query operations and allowlisted GETs for the public target,
rejects mutations/other repositories, forwards argv literally and does not log
credential-bearing values. This is not a collector/ranker. Reaching a bound stops
capture without another token, retrying a possibly applied command or broadening
scope. #601 may tune these named bounds with measured evidence in its PR, not an
unbounded fallback. Record actual request count; unknown GraphQL cost stays null.

Use a clean temporary HOME/XDG/gh configuration, no personal `pdb.toml`, inherited
agent/hook variables, source caches or user npm settings. Public release-matched
project settings may be used and named by digest. Set an explicit synthetic example
focus where needed; it is neither an actual agent claim nor authentication. Never
run `setup`, `claim`, `submit`, `complete`, `estimate`, dependency mutations,
`onboard --install`, hook installation, rebrief initialization, a model or an agent.
The page may explain supported user setup without executing it during capture.

Capture has a repository-scoped read-only token only, supplied just for the gh
read. No npm publish, Pages write or deployment metadata permission enters the
capture process. Missing access yields a failed capture, not an authentication
prompt or a fabricated example. Permission/source incompleteness remains visible.

Strip terminal control sequences, including OSC hyperlinks/clipboard operations,
CSI movement/erase, C0/C1 controls and carriage-return rewriting, before rendering.
Preserve ordinary printable text, spacing, tabs/newlines; HTML-escape everything.
Do not execute or interpret output as HTML, Markdown commands or scripts. Link only
validated source GitHub URLs; reject javascript/data/file URLs and URL credentials.
Run a conservative credential/private-path/private-identity exposure check before
publishing: credential or unexplained identity matches fail and discard output;
necessary path redactions use a visible placeholder and are listed in metadata.
Never upload raw private caches or raw failed-command stdout/stderr as public
workflow artifacts. Cache/path arguments in displayed provenance are either safe
controlled relative paths or visibly redacted, never silently rewritten commands.

Every published example carries exact version, gitHead, command ID/sanitized argv,
capture time, source repository, observation time, live/offline mode, exit status,
coverage/completeness, omissions/truncation and sanitization/redaction notices.
Exit 2 is a labelled partial snapshot, not “all current work”; exit 1/invalid schema,
size/credential failure or an unbounded/malformed result prevents deployment.
Examples are dated snapshots, never silently called current after capture.

A site manifest adds schema version, source publish run/attempt, docs run, template
revision, npm integrity, policy/config identity when exposed, per-example hashes,
optional screenshot hashes and final site artifact digest. It is generated from
verified facts, not a manually updated version banner. Screenshots use the same
sanitized output and manifest; no screenshot from another release is mixed in.
No visitor-side API credential or raw private configuration appears in the bundle.

## Owner-supplied conversation illustrations (#793)

The owner requested three supplied conversation screenshots as editorial website
content. Keep these distinct from release-validated CLI examples: label their
source and historical date, describe an assistant explaining PDB evidence rather
than presenting assistant prose as native PDB output, and do not infer release
capabilities, live priorities or product completion from the depicted tickets.
Provide useful captions/alt text, responsive previews and full-image links.
Preserve original image bytes; use a filename extension matching actual encoding.

A code-owned list in website/conversations.ts names the three static image assets
under assets/conversations/. The renderer and builder share that list. The build
copies only those files; siteFiles admits only those exact image paths in addition
to its current HTML/CSS/JS paths, rejects symlinks/other files as before, and hashes
the images into the existing manifest files map and artifact digest. No generic
binary extension allowlist, fetched image URL or unverified manifest field is added.
Editorial images never become captured command examples or receive fabricated
capture metadata. Require every listed image in a release artifact and verify its
bytes match the reviewed source asset, so an absent or substituted illustration
cannot pass simply by rewriting file hashes.

The owner-authorized manual preview may receive this labelled editorial update
through its existing gh-pages branch, preserving CNAME and HTTPS configuration.
That is not a release-driven build or proof of #602 completion. Future verified
release builds still use images/templates from the exact published source and all
existing capture, publication and manifest checks. Do not append these assets to
an already-hashed release artifact or rewrite its capture provenance.

## Deployment ordering and recovery

Build/capture/test jobs are read-only. A separate protected deploy job receives
only the validated static artifact and manifest; it does not run the npm product,
install its dependencies or execute captured content. Pages requires `pages: write`,
`id-token: write` and a deployment environment; keep those permissions out of the
build/capture jobs. See [the Pages deployment requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages#deploying-github-pages-artifacts).
Pin reviewed Actions to immutable commits during implementation.

Serialize stable deployment in its own group, without cancelling a Pages upload
in flight and without sharing the npm publication concurrency group. Inside that
serialization, revalidate the pinned version against stable registry/release
metadata and the last deployment intent. If newer, conflicting or unknown evidence
exists, skip/fail without moving the site; never rebuild a different version in
place. This second check is rejection-only, not another build-version resolution.

Keep the monotonic deployment intent in GitHub deployment metadata, not a CDN read
of the site's potentially cached version banner. Use a dedicated environment/task
and a strict payload containing the verified version/source/integrity/artifact
hash and run IDs; validate the latest record against the trusted docs workflow.
Before Pages deployment, persist the candidate intent. Versions may stay equal on
a repair or increase; they may not decrease. A previous unknown/in-progress intent
also prevents an older version, since that operation might have applied. This
requires `deployments: write` only in the deploy job. GitHub provides deployment
payloads/status records through [its deployment API](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment).
No database or new credential is introduced. Unknown/malformed/unreadable state
stops deployment; lack of history must be positively distinguished from failed
history access. A later known candidate can repair the same version. Out-of-band
manual site deployments need reconciliation, not automatic assumption of safety.

Use the standard Pages artifact and deployment actions, with the deploy job needing
the successful build. Publish status and links only after the host confirms success.
Failure before deployment preserves the last site; a lost response after upload
is unknown, inspected through Pages/deployment APIs before retry. Never delete the
last site or roll back to an older candidate as failure cleanup.

Provide a docs-only manual retry with exact version and source publish run/attempt.
It revalidates immutable registry, release and run evidence and rebuilds the same
candidate; no publication helper is invoked. If the publication manifest is missing,
require explicit reconstruction from matching registry gitHead/integrity, official
release/tag and trusted publisher run, rejecting ambiguity. Disabled/missing Pages,
DNS or environment permissions are actionable setup failures, not npm failures.

## Delivery and acceptance

| Ticket | Concrete handoff                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #600   | Four small static pages and original responsive terminal styling, TypeScript copy controls, escaped example slots, capability-gated snippets, manifest/version display, accessibility and screenshot QA; no live publication                        |
| #601   | Typed publication/site manifests; exact-artifact installer; released-source template selection; allowlisted budgeted capture/cache reuse; control/path/credential sanitization; screenshot provenance; injected registry/process/clock/gh fixtures  |
| #602   | Publisher manifest handoff and guarded completion trigger; read-only build versus protected deploy permissions; monotonic deployment intent; stable/prerelease isolation; docs-only retry; Pages/DNS setup checklist and actual deployment evidence |

#600 and #601 can proceed independently using explicitly labelled fixtures. #602
needs both. Keep their native dependencies and estimates; re-estimate when measured
work changes the scope. #599 completes with this reviewed contract, not with a live
site or a claim that the downstream tickets shipped.

Required injected checks: exact version/gitHead/integrity mismatch; registry lag and
deadline; overtaken build; disabled/skipped publisher; wrong workflow/repo/ref/run
attempt/fork artifact; old release without generator; partial/failed capture;
request/time/output cap; unsupported command; literal argument forwarding; no
mutation or model/hook call; offline labels; hostile HTML/terminal control/path/
credential output; matching screenshot provenance; deployment-order races,
write-ahead intent followed by unknown completion, unreadable prior state, duplicate
retry and prerelease rejection. Run fixture validation without live mutations.

Browser/package checks cover all four routes, copy controls, keyboard/zoom/mobile
layout, safe source links and meaningful no-JS reading. Deployment smoke confirms
version and manifest from the deployed artifact after host success; stale DNS/TLS
or CDN evidence cannot be called a successful custom-domain deployment. Record
missing external setup concretely without blocking design or inventing access.
