/**
 * Agent onboarding (#351, doc/design/agent-onboarding.md): one pure builder for the onboarding
 * document every transport renders: purpose, the current-rules reference, identity steps,
 * examples, a short copyable prompt and the persistent AGENTS.md coordination section.
 *
 * Inputs are verified facts only (the selected repository, an optional validated server origin,
 * a role hint): no issue text, comment or other external content can reach the output, and it
 * never contains tokens, credentials or local paths. It does not snapshot the rules: it points
 * at them, and asks agents to read them at the start of every session.
 */

export const ONBOARDING_SCHEMA_VERSION = 1;
export const COORDINATION_START = "<!-- pdb:coordination:start -->";
export const COORDINATION_END = "<!-- pdb:coordination:end -->";

export interface OnboardingInput {
  /** The verified owner/name, or null when no project was selected. */
  repository: string | null;
  /** The role the examples use; omitted means a placeholder. */
  role?: "implementer" | "designer";
  /** A validated HTTP(S) origin of a running `pdb serve`, when the caller knows one. */
  server?: string | null;
}

export interface OnboardingDocument {
  schemaVersion: typeof ONBOARDING_SCHEMA_VERSION;
  kind: "onboarding";
  repository: string | null;
  purpose: string;
  rules: { command: string; url: string | null };
  /** The onboarding itself: the CLI command, and the served setup page when known (#391). */
  onboarding: { command: string; url: string | null };
  identity: string[];
  examples: { purpose: string; command: string }[];
  /** Short text a person pastes into an agent: onboarding and rules first. */
  prompt: string;
  /** The managed AGENTS.md section, markers included. */
  persistentSection: string;
  /** Present when no project is selected: how to select one. */
  selectProject: string | null;
}

/**
 * Validate an explicit `--server` value: an http(s) origin with no credentials, query or
 * fragment. Returns the normalized origin, or null when it is not acceptable.
 */
export function validServerOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/** A served page of one repository, with the selector properly escaped. */
const pageUrl = (origin: string, path: string, repository: string) =>
  `${origin}${path}?repo=${encodeURIComponent(repository)}`;
const rulesUrl = (origin: string, repository: string) => pageUrl(origin, "/rules", repository);

/** Build the onboarding document (pure). */
export function onboardingDocument(input: OnboardingInput): OnboardingDocument {
  const repo = input.repository;
  const repoFlag = repo ? ` --repo ${repo}` : " --repo OWNER/NAME";
  const role = input.role ?? "implementer|designer";
  // The selected repository is always passed, so setup refuses a checkout of another project.
  const setupCommand = (r: string) => `pdb setup identity --role ${r}${repoFlag}`;
  const server = input.server ?? null;
  const url = server && repo ? rulesUrl(server, repo) : null;
  const rulesRef = `\`pdb rules\`${url ? ` (or ${url})` : ""}`;
  // The served setup page of this project (#391), when the caller knows the server.
  const onboardingUrl = server && repo ? pageUrl(server, "/setup", repo) : null;
  const onboardingRef = `\`pdb onboard${repoFlag}\`${onboardingUrl ? ` (or ${onboardingUrl})` : ""}`;
  const examples = [
    { purpose: "Read the current rules", command: "pdb rules" },
    {
      purpose: "Get your own persistent identity once",
      command: setupCommand(role),
    },
    { purpose: "See what to do next", command: `pdb${repoFlag} --role ${role} --agent NAME` },
    { purpose: "Use the MCP server instead of the CLI", command: `pdb-mcp${repoFlag}` },
    { purpose: "Help", command: "pdb --help" },
    { purpose: "Show this onboarding again", command: `pdb onboard${repoFlag}` },
  ];
  const where = repo ? `the ${repo} project` : "this project";
  const prompt = [
    `You are working on ${where}, which coordinates work with Presidential Daily Briefing (pdb).`,
    `Before any project work:`,
    `1. Read the onboarding and the current rules: ${onboardingRef} and ${rulesRef}.`,
    `2. Get your own persistent name once: \`${setupCommand(role)}\`. Never reuse another agent's name.`,
    `3. Use the CLI (\`pdb${repoFlag} --agent NAME\`) or the MCP server (\`pdb-mcp${repoFlag}\`) for status and priorities; help is \`pdb --help\`.`,
    `4. If AGENTS.md has no pdb coordination section, add it: \`pdb onboard${repoFlag} --install\`.`,
    `At the start of every session, read the current rules again before choosing work.`,
  ].join("\n");
  const persistentSection = [
    COORDINATION_START,
    "## Coordination with Presidential Daily Briefing (pdb)",
    "",
    `${repo ? `This project (${repo})` : "This project"} uses pdb for status, priorities, claims and handoffs.`,
    "",
    `- At the start of every session, read the current rules: ${rulesRef}.`,
    `- Get your own persistent identity once: \`${setupCommand("implementer|designer")}\`. Never reuse another agent's name.`,
    `- See what to do next: \`pdb${repoFlag} --agent NAME\`. Help: \`pdb --help\`; onboarding: ${onboardingRef}.`,
    `- MCP clients: \`pdb-mcp${repoFlag}\`${server ? `; web: ${server}` : ""}.`,
    "- Prefer pdb over raw gh for status and priorities; use gh only for operations pdb does not support.",
    COORDINATION_END,
  ].join("\n");
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    kind: "onboarding",
    repository: repo,
    purpose:
      "Presidential Daily Briefing (pdb) tells agents what to work on next from the project's GitHub issues, pull requests and rules, and records claims and handoffs.",
    rules: { command: "pdb rules", url },
    onboarding: { command: `pdb onboard${repoFlag}`, url: onboardingUrl },
    identity: [
      `Run \`${setupCommand(role)}\` once in this checkout; it generates your own name and keeps it.`,
      "Use that name with --agent. Never reuse another agent's or another harness's entry.",
    ],
    examples,
    prompt,
    persistentSection,
    selectProject: repo
      ? null
      : "No project selected: run from a GitHub checkout, or pass --repo OWNER/NAME.",
  };
}

/**
 * Short MCP server instructions from the same document (#351). Whether a client shows them to
 * the model is up to the client; connecting never edits AGENTS.md or runs anything.
 */
export function onboardingInstructions(doc: OnboardingDocument): string {
  return [
    doc.purpose,
    "Call triage_briefing at the start of work to see what to do next.",
    `At the start of every session read the current rules (${doc.rules.command}${doc.rules.url ? `, ${doc.rules.url}` : ""}).`,
    doc.identity[0],
    `Full onboarding, including the AGENTS.md section: ${doc.examples.find((e) => e.command.startsWith("pdb onboard"))?.command ?? "pdb onboard"}.`,
  ].join(" ");
}

/** Plain-text rendering of the document (the same content as its JSON). */
export function onboardingText(doc: OnboardingDocument): string {
  return [
    `Presidential Daily Briefing onboarding${doc.repository ? ` for ${doc.repository}` : ""}`,
    "",
    doc.purpose,
    ...(doc.selectProject ? ["", doc.selectProject] : []),
    "",
    `Rules: ${doc.rules.command}${doc.rules.url ? ` (${doc.rules.url})` : ""}`,
    "",
    "Identity:",
    ...doc.identity.map((line) => `  ${line}`),
    "",
    "Commands:",
    ...doc.examples.map((e) => `  ${e.purpose}: ${e.command}`),
    "",
    "Prompt to give an agent:",
    "",
    doc.prompt,
    "",
    "AGENTS.md section (pdb onboard --install adds or updates it):",
    "",
    doc.persistentSection,
    "",
  ].join("\n");
}
