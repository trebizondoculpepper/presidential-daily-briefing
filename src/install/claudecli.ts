/**
 * `pdb install claude` / `pdb uninstall claude` command surface (#769).
 *
 * Contract: doc/design/attended-installer-delivery.md (focused order step 3) and
 * doc/design/codex-installer.md's shared CLI/result shapes. Default scope is the current
 * repository (project `.mcp.json`); `--global` targets the user-wide Claude config. Identity is
 * resolved/recovered through the existing `pdb setup identity` service for project scope. The
 * Stop hook item registers the owned `pdb rebrief claude-stop --installed` entry in the scope's
 * Claude settings file (project `.claude/settings.local.json`, user settings.json).
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { ConfigError, nodeFileSystem, type GitRunner } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { prepareEffectiveIdentity, type EffectiveHuman } from "../config/effectiveidentity.js";
import { resolveIdentityTarget } from "../config/identity.js";
import { resolveEntry } from "../config/harness.js";
import { createGitService, type GitService } from "../git/service.js";
import { manifestPath, resolveProjectGitCommonDir, type InstallScope } from "./manifest.js";
import type { InstallEditErrorCode, InstallEditOutcome, InstallItemKind } from "./manifest.js";
import {
  claudeInstallSnapshotChanged,
  installClaudeMcp,
  readClaudeInstallSnapshot,
  resolveInstalledPdbMcp,
  uninstallClaudeMcp,
  type ClaudeInstallSnapshot,
} from "./claudemcp.js";
import {
  installClaudeStopHook,
  uninstallClaudeStopHook,
  claudeSettingsPath,
} from "./claudehook.js";

/** A registered installer client; only Claude is implemented by this module. */
export type ClaudeInstallClient = "claude";

export type ClaudeInstallErrorCode =
  | InstallEditErrorCode
  | "NO_PROJECT"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_AMBIGUOUS"
  | "UNSUPPORTED_SCOPE"
  | "UNSUPPORTED_CLIENT_VERSION"
  | "LOCKED";

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
  | (Extract<InstallScope, { kind: "global" }> & {
      /** True when `homeDir` is an explicit CLAUDE_CONFIG_DIR rather than the user home. */
      claudeConfigDir: boolean;
    });

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
  /** Whether a new identity would be created in dry-run preview. */
  planned?: boolean;
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
  dryRun: boolean,
): Promise<IdentityPrepareOutcome> {
  if (args.operation !== "install" || scope.kind !== "project")
    return { entry: null, created: false, refused: null, retry: null };
  const fs = runtime.fs ?? nodeFileSystem;
  const env = runtime.env ?? process.env;
  let targetEntry = args.entry ?? undefined;
  if (targetEntry === undefined) {
    let resolution;
    try {
      resolution = await resolveEntry({
        harness: args.harness ?? "claude",
        env,
        root: scope.root,
        fs,
      });
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        entry: null,
        created: false,
        refused: message,
        retry: null,
      };
    }
    if (resolution.status === "unresolved") {
      return {
        entry: null,
        created: false,
        refused: `${resolution.message} No identity was borrowed: the Claude install resolves the Claude entry.`,
        retry: null,
      };
    }
    targetEntry = resolution.entry;
  }
  const prepared = await prepareEffectiveIdentity(
    {
      project: scope.root,
      repository: scope.repository,
      entry: targetEntry,
      harness: args.entry === null ? undefined : (args.harness ?? undefined),
      role: args.role ?? undefined,
      intent: dryRun ? "dry-run" : "normal",
    },
    {
      cwd: scope.root,
      // Installer setup prepares the target entry without reading/rebinding any invoking session.
      env: {},
      fs,
      git: runtime.git,
      random: runtime.random,
      human: async (): Promise<EffectiveHuman> => ({
        context: {
          state: "unresolved",
          host: "github.com",
          login: null,
          source: "none",
          reason: "Installer identity preparation",
        },
        authenticationFailed: false,
      }),
    },
  );
  if (prepared.state === "unresolved" || prepared.state === "failed") {
    const diagnostic = prepared.diagnostic;
    return {
      entry: null,
      created: false,
      refused:
        diagnostic?.code === "identity-unresolved" || diagnostic?.code === "invalid-value"
          ? diagnostic.message
          : (diagnostic?.message ?? "IDENTITY_REQUIRED: identity could not be prepared."),
      retry: diagnostic?.recovery ?? null,
    };
  }
  if (prepared.state === "proposed") {
    if (prepared.diagnostic?.code === "identity-unresolved") {
      return {
        entry: null,
        created: false,
        refused: prepared.diagnostic.message,
        retry: prepared.diagnostic.recovery ?? null,
      };
    }
    return {
      entry: prepared.entry,
      planned: true,
      created: false,
      refused: null,
      retry: prepared.diagnostic?.recovery ?? null,
    };
  }
  // A refused/failed setup leaves the entry unverified: report it, do not continue.
  if (prepared.setup.state === "failed")
    return {
      entry: null,
      created: false,
      refused: prepared.diagnostic?.message ?? "IDENTITY_REQUIRED",
      retry: prepared.diagnostic?.recovery ?? null,
    };
  return {
    entry: prepared.entry,
    created: prepared.setup.state === "created" || prepared.setup.state === "imported",
    refused:
      prepared.setup.state === "persisted-with-error"
        ? prepared.setup.notices.join("; ") ||
          "The identity was persisted but its lock cleanup failed."
        : null,
    retry:
      prepared.setup.state === "persisted-with-error"
        ? "pdb config set identity.triage_role implementer --entry <KEY>"
        : null,
  };
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
    // When CLAUDE_CONFIG_DIR is set, `home` is the Claude config directory itself: the global
    // hook settings file lives at `<home>/settings.json` there, not `<home>/.claude/settings.json`.
    return { kind: "global", stateDir: home, homeDir: home, claudeConfigDir: !!claudeHome };
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
  stderr?: (text: string) => void | Promise<void>;
}

function formatClaudeInstallOutput(
  result: ClaudeInstallResult,
  scope: ClaudeInstallScope,
  operation: ClaudeInstallArguments["operation"],
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2) + "\n";
  return `pdb ${operation} claude\nScope: ${scope.kind === "project" ? `project ${scope.repository} at ${scope.root}` : `global ${scope.homeDir}`}\nItems:\n${result.items
    .map(
      (i) =>
        `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}${i.diff ? `\n${i.diff.trimEnd()}` : ""}${i.retry ? `\n    retry: ${i.retry}` : ""}`,
    )
    .join("\n")}\nNext:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`;
}

async function evaluateClaudeInstallPlan(params: {
  args: ClaudeInstallArguments;
  scope: ClaudeInstallScope;
  manifestPathForScope: string;
  mcpFile: string;
  runtime: ClaudeRunRuntime;
  dryRun: boolean;
  expectedSnapshot?: ClaudeInstallSnapshot;
}): Promise<{ result: ClaudeInstallResult; exitCode: number }> {
  const { args, scope, manifestPathForScope, mcpFile, runtime, dryRun, expectedSnapshot } = params;
  // A STDIO install needs the installed pdb-mcp command; refusing here avoids writing a
  // command that cannot run (attended-installer-delivery.md "never a checkout or .mjs helper").
  const pdbMcp =
    args.operation === "install" && args.transport === "stdio"
      ? await resolveInstalledPdbMcp()
      : null;
  if (!dryRun && args.operation === "install" && args.transport === "stdio" && !pdbMcp) {
    const refused: ClaudeInstallResult = {
      schemaVersion: 1,
      kind: "install-result",
      client: args.client,
      operation: args.operation,
      scope,
      dryRun,
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
          file: claudeSettingsPath(
            scope,
            scope.kind === "global" ? scope.claudeConfigDir : undefined,
          ),
          action: "kept",
          outcome: "not-attempted",
          code: "UNSUPPORTED_SCOPE",
          message: "The running PDB is not an npm installation; the Stop hook was not written.",
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
    return { result: refused, exitCode: 2 };
  }
  const conflicted =
    !dryRun &&
    expectedSnapshot &&
    claudeInstallSnapshotChanged(
      expectedSnapshot,
      await readClaudeInstallSnapshot(
        scope,
        manifestPathForScope,
        claudeSettingsPath(scope, scope.kind === "global" ? scope.claudeConfigDir : undefined),
      ),
    );
  // Resolve/recover the per-repository identity before writing the project MCP entry so the
  // installed server uses the intended identity (attended-installer-delivery.md). A refusal is
  // reported as a partial outcome, never silently swallowed.
  const identity = conflicted
    ? { entry: null, created: false, refused: null, retry: null }
    : await prepareIdentity(args, scope, runtime, dryRun);
  const identityEntry = identity.entry;
  let identityItem: ClaudeInstallItem | null = null;
  // Refusals (ambiguous identity, needed setup without a role, or lock-cleanup failure) must
  // appear in dry-run and non-interactive previews too, so the result always says whether
  // installation can actually proceed (#970).
  if (identity.refused !== null) {
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
  const identityBlocked = identityItem?.outcome === "refused";
  const performed = conflicted
    ? {
        mcp: {
          action: "kept" as const,
          outcome: "refused" as const,
          ownership: "absent" as const,
          code: "CONFLICT" as const,
          message:
            "Claude configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      }
    : identityBlocked && scope.kind === "project" && args.operation === "install"
      ? {
          mcp: {
            action: "kept" as const,
            outcome: "not-attempted" as const,
            ownership: "absent" as const,
            code: "IDENTITY_REQUIRED" as const,
            message:
              "MCP registration withheld: the Claude identity could not be resolved; fix identity and re-run.",
            diff: null,
            manifestRecord: null,
          },
        }
      : args.operation === "install"
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
            dryRun,
            claudeConfigDir: scope.kind === "global" ? scope.claudeConfigDir : undefined,
            expectedSnapshot,
          })
        : await uninstallClaudeMcp({
            scope,
            manifestPath: manifestPathForScope,
            dryRun,
            claudeConfigDir: scope.kind === "global" ? scope.claudeConfigDir : undefined,
            expectedSnapshot,
          });
  const mcp = performed.mcp;
  const hook = conflicted
    ? {
        hook: {
          action: "kept" as const,
          outcome: "refused" as const,
          ownership: "absent" as const,
          code: "CONFLICT" as const,
          message:
            "Claude configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      }
    : identityBlocked && scope.kind === "project" && args.operation === "install"
      ? {
          hook: {
            action: "kept" as const,
            outcome: "not-attempted" as const,
            ownership: "absent" as const,
            code: "IDENTITY_REQUIRED" as const,
            message:
              "Stop-hook registration withheld: the Claude identity could not be resolved; fix identity and re-run.",
            diff: null,
            manifestRecord: null,
          },
        }
      : args.operation === "uninstall"
        ? await uninstallClaudeStopHook({
            scope,
            manifestPath: manifestPathForScope,
            dryRun,
            claudeConfigDir: scope.kind === "global" ? scope.claudeConfigDir : undefined,
          })
        : await installClaudeStopHook({
            scope,
            options: {
              role: scope.kind === "project" ? args.role : undefined,
              entry: scope.kind === "project" ? (identityEntry ?? args.entry) : undefined,
            },
            manifestPath: manifestPathForScope,
            pdbVersion: "0.1.0",
            dryRun,
            claudeConfigDir: scope.kind === "global" ? scope.claudeConfigDir : undefined,
          });
  const mcpConfigured =
    args.operation === "install" &&
    !dryRun &&
    (mcp.outcome === "applied" || mcp.outcome === "kept" || mcp.outcome === "committed-with-error");
  const items: ClaudeInstallItem[] = [
    ...(identityItem
      ? [identityItem]
      : identityEntry && scope.kind === "project" && args.operation === "install"
        ? [
            {
              kind: "identity" as const,
              file: null,
              action: "kept" as const,
              outcome: identity.planned
                ? ("planned" as const)
                : identity.created
                  ? ("applied" as const)
                  : ("kept" as const),
              code: null,
              message: identity.planned
                ? `Would configure [agents.${identityEntry}] in pdb.toml with role ${args.role}.`
                : identity.created
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
      file: claudeSettingsPath(scope, scope.kind === "global" ? scope.claudeConfigDir : undefined),
      action: hook.hook.action,
      outcome: hook.hook.outcome,
      code: hook.hook.code,
      message: hook.hook.message,
      diff: hook.hook.diff,
      retry:
        hook.hook.outcome === "refused" ||
        hook.hook.outcome === "failed" ||
        hook.hook.outcome === "committed-with-error"
          ? `pdb ${args.operation} claude${args.global ? " --global" : ""}${args.repo ? ` --repo ${args.repo}` : ""} --yes`
          : null,
    },
  ];
  const result: ClaudeInstallResult = {
    schemaVersion: 1,
    kind: "install-result",
    client: args.client,
    operation: args.operation,
    scope,
    dryRun,
    items,
    status: {
      configured: mcpConfigured,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    },
    next: [
      scope.kind === "project"
        ? "Configured the Claude MCP server for this project (STDIO unless --transport http)."
        : "Configured the Claude MCP server in your user-wide Claude config.",
      dryRun ? "Dry run: remove --dry-run (or confirm) to write." : "",
      args.transport === "http" ? "HTTP MCP transport is unverified for Claude Code." : "",
      args.operation === "install"
        ? "Claude will start the PDB MCP server on the next session after you approve it."
        : "",
      hook.hook.outcome === "applied" || hook.hook.outcome === "kept"
        ? "Run the workspace trust flow in Claude Code and approve the PDB Stop hook (changing a trusted definition needs normal review again)."
        : "",
    ].filter(Boolean),
  };
  const refusedOrFailed = result.items.some(
    (i) =>
      i.outcome === "refused" ||
      i.outcome === "failed" ||
      i.outcome === "committed-with-error" ||
      i.code === "IDENTITY_REQUIRED",
  );
  const appliedOrCurrent = result.items.some(
    (i) => i.outcome === "applied" || i.outcome === "kept" || i.outcome === "adopted",
  );
  const exitCode = refusedOrFailed ? 2 : !appliedOrCurrent && !args.dryRun ? 1 : 0;
  return { result, exitCode };
}

/**
 * Run `pdb install claude` / `pdb uninstall claude`. Identity is resolved/recovered for project
 * scope (never invented for --global); the Stop hook item registers the owned installed entry.
 */
export async function runClaudeInstall(
  args: ClaudeInstallArguments,
  runtime: ClaudeRunRuntime,
  output: (text: string) => Promise<void>,
): Promise<number> {
  const scope = await resolveClaudeInstallScope(args, runtime);
  const manifestPathForScope = manifestPath(scope, "claude");
  const mcpFile = mcpFileFor(scope);
  // HTTP transport needs a valid explicit endpoint: this CLI has no running-server context that
  // could establish a default, and an unverified address cannot be claimed as applied (#970).
  if (
    args.operation === "install" &&
    args.transport === "http" &&
    (args.url === null || !/^https?:\/\/\S+$/i.test(args.url))
  ) {
    const refused: ClaudeInstallResult = {
      schemaVersion: 1,
      kind: "install-result",
      client: args.client,
      operation: args.operation,
      scope,
      dryRun: true,
      items: [
        {
          kind: "mcp",
          file: mcpFile,
          action: "kept",
          outcome: "refused",
          code: "UNSUPPORTED_SCOPE",
          message:
            "HTTP transport requires a valid explicit --url (http(s) endpoint); this command cannot invent a server address.",
          diff: null,
          retry: `pdb install claude --transport http --url http://127.0.0.1:4372/mcp${args.repo ? ` --repo ${args.repo}` : ""}`,
        },
        {
          kind: "hook",
          file: claudeSettingsPath(
            scope,
            scope.kind === "global" ? scope.claudeConfigDir : undefined,
          ),
          action: "kept",
          outcome: "not-attempted",
          code: "UNSUPPORTED_SCOPE",
          message: "The install was refused before the Stop hook was written.",
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
      next: ["Supply a valid --url with --transport http, then re-run."],
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
  // Confirmation contract: --dry-run always previews; --yes applies directly; otherwise a TTY
  // shows the read-only preview first and requests confirmation before applying, while a non-TTY
  // without --yes behaves as a dry run (never writes unconfirmed).
  if (args.dryRun || (!args.yes && !runtime.confirm)) {
    const preview = await evaluateClaudeInstallPlan({
      args,
      scope,
      manifestPathForScope,
      mcpFile,
      runtime,
      dryRun: true,
    });
    await output(formatClaudeInstallOutput(preview.result, scope, args.operation, args.json));
    return preview.exitCode;
  }
  let expectedSnapshot: ClaudeInstallSnapshot | undefined;
  if (!args.yes && runtime.confirm) {
    expectedSnapshot = await readClaudeInstallSnapshot(
      scope,
      manifestPathForScope,
      claudeSettingsPath(scope, scope.kind === "global" ? scope.claudeConfigDir : undefined),
    );
    const preview = await evaluateClaudeInstallPlan({
      args,
      scope,
      manifestPathForScope,
      mcpFile,
      runtime,
      dryRun: true,
    });
    if (preview.exitCode === 2) {
      await output(formatClaudeInstallOutput(preview.result, scope, args.operation, args.json));
      return 2;
    }
    const previewText = formatClaudeInstallOutput(preview.result, scope, args.operation, false);
    if (!args.json) {
      await output(previewText);
    } else if (runtime.stderr) {
      await runtime.stderr(previewText);
    } else {
      process.stderr.write(previewText);
    }
    const approved = await runtime.confirm(
      `Apply pdb ${args.operation} claude in ${scope.kind === "project" ? scope.root : scope.homeDir}?`,
    );
    if (!approved) {
      if (args.json) {
        await output(formatClaudeInstallOutput(preview.result, scope, args.operation, true));
      }
      return preview.exitCode;
    }
  }
  const applied = await evaluateClaudeInstallPlan({
    args,
    scope,
    manifestPathForScope,
    mcpFile,
    runtime,
    dryRun: false,
    expectedSnapshot,
  });
  await output(formatClaudeInstallOutput(applied.result, scope, args.operation, args.json));
  return applied.exitCode;
}
