# Agent workflow

Read [architecture.md](architecture.md) for architectural requirements. This guide
contains working procedures; it does not define a competing architecture. Paths
in commands are relative to the repository root.

## Automated review and release gate

Owner policy: either Codex or CodeRabbit may satisfy automated review. Required CI (`verify`) must pass on the current PR head, and at least one provider must have completed a clean review covering that head. A completed current-head Codex receipt with no unresolved findings is sufficient; a passing current-head CodeRabbit review is sufficient. Both are not required. Quota skips, neutral checks without a completed review, pending/error reviews and stale-head receipts are not approval. Address every substantive outstanding finding from either reviewer before merging, even when the other provider is clean. A missing second-provider review alone is not a blocker. Follow [review-gate.md](design/review-gate.md).

A merge does not publish to npm. Publication still requires the owner's explicit release request and the existing verified `npm run release` process. Never bypass required CI or use an admin/force merge merely because one reviewer is clean.

## Work and checks

Use this project's own toolchain for ticket intake, prioritization, claims, handoffs, estimation and diagnostics so routine work tests the product itself. No separate communications platform or external check-in is required. Use this project's triage tool instead of direct `gh` wherever the operation is supported. Use full ticket intake and native dependency views before separate GitHub searches; fall back to `gh` only for unsupported operations, missing evidence or triage diagnosis. Check current `--help`, not planned command syntax.

Use this repository's issues, not the old poker_blocks issue numbers. Recheck current ownership and native blockers before claiming. Keep one issue/PR focused; preserve another agent's work. An unanswered question goes on its ticket with the concrete blocker.

For documentation-only changes (root Markdown, `doc/`, `diary/` and GitHub Markdown templates, excluding `doc/reports/examples/`), run `npx vp fmt --check`; unit tests, builds and package tests are not required. Mixed changes and all executable/configuration changes retain the full checks. Before committing those changes run `npm run check`, `npm test` and `npm run build`. Use the installed Vite+ pre-commit hook; do not bypass it. Keep the developer diary in `diary/` for significant work.

## Commands

```sh
npm install                                   # also installs the Vite+ hooks (prepare)
npm run pdb -- --repo owner/repo [--json] [--issue 42] [--agent name]
npm run pdb -- deps 42 --repo owner/repo --tree
npm run check                                 # vp check (format, lint, type check) + examples tsc
npm run fmt                                   # apply formatting
npm test                                      # vp test run (Vitest)
npx vp test run src/workflow/claims.test.ts -t "name"  # one file / one test by name
npm run build                                 # vp pack -> dist/cli.mjs
node dist/cli.mjs --help                      # quick CLI smoke test
npm run smoke                                 # credential-free exit-code smoke of dist/cli.mjs
npx tsx scripts/smoke.ts src/cli.ts           # same smoke against the TypeScript source
npm run package-test                          # pack, install globally into a temp prefix, smoke
npm run rules:build                           # validate policy/*.edn, write policy.generated.json
npm run rules:test [-- --junit PATH]          # rules-only: run scenarios/*.edn against the engine
npm run test:report                           # CI's JUnit reports + summary locally, into reports/
```

## Editing the rules

The DataScript policy lives in `src/rules/datalog/policy/*.edn` (DataScript Datalog, not Prolog). Edit those files, never `policy.generated.json`, which `npm run rules:build` writes and `npm run check` verifies is current. Each decision rule is one map in `decisions.edn` holding its ID, band, `:when` clauses, `:why` text and evidence witnesses; attributes are strings, not keywords. Then:

1. `npm run rules:test` runs every scenario in `src/rules/datalog/scenarios/*.edn` against the engine in seconds, without GitHub or the CLI. Exit 1 means a scenario's expected decision differs (`RuleDecisionFailure`); exit 2 means a source, scenario or the evaluator is broken (`RuleInfrastructureError`).
2. Add or update a scenario for the behaviour you changed. A scenario gives engine facts and the complete expected result:

   ```clojure
   {:id "easy-win" :doc "An eligible L/S ticket is a known easy win."
    :viewer {:role "implementer"}
    :facts [{:e 1 "forward-complete" true}
            {:e 100 "kind" "issue" "state" "OPEN" "number" 1 "target" "t1" "created" 1
                    "label" "status:ready" "labels-complete" true "native-complete" true
                    "reverse-complete" true "blocking-complete" true "open-blockers" 0
                    "impact-state" "current" "impact-size" "L"
                    "complexity-state" "current" "complexity-size" "S"}]
    :expect {:actions [{:subject 100 :rule "D-EASY" :kind "implement" :band 4
                        :why "Known easy win: impact L, complexity S."}]
             :denials #{}}}
   ```

3. `npm run rules:build`, then the full checks. If decisions change on purpose, regenerate the golden parity file (`PDB_PARITY_REGENERATE=1 npx vp test run src/rules/datalog/parity.test.ts`) and state the change and the new rules hash in the PR.

Without `--repo`, the target repository is resolved by `gh repo view` from the current working directory. Installed consumers use the declared runtime dependencies and built bundles; shared GitHub fact types live in `src/github/types.d.ts`; `tsconfig.json` (strict) covers `src/` and `scripts/`, and `doc/reports/examples/tsconfig.json` covers the rules examples. Tests sit beside the code they cover (`src/<area>/*.test.ts`), with shared fixtures in `src/testing/` and cross-feature suites in `src/acceptance/` (doc/design/source-layout.md); the `gh` wrapper tests in `src/github/github.test.ts` fake `gh` with a POSIX shell script and are skipped on Windows. The CLI and tooling target the current Node LTS, Node 26+ (`engines`, doc/design/runtime.md). CI runs the checks, tests, build, smoke tests and package test with Node 26 on Ubuntu and Windows (required) and, on trial, runs the built and source CLI, smoke tests and package test on FreeBSD in a VM (Vite+ has no FreeBSD binding, so check/test/build run on the Linux host; non-blocking: not part of `verify`, and may be removed if it proves problematic); macOS is not run unless explicitly requested, as it is expected to match Linux. The single `verify` job passes only when every Ubuntu/Windows matrix job passes, and is the check to require. Line endings are LF everywhere.

## Choosing work

Be proactive: when one job finishes, find the next one rather than stopping to ask.

1. **Your own open PRs come first.** An implementer's job is to get code merged, not to open PRs. Wait for CI and review, address every substantive finding (reviewers, bots, comments on the linked ticket), reply on each thread, and push until the PR is ready to merge. Wait in the background while reviews are pending; do not end the session because a review has not arrived yet.
2. **Then pick a ticket with the triage tool** (`npm run pdb`, `deps N`):
   - first, the ticket that unblocks the most downstream work (last open blocker for the most dependants);
   - failing that, a bug;
   - otherwise, the oldest ticket before newer ones.
3. **Any PR that needs work to merge, or any issue you can pick up, is fair game.** If two jobs both look valid, just pick one; the choice often does not matter. Do not stop to ask which.

Skip only work that someone else is visibly doing now: an `agent:` label, an open PR by someone else, or a recent claim comment for active work. A queued intention ("I'll do this after X") is not an active claim. Comment on the ticket when you claim it.

## Mirrored process proposal

The owner requested a mirror of poker_blocks' design/implementation process. Review [doc/process.md](process.md) and [doc/design-implementation.md](design-implementation.md); [doc/poker-blocks-process.md](poker-blocks-process.md) preserves historical process context with personal integration details removed. [Issue #12](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues/12) asks this project to consider adoption and adaptations. These are review proposals; they do not silently override this guide or assert that branch protection/reviewer integrations exist.

The [process adaptation audit](reports/process-adaptation-audit.md) (#12) recommends retaining this guide and the focused merged contracts as active policy. The mirrored process remains context, not a second competing instruction source. Close tickets only when their stated acceptance is complete; completing a documentation phase alone does not finish its implementation or empirical follow-up.

For a design/research phase with further ticket acceptance outstanding, use neutral PR wording such as `References #N`. Do not negate a GitHub closing keyword next to a real issue reference: GitHub still treated that wording as a closing directive in this project. Use an intentional closing directive only when the PR completes the issue’s stated acceptance. Verify the issue state after merge.

## Proportionate research

Follow [the research-stage instructions](design/research-stages.md) for #72/#74/#75/#78: up to roughly one hour of agent time for initial plausibility/preparation. Higher-standard feasibility/practicality or repetitive evaluation is separate and must not block the original low-cost experiment. Later repetitive trials go to a cheaper agent after review and a separately agreed budget; a possible $20 cap is not current authorization. Cheap, bounded experiments can establish plausibility; costly ones need a plausible basis first. Unknown cost must be estimated, not treated as low.
