/** Shared, read-only HTML navigation and URL binding (#605). No I/O or workflow decisions. */
export type PageScope = "project" | "project-optional" | "global-or-project" | "account";
export interface ServedPage {
  id: string;
  path: string;
  label: string;
  scope: PageScope;
  parameters: readonly string[];
  carries: readonly string[];
  shipped: boolean;
  section?: string;
}
export const servedPages: readonly ServedPage[] = [
  {
    id: "work",
    path: "/",
    label: "Work",
    scope: "project",
    parameters: ["repo", "role", "agent"],
    carries: ["role", "agent"],
    shipped: true,
  },
  {
    id: "ticket",
    path: "/ticket",
    label: "Ticket",
    scope: "project",
    parameters: ["repo", "n", "role", "agent"],
    carries: ["role", "agent"],
    shipped: true,
    section: "work",
  },
  {
    id: "human",
    path: "/human",
    label: "Human attention",
    scope: "project",
    parameters: ["repo", "agent"],
    carries: [],
    shipped: true,
    section: "work",
  },
  {
    id: "activity",
    path: "/activity",
    label: "Activity",
    scope: "project",
    parameters: ["repo", "window"],
    carries: [],
    shipped: true,
    section: "work",
  },
  // Pipeline Health (#575, #684): API-first; the page reads /api/v1/metrics.
  {
    id: "pipeline",
    path: "/pipeline",
    label: "Pipeline",
    scope: "project",
    parameters: ["repo"],
    carries: [],
    shipped: true,
  },
  {
    id: "rules",
    path: "/rules",
    label: "Rules",
    scope: "project-optional",
    parameters: ["repo", "role", "rule"],
    carries: [],
    shipped: true,
  },
  {
    id: "setup",
    path: "/setup",
    label: "Setup",
    scope: "project-optional",
    parameters: ["repo", "role"],
    carries: [],
    shipped: true,
  },
  {
    id: "diagnostics",
    path: "/diagnostics",
    label: "Diagnostics",
    scope: "global-or-project",
    parameters: ["repo", "tab"],
    carries: ["tab"],
    shipped: true,
  },
  {
    id: "quotas",
    path: "/quotas",
    label: "Quotas",
    scope: "account",
    parameters: ["repo", "role", "agent"],
    carries: ["role", "agent"],
    shipped: true,
  },
];
export type ServedProject = { repository: string; project?: string };
export interface PageSelection {
  state: "selected" | "none" | "global" | "account" | "malformed" | "unserved";
  status: number;
  repository: string | null;
  query: URLSearchParams;
  message?: string;
}
export const htmlEscape = (value: string | number | null): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export const pageById = (id: string): ServedPage => {
  const page = servedPages.find((p) => p.id === id);
  if (!page) throw new Error("Unknown served page");
  return page;
};
/** Validate only literal URL inputs and served-resource binding. Missing selection stays absent. */
export function resolvePageSelection(
  query: URLSearchParams,
  served: readonly ServedProject[],
  page: ServedPage,
): PageSelection {
  const error = (
    status: number,
    state: "malformed" | "unserved",
    message: string,
  ): PageSelection => ({ status, state, repository: null, query: new URLSearchParams(), message });
  for (const key of new Set(query.keys())) {
    if (!page.parameters.includes(key))
      return error(
        400,
        "malformed",
        "Unknown parameter for this page. Choose a served project from the menu.",
      );
    if (query.getAll(key).length !== 1)
      return error(400, "malformed", "Give each parameter at most once.");
  }
  const role = query.get("role");
  if (
    role !== null &&
    ![
      "implementer",
      "designer",
      ...(page.id === "work" || page.id === "ticket" || page.id === "quotas" ? ["human"] : []),
    ].includes(role)
  )
    return error(400, "malformed", "role must be a supported role for this page.");
  const agent = query.get("agent");
  if (agent !== null && !/^[A-Za-z0-9][\w.-]{0,99}$/.test(agent))
    return error(400, "malformed", "agent must be a name (letters, digits, . _ -).");
  const n = query.get("n");
  if (n !== null && (!/^[1-9]\d{0,15}$/.test(n) || !Number.isSafeInteger(Number(n))))
    return error(400, "malformed", "n must be a positive safe integer.");
  const repo = query.get("repo");
  if (page.id === "ticket" && repo !== null && n === null)
    return error(400, "malformed", "Open a ticket from Work or provide its positive number as n.");
  if (repo === null)
    return {
      status: 200,
      state:
        page.scope === "account"
          ? "account"
          : page.scope === "global-or-project"
            ? "global"
            : "none",
      repository: null,
      query: new URLSearchParams(query),
    };
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo))
    return error(
      400,
      "malformed",
      "repo must be owner/name. Choose a served project from the menu.",
    );
  const found = served.find((s) => s.repository.toLowerCase() === repo.toLowerCase());
  if (!found)
    return error(
      403,
      "unserved",
      "That repository is not served by this server. Choose a served project from the menu.",
    );
  const canonical = new URLSearchParams(query);
  canonical.set("repo", found.repository);
  return {
    status: 200,
    state: page.scope === "account" ? "account" : "selected",
    repository: found.repository,
    query: canonical,
  };
}
export interface ShellContext {
  page: string;
  served: readonly ServedProject[];
  selection: PageSelection;
}
export function shellContext(
  page: string,
  served: readonly ServedProject[] = [],
  query = new URLSearchParams(),
): ShellContext {
  return { page, served, selection: resolvePageSelection(query, served, pageById(page)) };
}
/** Fixed-order, root-relative links. Only equivalent Work/Ticket identity keys cross pages. */
export function pageHref(
  page: ServedPage,
  selection: PageSelection,
  from?: ServedPage,
  samePage = false,
): string {
  const query = new URLSearchParams();
  if (selection.repository) query.set("repo", selection.repository);
  for (const key of page.parameters) {
    if (key === "repo") continue;
    if (
      (samePage || (from?.carries.includes(key) && page.carries.includes(key))) &&
      selection.query.has(key)
    )
      query.set(key, selection.query.get(key)!);
  }
  return page.path + (query.size ? `?${query}` : "");
}
export function renderToolbar(context: ShellContext): string {
  const page = pageById(context.page),
    selection = context.selection;
  const active = page.section ?? page.id;
  const carryAttribute = (target: ServedPage) => {
    const keys = target.carries.filter((key) => page.carries.includes(key));
    return keys.length ? ` data-shell-carries="${htmlEscape(keys.join(" "))}"` : "";
  };
  const links = servedPages
    .filter((p) => p.shipped && !p.section)
    .map(
      (p) =>
        `<a href="${htmlEscape(pageHref(p, selection, page))}"${carryAttribute(p)}${p.id === active ? ' aria-current="page"' : ""}>${htmlEscape(p.label)}</a>`,
    )
    .join(" ");
  const destination = page.id === "ticket" ? pageById("work") : page;
  const projects = context.served
    .map((s) => {
      const selected = { ...selection, repository: s.repository };
      return `<li><a href="${htmlEscape(pageHref(destination, selected, page))}"${carryAttribute(destination)}${s.repository === selection.repository ? ' aria-current="true"' : ""}>${htmlEscape(s.repository)}</a></li>`;
    })
    .join("");
  const indicator =
    page.scope === "account"
      ? "Account-wide: your GitHub login's quotas, not a project's"
      : selection.repository
        ? ""
        : selection.state === "global"
          ? "Scope: Global"
          : !context.served.length
            ? "No projects are served"
            : "No project selected";
  // One consistent toolbar on every served page (#733): project/context selection on the top
  // row (always visible, even on account-wide pages, clearly labelled as context), page
  // navigation on the row below, then page content. Controls sit above the content they affect.
  const projectMenu = `<details class="project-menu"><summary>${htmlEscape(
    selection.repository ? selection.repository : "Change project",
  )}</summary><ul>${projects || "<li>No projects are served. Start pdb serve with --repo or --project.</li>"}</ul></details>`;
  return `<header class="shell-toolbar"><a class="skip-link" href="#content">Skip to content</a><div class="shell-context"><a class="product" href="${htmlEscape(pageHref(pageById("work"), selection, page))}"${carryAttribute(pageById("work"))}>Presidential Daily Briefing</a>${projectMenu}${indicator ? `<span>${htmlEscape(indicator)}</span>` : ""}<p class="working-for" data-working-for role="status" aria-live="polite">Working for: loading…</p></div><div class="shell-menus"><nav class="wide-pages" aria-label="Pages">${links}</nav><details class="narrow-pages"><summary>Pages: ${htmlEscape(pageById(active).label)}</summary><nav aria-label="Pages">${links}</nav></details></div></header>`;
}
export function shellStart(
  context: ShellContext,
  title: string,
  script?: string,
  stylesheet?: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)}</title><link rel="stylesheet" href="/dashboard.css">${stylesheet ? `<link rel="stylesheet" href="${htmlEscape(stylesheet)}">` : ""}<script src="/project-selection.js" defer></script>${script ? `<script src="${htmlEscape(script)}" defer></script>` : ""}</head><body>${renderToolbar(context)}`;
}
export function shellPage(
  context: ShellContext,
  title: string,
  main: string,
  script?: string,
  footer = "Read-only. Navigation changes no project state.",
): string {
  return `${shellStart(context, title, script)}<main id="content" tabindex="-1" ${context.selection.repository ? `data-repo="${htmlEscape(context.selection.repository)}"` : ""}><h1>${htmlEscape(title)}</h1>${main}</main><footer>${footer}</footer></body></html>`;
}
export function selectionErrorPage(context: ShellContext): string {
  return shellPage(
    context,
    "Choose a project",
    `<p class="error" role="alert">${htmlEscape(context.selection.message ?? "No project selected. Choose a served project from the menu.")}</p>`,
  );
}
export const shellCss = `
.working-for { margin: 0; font-size: 0.9em; overflow-wrap: anywhere; }
.working-for[data-state="unresolved"], .working-for[data-state="unavailable"] { font-style: italic; }
:root { --toolbar-height: 9rem; }
html { scroll-padding-top: var(--toolbar-height); }
:where([id], a, button, input, select, summary) { scroll-margin-top: var(--toolbar-height); }
.shell-toolbar { z-index: 10; position: sticky; top: 0; background: Canvas; padding: .5rem 0; border-bottom: 1px solid GrayText; }
.shell-context { display: flex; flex-wrap: wrap; gap: .25rem 1rem; align-items: baseline; overflow-wrap: anywhere; }
.product { font-weight: 700; }
.process-identity { display: flex; flex-wrap: wrap; gap: .3rem 1rem; margin-top: .7rem; padding-top: .5rem; border-top: 1px solid GrayText; font-size: .85rem; overflow-wrap: anywhere; }
.process-identity code { overflow-wrap: anywhere; }
.project-menu { position: relative; }
.project-menu summary { cursor: pointer; font-size: .85rem; border: 1px solid GrayText; border-radius: .25rem; padding: .15rem .5rem; }
.shell-menus { display: flex; gap: .5rem 1rem; align-items: start; margin-top: .5rem; }
.shell-menus nav a { display: inline-block; margin: 0 .6rem .2rem 0; }
.narrow-pages { position: relative; }
.project-menu ul, .narrow-pages nav { position: absolute; z-index: 11; background: Canvas; border: 1px solid GrayText; padding: .75rem; margin: .25rem 0 0; width: min(24rem, 75vw); max-height: 50vh; overflow: auto; overflow-wrap: anywhere; }
.project-menu ul { list-style: none; }
.project-menu li { margin: 0 0 .5rem; }
.narrow-pages { display: none; }
.skip-link { position: absolute; left: -10000px; }
.skip-link:focus { left: 0; top: 0; background: Canvas; z-index: 12; }
:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
nav a[aria-current], .project-menu a[aria-current] { font-weight: 700; text-decoration: underline; text-decoration-thickness: 3px; }
@media (prefers-color-scheme: dark) { .error { color: #ff8a80; } .warn { color: #ffcc80; } }
@media (max-width: 40rem) {
  :root { --toolbar-height: 10rem; }
  .wide-pages { display: none; }
  .narrow-pages { display: block; }
  .narrow-pages nav { right: 0; }
  .shell-context { display: block; font-size: .85rem; }
  .shell-context span { display: block; }
}
@media (max-height: 30rem) { .shell-toolbar { position: static; } }
`;
