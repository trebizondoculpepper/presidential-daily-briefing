# Normal CLI effective identity (#677)

The shared preparation service merged in #776 as `8d6010d`. This deliverable activates it for
normal briefings, catch-up, focused workflow reads, claims, question resolution, release,
dependencies, delivery, estimates and issue creation. Each command parses its own flags before
preparing identity; no raw argument scanner can mistake a body/rationale for a selector.

Attribution uses the verified saved name/default role without manual name lookup. Explicit
names remain per-call overrides. Shared entry/harness/role options support safe first use;
a missing bootstrap role produces a concrete setup result instead of inventing implementer.
The original planner receives a real resolved name, never a placeholder. Dry-runs needing a
new name preview setup without allocating or making remote requests. Offline, config, Doctor,
rules, help and onboarding remain non-initializing.

The per-invocation output adapter emits setup notices and diagnostics to stderr and adds
`effectiveIdentity` to the actual JSON object. It forwards/awaits output immediately, preserving
checkpoint advancement after successful flush. Human attention/routing stays separate from
employing-human and execution metadata. Issue creation reuses the same human context; current
main's managed-checkout and default-human-assignee guards remain intact.

Twelve disposable-project acceptance cases run through the real CLI parser/dispatcher and
output: first use, reuse, missing role, original-command failure and retry, human view, text
stderr, checkpoint flush order, live claim planning, zero-write claim dry-run, catch-up, issue
preview and disabled-metric estimation. Legacy credential-free tests explicitly disable default
bootstrap; tests of this feature inject disposable filesystem/Git/human/session boundaries.
Onboarding now starts with the normal command rather than requiring an agent-name echo.

Validation on merged core/current main: check (zero errors, 54 existing warnings), full suite
(141 files, 2,611 passed and one skipped), build, source smoke and packed-install/package tests.
After the final help-text update, affected CLI/workflow/onboarding suites and checks are rerun;
the normal Vite+ commit hook is retained. MCP and HTTP startup/projections remain the next
#677 deliverable; membership stays open. Nothing is released to npm.

Review follow-through: Codex found that following a transferred ticket re-entered normal
preparation for the destination repository. Transfer reads now inherit the verified original
invocation context, retain transferredFrom and perform no destination identity setup. The
actual CLI regression fails on the reviewed head and passes after the fix.

A target-scope audit also found that implicit gh targets and offline cache repositories must
be resolved before private identity selection. Attributed handlers now pass their actual target
through to preparation and their planner; offline reads use the cache's repository without live
target lookup. Seven command-family tests and an offline cross-repository cache test fail before
and pass after. Repository-selection diagnostics omit private checkout paths at the shared
service boundary. Final validation: check, 141 files / 2,620 passed and one skipped, build,
source smoke and packed-install/package tests, with no timeout or concurrency policy relaxed.
