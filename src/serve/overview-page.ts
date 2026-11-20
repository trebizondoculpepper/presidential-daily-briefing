/**
 * The Overview page served at `/overview` (#824, doc/design/dashboard-pipeline-metrics.md "Overview / News
 * (#574)"). A static bootstrap: the shared shell, a mount point and the built assets. The
 * component reads `/api/v1/metrics?view=news`; the server generates no figures here, and loading
 * the page reads nothing from GitHub.
 */
import { shellContext, shellStart } from "./shell.js";

export const overviewAssets = {
  script: "/web/overview.js",
  stylesheet: "/web/overview.css",
} as const;

export function overviewBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so. */
  assetsAvailable = true,
): string {
  const context = shellContext("overview", served, query);
  const heading = `<main id="content" tabindex="-1"><h1>Overview</h1>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Overview")}${heading}
<p class="error" role="alert">The Overview page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same data is available from <code>/api/v1/metrics?view=news</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(context, "Overview", overviewAssets.script, overviewAssets.stylesheet)}${heading}
<div id="overview-app" data-api="/api/v1/metrics" data-team-api="/api/v1/team"><p role="status">Loading the overview…</p></div>
<noscript><p class="warn">This page needs JavaScript. The same data is available from <code>/api/v1/metrics?view=news</code>.</p></noscript>
</main>
</body>
</html>
`;
}
