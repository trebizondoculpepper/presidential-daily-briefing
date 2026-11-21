# Developer-server spike: Vite+ HMR and supervised backend reload (#791)

Status: spike result. The prototype under `spike/dev-server/` is experimental and is not wired into
`npm run dev`, the production build, `pdb serve` or the package. The proposed contract is
[dev-server.md](../design/dev-server.md); it is a proposal for review, not shipped behaviour.

## What was asked

Make PDB serve development a normal Vite+/TypeScript loop: genuine UI HMR (no full document
reload), a backend edit that changes a live API response, existing PDB services as the only source
of API behaviour, and bounded evidence about lifecycle, isolation and security. Keep the experiment
inside the pinned toolchain, not a framework survey.

## Environment

| Item      | Value                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool      | `vp` (vite-plus) 1.5.0, Vite core `@voidzero-dev/vite-plus-core` 1.5.0                                                                         |
| Svelte    | `svelte` 5.58.0, `@sveltejs/vite-plugin-svelte` 7.3.1                                                                                          |
| Node      | 26.7.0 (macOS, arm64)                                                                                                                          |
| Prototype | `spike/dev-server/` (`index.html`, `src/Counter.svelte`, `src/store.svelte.ts`, `src/main.ts`, `server.ts`, `supervise.mjs`, `serve-entry.ts`) |

`vp dev` is the built-in dev server (arguments forwarded to Vite); `vp run dev` is the task runner
that would invoke a `dev` script. The distinction matters for the contract: the HMR proof uses
`vp dev` directly, while the proposed single entry point is `npm run dev` → a `vp run dev` task that
supervises both halves.

## 1. Frontend HMR (no document reload)

```sh
npx vp dev spike/dev-server --config spike/dev-server/vite.config.ts
# VITE+ v1.5.0  ready in 389 ms
# ➜ Local: http://127.0.0.1:5199/
curl -s http://127.0.0.1:5199/src/Counter.svelte | head -1
# import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = ...
```

A headless probe (`/tmp/hmr-probe.mjs`, reproduced by the steps below) connects to the HMR socket
(`ws://127.0.0.1:5199/`, subprotocol `vite-hmr`), edits the component, and records what arrives:

```json
{
  "connected": true,
  "updates": [["/src/Counter.svelte"]],
  "fullReload": false,
  "editToUpdateMs": 205
}
```

So a component edit produced a real HMR `update` for the module with **no `full-reload` message**,
205 ms after the write.

### Which UI state survives (checked in a real browser)

Using the browser against the same dev server, clicking the button to 2 and then editing the
component:

| Edit                                                                     | Observed after the edit            | Document URL |
| ------------------------------------------------------------------------ | ---------------------------------- | ------------ |
| `$state` local to the component, template text edited                    | text updated, **count reset to 0** | unchanged    |
| state moved to `src/store.svelte.ts` (module `$state`), component edited | text updated, **count stayed 2**   | unchanged    |

Both edits applied without navigation, so the HMR path is genuine. The finding that shapes the
contract: with these pinned versions a **component edit re-instantiates the component**, so
component-local `$state` is lost; state held in a module survives a component edit. The dev server
must therefore treat module-level state as the HMR-durable seam and should not promise that
page-local component state survives an edit.

## 2. Backend edit changes a live API response

Two supervised proofs on disposable loopback ports (never 4372, never the user's running server):

```sh
PDB_SPIKE_PORT=5198 node spike/dev-server/supervise.mjs \
  spike/dev-server/server.ts spike/dev-server/server.ts
curl -s http://127.0.0.1:5198/api/answer
# {"answer":"v1","escaped":"&lt;b&gt;&amp;"}      ← escapeHtml comes from src/serve/rules-page.ts
# edit `answer` to "v2"
curl -s http://127.0.0.1:5198/api/answer
# {"answer":"v2","escaped":"&lt;b&gt;&amp;"}
```

The same supervisor runs the real backend from source:

```sh
node spike/dev-server/supervise.mjs spike/dev-server/serve-entry.ts src
# pdb serve 0.1.0 listening on http://127.0.0.1:5197/
```

A touch/edit of `src/serve.ts` restarted it and the server answered again:

```json
{
  "before": "2026-11-21T03:10:54.156Z",
  "after": "2026-11-21T03:11:00.566Z",
  "changed": true,
  "restartMs": 1277
}
```

Distinctions recorded, as the ticket asks:

- **Frontend HMR**: module update in ~205 ms, no navigation, no backend involvement.
- **Backend restart**: whole process restart, ~1.3 s from edit to a fresh `startedAt`; the in-memory
  cache is lost (which `pdb serve` already reports: "cache: memory only, ttl 5m; restart clears it").
- **Browser reload**: not needed for either; a full reload is only what the old loop forced.

## 3. Before/after edit-loop measurement

| Loop                    | Measured                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Before: frontend change | `npm run build:web` **2.9 s**, then a manual browser refresh (page state lost)        |
| Before: backend change  | `npm run build` **3.9 s** + restart `pdb serve` from `dist` (**0.65 s** to first 200) |
| After: frontend         | HMR update **205 ms**, no refresh                                                     |
| After: backend          | supervised restart **1.3 s**, no rebuild                                              |

These are single observations on one machine, not a benchmark suite.

## Lifecycle, isolation and security findings

- **Ports**: the prototype bound `127.0.0.1` only (5197 backend, 5198 spike backend, 5199 assets,
  5196 an earlier disposable check) and never touched 4372. The contract keeps loopback-only
  listeners and an explicit port choice.
- **Cancellation/cleanup**: `SIGINT` and `SIGTERM` share one shutdown path that forwards the same
  signal to the child and waits for it before exiting. Verified: with the spike backend listening on
  5198 (`node 61054 ... TCP 127.0.0.1:5198 (LISTEN)`), `kill -TERM <supervisor>` left **no
  supervisor process and no listener** (`0 process`, `0 line(s)` from `lsof`), so the next run can
  bind the port again. Requests in flight are aborted by process exit — the same boundary `pdb
  serve` already has, so the dev server does not add a second lifecycle owner.
- **Restart serialisation**: the replacement is spawned only after the old child's `exit`, because
  `SIGTERM` is asynchronous and a fast replacement would race the old process for the port. Verified
  with a child that delays exit by 700 ms: one `restart` line, one new `slow child on 5195`, no
  `EADDRINUSE`. A 3 s SIGKILL guard bounds a child that ignores the signal.
- **Shutdown vs restart**: shutdown sets a stopping flag before anything else, so a signal that
  arrives while a restart waits for the old child cannot spawn a replacement that shutdown would
  orphan. Verified: terminating during a pending restart left no supervisor, no child and no
  listener. A child killed externally (`signalCode`, `exitCode` null) is still recognised as
  exited, so the next edit restarts it (verified with `kill -KILL` + edit: a new listener came up).
- **Failed edits**: a TypeScript error keeps the last good backend process only if the supervisor
  refuses to restart on a failed start; the prototype currently restarts on every write and logs
  `backend exited 1`. The contract requires "keep the last good process, report the error, retry on
  the next successful edit".
- **Cache and sessions**: a backend restart clears the in-memory cache and any MCP session, so a
  developer must expect a cold cache after a backend edit; the assets half keeps its module graph.
- **Watch scope**: the prototype watched exactly the paths it was given. The contract excludes
  `pdb.toml`, `agent-*.toml`, `.git`, `node_modules`, `dist`, cache/log directories and any
  identity/private configuration, so a dev server cannot leak or churn private state.
- **Isolation**: no identity is created, no GitHub mutation is performed and no project context is
  changed; the spike reused an existing authenticated `gh` session exactly as `pdb serve` does.

## Limitations (honest)

- State survival was verified for the two edit shapes above only; other component changes (props,
  store shape, `$props` signature) may behave differently.
- Restart timing was measured on macOS; Windows/FreeBSD were not exercised.
- The supervisor is 40 lines and demonstrates the mechanism, not a production-grade runner (no
  debounce coalescing beyond 150 ms, no failure backoff, no source-map-aware stack mapping).
- No CSP/Host/Origin hardening was implemented; the prototype serves a disposable page. The
  contract states what must be decided before production.

## Recommendation and revised estimate

1. Ship `npm run dev` as a `vp run dev` task that (a) starts `vp dev` with a dev-only config for the
   one HMR seam and (b) supervises the existing `pdb serve` entry from source, keeping the last good
   backend on a failed edit.
2. Keep the seam minimal: the API-first Svelte pages (`src/web/*/main.ts`) are already a real
   module boundary; no page rewrite is needed to get HMR.
3. Revised estimate for the follow-up implementation ticket: **complexity M / impact M** — one dev
   config, one supervisor script, watch exclusions, failure recovery, a loopback/CSP decision and
   focused tests, with the reviewed contract as the gate.
