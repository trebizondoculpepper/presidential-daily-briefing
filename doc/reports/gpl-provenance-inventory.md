# GPL provenance and scoped-exception feasibility

Bounded technical inventory for #840, checked 2026-11-17 against main `67900aa`.
Follows [the DataScript options report](gpl-datascript-options.md). No license,
dependency, notice, release or external-party communication changed. This report
returns **unknown pending a concrete rights confirmation**, not blanket clearance
or a claim that anyone violated a license.

## Evidence inventory

| Portion                       | Evidence and observed grant                                                                                                                                                                                                                                                                                                                                             | What it establishes / does not establish                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standalone bootstrap          | Commit [`68ab588`](https://github.com/trebizondoculpepper/presidential-daily-briefing/blob/68ab5883dd18a91def97ed77741ed64c6ca6918d/LICENSE) contains MIT; its manifest says MIT. The root LICENSE has no later content change through the checked main.                                                                                                                | The standalone project was presented with an MIT grant. That fact alone does not prove authority to relicense every inherited portion.                                                                                                                 |
| Extracted original CLI        | Bootstrap HANDOFF identifies poker_blocks source `7579093` and unfinished native-dependency work as the extraction origin. At that exact source revision, [`LICENSE`](https://github.com/trebizondoculpepper/poker_blocks/blob/7579093/LICENSE) contains GPLv3 text. Its tree has no separate LICENSE/COPYING under `scripts/triage`; the package has no license field. | An inherited-license provenance question exists. A separate grant or rights-holder authorization could resolve it; its existence is not established by the checked files. A root license alone is not a conclusive legal classification of every file. |
| Source continuity             | Source files `scripts/triage/{briefing,compact,cli,github}.js` compared with bootstrap `src/` counterparts. All 211 source lines of compact.js and all 186 of cli.js occur as matching blocks; briefing has 474/550 source lines and github has 221/259.                                                                                                                | Supports HANDOFF's reported reuse rather than assuming the standalone tool was a clean-room rewrite. This is a text comparison, not a copyright/substantiality opinion.                                                                                |
| Subsequent first-party source | The standalone LICENSE remains MIT. A notice-keyword scan of tracked `src/`, `scripts/` and maintained executable examples found no additional explicit SPDX/copyright/license headers.                                                                                                                                                                                 | No contrary file-level notice was found by this bounded scan. It is not proof of every contributor's ownership, employment terms, omitted notices or source origin.                                                                                    |
| DataScript runtime            | Pinned 1.8.1, exact EPL-1.0 upstream license/notice verified in #787; runtime engine and worker import it. Lockfile records its version/integrity but no license field.                                                                                                                                                                                                 | Its own grant must be read from actual distribution/upstream notices; a metadata-only license scan would miss it. PDB cannot replace that grant by editing its own LICENSE.                                                                            |
| Other development tooling     | Lock metadata identifies lightningcss and platform variants as MPL-2.0 and dev-only.                                                                                                                                                                                                                                                                                    | No claim of a second shipped-runtime conflict is made. This was not a complete dependency/distribution audit; tools versus redistributed outputs must be checked in the eventual packaging audit.                                                      |
| Human routing / commit actors | CONTRIBUTORS.md routes the project to one human; agents share the authenticated GitHub identity.                                                                                                                                                                                                                                                                        | Neither routing nor a commit account proves copyright ownership or authority over another contributor's grant. No CLA, assignment or employment conclusion follows from those fields.                                                                  |

The original GPLv3 license file's SHA-256 is
`3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`.
The FSF copyright line in that document concerns the **license text**, not proof
that the FSF owns poker_blocks code. The source-tree response was complete
(`truncated: false`). No private identity files or account details were inspected.

## Existing permissions versus ownership

MIT already supplies broad use/modification/distribution/sublicensing permission
subject to its notices. Where a valid MIT grant covers a portion, do not invent a
requirement to obtain fresh consent merely because a future project grant differs.
Keep the MIT notice as required. The question is whether that grant was validly
available for the inherited source and whether any other applicable terms limit
the proposed combination.

For portions actually governed by GPL, the
[GNU FAQ's incompatible-library guidance](https://www.gnu.org/licenses/gpl-faq.html#GPLIncompatibleLibs)
distinguishes a copyright holder's additional permission from trying to grant an
exception for someone else's GPL code. The technical inventory cannot establish
an unrecorded separate grant. It also cannot disprove that the owner holds the
relevant rights and could document a valid relicensing/permission decision.

A project-side exception would not relicense DataScript: its EPL terms/notices
continue. The earlier report's Eclipse/GNU findings and EPL-2.0 secondary-license
qualification remain unchanged. No upstream permission was requested or assumed.

## Concrete remaining question

**Can the owner confirm the rights or permission under which the extracted
poker_blocks triage code was made available as MIT, including authority to grant
the proposed project-side additional permission if that path is selected?**

Useful evidence could be original authorship/ownership with any applicable
employment constraints resolved, a documented separate grant, or required
contributor permission. Do not request private legal records in a public issue;
a suitable public confirmation/reference can state the applicable authority and
scope. Existing grants should be used where sufficient, not replaced by an
invented demand for every contributor to sign again.

After that confirmation, the owner can select a scoped exception/permission path
or replacement. If authority is not established, the result stays unknown; do not
rewrite historical notices or silently declare old MIT archives invalid. Any
remedy/relicensing choice needs review on its actual facts.

## Small next steps

- Record the rights confirmation and selected path on #634. This is the useful
  human discussion, not reopening GPL-3.0-or-later or contributor naming.
- If a scoped exception is supported and selected, prepare its precise reviewed
  grant/notice/metadata changes as a separate S–M implementation ticket. Include
  the actual pinned DataScript combination and downstream notice obligations.
- If replacement is selected instead, use the earlier report's S feasibility
  spike before an L–XL migration; do not turn this inventory into an engine rewrite.
- A full release-package license/notice audit remains part of the chosen change,
  not an unsupported promise from this bounded metadata/source scan.

No further automated source scan can answer an unrecorded ownership/permission
fact. Research #840 can complete with this evidence table and unknown result;
#634 remains open for the actual decision. Existing releases/notices stay intact.
