# Development Diary Entry - 2026-11-21

## Context

- **Date**: 2026-11-21
- **Branch**: feat/818-configuration-page-v2
- **Contributors**: OpenCode (anouk_moreau)

## Problem Statement

#818 asks for a read-only Configuration page (Global and per-serving-project scope) rendered by
`pdb serve` through #804's shared configuration service, with focused regression coverage,
accessible UI, a shared-shell tab and no read of TOML in the page. A first attempt (PR #952,
closed unmerged) built the page as a backend TS template and carried 4 review findings: a P1
requiring frontend-owned markup/assets, `?repo=` refused by the API helper, the selected
repository not read from the shell's main element, and Global scope lost to the shared
project-selection auto-redirect.

## Our Approach

Re-implemented from scratch on the current API-first architecture (the Rules page pattern):
a Svelte component under `src/web/configuration/`, a static bootstrap served at `/configuration`
that mounts it, and a versioned `/api/v1/configuration` route returning the shared service's
`ConfigurationView` (value/default/source/type/description, plus `ok | unsupported | degraded`
readable states). Global is the default scope; `?repo=` selects one served repository. The page
declares `data-project-selection="none"` on its main element and the shared
`project-selection.ts` honours it, so opening the page keeps Global unless a project is chosen
explicitly.

Implementation skew from #952: `loadGlobalConfig` and `GLOBAL_KEYS` already exist on main
(global `config.toml` shipped for #804), so the page reads real per-OS-user global settings and
a served checkout's repository settings. The API validates only the page's own `repo` parameter
and reuses `selectRepository`, so unserved repositories refuse with the shared code/status.

## Verification

- 26 new focused tests (configuration view, read API, bootstrap, project-selection opt-out,
  Svelte client) plus the existing shell/webassets/serve suites: 43 files / 454 pass in the
  serve+web slice.
- TSC, `vp check` and `npm run build` clean; the page asset builds in the `build:web` step.
- Live smoke test: `pdb serve --port 4399 --project <worktree>` → `/configuration` 200 with
  app mount and assets; `/api/v1/configuration` 200 with Global rows; `?repo=...` 200 with the
  project's settings; bad parameter 400; unknown repository 403; toolbar reports "Scope: Global".
- `npm test` full-suite run in progress at write time.

## Next Steps

Merge this slice (#818) after the acceptance gate; the later editor (save/reset, project
registration editing, reload/shutdown) remains out of scope per the ticket's split.
