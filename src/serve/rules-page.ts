import { pageById, shellContext, shellStart } from "./shell.js";
/**
 * The read-only project rules page served at `/rules` (#392, doc/design/rules-english-command.md
 * and doc/design/serve-global-dashboard-roadmap.md).
 *
 * It renders the same compiled rules document as the formal CLI. Authored rule purposes
 * appear before native details controls; the shared formal formatter supplies conditions,
 * ordering and evidence. Missing metadata remains a visible gap. No rule matching occurs here.
 *
 * API-first (#853, doc/design/serve-api-first-frontend.md): `readRules` is the shared read the
 * versioned `/api/v1/rules` route returns as data; `/rules` is a static bootstrap whose Svelte
 * component (src/web/rules) fetches that route. The server generates no rules HTML.
 *
 * A read loads at most the selected served project's local settings file through the verified
 * checkout resolver. It makes no GitHub request, starts no background work and writes nothing.
 */
import {
  ConfigError,
  loadConfig,
  nodeFileSystem,
  resolveRepositoryTarget,
} from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import {
  decisionFormalLines,
  denialFormalLines,
  denialQueryLines,
  decisionGroups,
} from "../rules/datalog/english-render.js";
import type { EffectiveSettings, RulesDocument } from "../rules/datalog/rules-command.js";
import { declaredRulesContext } from "../rules/declared-context.js";
import { projectRulesContext } from "../rules/project-context.js";
import { HttpFailure } from "./http.js";
import type { ServeErrorCode } from "./http.js";

/** Local, read-only boundaries for effective settings; tests inject fakes. */
export interface RulesPageRuntime {
  /**
   * A legacy runner for tests; when omitted (production) every checkout read goes through the
   * typed Git service with its isolated runner (#938, #904).
   */
  git?: GitRunner;
  fs: ConfigFileSystem;
}

export const defaultRulesPageRuntime = (): RulesPageRuntime => ({
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

/** One rule as the page lists it: its ID, authored purpose (null when not supplied) and formal lines. */
export interface RulesRuleView {
  id: string;
  purpose: string | null;
  /** The generated formal conditions, or null when the rule has none of its own. */
  formal: string[] | null;
}
/** A formal block shown behind a disclosure control. */
export interface RulesFormalView {
  label: string;
  lines: string[];
}
/**
 * One section of the rules listing, arranged from the shared text and document by the existing
 * display helpers. It decides no policy and invents no English: every string is supplied content.
 */
export type RulesSectionView =
  | { kind: "text"; title: string; lines: string[] }
  | { kind: "formal"; title: string; formal: RulesFormalView }
  | {
      kind: "decisions";
      title: string;
      introduction: string;
      bands: { band: number; rules: RulesRuleView[] }[];
    }
  | {
      kind: "rules";
      title: string;
      /** A formal block shown before the rules (the denial query), when any. */
      before: RulesFormalView | null;
      rules: RulesRuleView[];
      /** A formal block shown after the rules, when any. */
      after: RulesFormalView | null;
    };

/** The rules page's data: the document's own typed metadata plus its arranged sections. */
export interface RulesView {
  policy: RulesDocument["policy"];
  effectivePolicy: RulesDocument["effectivePolicy"];
  scope: RulesDocument["scope"];
  narration: RulesDocument["narration"];
  effectiveSettings: RulesDocument["defaults"]["effective"];
  sections: RulesSectionView[];
}

/** Arrange one compiled document and its formal text for display, without changing either. */
export function rulesView(doc: RulesDocument, text: string): RulesView {
  const formal = (lines: string[], label: string): RulesFormalView => ({ label, lines });
  const rule = (r: { id: string; purpose?: string }, lines?: string[]): RulesRuleView => ({
    id: r.id,
    purpose: r.purpose ?? null,
    formal: lines ?? null,
  });
  const sections: RulesSectionView[] = rulesSections(text).map((s) => {
    if (s.title.startsWith("Decision rules ("))
      return {
        kind: "decisions",
        title: s.title,
        introduction: s.lines[0] ?? "",
        bands: decisionGroups(doc.decisions).map(({ band, decisions }) => ({
          band,
          rules: decisions.map((d) => rule(d, decisionFormalLines(d))),
        })),
      };
    if (s.title.startsWith("Eligibility and denials ("))
      return {
        kind: "rules",
        title: s.title,
        before: doc.eligibility.denialQuery
          ? formal(denialQueryLines(doc.eligibility.denialQuery), "Formal denial query")
          : null,
        rules: doc.eligibility.denials.map((d) => rule(d, denialFormalLines(d))),
        after: null,
      };
    if (s.title.startsWith("Procedural obligations ("))
      return {
        kind: "rules",
        title: s.title,
        before: null,
        rules: doc.obligations.map((o) => rule(o)),
        after: formal(s.lines, "Structured obligation definitions"),
      };
    if (s.title.startsWith("Project preferences (") && doc.project)
      return {
        kind: "rules",
        title: s.title,
        before: null,
        rules: doc.project.preferences.map((p) => rule(p)),
        after: formal(s.lines, "Formal conditions for project preferences and helpers"),
      };
    if (["Policy", "Defaults", "Not formalized here"].includes(s.title))
      return { kind: "text", title: s.title, lines: s.lines };
    return {
      kind: "formal",
      title: s.title,
      formal: formal(s.lines, `Formal ${s.title.toLowerCase()}`),
    };
  });
  return {
    policy: doc.policy,
    effectivePolicy: doc.effectivePolicy,
    scope: doc.scope,
    narration: doc.narration,
    effectiveSettings: doc.defaults.effective,
    sections,
  };
}

/** The shared rules read for one request's query: the view, or a coded refusal. */
export type RulesRead =
  | {
      ok: true;
      /** The selected repository, or null when the selection is missing and ambiguous. */
      selected: string | null;
      filters: { role?: string; rule?: string };
      view: RulesView;
    }
  | { ok: false; status: number; code: ServeErrorCode; message: string };

/**
 * Read the rules for one query (#853): the same document as `pdb rules`, with the selected served
 * project's effective settings and project preferences. Unserved or malformed selections and
 * unknown parameters are refused; a policy that does not match the engine fails without a view.
 */
export async function readRules(
  query: URLSearchParams,
  served: readonly { repository: string; project?: string }[],
  runtime: RulesPageRuntime,
  /** The served-project resolver the read API uses (`selectRepository`). */
  select: (
    served: readonly { repository: string; project?: string }[],
    repo: string | undefined,
  ) => { repository: string; project?: string },
): Promise<RulesRead> {
  const refuse = (status: number, code: ServeErrorCode, message: string): RulesRead => ({
    ok: false,
    status,
    code,
    message,
  });
  for (const key of query.keys())
    if (!(rulesPageParameters as readonly string[]).includes(key))
      return refuse(
        400,
        "INVALID_ARGUMENT",
        `Unknown parameter. The rules page accepts ${rulesPageParameters.join(", ")}.`,
      );
  for (const key of new Set(query.keys()))
    if (query.getAll(key).length > 1)
      return refuse(400, "INVALID_ARGUMENT", "Give each parameter at most once.");
  const repo = query.get("repo") ?? undefined;
  let selected: { repository: string; project?: string } | null = null;
  try {
    selected = repo === undefined ? null : select(served, repo);
  } catch (error) {
    if (!(error instanceof HttpFailure)) throw error;
    // Missing selection with several projects: the shared policy, with no project's settings.
    if (error.code !== "REPOSITORY_UNRESOLVED")
      return refuse(
        error.status,
        error.code,
        error.code === "REPOSITORY_NOT_SERVED"
          ? "That repository is not served by this server. Choose a served project."
          : "repo must be owner/name. Choose a served project.",
      );
  }
  const filters = {
    ...(query.has("role") ? { role: query.get("role")! } : {}),
    ...(query.has("rule") ? { rule: query.get("rule")! } : {}),
  };
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
    return {
      ok: true,
      selected: selected?.repository ?? null,
      filters,
      view: rulesView(doc, rules.rulesFormalText(doc)),
    };
  } catch (error) {
    if (error instanceof rules.RulesArgumentError)
      return refuse(400, "INVALID_ARGUMENT", error.message);
    if (error instanceof rules.RulesArtifactError)
      return refuse(
        500,
        "INTERNAL",
        `The packaged policy could not be compiled to a current document: ${error.message}`,
      );
    throw error;
  }
}

/** Built frontend assets the rules page loads from this server's origin (#853). */
export const rulesAssets = { script: "/web/rules.js", stylesheet: "/web/rules.css" } as const;

/**
 * The static `/rules` bootstrap: the shared shell, a mount point and the built assets. It carries
 * no rules content; the component reads `/api/v1/rules` with the page's own query.
 */
export function rulesBootstrapHtml(
  served: readonly { repository: string; project?: string }[],
  query: URLSearchParams,
  /** Whether the built frontend assets are served; without them the page says so (#1138). */
  assetsAvailable = true,
): string {
  const context = shellContext("rules", served, query);
  if (!assetsAvailable)
    return `${shellStart(context, "Project rules")}<main id="content" tabindex="-1"><h1>Project rules</h1>
<p class="error" role="alert">The Rules page's frontend assets are not built, so this page cannot load. Run <code>npm run build</code> in this source checkout and restart <code>pdb serve</code>. The same document is available from <code>pdb rules</code> and <code>/api/v1/rules</code>.</p>
</main>
</body>
</html>
`;
  return `${shellStart(
    context,
    "Project rules",
    rulesAssets.script,
    rulesAssets.stylesheet,
  )}<main id="content" tabindex="-1"><h1>Project rules</h1>
<div id="rules-app" data-api="/api/v1/rules"><p role="status">Loading the rules…</p></div>
<noscript><p class="warn">This page needs JavaScript to load the rules. The same document is available from <code>pdb rules</code>.</p></noscript>
</main>
</body>
</html>
`;
}
