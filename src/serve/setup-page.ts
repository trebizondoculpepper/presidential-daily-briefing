import { pageById, shellContext, shellStart } from "./shell.js";
/**
 * The read-only agent setup page served at `/setup` (#391, doc/design/agent-onboarding.md "Web
 * page and prompt"). It renders the same onboarding document as `pdb onboard` (#351), built with
 * this server's actual origin and the selected served project, plus the HTTP MCP connection
 * details. Client examples are labelled by the evidence behind them; unverified clients say so.
 *
 * Loading it makes no GitHub request, reads no file and writes nothing: copying the prompt never
 * edits AGENTS.md or client settings. The HTML has no inline script; `/setup.js` only adds copy
 * buttons, and every block stays selectable plain text without it or without clipboard access.
 */
import { onboardingDocument, type OnboardingDocument } from "../briefing/onboarding.js";
import { HttpFailure } from "./http.js";
import { escapeHtml } from "./rules-page.js";

/** Query parameters the page accepts. */
export const setupPageParameters = pageById("setup").parameters;

type Served = { repository: string; project?: string };

/** One client's connection example and the evidence behind it. */
export interface ClientExample {
  client: string;
  /** "verified" only with a recorded acceptance report; otherwise "unverified". */
  status: "verified" | "unverified";
  evidence: string;
  text: string;
}

/** Connection examples for the actual MCP endpoint, labelled by recorded evidence. */
export function clientExamples(endpoint: string): ClientExample[] {
  return [
    {
      client: "Claude Code (HTTP)",
      status: "verified",
      evidence:
        "Claude Code 2.1.325 on macOS, 2026-11-14/15: doc/reports/serve-http-mcp-acceptance.md. Other platforms not tested.",
      text: `claude mcp add --transport http pdb ${endpoint}`,
    },
    {
      client: "Codex (stdio, no server needed)",
      status: "verified",
      evidence:
        "The installed stdio pdb-mcp registered in Codex config.toml with absolute paths: doc/reports/agent-platforms/codex-mcp-acceptance.md. Replace both paths with yours. Codex over HTTP is not yet verified (#397).",
      text: `[mcp_servers.pdb]\ncommand = "/absolute/path/to/bin/pdb-mcp"\nargs = ["--project", "/absolute/path/to/your/checkout"]`,
    },
    {
      client: "Other MCP clients, including Ori Code (HTTP)",
      status: "unverified",
      evidence:
        "No recorded acceptance (Ori Code: #399). Use your client's Streamable HTTP server setting with this URL.",
      text: endpoint,
    },
  ];
}

let blockId = 0;
/** A selectable, copyable block; `/setup.js` adds the copy button. */
const copyBlock = (label: string, text: string) => {
  const id = `copy-${++blockId}`;
  return `<pre class="rules" id="${id}" data-copy aria-label="${escapeHtml(label)}">${escapeHtml(text)}</pre>`;
};

function navigation(_origin: string, served: readonly Served[], selected: string | null): string {
  return shellStart(
    shellContext("setup", served, new URLSearchParams(selected ? { repo: selected } : {})),
    "Agent setup",
    "/setup.js",
  );
}

/** The page for one onboarding document and the server's MCP endpoint. */
export function setupPageHtml(
  doc: OnboardingDocument,
  origin: string,
  served: readonly Served[],
): string {
  blockId = 0;
  const endpoint = new URL("/mcp", origin).toString();
  const notice = doc.repository
    ? ""
    : '<p class="warn" role="status">No project selected; choose one above. The prompt and examples below use placeholders until you do.</p>\n';
  const clients = clientExamples(endpoint)
    .map(
      (c) =>
        `<h3>${escapeHtml(c.client)} <span class="${c.status === "verified" ? "ok" : "warn"}">${c.status}</span></h3>\n<p>${escapeHtml(c.evidence)}</p>\n${copyBlock(`${c.client} configuration`, c.text)}`,
    )
    .join("\n");
  const commands = doc.examples
    .map((e) => `<li>${escapeHtml(e.purpose)}: <code>${escapeHtml(e.command)}</code></li>`)
    .join("");
  const rulesLink = doc.rules.url
    ? `<a href="${escapeHtml(doc.rules.url)}">the rules page</a> or `
    : "";
  return `${navigation(origin, served, doc.repository)}<main id="content" tabindex="-1"><h1>Agent setup</h1>
${notice}<p>${escapeHtml(doc.purpose)}</p>
<section><h2>1. Give your agent this prompt</h2>
<p>Paste it into any agent. It reads the onboarding and the current rules first, sets up its own identity and adds the pdb section to AGENTS.md if missing. Copying it changes nothing here.</p>
${copyBlock("Prompt", doc.prompt)}
</section>
<section><h2>2. Connect over MCP</h2>
<p>MCP endpoint of this server: <code>${escapeHtml(endpoint)}</code>. MCP is optional: the CLI works without it.</p>
${clients}
</section>
<section><h2>3. Or use the CLI</h2>
<p>If MCP is not configured or this server is not running, the CLI does the same reads. Rules: ${rulesLink}<code>${escapeHtml(doc.rules.command)}</code>.</p>
<ul>${commands}</ul>
<p>Identity: ${doc.identity.map((l) => escapeHtml(l)).join(" ")}</p>
</section>
<section><h2>4. The AGENTS.md section</h2>
<p>The prompt asks the agent to add this between the pdb markers, keeping everything else. In the project checkout, <code>${escapeHtml(doc.onboarding.command)} --install</code> does the same; this page never writes it.</p>
${copyBlock("AGENTS.md section", doc.persistentSection)}
</section>
<section><h2>Hooks</h2>
<p>Connecting an MCP server does not install client hooks such as a stop hook, and this page installs nothing. Hooks are configured separately in each client.</p>
</section>
</main>
<footer>Read-only. The same document as <code>${escapeHtml(doc.onboarding.command)}</code>. Loading this page makes no GitHub requests.</footer>
</body>
</html>
`;
}

/** The copy-button script: progressive enhancement only, no data and no requests. */
export function setupScript(): string {
  return `"use strict";
for (const block of document.querySelectorAll("pre[data-copy]")) {
  if (!navigator.clipboard) break;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy " + (block.getAttribute("aria-label") || "text"));
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(block.textContent || "").then(
      () => { button.textContent = "Copied"; },
      () => { button.textContent = "Select the text to copy"; },
    );
  });
  block.before(button);
}
`;
}

export interface SetupPageResult {
  status: number;
  html: string;
}

/** Build the page for one request's query, through the served-project allowlist. */
export function setupPage(
  query: URLSearchParams,
  serverUrl: string,
  served: readonly Served[],
  select: (served: readonly Served[], repo: string | undefined) => Served,
): SetupPageResult {
  // The bound URL fixed at startup, never a request Host header; links get no "//".
  const origin = new URL(serverUrl).origin;
  const error = (status: number, message: string): SetupPageResult => ({
    status,
    html: `${navigation(origin, served, null)}<main id="content" tabindex="-1"><h1>Agent setup</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
</main>
</body>
</html>
`,
  });
  for (const key of query.keys())
    if (!(setupPageParameters as readonly string[]).includes(key))
      return error(
        400,
        `Unknown parameter. The setup page accepts ${setupPageParameters.join(", ")}.`,
      );
  for (const key of new Set(query.keys()))
    if (query.getAll(key).length > 1) return error(400, "Give each parameter at most once.");
  const role = query.get("role");
  if (role !== null && role !== "implementer" && role !== "designer")
    return error(400, "role must be implementer or designer.");
  let selected: Served | null = null;
  try {
    selected = query.has("repo") ? select(served, query.get("repo")!) : null;
  } catch (failure) {
    if (!(failure instanceof HttpFailure)) throw failure;
    if (failure.code !== "REPOSITORY_UNRESOLVED")
      return error(
        failure.status,
        failure.code === "REPOSITORY_NOT_SERVED"
          ? "That repository is not served by this server. Choose a served project above."
          : "repo must be owner/name. Choose a served project above.",
      );
  }
  const doc = onboardingDocument({
    repository: selected?.repository ?? null,
    server: origin,
    ...(role ? { role } : {}),
  });
  return { status: 200, html: setupPageHtml(doc, origin, served) };
}
