import { pageById, shellContext, shellStart } from "./shell.js";
/**
 * The read-only project rules page served at `/rules` (#392, doc/design/rules-english-command.md
 * and doc/design/serve-global-dashboard-roadmap.md).
 *
 * It renders the very document `pdb rules` prints: the same `rulesDocument` built from the same
 * packaged English model, projected by the same `rulesText`. The page only splits that text into
 * its `== Section ==` parts under HTML headings, so the CLI and the page cannot say different
 * things. Nothing here describes an individual rule or reads runtime why templates.
 *
 * Loading the page reads at most the selected served project's local settings file through the
 * verified checkout resolver. It makes no GitHub request, starts no background work and writes
 * nothing. The response is static HTML with no script, under the dashboard's strict CSP.
 */
import {
  ConfigError,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
} from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import type { EffectiveSettings, RulesDocument } from "../rules/datalog/rules-command.js";
import { declaredRulesContext } from "../rules/declared-context.js";
import { projectRulesContext } from "../rules/project-context.js";
import { HttpFailure } from "./http.js";

/** Local, read-only boundaries for effective settings; tests inject fakes. */
export interface RulesPageRuntime {
  git: GitRunner;
  fs: ConfigFileSystem;
}

export const defaultRulesPageRuntime = (): RulesPageRuntime => ({
  git: nodeGit,
  fs: nodeFileSystem,
});

/** Query parameters the page accepts: the project and the `pdb rules` filters. */
export const rulesPageParameters = pageById("rules").parameters;

export const escapeHtml = (text: string | number | null): string =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** A link on the server's own origin with encoded query values. */
export function pageUrl(origin: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

/** One `== Title ==` part of the text listing; the opening part is the policy header. */
export interface RulesSection {
  title: string;
  lines: string[];
}

/** Split the `pdb rules` text into its sections without changing a single line. */
export function rulesSections(text: string): RulesSection[] {
  const sections: RulesSection[] = [{ title: "Policy", lines: [] }];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const heading = /^== (.+) ==$/.exec(line);
    if (heading) sections.push({ title: heading[1]!, lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  for (const s of sections) {
    while (s.lines[0] === "") s.lines.shift();
    while (s.lines.at(-1) === "") s.lines.pop();
  }
  return sections;
}

/**
 * Effective settings of one served repository. Known only when it was served with --project and
 * that checkout verifies as the repository; otherwise unknown, never the defaults.
 */
export async function effectiveSettings(
  served: { repository: string; project?: string },
  runtime: RulesPageRuntime,
): Promise<EffectiveSettings> {
  if (served.project === undefined)
    return {
      status: "unknown",
      reason: `${served.repository} is served without a local project (--repo only), so its committed settings are not read; this page makes no GitHub requests. Serve it with --project to show them, or run pdb config list in its checkout.`,
    };
  try {
    const target = await resolveRepositoryTarget(served.project, served.repository, runtime.git);
    const config = await loadConfig(target.root, runtime.fs);
    return {
      status: "known",
      repository: served.repository,
      readFrom:
        config.format === null ? `no settings file (${config.path} is absent)` : config.path,
      settings: config.settings.map((s) => ({ name: s.key, value: s.value, source: s.source })),
    };
  } catch (error) {
    // The code only: messages can carry absolute local paths.
    const code = error instanceof ConfigError ? error.code : "unreadable";
    return {
      status: "unknown",
      reason: `The settings of ${served.repository} could not be read from its local project (${code}), so they are not known and are not assumed to equal the defaults. Run pdb config list in its checkout.`,
    };
  }
}

interface PageContext {
  origin: string;
  served: readonly { repository: string; project?: string }[];
  /** The selected repository, or null when the selection is missing and ambiguous. */
  selected: string | null;
  filters: { role?: string; rule?: string };
}

const navigation = (page: PageContext, title = "Project rules") =>
  shellStart(
    shellContext(
      "rules",
      page.served,
      new URLSearchParams(page.selected ? { repo: page.selected } : {}),
    ),
    title,
  );

/** The full page for one compiled document. */
export function rulesPageHtml(doc: RulesDocument, text: string, page: PageContext): string {
  const sections = rulesSections(text);
  const effective = doc.defaults.effective;
  const filters = Object.entries(page.filters).filter(([, v]) => v !== undefined);
  const notices: string[] = [];
  if (page.selected === null)
    notices.push(
      '<p class="warn" role="status">No project selected; choose one above to see its effective settings. The policy below is the same for every project.</p>',
    );
  if (doc.effectivePolicy.state === "error")
    notices.push(
      `<p class="error" role="alert">Project policy error: ${escapeHtml(doc.effectivePolicy.reason)}. ${doc.effectivePolicy.next.map(escapeHtml).join(" ")}</p>`,
    );
  if (!doc.scope.complete)
    notices.push(
      `<p class="warn" role="status">Filtered subset (${filters
        .map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`)
        .join(", ")}): not the complete rules. <a href="${escapeHtml(
        pageUrl(page.origin, "/rules", page.selected ? { repo: page.selected } : {}),
      )}">Show every rule</a>.</p>`,
    );
  const identity = `<dl class="identity">
<dt>Policy version</dt><dd><code>${escapeHtml(doc.policy.policyVersion)}</code></dd>
<dt>Default rulesHash</dt><dd><code>${escapeHtml(doc.policy.rulesHash)}</code></dd>
<dt>Effective policy</dt><dd>${
    doc.effectivePolicy.state === "active"
      ? `default plus project preferences, <code>${escapeHtml(doc.effectivePolicy.effectiveRulesHash)}</code>`
      : doc.effectivePolicy.state === "disabled"
        ? "the shipped default only (project preferences disabled)"
        : doc.effectivePolicy.state === "error"
          ? '<span class="error">error: project preferences are enabled but not in force</span>'
          : "unknown"
  }</dd>
<dt>Sources</dt><dd>${doc.policy.sources.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}</dd>
<dt>English model</dt><dd><code>${escapeHtml(doc.policy.englishModelVersion)}</code></dd>
<dt>Scope</dt><dd>${doc.scope.complete ? "complete" : "filtered subset"}</dd>
<dt>Effective settings</dt><dd>${effective.status === "known" ? `known for ${escapeHtml(effective.repository)}` : "unknown"}</dd>
</dl>
`;
  const toc = sections
    .map((s, i) => `<li><a href="#section-${i}">${escapeHtml(s.title)}</a></li>`)
    .join("");
  const body = sections
    .map(
      (s, i) =>
        `<section id="section-${i}"><h2>${escapeHtml(s.title)}</h2>\n<pre class="rules">${escapeHtml(s.lines.join("\n"))}</pre></section>`,
    )
    .join("\n");
  return `${navigation(page)}<main id="content" tabindex="-1"><h1>Project rules</h1>
${notices.join("\n")}
${identity}<nav aria-label="Sections"><ol class="toc">${toc}</ol></nav>
${body}
</main>
<footer>Read-only. Compiled from the packaged policy artifact and, when enabled, the project's <code>pdb.rules.edn</code>; the same document as <code>pdb rules${filters.map(([k, v]) => ` --${escapeHtml(k)} ${escapeHtml(v)}`).join("")}</code>. Loading this page makes no GitHub requests.</footer>
</body>
</html>
`;
}

/** An error page: the reason and the served projects, never an older document. */
export function rulesErrorHtml(message: string, page: PageContext): string {
  return `${navigation({ ...page, selected: null }, "Project rules: error")}<main id="content" tabindex="-1"><h1>Project rules</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}

export interface RulesPageResult {
  status: number;
  html: string;
}

/**
 * Build the page for one request's query. Unserved or malformed selections fail with the
 * served-project list; an artifact that does not match the engine fails without a document.
 */
export async function rulesPage(
  query: URLSearchParams,
  origin: string,
  served: readonly { repository: string; project?: string }[],
  runtime: RulesPageRuntime,
  /** The served-project resolver the read API uses (`selectRepository`). */
  select: (
    served: readonly { repository: string; project?: string }[],
    repo: string | undefined,
  ) => { repository: string; project?: string },
): Promise<RulesPageResult> {
  const page: PageContext = { origin, served, selected: null, filters: {} };
  for (const key of query.keys())
    if (!(rulesPageParameters as readonly string[]).includes(key))
      return {
        status: 400,
        html: rulesErrorHtml(
          `Unknown parameter. The rules page accepts ${rulesPageParameters.join(", ")}.`,
          page,
        ),
      };
  for (const key of new Set(query.keys()))
    if (query.getAll(key).length > 1)
      return { status: 400, html: rulesErrorHtml("Give each parameter at most once.", page) };
  const repo = query.get("repo") ?? undefined;
  let selected: { repository: string; project?: string } | null = null;
  try {
    selected = repo === undefined ? null : select(served, repo);
  } catch (error) {
    if (!(error instanceof HttpFailure)) throw error;
    // Missing selection with several projects: show the selector and the shared policy.
    if (error.code !== "REPOSITORY_UNRESOLVED")
      return {
        status: error.status,
        html: rulesErrorHtml(
          error.code === "REPOSITORY_NOT_SERVED"
            ? "That repository is not served by this server. Choose a served project above."
            : "repo must be owner/name. Choose a served project above.",
          page,
        ),
      };
  }
  page.selected = selected?.repository ?? null;
  const filters = {
    ...(query.has("role") ? { role: query.get("role")! } : {}),
    ...(query.has("rule") ? { rule: query.get("rule")! } : {}),
  };
  page.filters = filters;
  const rules = await import("../rules/datalog/datalog.js");
  const effective = selected
    ? await effectiveSettings(selected, runtime)
    : ({
        status: "unknown",
        reason: "No project is selected, so no project's effective settings are shown.",
      } as EffectiveSettings);
  // #516: the same project enablement and loader the briefing uses, from the verified checkout.
  const { project, limits } = await projectRulesContext(
    !selected
      ? {
          unknown:
            "No project is selected, so whether project preferences are in force is unknown.",
        }
      : selected.project === undefined
        ? {
            unknown: `${selected.repository} is served without a local project (--repo only), so its project configuration and pdb.rules.edn are not read; whether project preferences are in force is unknown. Serve it with --project.`,
          }
        : {
            repository: selected.repository,
            runtime: { cwd: selected.project, git: runtime.git, fs: runtime.fs },
          },
  );
  try {
    const doc = rules.rulesDocument(
      { ...declaredRulesContext(), effective, project },
      filters,
      undefined,
      limits,
    );
    return { status: 200, html: rulesPageHtml(doc, rules.rulesText(doc), page) };
  } catch (error) {
    if (error instanceof rules.RulesArgumentError)
      return { status: 400, html: rulesErrorHtml(error.message, page) };
    if (error instanceof rules.RulesArtifactError)
      return {
        status: 500,
        html: rulesErrorHtml(
          `The packaged policy could not be compiled to a current document: ${error.message}`,
          page,
        ),
      };
    throw error;
  }
}
