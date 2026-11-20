/**
 * The Timing page served at `/timing` (#820, doc/design/dashboard-pipeline-metrics.md "Timing
 * (#576)"). A static bootstrap: the shared shell, a mount point and the built assets. The
 * component reads `/api/v1/metrics?view=timing`; the server generates no figures here, and loading
 * the page reads nothing from GitHub.
 */
import { shellContext, shellStart } from "./shell.js";

export const timingAssets = {
  script: "/web/timing.js",
  stylesheet: "/web/timing.css",
} as const;

export function timingBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so. */
  assetsAvailable = true,
): string {
  const context = shellContext("timing", served, query);
  const heading = `<main id="content" tabindex="-1"><h1>Timing</h1>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Timing")}${heading}
<p class="error" role="alert">The Timing page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same data is available from <code>/api/v1/metrics?view=timing</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(context, "Timing", timingAssets.script, timingAssets.stylesheet)}${heading}
<div id="timing-app" data-api="/api/v1/metrics"><p role="status">Loading the timing figures…</p></div>
<noscript><p class="warn">This page needs JavaScript. The same data is available from <code>/api/v1/metrics?view=timing</code>.</p></noscript>
</main>
</body>
</html>
`;
}
