# Agent guide

Applies to every coding/review agent on all supported platforms. `CLAUDE.md` is a
compatibility entry point to this guide. Work in this standalone PDB repository,
not its historical game-repository source.

Read [HANDOFF.md](HANDOFF.md), then the main
[architecture guidelines](doc/architecture.md). Read the
[agent workflow](doc/agent-workflow.md) before intake, changes, checks or delivery.
Detailed [feature contracts](doc/design/README.md) refine the architecture;
[research](doc/research/README.md) explains decisions without overriding them.

## Working rules

- Use the project's PDB toolchain for supported intake, claims, dependencies,
  estimation and diagnostics; check current `--help`. Use GH only for unsupported
  operations, missing evidence or PDB diagnosis.
- Recheck human ownership, claims and native blockers before pickup. Preserve
  other agents' work. Own PR follow-up comes first; finish review/CI and merge
  rather than stopping at an open PR. Prefer small, focused tickets and changes.
- English prose; strict TypeScript application code; private `pdb.toml`, tokens,
  identity/config files and live snapshots stay out of the public repository.
  Use config/setup commands and existing authentication; no external check-in.
- Architecture changes require a reviewed docs PR before implementation; reuse
  accurate merged contracts. Close tickets only when their acceptance is met.
- Docs-only: `npx vp fmt --check`. Executable/config or mixed changes: `npm run
  check`, `npm test`, `npm run build`, with appropriate smoke/package checks. Use
  installed Vite+ hooks, never bypass them. Keep significant work in `diary/`.
- Required CI must pass on the exact PR head and Codex **or** CodeRabbit must have
  completed a clean review of that head. Resolve substantive findings from either;
  missing/skipped/stale review is not approval. Never force/admin-bypass checks.
  Merging is not publication; a release requires explicit owner authorization.

## Code Review Rules

- Architectural consistency with [doc/architecture.md](doc/architecture.md) is the
  primary review target. Read the shared [review prompt](.github/review-guidelines.md)
  and relevant feature contracts before assessing the diff.
- Prioritize new service/state-owner duplication, adapter bypasses, thick
  controllers, native-policy forks, broken typed/evidence boundaries and context
  leaks. Cite the changed code, principle and concrete consequence.
- Distinguish existing migration debt from new drift; avoid unrelated rewrites
  and style-only noise. Still report material correctness, data-loss, security
  and compatibility regressions. Follow [the merge gate](doc/design/review-gate.md).
