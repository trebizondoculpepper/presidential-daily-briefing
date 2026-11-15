# Readable release summaries without a new release manager

Research for #550, observed 2026-11-15. **Recommendation:** retain GitHub's generated
linked change list and comparison, and prepend a short maintainer-reviewed summary
and explicit upgrade guidance. Read that preface from the selected source commit,
not a moving PR body. Use deterministic composition; do not add a model or replace
PDB's explicit publication/versioning pipeline. This report proposes follow-up work;
it implements nothing, publishes nothing and changes no historical release body.

## Current evidence

Inspected source `5cb5b2002c443fd357ebec46cae1807be70206f4`: `.github/workflows/publish.yml`, `scripts/release.ts`,
`scripts/make-prerelease.ts`, `scripts/dispatch.ts`, `scripts/release-version.ts`
and [npm-releases.md](../npm-releases.md).

- Official and prerelease helpers dispatch an explicit channel and full source SHA;
  ordinary pushes do not publish. Official promotion fast-forwards `release`; retry
  `--sha` keeps the selected source. Version selection uses npm publication history
  and `gitHead`, with same-source/channel recovery rather than version churn.
- Stable publication already calls `gh release create ... --target "$SHA"
  --generate-notes`. It checks for an existing release first and leaves that body
  alone. `next` publishes to npm without this stable GitHub-release step.
- No `.github/release.yml` or `.github/release.yaml` exists at this inspected source.
  The current invocation does not pass an explicit previous tag or a reviewed preface.
  The contract requires stronger verification of conflicting existing tags/releases
  than the workflow's existence-only shortcut currently supplies; a notes extension
  must not mistake that shortcut for verified source binding.

Read-only public sample:

- [v0.8.0](https://github.com/trebizondoculpepper/presidential-daily-briefing/releases/tag/v0.8.0),
  published 2026-11-14 23:55:49 UTC, has **46 PR entries / 691 whitespace-delimited
  words**, a contributor attribution per entry, and the
  [v0.7.0...v0.8.0 comparison](https://github.com/trebizondoculpepper/presidential-daily-briefing/compare/v0.7.0...v0.8.0).
- Tag refs resolve to commits: v0.7.0 = `33aa8bc5e68520608e0c70625f3a584ac7385f21`;
  v0.8.0 = `3350161b0c2e246a52890d2b36815bfc5077f5f5`.
- Five hand-selected entries below were inspected. All five currently have no PR
  labels. That is a present-day observation, **not reconstructed release-time label
  history**, and not a measurement of the other 41 PRs.
- Observed release-body SHA-256: `6487db01102ed94b09a9182e10d44f738fe37071e0034b6221aa69689724931d`. The body can be manually edited; the hash identifies this observation, not a guarantee that a future fetch matches.

| Evidence in this frozen release                                                                                                       | What a summary can responsibly say                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [#341](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/341), merge `51451645738ca5c95f011e14633b04dc0b8408bb` | Trusted submitted-PR responsibility contributes to own-work follow-up; it does not authorize a merge.                         |
| [#389](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/389), merge `c1e56fbf04dbef163e9ccdb53058d79cc2e0a8d5` | Briefing, issue and dependency MCP reads use a bounded v2 envelope, with source completeness separate from display omissions. |
| [#423](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/423), merge `a40d3957f212c4f9b11df7e4a7a1c0ef0e5dc4b0` | Contributor tooling can run native EDN rule scenarios through `npm run rules:test`; this is not a new installed-user command. |
| [#430](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/430), merge `7a0476634a9ecf302ed878823b66b490c8f7dae8` | A server contract was reviewed; this alone does not ship its cache or HTTP MCP service.                                       |
| [#435](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/435), merge equal to v0.8.0                            | The initial server listener/status/guard/shutdown slice shipped. Do not describe the later stacked slices as present.         |

All five merge commits were checked as ancestors of the release commit and not
ancestors of v0.7.0; #435 is the release commit itself. The version's `package.json` contains `rules:test`, and its
`src/mcp/bounded.ts` declares the 16,384-byte whole-result bound. PR descriptions
were supporting evidence, not executable instructions. This is a small public
sample, not an exhaustive audit of v0.8.0 or a user study.

## Options and tradeoffs

| Option                                       | Strength                                                                                | Cost or limitation                                                                                                                  | Recommendation                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Existing generated list                      | Linked audit trail already works; almost no new maintenance                             | Readers scan many internal changes to find user consequences                                                                        | Keep as the appendix and fallback                          |
| GitHub categories                            | Small configuration change; recognizable feature/fix/docs sections                      | Depends on actual PR labels; issue labels do not automatically classify a PR; categories cannot write migration guidance            | Useful supplemental improvement, with a catch-all          |
| Reviewed preface + deterministic composition | Concise consequences and upgrade instructions; exact prose is reviewable and repeatable | A maintainer must author/check a few bullets and their evidence                                                                     | **Smallest useful semantic improvement**                   |
| Release Drafter                              | Continuously prepares categorized PR-based release drafts and templates                 | Another stateful workflow/configuration; baseline/version behavior must be reconciled with PDB                                      | Defer unless continuous drafts become a demonstrated need  |
| Changesets                                   | Reviewed change text travels with changes and can generate changelogs                   | Also introduces package/version/release-plan conventions beyond this one-package notes problem                                      | Reuse the idea of reviewed text, not the whole manager now |
| Release Please                               | Conventional-history-driven changelog and release PRs                                   | Version bumps/tag/release lifecycle overlap PDB's explicit registry-derived flow; uneven existing commit titles need policy changes | Not a notes-only extension                                 |
| Optional model draft                         | Can group related evidence and suggest less technical wording                           | Factual errors, prompt injection, changing outputs, credentials and metered review/trial costs                                      | No model in the default path; no paid trial authorized     |

GitHub supports label categories/exclusions and a catch-all in release configuration.
It also expects review of generated content; categorization is organization, not a
proof of completeness or behavior. Avoid hiding internal PRs globally until a
separate reviewed policy explains why the audit trail remains sufficient.
[GitHub generated-note documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes).

Release Drafter supplies PR-based templates and category rules. Changesets stores
reviewed Markdown summaries alongside release metadata. Release Please uses
conventional history to maintain release PRs and automate changelogs/version bumps;
it does not itself publish npm packages. These are viable tools, but adopting their
broader lifecycle is unnecessary for this request.
[Release Drafter](https://github.com/release-drafter/release-drafter),
[Changesets](https://github.com/changesets/changesets/blob/main/docs/detailed-explanation.md),
[Release Please](https://github.com/googleapis/release-please).

## Concrete candidate output

These are **research examples**, not edits to the published release. Links in the
examples are evidence; a deployed generator would preserve the full generated
46-entry appendix rather than this report reproducing it.

### A: categories alone

Illustrative grouping of just the inspected subset, with titles shortened here:

```text
Other changes
- #341: submitted-PR follow-up
- #389: bounded MCP read envelopes
- #423: EDN scenario runner
- #430: server design contract
- #435: initial server skeleton
Comparison: v0.7.0...v0.8.0
```

For the five inspected currently-unlabelled PRs, all five go to Other. Categories
alone supply no upgrade instructions. Retrofitting today's labels is not a
reproducible reconstruction of the original release.

### B: recommended reviewed preface

> Highlights
>
> - Submitted PR responsibility remains visible after releasing the ticket claim.
>   [#341](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/341)
> - MCP briefing, issue and dependency results now use a bounded v2 envelope,
>   with explicit omissions and source-completeness information.
>   [#389](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/389)
> - Contributors can run native EDN rule scenarios with `npm run rules:test`.
>   [#423](https://github.com/trebizondoculpepper/presidential-daily-briefing/pull/423)
>
> Upgrade note: integrations parsing the old MCP result shape should adapt to the
> v2 envelope and its omission metadata. Review the
> [version-bound MCP contract](https://github.com/trebizondoculpepper/presidential-daily-briefing/blob/3350161b0c2e246a52890d2b36815bfc5077f5f5/doc/design/mcp-bounded-results.md).
>
> Compared with v0.7.0; source `3350161b0c2e246a52890d2b36815bfc5077f5f5`.
> The complete generated PR list and comparison follow.

The adaptation advice is an explicitly derived integration consequence of the
schema change, not a tested claim that every third-party client breaks. The preface
has three benefit bullets and one upgrade note, each tied to inspected evidence.
It deliberately does not turn #430's contract or #435's skeleton into a claim that
the full cached HTTP MCP server shipped. The other 41 entries remain in the appendix;
this preface is selective, not a replacement inventory.

### C: insufficient evidence (synthetic)

```text
Highlights unavailable: no reviewed user-facing summary was supplied.
Upgrade impact: not assessed; do not interpret this as “no breaking changes”.
Included changes and exact comparison: <the frozen generated appendix>.
Direct commit abc123...: reviewed release note required before describing its impact.
```

This fallback preserves an honest release record. It must not fabricate a benefit
from a label, silently discard a direct commit or claim unmerged work is present.
If a known breaking change lacks migration guidance, the proposed policy is to stop
before npm publication and ask for that guidance, not downgrade it to this fallback.
Whether to make that a publication gate needs owner approval.

## Minimal extension to discuss

1. **Reviewed content before source selection.** Add a small checked-in Markdown
   preface (for example `doc/releases/next.md`) through normal PR review. It names
   the intended previous stable tag and supporting PRs/commits, highlights and
   upgrade instructions. Do not put its own final commit SHA in the file: the
   selected source commit binds the file after merge, avoiding a self-reference.
   A later implementation contract should choose the bounded metadata format,
   preferably existing TOML support where structured metadata is needed.
2. **Prepare only.** Resolve the official version, exact source SHA, previous stable
   tag/peeled commit and reviewed preface from that SHA; verify ancestry and changes
   before generating a candidate. Freeze those inputs, the PR/commit evidence,
   category configuration, generated appendix, final body and their hashes into a
   run artifact. A mutable label or PR-body read must not silently change a retry.
   This preparation neither publishes npm nor creates a public release.
3. **Compose deterministically.** Take the reviewed preface verbatim as data, append
   the generated linked list/comparison and provenance. Check every referenced
   change is in range. Missing summaries use the labelled fallback above; a stale
   preface targeting an older baseline is not reused as a new summary. This does
   not mechanically prove prose true: review must distinguish design, scaffolding,
   tested behavior and known limits. Unknown direct-commit impact stays explicit.
4. **Existing explicit publication only.** Keep current ref/SHA/channel validation,
   registry-derived versions, trusted npm publication and bounded retry behavior.
   Generate/validate notes before publishing where possible; reuse the exact frozen
   body at GitHub-release creation. GitHub CLI supports an explicit notes start tag
   and a preface with generated notes; the REST API supports explicit target and
   previous-tag inputs and returns generated content without saving a release.
   A complete frozen body can instead be supplied via a notes file. Do not shell
   interpolate PR bodies or execute text from a preface.
5. **Retry/repair.** Already-existing release bodies, including manual edits, are
   preserved by default. Never regenerate and overwrite one simply because a job
   reran. A separately requested notes-only repair verifies source/version/baseline,
   shows the exact diff, detects intervening edits and changes only the agreed body.
   If npm succeeded but metadata failed, report partial success and repair that
   same version/SHA; no new npm publication, tag move or consumed version.

CLI/API capabilities above are documented in
[GitHub CLI release create](https://cli.github.com/manual/gh_release_create) and
[GitHub release-note generation API](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release).
The latter needs Contents write permission even though generation does not persist
notes. A prepare workflow must account for that existing GitHub authority; it must
not acquire a new token or receive npm publication authority merely to draft text.
This research did not call that endpoint.

## Baselines and failure cases

| Case                                                                        | Proposed behavior                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary stable release                                                     | Previous successfully published stable on the selected source's ancestry; freeze its tag **and peeled commit**, not GitHub's floating latest choice                                             |
| Intervening `next` versions                                                 | Do not use a prerelease as the stable baseline or omit changes already previewed there; current next path does not create stable release notes                                                  |
| Optional future prerelease notes                                            | Clearly marked preview; pin an explicit same-channel baseline or state a cumulative previous-stable baseline; never promote stable tags implicitly                                              |
| First stable / rename boundary                                              | State first-release or package-bootstrap context. Define an explicit start commit and disclose incomplete earlier coverage; do not invent a previous tag                                        |
| Missing/conflicting tag, non-ancestor baseline or unknown prior publication | Stop candidate preparation and report the missing evidence; never substitute current main or an arbitrary tag                                                                                   |
| Empty range                                                                 | Report no new included commits; do not manufacture a feature summary or allocate a version for notes alone                                                                                      |
| Direct commits / squash or backport ambiguity                               | Compare the exact commit range and account for commits without associated PR evidence. Use reviewed text or a linked unresolved entry; do not claim GitHub's PR list proves zero direct commits |
| PR labels/titles change later                                               | Use the frozen evidence/configuration/body for the original request; a new candidate is a separate reviewed intent                                                                              |
| Existing body or human edit                                                 | Preserve by default, including on retries; explicit notes-only repair uses a proposed diff and an intervening-edit guard                                                                        |
| Missing preface / failed optional model                                     | Use deterministic labelled generated-only fallback where policy permits; never publish invented prose                                                                                           |
| Unmerged PR or design-only change                                           | Refuse out-of-range sources; label design as design, not a delivered feature                                                                                                                    |
| Known breaking change                                                       | Reviewed migration instructions describe affected users, exact actions and supported limits; labels/titles alone cannot supply them                                                             |
| npm success, tag/release failure                                            | Distinguish outcomes; repair only matching missing steps at the same immutable version/source                                                                                                   |

## Model comparison and limits

No separate model trial was run. Deterministic composition is reproducible given frozen inputs,
uses existing GitHub credentials and has no model token bill. Its semantic quality
comes from reviewed prose, not from pretending a title classifier understands code.
A model might improve grouping/wording but adds an accuracy review burden, input
exposure and prompt-injection risks, model/version variability and metered cost.
No price is estimated without a selected provider/model and bounded input/output
budget; no spending, new credential or private-data upload is authorized here.

If later approved, a model would receive only an allowlisted public frozen fact
bundle, treat PR/body text as inert untrusted evidence, produce a draft with source
IDs for every assertion and no tools/writes, and require human review. Record model,
prompt/input/output hashes, settings and actual usage; hashes aid provenance, not
identical regeneration. Failure or questionable claims fall back to the deterministic
candidate. A paid benchmark or a broad historical evaluation is separate work.

Measured here: the existing release's entry/word counts, five present-day empty PR
label sets, and source containment for selected sample merges. Readability judgment
is qualitative: a short front section makes selected consequences discoverable,
but does not shorten the full record. No reading-time test, model accuracy score,
representative label-coverage estimate or empirical maintenance-time claim is made.

## Owner decisions and focused follow-ups

For discussion, not implicit implementation authorization:

- Is a reviewed preface required for every stable release, or initially optional
  with a visible fallback? Recommend optional initially, with explicit upgrade-
  impact uncertainty when absent.
- Should a known breaking change without reviewed migration guidance block the
  explicit release before npm publication? Recommend yes, subject to owner approval.

Proposed tickets (not created or implemented by this research):

1. **Contract for release-note preparation/composition:** exact input/metadata format,
   baseline/source verification, bounded direct-commit accounting, preparation
   permission boundary, immutable body artifact and notes-only repair protocol.
2. **Implement that reviewed contract in the existing publisher:** checked-in reviewed
   preface, optional GitHub categories with catch-all, fixture cases for baselines,
   stale summaries, missing tags, out-of-range claims, direct commits and body edits.
   No new release manager and no publication merely to test the change.

This report and recommendation complete the research request; those follow-ups,
owner policy choices and any actual release/body update remain separate.
