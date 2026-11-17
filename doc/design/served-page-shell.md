# Served-page shell and project navigation

Status: proposed contract for #627, implemented under #605. This document implements nothing. Sections headed "Shipped today" describe current behaviour on `origin/main` at ae4c5dd and cite the file that implements it. Sections headed "#452 foundations" describe work that the merged [serve-startup-configuration.md](serve-startup-configuration.md) specifies and that #452 is still building. Every other section is a proposal for #605. Merging this document does not close #605, and it does not mean the toolbar, the Agents page or any other page has shipped.

Current follow-up contract: [project-first toolbar and running-process footer](served-shell-followups.md) (#733, #730). It supersedes historical layout/footer details below; it does not claim those runtime follow-ups have shipped.

## Contents

- [Owner direction](#owner-direction)
- [Shipped today](#shipped-today)
- [#452 foundations](#452-foundations)
- [Page registry and scopes](#page-registry-and-scopes)
- [The toolbar](#the-toolbar)
- [Routes, parameters and validation](#routes-parameters-and-validation)
- [Selection states](#selection-states)
- [Project changes, history and stale data](#project-changes-history-and-stale-data)
- [Security boundaries](#security-boundaries)
- [Accessibility and layout](#accessibility-and-layout)
- [Integration seam for future pages](#integration-seam-for-future-pages)
- [Implementation and test handoff for #605](#implementation-and-test-handoff-for-605)
- [Out of scope](#out-of-scope)

## Owner direction

This section restates #605, the shared-shell rules in [dashboard-pipeline-metrics.md](dashboard-pipeline-metrics.md#page-map-and-shared-shell) (#573) and the Settings and Diagnostics page contracts (#584, #585). It does not reopen any of them.

- One constant toolbar, visible on every served HTML page while scrolling, with the page navigation and the project selection. It is a single component, not one selector per page.
- The selected project is kept as the user moves between pages. Deep links recover it, and back and forward work.
- Global and account-scoped pages never present their data as belonging to the selected project. Settings keeps its explicit **Global** scope, and Quotas is account-wide.
- Pages that need a project name the selected project and show a useful no-selection state. Nothing falls back to the server's working directory or guesses a project.
- Malformed or unserved selections fail safely, and switching projects never mixes old data with new.
- Rendering the toolbar makes no GitHub read. There is no new project store, ranking engine, background polling, settings write or ticket mutation.
- The existing CSP, the no-inline-script rule, HTML escaping, the Host and Origin checks and the served-project allowlist are all kept.
- The toolbar must work with the keyboard and on narrow screens. The sticky layout must never hide content, and the result is checked visually on long and short pages.

## Shipped today

### HTML routes

| Route     | Rendering                                                                                                                                                                          | Accepted parameters                                                                                                                                  | Header                                                                                                                                                                                   | Source                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `/`       | Static HTML built once at startup (`dashboardFiles` in `src/serve.ts`). `/dashboard.js` fills the project `<select>` from `GET /api/v1/status`, then reads `GET /api/v1/briefing`. | `repo`, `role`, `agent`. Any other key falls through to `getOnly` and gets a JSON `INVALID_ARGUMENT` error, not an HTML page (`src/serve.ts`).       | `<h1>pdb serve</h1>`, a form with Project select, Role select, Agent input, Show and Refresh, then links to Project rules and Agent setup (`dashboardPage` in `src/serve/dashboard.ts`). | `src/serve/dashboard.ts`   |
| `/ticket` | Static HTML built once at startup. `/ticket.js` reads `GET /api/v1/tickets/N`.                                                                                                     | `ticketPageParameters` = `repo`, `n`, `agent` (`src/serve/ticket-page.ts`). Unknown keys get the same JSON error.                                    | `<h1>pdb ticket</h1>`, "Back to the to-do list" and Refresh only. No project indicator or selector (`ticketPage`).                                                                       | `src/serve/ticket-page.ts` |
| `/setup`  | Server-rendered on each request, with no GitHub request (`setupPage`).                                                                                                             | `setupPageParameters` = `repo`, `role`. An unknown key, bad role, malformed repo or unserved repo gets an HTML error page that keeps the navigation. | `<h1>Agent setup</h1>`, then a `<nav aria-label="Projects">` with Dashboard and Rules links and one link per served project, marked with `aria-current="page"` (`navigation`).           | `src/serve/setup-page.ts`  |
| `/rules`  | Server-rendered on each request from the packaged policy, with no GitHub request (`rulesPage`).                                                                                    | `rulesPageParameters` = `repo`, `role`, `rule`. Errors are HTML pages, as on `/setup`.                                                               | `<h1>Project rules</h1>`, then a `<nav aria-label="Projects">` with a Dashboard link and the project list. There is no Setup link (`navigation`).                                        | `src/serve/rules-page.ts`  |

Every HTML, CSS and script response carries `dashboardSecurityPolicy`, `cache-control: no-store`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer` (`src/serve.ts`, `src/serve/dashboard.ts`). The policy is `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Because of `form-action 'none'`, no page can submit an HTML form: the dashboard's form works only because its script calls `preventDefault` and fetches. All four pages share one stylesheet, `/dashboard.css` (`dashboardCss`), in which the `header` element is already `position: sticky; top: 0`.

### Project selection

- The served set is fixed at startup by `servedSet` in `src/serve.ts`, from `--repo` and `--project`, deduplicated case-insensitively. A `ServedRepository` is `{ repository, project? }` (`src/serve/types.ts`). Nothing is persisted.
- `selectRepository` (`src/serve/api.ts`) is the one allowlist check. A `repo` that does not match `owner/name` gives 400 `INVALID_ARGUMENT`. An unserved `repo` gives 403 `REPOSITORY_NOT_SERVED`, with the served projects as `next` hints. A missing `repo` resolves to the only served project when exactly one is served, and otherwise gives 400 `REPOSITORY_UNRESOLVED`. The comparison is case-insensitive, and the result is the served entry's own spelling.
- `/setup` and `/rules` call `selectRepository`. With `REPOSITORY_UNRESOLVED` they render without a selected project instead of failing (`setupPage`, `rulesPage`).
- The dashboard client never calls `selectRepository`. It preselects `served.find((s) => s.repository === wanted) ?? served.find((s) => s.default)` (`dashboardClient` in `src/serve/dashboard.ts`), where `default` is true only when exactly one project is served (`statusDocument` in `src/serve.ts`). **Gap:** with one served project, an unserved or differently cased `?repo=` silently shows the default project. With several, it shows "Select a project." with no error. Neither case says the requested project was refused.

### Propagation and history

- The dashboard rewrites its URL with `history.replaceState` on every Show (`?repo=…&role=…[&agent=…]`). It never calls `pushState` and has no `popstate` listener, so back and forward do not step through selections (`dashboardClient`).
- The dashboard rewrites its Rules and Setup links to carry `repo` only (`linkRules`). Each issue row links to `/ticket?repo=R&n=N[&agent=A]`, and only for issues of the selected project (`renderActions`).
- The ticket page's back link carries `repo` and `agent` but drops `role` (`backUrl` in `src/serve/ticket-page.ts`), so returning from a designer view lands on the implementer view.
- On `/setup`, the project links stay on `/setup?repo=R` and drop `role`. On `/rules`, they stay on `/rules?repo=R` and drop `role` and `rule` (`navigation` in both files).
- Setup and Rules build absolute links from the bound URL fixed at startup, never from the request's Host header (`pageUrl` in `src/serve/rules-page.ts`, called with `facts.url`). The dashboard and ticket page use root-relative links.

### Stale responses

The dashboard and ticket page discard a superseded response by comparing a request counter (`if (mine !== request) return`). While a request is in flight, the earlier list is marked `provisional`. Neither page aborts the superseded `fetch` (`dashboardClient`, `ticketClient`). The server already aborts a collection when the client disconnects, through reference-counted waiters (`ServeCache` in `src/serve/cache.ts`), so an aborted `fetch` releases its share of the work.

### GitHub reads

`/setup` and `/rules` read nothing from GitHub. The dashboard's first request is `GET /api/v1/status`, which reads only in-memory facts. It then reads exactly one briefing, for the preselected project only (`start` in `dashboardClient`). The ticket page reads only its own ticket, and a PR only when that PR's button is pressed.

### Request guard

`guardRequest` (`src/serve/http.ts`) runs before routing on every request, `/mcp` included. The Host header must name an allowed host name (loopback names plus the bound address) on the bound port, otherwise the request gets 421 `MISDIRECTED_HOST`. An Origin header, when present, must be same-scheme, same-host and same-port, otherwise the request gets 403 `FORBIDDEN_ORIGIN`. Only origin-form request targets are accepted (`handle` in `src/serve.ts`). The access log records the path only, never the query (`pathForLog`).

### Browser test infrastructure

Browser scripts are tested by running the served script text in `runInNewContext` with a fake DOM (`fakeBrowser` in `src/serve/dashboard.test.ts`). The repository has no real-browser harness: `package.json` has no Playwright, jsdom or happy-dom dependency, and the public-website browser acceptance (#600) is still open.

## #452 foundations

These are specified in [serve-startup-configuration.md](serve-startup-configuration.md) and are not implemented. The shell must not claim them before #452 ships.

- A saved, ordered registry, `serve.projects`, of `{ host, repository, localRoot? }` in the global `config.toml`, deduplicated by canonical host and repository.
- Live registration into a running instance through a verified control request. After this ships, the served set can change while a page is open.
- Global configuration scope, which the Settings page shows as **Global**.

Comments on #452 (2026-11-15) record unresolved safety work for live reload: per-request context generation and cancellation, final-response validation, and invalidating repository contexts that change. Until that lands, the served set stays fixed at startup.

The shell needs two things from #452 and nothing more. It reads the current served set through one accessor on every request, and it uses `selectRepository` (or #452's replacement of it) as the only allowlist. It keeps no copy of the registry.

## Page registry and scopes

Each served HTML page is described by one entry in a typed page registry, `src/serve/shell.ts` (proposed). The toolbar, the router's parameter allowlist and the link builder all derive from that registry, so pages no longer duplicate navigation.

```ts
type PageScope =
  | "project" // needs a selected project
  | "project-optional" // useful without one; says so
  | "global-or-project" // no project means Global (Settings)
  | "account"; // never project-scoped (Quotas)

interface ServedPage {
  id: string; // stable, e.g. "work"
  path: string; // e.g. "/"
  label: string; // toolbar text, e.g. "Work"
  scope: PageScope;
  /** Every accepted query key; `repo` is implied across shell pages (validated on account pages as navigation context only). */
  parameters: readonly string[];
  /** Keys this page carries forward to the same keys on another page (see Carry rules). */
  carries: readonly string[];
  /** Linked from the toolbar only when the page is routed in this build. */
  shipped: boolean;
}
```

| Page            | Path           | Scope                                              | Parameters                                                      | Status                                                                                  |
| --------------- | -------------- | -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Work            | `/`            | project                                            | `repo`, `role`, `agent`                                         | Shipped (#374). The human mode, `/human` (#458), joins Work's navigation when it ships. |
| Ticket detail   | `/ticket`      | project                                            | `repo`, `n`, `agent`, plus `role` (new, so Back keeps the view) | Shipped (#454). Not a toolbar entry: it marks Work as the active section.               |
| Rules           | `/rules`       | project-optional                                   | `repo`, `role`, `rule`                                          | Shipped (#392)                                                                          |
| Setup           | `/setup`       | project-optional                                   | `repo`, `role`                                                  | Shipped (#391)                                                                          |
| Overview        | `/overview`    | project                                            | per #574                                                        | Proposed ([metrics contract](dashboard-pipeline-metrics.md))                            |
| Pipeline health | `/pipeline`    | project                                            | per #575                                                        | Proposed                                                                                |
| Timing          | `/timing`      | project                                            | per #576                                                        | Proposed                                                                                |
| Agents          | `/activity`    | project                                            | `repo`, `window`                                                | Proposed (#456, [read views](serve-dashboard-read-views.md))                            |
| Diagnostics     | `/diagnostics` | project-optional (the Ticket Doctor tab needs one) | `repo`, `tab`                                                   | Proposed ([contract](serve-diagnostics-page.md), #585)                                  |
| Settings        | `/settings`    | global-or-project                                  | `repo`                                                          | Proposed ([contract](serve-settings-page.md), #584)                                     |
| Quotas          | `/quotas`      | account                                            | `repo`, `role`, `agent` (navigation context only)               | Proposed ([contract](github-quotas.md), #548; context retention #732)                   |

The toolbar never links to a page whose `shipped` flag is false. An unshipped route keeps answering 404 as it does today, so the toolbar has no dead links. When a page ticket ships, it adds its registry entry and its route in the same PR.

## The toolbar

One server-rendered `<header>` at the top of every page, with no script required:

1. A "Skip to content" link, the first focusable element. It is visually hidden until it receives focus, and it targets `<main id="content" tabindex="-1">`.
2. The product name, linking to Work for the current project, or to `/` with no project.
3. A **context indicator** in text, which never relies on colour alone:
   - with a project: `Project: owner/name`;
   - on a project page with nothing selected: `No project selected`;
   - on Settings without `repo`: `Scope: Global`;
   - on Quotas: `Account-wide: your GitHub login's quotas, not a project's`.
4. A **project menu**: a `<details>` element whose `<summary>` reads "Change project", containing one link per served project in served order. The current project's link has `aria-current="true"`. On Settings the menu also has a "Global" entry, and on Quotas the menu is left out. The menu is a list of links because `form-action 'none'` forbids form submission; it works without script, the keyboard opens it with Enter or Space, and it is not a custom ARIA widget.
5. **Page navigation**: `<nav aria-label="Pages">` with one link per shipped registry entry in registry order. The active page, or the page's section for Ticket detail, gets `aria-current="page"`, and is visibly marked with weight and an underline as well as any colour.

The toolbar holds no Refresh, Show or page-specific controls. Those stay in each page's main region, and the Work page's Role and Agent controls stay on that page. The dashboard's current project `<select>` is removed, because the project menu replaces it.

The toolbar is produced by one function, `renderToolbar(context)`, from the registry, the current served set and the request's validated selection. It reads only in-memory state, and it calls no GitHub API, no cache read, no `fetch` and no `/api/v1/*` route.

## Routes, parameters and validation

### Link building

Every toolbar and cross-page link is built by one helper, `pageHref(page, selection)`. It produces a root-relative path whose query string comes from `URLSearchParams`, so values are encoded. The helper never uses the request's Host header or the bound origin. (Setup's and Rules' absolute links on the bound URL remain valid; switching them to root-relative links is allowed but not required.) Parameters are emitted in a fixed order: `repo` first, then the page's own keys in registry order. That gives one canonical URL per view.

### Carry rules

A rule decides which parameters follow the user from one page to another:

- `repo` is carried across every shell page—including account pages such as Quotas—as navigation context so returning to Work, Rules, or Setup preserves the selected project. Account pages still label their data as account-wide (`Account-wide: your GitHub login's quotas, not a project's`), validate `repo` against the served allowlist, omit the project menu, and never attribute account data to a repository.
- On Settings without `repo` (Global), links to other pages carry no `repo`. Global is a Settings scope, not a project.
- `role` and `agent` are carried between Work, Ticket detail, and through account pages (such as Quotas) as navigation context so returning to Work or Ticket preserves the same view. Setup's `role` is a different setting (the onboarding prompt's role) and is never filled in from Work's role.
- Page-specific keys (`n`, `rule`, `window`, `tab`, metric windows and the like) are never carried to another page.
- An identity is never inferred. `agent` appears only when the user entered or followed it. The shell never reads `pdb.toml`, a harness identity or the GitHub login to fill it in.

### Server-side validation

This applies to every HTML route; JSON routes are unchanged.

1. The parameter keys must be a subset of the page's registered parameters, otherwise the response is 400.
2. A repeated key is refused with 400 (for example `repo=a/b&repo=c/d`). Today `URLSearchParams.get` silently takes the first value.
3. `repo`, when present, goes through `selectRepository`. An empty value is malformed. Malformed gives 400, and unserved gives 403.
4. The page validates its own keys (for example `role` against the registered roles, `n` as a positive integer and `tab` from a fixed set) before any read.
5. Every refusal is an **HTML** error page that keeps the full toolbar, with no project selected. It sends the same status code and the existing security headers, and it explains the refusal in a `role="alert"` paragraph without echoing the raw value into markup. The page tells the user to choose a served project from the menu. `/` and `/ticket` currently answer unknown keys with JSON; this rule changes them to HTML for browser routes only.
6. A case-variant `repo` resolves to the served spelling, and every link on the page uses that spelling. The page does not redirect.

Validation reads only the in-memory served set. A refused request makes no GitHub request and no cache read.

### Rendering model

`/` and `/ticket` become per-request server-rendered pages: the shell (head, toolbar, empty main) plus the page's existing script. Their data loading stays client-side and unchanged. Per-request rendering is needed because the toolbar depends on the request's `repo`, and after #452 on the current served set, so it cannot be a file built once. It costs one string build and no I/O. Static assets (`/dashboard.css`, `/dashboard.js`, `/ticket.js`, `/setup.js`) stay prebuilt.

## Selection states

| State                                    | When                                                              | Toolbar                                         | Main region                                                                                                                                                 | Reads                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Selected                                 | valid served `repo`                                               | `Project: owner/name`, with the menu marking it | the page                                                                                                                                                    | only what the page itself reads                                |
| No selection, on a project page          | no `repo` on a `project` page                                     | `No project selected`                           | "Choose a project", with the served projects as links to this same page                                                                                     | none                                                           |
| No selection, on a project-optional page | no `repo` on Rules, Setup or Diagnostics                          | `No project selected`                           | the page's documented no-project content (the shared policy, the generic setup, or the Doctor's no-project subset), saying that project facts are not shown | as the page specifies, with no GitHub read for Rules and Setup |
| Global                                   | Settings without `repo`                                           | `Scope: Global`                                 | Global settings ([contract](serve-settings-page.md))                                                                                                        | local files only                                               |
| Account                                  | Quotas                                                            | `Account-wide…`; no project menu                | quota view ([contract](github-quotas.md))                                                                                                                   | only on explicit Refresh                                       |
| Malformed                                | `repo` not `owner/name`, a repeated key or an unknown key         | `No project selected`                           | 400 alert                                                                                                                                                   | none                                                           |
| Unserved                                 | well-formed `repo` that is not served                             | `No project selected`                           | 403 alert: "That repository is not served by this server", plus the served list                                                                             | none                                                           |
| Nothing served                           | the served set is empty (possible only after #452 allows removal) | `No projects are served`                        | the registration hint from [serve-startup-configuration.md](serve-startup-configuration.md)                                                                 | none                                                           |

**A missing `repo` is never resolved to a project by the pages,** even when exactly one project is served. This follows rule 1 of the [shared-shell rules](dashboard-pipeline-metrics.md#page-map-and-shared-shell) and the #605 instruction not to guess. With one project, the no-selection state shows that single project as a one-click link, so nothing loads until the user picks it. This changes the current dashboard, which auto-loads the only served project. The JSON API's single-project default in `selectRepository` is unchanged, because CLI and MCP clients rely on it. The dashboard's silent fallback when an unserved `repo` is given (see the gap above) is removed: the server refuses it with 403 before the script runs.

## Project changes, history and stale data

- **Changing project is a full navigation.** The project menu links to the same page with the new `repo` and with the carry rules applied. If the current page cannot exist in the new project, the link goes to that page's section instead: Ticket detail goes to Work. A full navigation replaces the document, so no old project's DOM, in-flight `fetch` or script state survives, and project data cannot mix by construction. The browser cancels the old document's requests when it unloads.
- **Deep links:** every view is fully described by its URL. Opening, reloading or bookmarking a URL reproduces the selection, and validation repeats on every request.
- **Back and forward:** project and page changes are ordinary navigations, so the browser's history handles them. A page restored from the back/forward cache shows its own URL's project and its own earlier results. Browsers differ on whether `cache-control: no-store` keeps a page out of that cache, so pages with client-side reads also listen for `pageshow` with `persisted: true` and then re-run the in-page pattern below for the URL they show, without reading GitHub again unless their contract fetches on load.
- **In-page selection changes** are a change of role or agent on Work, a change of tab on Diagnostics, or a change of window on a metrics page. They stay on the page and follow one pattern:
  1. a user-initiated change calls `history.pushState` with the canonical URL, while start-up canonicalisation uses `replaceState`;
  2. a `popstate` listener reads the URL again, validates it with the same client-side rules, and re-renders that selection;
  3. each read creates a fresh `AbortController`, aborts the previous one, and passes its signal to `fetch`;
  4. the existing generation check stays as a second guard, so a response is applied only if it matches the current generation and its envelope's `selection.repository` equals the page's `repo`;
  5. while loading, the previous results stay visible marked `provisional` with the existing loading text, never under another project's name. Because project changes are full navigations, the previous results always belong to the same project.
- **Live registration (after #452):** the toolbar reflects the served set at render time. If a project is unregistered while its page is open, the page's next read gets `REPOSITORY_NOT_SERVED` from the API and shows it as an error, and the next navigation shows the Unserved state. The shell does not poll for registry changes.
- **No eager reads:** rendering a page, its toolbar or the project menu reads nothing from GitHub and fetches no `/api/v1/*` route. In particular the dashboard stops fetching `/api/v1/status` to build its selector. Only the visible page's main region reads, for the selected project, on load (where its contract allows) or on Refresh. No prefetch, timer or cross-project fan-out.

## Security boundaries

- **CSP unchanged:** the toolbar needs no script and no inline style. Its CSS goes into the shared `/dashboard.css`. Page scripts remain same-origin files generated from self-contained TypeScript functions, as `dashboardScript` and `ticketScript` are today.
- **Escaping:** every served-project name, label and parameter value in the toolbar goes through `escapeHtml` (`src/serve/rules-page.ts`; the dashboard and ticket renderers keep their own copies for the browser). Attribute values are quoted. No raw query value is echoed into an error page; only fixed messages and the served spelling appear.
- **Allowlist:** the toolbar lists only the served set, and every `repo` is checked by `selectRepository` on the server. The page's own JSON reads are checked again by the API. The client never builds a project list from user input.
- **Host and Origin:** `guardRequest` keeps running before routing, and toolbar links are root-relative paths, so no link depends on the Host header.
- **No writes:** the toolbar, the project menu and navigation are GET-only. They set no cookie and no `localStorage`, and write no session or server state. The selected project lives only in the URL, as [rule 1 of the shared shell](dashboard-pipeline-metrics.md#page-map-and-shared-shell) requires.
- **Logs:** query strings stay out of the access log (`pathForLog`), so project and agent names are not logged by navigation.

## Accessibility and layout

- **Landmarks:** `<header>` (banner) holds the toolbar, `<nav aria-label="Pages">` holds the page links, `<main id="content">` holds the page, and `<footer>` is unchanged. Each page keeps exactly one `<h1>`, which is the page's own title. The product name in the toolbar is not a heading.
- **Keyboard:** the tab order is skip link, product name, project menu summary, project links (when open), page links, then main content. Escape closes an open project menu and returns focus to its summary (an optional same-origin `/shell.js` enhancement; the menu works fully without it). Focus is always visible, using `:focus-visible` with an outline of at least 2px.
- **Sticky without obscuring content:**
  - The header stays `position: sticky; top: 0`.
  - The shared CSS sets `html { scroll-padding-top: var(--toolbar-height) }`, and focusable and anchor targets get `scroll-margin-top`. This keeps keyboard focus, `#section-N` anchors on Rules and the skip-link target from landing underneath the toolbar.
  - `--toolbar-height` is a fixed value for each breakpoint, so the toolbar's height must stay within it.
  - Under `@media (max-height: 30rem)` (short landscape phones, high zoom) the toolbar is `position: static`, so it never takes most of the viewport.
- **Narrow screens:** at widths below 40rem, the page links collapse into a second `<details>` ("Pages", which shows the active page's name) next to the project menu. The toolbar is then two lines at most when collapsed. At 320 CSS px and at 400% zoom there is no horizontal scrolling. Long project names wrap with `overflow-wrap: anywhere`.
- **Announcements:** the project indicator is plain text in the banner and is not an `aria-live` region (a navigation is a new page). Existing `aria-live` status regions inside pages are unchanged.
- **Colour:** the active page and current project are marked by `aria-current`, weight and underline. Light and dark modes use the existing `color-scheme: light dark` system colours (`Canvas`, `CanvasText`, `GrayText`), so contrast follows the user's theme.

## Integration seam for future pages

A page ticket (#574–#576, #456, #458, #548, #584, #585) integrates by:

1. adding its `ServedPage` entry to the registry, with `shipped: true`;
2. adding a route whose handler calls `resolvePageSelection(query, served, page)`. That returns one of `selected`, `none`, `global`, `account`, `malformed` or `unserved`, together with the HTTP status and the validated parameters. The handler renders `shellPage({ page, selection, title, main, script? })`;
3. rendering only its main region and its own same-origin script;
4. following the in-page selection pattern above for any client-side state it keeps.

It does not write its own header, project list, selector or parameter allowlist. The router derives the allowlist for HTML routes from the registry instead of the inline `selection` arrays in `src/serve.ts`. Pages that ship before #605 (the Diagnostics contract allows it) keep their existing header and move onto the shell when #605 lands.

## Implementation and test handoff for #605

#605 can start once this document merges. It does not wait for #452: the shell reads today's fixed served set through the accessor and picks up live registration when #452 ships. Suggested PR slices:

1. **Shell module.** `src/serve/shell.ts` with the registry for the four shipped pages, `resolvePageSelection`, `pageHref`, `renderToolbar` and `shellPage`, plus the toolbar CSS added to `dashboardCss`. Unit tests:
   - every selection state in the table, including a case-variant repo, an empty repo, a repeated key and an unknown key;
   - carry rules: `repo` across every shell page (including Quotas as navigation context, nothing from Global), `role` and `agent` between Work, Ticket, and Quotas, page keys never carried;
   - link encoding with hostile values (`<`, `"`, `&`, `#`, `?`, `/`, spaces and non-ASCII);
   - `aria-current` on the active page and the current project, with no link to an unshipped page;
   - a spy on an injected GitHub runtime and cache shows zero calls while rendering any toolbar state.
2. **Setup and Rules onto the shell.** Delete their `navigation` functions. Tests: the existing page tests still pass, the toolbar is identical in structure on both pages, error pages keep the toolbar, and switching project from the Rules page carries no `rule` or `role`.
3. **Work and Ticket onto the shell.** Render them per request, remove the project `<select>` and the `/api/v1/status` bootstrap, read `repo` from the URL only, and add `role` to the ticket's parameters and back link. Tests:
   - in the `fakeBrowser` sandbox, no fetch of `/api/v1/status`;
   - no briefing fetch when `repo` is missing (one or several served);
   - an unserved or malformed `repo` gives a 403 or 400 HTML page before any script runs;
   - Ticket's "Change project" link goes to Work for the new project;
   - Back keeps `role` and `agent`.
4. **History and cancellation.** `pushState` and `popstate` for Work's role and agent, an `AbortController` per read, and checking the envelope's selection. Tests in the sandbox:
   - back after a role change re-renders the earlier role;
   - a superseded fetch receives an abort;
   - a late response for an earlier generation or a different repository is never rendered.
5. **HTML error pages for HTML routes.** Unknown keys on `/` and `/ticket` get an HTML 400 with the toolbar, while JSON routes are unchanged. Server tests cover status codes, the security headers on every page and error, and no raw value echoed.
6. **Visual and accessibility verification** (acceptance for #605):
   - Widths 320, 390, 768 and 1280 CSS px. Zoom 200% and 400%. Light and dark themes.
   - A **long page**: Rules for a project, plus a Work list with at least 50 rows. Check that the toolbar stays visible while scrolling and that following `#section-N` anchors and tabbing through rows never leaves the focused element or heading under the toolbar.
   - A **short page**: Setup with no project, and a 403 error page. Check that the toolbar does not stretch, overlap the footer or leave layout gaps.
   - A short viewport (height at most 30rem), where the toolbar is not sticky.
   - Keyboard only: the skip link works, the project menu opens and closes, and the page links and `aria-current` are announced (check with VoiceOver or NVDA).
   - **Verification dependency:** the repository has no real-browser harness (see [Browser test infrastructure](#browser-test-infrastructure)). Until one exists (the same need as #600), #605 records these checks manually in its PR, with one screenshot per width and theme for the long and short page and a note of the keyboard and screen-reader pass. Structural assertions (landmarks, `aria-current`, skip-link target, no inline script or style, CSS rules for `scroll-padding-top` and the short-viewport media query) run in the unit tests. A missing harness does not block this design.
7. **Packaged smoke.** `scripts/package-test.ts` checks that every shipped HTML route returns 200 with the toolbar from the packed build, and that `/api/v1/*` and `/mcp` behave as before.

Regression guard across all slices: the existing JSON envelopes, API routes, MCP and CLI are unchanged, and no new dependency, project store, poller or write endpoint is added.

## Out of scope

Global configuration and live registration (#452); page contents and their reads (#574–#576, #456, #458, #548, #584, #585); settings writes and the #455 write session; ticket mutations including Unassign (#588); the public website (#599, #600); remembering a last-used project across sessions (the URL is the only store); and multi-host disambiguation of `repo`. On that last point, #452 adds `host` to registrations, and if two served entries ever share an `owner/name` on different hosts, #452 must extend `selectRepository` and this shell then follows its parameter. Until then `repo=owner/name` is unambiguous, because a running server talks to a single host (`ghAuthContext` in `src/serve.ts` reads one `GH_HOST`).
