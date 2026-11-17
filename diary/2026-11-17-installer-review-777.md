# Installer merge review (#777)

Addressed the two current-head Codex findings before the requested merge. JSON and
TOML edit/removal previews now contain only the managed entry, excluding unrelated
configuration credentials. TOML block scanning recognizes array-of-tables and
commented table boundaries, including quoted keys containing closing brackets;
unrelated appended tables no longer make an unchanged PDB entry appear edited.
Existing before/after TOML validation remains in force.

Added disposable-file regressions for dry-run and applied JSON create/replace/remove,
TOML replacement/removal secret isolation, and unchanged reruns after three valid
unrelated header forms. All 13 focused installer tests pass. No real client config
or trust setting was changed. Full validation is recorded with the PR reply.

Full validation passed: check (zero errors, 54 existing warnings), 138 test files /
2,568 passing tests (one skip), and build. The normal pre-commit hook is retained.

The original PR merged concurrently before the fixes were pushed. Follow-up #797
carries them onto current main. Full current-main validation exposed a stale
process-footer assertion from #730: the Doctor link is now valid because #788
shipped Diagnostics. Updated that assertion to require the scoped link and retain
the no-context/no-link control; no footer or installer runtime behavior is relaxed.

Current-main validation passes after the stale assertion correction: check (zero
errors, 54 existing warnings), all 151 files / 2,754 tests (one skip), and build.

Windows CI exposed a 20-second timeout in the MCP budget size-table aggregate.
That test repeated every case already checked individually with exact serialized
byte counts and budgets. Moved its size logging into the existing parameterized
cases and removed the duplicate aggregate execution. All tool/argument cases, SDK
transport, exact counts and budget assertions remain; no deadline, skip or retry
was changed.

After consolidating the duplicate size-table execution, all 151 test files /
2,753 tests pass (one skip), with check and build also passing. The one fewer test
is the aggregate duplicate; all individual tool/argument cases remain.

Integrated current main after its independent Doctor-link test repair conflicted
with the same assertion. Preserved both the valid scoped link and no-context
control. Check, all 154 files / 2,789 tests (one skip), and build pass on the
combined tree; this also resolves the conflict that prevented PR CI from starting.
