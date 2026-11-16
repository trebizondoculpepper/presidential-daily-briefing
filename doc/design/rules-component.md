# Rules component: native EDN sources, build and test boundary

Status: architecture contract for #348. All migration steps are implemented: the policy lives in `src/rules/datalog/policy/*.edn` and `policy.ts` is gone. The inventory below describes the code before extraction. Implementation follows in the small PRs listed under "Migration plan". It refines, and does not replace, the owner decisions in [local service and isolated rule testing](local-service-and-rule-testing.md) and the engine contract in [Datalog decisions and explanations](datalog-live-experiment.md). Source placement follows [source layout by capability](source-layout.md) (#335).

## Summary

- The DataScript policy moves out of TypeScript strings into native EDN files under `src/rules/datalog/`. EDN is the only maintained source.
- `npm run rules:build` reads, validates and bundles those files into one JSON policy artifact. This is parsing and bundling. DataScript has no ahead-of-time compiler, and nothing here claims one.
- The engine exposes one typed, deterministic function: normalized facts in, decisions and explanations out. Collecting from GitHub, authentication, configuration and rendering stay outside it.
- Rule tests are written in EDN beside the policy. `npm run rules:test` runs them with a small TypeScript runner. That command does not start PDB or GitHub collection, and it does not run the application tests.
- The extraction is behaviour-preserving. A golden parity suite, captured before anything moves, must show identical actions, order, denials and explanations after every PR.

## Inventory (at `c1e56fb`)

Everything lives in `src/rules/datalog/`. The policy is in `policy.ts` (523 lines) and the evaluator in `datalog.ts` (462 lines).

| What                               | Where today                                                                                               | Count                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Decision rules                     | `definitions` in `policy.ts`, each a TypeScript record holding an EDN clause string                       | 23 (IDs `D-ATTENTION` … `D-INSPECT`)                           |
| Explanation templates              | `why` field of each decision rule                                                                         | 23, one per rule                                               |
| Reason codes                       | `codes` field of each decision rule                                                                       | 15 distinct                                                    |
| Derived-predicate rule clauses     | `clauses` template string                                                                                 | 76 clauses defining 48 named predicates                        |
| Ordering rule clauses              | `sortClauses` template string                                                                             | 9 clauses defining 4 predicates                                |
| Ordering descriptor                | `comparison` array                                                                                        | 11 sort keys                                                   |
| Queries in `policy.ts`             | `queries` (q0–q7), `keyQueries`, `unknownUnlocks`, `activeDependents`, `denialsQuery`, `otherClaimsQuery` | 16                                                             |
| Queries embedded in `datalog.ts`   | lines 305 and 373 build a query by string interpolation; lines 334 and 337 are literal queries            | 4                                                              |
| Witness (evidence-binding) clauses | `commonWitnesses`, `eligibilityWitnesses`, `witnessClauses`                                               | 27 (6 common, 4 eligibility, 17 rule-specific across 11 rules) |
| Constant sets                      | `constants` (one, `readiness`, is appended after the literal)                                             | 13                                                             |
| Cardinality-many schema attributes | `schema`                                                                                                  | 20, plus every constant set                                    |
| Command templates and kinds        | `commandTemplates`, `commandKinds`                                                                        | 6 templates, 11 kind mappings                                  |
| Rule tests                         | `datalog.test.ts` (18 tests) and `assessment-priority.test.ts` (8 tests, from #356 via PR #375)           | 26, all in TypeScript, all going through `Snapshot`            |

All of it is EDN text inside TypeScript strings. `rulesHash` is `sha256(JSON.stringify(artifact))` over an object made from those exports (`datalog.ts` line 96). It is shown in the text header (first 12 characters) and in `decisionEngine` metadata. Nothing persists it.

The only consumer is `src/service.ts`, which lazily imports `rules/datalog/datalog.js`. The build turns that into the single `dist/datalog-*.mjs` chunk that `scripts/package-test.ts` requires. `scripts/datalog-trial.ts` imports `evaluateDatalog` directly.

## Component boundary

The component is everything under `src/rules/datalog/` except the adapter:

| Part                   | Path (target)                             | Role                                                                        |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Policy sources         | `src/rules/datalog/policy/*.edn`          | The rules, queries, decision metadata and explanations. Source of truth     |
| Rule tests             | `src/rules/datalog/tests/*.edn`           | Native test definitions                                                     |
| Build                  | `src/rules/datalog/build.ts`              | Read, validate and bundle                                                   |
| Bundled artifact       | `src/rules/datalog/policy.generated.json` | Output of the build; the only thing the engine loads                        |
| Engine                 | `src/rules/datalog/engine.ts`             | `evaluatePolicy(facts, options)`. Pure and synchronous                      |
| Test runner            | `src/rules/datalog/runner.ts`             | Executes the EDN tests                                                      |
| Type shim              | `src/rules/datalog/datascript.d.ts`       | Unchanged                                                                   |
| Host adapter (outside) | `src/rules/datalog/adapter.ts`            | `Snapshot` + assessments + viewer → `PolicyFacts`; result → `RankedActions` |

`datalog.ts` remains as a re-export of the adapter so the lazily loaded chunk keeps its `dist/datalog-*.mjs` name; `service.ts`, the tests and `scripts/datalog-trial.ts` import it unchanged. The adapter sits in the same directory so the move stays local, but it is host integration rather than part of the component. Rule tests never import it. Only the adapter and `service.ts` import `github/types.ts`, `assessments.ts`, `blended.ts` or `ranking.ts`. The engine, build and runner import none of them, and a test enforces this.

### Public interface

```ts
/** Normalized, already-collected facts. No GitHub objects, URLs only as opaque strings. */
interface PolicyFacts {
  viewer: {
    agent: string | null;
    role: "implementer" | "designer";
    platform: string;
    order: "impact" | "oldest" | "newest";
  };
  complete: { forwardClosing: boolean };
  subjects: PolicySubject[]; // issues and PRs as attribute → value(s) records, stable numeric ids
}
interface PolicyDecision {
  subject: number;
  ruleId: string;
  kind: string;
  band: number;
  keys: (string | number)[]; // emitted sort keys, in `comparison` order
  why: {
    text: string;
    ruleIds: string[];
    facts: Record<string, string | number | boolean>;
    overriddenRuleIds: string[];
  };
  codes: string[];
}
interface PolicyResult {
  policyVersion: number;
  rulesHash: string;
  decisions: PolicyDecision[]; // already ordered by the fixed comparator
  denials: { subject: number; ruleId: string }[];
  unlocks: { subject: number; count: number | null; unknown: string[] }[];
  coverage: { subjects: number; datoms: number };
  diagnostics: string[];
}
function evaluatePolicy(
  facts: PolicyFacts,
  options?: { signal?: AbortSignal; now?: () => number },
): PolicyResult;
```

The exact field list is fixed in the PR that splits the adapter (step 5), and that PR must not change behaviour. These rules hold from the start:

- Deterministic. The same facts and bundle give byte-identical JSON output. Witness values are sorted, ties fall back to the subject number and then the rule ID, and nothing reads the wall clock, environment, filesystem or network. `now` exists only for the soft time-budget diagnostic, which stays outside the decision fields.
- Facts stay raw, as the engine contract requires. The adapter supplies no preselected kinds, eligibility verdicts or ranks. Known-false and unknown remain distinct: completeness flags travel with the facts.
- Errors are `DatalogError` codes, as now: `unsupported-role`, `experimental-scope-exceeded` and `invalid-inference`. The 500-subject and 50,000-datom limits stay in the engine.
- Command text (`pdb claim …`) is rendering. `commandTemplates` and `commandKinds` moved out of the policy into `commands.ts` in step 3, and they move into the adapter in step 5. The engine returns the rule's `kind`, and the host maps that to a command.

## Native file format

### Dialect

The files are EDN read by DataScript 1.8.1's own reader, and the dialect is DataScript Datalog. It is not Datomic Datalog and it is not Prolog. What DataScript actually accepts was checked against its source and the installed package on 2026-11-14:

- `datascript.js` `q` passes the query string to `cljs.reader/read-string` (`src/datascript/js.cljs`, tag 1.8.1, lines 87–90: <https://github.com/tonsky/datascript/blob/1.8.1/src/datascript/js.cljs>, accessed 2026-11-14).
- A rules argument given as a string goes through `edn/read-string` in `parse-rules` (`src/datascript/query.cljc`, tag 1.8.1, lines 189–190: <https://github.com/tonsky/datascript/blob/1.8.1/src/datascript/query.cljc>, accessed 2026-11-14). The comment there says it exists "for datascript.js interop".
- Probing the installed `datascript@1.8.1` showed that `;` comments, `#_` discard, keywords, sets, map-form queries, namespaced rule names and `#inst` all read correctly.
- Two traps came out of the same probe:
  1. `read-string` reads **only the first form**. A second top-level form in the same string is silently ignored. The build must therefore reject any file that does not contain exactly one top-level form.
  2. Keyword attributes in datoms supplied from JavaScript fail at query time (`Cannot compare :a/b to :a/b`). The policy already uses string attributes such as `"kind"` and `"label"`, and it keeps doing so.

The upstream project has no separate JavaScript language reference for queries. The Clojure documentation for DataScript and Datomic queries is the reference for syntax, and the installed version's behaviour is the authority.

### Files

Each file holds exactly one top-level EDN form:

| File                   | Form                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/rules.edn`     | Vector of rule clauses: today's `clauses`                                                                                                                                                                         |
| `policy/ordering.edn`  | Map: `:overrides` (declared winner/loser precedence exceptions, #416), `:comparison` (vector of key names) and `:rules` (today's `sortClauses`)                                                                   |
| `policy/queries.edn`   | Map from query keyword to query form: q0–q7, the key queries, the named queries and the 4 now embedded in `datalog.ts`                                                                                            |
| `policy/decisions.edn` | Vector of decision maps (below)                                                                                                                                                                                   |
| `policy/schema.edn`    | Map: `:policy-version`, `:many` (cardinality-many attributes), `:constants` (name → vector), `:common-witnesses`, `:eligibility-witnesses`, `:lexicon` (input attribute and viewer phrases for `pdb rules`, #416) |

The two queries that are built by string interpolation today become parameterised forms. The per-rule match query takes the rule's `:when` clauses, and the witness query takes a witness clause. The build splices these structurally and checks the result reads back as one form, so no runtime string concatenation of user-visible policy remains.

### Editor support

Native `.edn` is the format whatever the editor support turns out to be. The owner recorded that Cursive documents EDN file-structure support and has a JetBrains Marketplace listing for IntelliJ IDEA and Android Studio (sources in the #348 comments: <https://github.com/cursive-ide/cursive/blob/master/CHANGELOG.md> and <https://plugins.jetbrains.com/plugin/8090-cursive/versions>). That gives EDN syntax and structure. It does not give DataScript-specific inspections, and compatibility with every JetBrains IDE is unverified. Any Clojure-aware editor highlights `.edn` files, but no other editor was checked for this contract. Semantic validation is the build's job.

## One policy artifact: IDs, ordering and explanations together

Everything about a decision rule sits in one map in `decisions.edn`, so its selection clauses, ordering metadata, explanation and evidence bindings cannot drift apart:

```clojure
{:id         "D-EASY"
 :kind       "implement"
 :band       4
 :preference 0
 :when       [[1 "role" "implementer"] (eligible ?t) (easy ?t) [1 "order" "impact"]]
 :why        "Known easy win: impact {impact}, complexity {complexity}."
 :codes      ["easy-win"]
 :witnesses  {}}  ; rule-specific bindings, e.g. {:failedChecks [...clauses binding ?value...]}
```

The build enforces:

- IDs are unique and match `D-[A-Z-]+`. Vector order is the rule index the engine uses, which today is `10 + i`, so moving a rule within the file is a policy change and parity tests will catch it.
- Every `{placeholder}` in `:why` names a common, eligibility or rule-specific witness. A placeholder with no binding fails the build. This turns today's runtime "missing explanation binding" diagnostic into a build error, and the runtime diagnostic stays as well.
- Every predicate used in `:when`, a witness or a query is defined in `rules.edn` or `ordering.edn`, or is a DataScript built-in. Every `D-DENY-*` ID produced in `rules.edn` is documented with a one-line reason in `decisions.edn` under `:denials`.
- `:band` and `:preference` are integers, and `:kind` is one of the action kinds the adapter maps.

The bundle is one JSON object holding all five files after validation, in canonical form. `rulesHash` is computed over that object (see "Hash behaviour"). This artifact is also the input for the English policy page (#392).

## Build pipeline

"Compile" in this component means **read, validate and bundle**. DataScript interprets queries at run time and has no ahead-of-time compiler. Nothing is turned into executable code.

`npm run rules:build` runs `tsx src/rules/datalog/build.ts`, which:

1. Reads each `policy/*.edn` file with a JavaScript EDN reader (a devDependency chosen in migration step 2; it is build-time only and never ships). It rejects any file that is not exactly one top-level form and reports `file:line:column`.
2. Validates the structure and cross-references listed above.
3. Prints each clause and query back to a canonical EDN string, then has DataScript itself read every string and run every query and rule set once against an empty database with the policy schema. This catches anything DataScript rejects that the build's reader accepted.
4. Writes `policy.generated.json`, with keys sorted and a header naming the source files. It writes nothing if any step failed. `rules:build --check` exits non-zero if the committed file differs from a fresh build.

How it reaches the CLI and MCP:

- `engine.ts` statically imports `policy.generated.json`. At runtime nothing touches the filesystem, so there is no working-directory-dependent lookup and installed users need no source checkout or build tools.
- `service.ts` keeps its lazy `import("./rules/datalog/datalog.js")`, which becomes `adapter.js`. `vp pack` inlines JSON imports, so the bundle lands inside the same lazily loaded chunk. `scripts/package-test.ts` keeps requiring exactly one `dist/datalog-*.mjs`, and the package `files` allowlist does not change. Migration step 4 checks that the chunk count and allowlist are unchanged; if `vp pack` were to split the JSON out, that PR must stop and report rather than loosen package-test.
- The generated file is committed. `tsx` (the `triage`/`pdb`/`mcp` scripts and `scripts/*.ts`), Vitest and `vp pack` then work without a pre-step. `npm run check` gains `rules:build --check`, so a stale artifact fails locally and in CI. The EDN files remain the only hand-edited source. The generated file is marked as such and is never edited by hand.

## Rules-only tests

### Command and runner

`npm run rules:test` runs `tsx src/rules/datalog/runner.ts`. It loads `policy.generated.json` (after an in-memory `rules:build`, so a source edit is tested without a separate step) and every `tests/*.edn`. It calls only `evaluatePolicy`. It does not import the adapter, service, CLI, MCP or `gh`, and it does not touch the network.

#336 is still researching testing practice. For this contract the choice is bounded: no maintained framework executes DataScript EDN test definitions from Node without a JVM or ClojureScript build, so a small TypeScript runner is used and documented as such. If #336 later recommends something compatible, swapping it in only affects the runner, because the EDN test definitions are the stable part.

### Test definitions

```clojure
{:id    "P6-blocked-ready"
 :about "Ready label but an open native blocker; another fully known ticket is eligible"
 :viewer {:agent "a" :role "implementer" :platform "" :order "impact"}
 :complete {:forward-closing true}
 :subjects [{:id 1 :kind "issue" :state "OPEN" :label ["status:ready"] :labels-complete true
             :native-complete true :open-blockers 1 :created 1 :number 1}
            {:id 2 :kind "issue" :state "OPEN" :label ["status:ready"] :labels-complete true
             :native-complete true :open-blockers 0 :created 2 :number 2}]
 :expect {:order    [[2 "D-ORDINARY"]]          ; exact prefix of the ordered decisions
          :absent   [[1 "implement"]]           ; must not appear anywhere
          :denials  [[1 "D-DENY-BLOCKER"]]
          :why      {2 {:rule-ids ["D-ORDINARY"] :facts {"readiness" "status:ready"}}}}}
```

Assertions cover selected actions, forbidden actions, relative order, denials, overridden rule IDs and explanation bindings (rule IDs and fact values, not English wording). Fixtures are small and explicit. Between them they cover the ticket's list: eligibility, denial, missing or incomplete evidence, priorities, cross-role assessment boosts, oldest-first and explanation bindings.

### Outcomes and reporting

The outcome categories follow [local service and isolated rule testing](local-service-and-rule-testing.md):

- **Rule failure.** The scenario ran, but the decision, denial, order or explanation differs from what it expects. Exit code 1.
- **Infrastructure error.** Parsing, reading the bundle, an unknown fixture key or a runner fault means the assertion was never validly evaluated. Exit code 2, which wins over 1, and any rule failures are still listed.

Each result carries the scenario ID, file and line, and rule IDs. `--junit PATH` writes JUnit XML, which is what #394 publishes through #393's shared reporting path. A missing report or a crash never looks like a pass. A single Vitest file, `rules.test.ts`, calls the runner once, so `npm test` and the required `verify` check still include rule tests. `rules:test` exists for speed and does not replace the full suite.

### Manual local research validation

The formal-comprehension research preparation check is a separate manual category. Run `npm run test:manual:formal` locally when designing/changing the formal engine representation, modifying research preparation/scoring, or regenerating experiment inputs after relevant rule changes. This exhaustive check replays native scenarios for projection parity and compiles a research engine bundle; it is not a product unit test and must not be included in `npm test`, required CI checks or a new automatic CI job. See the [experiment procedure](../reports/formal-rules-comprehension-experiment.md).

The explicit manual configuration selects `doc/reports/examples/formal-comprehension.manual.ts`. Normal test discovery selects `*.test.ts`, so the manual validator is still type/lint checked without running its expensive setup in CI. It is offline and makes no LLM/GitHub requests. Native EDN correctness, normal adapter/integration tests and installed-package checks remain in their existing CI paths; this exception does not weaken their coverage.

### Relation to existing tests

- `assessment-priority.test.ts` (#356 via PR #375) and the policy cases in `datalog.test.ts` become EDN scenarios. Each conversion keeps its assertions and reports the scenario count before and after.
- Cases about snapshot adaptation, the `Snapshot`/assessment input, `RankedActions` projection, engine selection, CLI/MCP parity and packaging stay in TypeScript as the integration layer: `adapter.test.ts`, `src/acceptance/*` and `scripts/package-test.ts`.
- The scenario list in [rule-scenario-plausibility](rule-scenario-plausibility.md) (P1–P14) is the target coverage for EDN scenarios. #340 audits gaps and #339 informs boundary tests. This contract depends on neither: the extraction ships with the converted existing tests, and their findings arrive as new EDN scenarios.

## Migration plan

Each step is one focused PR. Each must pass `npm run check`, `npm test`, `npm run build`, `npm run package-test` and the parity suite. None changes policy semantics, CLI/MCP schemas or output text.

1. **Parity golden.** Before anything moves, add `parity.test.ts`. It runs today's `evaluateDatalog` over every snapshot used by the existing rule tests, the package-test parity snapshot and the frozen `scripts/datalog-trial.ts` input, for both roles and all three orders. It records the ordered items (target, kind, rule IDs, why text, fact bindings, overridden IDs), the denials and the unlock results to a committed `parity.golden.json`. The test only reads the golden file. Regenerating it takes an explicit flag and must be called out in the PR.
2. **Reader and build skeleton.** Add the devDependency EDN reader, `build.ts`, `rules:build` and `--check`. Have the build emit a bundle from the current `policy.ts` exports, so its structure and validation can be reviewed with no source change.
3. **EDN sources.** Move `clauses`, `sortClauses`, every query (including the 4 embedded in `datalog.ts`), constants, schema and witnesses into `policy/*.edn`, and decisions with their explanations into `decisions.edn`. Delete `policy.ts`. The engine reads `policy.generated.json`. The golden passes unchanged. This is the only PR where `rulesHash` changes (below).
4. **Packaging proof.** Confirm the single lazy chunk, the unchanged allowlist, installed CLI and MCP outside the checkout, and no runtime file reads. This may fold into step 3 if that PR stays small.
5. **Typed boundary.** Split `datalog.ts` into `engine.ts` (`evaluatePolicy`) and `adapter.ts` (normalization, the `RankedActions` projection and command templates). Add the import-boundary test. Golden unchanged.
6. **Native tests.** Add `runner.ts`, `rules:test`, `--junit` and `rules.test.ts`. Convert the policy cases from `datalog.test.ts` and `assessment-priority.test.ts` to `tests/*.edn`. The remaining TypeScript cases become `adapter.test.ts`.
7. **Contributor docs.** Add the edit → `rules:build` → `rules:test` workflow with a short example to `AGENTS.md` and the README, and point `source-layout.md` at this contract. CI publishing is #394: `reports/junit-rules.xml` goes through #393's summary and artifact, and the `rule outcome categories` step demonstrates on every platform that a wrong decision, malformed EDN and runner faults land in their categories (doc/design/test-reporting.md). `rules:test -- --scenarios DIR` runs another scenario directory.

The golden suite stays after the extraction as a regression net. Intentional policy changes later regenerate it alongside the EDN change that causes them.

### Hash behaviour

`rulesHash` stays `sha256` over a JSON object. Its input changes once, in step 3, from the JavaScript export object to the canonical bundle. Clause strings are printed canonically, so whitespace and comments in the EDN no longer affect the hash, but the different representation does produce a new value. That PR states the old and new hash. `policyVersion` stays `1`, because decisions are identical, and the golden proves it. After that, the hash changes only when policy content changes. Nothing persists the hash, so no migration is needed.

## Risks and open questions

**Owner question (one).** Should `policy.generated.json` be committed with a `--check` freshness gate, as proposed, or git-ignored and produced by pre-scripts before `test`, `build`, `triage`, `pdb` and `mcp`? Committing it keeps every existing entry point and `tsx` path working unchanged. The cost is a generated, but verified, copy in the diff. Git-ignoring it removes that copy but adds a build step in front of every command. This contract proceeds with committing unless the owner says otherwise.

Risks, which the PRs themselves handle:

- **Reader divergence.** The build's EDN reader could accept something DataScript's reader treats differently. Step 3 of the build mitigates this by having DataScript read and run every printed form.
- **Silent extra forms.** DataScript's reader ignores anything after the first form. The build's single-form check prevents this.
- **Chunking.** If `vp pack` ever emitted the JSON as a separate chunk, package-test would fail. Step 4 checks for this, and the fix belongs in the import, not in loosening the test.
- **Coordination with #335.** Moves for #335 (open PR #365 and later stage-3 test splits) do not touch `src/rules/datalog/`. Steps 5 and 6 recheck for open #335 PRs before editing `service.ts` imports or splitting tests.
