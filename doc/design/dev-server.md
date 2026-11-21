# Proposed developer server: one command, HMR, supervised backend

Status: **proposal** for #791, grounded in the [spike report](../reports/dev-server-spike.md).
Implementation follows in #792 once this contract is reviewed.
Nothing in this document is implemented; the prototype under `spike/dev-server/` is experimental and
must not be treated as the shipped design. This contract must be reviewed and merged before
production code, per the issue's review gate.

## Goal

A developer changes a component and sees it update in the browser without a document reload, changes
a backend module and sees the API response change without a rebuild, and runs both from one command.
Installed `pdb serve` stays exactly as it is for normal use.

## Shape

- **Entry point**: `npm run dev` runs a `vp run dev` task. `vp dev` alone remains the built-in Vite
  dev server and is what the task starts for assets; the task adds the supervised backend. The two
  are different commands and the contract keeps them distinct.
- **Two halves, one supervisor**:
  1. **Assets** — `vp dev` with a development-only config that serves the existing `src/web/*/main.ts`
     entries. This is the smallest real browser-module seam; no page rewrite, no SSR migration, no
     change to the built `dist/web` pipeline.
  2. **Backend** — the existing `pdb serve` entry executed from source (`tsx`), supervised: on a
     watched edit the child is restarted. Server module replacement is explicitly out of scope
     until it is shown to be simpler and safe.
- **Reuse, never reimplement**: API behaviour continues to come from the same services, native
  policy and startup/close boundaries as `pdb serve`. The dev server must not add a
  development-only collector, policy engine, ranker or cache. It passes the same flags
  (`--repo`, `--role`, `--entry`) as the installed command.

## Ports, binding and lifecycle

- Loopback only (`127.0.0.1`), on ports chosen by the task (defaults: assets 5199, backend 5197) and
  refused if already in use (`strictPort`), so the developer's normal serve on 4372 is never
  disturbed or killed.
- One process tree: the supervisor owns the backend child, forwards `SIGINT`/`SIGTERM`, and exits
  only after the child has exited. No detached processes, no orphan listeners.
- **Failed edits**: a backend that fails to start (TypeScript error, port in use) must leave the
  previous good process serving, print the failure once and retry on the next successful edit.
  Restart debounce must coalesce editor write bursts.
- Requests in flight at restart are aborted with the child; the dev server adds no second lifecycle
  owner and promises no request replay.
- Cache and sessions: a backend restart clears the in-memory cache and any MCP session. The task
  says so on startup rather than hiding it.

## Watch scope

Watch the backend's source inputs only. Never watch `node_modules`, `dist`, `.git`, cache or log
directories, or any identity/private configuration (`pdb.toml`, `agent-*.toml`, `agent-inbox.toml`);
a dev server must not churn or expose private state. Assets are watched by Vite's own graph.

## Security

- Development listeners are loopback-only; no `--host` default, no LAN exposure.
- The asset dev server keeps Vite's HMR WebSocket on the same origin. Any CSP relaxation is
  development-only and must not be applied to `pdb serve`; the normal Host/Origin checks, repository
  allowlist and CSP stay in force for the API half.
- The dev server must not serve arbitrary project files: only the dev entries, the module graph they
  import and the loopback API. No directory listing, no `/@fs` escape outside the repository.
- No identity creation, client installation, GitHub mutation or model session is part of `dev`.

## HMR expectations

- A component edit must produce a module update with no document navigation.
- The spike found that component-local `$state` is lost on a component edit while module-level
  `$state` survives, on the pinned toolchain. The contract therefore treats module state as the
  durable seam and documents the limitation instead of promising more.
- A backend edit is a restart, not hot replacement; the API response after restart is the proof.

## Acceptance cases

1. One command starts both halves on disposable loopback ports; `pdb serve` on 4372 is untouched.
2. Editing a page component updates it without a document reload, with module-level state intact.
3. Editing a backend module changes an existing API response after an automatic restart; a failing
   edit leaves the last good process serving and reports once.
4. Interrupting the task exits both children and frees both ports.
5. Watch exclusions hold: touching an identity or cache file does not restart the backend.
6. The built pipeline, `npm test`, packaging and `pdb serve` behaviour are unchanged.

## Packaging impact

The dev config, supervisor and dev-only dependencies stay out of the published archive: the
`files` allowlist is explicit and the spike directory is not built. A follow-up implementation PR
must re-run the package test to prove the archive is unchanged.

## Smallest implementation and estimate

One dev config, one supervisor script, watch exclusions, failure recovery, the loopback/CSP decision
above and six focused tests. **Complexity M / impact M**, assuming this contract is accepted; no
change to the default serve command, the package contents or the production frontend build.
