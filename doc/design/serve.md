# `pdb serve`: local HTTP server, memory cache and HTTP MCP

Architecture contract for #372, the design slice of #42. Implementation is #373 (server and cache) and #390 (HTTP MCP); the dashboard is #374. This document is binding for those tickets once merged; it does not claim any of it is shipped.

**Status (#373).** Implemented in four stacked PRs: #435 (skeleton and lifecycle), #438 (cache and read API), #439 (HTTP MCP) and the docs PR. The defaults this document leaves to the owner are single named constants in `src/serve/options.ts` (`DEFAULT_PORT`, `DEFAULT_TTL_MS`, `STALE_WINDOW_MS`) and `src/serve/cache.ts`/`src/serve/mcp.ts` (entry, byte, concurrency and session bounds). Recorded interpretations: `who` and `team` read the cached snapshot entries shared with the briefing and apply `staleHours` per request; refresh `scope` accepts `all`, `briefing`, `issues`, `who`, `team`, `deps`, `prs` and (#454) `tickets`; the JSON envelope gains a `warnings` array for the stale warning; HTTP MCP adds the freshness block inside the existing envelope `freshness` record as `freshness.cache`, because the version-2 envelope is a strict object that already carries a `freshness` field; on Windows only console Ctrl-C/Ctrl-Break shut down gracefully, a kill from another process terminates at once. The real-client Claude Code verification below is recorded in [serve-http-mcp-acceptance.md](../reports/serve-http-mcp-acceptance.md).

## Contents

- [Owner decisions this contract implements](#owner-decisions-this-contract-implements)
- [Research summary](#research-summary)
- [Command line](#command-line)
- [HTTP surface](#http-surface)
- [Caching](#caching)
- [Security](#security)
- [Identity and project selection](#identity-and-project-selection)
- [Testing and acceptance](#testing-and-acceptance)
- [Delivery plan for #373](#delivery-plan-for-373)
- [Owner questions](#owner-questions)

## Owner decisions this contract implements

From #42 "Superseding owner decisions (2026-11-14)", the owner clarifications on #372/#373 and [local-service-and-rule-testing.md](local-service-and-rule-testing.md):

- `pdb serve` is a foreground command of the existing npm package, running under Node with the host's authenticated `gh`. No Docker, daemon installation, service registration, persisted cache, snapshot file or database.
- One memory-only cache of whole collected results. Five-minute initial TTL, configurable up to ten minutes. A restart clears everything.
- Concurrent identical reads are coalesced. Entries are isolated by repository, authentication context and evidence coverage; role and identity projections are computed per caller and never shared.
- Freshness and failure are visible on every result; explicit refresh exists; every mutation keeps its own live verification and never consumes cached facts.
- Minimal local HTTP lifecycle: port, localhost binding, shutdown and project selection. The existing collector and ranker are shared by the JSON read API, the dashboard (#374) and HTTP MCP (#390).
- No inactivity lease in v1. No new background polling architecture. Generic HTTP MCP precedes platform stop-hook prototypes.

The #42 ticket body's lease, backoff and proactive-collection language is superseded by those decisions. This contract finds no concrete need for a lease in v1: the process is foreground, owned by the user's terminal, and holds no state worth expiring beyond the cache TTL.

## Research summary

Current boundaries the server reuses rather than replaces:

- **Read service.** `src/briefing/service.ts` exposes `readBriefing(runtime, request)` and `readDependencies(...)` over an injected `ReadRuntime` (`collect`, `dependencyReport`, `rest`, `queryWith`, `now`, `redactDiagnostic`, `guide`, `estimation`). CLI and stdio MCP already call these directly. `pr`, `who` and `team` are CLI-only today; #373 extracts them into the same transport-neutral service shape before exposing them (no CLI subprocesses, no text parsing).
- **MCP.** `src/mcp.ts` builds a fresh `McpServer` per connection through `createServer(options, runtime, version)` and serves it with `serveStdio(factory)`. Tools are read-only: `triage_briefing`, `triage_issue`, `triage_dependencies`, `triage_events`, returning the version-2 bounded envelope of [mcp-bounded-results.md](mcp-bounded-results.md) within 16,384 bytes. Selection follows [mcp.md](mcp.md) including the #271 rule: no repository from the process cwd.
- **SDK.** `package.json` pins `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0. The server package exports `createMcpHandler` (a web-standard `Request` to `Response` handler), `WebStandardStreamableHTTPServerTransport` (with `allowedHosts`, `allowedOrigins` and `enableDnsRebindingProtection`), and helpers `validateHostHeader`, `validateOriginHeader`, `localhostAllowedHostnames` and `localhostAllowedOrigins`. These implement the MCP Streamable HTTP transport; we invent no framing.
- **Coalescing.** `sharedCollect` in `src/mcp/polling.ts` already shares one in-flight unfocused collection per repository with a reference-counted abort, so a cancelled waiter does not cancel others. It caches nothing after completion. The server generalises this into the keyed cache below.
- **Polling.** The opt-in `--poll` watcher of [polling-events.md](polling-events.md) is a per-process timer bound to one explicit repository. `pdb serve` does not start it in v1 and adds no other background collection: data is fetched only when a request (or explicit refresh) needs it.
- **Cache research.** [cache-experiments.md](cache-experiments.md) and the #202/#203 reports ([refresh](../reports/cache-refresh-experiment.md), [storage](../reports/cache-storage-experiment.md)) studied incremental page/manifest caches and persisted storage. The owner rejected both page caching and persistence for this slice (#380 settlement), so the server caches whole results only. Their findings on volatile facts reinforce the rule that mutations re-read live.
- **Degradation.** #369 (stale-result degradation contract) is not merged. This document states an interim rule under [Failure behaviour](#failure-behaviour) and defers to #369 once it lands.

## Command line

```text
pdb serve [--port N] [--host ADDR] [--allow-remote] [--ttl DURATION]
          [--repo owner/name]... [--project PATH]...
          [--agent NAME] [--entry KEY | --harness NAME]
```

| Option                            | Default     | Validation                                                                                                                                  |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port N`                        | `4372`      | Integer 0–65535. `0` asks the OS for an ephemeral port (tests).                                                                             |
| `--host ADDR`                     | `127.0.0.1` | Literal IP address or `localhost`. Loopback (`127.0.0.0/8`, `::1`, `localhost`) is always allowed. Anything else requires `--allow-remote`. |
| `--allow-remote`                  | off         | Only meaningful with a non-loopback `--host`; see [Security](#security).                                                                    |
| `--ttl DURATION`                  | `5m`        | Parsed with the existing `parseDuration`. Accepted range 1m–10m inclusive; outside the range is a usage error, never silently clamped.      |
| `--repo owner/name`               | none        | Repeatable. Existing owner/name validator.                                                                                                  |
| `--project PATH`                  | none        | Repeatable. Absolute path to a local checkout; resolved to its repository at startup with the existing resolver.                            |
| `--agent`, `--entry`, `--harness` | none        | Same meaning and validators as `pdb-mcp`; startup identity defaults.                                                                        |

At least one `--repo` or `--project` is required. Without one the command exits with status 2 and the guidance `pdb serve needs --repo owner/name or --project /absolute/project/path`; it never serves the cwd repository (#271). The union of startup repositories is the **served set**; see [Identity and project selection](#identity-and-project-selection).

Startup sequence, in order: parse and validate arguments; resolve every `--project` to a repository (failure exits 2 naming the path); resolve the authentication context once (`gh auth status`/`gh api user` through the existing argument-array runner; failure exits 1 with "run gh auth login"); bind the listener; print the banner. No GitHub data is collected at startup.

The banner goes to **stdout**, one line per fact, so scripts and humans can read it:

```text
pdb serve 0.4.0 listening on http://127.0.0.1:4372/
  repositories: owner/one (default), owner/two
  cache: memory only, ttl 5m; restart clears it
  mcp: http://127.0.0.1:4372/mcp
  stop: Ctrl-C
```

The first line is stable and machine-parsable (`listening on <url>`), and with `--port 0` it carries the actual bound port. Logs (one line per request: method, path, status, cache source, duration; never query values that could carry local paths, never headers) go to **stderr**.

**Port conflict.** If `listen` fails with `EADDRINUSE` the process exits with status 3 and `pdb serve: port 4372 on 127.0.0.1 is already in use; is another pdb serve running? Stop it or pass --port N (0 picks a free port).` It does not probe for another free port: a silently different URL would break configured MCP clients. `EACCES` exits 3 with a similar message. Other startup errors exit 1.

**Signals and shutdown.** SIGINT and SIGTERM (and Ctrl-Break on Windows via SIGBREAK) start a graceful shutdown: stop accepting connections, abort every in-flight collection through its `AbortController` (which terminates running `gh` children, as for stdio MCP cancellation), close MCP sessions, wait up to 5 seconds for open responses, then exit 0. A second signal exits immediately with status 130. Shutdown discards the cache; nothing is written to disk. Stdin EOF does not stop the server (it is a terminal process, not a stdio protocol). There is no `--daemon`, pid file or detach.

## HTTP surface

All routes are under one origin. JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`. Unknown query parameters are rejected (400), matching the strict-object rule of the MCP inputs. Only `GET` for reads, `POST` for refresh and MCP; other methods return 405 with an `Allow` header.

### Read API

| Path                                  | Query                                                                                                                                                   | Result (`result` field)                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/briefing`                | `repo?`, `agent?`, `entry?`, `harness?`, `role?` (`implementer`/`designer`), `order?` (`impact`/`oldest`/`newest`), `since?`, `limit?` 1–100 default 10 | Existing compact briefing JSON, the same object as CLI `--json` with the same flags                                  |
| `GET /api/v1/issues/{n}`              | `repo?`, `agent?`, `entry?`, `harness?`, `includeTransferred?`                                                                                          | Existing issue intake JSON (CLI `--issue N --json`); unavailable issues return the existing diagnosis                |
| `GET /api/v1/issues/{n}/deps`         | `repo?`, `tree?` boolean                                                                                                                                | Existing native dependency report (CLI `deps N --json`)                                                              |
| `GET /api/v1/prs/{n}`                 | `repo?`, `history?` boolean                                                                                                                             | Existing PR diagnosis JSON (CLI `pr N [--history] --json`)                                                           |
| `GET /api/v1/issues/{n}/who`          | `repo?`, `staleHours?`                                                                                                                                  | Existing `who N --json` report                                                                                       |
| `GET /api/v1/tickets/{n}`             | `repo?`, `agent?`, `entry?`, `harness?`, `platform?`, `limitPrs?` 1–100 default 10                                                                      | `ticket-status` document of `pdb ticket N --json` (#454, [consolidated-ticket-view.md](consolidated-ticket-view.md)) |
| `GET /api/v1/team`                    | `repo?`, `staleHours?`                                                                                                                                  | Existing `team --json` report                                                                                        |
| `GET /api/v1/status`                  | none                                                                                                                                                    | Server status (below)                                                                                                |
| `GET /healthz`                        | none                                                                                                                                                    | `{"ok":true}` with 200 while accepting requests; 503 during shutdown. Never touches GitHub.                          |
| `POST /api/v1/refresh`                | body `{"repo"?: string, "scope"?: "all" \| "briefing" \| ...}`                                                                                          | Drops matching entries and returns the evicted count; see [Refresh](#refresh)                                        |
| `POST`/`GET`/`DELETE /mcp`            | MCP Streamable HTTP                                                                                                                                     | HTTP MCP endpoint                                                                                                    |
| `GET /`                               | none                                                                                                                                                    | The read-only dashboard (#374); see [Dashboard](#dashboard)                                                          |
| `GET /rules`                          | `repo?`, `role?`, `rule?`                                                                                                                               | The read-only project rules page (#392); see [Rules page](#rules-page)                                               |
| `GET /dashboard.js`, `/dashboard.css` | none                                                                                                                                                    | The dashboard's script and stylesheet, same-origin                                                                   |

The JSON API returns full existing CLI JSON, not the MCP 16 KiB bounded envelope; the byte budget is an MCP client constraint. A response size guard of 4 MiB returns 500 `RESULT_TOO_LARGE` rather than streaming unbounded data. `--full`, `--cache`, `--offline` and `--checkpoint` are not exposed: they are file and checkpoint features with no place in a shared server. The `briefing` (catch-up) mode and `triage_events` are not in the v1 JSON API; they remain reachable through MCP exactly as over stdio.

Envelope, for every `/api/v1/*` data route:

```json
{
  "schemaVersion": 1,
  "kind": "serve-read",
  "view": "briefing",
  "status": "complete",
  "selection": {
    "repository": "owner/repo",
    "agent": "kavya_sabbagh",
    "identitySource": "tool",
    "triageRole": "implementer",
    "entry": null,
    "identityDiagnostic": null
  },
  "freshness": {
    "source": "cached",
    "observedAt": "2026-11-14T22:01:07.000Z",
    "ageSeconds": 83,
    "ttlSeconds": 300,
    "expiresAt": "2026-11-14T22:06:07.000Z",
    "stale": false,
    "refreshError": null
  },
  "result": {},
  "error": null
}
```

`selection` reuses the MCP `selectionSchema` from `src/mcp/bounded.ts`. `status` is `complete`, `incomplete` or `error`, with the same meaning as the MCP envelope: incomplete source evidence stays incomplete and is never presented as clean. `result` is the unchanged versioned CLI JSON, so its own schema version, completeness, evidence and omissions are preserved. `freshness.source` is `live` (collected for this request, possibly coalesced with other waiters), `cached` (served from an unexpired entry) or `stale` (see failure behaviour). `ageSeconds` is computed from the injected clock at response time.

Error envelope: same shape with `status: "error"`, `result: null`, and `error: {"code": "...", "message": "...", "next": ["..."]}` using sanitized messages (no stack, no raw `gh` stderr, no local paths; existing `redactLocalText`). Status codes:

| HTTP      | `error.code`                                                 | When                                                                                         |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 400       | `INVALID_ARGUMENT`                                           | Bad or unknown query parameter, invalid number, `role` with an unsupported view              |
| 400       | `REPOSITORY_UNRESOLVED`                                      | No `repo` and more than one served repository; `next` lists `?repo=` choices                 |
| 403       | `REPOSITORY_NOT_SERVED`                                      | `repo` outside the served set                                                                |
| 403       | `FORBIDDEN_ORIGIN` / 421 `MISDIRECTED_HOST`                  | Origin or Host check failed                                                                  |
| 404       | `NOT_FOUND`                                                  | Unknown route                                                                                |
| 404 / 410 | (none)                                                       | Not used for unavailable issues: those are 200 with the existing diagnosis in `result`       |
| 413       | `BODY_TOO_LARGE`                                             | Request body over 64 KiB                                                                     |
| 415       | `UNSUPPORTED_MEDIA_TYPE`                                     | `POST` without `application/json`                                                            |
| 502       | `GITHUB_UNAVAILABLE` / `GITHUB_AUTH` / `GITHUB_RATE_LIMITED` | Collection failed and no stale result may be served; `next` gives the CLI command to inspect |
| 503       | `SHUTTING_DOWN`                                              | Request arrived during shutdown                                                              |
| 500       | `INTERNAL` / `RESULT_TOO_LARGE`                              | Unexpected failure; message sanitized                                                        |

`GET /api/v1/status` returns `kind: "serve-status"` with version, `startedAt`, bound URL, served repositories (marking the default), TTL, authentication context as host and login only, cache counters (`entries`, `approxBytes`, `hits`, `misses`, `coalesced`, `evictions`, `inflight`), and per repository the most recent `observedAt`, the last error code and time. It never contains tokens, environment, paths or file contents.

### HTTP MCP

Path `/mcp`, Streamable HTTP as provided by `@modelcontextprotocol/server` 2.4.0. Implementation uses the SDK's `createMcpHandler` (or `WebStandardStreamableHTTPServerTransport` if the handler cannot express the session behaviour below), adapted to `node:http` by converting `IncomingMessage` to a web `Request` and streaming the `Response` back. Adding a framework (Express, Hono) or the separate Node adapter package needs justification in the PR; the conversion is small and Node 26 has native `Request`/`Response`.

- **Same tools, same server factory.** The factory is the existing `createServer(options, runtime, version)` with a runtime whose `collect`, `dependencyReport` and auxiliary reads go through the server cache. Tool names, input schemas, the bounded version-2 envelope and annotations are unchanged, so stdio `pdb-mcp` and HTTP MCP give identical results for identical facts. Bounded envelopes gain the `freshness` object as an additive field.
- **Sessions.** Stateful sessions with `sessionIdGenerator: () => crypto.randomUUID()`. Each session owns its `McpServer`, its client info (used for harness-based identity) and nothing else; repository and identity are re-resolved per call as over stdio. `DELETE /mcp` with the session header closes it. Idle sessions are dropped after 30 minutes without a request, and at most 64 sessions exist (the oldest idle is closed first); an unknown session ID returns 404 so clients re-initialize, which is the specified reconnect path. Dropping a session never drops cache entries.
- **Cancellation.** A client `notifications/cancelled` or a closed HTTP request aborts that call's signal. Through the reference-counted coalescing, the shared collection is aborted only when no other waiter (JSON or MCP) remains.
- **Notifications.** No server-initiated notifications are required by any tool; clients without SSE support work through single JSON responses.
- **Stdio unchanged.** `pdb-mcp` keeps working exactly as now, with its own process and no cache. HTTP MCP is an additional entry point, not a replacement.

### Dashboard

`GET /` is the read-only dashboard (#374). It reads only `GET /api/v1/status` (the project selector) and `GET /api/v1/briefing` (the selected view). Ranking, reasons, rule IDs and commands come from the shared engine; the page orders and chooses nothing.

- Select a project, a role (`implementer` or `designer`) and optionally an agent. The selection is kept in the page URL (`?repo=…&role=…&agent=…`), so a view can be bookmarked. With one served repository it is preselected. With several and none in the URL, nothing is fetched until a project is chosen.
- Only the view the user opened is fetched: on load (when a project is known), on **Show**, or when the project or role changes. There is no background prefetch or polling. **Refresh** repeats the request with `refresh=true`.
- The list is the briefing's `rankedActions` in server order, with titles, reasons, rule IDs, `nextCommand`/`thenCommand`/`inspection` and the omitted count. The header states the observation time, age, source and TTL. It shows a stale snapshot and its refresh error, incomplete evidence with its warnings, the identity diagnostic and the resolved repository, role and agent. While a newer request is pending, the previous list stays visible but is marked provisional.
- Security: three same-origin responses (`/`, `/dashboard.js`, `/dashboard.css`) under `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. There is no inline script or style and no external resource. All server text is HTML-escaped, and only `https://github.com/` targets become links. Host and Origin checks apply as for every route.
- The browser script is generated from TypeScript (`src/serve/dashboard.ts`). Its two functions reference no module-level names, so their source text runs on its own. A one-line `__name` shim covers the helper that `tsx` (esbuild `keepNames`) injects when running from source.

### Rules page

`GET /rules?repo=R` (#392, `src/serve/rules-page.ts`) renders the same document as `pdb rules` (doc/design/rules-english-command.md): the shared `rulesDocument` built from the packaged English model, projected by the shared `rulesText` and split into its `== Section ==` parts under HTML headings. It adds no per-rule prose and never lists runtime why templates. `role` and `rule` are the `pdb rules` filters, and a filtered page says it is a subset. The selected project is resolved through the served-project allowlist; with several projects and none selected the page shows the selector and the shared policy with settings unknown. An unserved or malformed `repo` answers 403/400 with the served projects and no document, and an artifact that does not match the engine answers 500 rather than showing an older document. Effective settings are read only for a project served with `--project`, through the verified checkout resolver and the read-only settings loader; otherwise, or when that fails, they are shown as unknown, never as the defaults. Loading the page makes no GitHub request, starts no background work and writes nothing. It is static HTML with no script under the dashboard CSP, every value is escaped, and links are built on the server's own origin with encoded selection. The dashboard links to it, and the startup banner prints its URL for onboarding.

`GET /setup?repo=R&role=implementer|designer` (#391, `src/serve/setup-page.ts`) renders the onboarding document of `pdb onboard` (#351, doc/design/agent-onboarding.md) for the selected served project. It is built with the origin this server bound at startup, never a request Host header, and shows:

- the copyable prompt, which links this project's `/setup` and `/rules` pages first;
- the MCP endpoint `/mcp`;
- client configuration examples. Each is labelled `verified` only with a recorded acceptance report (Claude Code over HTTP; Codex over stdio) and `unverified` otherwise (Codex over HTTP, #397; Ori Code, #399);
- the CLI fallback;
- the AGENTS.md section.

Selection uses the served-project allowlist like `/rules`: 403/400 for an unserved or malformed `repo`, and placeholders with the selector when several projects are served and none is chosen. Loading the page makes no GitHub request, reads no file and writes nothing. Copying never edits AGENTS.md or client settings, and the page says that connecting MCP installs no hooks. The HTML has no inline script; `/setup.js` only adds copy buttons, and every block stays selectable text without it. The dashboard links to it and the startup banner prints its URL.

## Caching

### What is cached

The unit is a **whole collected fact result**, the output of one collector call before any identity-specific rendering:

| Collector                                                               | Key coverage fields                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `collect(repository, {issue?, since?, includeTransferred?})` (snapshot) | `issue`, `since` normalised to ISO, `includeTransferred` |
| `dependencyReport(repository, n, {tree})`                               | `n`, `tree`                                              |
| PR diagnosis collection                                                 | `n`, `history`                                           |
| `who`/`team` collection                                                 | `n` (who), `staleHours`                                  |

Auxiliary read-throughs made while presenting a result (provenance permission lookups via `rest`, delivery evidence via `queryWith`) are memoised inside the same entry and expire with it; they are never cached independently. Presentation (`presentBriefing`, ranking, role queues, compact text, MCP bounding) runs per request on the cached facts with the caller's agent, role, order, limit and the injected clock. A rendered queue is therefore never a cache entry and one caller's queue cannot be served to another.

Not cached: anything a mutation reads (claims, release, submit, complete, deps add/remove, estimate, needs-human, deliverables), the update check, local configuration and identity files (read per request, they are local and cheap), and `triage_events`.

### Keys and isolation

`key = (authContext, repository, collector, coverage)` where:

- `authContext` is `<gh host>/<login>` resolved at startup and re-resolved whenever a live collection runs at most once per TTL. If it changes (for example `gh auth switch`), the whole cache is cleared and the new context is reported in status. Tokens never enter keys, logs or responses.
- `repository` is the normalised `owner/name` (lower-cased for the key, original case in output).
- `coverage` is the canonical JSON of the collector's option object with absent fields omitted.

Identity and role are deliberately not in the key: they change projection, not collection. Since `collect` today does not vary by agent, this is safe; if a future collector does take agent-specific input, that input becomes part of `coverage` automatically because it is an option field.

### TTL, coalescing and memory bounds

- An entry is fresh for `ttl` after `observedAt` (the injected clock at collection completion; collections record their own start time in the result as today). A read of a fresh entry returns `source: "cached"`.
- A read with no fresh entry starts a live collection under the key. Concurrent reads of the same key join the in-flight promise (`source: "live"`, counted as `coalesced`). This generalises `sharedCollect`: same reference-counted abort, extended to every collector and all coverage values instead of unfocused snapshots only.
- No background refresh, no refresh-ahead and no polling. An idle server makes no GitHub requests.
- Bounds: at most 256 entries and 64 MiB of approximate size (`Buffer.byteLength(JSON.stringify(result))` measured once on insert). Over either bound, evict least recently used. Expired entries are swept on access and by a sweep every TTL; a stale-eligible entry (below) is kept until its stale window ends. In-flight collections are bounded by a semaphore of 4 concurrent distinct collections; further distinct keys queue in FIFO order (identical keys still coalesce).

### Refresh

`POST /api/v1/refresh` with `{"repo": "owner/name"}` removes every entry for that repository in the current auth context; without `repo` it removes all entries. It does not collect: the next read collects live. This keeps refresh cheap, idempotent and free of a second code path. Any read route also accepts `refresh=true`, which bypasses a fresh entry for that key, collects live (coalescing with any in-flight collection that started after the request arrived, never with an older one) and replaces the entry. MCP tools gain no refresh argument in v1; an MCP client wanting fresh data waits for the TTL or calls the JSON refresh. The dashboard's refresh button uses `refresh=true`.

### Failure behaviour

Interim rule until #369 lands; #373 implements #369's contract instead if it merges first, and this section is then amended.

- A live collection that fails with no previous entry for the key returns an error (502 family, or the MCP `isError` envelope with the same code). Partial collections that the existing collectors report as incomplete are not failures: they are cached and served with `status: "incomplete"`, as the CLI does.
- A live collection that fails while an expired entry for the same key exists, and that entry's `observedAt` is within **30 minutes**, returns the old result with `source: "stale"`, `stale: true`, the true `observedAt`/age, `refreshError: {"code", "message"}`, and envelope `status: "incomplete"` with a warning that facts may have changed. HTTP status is 200. Beyond 30 minutes the error is returned and the old entry is dropped.
- Explicit `refresh=true` failing behaves the same way, so refresh never destroys the last good result.
- A failure is not cached: the next request tries again. To avoid hammering on rate limits, after a `GITHUB_RATE_LIMITED` failure for an auth context, live collections for that context are refused for the `retry-after`/reset interval GitHub reports (at most 10 minutes), returning stale-eligible results or 502 `GITHUB_RATE_LIMITED` with the reset time.
- Mutations are not served by this server in v1. When CLI mutation commands run beside a server, they continue to collect their own live facts; nothing in the server cache is readable by them.

## Security

- **Binding.** Default `127.0.0.1`. `localhost` binds to the loopback addresses only. A non-loopback `--host` without `--allow-remote` exits 2. With it, the server prints to stderr: `WARNING: pdb serve is reachable from other machines at http://ADDR:PORT/. It has no authentication; anyone who can reach it can read private repository data that your gh login can see.` and repeats `exposed: true` in status. No authentication scheme is offered in v1.
- **DNS rebinding.** Every request's `Host` header must name the bound address or a loopback name (`localhost`, `127.0.0.1`, `[::1]`) with the bound port; with `--allow-remote` the explicit `--host` value is added. Otherwise 421 `MISDIRECTED_HOST`. If an `Origin` header is present it must be `http://` plus one of those host:port values, else 403 `FORBIDDEN_ORIGIN`. Implementation uses the SDK's `validateHostHeader`/`validateOriginHeader` with an allowlist derived from the bound address, applied before routing to both the JSON API and `/mcp`. Requests without `Origin` (CLI, MCP clients, curl) are allowed.
- **Cross-site requests.** `POST` requires `Content-Type: application/json`, which a cross-site form cannot send without a CORS preflight; the server sends no CORS headers, so preflights fail. No cookies are used.
- **No credentials or local secrets in output.** The server never reads tokens itself; `gh` keeps them. Responses, logs and status carry only host and login. Local paths are redacted with the existing `redactPaths`/`redactLocalText`, as for MCP. Error messages are sanitized.
- **No mutation endpoints in v1.** The JSON API and MCP registry are read-only; refresh mutates only the server's own memory. Claims, releases, dependency edits, estimates and every other write stay CLI-only, where they already re-read live state. A later ticket may add writes only with a contract amendment specifying live verification per operation.
- **Resource limits.** Body limit 64 KiB; header timeout 10 s; per-request collection timeout follows the existing collector bounds; the cache and session bounds above.
- **Shared machines.** Loopback binding does not stop other local users on the same host. This is documented as a limitation in the help text; v1 adds no token.

## Identity and project selection

Repository per request, in order: `repo` query parameter (or MCP tool `repo`), which must be in the served set; else the single served repository when exactly one; else `REPOSITORY_UNRESOLVED` listing the choices. The process cwd is never consulted (#271). Each `--project` is the checkout used for that repository's local configuration, workflow guide setting, estimation settings and identity file, exactly as `pdb-mcp --project` does; a repository given only by `--repo` has no local project, so identity can come only from explicit `agent` or startup `--agent`.

Agent per request, reusing `resolveReadIdentity` in `src/config/readidentity.ts` with the existing precedence: request `agent`, then startup `--agent`, then the entry chosen by request `entry`/`harness`, startup `--entry`/`--harness`, verified MCP client info (`ori-SERVER` maps to `ori.SERVER`; HTTP MCP clients present client info at initialize, stored per session), or environment detection (the server's own environment only; it identifies the human running `pdb serve`, so it is used only when no request-level signal exists and is reported as `identitySource: "environment"`). The identity file is read only from the selected repository's project and only when it matches; it is never created or changed. Failures yield an unfocused read with `identityDiagnostic`.

Role is never inferred: `role` is an explicit request parameter, as in #260. `selection.triageRole` reports the entry's role so a client (or the dashboard) can pass it. The dashboard's designer/implementer views are therefore just `role=designer` / `role=implementer` requests.

Per-call context is never shared: two concurrent requests with different `repo`/`agent` values share only cache entries whose keys match, and each renders its own projection.

## Testing and acceptance

Injected boundaries, following the existing `ReadRuntime`/`McpRuntime` pattern: `collect`, `dependencyReport`, `rest`, `queryWith`, PR/who/team collectors, `authContext`, a `Clock` (`now` plus timer scheduling, so TTL, stale windows and session idling advance without sleeping), and `listen` options (host and port, tests always use port 0). No test touches GitHub or a fixed port.

Required tests in #373/#390:

1. Argument parsing: defaults, TTL range (1m and 10m accepted, 0s and 11m rejected), non-loopback without `--allow-remote` rejected, missing repo/project, repeatable options.
2. HTTP integration on an ephemeral port with fake collectors: every route's envelope validates; unknown parameters 400; `REPOSITORY_UNRESOLVED`/`NOT_SERVED`; JSON results equal CLI `--json` output for the same injected facts (parity, like `src/mcpparity.test.ts`).
3. Cache: hit within TTL, miss after advancing the clock, coalescing of N concurrent identical requests into one collector call, distinct coverage keys not shared, auth context change clears, LRU eviction at the entry and byte bounds, two agents with different roles on one cached snapshot receive different correct queues.
4. Failure: error without previous entry; stale result within 30 minutes and error after; refresh failure preserves the last good result; rate-limit cooldown; incomplete collection cached as incomplete.
5. Cancellation: one of two coalesced waiters aborting leaves the other's result intact; the last waiter aborting aborts the collector signal; shutdown aborts in-flight collections and exits 0.
6. Security: wrong `Host` 421, foreign `Origin` 403, `POST` without JSON content type 415, no token-like or path strings in any response (scan fixtures seeded with sentinel values).
7. Port conflict: occupy a port in the test, start the server on it, assert exit status 3 and the message.
8. MCP over HTTP with the real `@modelcontextprotocol/client` 2.4.0 Streamable HTTP client: initialize, list tools (same set as stdio), call each read tool, two sessions with different repositories/agents in parallel, cache reuse visible in `freshness`, session delete and reconnect after an unknown session ID, cancellation. A stdio regression run of the existing MCP tests stays green.
9. Packaged smoke: pack and install the archive into a temporary prefix (extending the existing installed-archive test), run `pdb serve --repo owner/name --port 0` with a fake `gh` on `PATH`, read the URL from the first stdout line, hit `/healthz` and `/api/v1/status`, send SIGTERM, assert exit 0 within the shutdown window.

Real-client verification (recorded, not CI): run `pdb serve --project /absolute/checkout` and register it in Claude Code with `claude mcp add --transport http pdb http://127.0.0.1:4372/mcp`; confirm `/mcp` lists the server as connected, a role briefing call returns a bounded result with `freshness.source` `live` then `cached` on repeat, and that stopping and restarting the server is recovered by the client. Record Claude Code version, model and harness provenance in a report under `doc/reports/`, per the native acceptance rules (#395/#397/#399 own the per-client acceptance; SDK tests alone do not claim it).

## Delivery plan for #373

Four small PRs, each independently reviewable and leaving `main` releasable:

1. **Server skeleton and lifecycle.** `src/serve.ts` and a `serve` subcommand in `src/cli.ts`: argument parsing and validation, auth context resolution, `node:http` listener with Host/Origin/body checks, `/healthz`, `/api/v1/status` (empty cache counters), `/` placeholder (replaced by the #374 dashboard), banner, port-conflict exit, signal handling and graceful shutdown. Tests 1, 6, 7 and the packaged smoke (9).
2. **Cached read API.** The keyed memory cache (TTL, coalescing generalised from `sharedCollect`, LRU bounds, stale window, rate-limit cooldown, refresh); extraction of PR/who/team into transport-neutral read services; all `/api/v1` read routes and `POST /api/v1/refresh`; identity and project selection. Tests 2–5.
3. **HTTP MCP (#390).** `/mcp` with the SDK Streamable HTTP handler and session management, `createServer` with the cached runtime, additive `freshness` in the bounded envelope. Test 8 plus stdio regression.
4. **Docs.** README and `pdb serve --help`, generic MCP HTTP configuration example (marked verified only after the recorded Claude Code smoke), update [mcp.md](mcp.md) and this document's status, diary entry.

## Owner questions

None block implementation; each has a default above that #373 uses unless the owner overrides it.

1. Default port `4372` and the 30-minute stale window are arbitrary choices; adjust if preferred.
