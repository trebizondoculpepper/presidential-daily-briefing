/**
 * The Pipeline Health page served at `/pipeline` (#575, #684; doc/design/dashboard-pipeline-metrics.md
 * and doc/design/serve-api-first-frontend.md). A static bootstrap: the shared shell, a mount point
 * and the built assets. The component reads `/api/v1/metrics` for the selected project; the
 * server generates no metrics HTML, and loading the page itself reads nothing from GitHub.
 */
import { shellContext, shellStart } from "./shell.js";

export const pipelineAssets = {
  script: "/web/pipeline.js",
  stylesheet: "/web/pipeline.css",
} as const;

export function pipelineBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so. */
  assetsAvailable = true,
): string {
  const context = shellContext("pipeline", served, query);
  const heading = `<main id="content" tabindex="-1"><h1>Pipeline health</h1>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Pipeline health")}${heading}
<p class="error" role="alert">The Pipeline page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same data is available from <code>/api/v1/metrics?view=inventory</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(context, "Pipeline health", pipelineAssets.script, pipelineAssets.stylesheet)}${heading}
<div id="pipeline-app" data-api="/api/v1/metrics"><p role="status">Loading the inventory…</p></div>
<noscript><p class="warn">This page needs JavaScript. The same data is available from <code>/api/v1/metrics?view=inventory</code>.</p></noscript>
</main>
</body>
</html>
`;
}
