/**
 * `pdb install codex` / `pdb uninstall codex` command surface (#768 slice 2a).
 *
 * Contract: doc/design/codex-installer.md ("CLI contract", "Result, partial failure and next
 * steps") and doc/design/attended-installer-delivery.md. This slice adds the command surface,
 * argument parsing, scope resolution and the versioned result types only; it performs **no file
 * writes**. Later slices wire the MCP entry (slice 2b) and identity/result assembly (slice 2c)
 * through the shared manifest primitives (`src/install/manifest.ts`, #767).
 *
 * The shared item/error types are declared here so the CLI help, dry-run JSON and later slices
 * share one source of truth.
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigError, nodeFileSystem } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { isAgentName, readIdentity, setIdentity } from "../config/identity.js";
import { resolveEntry, type Environment } from "../config/harness.js";
import { createGitService } from "../git/service.js";
import { manifestPath, type InstallItemKind, type InstallScope } from "./manifest.js";
import {
  codexInstallSnapshotChanged,
  installCodexMcp,
  readCodexInstallSnapshot,
  uninstallCodexMcp,
  type CodexInstallSnapshot,
} from "./codexmcp.js";
import { installCodexStopHook, uninstallCodexStopHook } from "./codexhook.js";

/** A registered installer client; only Codex is implemented in this slice. */
export type InstallClient = "codex";

/** Result item kinds: manifest entries plus the read-only identity decision. */
export type InstallResultItemKind = InstallItemKind | "identity";

export type InstallErrorCode =
  | "NO_PROJECT"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_AMBIGUOUS"
  | "UNSUPPORTED_SCOPE"
  | "UNSUPPORTED_CLIENT_VERSION"
  | "FUTURE_MANIFEST_VERSION"
  | "MALFORMED_MANIFEST"
  | "MALFORMED_CONFIG"
  | "UNSUPPORTED_SCHEMA"
  | "UNSAFE_TOML_EDIT"
  | "UNSAFE_PATH"
  | "CONFLICT"
  | "LOCKED"
  | "OWNED_ENTRY_EDITED"
  | "FOREIGN_ENTRY"
  | "HOOK_NOT_AVAILABLE"
  | "WRITE_FAILED";

export type InstallItemAction = "create" | "replace" | "remove" | "kept" | "absent" | "skipped";
export type InstallItemOutcome =
  | "applied"
  | "kept"
  | "committed-with-error"
  | "adopted"
  | "planned"
  | "refused"
  | "failed"
  | "not-attempted";

export interface InstallItem {
  kind: InstallResultItemKind;
  /**
   * Scope-relative file path (for example `.codex/config.toml`), never an absolute private path:
   * installer output must not leak the user's home or checkout root (#844 finding).
   */
  file: string | null;
  action: InstallItemAction;
  outcome: InstallItemOutcome;
  code: InstallErrorCode | null;
  message: string;
  diff: string | null;
  retry: string | null;
}

/** The redacted result scope: kind plus non-secret facts only (no absolute paths). */
export type InstallResultScope =
  | { kind: "project"; repository: string; targets: { config: string; hooks: string } }
  | { kind: "global"; targets: { config: string; hooks: string } };

/** Internal scope carries absolute paths for later write slices; never serialized. */
export type InstallInternalScope =
  | { kind: "project"; root: string; repository: string; gitCommonDir: string }
  | { kind: "global"; home: string };

export interface InstallResult {
  schemaVersion: 1;
  kind: "install-result";
  client: InstallClient;
  operation: "install" | "uninstall";
  scope: InstallResultScope;
  dryRun: boolean;
  items: InstallItem[];
  status: {
    configured: boolean;
    trusted: "unknown";
    executed: "unknown";
    receiptVerified: "unknown";
  };
  next: string[];
}

export interface InstallArguments {
  client: InstallClient;
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

const HTTP_URL = /^https?:\/\/\S+$/i;

/** The supported Codex installer flags (codex-installer.md "CLI contract"). */
export function installArgumentsFor(
  args: string[],
  operation: "install" | "uninstall",
): InstallArguments {
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
  // Execution requires exactly one client positional; client-free help is allowed.
  if (values.help !== true && positionals.length !== 1)
    throw new Error(
      `pdb ${operation} requires exactly one client (codex); run "pdb ${operation} codex" or pass --help.`,
    );
  const client = (positionals[0] ?? (values.help === true ? "codex" : undefined)) as
    | InstallClient
    | undefined;
  if (client !== "codex")
    throw new Error(`Unsupported installer client ${JSON.stringify(client)}; supported: codex.`);
  if (values.transport !== undefined && values.transport !== "stdio" && values.transport !== "http")
    throw new Error("--transport must be stdio or http.");
  if (operation === "uninstall" && values.transport !== undefined)
    throw new Error("--transport applies to install only; uninstall removes whatever is owned.");
  if (values.url !== undefined) {
    if (values.transport !== "http") throw new Error("--url requires --transport http.");
    if (!HTTP_URL.test(values.url))
      // #844/CodeRabbit: never echo the rejected operand; it may carry credentials.
      throw new Error(
        "--url must be an http(s) endpoint without whitespace; the value is not echoed.",
      );
  }
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

export const installHelp = (operation: "install" | "uninstall"): string =>
  operation === "install"
    ? `Usage: pdb install codex [--global] [--transport stdio|http] [--url URL] [--role implementer|designer]
                    [--entry KEY | --harness NAME] [--repo owner/name] [--dry-run] [--json] [--yes]
Configure project-local (or explicit --global) PDB identity and Codex MCP entries.
Default scope is the current repository; --global uses the user-wide Codex home. Without an
explicit --entry/--harness, the Codex identity entry is targeted (never the invoking agent).
STDIO is the default; --transport http with --url is explicit. --dry-run previews planned items
and writes nothing; pass --yes to apply non-interactively.`
    : `Usage: pdb uninstall codex [--global] [--dry-run] [--json] [--yes]
Remove PDB-managed Codex MCP entries in the selected scope while preserving identity and
project settings. Already absent is a no-op. --global is required to target user-wide entries;
--dry-run previews without writing, and --yes applies non-interactively.`;

/** The user-wide Codex home: $CODEX_HOME when set, else `~/.codex`. */
function codexHome(env: Environment): string {
  const homeDir = env.HOME?.trim() || homedir();
  const explicit = env.CODEX_HOME?.trim();
  return explicit ? resolveHome(explicit, homeDir) : join(homeDir, ".codex");
}

/** Resolve the installer scope internally; the serialized result uses a redacted projection. */
export async function resolveInstallScope(
  args: InstallArguments,
  runtime: ConfigRuntime,
): Promise<InstallInternalScope> {
  const env: Environment = runtime.env ?? process.env;
  if (args.global) return { kind: "global", home: codexHome(env) };
  try {
    const cwd = runtime.cwd ?? process.cwd();
    const svc = createGitService(runtime.git === undefined ? {} : { git: runtime.git });
    // The typed service returns null for an absent checkout and throws for a failed Git read;
    // absence is NO_PROJECT, a rejection is a redacted execution failure (never conflated).
    let root: string | null = null;
    try {
      root = await svc.workingTreeRoot({ cwd });
    } catch (error) {
      throw new Error(
        "NO_PROJECT: Git could not be executed in the selected directory; check the Git installation. Nothing was written.",
      );
    }
    if (!root)
      throw new Error(
        `NO_PROJECT: no Git working-tree root. Next: ${args.dryRun ? "pdb" : "pdb"} install codex --global --dry-run${args.json ? " --json" : ""} for a user-wide preview.`,
      );
    // Route every Git fact through the typed service so GIT_DIR/GIT_WORK_TREE cannot point at an
    // unrelated checkout (architecture's explicit-checkout boundary). `svc.remotes` runs with the
    // sanitized environment, unlike legacy runners that inherit those variables.
    let repository: string | null = null;
    if (args.repo !== null && args.repo !== undefined) {
      const remotes = await svc.remotes({ cwd: root });
      // githubRepositories lowercases names; normalize the argument so install/uninstall accept
      // the repository's original capitalization (#844 finding).
      const requested = args.repo.toLowerCase();
      const repositories = [
        ...new Set(remotes.map((r) => r.repository).filter((r): r is string => r !== null)),
      ];
      if (!repositories.includes(requested)) {
        throw new Error(
          `NO_PROJECT: the checkout is not ${args.repo} (GitHub remotes: ${repositories.join(", ") || "none"}).`,
        );
      }
      repository = requested;
    } else {
      const identity = await svc.checkout({ cwd: root });
      repository = identity ? identity.repository : null;
    }
    if (!repository)
      throw new Error(
        `NO_PROJECT: the repository could not be resolved; run from a checkout with a single GitHub remote or pass --repo owner/name. Next: ${args.dryRun ? "pdb" : "pdb"} install codex --global --dry-run${args.json ? " --json" : ""} for a user-wide preview.`,
      );
    const rawCommonDir = (await svc.commonDirectory({ cwd: root })) ?? "";
    if (!rawCommonDir)
      throw new Error(
        `NO_PROJECT: the checkout's common directory could not be resolved. Next: ${args.dryRun ? "pdb" : "pdb"} install codex --global --dry-run${args.json ? " --json" : ""} for a user-wide preview.`,
      );
    // The internal scope promises absolute paths: resolve a relative common directory against
    // the root passed to the Git call, so a nested call sites addresses the right directory.
    const gitCommonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(root, rawCommonDir);
    return { kind: "project", root, repository, gitCommonDir };
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`NO_PROJECT: ${error.message}`);
    throw error;
  }
}

function resolveHome(path: string, homeDir: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homeDir);
  return path;
}

function redactUrl(url: string): string {
  return url
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/(https?:\/\/[^\s"?#]+)\?[^\s"]*/gi, "$1?***");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildRetryCommand(args: InstallArguments, resolvedEntry: string | null): string | null {
  if (args.operation === "install" && args.transport === "http" && args.url) {
    if (redactUrl(args.url) !== args.url) return null;
  }
  const globalOpt = args.global ? " --global" : "";
  const roleOpt = args.role ? ` --role ${args.role}` : "";
  const identityOpt = args.entry
    ? ` --entry ${args.entry}`
    : args.harness
      ? ` --harness ${args.harness}`
      : resolvedEntry
        ? ` --entry ${resolvedEntry}`
        : "";
  const repoOpt = args.repo ? ` --repo ${args.repo}` : "";
  const transportOpt =
    args.operation === "install" && args.transport === "http"
      ? ` --transport http${args.url ? ` --url ${shellQuote(args.url)}` : ""}`
      : "";
  return `pdb ${args.operation} codex${globalOpt}${roleOpt}${identityOpt}${repoOpt}${transportOpt} --yes`;
}

/** Identity decision and (when applying) creation/recovery via `setIdentity` (#800). */
async function identityStep(
  args: InstallArguments,
  scope: InstallInternalScope,
  runtime: ConfigRuntime,
  dryRun: boolean,
): Promise<{ item: InstallItem | null; entry: string | null }> {
  if (args.operation !== "install" || scope.kind !== "project") return { item: null, entry: null };
  const env: Environment = runtime.env ?? process.env;
  const fs = runtime.fs ?? nodeFileSystem;
  const repoFlag = args.repo ? ` --repo ${args.repo}` : "";
  const retryCmd = buildRetryCommand(args, null);
  // The Codex install must target the Codex identity: without an explicit --entry/--harness,
  // resolve the `codex` entry, never the invoking runtime's harness (e.g. CLAUDECODE). Entry
  // resolution itself reads/parses pdb.toml, so it belongs inside the redacted error boundary.
  let resolution;
  try {
    resolution = await resolveEntry({
      entry: args.entry ?? undefined,
      harness: args.harness ?? "codex",
      env,
      root: scope.root,
      fs,
    });
  } catch (error) {
    // #844/Codex: entry resolution can fail on an unreadable/malformed identity file before
    // readIdentity runs; return the same structured refusal, never the raw filesystem error.
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "refused",
        code: "IDENTITY_REQUIRED",
        message:
          "The repository identity file (pdb.toml) could not be read; check access and retry.",
        diff: null,
        retry: null,
      },
      entry: null,
    };
  }
  if (resolution.status === "unresolved")
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "refused",
        code: "IDENTITY_AMBIGUOUS",
        message: `${resolution.message} No identity was borrowed: the Codex install resolves the Codex entry.`,
        diff: null,
        retry: null,
      },
      entry: null,
    };
  const entry = resolution.entry;
  let record;
  try {
    record = await readIdentity(scope.root, entry, fs);
  } catch (error) {
    // #844/CodeRabbit: never leak the checkout path or raw error; name only pdb.toml.
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "refused",
        code: "IDENTITY_REQUIRED",
        message:
          "The repository identity file (pdb.toml) could not be read; check access and retry.",
        diff: null,
        retry: `pdb config get identity.name --entry ${entry}`,
      },
      entry: null,
    };
  }
  // Validate the name with the canonical validator (pattern + 100-character limit), not just
  // non-null: an over-long or malformed name must not be reported as valid.
  const ready =
    record.entryExists &&
    record.name !== null &&
    isAgentName(record.name) &&
    record.triageRole !== null;
  if (ready)
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "applied",
        code: null,
        message: `Existing identity entry [agents.${entry}] is valid and will be preserved.`,
        diff: null,
        retry: null,
      },
      entry,
    };
  if (record.entryExists && (!record.name || !isAgentName(record.name))) {
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "refused",
        code: "IDENTITY_REQUIRED",
        message: `Identity entry [agents.${entry}] in pdb.toml has no valid name; set one explicitly.`,
        diff: null,
        retry: `pdb config set identity.name NAME --entry ${entry}${repoFlag}`,
      },
      entry: null,
    };
  }
  const role = args.role;
  if (!role) {
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: "kept",
        outcome: "refused",
        code: "IDENTITY_REQUIRED",
        message: `Identity entry [agents.${entry}] needs setup; pass --role implementer|designer and retry.`,
        diff: null,
        retry: null,
      },
      entry: null,
    };
  }
  const action = record.entryExists ? ("replace" as const) : ("create" as const);
  const section = entry.includes(".") ? `[agents."${entry}"]` : `[agents.${entry}]`;
  if (dryRun) {
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action,
        outcome: "planned",
        code: null,
        message: `Would configure [agents.${entry}] in pdb.toml with role ${role}.`,
        diff: `+ ${section}\n+ identity.triage_role = "${role}"\n`,
        retry: `pdb setup identity --role ${role} --entry ${entry}${repoFlag}`,
      },
      entry,
    };
  }
  try {
    const write = await setIdentity(
      { root: scope.root, repository: scope.repository },
      entry,
      "identity.triage_role",
      role,
      {
        fs,
        git: runtime.git,
        random: runtime.random,
        requireName: true,
        reuseExistingIdentity: true,
      },
    );
    const storedRole = write.record.triageRole ?? role;
    const finalAction = !write.changed ? ("kept" as const) : action;
    if (write.lockCleanup) {
      return {
        item: {
          kind: "identity",
          file: "pdb.toml",
          action: finalAction,
          outcome: "committed-with-error",
          code: "LOCKED",
          message: write.lockCleanup,
          diff: null,
          retry: retryCmd,
        },
        entry,
      };
    }
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action: finalAction,
        outcome: "applied",
        code: null,
        message: !write.changed
          ? `Existing identity entry [agents.${entry}] with role ${storedRole} is valid and was preserved.`
          : `Configured [agents.${entry}] in pdb.toml with role ${storedRole}.`,
        diff: null,
        retry: null,
      },
      entry,
    };
  } catch (error) {
    const isConfig = error instanceof ConfigError;
    const code = isConfig && /lock/i.test(error.message) ? "LOCKED" : "WRITE_FAILED";
    const message = isConfig
      ? error.recovery
        ? `${error.message} ${error.recovery}`
        : error.message
      : "Failed to configure repository identity in pdb.toml; check permissions and retry.";
    return {
      item: {
        kind: "identity",
        file: "pdb.toml",
        action,
        outcome: "failed",
        code,
        message,
        diff: null,
        retry: isConfig && code === "LOCKED" ? null : retryCmd,
      },
      entry: null,
    };
  }
}

function projectScope(
  scope: Extract<InstallInternalScope, { kind: "project" }>,
): InstallResultScope {
  return {
    kind: "project",
    repository: scope.repository,
    targets: { config: ".codex/config.toml", hooks: ".codex/hooks.json" },
  };
}

function globalScope(): InstallResultScope {
  return { kind: "global", targets: { config: "config.toml", hooks: "hooks.json" } };
}

const resultScope = (scope: InstallInternalScope): InstallResultScope =>
  scope.kind === "project" ? projectScope(scope) : globalScope();

/** The manifest scope the shared primitives expect, and the private manifest location. */
/** Sanitize MCP diff text so absolute paths and URL credentials/query tokens never leak. */
function redactMcpDiff(
  diff: string | null,
  internal: InstallInternalScope,
  redacted: InstallResultScope,
): string | null {
  if (!diff) return null;
  const basePath = internal.kind === "project" ? internal.root : internal.home;
  const configTarget =
    internal.kind === "project"
      ? `${internal.root}/${redacted.targets.config}`
      : `${internal.home}/${redacted.targets.config}`;
  const replacementRoot = internal.kind === "project" ? "<project>" : "<codex-home>";
  return diff
    .split(configTarget)
    .join(redacted.targets.config)
    .split(basePath)
    .join(replacementRoot)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/(https?:\/\/[^\s"?#]+)\?[^\s"]*/gi, "$1?***");
}

const manifestScope = (scope: InstallInternalScope): InstallScope =>
  scope.kind === "project"
    ? { kind: "project", root: scope.root, gitCommonDir: scope.gitCommonDir }
    : { kind: "global", stateDir: scope.home, homeDir: scope.home };

const manifestFor = (scope: InstallInternalScope, client: InstallClient): string =>
  manifestPath(manifestScope(scope), client);

function formatCodexInstallOutput(
  result: InstallResult,
  redacted: InstallResult["scope"],
  operation: InstallArguments["operation"],
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2) + "\n";
  const scopeLine =
    redacted.kind === "project"
      ? `project ${redacted.repository}`
      : "global (user-wide Codex home)";
  return `pdb ${operation} codex\nScope: ${scopeLine}\nItems:\n${result.items
    .map(
      (i) =>
        `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}${i.diff ? `\n${i.diff.trimEnd()}` : ""}${i.retry ? `\n    retry: ${i.retry}` : ""}`,
    )
    .join("\n")}\nHere's what to do next:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`;
}

async function evaluateCodexInstallPlan(
  args: InstallArguments,
  internal: InstallInternalScope,
  redacted: InstallResult["scope"],
  runtime: ConfigRuntime,
  dryRun: boolean,
  expectedSnapshot?: CodexInstallSnapshot,
): Promise<{ result: InstallResult; exitCode: number }> {
  const manifest = manifestFor(internal, args.client);
  const scope = manifestScope(internal);
  const conflicted =
    !dryRun &&
    expectedSnapshot &&
    codexInstallSnapshotChanged(expectedSnapshot, await readCodexInstallSnapshot(scope, manifest));
  const identity = conflicted
    ? { item: null, entry: null }
    : await identityStep(args, internal, runtime, dryRun);
  const identityItem = identity.item;
  const identityEntry = identity.entry;
  // Identity/context boundary: a project MCP registration must not proceed when the identity
  // decision refused or failed — otherwise the server later picks an unrelated agent from client
  // metadata instead of honoring the refused selection.
  const identityBlocked = identityItem?.outcome === "refused" || identityItem?.outcome === "failed";
  const mcp = conflicted
    ? {
        mcp: {
          action: "kept" as const,
          outcome: "refused" as const,
          ownership: "absent" as const,
          code: "CONFLICT" as const,
          message:
            "Codex configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      }
    : identityBlocked && internal.kind === "project" && args.operation === "install"
      ? {
          mcp: {
            action: "kept" as const,
            outcome: "not-attempted" as const,
            ownership: "absent" as const,
            code: "IDENTITY_REQUIRED" as const,
            message:
              "MCP registration withheld: the Codex identity could not be resolved; fix identity and re-run.",
            diff: null,
            manifestRecord: null,
          },
        }
      : args.operation === "uninstall"
        ? await uninstallCodexMcp({
            scope,
            manifestPath: manifest,
            dryRun,
            expectedSnapshot,
          })
        : await installCodexMcp({
            scope,
            options: {
              transport: args.transport,
              url: args.url,
              entry: identityEntry ?? args.entry,
              projectRoot: internal.kind === "project" ? internal.root : undefined,
            },
            manifestPath: manifest,
            pdbVersion: "0.1.0",
            dryRun,
            expectedSnapshot,
          });
  const hook = conflicted
    ? {
        hook: {
          action: "kept" as const,
          outcome: "refused" as const,
          ownership: "absent" as const,
          code: "CONFLICT" as const,
          message:
            "Codex configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      }
    : identityBlocked && internal.kind === "project" && args.operation === "install"
      ? {
          hook: {
            action: "kept" as const,
            outcome: "not-attempted" as const,
            ownership: "absent" as const,
            code: "IDENTITY_REQUIRED" as const,
            message:
              "Stop-hook registration withheld: the Codex identity could not be resolved; fix identity and re-run.",
            diff: null,
            manifestRecord: null,
          },
        }
      : args.operation === "uninstall"
        ? await uninstallCodexStopHook({
            scope,
            manifestPath: manifest,
            dryRun,
          })
        : await installCodexStopHook({
            scope,
            options: {
              role: internal.kind === "project" ? (identityEntry ?? args.role) : undefined,
              entry: internal.kind === "project" ? (identityEntry ?? args.entry) : undefined,
            },
            manifestPath: manifest,
            pdbVersion: "0.1.0",
            dryRun,
          });
  const mcpFailed =
    mcp.mcp.outcome === "refused" ||
    mcp.mcp.outcome === "failed" ||
    mcp.mcp.outcome === "committed-with-error";
  const mcpConfigured =
    args.operation === "install" &&
    !dryRun &&
    (mcp.mcp.outcome === "applied" ||
      mcp.mcp.outcome === "kept" ||
      mcp.mcp.outcome === "committed-with-error");
  const retryCmd = buildRetryCommand(args, identityEntry);
  // The primitive's message may embed absolute paths; the serialized result must use the
  // scope-relative target and never leak private paths (output/privacy contract).
  const items: InstallItem[] = [
    ...(identityItem ? [identityItem] : []),
    {
      kind: "mcp",
      file: redacted.targets.config,
      action: mcp.mcp.action,
      outcome: mcp.mcp.outcome,
      code: mcp.mcp.code,
      message: mcp.mcp.message,
      diff: redactMcpDiff(mcp.mcp.diff, internal, redacted),
      retry: mcpFailed ? retryCmd : null,
    },
    {
      kind: "hook",
      file: redacted.targets.hooks,
      action: hook.hook.action,
      outcome: hook.hook.outcome,
      code: hook.hook.code,
      message: hook.hook.message,
      diff: redactMcpDiff(hook.hook.diff, internal, redacted),
      retry:
        hook.hook.outcome === "refused" ||
        hook.hook.outcome === "failed" ||
        hook.hook.outcome === "committed-with-error"
          ? retryCmd
          : null,
    },
  ];
  const result: InstallResult = {
    schemaVersion: 1,
    kind: "install-result",
    client: args.client,
    operation: args.operation,
    scope: redacted,
    dryRun,
    items,
    status: {
      configured: mcpConfigured,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    },
    next: [
      args.operation === "install"
        ? dryRun
          ? "Dry run: pass --yes (or confirm interactively without --dry-run) to apply."
          : mcpConfigured
            ? "Codex MCP server is configured; Codex starts it on the next session."
            : "Fix any refused/failed items above and re-run."
        : dryRun
          ? "Dry run removal preview: pass --yes (or confirm interactively without --dry-run) to apply."
          : mcpFailed
            ? "Fix any refused/failed items above and re-run."
            : mcp.mcp.action === "absent"
              ? "No owned PDB Codex MCP entry was present; identity and unrelated entries were preserved."
              : "Removed owned PDB Codex MCP entries; identity and unrelated entries were preserved.",
      args.operation === "install" && args.transport === "http"
        ? "HTTP MCP transport is unverified for Codex (#397)."
        : "",
      hook.hook.outcome === "applied" || hook.hook.outcome === "kept"
        ? "Open Codex in the project, run /hooks, then review and trust the PDB Stop hook (native exact-definition trust; a changed definition needs normal review again)."
        : "",
    ].filter(Boolean),
  };
  // Exit status per the installer contract: 2 when an item is refused, failed or
  // committed-with-error; 1 when a non-preview request applied nothing; 0 for a successful
  // apply/kept or a preview.
  const refusedOrFailed = items.some(
    (i) =>
      i.outcome === "refused" ||
      i.outcome === "failed" ||
      i.outcome === "committed-with-error" ||
      i.code === "IDENTITY_REQUIRED",
  );
  const appliedOrCurrent = items.some(
    (i) => i.outcome === "applied" || i.outcome === "kept" || i.outcome === "adopted",
  );
  const exitCode = refusedOrFailed ? 2 : !appliedOrCurrent && !args.dryRun ? 1 : 0;
  return { result, exitCode };
}

/** Execute `pdb install codex` / `pdb uninstall codex` for the resolved scope (#768). */
export async function runCodexInstallSurface(
  args: InstallArguments,
  runtime: ConfigRuntime & { confirm?: (prompt: string) => Promise<boolean> },
  output: (text: string) => Promise<void>,
): Promise<number> {
  const internal = await resolveInstallScope(args, runtime);
  const redacted = resultScope(internal);
  // Confirmation contract: --dry-run always previews; --yes applies directly; otherwise a TTY
  // shows the read-only preview first and requests confirmation before applying, while a non-TTY
  // without --yes behaves as a dry run (never writes unconfirmed).
  if (args.dryRun || (!args.yes && !runtime.confirm)) {
    const preview = await evaluateCodexInstallPlan(args, internal, redacted, runtime, true);
    await output(formatCodexInstallOutput(preview.result, redacted, args.operation, args.json));
    return preview.exitCode;
  }
  let expectedSnapshot: CodexInstallSnapshot | undefined;
  if (!args.yes && runtime.confirm) {
    expectedSnapshot = await readCodexInstallSnapshot(
      manifestScope(internal),
      manifestFor(internal, args.client),
    );
    const preview = await evaluateCodexInstallPlan(args, internal, redacted, runtime, true);
    if (preview.exitCode === 2) {
      await output(formatCodexInstallOutput(preview.result, redacted, args.operation, args.json));
      return 2;
    }
    if (!args.json) {
      await output(formatCodexInstallOutput(preview.result, redacted, args.operation, false));
    }
    const approved = await runtime.confirm(
      `Apply pdb ${args.operation} codex in ${internal.kind === "project" ? internal.root : internal.home}?`,
    );
    if (!approved) {
      if (args.json) {
        await output(formatCodexInstallOutput(preview.result, redacted, args.operation, true));
      }
      return preview.exitCode;
    }
  }
  const applied = await evaluateCodexInstallPlan(
    args,
    internal,
    redacted,
    runtime,
    false,
    expectedSnapshot,
  );
  await output(formatCodexInstallOutput(applied.result, redacted, args.operation, args.json));
  return applied.exitCode;
}
