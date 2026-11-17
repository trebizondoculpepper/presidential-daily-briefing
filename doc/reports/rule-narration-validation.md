# Rule-attached narration validation (#578)

The Rules page now reads literal purposes from the native artifact. All 38 built-in
decisions and nine denials have a purpose; there is no runtime model call or second
matching engine. The formal compiler still supplies expandable conditions,
priority, overrides and evidence. Predicates, queries and the operational-policy
limitations remain visible. Coverage and missing-purpose fallbacks are explicit.

Representative source-to-page examples:

| Rule               | Authored purpose                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------- |
| D-ATTENTION        | Bring work explicitly addressed to this agent to the front of its queue.                  |
| D-PR-FAIL          | Prioritize repairing failed PR checks before the change can progress toward merge.        |
| D-EASY             | Prefer known high-impact, low-effort opportunities when ordering work by impact.          |
| D-COMPLEXITY-BOOST | Prioritize estimating effort when known high impact could make the work valuable.         |
| D-INSPECT          | Show work needing eligibility or platform evidence without declaring it ready for pickup. |

Stable IDs bind these purposes to the generated conditions. Tests cover both agent
roles, represented human rules, filtered views, future rule IDs, old artifacts
without purposes, malformed/duplicate/unknown metadata and escaped HTML, URLs and
template-like strings. Generic purposes do not interpolate ticket witnesses.

## Compatibility

Bundled `rulesHash` remains
`017d781821f07a45492b8aff30d69cfc06d33dcbc938f86465c0a1c3301eb0a8`.
Only the new purpose fields are excluded from its legacy inputs; existing why,
witness and lexicon fields still count. The independent narration revision binds
purposes and gaps to that hash. Mixed revisions are rejected. The formal CLI
listing was compared byte-for-byte with the pre-implementation listing: identical.
All 99 existing Datalog scenarios pass; decision goldens are unchanged.

Project v1 remains closed to `:purpose`, with independently captured pre-change
project and effective hashes checked in regression tests. Explicit format v2
allows optional literal purposes, retains projection 1 and identical executable
queries, and includes purposes in the project source/effective identities. The
starter remains v1; no configuration is migrated or written. The page reports
actual source format and revision, effective settings and unavailable states.

## Browser check

Isolated headless Chrome 157.0.8103.79 rendered all 47 cards at 1280 × 900 and
320 × 800 without horizontal overflow. Native keyboard Enter expanded and collapsed
the first formal section; Tab moved to the next summary. The purpose revision
initially exposed overflow at 320 pixels; the identity list now stacks at narrow
widths, and both viewport checks pass after that correction.

[Wide capture](assets/578-rules/wide.png) · [Narrow capture](assets/578-rules/narrow.png).
These checks establish browser layout and native keyboard interaction only.
VoiceOver testing remains deferred to #719 at the owner's request.

The separate model-comprehension question remains #579, with frozen predictions
against the real engine oracle required before claiming understanding. This
implementation performs no paid evaluation and does not change its budget.

The first package check exposed a new bundler-shared formal-renderer chunk omitted
from the npm allowlist. Added that specific chunk family and extended the existing
import-graph package assertion, so installed CLI/MCP artifacts carry their formal
renderer dependencies and missing chunks fail before invocation.

The repaired installed-package validation passed, including native adapter
invocation, actual project workers, CLI/MCP parity for both roles and ordering
modes, and the TypeScript rollback engine. The format-2 evaluation regression
checks real worker admission, identical action order/reasons and the actual
format/revision manifest.

Final local validation: check passed with zero errors and 54 existing warnings;
145 test files passed, 2,670 tests passed and one was skipped. Build, smoke and
installed-package validation passed. The import-cycle guard passes without new
exceptions; CLI and page share pure functions in the existing English renderer.
