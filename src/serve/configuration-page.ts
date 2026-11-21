/**
 * The Configuration page (#818): a static bootstrap whose Svelte component (src/web/configura­
 * tion) reads `/api/v1/configuration`. The server renders no configuration HTML, computes nothing
 * about a value's meaning and never reads the registry itself (#852, #853 contract).
 *
 * The page is read-only in this slice: no save, reset, registration editing, reload or shutdown.
 * Global is shown when no project is selected (the marker below keeps the shared project
 * selection from auto-selecting one), and a registered project's own repository settings are
 * shown when the shell selects one.
 */
import { shellContext, shellStart } from "./shell.js";

export const configurationAssets = {
  script: "/web/configuration.js",
  stylesheet: "/web/configuration.css",
} as const;

/**
 * The static `/configuration` bootstrap. `data-project-selection="none"` tells the shared
 * project-selection script not to auto-restore a remembered or sole project onto this page:
 * opening the page shows Global by default, and a project is chosen only when the human (or the
 * toolbar) links to one explicitly.
 */
export function configurationBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so (#1138). */
  assetsAvailable = true,
): string {
  const context = shellContext("configuration", served, query);
  const heading = `<main id="content" tabindex="-1" data-project-selection="none"><h1>Configuration</h1>`;
  if (!assetsAvailable)
    return `${shellStart(context, "Configuration")}${heading}
<p class="error" role="alert">The Configuration page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same data is available from <code>/api/v1/configuration</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(
    context,
    "Configuration",
    configurationAssets.script,
    configurationAssets.stylesheet,
  )}${heading}
<div id="configuration-app" data-api="/api/v1/configuration"><p role="status">Loading configuration…</p></div>
<noscript><p class="warn">This page needs JavaScript. The same data is available from <code>/api/v1/configuration</code>.</p></noscript>
</main>
</body>
</html>
`;
}
