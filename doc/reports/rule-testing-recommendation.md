# Testing the workflow rules: recommendation

Date: 2026-11-14. Source: `34110ed` (policy 1, DataScript 1.8.1, Vitest 5.1.0 via Vite+ 1.5.0). Tracking: #336. Informs #348, #339, #340 and #394.

## Outcome

**Recommendation:** write rule tests as native EDN scenario files and run them with a small TypeScript runner hosted inside the existing Vitest suite. Make the runner raise two distinct error classes: `RuleDecisionFailure` for a wrong decision, and `RuleInfrastructureError` for an unreadable file, an invalid scenario or a failing evaluator. Keep the existing TypeScript scenario tests until equivalent EDN scenarios replace them.

No existing framework fits. Upstream DataScript tests itself with Clojure's `clojure.test` plus a hand-written JavaScript assertion harness. It ships no Datalog-native test facility and no way to run test definitions from Node. PlUnit is a sound reference if real Prolog is ever adopted, but it is not applicable to DataScript.

A runnable example ([`examples/rule-testing/`](examples/rule-testing/)) shows the approach working against the real evaluator. It has seven native EDN scenarios, outcome-category self-tests and a metamorphic property: 20 tests in all. It caught two hand-made policy mutations as rule failures and one syntax break as an infrastructure error.

This was a bounded research pass of about 45 minutes of agent time. It does not implement #348's rules component, a rules-only command, CI reporting (#394) or a coverage gate.

## The questions

### 1. Host runner, engine facility, or both?

**Both, with a thin seam.** The definitions should be native EDN, which the owner requires and which matches how rules are written. Execution should stay in the host Vitest runner. The evidence:

- DataScript's own suite is Clojure: one `clojure.test` namespace per area (`query_rules.cljc`, `query_not.cljc`, `query_or.cljc` and so on), each using `deftest`, `is` and `testing` around `d/q` calls. Its JavaScript API is tested by `test/js/tests.js`, a hand-written harness with `assert_eq`, `assert_eq_set` and `assert_throws` and its own pass/fail counters, driven by `script/test_js.js`, which exits 1 on failure. ([test directory](https://github.com/tonsky/datascript/tree/master/test/datascript/test), [JS harness](https://github.com/tonsky/datascript/blob/master/test/js/tests.js), [JS driver](https://github.com/tonsky/datascript/blob/master/script/test_js.js))
- Neither form is usable as-is. `clojure.test` would add a JVM/Clojure toolchain to a project whose runtime is Node built-ins plus `gh`. The JS harness reports only counts: it has no locations, no categories and no JUnit output.
- The pinned npm package exposes `q`, `init_db`, `create_conn`, `transact` and `db` (see `src/rules/datalog/datascript.d.ts`). It does not expose its EDN reader, so the scenario files need a separate parser.
- DataScript itself makes the categories easy to tell apart. A malformed query throws (`Unexpected EOF while reading item 2 of vector`), and so does an unknown rule (`Unknown rule 'nope in (nope ?x)`). The runner can therefore classify evaluator exceptions as infrastructure, not as wrong decisions.

Hosting inside Vitest is what makes the owner's reporting requirement cheap. Each scenario becomes one Vitest test named `<scenario-id> (<file>:<line>)`. Vitest already provides the JUnit reporter, exit codes and the existing `verify` semantics.

### 2. Real Prolog later: PlUnit

[PlUnit](<https://www.swi-prolog.org/pldoc/doc_for?object=section(%27packages/plunit.html%27)>) is the established choice:

- Tests are `test/1` and `test/2` clauses inside `begin_tests/1` and `end_tests/1`.
- `test/2` options express the expected result directly: `true(Answer == Value)`, `fail`, `throws(Error)`, `all(...)` and `set(...)` for multiple solutions, `forall(Generator)` for table-driven cases, plus `setup` and `cleanup`.
- `swipl -g run_tests -t halt file.pl` exits 0 on success and 1 on failure.
- `set_test_options/1` controls output (`format(log)`, `output(on_failure)`, `timeout`, `jobs`).

Its trade-offs for this project:

- It is SWI-Prolog first: the page says it also runs on SICStus, but coverage analysis is SWI-only.
- It requires a native `swipl` runtime outside npm.
- The page does not document JUnit XML output, so CI visibility would need its own adapter.

PlUnit's option vocabulary is a useful design reference for the EDN expectation keys. It is not a reason to change engines; the owner has also ruled out switching to Prolog for editor support.

### 3. Isolating the layers

| Layer                 | What it proves                                                       | Where                                                     | Failure means                              |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Pure rule scenarios   | Facts in → decisions, denials, order, rule IDs and bindings out      | Native EDN under `src/rules/datalog/`, rules-only command | A rule is wrong (`RuleDecisionFailure`)    |
| Rule infrastructure   | Sources parse, scenarios validate, the evaluator runs                | Same runner, before and around each scenario              | Infrastructure (`RuleInfrastructureError`) |
| Fact adapter          | Snapshot → datoms is faithful (missing stays missing, pages, owners) | TypeScript tests beside the adapter (#339)                | Host integration                           |
| Explanation rendering | Bindings → text, commands, truncation                                | TypeScript tests beside the rendering code                | Host integration                           |
| CLI/MCP and live      | Surfaces agree, exit codes, real `gh`                                | `acceptance/` (#335), live trials                         | Host integration                           |

The pure layer needs #348's typed facts-in boundary. Until it exists, the example's scenarios describe compact host facts, and a small adapter (`snapshotOf`) turns them into the snapshot the evaluator reads today. That adapter belongs to the host layer. Once #348 lands, scenario `:given` blocks should become the boundary's facts directly, so adapter bugs cannot hide or cause rule failures.

### 4. Meaningful rule coverage

JavaScript line coverage of `datalog.ts` says almost nothing about the rules: all of the policy is data, passed as strings to one `ds.q` call. Measure coverage in the rules' own terms:

- **Rule-ID coverage.** Every decision rule must appear in at least one scenario as a winner and, where it can lose, as an overridden rule. Every denial ID must appear as an asserted denial. This is mechanical to check from the scenario files against `definitions` and the denial clauses.
- **Exhaustive expectations.** `:actions` lists every action in order, and `:denials` is the exact set. An extra, missing or reordered action fails, so a scenario cannot pass by checking only the one action it was written for.
- **Scenario tables for the hard distinctions:** missing versus false evidence, competing priorities, conflicting labels or owners, platform restrictions, dependency counts, and duplicate-action prevention.
- **Metamorphic properties.** Some transformations of the facts should leave decisions unchanged. The example checks one: adding an unrelated parked ticket must not change any other subject's actions. Renumbering subjects, or reordering facts within a snapshot, are cheap further properties.
- **Small mutation checks.** Change one rule (a band, a removed denial clause) and confirm a scenario fails. The example did this by hand (below). Doing it automatically needs the evaluator to accept the policy artifact as input, which belongs in #348's boundary.

## The runnable example

[`examples/rule-testing/`](examples/rule-testing/) runs with the normal suite (`npm test`), or alone:

```sh
npx vp test run doc/reports/examples/rule-testing
```

- [`scenarios.edn`](examples/rule-testing/scenarios.edn) has seven native EDN scenarios covering every example the ticket requires. Each gives `:given` facts (role, agent, platform, issues with labels, sizes and blocks) and an exhaustive `:expect`:

  ```edn
  {:id :missing-versus-false-evidence
   :given {:role :implementer
           :issues [{:n 1 :labels ["status:ready" "question"] :impact "M" :complexity "M"}
                    {:n 2 :labels-complete false :impact "M" :complexity "M"}]}
   :expect {:actions [{:n 2 :kind :inspect :rule "D-INSPECT" :band 6
                       :facts {:labelsComplete false :uncertainty "labels incomplete"}}]
            :denials #{[1 "D-DENY-PREREQUISITE"]
                       [2 "D-DENY-LABELS-UNKNOWN"]
                       [2 "D-DENY-PLATFORM"]}}}
  ```

  A known `question` label is a definite denial. An unread label page is not treated as "no labels": it denies pickup as unknown and produces an inspection action carrying the reason.

- [`runner.ts`](examples/rule-testing/runner.ts) validates the file and runs the real `evaluateDatalog` with a fixed clock and no GitHub access. It reports every mismatch in a scenario at once, and checks the one-action-per-subject-and-kind invariant on every scenario.
- [`edn.ts`](examples/rule-testing/edn.ts) is a minimal EDN-subset reader that records each map's source line. A production runner should use a maintained parser instead. [`edn-data`](https://github.com/jorinvo/edn-data) (MIT, no dependencies, active) returns plain JS data but no source positions. A scenario's line can then be recovered from its unique `:id`, which the runner already requires.
- [`rule-testing.test.ts`](examples/rule-testing/rule-testing.test.ts) contains:
  - one test per scenario, named `id (file:line)`;
  - self-tests showing that a wrong expectation is a `RuleDecisionFailure`, and that broken EDN, an unsupported role, a duplicate ID, a malformed optional field (such as `:facts` that is not a map), a dependency on an absent issue or an unsupported string escape is a `RuleInfrastructureError`. A present but malformed expectation is never silently skipped;
  - the metamorphic property, run over every scenario.

**Mutation results**, each made temporarily in `src/rules/datalog/policy.ts` and then reverted:

| Mutation                              | Result                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `D-EASY` band 4 → 6                   | 1 test failed: `competing-assessment-priorities (scenarios.edn:12)`, `RuleDecisionFailure`                       |
| Platform denial clause removed        | 2 failed: `missing-versus-false-evidence (:29)`, `platform-mismatch (:48)`, both `RuleDecisionFailure`           |
| Unbalanced bracket in a denial clause | 14 tests `RuleInfrastructureError` ("Unmatched delimiter ]"), plus the self-test that expects a decision failure |

**Reporting finding for #394.** Vitest 5.1.0's JUnit reporter writes every failing test as `<failure>` and always reports `errors="0"`, even for a thrown non-assertion error or a module that failed to load. The category survives only in the `type` attribute (`type="RuleDecisionFailure"` versus `type="RuleInfrastructureError"`, measured with `--reporter=junit`). A summary for #394 must therefore classify by `type`, never by the `<failure>`/`<error>` element. A missing report must still count as failure.

## Coverage gaps in the current tests

The existing rules tests (`src/rules/datalog/datalog.test.ts`, `assessment-priority.test.ts`) mostly assert kinds, bands and order. Searching all of `src/**/*.test.ts` for each rule's quoted ID:

- 31 rule and denial IDs exist in policy 1. Only 2 (`D-EASY`, `D-PR-REVIEW`) are named in the rules tests, and 3 (adding `D-PR-INTEGRATE`) are named anywhere in `src/` tests.
- No denial ID is asserted anywhere, although the evaluator returns them in `decisionEngine.denials`.
- Never named by ID: `D-BAD-COMPLEXITY`, `D-BAD-IMPACT`, `D-DECIDE`, `D-DESIGN`, `D-DESIGN-REVIEW`, `D-DOCUMENT`, `D-IMPACT`, `D-IMPACT-BOOST`, `D-OWN-EASY`, `D-OWN-UNFAVORABLE`, `D-PR-CONFLICT`, `D-PR-FAIL`, `D-PR-MERGE`, `D-DENY-CLOSING-UNKNOWN`, `D-DENY-NATIVE-UNKNOWN` and `D-DENY-OPEN-PR`. The example names twelve further IDs, but none of these.

This counts literal IDs only. A rule can be exercised indirectly through its kind and band, so the true gap is smaller than the list suggests. Still, without an ID assertion, a change in which rule wins (for example `D-OWN-EASY` instead of `D-OWN`, both in band 6) can go unnoticed, and so can a wrong overridden-rule list.

Two other observations:

- A ticket with two `agent:` labels gives one of the listed owners `continue-implementation` (`D-OWN`) while denying everyone else pickup (`D-DENY-CLAIM`). The example records this as current behaviour. Whether a listed owner should be told to resolve the duplicate ownership first is a policy question, not a test result.
- The rule tests build fixtures through the full TypeScript `Snapshot` shape, so they also exercise the adapter. A fixture mistake there looks like a rule failure. The layering above separates them.

## Placement and the source layout (#335, #348)

The rules component's native sources and their scenario files belong together under `src/rules/datalog/`, for example `policy/*.edn` beside `scenarios/*.edn`. The runner and its colocated test belong there too, as `src/rules/datalog/scenarios.test.ts`. This keeps stage 3 of #335 unaffected: its `rules/datalog/` rows only move existing tests.

A rules-only command can then be `vp test run src/rules/datalog`, which starts no PDB process, does no GitHub collection and runs no other tests. That is the same assertion path CI uses, as `doc/design/local-service-and-rule-testing.md` requires. The example stays under `doc/reports/examples/` as research and should not be imported by `src/`.

## Follow-up

These fit existing tickets; no new ticket is needed yet:

- **#348:**
  - Make the evaluator accept the policy artifact as an input alongside the facts. That enables automatic rule mutation tests.
  - Make scenario `:given` blocks boundary facts, not host-snapshot fixtures.
  - Use a maintained EDN parser, with `:id`-based source lines.
  - Keep the two error classes.
- **#340:**
  - Use the rule-ID coverage measure above as the audit's metric.
  - Add scenarios for the 16 never-named IDs, starting with `D-OWN-EASY` versus `D-OWN` and the three `UNKNOWN`/`OPEN-PR` denials.
  - Assert denials in every scenario.
- **#339:**
  - Test the fact adapter on its own (missing versus false, pagination, owners, platforms), so adapter faults stop surfacing as rule failures.
- **#394:**
  - Classify by the JUnit `type` attribute, since Vitest reports `errors="0"` regardless.
  - Name tests `id (file:line)`, as the example does, so annotations point at the EDN source.

Port the existing TypeScript rule scenarios to EDN only once #348's runner exists. Keep both suites until the EDN suite covers at least everything the TypeScript suite asserts.
