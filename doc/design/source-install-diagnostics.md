# Diagnose the running source installation

Contracts for #309 (checkout freshness) and #346 (dependency readiness). These are
separate implementation tickets sharing the same verified installation-root service.
Extend updates.md and diagnostics.md; no automatic update, fetch, package install or
Git edit is authorized by these checks. This document does not claim they are shipped.

## Which installation is being diagnosed

Resolve this program's own package root from its loaded module/bundle location,
following the executable link to its real target. Verify the package manifest belongs
to PDB. Never use the user's cwd or selected target project as a substitute: an agent
can run a globally linked PDB while working in a different repository. Bound upward
manifest search and filesystem/process work. A missing/unreadable/ambiguous root is
unknown, not an npm installation or a healthy checkout.

Distinguish npm package, source checkout (including npm link), and unknown installation.
Do not treat every path containing node_modules as a published install when a symlink
resolves into a source tree. Keep package version and executing revision distinct;
this repository's manifest version alone does not identify a release or compiled SHA.
A source Git HEAD describes the checkout, not proof that dist was rebuilt from it.

## #309: local Git freshness

For a verified source root, use injected argument-array Git calls without a shell,
network access or user Git aliases. Read its working-tree root, current HEAD, branch
or detached state, and local comparison refs. Support worktrees whose .git is a file.
Never run fetch, pull, checkout, reset, merge or npm from a diagnostic.

Report upstream and repository-default comparisons separately when available. The
branch's own upstream may be another feature branch: equality there cannot prove it
includes main. Prefer the configured remote's symbolic default ref for the default
comparison; a local origin/main fallback is permitted only when present and explicitly
labelled as the fallback, not as a verified remote default. Missing refs remain unknown.
No remote URL, credential-bearing Git config or raw command output is rendered.

For each valid comparison use ancestor/reachability counts, yielding behind, ahead,
diverged or equal with numeric ahead/behind counts. Equal means equal to the observed
local ref, not current with GitHub. Show observed ref/HEAD and observation time. Report
FETCH_HEAD timestamp if safely available as the local last-fetch evidence, labelled
as such: it need not describe that exact ref and does not prove remote freshness.
Missing fetch time is unknown. Do not say 'up to date' based on an old local ref.

Missing Git, shallow/incomplete history, an unreadable ref, detached/unborn HEAD,
permission errors or timeout produce explicit unknown fields. Do not turn a failed
comparison into zero commits behind. Local ref/HEAD changes during collection are
reported as unstable/retry, not a consistent comparison. Bound Git calls to eight,
one second per call and three seconds overall; when exhausted, return partial
local diagnostics without delaying useful briefing work further.

Explicit `pdb version` reports source revision/branch/comparison and a safe local
installation location. Routine briefings show a short warning only for a proven
behind/diverged default comparison, plus a focused version/doctor command for detail.
Unknown diagnostic data must remain available in JSON/detail but must not produce a
large recurring footer. Preserve JSON/MCP stdout; no unsolicited protocol text.
Remote HTTP/MCP diagnostics expose safe installation categories and revision/freshness,
not machine paths. Existing Doctor keeps its relative-path privacy convention.

`--no-update-check` and supported environment opt-outs suppress automatic freshness
probes/notices as well as npm update checks. Explicit version/Doctor inspection may
report installation identity but records comparison as skipped if that opt-out is
active. Offline disables network as before; these local-only probes may still run
unless opted out. Published npm installs retain their existing registry/cache path;
this slice never adds a Git probe in each consuming repository.

Recovery guidance is inspection-first: identify the installation root and show the
supported commands to update/rebuild it deliberately, or install the published package.
Do not recommend blind pull/reset on a dirty, detached or diverged branch. Do not
claim changing Git HEAD changes an already-built executable. The operator chooses
whether to rebuild, switch branches or replace a linked install.

## #346: dependency readiness and engine load errors

Doctor checks dependencies at the same verified source root, not the target project.
Read the root package manifest, package-lock and npm's installed hidden lock evidence
when available. Compare normalized expected and installed records for applicable
runtime/development packages, including versions and lock identity. Account for npm's
platform/architecture/optional and explicitly omitted dependency groups; a foreign
optional binary's absence is not corruption. No reliance on file timestamps alone.

A hidden lock alone is a hint, not proof that files still exist. Verify the required
runtime modules/engine chunk resolve from the running installation, without executing
arbitrary package setup code, downloading anything or running package scripts. The
implementation must document its supported lockfile versions and normalization;
unreadable/unsupported/absent lock evidence is unknown, never declared current.
Do not claim full tree integrity from selected required-module checks. Return a
bounded summary identifying mismatched/missing package names, not private lockfile
contents, registry URLs, local directory trees or environment values.

Known source dependency mismatch/missing required module gives exact `npm ci` recovery
at the running source root, followed by rebuild when executing dist. Unknown evidence
explains why it cannot establish readiness. A published installation with a missing
packaged chunk/module instead suggests reinstalling the published package; do not
instruct users to run npm ci inside their unrelated consuming project.

The engine loader preserves `decision-engine-failed` compatibility but adds a typed
cause category: missing module/chunk, unsupported runtime, invalid policy or evaluation
failure where supported by actual error evidence. Sanitize module identity using
structured error fields or a validated package specifier; never echo raw error text,
private absolute paths or an arbitrary path embedded in a thrown message. Unknown
load errors stay unknown. A rules decision failure is not reported as dependency
corruption merely because Datalog threw. Never silently fall back to TypeScript or
modify the user's selected engine to hide a broken install.

Doctor checks remain independent: a dependency error does not suppress identity,
authentication or other diagnostics. Read-only means no npm install, lockfile write,
cache mutation, credential change or automatic repair. Share the loader's safe cause
with CLI/MCP/serve structured errors; concise text names the cause and delivered
Doctor/reinstall command without replacing existing exit/error semantics.

## Acceptance and delivery

Each ticket has its own implementation PR and remains open after this contract:

- #309: injected Git/filesystem/clock tests for equal/ahead/behind/diverged,
  feature-upstream versus default, missing/stale FETCH_HEAD, unavailable default,
  detached/unborn/shallow, Git missing, worktree, linked source versus consumer cwd,
  changes during observation, deadline, opt-out/offline and JSON/privacy behavior.
- #346: injected manifest/lock/resolution tests for matched applicable packages,
  mismatch/missing module, hidden-lock false assurance, unsupported/absent lock,
  omitted dev/platform optional packages, source versus npm and independent Doctor
  failures. Loader tests distinguish missing module from native rule/evaluation error,
  sanitize paths/messages and preserve the chosen engine and public error code.
- Both: packaged and linked-source smoke fixtures in temporary directories, no live
  credentials or source installs changed. No network or filesystem mutation occurs
  in a diagnostic. Runtime settings, help and recovery syntax agree across surfaces.

Existing S complexity/M impact estimates remain the current starting estimates for
both tickets. If inspection shows broader required-module integrity/lock support is
needed, revise complexity with explicit evidence rather than claiming a narrow check
proves every dependency correct.
