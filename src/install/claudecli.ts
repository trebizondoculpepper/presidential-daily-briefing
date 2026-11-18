/**
 * `pdb install claude` / `pdb uninstall claude` command surface (#769).
 *
 * Contract: doc/design/attended-installer-delivery.md (focused order step 3) and
 * doc/design/codex-installer.md's shared CLI/result shapes. Default scope is the current
 * repository (project `.mcp.json`); `--global` targets the user-wide Claude config. Identity is
 * resolved/recovered through the existing `pdb setup identity` service for project scope. The
 * Stop hook item is never invented: it stays `not-attempted`/`HOOK_NOT_AVAILABLE` until a
 * packaged session-bound adapter exists.
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { ConfigError, nodeFileSystem, type GitRunner } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { resolveIdentityTarget, setIdentity, type IdentityTarget } from "../config/identity.js";
import { resolveEntry, type Environment } from "../config/harness.js";
import { createGitService, type GitService } from "../git/service.js";
import { manifestPath, resolveProjectGitCommonDir, type InstallScope } from "./manifest.js";
import type { InstallEditErrorCode, InstallEditOutcome, InstallItemKind } from "./manifest.js";
import { installClaudeMcp, resolveInstalledPdbMcp, uninstallClaudeMcp } from "./claudemcp.js";

/** A registered installer client; only Claude is implemented by this module. */
export type ClaudeInstallClient = "claude";

export type ClaudeInstallErrorCode =
  | InstallEditErrorCode
  | "NO_PROJECT"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_AMBIGUOUS"
  | "UNSUPPORTED_SCOPE"
  | "UNSUPPORTED_CLIENT_VERSION"
  | "LOCKED"
  | "HOOK_NOT_AVAILABLE";

/** Installer item kinds: the managed native entries plus the identity preparation outcome. */
export type ClaudeInstallItemKind = InstallItemKind | "identity";

export type ClaudeInstallItemAction =
  | "create"
  | "replace"
  | "remove"
  | "kept"
  | "absent"
  | "skipped";
export type ClaudeInstallItemOutcome = InstallEditOutcome | "not-attempted";

export interface ClaudeInstallItem {
  kind: ClaudeInstallItemKind;
  file: string | null;
  action: ClaudeInstallItemAction;
  outcome: ClaudeInstallItemOutcome;
  code: ClaudeInstallErrorCode | null;
  message: string;
  diff: string | null;
  retry: string | null;
}

/** The installer scope, with `repository` carried on the project variant for reporting. */
export type ClaudeInstallScope =
  | (Extract<InstallScope, { kind: "project" }> & { repository: string })
  | Extract<InstallScope, { kind: "global" }>;

export interface ClaudeInstallResult {
  schemaVersion: 1;
  kind: "install-result";
  client: ClaudeInstallClient;
  operation: "install" | "uninstall";
  scope: ClaudeInstallScope;
  dryRun: boolean;
  items: ClaudeInstallItem[];
  status: {
    configured: boolean;
    trusted: "unknown";
    executed: "unknown";
    receiptVerified: "unknown";
  };
  next: string[];
}

export interface ClaudeInstallArguments {
  client: ClaudeInstallClient;
  operation: "install" | "uninstall";
  global: boolean;
  transport: "stdio" | "http";
  url: string | null;
  role: string | null;
  entry: string | null;
  harness: string | null;
  repo: string | null;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  help: boolean;
}

/** The supported Claude installer flags (attended-installer-delivery.md CLI shape). */
export function claudeInstallArgumentsFor(
  args: string[],
  operation: "install" | "uninstall",
): ClaudeInstallArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      global: { type: "boolean" },
      transport: { type: "string" },
      url: { type: "string" },
      role: { type: "string" },
      entry: { type: "string" },
      harness: { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const client = (positionals[0] ?? "claude") as ClaudeInstallClient;
  if (client !== "claude")
    throw new Error(`Unsupported installer client ${JSON.stringify(client)}; supported: claude.`);
  if (values.transport !== undefined && values.transport !== "stdio" && values.transport !== "http")
    throw new Error("--transport must be stdio or http.");
  if (values.transport === "http" && operation === "uninstall")
    throw new Error("--transport applies to install only; uninstall removes whatever is owned.");
  if (values.url !== undefined && values.transport !== "http")
    throw new Error("--url requires --transport http.");
  if (values.entry !== undefined && values.harness !== undefined)
    throw new Error("Give --entry or --harness, not both.");
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.role !== undefined && values.role !== "implementer" && values.role !== "designer")
    throw new Error("--role must be implementer or designer.");
  return {
    client,
    operation,
    global: values.global === true,
    transport: values.transport === "http" ? "http" : "stdio",
    url: values.url ?? null,
    role: values.role ?? null,
    entry: values.entry ?? null,
    harness: values.harness ?? null,
    repo: values.repo ?? null,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    yes: values.yes === true,
    help: values.help === true,
  };
}

export const claudeInstallHelp = (operation: "install" | "uninstall"): string =>
  operation === "install"
    ? `Usage: pdb install claude [--global] [--transport stdio|http] [--url URL] [--role implementer|designer]
                       [--entry KEY | --harness NAME] [--repo owner/name] [--dry-run] [--json] [--yes]
Configure the PDB MCP connection for Claude Code. Default scope is the current repository
(project .mcp.json); --global targets the user-wide Claude config. STDIO is the default;
--transport http with --url is explicit. --dry-run previews exact changes and writes nothing.
A Claude Stop hook is not installed (hook adapter is a separate slice).`
    : `Usage: pdb uninstall claude [--global] [--dry-run] [--json] [--yes]
Remove only PDB-managed Claude entries in the selected scope; identity, project settings and
unrelated entries survive. Already absent is a no-op. --global is required to touch user-wide
entries.`;

function resolveHome(path: string, homeDir: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homeDir);
  return path;
}

/** The typed Git service over the injected runner (or the node default when absent). */
function gitService(git: GitRunner | undefined): GitService {
  return createGitService(git === undefined ? {} : { git });
}

export interface IdentityPrepareOutcome {
  /** The resolved logical entry key, or null when none was set up (uninstall or global). */
  entry: string | null;
  /** Whether a new identity was created for this install. */
  created: boolean;
  /** A refusal message when identity could not be prepared; null otherwise. */
  refused: string | null;
  /** Exact retry command, when refused. */
  retry: string | null;
}

/**
 * Resolve/recover the per-repository identity for a project install (attended-installer-delivery.md
 * "Project setup reuses identity resolution/allocation"). A valid existing entry is kept; a missing
 * entry is initialized through the same locked writer `pdb setup identity` uses, with `--role`.
 * Global scope and uninstall never invent an identity. Non-interactive installs without `--role`
 * refuse rather than guessing.
 */
async function prepareIdentity(
  args: ClaudeInstallArguments,
  scope: ClaudeInstallScope,
  runtime: ClaudeRunRuntime,
): Promise<IdentityPrepareOutcome> {
  if (args.operation !== "install" || scope.kind !== "project")
    return { entry: null, created: false, refused: null, retry: null };
  const env: Environment = runtime.env ?? process.env;
  const fs = runtime.fs ?? nodeFileSystem;
  const root = scope.root;
  const resolution = await resolveEntry({
    entry: args.entry ?? undefined,
    harness: args.harness ?? undefined,
    env,
    root,
    fs,
  });
  if (resolution.status === "unresolved") {
    const flags = `--entry KEY${args.repo ? ` --repo ${args.repo}` : ""}`;
    return {
      entry: null,
      created: false,
      refused: resolution.message,
      retry: `pdb setup identity --role implementer|designer ${flags.trim()}`,
    };
  }
  const entry = resolution.entry;
  const target: IdentityTarget = { root, repository: scope.repository };
  if (!args.role) {
    return {
      entry: null,
      created: false,
      refused: "IDENTITY_REQUIRED: a role is needed to set up a missing identity.",
      retry: `pdb install claude --role implementer|designer --entry ${entry}${args.repo ? ` --repo ${args.repo}` : ""}`,
    };
  }
  // Dry-run previews identity setup without writing (setIdentity is the same locked writer
  // `pdb setup identity` uses; it must never run during a --dry-run preview).
  if (args.dryRun) return { entry, created: false, refused: null, retry: null };
  const write = await setIdentity(target, entry, "identity.triage_role", args.role, {
    fs,
    git: runtime.git,
    requireName: true,
  });
  if (!write.record.name)
    return {
      entry: null,
      created: false,
      refused: `IDENTITY_REQUIRED: entry [agents.${entry}] has no valid name.`,
      retry: `pdb config set identity.name NAME --entry ${entry}`,
    };
  return { entry, created: write.createdEntry || write.changed, refused: null, retry: null };
}

/** Resolve the installer scope: project root (default) or user-wide Claude config (--global). */
export async function resolveClaudeInstallScope(
  args: ClaudeInstallArguments,
  runtime: ConfigRuntime,
): Promise<ClaudeInstallScope> {
  if (args.global) {
    const homeDir = process.env.HOME ?? homedir();
    const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim();
    const home = claudeHome ? resolveHome(claudeHome, homeDir) : homeDir;
    return { kind: "global", stateDir: home, homeDir: home };
  }
  try {
    // Resolve the verified working-tree root first (never a parent or global fallback).
    const git = runtime.git;
    const cwd = runtime.cwd ?? process.cwd();
    const root = await gitService(git).workingTreeRoot({ cwd });
    if (!root) throw new Error("NO_PROJECT: no Git working-tree root.");
    // With --repo, verify the checkout matches it; without one, derive the repository from the
    // checkout's own remotes (a CheckoutIdentity requires exactly one trusted GitHub remote).
    let repository: string | null;
    if (args.repo !== null && args.repo !== undefined) {
      try {
        repository = (await resolveIdentityTarget(cwd, args.repo, git)).repository;
      } catch (error) {
        if (error instanceof ConfigError) throw new Error(`NO_PROJECT: ${error.message}`);
        throw error;
      }
    } else {
      const identity = await gitService(git).checkout({ cwd: root });
      repository = identity ? identity.repository : null;
    }
    if (!repository)
      throw new Error(
        "NO_PROJECT: the repository could not be resolved; run from a checkout with a single GitHub remote or pass --repo owner/name.",
      );
    const gitCommonDir = await resolveProjectGitCommonDir(root, git);
    return { kind: "project", root, repository, gitCommonDir };
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`NO_PROJECT: ${error.message}`);
    throw error;
  }
}

const mcpFileFor = (scope: ClaudeInstallScope): string =>
  scope.kind === "project" ? `${scope.root}/.mcp.json` : `${scope.homeDir}/.claude.json`;

export interface ClaudeRunRuntime extends ConfigRuntime {
  confirm?: (prompt: string) => Promise<boolean>;
}

/**
 * Run `pdb install claude` / `pdb uninstall claude`. Identity is resolved/recovered for project
 * scope (never invented for --global); the hook item is withheld (HOOK_NOT_AVAILABLE).
 */
export async function runClaudeInstall(
  args: ClaudeInstallArguments,
  runtime: ClaudeRunRuntime,
  output: (text: string) => Promise<void>,
): Promise<number> {
  const scope = await resolveClaudeInstallScope(args, runtime);
  const manifestPathForScope = manifestPath(scope, "claude");
  const mcpFile = mcpFileFor(scope);
  // A STDIO install needs the installed pdb-mcp command; refusing here avoids writing a
  // command that cannot run (attended-installer-delivery.md "never a checkout or .mjs helper").
  const pdbMcp =
    args.operation === "install" && args.transport === "stdio"
      ? await resolveInstalledPdbMcp()
      : null;
  if (!args.dryRun && args.operation === "install" && args.transport === "stdio" && !pdbMcp) {
    const refused: ClaudeInstallResult = {
      schemaVersion: 1,
      kind: "install-result",
      client: args.client,
      operation: args.operation,
      scope,
      dryRun: args.dryRun,
      items: [
        {
          kind: "mcp",
          file: mcpFile,
          action: "kept",
          outcome: "refused",
          code: "UNSUPPORTED_SCOPE",
          message:
            "The running PDB is not an npm installation, so the installed pdb-mcp command cannot be resolved; refusing to write an entry that cannot run.",
          diff: null,
          retry: null,
        },
        {
          kind: "hook",
          file:
            scope.kind === "project"
              ? `${scope.root}/.claude/settings.local.json`
              : `${scope.homeDir}/.claude/settings.json`,
          action: "skipped",
          outcome: "not-attempted",
          code: "HOOK_NOT_AVAILABLE",
          message:
            "Installed hook adapter is a separate slice; withheld until it can bind a session.",
          diff: null,
          retry: null,
        },
      ],
      status: {
        configured: false,
        trusted: "unknown",
        executed: "unknown",
        receiptVerified: "unknown",
      },
      next: ["Install or update PDB via npm, then re-run."],
    };
    if (args.json) await output(JSON.stringify(refused, null, 2) + "\n");
    else
      await output(
        `pdb install claude: refused (UNSUPPORTED_SCOPE).\n${refused.items
          .map((i) => `  ${i.kind} (${i.outcome}, ${i.code}): ${i.message}`)
          .join("\n")}\nNext:\n  ${refused.next.join("\n  ")}\n`,
      );
    return 2;
  }
  // Resolve/recover the per-repository identity before writing the project MCP entry so the
  // installed server uses the intended identity (attended-installer-delivery.md). A refusal is
  // reported as a partial outcome, never silently swallowed.
  const identity = await prepareIdentity(args, scope, runtime);
  const identityEntry = identity.entry;
  let identityItem: ClaudeInstallItem | null = null;
  if (identity.refused !== null && !args.dryRun) {
    identityItem = {
      kind: "identity",
      file: null,
      action: "kept",
      outcome: "refused",
      code: "IDENTITY_REQUIRED",
      message: identity.refused,
      diff: null,
      retry: identity.retry,
    };
  }
  const performed =
    args.operation === "install"
      ? await installClaudeMcp({
          scope,
          options: {
            transport: args.transport,
            url: args.url,
            entry: identityEntry ?? args.entry,
            projectRoot: scope.kind === "project" ? scope.root : undefined,
          },
          manifestPath: manifestPathForScope,
          pdbVersion: "0.1.0",
          dryRun: args.dryRun,
        })
      : await uninstallClaudeMcp({
          scope,
          manifestPath: manifestPathForScope,
          dryRun: args.dryRun,
        });
  const mcp = performed.mcp;
  const items: ClaudeInstallItem[] = [
    ...(identityItem
      ? [identityItem]
      : identityEntry && scope.kind === "project" && args.operation === "install"
        ? [
            {
              kind: "identity" as const,
              file: null,
              action: "kept" as const,
              outcome: identity.created ? ("applied" as const) : ("kept" as const),
              code: null,
              message: identity.created
                ? `Setup/reused identity entry [agents.${identityEntry}] for this repository.`
                : `Using existing identity entry [agents.${identityEntry}] for this repository.`,
              diff: null,
              retry: null,
            },
          ]
        : []),
    {
      kind: "mcp",
      file: mcpFile,
      action: mcp.action,
      outcome: mcp.outcome,
      code: mcp.code,
      message: mcp.message,
      diff: mcp.diff,
      retry: null,
    },
    {
      kind: "hook",
      file:
        scope.kind === "project"
          ? `${scope.root}/.claude/settings.local.json`
          : `${scope.homeDir}/.claude/settings.json`,
      action: "skipped",
      outcome: "not-attempted",
      code: "HOOK_NOT_AVAILABLE",
      message: "Installed hook adapter is a separate slice; withheld until it can bind a session.",
      diff: null,
      retry: null,
    },
  ];
  const result: ClaudeInstallResult = {
    schemaVersion: 1,
    kind: "install-result",
    client: args.client,
    operation: args.operation,
    scope,
    dryRun: args.dryRun,
    items,
    status: {
      configured: false,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    },
    next: [
      scope.kind === "project"
        ? "Configured the Claude MCP server for this project (STDIO unless --transport http)."
        : "Configured the Claude MCP server in your user-wide Claude config.",
      args.dryRun ? "Dry run: remove --dry-run to write." : "",
      args.transport === "http" ? "HTTP MCP transport is unverified for Claude Code." : "",
      args.operation === "install"
        ? "Claude will start the PDB MCP server on the next session after you approve it."
        : "",
    ].filter(Boolean),
  };
  if (args.json) {
    await output(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  await output(
    `pdb ${args.operation} claude\nScope: ${scope.kind === "project" ? `project ${scope.repository} at ${scope.root}` : `global ${scope.homeDir}`}\nItems:\n${result.items
      .map((i) => `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}`)
      .join("\n")}\nNext:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`,
  );
  return mcp.code === "CONFLICT" || mcp.outcome === "failed" ? 2 : 0;
}
