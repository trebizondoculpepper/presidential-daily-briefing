# Slow tests: redundancy and faster coverage-preserving execution (#706)

Source SHA: `f26ab896816091f4ea61ba5610c7d0a3cfd3627b` (main, 20 November 2026). Research only: no test, CI job, policy or runtime behaviour changes here. The harnesses in [examples/slow-tests](examples/slow-tests/) are manual and local, use only the repository's scenarios and fixtures, and make no GitHub calls.

## Summary

The suite has slowed sharply since the ticket's baseline. On CI, `rules.test.ts` alone went from 131 s to 1157 s on Ubuntu and from 176 s to 1310 s on Windows between run 43942965450 (`8b593c0`, 16 November) and run 44758025037 (`f26ab89`, 20 November). The test jobs went from about 5 and 9 minutes to 27 and 32 minutes. Most of that time is one thing: full native policy evaluations, now about 250–300 ms each locally, repeated about 1,300 times by the role/kind metamorphic matrix and many more times by parity, process and MCP tests.

Recommendations, in priority order:

1. **Make each policy evaluation cheaper (engine; largest lever, uncertain size).** One family of decision queries re-derives the `foreground` rule in every query; it accounts for 44% of evaluation time across the scenario set. Materializing shared derived relations once per evaluation could cut every engine-bound test at once. This changes product code and needs its own ticket, a profile-backed prototype and the parity goldens as its oracle.
2. **Flip every subject's kind at once in the metamorphic matrix (test; −22% of the matrix, about −70 s locally).** Probes show detection in exactly the same scenarios as the current per-subject flip for all five injected guard faults.
3. **Share the evaluation in the `--max-chars` sweep (test; about −35 s of a 43 s file locally).** 76 end-to-end CLI runs evaluate the same snapshot; only rendering varies with the budget.
4. **Keep the role axis of the matrix and keep the matrix itself.** Scenario expectations and the static guard check miss guards that are present but ineffective; only the matrix's role axis detects those.

Rejected shortcuts: running only the scenario's own role (misses ineffective role guards that the static check also misses, see probes); mocking the engine in parity, process or MCP tests (removes the real-engine path); raising timeouts; dropping Windows.

## Measured starting point

Local full run, macOS, Apple silicon, Node 26, default parallelism: 399 s wall, 1063 s user, 534 MB peak RSS. Per-file wall time (files run in parallel, so these do not sum to wall time):

| File                               | Time  | Tests              |
| ---------------------------------- | ----- | ------------------ |
| `src/rules/datalog/rules.test.ts`  | 397 s | 344                |
| `src/rules/datalog/parity.test.ts` | 92 s  | 41                 |
| `src/briefing/process.test.ts`     | 44 s  | 10 (one case 38 s) |
| `src/acceptance/mcp.test.ts`       | 25 s  | 28                 |
| `src/serve/api.test.ts`            | 20 s  | 64                 |
| `src/acceptance/mcpparity.test.ts` | 16 s  | 19                 |
| `src/acceptance/mcpbudget.test.ts` | 15 s  | 31                 |

CI per-suite JUnit times (`test-reports-*` artifacts; suites overlap, so sums are not wall time):

| Suite               | Ubuntu 16 Nov | Ubuntu 20 Nov  | Windows 16 Nov | Windows 20 Nov |
| ------------------- | ------------- | -------------- | -------------- | -------------- |
| `rules.test.ts`     | 131 s         | 1157 s         | 176 s          | 1310 s         |
| `parity.test.ts`    | 43 s          | 190 s          | 58 s           | 230 s          |
| `process.test.ts`   | —             | 106 s          | —              | 122 s          |
| `mcpbudget.test.ts` | 50 s          | (not in top 6) | 75 s           | (not in top 6) |

Within `rules.test.ts` on CI Ubuntu, the metamorphic matrix ("every role and kind variant") took 105 s over 84 scenarios on 16 November and 933 s over 167 scenarios on 20 November. Scenarios doubled while matrix time grew 8.9×, so each scenario's matrix costs about 4.5× more. Over the same period the policy grew from 38 to 57 decisions and from 109 to 223 rule clauses. The MCP budget suite, a hotspot in the ticket, is no longer one: it fell out of the top six.

Locally, `rules.test.ts` divides as follows: matrix 329 s over 169 tests, scenario expectations 66 s over 167, runner categories 3 s.

## Inventory and fault models

| Hotspot                                 | What repeats                                                                                     | Distinct fault model                                                                                             | Verdict                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Scenario expectations (`rules.test.ts`) | One evaluation per scenario                                                                      | Each scenario's decisions, denials, order and explanations                                                       | Keep: distinct inputs                                    |
| Role/kind matrix (`rules.test.ts`)      | 3 roles × (1 + subjects) evaluations per scenario; 1,281 in total                                | A decision selected for the wrong role or subject kind (#469), including rules with no scenario for that variant | Keep the matrix; reshape the kind axis                   |
| Golden parity (`parity.test.ts`)        | Recorded inputs × roles × orders                                                                 | Any change in actions, order, denials, explanations and bindings                                                 | Keep: distinct oracles; cost falls with recommendation 1 |
| `--max-chars` sweep (`process.test.ts`) | 2 guide settings × 38 budgets, each a full CLI run with a native evaluation of the same snapshot | Output never exceeds the budget; essential text survives large budgets; truncation is marked                     | Share the evaluation for interior budgets                |
| MCP transport, parity and budget        | CLI vs MCP on the same inputs                                                                    | Framing, parity and section budgets                                                                              | No change recommended now; cost is evaluation-bound      |

## Experiment 1: cost of an evaluation

[`query-profile.ts`](examples/slow-tests/query-profile.ts) wraps `datascript.q` and `init_db` in its own process and evaluates every scenario once with its own viewer: 167 evaluations in 55 s, about 330 ms each, excluding the policy build's own validation queries. Each evaluation runs about 33 queries from a family that begins `(foreground ?t) [1 "role" ?role] [(not= ?role ...`. That family takes 44% of the time, and a second human-role family takes another 11.3%. `init_db` takes 2%. Datascript does not share rule results between queries, so `foreground` and related rules are recomputed for every decision query. That matches the #1123 note in `process.test.ts` that the engine "runs one query per decision and denial", whose cost grows with the policy.

Hypothesis, not measured: materializing `foreground` (and similar shared relations) once per evaluation, and transacting the result before the decision queries the way the engine already does for root relations, would cut evaluation time substantially. The size of the saving is uncertain until prototyped; the goldens and scenarios are the oracle.

## Experiment 2: matrix shapes

[`matrix-cost.ts`](examples/slow-tests/matrix-cost.ts) runs the same evaluations as the matrix under three shapes:

| Shape                               | Evaluations | Time  | Per evaluation |
| ----------------------------------- | ----------- | ----- | -------------- |
| Per subject (current)               | 1,281       | 326 s | 255 ms         |
| All subjects' kinds flipped at once | 1,002       | 248 s | 247 ms         |
| Scenario's own role only            | 427         | 141 s | 330 ms         |

## Experiment 3: retained detection under injected faults

[`guard-probes.ts`](examples/slow-tests/guard-probes.ts) weakens one guard in a decision rule in memory (through `buildPolicy`'s injected reader; no file changes). For each probe it reports:

- the textual static guard check in `rules.test.ts` ("guards each role-specific rule with its role in the policy");
- the scenario expectations;
- the scenarios in which each matrix shape fails, using the audience table pinned in `rules.test.ts` as the oracle, compared by scenario identity, not only by count.

Two probes delete a guard. Two keep the guard's text but make it ineffective (semantic faults): the role variable is bound to the subject kind instead of the viewer's role, or the human guard sits inside an `or` that any subject satisfies.

| Injected fault                                                             | Static guard check | Scenario expectations | Per subject (current) | All kinds at once   | Own role only |
| -------------------------------------------------------------------------- | ------------------ | --------------------- | --------------------- | ------------------- | ------------- |
| `D-COMPLEXITY` loses its issue-kind guard                                  | misses             | 0                     | 15                    | 15 (same scenarios) | 15 (same)     |
| `D-COMPLEXITY` loses its not-human role guard                              | detects            | 0                     | 15                    | 15 (same)           | 0             |
| `D-COMPLEXITY` keeps the not-human text, but it no longer tests the viewer | misses             | 0                     | 15                    | 15 (same)           | 0             |
| `D-HUMAN-ASK-YOU` loses its human role guard                               | detects            | 1                     | 4                     | 4 (same)            | 1             |
| `D-HUMAN-ASK-YOU` keeps the human text inside an always-true `or`          | misses             | 1                     | 4                     | 4 (same)            | 1             |

Findings:

- The static check catches a deleted role guard but not a kind-guard loss or a role guard that is present yet ineffective. The scenario expectations alone almost never notice any of these faults. Only the matrix detects all five, so it stays.
- Flipping all kinds at once detected every fault in exactly the same scenarios as the current per-subject flip, by scenario identity.
- Running only the scenario's own role missed both semantic role faults, which the static check also misses. It is rejected: the role axis is the only detector of those faults.

Limits: five probes on two rules. A fault that appears only when exactly one of several subjects changes kind could in principle be missed by flipping all at once; none was found here. The follow-up ticket should add a probe for an interaction-sensitive rule before adopting the change.

## Experiment 4: the `--max-chars` sweep

The 38 s case runs the CLI end to end 76 times (guide on or off × 38 budgets). By the comment in the test, each run takes about 0.5 s of native evaluation over the same snapshot. Budget handling is in rendering, so evaluating once and rendering many budgets keeps the oracle (length ≤ budget, essential text above 350 characters, a truncation marker below). Recommendation: keep the boundary budgets (1, 2, 12, 31, 80, 175, 349, 350 and the largest) end to end, and sweep the interior budgets through the shared renderer with one evaluation. The truncation and budget faults are rendering faults, so the reduced sweep still exercises them; the end-to-end boundary runs keep the CLI path. Not measured beyond the arithmetic (about 65 of 76 runs saved, roughly 35 s locally and 90–100 s on CI); the follow-up should measure it.

## Follow-up tickets (small, independently reviewable)

1. **Engine: materialize shared derived relations per evaluation** (product, policy-preserving). Profile, prototype `foreground` materialization, and show identical parity goldens and scenarios with before and after timings. Expected to be the largest saving across `rules`, `parity`, `process` and MCP tests. Needs reviewed design per the architecture rules, since it touches the engine.
2. **Test: flip all subject kinds at once in the role/kind matrix.** About −22% of the matrix. Add an interaction-sensitive probe scenario first.
3. **Test: share one evaluation across the `--max-chars` interior budgets.** Keep the boundary budgets end to end.
4. **Watch: per-file CI timings.** Track the JUnit per-suite times already uploaded as artifacts, so growth like the 8.9× matrix increase is visible in review rather than through timeouts. Reporting only, not a timing gate.

## Reproduce

```
npx tsx doc/reports/examples/slow-tests/query-profile.ts
npx tsx doc/reports/examples/slow-tests/matrix-cost.ts        # about 12 minutes
npx tsx doc/reports/examples/slow-tests/guard-probes.ts role-agents   # also kind-issue, role-human; about 15 minutes each
```
