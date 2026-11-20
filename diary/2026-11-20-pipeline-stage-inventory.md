# Pipeline Health: current stage inventory (#684)

Added `/pipeline`, the second API-first Svelte page, as the first Pipeline Health section. The
backend already existed (#883, `/api/v1/metrics?view=inventory`), so this is page work only:
a client that parses the `serve-read` envelope, cancels superseded reads and re-reads on an
explicit Refresh, and a table of ready, blocked and agent-claimed stages with median and oldest
age, unknown ages and a bounded drill-down to `/ticket`.

Adding a second page exposed a build problem: with two inputs, Vite split shared Svelte code into
a chunk the entries `import`, which classic `<script defer>` tags cannot load. Each page is now
built on its own as an IIFE. That first inlined the CSS as an injected style element, which the
CSP forbids, so `cssCodeSplit: false` keeps the stylesheet a file named after the page.
