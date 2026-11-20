/**
 * The Discussion page served at `/discussion` (#1103, doc/design/estimation-refinement-loop.md
 * "Discussion view"). A static bootstrap: the shared shell, a mount point and the built assets.
 * The component reads `/api/v1/discussion`; the server generates no ranking here, and loading the
 * page reads nothing from GitHub.
 */
import { shellContext, shellStart } from "./shell.js";

export const discussionAssets = {
  script: "/web/discussion.js",
  stylesheet: "/web/discussion.css",
} as const;

export function discussionBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so. */
  assetsAvailable = true,
): string {
  const context = shellContext("discussion", served, query);
  const heading = `<main id="content" tabindex="-1"><h1>Discussion</h1>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Discussion")}${heading}
<p class="error" role="alert">The Discussion page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same data is available from <code>/api/v1/discussion</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(context, "Discussion", discussionAssets.script, discussionAssets.stylesheet)}${heading}
<div id="discussion-app" data-api="/api/v1/discussion"><p role="status">Loading the discussion list…</p></div>
<noscript><p class="warn">This page needs JavaScript. The same data is available from <code>/api/v1/discussion</code>.</p></noscript>
</main>
</body>
</html>
`;
}
