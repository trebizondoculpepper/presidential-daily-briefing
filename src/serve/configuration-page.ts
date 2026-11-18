/**
 * The Configuration page (#818): a static shell plus a same-origin script that reads
 * `/api/v1/configuration`. Rendering happens in the browser; this module assembles no HTML from
 * domain data and the server computes nothing about what a value means (#852 contract).
 *
 * The page is read-only in this slice: no save, reset, registration editing, reload or
 * shutdown. Global is shown when no project is selected, and a registered project's own
 * repository settings when one is.
 */
import { shellContext, shellPage, type ShellContext } from "./shell.js";

export const configurationPage = (context: ShellContext = shellContext("configuration")): string =>
  shellPage(
    context,
    "Configuration",
    `
<section id="scope" aria-live="polite"><p>Loading configuration…</p></section>
<table>
<caption>Registered settings for the selected scope</caption>
<thead><tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Source</th><th scope="col">Type</th><th scope="col">Default</th><th scope="col">Description</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p id="warnings"></p>
`,
    "/configuration.js",
    "Read-only. Values, defaults and sources come from the configuration service.",
  );

/**
 * The browser script. Self-contained on purpose: it references no module-level names, so the
 * served text runs on its own, and the shell's strict CSP loads no external resource.
 */
export const configurationScript = (): string =>
  `const cell = (text) => {
  const td = document.createElement("td");
  td.textContent = text === undefined || text === null ? "" : String(text);
  return td;
};
const shown = (value) => (Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : String(value));
const load = async () => {
  const scope = document.getElementById("scope");
  const rows = document.getElementById("rows");
  const warnings = document.getElementById("warnings");
  const repo = (document.querySelector("main") || {}).dataset?.repo || "";
  const query = repo ? "?repo=" + encodeURIComponent(repo) : "";
  const response = await fetch("/api/v1/configuration" + query, { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || body.kind !== "configuration") {
    scope.textContent = body && body.error ? "Configuration could not be read: " + body.error.message : "Configuration could not be read.";
    return;
  }
  scope.textContent = (body.scope === "global" ? "Global (no project selected)" : "Project " + body.repository) + " — " + body.path;
  rows.replaceChildren();
  for (const row of body.rows) {
    const tr = document.createElement("tr");
    tr.append(cell(row.key), cell(shown(row.value)), cell(row.source), cell(row.type), cell(shown(row.defaultValue)), cell(row.description));
    rows.append(tr);
  }
  warnings.textContent = body.warnings.join(" ");
};
load();
`;
