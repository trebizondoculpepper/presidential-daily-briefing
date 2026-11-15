# Lean briefing row comparison (#352)

Offline presentation probe on five committed synthetic parity inputs, each replayed for both roles. The real native engine supplies the decisions and original why. The proposed renderer is an isolated row projection; no installed behavior changed.

## Method

Run from the repository root after npm ci:

```sh
npx vp pack scripts/compare-briefing-rows.ts --format esm --out-dir node_modules/.cache/pdb-lean-probe
node node_modules/.cache/pdb-lean-probe/compare-briefing-rows.mjs
```

The baseline is the actual compactText NEXT STEPS section, extracted before background sections. The proposal keeps the same ordered native actions, verbatim why, Next/Then commands and source URLs. It removes separate metrics/internal codes and zero-only summary text. Source inputs are the already committed parity fixtures, not a live repository snapshot.

Fixture SHA-256: `d4897b4bc2a0179167765097c48e420c7d3bdbd9d97d9ff00fd71db2c8f3b165`. Rules hash: `b652593e469c5f1e2e2307064916fd6362a36395f88b3ab0f57126636089c31c`.

The parity fixtures deliberately contain a supplied unlock sentinel 999 to test that the engine ignores supplied scores. The probe normalizes that presentation-only sentinel to zero for BOTH renderings, leaves the source graph unchanged, and asserts identical complete native results before and after normalization. Positive unlocks still come from actual native edge evidence. This avoids counting removal of a deliberately false test value as a prose improvement.

## Row-only results

| Role        | Before characters | Proposed characters | Reduction | Approximate tokens before/after |
| ----------- | ----------------: | ------------------: | --------: | ------------------------------: |
| implementer |              2970 |                2187 |     26.4% |                       742 / 547 |
| designer    |              1386 |                1026 |     26.0% |                       346 / 256 |

Character counts are Unicode code points. Token numbers are only the rough characters/4 heuristic, not output from an LLM tokenizer. These are aggregates over this small synthetic corpus, not a claimed production average or context-window guarantee. Two designer projections are empty under both renderings. One positive-unlock implementer case grows by one character because the useful count is retained explicitly.

## Implementer example

Before:

```text
NEXT STEPS (4)
- #1 Ticket 1 — implement (easy-win)
  impact L · complexity S · unlocks at least 0
  Why: Known easy win: impact L, complexity S.
  Next: pdb claim 1 --repo o/r --agent NAME
  https://github.com/o/r/issues/1
- #2 Ticket 2 — estimate-complexity (assessment, cross-role-boost)
  impact L · complexity unassessed · unlocks at least 0
  Why: High impact L, but effort is unassessed; estimate it to test implementation value.
  Next: pdb estimate 2 --metric complexity --size SIZE --rationale TEXT --repo o/r
  https://github.com/o/r/issues/2
- #2 Ticket 2 — implement (ordinary)
  impact L · complexity unassessed · unlocks at least 0
  Why: Eligible implementation: impact L (current), complexity unknown (unassessed).
  Next: pdb claim 2 --repo o/r --agent NAME
  https://github.com/o/r/issues/2
- #3 Ticket 3 — implement (unfavorable)
  impact S · complexity XL · unlocks at least 0
  Why: High effort for limited benefit: impact S, complexity XL; reconsider or split.
  Next: pdb claim 3 --repo o/r --agent NAME
  https://github.com/o/r/issues/3
- Complexity assessment: 1 eligible, 1 ranked, 1 shown; 0 conflicting. Guidance: pdb estimate --help
```

Proposed:

```text
NEXT STEPS (4)
1. Implement #1: Ticket 1
   Known easy win: impact L, complexity S.
   Next: pdb claim 1 --repo o/r --agent NAME
   https://github.com/o/r/issues/1
2. Estimate complexity #2: Ticket 2
   High impact L, but effort is unassessed; estimate it to test implementation value.
   Next: pdb estimate 2 --metric complexity --size SIZE --rationale TEXT --repo o/r
   https://github.com/o/r/issues/2
3. Implement #2: Ticket 2
   Eligible implementation: impact L (current), complexity unknown (unassessed).
   Next: pdb claim 2 --repo o/r --agent NAME
   https://github.com/o/r/issues/2
4. Implement #3: Ticket 3
   High effort for limited benefit: impact S, complexity XL; reconsider or split.
   Next: pdb claim 3 --repo o/r --agent NAME
   https://github.com/o/r/issues/3
```

## Designer example

Before:

```text
NEXT STEPS (3)
- #1 Ticket 1 — decide (designer-duty)
  Why: Resolve the recorded design decision before implementation proceeds.
  Next: pdb --repo o/r --issue 1 --json
  https://github.com/o/r/issues/1
- #2 Ticket 2 — assess-impact (assessment, cross-role-boost)
  impact unassessed · complexity S · unlocks at least 0
  Why: Complexity S is small, but benefit is unassessed; assess impact to test for an easy win.
  Next: pdb estimate 2 --metric impact --size SIZE --rationale TEXT --repo o/r
  https://github.com/o/r/issues/2
- #3 Ticket 3 — assess-impact (assessment)
  impact unassessed · complexity unassessed · unlocks at least 0
  Why: Benefit is unassessed; assess it before comparing implementation value.
  Next: pdb estimate 3 --metric impact --size SIZE --rationale TEXT --repo o/r
  https://github.com/o/r/issues/3
- Impact assessment: 2 eligible, 2 ranked, 2 shown; 0 conflicting, 0 invalid, 0 unknown. Guidance: pdb estimate --help --metric impact
```

Proposed:

```text
NEXT STEPS (3)
1. Decide #1: Ticket 1
   Resolve the recorded design decision before implementation proceeds.
   Next: pdb --repo o/r --issue 1 --json
   https://github.com/o/r/issues/1
2. Assess impact #2: Ticket 2
   Complexity S is small, but benefit is unassessed; assess impact to test for an easy win.
   Next: pdb estimate 2 --metric impact --size SIZE --rationale TEXT --repo o/r
   https://github.com/o/r/issues/2
3. Assess impact #3: Ticket 3
   Benefit is unassessed; assess it before comparing implementation value.
   Next: pdb estimate 3 --metric impact --size SIZE --rationale TEXT --repo o/r
   https://github.com/o/r/issues/3
```

## Coverage and limits

The corpus covers PR follow-up, easy wins, both assessment types, design decisions, inspection of unknown evidence, zero and positive native unlocks. Script assertions preserve every original why and command and prove the report is not mutated. The design additionally requires production tests for lower-bound/unknown unlocks, omissions, material warnings, both engines, explicit context and budgets; this row-only probe does not establish that full acceptance matrix.

No agent-comprehension, task-success, throughput or GitHub-request improvement was measured. The visible priority is ordinal order; no numeric priority score was invented. The repeated words can be removed without a separate prose explanation engine. See [the implementation contract](../design/lean-briefing-rows.md).
