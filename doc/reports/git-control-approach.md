# Git control approach for PDB

Research for #872, requested urgently by the owner: how should this TypeScript project
control Git — a mature typed library wrapping the Git executable, a Git implementation
library, or the existing injected `GitRunner` behind a typed Git service?

**Recommendation: keep executing the Git binary, behind the existing injected boundary, and
give that boundary a typed service surface.** Adopt no library now. If a library is wanted
later, `simple-git` is the lower-risk option because it still runs the real binary; an
implementation library (`isomorphic-git`) would change Git semantics the project depends on —
including the release script's `fetch`/`push`, where credentials and the credential helper are
the binary's own.

This document records evidence only. It changes no dependency and no behaviour.

## What the source actually does

Production Git use is **read-only discovery**, spread over 24 non-test modules behind one
boundary: `GitRunner` (`src/config/config.ts`), whose production implementation `nodeGit` runs
`execFile("git", args)` — an argument array, never a shell.

| Operation                                                                            | Example callers                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Working-tree root                                                                    | `rev-parse --show-toplevel`                                 |
| Remotes and their URLs                                                               | `remote -v`, `remote`                                       |
| Revision identity                                                                    | `rev-parse HEAD`, `symbolic-ref -q HEAD`                    |
| Ref existence and divergence                                                         | `show-ref --head`, `rev-list --left-right --count`          |
| Ignore rules                                                                         | `check-ignore --quiet`, `rev-parse --git-path info/exclude` |
| Tracked-file checks                                                                  | `ls-files --error-unmatch`                                  |
| Repositories whose files this checkout owns (worktrees, submodules where configured) | `rev-parse --git-common-dir`                                |

Application code writes nothing: no `fetch`, `checkout`, `pull`, `merge`, `commit`, `reset`,
`clean`, `push`, `branch`, `tag`, `stash`, worktree or submodule mutation anywhere in `src/`.
The module that reads remote state (`src/updates/checkout.ts`, the npm update check) also only
reads: `symbolic-ref`, `show-ref`, `rev-list`, `rev-parse`, `remote`.

**Maintained release scripts are the exception, and they do write.** `scripts/dispatch.ts`
runs `git fetch --no-tags origin main` and `git fetch --no-tags origin release` to resolve
what to ship, `git ls-remote` to see whether a release branch exists, `git merge-base
--is-ancestor` to refuse rewriting history, and finally `git push origin <sha>:refs/heads/release`
to fast-forward it (never forced). Those are operator-invoked, safety-checked writes with
their own runner (`run("git", args)`), outside the `GitRunner` boundary, and they publish
nothing by themselves — the Publish workflow still has to run. Any conclusion about "how PDB
controls Git" has to hold for this path too, and it is the strongest argument for executing the
real binary: credentials, credential helpers, push negotiation and pre-push hooks are exactly
where an implementation library diverges.

Two further properties matter more than the choice of library:

1. **The boundary is why tests exist.** Every module takes `GitRunner` (or a `runtime.git`),
   so the suite fakes Git without a checkout — `src/serve/registration.test.ts` is a current
   example. A library must be injected the same way or that ability is lost.
2. **Identity must come from the checkout, not the environment.** `gh repo view` honours
   `GH_REPO`; the #805 review found that a stale `GH_REPO` could label one checkout as another
   repository and save the wrong local root against it. `githubRepositories()` already parses
   remotes for exactly this reason, and a typed service should own that rule rather than leave
   it to each caller.

## Options considered

Versions and requirements were read from the registry on 2026-11-18 with `npm view`. The
project runs Node `>=26` (`package.json` `engines`).

| Option                                                                               | What it is                                | Typed results                                 | Runs `git`?          | New runtime deps                                          | Verdict               |
| ------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------- | -------------------- | --------------------------------------------------------- | --------------------- |
| **Current `GitRunner` + `execFile`**                                                 | 15-line boundary, argument arrays         | No (stdout strings, small parsers)            | Yes, the real binary | none                                                      | **Baseline: keep**    |
| **`simple-git` 4.1.0** (~903 KB unpacked, published 2026-11-16)                      | Typed promise wrapper over the executable | Yes: `status`, `branch`, `log`, error classes | Yes                  | 1 (+2 optional plugins)                                   | Best library fallback |
| **`isomorphic-git` 1.44.16** (pure JS, `engines.node >=14.17`, published 2026-11-17) | Git reimplemented in JavaScript           | Yes, structured                               | **No**               | 6 (`pako`, `pify`, `diff3`, `crc-32`, `ignore`, `sha.js`) | Not for this project  |

### Why not an implementation library

`isomorphic-git` is a real implementation: it does not shell out. That is exactly the
property the project cannot currently afford to change:

- **Settings the process relies on** — `safe.directory`, `core.*`, `insteadOf`, credential
  helpers, sparse checkout and filters — are honoured by the binary and would have to be
  reproduced or silently diverge.
- **Worktree and common-dir semantics**: the project reads `--git-common-dir` and
  `--git-path info/exclude` to decide which files a checkout owns. A reimplementation's
  answers are close, not identical.
- **Supply chain**: six runtime dependencies for read-only calls that today need none, in a
  package whose only other runtime dependencies are deliberate, few and reviewed.
- **No safety gain**: the calls are argument arrays without a shell already. The risk a
  library typically removes (string interpolation, quoting) does not exist here.

### Why `simple-git` is the sensible fallback

It wraps the same binary, so semantics do not move; it adds typed errors and structured
results for `status`/`branch`/`log`, which the project does not currently need (`status` is a
single `--porcelain` line today, and `log` is not used). It is one dependency with an optional
plugin model, actively released, and it accepts an injectable `binary`/`baseDir` — so the
test boundary survives.

Its cost is a new dependency for calls that are mostly one flag long, and a wrapper whose
error taxonomy would have to be mapped back onto the project's structured refusals.

## Recommendation in detail

1. **Keep `GitRunner`**, and keep `execFile("git", args)` as the only production
   implementation: argument arrays, no shell, inherited environment except where a caller
   deliberately overrides it.
2. **Add a typed Git service over it** rather than a library: one module owning the
   operations in the table above, returning typed results (`repositoryIdentity`,
   `workingTreeRoot`, `revision`, `isIgnored`, `isTracked`, `remotes`) and owning the
   `GH_REPO`-independent identity rule. Callers stop composing `rev-parse` themselves; tests
   keep injecting the runner underneath.
3. **Adopt `simple-git` only if** a future need genuinely requires its typed surface (rich
   `status`, `log` parsing, progress reporting) — and then behind the same service, with the
   runner still the only place that spawns Git.
4. **Do not adopt `isomorphic-git`** while the project depends on binary Git semantics for
   identity, ignore rules, worktree ownership and the release script's authenticated
   `fetch`/`push`.
5. **Leave `scripts/dispatch.ts` as it is.** Its writes are deliberate, ancestry-checked and
   never forced; a typed read service should not absorb them, and a library must not replace
   them without the same checks and credential behaviour.

## Bounds of this research

Registry metadata and the source inventory above are verified. No candidate library was
installed or benchmarked for this report: the decision does not turn on performance, and
adding dependencies to evaluate them would exceed the requested investigation. If the owner
wants a measured comparison, the honest experiment is a spike branch that replaces the
`identity.ts` ignore/tracked checks with `simple-git` and runs the existing suite — those are
the only calls where a wrapper plausibly saves code.
