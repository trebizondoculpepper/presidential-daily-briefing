# GitHub conflict editor investigation

Observed 18 November 2026. Question: was a disabled **Resolve conflicts** button
caused by a setting introduced by PDB/project policy? No settings were changed.

## Verified repository configuration

The active repository ruleset is **main: pull requests and verify**, ID 27166105.
It targets only the default branch. Rules require a PR and the `verify` check,
prevent non-fast-forward updates and deletion; there are no bypass actors. The
review count is zero and all ordinary merge methods are permitted. The legacy
branch-protection endpoint returns 404 because rulesets, not legacy protection,
are configured. This does not mean main is unprotected.

The head branches of PR #998 (`feat/891-localdoctor-typed-services`) and #999
(`feat/930-mcp-server-typed-services`) return no applied branch rules. The API
identity used for this inspection has admin/write permission; that does not prove
the user's browser session uses the same account or permissions. No explicit
conflict-editor prohibition, signed-commit rule or protected-head rule was found.

Repository `allow_update_branch` is false. This is the separate **Update branch**
feature, not evidence that **Resolve conflicts** was disabled by project policy.
Do not change protection/CI/review requirements to diagnose that button.

## Local read-only conflict inspection

Fetched PR heads into investigation refs and used `git merge-tree --write-tree`
against the observed origin/main, without modifying branches or resolving conflicts.
#998 has a content conflict in `src/github/service/service.ts`; #999 has a content
conflict in `src/mcp/server.ts`. Both head branches lack applied protection rules.
These observations do not prove GitHub's web editor can handle either merge.
They do not establish which PR or browser account produced the reported grey button.

## Finding and limits

[GitHub's documentation](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-on-github)
limits the browser editor to supported simple conflicts; a deactivated button means
use another Git client/CLI. Resolving there merges the base into the head, so head
permissions/protection can also matter. The exact disabled-button reason is not
exposed in the repository settings inspected here.

Conclusion: no configuration was found establishing that PDB intentionally blocked
browser conflict resolution. The separate branch-update option is disabled, but
should not be conflated with the conflict editor. A specific PR and the button's
browser tooltip/account state would be needed to attribute the historical incident
more precisely. No new policy or settings change is warranted by this evidence.
