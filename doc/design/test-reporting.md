# Structured test reports in CI

Contract for #393. It changes how CI reports results, not what passes: `npm run check`,
`npm test`, `npm run build`, the smoke tests and `package-test` keep their commands and
exit codes, and the single required `verify` check keeps its meaning. No new permissions,
no third-party reporting action, no privileged `workflow_run` job and no live production
behavior change.

## Documentation-only verification

Owner decision (2026-11-16): pull requests changing only root Markdown, Markdown under `doc/` or `diary/`, or GitHub
Markdown templates (excluding `doc/reports/examples/`) use a documentation formatting job instead of the unit,
native-rule, build, smoke and package jobs, including the optional FreeBSD trial.
Executable examples, fixtures, dependencies, workflow/configuration changes and
mixed changes retain full verification. Renames inspect both old and new paths;
empty diffs and main pushes retain full verification. Classification failure fails
`verify`; skipped or failed required work cannot satisfy it. No workflow-level path
filter may leave the required check pending.

The stable `verify` check succeeds only after classification and the selected job
succeed. Automated review remains a separate required policy, including addressing
substantive findings; this fast path does not itself authorize an unchecked merge.

## Validation (2026-11-15)

- Toolchain: Vite+ `vp` 1.5.0 with Vitest 5.1.0. Vitest's built-in `junit` reporter works
  through `vp test run --reporter=junit --outputFile.junit=PATH`; the XML keeps the suite
  (file), the full test name, the failure message and type, the expected/received diff and
  the `file:line:column` frame.
- Annotations: with no reporter configured, Vitest adds GitHub `::error` annotations under
  `GITHUB_ACTIONS=true`. **Configuring any reporter explicitly turns that off.** CI must
  therefore name `default`, `github-actions` and `junit` together, or the existing
  annotations silently disappear.
- The rule-decision suite already writes JUnit: `npm run rules:test -- --junit PATH` (#394).
- Checked locally with a deliberate failing test outside the committed tree; the
  implementation PR repeats the check once on a disposable branch in Actions (annotations,
  summary, artifact, a fork-style read-only token) and records the run link.

## Reports and paths

Each matrix job writes into `reports/` (Git-ignored), named by suite so nothing overwrites:

| Suite                             | Producer                                                | File                        |
| --------------------------------- | ------------------------------------------------------- | --------------------------- |
| rule decisions                    | `npm run rules:test -- --junit`                         | `reports/junit-rules.xml`   |
| application and integration       | `vp test run` with `default`, `github-actions`, `junit` | `reports/junit-tests.xml`   |
| check, build, smoke, package-test | a step-record wrapper                                   | `reports/steps/<step>.json` |

One Vitest run covers application and integration tests; the summary separates them by
path (`src/acceptance/**` is integration, `src/rules/**` rule engine, the rest
application), so there is one reporting path without a second test run. Commands with no
native JUnit output run through a small TypeScript wrapper (`scripts/ci-step.ts NAME --
COMMAND...`) that streams output unchanged and records the exit code, duration and a
bounded tail (at most 60 lines, 8 KB) of combined output.

### Rule outcome category demonstration (#394)

The `rule outcome categories` step (`scripts/rules-categories.ts`, logic in
`src/ci/rulecategories.ts`) runs the real rules runner, with `--scenarios DIR`, against
deliberately broken inputs kept in `src/rules/datalog/category-demo/`. Each case must land
in its category:

| Case                                        | Expected                                               |
| ------------------------------------------- | ------------------------------------------------------ |
| a valid scenario with a wrong expectation   | exit 1, `<failure type="RuleDecisionFailure">`         |
| malformed EDN (an unclosed map)             | exit 2, `<error type="RuleInfrastructureError">`       |
| a scenario directory the runner cannot load | exit 2, `<error type="RuleInfrastructureError">`       |
| a JUnit report the runner cannot write      | exit 2, no report, `RuleInfrastructureError` on stderr |

Nothing of the other category may appear in a case's report. The step writes a table to the
step summary on every platform and fails only on a miscategorization, so CI stays green while
continuously showing the categories are distinct. Its JUnit goes to
`reports/rules-categories/`, uploaded with the artifact. The summarizer reads only the
required report files, so these demonstration failures are never counted as real ones. The
production scenarios never include `category-demo/`, and `npm test` runs the same
demonstration through `src/ci/rulecategories.test.ts`.

The job uploads `reports/` with the official `actions/upload-artifact` under `if: always()`
as `test-reports-<os>-node<version>`, retained 14 days, so reports survive a failing step.

## Summary and failure semantics

A TypeScript summarizer (`scripts/test-summary.ts`, `if: always()`) reads `reports/` and
appends Markdown to `$GITHUB_STEP_SUMMARY`: per suite the platform, tests, failures,
errors and skips; then each failing case with suite, test name, platform, a `path:line`
source link and the failure message and diff, bounded per case and overall, with an
explicit "Truncated due to maximum size" notice. Failed steps without JUnit show their
recorded tail.

It distinguishes, and names, these outcomes rather than collapsing them:

- **assertion failures** (JUnit `failure`) and **errors** (JUnit `error`);
- **valid zero tests**: a well-formed report with `tests="0"`;
- **missing report**: the producing step ran but wrote no file (crash or reporter
  misconfiguration), or did not run because an earlier step failed;
- **malformed report**: present but unparseable;
- **step failure without JUnit** (check, build, smoke, package-test);
- **reporting error**: the summarizer itself failed.

The summarizer never makes a run green. It exits non-zero when a required report is
missing or malformed although its producing step reported success, so "no report" can
never read as "no failures". It never turns a failed test step into a pass, and the test
steps still fail the job exactly as today, so `verify` is unchanged. An artifact upload
failure is visible as its own failed step.

Fork pull requests run the same job with the default read-only token; the summary uses
only `$GITHUB_STEP_SUMMARY` and the artifact, so no write permission or privileged
follow-up job executes untrusted artifacts. The FreeBSD trial job stays non-blocking and
out of scope.

## Local reproduction

`npm run test:report` runs the same reporters and wrapper locally into `reports/`, and
`npx tsx scripts/test-summary.ts reports` prints the same Markdown to standard output.
Both scripts are TypeScript, use only Node built-ins, and are covered by tests with
fixture reports for every outcome above.
