# Svelte Work-page spike

Contract for #753. The owner selected Svelte, the Work page, inline expansion,
several simultaneously open tasks, and preservation of open tasks across refresh.
This is one opt-in prototype, not a framework comparison or a whole-app rewrite.
The existing default Work page remains until a separate promotion decision.

## Boundary and route

Add `/work-preview` as an explicitly experimental Work view through the shared
page registry and served-project selection. It consumes the existing versioned
briefing, ticket/detail and supported action services, with the same repo, role,
agent, coverage and native decision identity. It may have a simple link from
Setup/developer instructions; do not replace `/` or silently send ordinary users
to the spike. Both views must render the same ordered actions for the same facts.

Keep one prioritized list. Do not sort, infer eligibility, hide blockers, decide
human scope or reconstruct priority in a component. Display supplied reasons,
commands, ownership and omissions. No second collector, polling loop or dashboard
store interprets GitHub state. Project selector first, navigation second, content
below, using the shared shell and #733 rather than a competing Svelte header.

## Rows and expansion

Each row has a title, coloured action badges beneath, short supplied priority
reason, ownership/blocker evidence and an accessible expand/collapse control.
Details expand directly below their row. Multiple rows may stay expanded.

Key rows by canonical repository plus stable action ID (and linked subject ID
where supplied), never array position. A same-context refresh preserves the set
of open IDs that still occur in the new result; reordered rows do not exchange
state. A removed action is removed from the expansion set, and a different action
on the same issue does not inherit its detail. Preserve keyboard focus and scroll
anchor when a surviving item moves. If a focused item disappears, move focus to a
nearby labelled list/refresh control and announce the update without trapping it.

Scope expansion/detail caches to project, role and agent. Switching any of these
cancels prior requests and starts the matching scope without leaking another
context's details. Back/Forward recovers URL selection through shared helpers.
No persistent cross-session preference store is required for this spike.

Load detail only when expanded, reuse the supported detail API, and coalesce the
same request when it is already pending. Collapsing does not mutate the ticket.
Late results from an older refresh or context generation are discarded even when
aborting the underlying request races with completion. Keep links to full ticket
and PR context; expansion is not a reason to fetch every ticket's full history.

## Truthful interaction states

- First fetch: bounded skeleton rows plus a text loading status, with `aria-busy`
  on the list; controls remain labelled and usable where safe.
- Refresh: keep earlier rows visible, label them Updating and show their existing
  observation time until a newer result is accepted. Never label old data current.
- Empty, partial, stale, cancelled and failed are distinct. Show coverage warnings,
  shown/total counts and retry guidance from the service. Unknown is not zero work.
- Use an indeterminate indicator and step/status text unless the service supplies
  a real total and completed count. No elapsed-time-based invented percentages.
- An existing supported action shows pending, confirmed success, partial/unknown,
  or error with concrete recovery. Prevent duplicate submission by operation ID.
  Keep useful content and context after failure. Do not retry an uncertain write
  just because the browser lost its response.

The spike may use refresh and detail expansion as its action-feedback examples.
It does not require a new ticket mutation, permission mechanism or feature just
to demonstrate a spinner. If write controls are integrated later, they consume
shared native admission and the reviewed served-write session unchanged.

Use semantic buttons, headings and lists; `aria-expanded`/`aria-controls`, useful
status announcements and visible focus. Skeletons are decorative, not repeated
announcements. Respect reduced motion and keep status meaningful without animation
or colour. Narrow layouts and zoom preserve readable task titles and control order.

## TypeScript, build, package and CSP

Use Svelte components with `<script lang="ts">`; script logic remains strict
TypeScript. Component markup/CSS is a deliberate UI format, not permission for
plain-JavaScript application services or workflow policy. Keep service types and
API parsing in shared typed modules. Document the narrow `.svelte` source-format
allowance alongside the TypeScript policy in the implementation PR.

Svelte/compiler/plugin tooling is development/build-only. First prove integration
with the installed Vite+ toolchain in a small deterministic asset build; do not
introduce a production dev server or runtime compiler. If the official plugin is
incompatible, record the actual incompatibility before proposing another build
pipeline. Component checking must be explicit in `npm run check`; TypeScript
service checks alone do not prove component types are checked.

Produce a fixed set of locally served JS/CSS assets during `npm run build` and
`prepack`, embedded in generated modules consumed by `serve` or explicitly listed
in npm package files. The implementation chooses one packaging mechanism and
verifies it in a packed install outside the checkout. No cwd-relative reads from
`src/`, missing dist assets, CDN scripts/fonts or browser-side package resolution.
Do not add Svelte server-side rendering or change the CLI/MCP entry architecture.

Keep external same-origin scripts and CSS under current CSP. No inline scripts,
inline event handlers, `eval`, relaxed script policy or runtime-injected styles
requiring unsafe-inline. Escape source data; do not render ticket Markdown or
service error text as trusted HTML. Bootstrap selection through the shared URL
and versioned status/API, not interpolated executable JavaScript. Preserve
Host/Origin guards, served-project allowlist and authentication isolation.

## Delivery and acceptance

1. Prove/check the component asset pipeline and npm inclusion with a minimal
   Work-root fixture; no change to the default route or another page renderer.
2. Implement the read-only queue, inline details and loading/refresh/error states
   using the existing services and shared shell.
3. Verify wide/narrow layouts, keyboard and reduced motion, then publish the exact
   source-install/start/preview URL and real screenshots for the human to try.

Focused tests use injected facts/clock/transport for list parity, stable identity,
multiple open rows, refresh/reorder/removal, project/role/agent changes and late
responses. Test pending/error/partial/unknown without live GitHub writes or model
turns. Include one packed-server smoke of assets under CSP. Do not snapshot every
pixel, add paid agent trials, benchmark an entire framework survey or duplicate
existing native policy matrices. Record actual accessibility limits rather than
claiming a screen-reader pass from a DOM tree.

Promotion to the default Work page, migration of other pages, a component library,
and unrelated task mutations remain separate follow-ups after preview feedback.
