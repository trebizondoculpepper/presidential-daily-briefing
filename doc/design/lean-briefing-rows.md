# Lean rows for the designer and implementer queues

Contract for #352, following `next-steps-only.md` (#353/#355). This changes text
presentation, not ranking, authority, JSON schemas or the rules' explanations.
The comparison in `../reports/lean-briefing-row-comparison.md` uses fixed public
synthetic inputs and the real native engine. No runtime renderer changes here.

## Default row

After the small repository/role header, keep one ranked list:

```text
1. Estimate complexity #12: Example feature
   High impact L, but effort is unassessed; estimate it to test implementation value.
   Next: pdb estimate 12 --metric complexity --size SIZE --rationale TEXT --repo owner/repo
   https://github.com/owner/repo/issues/12
```

The number is the displayed ordinal rank, not a scalar priority score. The current
engine produces lexicographic bands/keys and T-shirt categories, not a calibrated
numeric value. Do not print a made-up arithmetic score or divide impact by complexity.
For additional pages retain the correct ordinal offset only when that offset is
actually known; otherwise label a bounded subset, not a false global rank.

Use a short action label, ticket/PR identity and title, exactly one existing matched
why, the existing `Next`/`Then` commands when present, and one focused source link.
Claim commands apply only to actions that require a claim; an estimate or inspection
does not acquire ownership. Keep commands verbatim, including repository targeting:
copying them from a page or another working directory must not change the target.
Do not shorten a command by silently relying on the reader's current checkout.

Presentation labels may turn `estimate-complexity` into "Estimate complexity" and
`pr-follow-up` into "Follow up PR"; they must not rewrite the engine's rationale.
If a why is unavailable, preserve the actual inspection/error path rather than
manufacture a TypeScript explanation. Improve Datalog wording in the native rule
artifact separately, with its scenario tests. Rollback text keeps its existing
evidenced reason; it is not silently narrated as a Datalog result.

## Remove repetition, preserve meaning

- Omit the separate impact/complexity line in default rows. A reason such as
  "Known easy win: impact L, complexity S" already conveys the useful information.
  The full metric/provenance objects remain in JSON and focused/explicit context.
- Omit internal band/preference/reason-code lists from default prose. Preserve
  rule IDs, bindings, denials and override evidence in structured/detail output.
- Never print "unlocks at least 0" as routine row decoration. Positive proven
  utility may be shown tersely from the native decision's actual `unlocks` and
  `unlocksUnknown`, not an obsolete independently supplied score. Exact counts and
  lower bounds stay distinct. Unknown impact that matters to interpreting the
  action remains visible; zero observed unlocks with incomplete evidence is not
  proof of no impact. A shared coverage notice can name affected rows once.
- Drop zero-only impact/complexity queue counters and generic guidance repeated
  after the same to-do list. Retain conflicts, invalid/stale/unverified evidence
  and disabled/unreadable settings when they materially affect recommendations.
  State shared warnings once with focused links instead of repeating boilerplate.
- Hide empty sections and repeated generic pickup/history caveats by default.
  Background is already opt-in under #355; do not duplicate that implementation.

Do not remove eligibility restrictions, missing platform/identity, trust uncertainty,
offline/stale observations, incomplete collection or nonzero omissions merely to
meet a size target. Keep the material source warning even when rows are pruned.
Use source-provided omission counts; if warning display is bounded, count the
remaining warnings too. No fake "all clear" from an incomplete empty list.

The default remains a shortlist. `--context`/MCP `context: true` provide the reviewed
expanded compact view, including useful assessment/engine detail. Existing `--issue`,
`ticket`, `pr`, `deps`, `--full`, `--estimate`, `--guide` and help retain their own
documented scope. Preserve schemas and structured evidence; this slice does not
delete fields to shrink MCP JSON. Bounded structured results are a separate contract.

## Budgets and cross-surface behavior

Use one shared CLI/MCP text projection for both roles and both engines. HTTP and
the dashboard should consume the same ranked model, but their native HTML layout
is not a reason to add another ranker or prose explainer. Text budget truncation
states "Truncated due to maximum size" per #379, preferably retaining whole useful
rows and a supported detail/limit command when it fits. No false minimum-size error
or undocumented command. User-supplied titles/comments never become instructions.

Do not change top-ten selection, action kinds, eligibility, commands, provenance,
freshness or completion checks. A presentation comparison is not evidence that
agents follow the instructions better; it only measures the text and retained data.
No tokenizer-based budget claim is made without a specified tokenizer.

## Implementation and acceptance

Implement lean rows after #355's default/context split to avoid parallel competing
edits to the same renderer. Keep this as a focused follow-up rather than expanding
the already-ready #355 implementation. Reuse `scripts/compare-briefing-rows.ts` for
the documented presentation probe; its proposed projection is not production code.

Fixtures cover both roles/engines, PR follow-up, easy wins, assessments, inspection,
unknown evidence, exact/positive/lower-bound/zero unlocks, omissions and tiny budgets.
Assert identical action identities/order, original why, supported commands, links
and unchanged structured reports. Verify default text suppresses redundant fields,
expanded/focused context still exposes them, and material warnings survive. Include
CLI/MCP text parity and packaged command checks. Request/collection savings are
not implied by fewer output characters; profile work is separate.
