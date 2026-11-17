# Contributing

Open an issue describing a reproducible problem or scoped feature before substantial changes. See [HANDOFF.md](HANDOFF.md) for the initial backlog and the [agent guide](AGENTS.md) for architecture and project conventions.

Use Node 26+ (the current LTS; see doc/design/runtime.md) for development and use, npm and Vite+. Run `npm install`, then `npm run check`, `npm test` and `npm run build`. The pre-commit hook checks staged files. Tests should run without GitHub credentials; reproduce live issues using your own `gh` session without committing tokens or full private snapshots.

Submit a focused pull request using the template: link its issue and explain behavior, validation and limitations. Every change to `main` goes through a pull request, and the `verify` check must pass on its current head before it can merge; pull requests from forks run the same credential-free checks with read-only permissions ([repository settings](doc/repository-settings.md)). Merge also requires a clean current-head automated review from Codex or CodeRabbit and no unresolved substantive findings ([review gate](doc/design/review-gate.md)). Architectural contract changes go through a docs PR first. Contributions are under the project's MIT license. Releases are described in [npm releases](doc/npm-releases.md).

The owner-requested process mirrors from poker_blocks remain contextual proposals: [ticket-to-merge process](doc/process.md) and [design/implementation responsibilities](doc/design-implementation.md). The completed [adaptation audit](doc/reports/process-adaptation-audit.md) for [#12](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues/12) retains AGENTS.md and the focused merged contracts as the active process.
