/**
 * The experimental Svelte Work preview served at `/work-preview` (#753,
 * doc/design/svelte-work-spike.md). A static bootstrap: the shared shell, a mount point and the
 * built assets. The component reads the existing `/api/v1/briefing` and `/api/v1/tickets/N`; the
 * server generates no work HTML here, and loading the page reads nothing from GitHub. The default
 * Work page at `/` is unchanged; this page is not linked from the main navigation.
 */
import { shellContext, shellStart } from "./shell.js";

export const workPreviewAssets = {
  script: "/web/work.js",
  stylesheet: "/web/work.css",
} as const;

export function workPreviewBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so. */
  assetsAvailable = true,
): string {
  const context = shellContext("work-preview", served, query);
  const heading = `<main id="content" tabindex="-1"><h1>Work (preview)</h1>
<p class="warn">Experimental Svelte preview of the Work page. The default Work page is unchanged.</p>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Work (preview)")}${heading}
<p class="error" role="alert">The Work preview's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The default Work page is at <a href="/">/</a>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(context, "Work (preview)", workPreviewAssets.script, workPreviewAssets.stylesheet)}${heading}
<div id="work-app" data-api="/api/v1/briefing" data-ticket-api="/api/v1/tickets"><p role="status">Loading the work list…</p></div>
<noscript><p class="warn">This preview needs JavaScript. The default Work page at <a href="/">/</a> does not.</p></noscript>
</main>
</body>
</html>
`;
}
