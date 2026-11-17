# Global configuration service (#804 slice 1)

Anouk Moreau — implementation on `feat/804-global-config-service`.

#804's documentation phase landed in PR #848 (doc/design/configuration-service.md, merged
2026-11-17). This slice implements the transport-neutral per-OS-user global configuration
service and wires it into `pdb config --scope global`.

## What shipped

- `src/config/globalconfig.ts`: per-user global configuration service — directory resolution
  (`PDB_CONFIG_DIR` override, else `env-paths("pdb").config`), typed key registry
  (`serve.port`, `serve.ttl`, `serve.projects`), typed defaults/validation, read-only load,
  revisioned in-memory change comparison (`globalChanges`) and safe locked atomic writes
  (non-stealing file lock, exclusive same-directory temp + rename, intervening-edit conflict
  detection). Reads never create a file; malformed/future TOML is refused.
- `src/config/configcli.ts`: `pdb config get|set|list --scope global` routes to the global
  service; identity keys, `--entry`/`--harness` and `convert` are refused in the global scope.
- Tests: `src/config/globalconfig.test.ts` (16 injected-filesystem cases: scope separation,
  defaults, typed validation, malformed/future TOML, no-op and reverted edits, stale saves,
  concurrent writes, round-trip) plus a CLI-level global-scope case in `config.test.ts`.

## Workflow

Claimed with `pdb claim 804 --agent anouk_moreau`; issue #804 remains open (the repository
scope, revisions plumbing into serve, and the config CLI surface #815 are separate follow-ups).
Checks: `npm run check`, `npm test` (2806 passed, 1 skipped), `npm run build` all green; smoke
verified against the built `dist/cli.mjs` with an injected `PDB_CONFIG_DIR`.

## Next

Follow-up slices under the merged architecture: `serve.projects` resolution/registration
reuse (#805), repository-scope parity of change reports, and the config CLI polish (#815).
