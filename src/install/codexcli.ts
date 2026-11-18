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
import { join } from "node:path";
import { ConfigError, nodeFileSystem } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { readIdentity } from "../config/identity.js";
import { resolveEntry, type Environment } from "../config/harness.js";
import { createGitService } from "../git/service.js";
import type { InstallItemKind } from "./manifest.js";

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
  | "committed-with-error"
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
      throw new Error(`--url must be an http(s) endpoint, got ${JSON.stringify(values.url)}.`);
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
Configure the PDB MCP connection for Codex (identity decision and hook follow in later slices).
Default scope is the current repository; --global uses the user-wide Codex home. STDIO is the
default; --transport http with --url is explicit. --dry-run previews planned items and writes
nothing. This slice performs no file writes: the exact per-transport diff is not shown.`
    : `Usage: pdb uninstall codex [--global] [--dry-run] [--json] [--yes]
Preview/record removal intent for PDB-managed Codex entries in the selected scope. This slice
performs no file writes: entries are not removed yet, and identity/project settings are never
touched. Already absent is a no-op. --global is required to target user-wide entries.`;

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
    let root: string | null = null;
    try {
      root = await svc.workingTreeRoot({ cwd });
    } catch {
      root = null;
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
    const gitCommonDir = (await svc.commonDirectory({ cwd: root })) ?? "";
    if (!gitCommonDir)
      throw new Error(
        `NO_PROJECT: the checkout's common directory could not be resolved. Next: ${args.dryRun ? "pdb" : "pdb"} install codex --global --dry-run${args.json ? " --json" : ""} for a user-wide preview.`,
      );
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

/** A read-only identity decision for a project install (never writes, never allocates). */
async function identityDecision(
  args: InstallArguments,
  scope: InstallInternalScope,
  runtime: ConfigRuntime,
): Promise<InstallItem | null> {
  if (args.operation !== "install" || scope.kind !== "project") return null;
  const env: Environment = runtime.env ?? process.env;
  const fs = runtime.fs ?? nodeFileSystem;
  const resolution = await resolveEntry({
    entry: args.entry ?? undefined,
    harness: args.harness ?? undefined,
    env,
    root: scope.root,
    fs,
  });
  if (resolution.status === "unresolved")
    return {
      kind: "identity",
      file: null,
      action: "kept",
      outcome: "refused",
      code: "IDENTITY_AMBIGUOUS",
      message: resolution.message,
      diff: null,
      retry: `pdb setup identity --role implementer|designer --entry KEY${args.repo ? ` --repo ${args.repo}` : ""}`,
    };
  const entry = resolution.entry;
  const record = await readIdentity(scope.root, entry, fs);
  const ready = record.entryExists && record.name !== null && record.triageRole !== null;
  if (ready)
    return {
      kind: "identity",
      file: null,
      action: "kept",
      outcome: "applied",
      code: null,
      message: `Existing identity entry [agents.${entry}] is valid and will be preserved.`,
      diff: null,
      retry: null,
    };
  return {
    kind: "identity",
    file: null,
    action: "kept",
    outcome: "planned",
    code: "IDENTITY_REQUIRED",
    message: `Identity entry [agents.${entry}] needs setup; pass --role implementer|designer.`,
    diff: null,
    retry: `pdb install codex --role implementer|designer --entry ${entry}${args.repo ? ` --repo ${args.repo}` : ""}`,
  };
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

/** Build a not-yet-implemented install result for slice 2a (no file writes). */
export async function runCodexInstallSurface(
  args: InstallArguments,
  runtime: ConfigRuntime,
  output: (text: string) => Promise<void>,
): Promise<number> {
  const internal = await resolveInstallScope(args, runtime);
  const redacted = resultScope(internal);
  const identity = await identityDecision(args, internal, runtime);
  const mcpMessage = args.dryRun
    ? "MCP entry planned (slice 2b implements the write)."
    : "MCP entry write not implemented in this slice (slice 2b).";
  // Uninstall previews describe removal intent; install describes the planned entry. This slice
  // performs no writes and cannot produce an exact transport-specific diff.
  const mcpAction: InstallItemAction = args.operation === "uninstall" ? "remove" : "create";
  const mcpOutcome: InstallItemOutcome = args.dryRun ? "planned" : "not-attempted";
  const items: InstallItem[] = [
    ...(identity ? [identity] : []),
    {
      kind: "mcp",
      file: redacted.targets.config,
      action: mcpAction,
      outcome: mcpOutcome,
      code: null,
      message: mcpMessage,
      diff: null,
      retry: null,
    },
    {
      kind: "hook",
      file: redacted.targets.hooks,
      action: "skipped",
      outcome: "not-attempted",
      code: "HOOK_NOT_AVAILABLE",
      message: "Installed hook adapter is a separate slice; withheld until it can bind a session.",
      diff: null,
      retry: null,
    },
  ];
  const result: InstallResult = {
    schemaVersion: 1,
    kind: "install-result",
    client: args.client,
    operation: args.operation,
    scope: redacted,
    dryRun: args.dryRun,
    items,
    status: {
      configured: false,
      trusted: "unknown",
      executed: "unknown",
      receiptVerified: "unknown",
    },
    next: [
      "This slice only establishes the command surface; no Codex configuration was written.",
      "Slice 2b implements the MCP entry; slice 2c the identity write and next-step text.",
      args.dryRun
        ? "Remove --dry-run when the write slices ship."
        : "Re-run once the write slices ship.",
    ],
  };
  // Exit 2 (partial/unfulfilled) when an identity decision needs setup; 0 otherwise.
  const exitCode =
    items.some((i) => i.outcome === "refused") || items.some((i) => i.code === "IDENTITY_REQUIRED")
      ? 2
      : 0;
  if (args.json) {
    await output(JSON.stringify(result, null, 2) + "\n");
    return exitCode;
  }
  const scopeLine =
    redacted.kind === "project"
      ? `project ${redacted.repository}`
      : "global (user-wide Codex home)";
  await output(
    `pdb ${args.operation} codex: command surface only (no configuration written).\nScope: ${scopeLine}\nItems:\n${result.items
      .map((i) => `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}`)
      .join("\n")}\nNext:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`,
  );
  return exitCode;
}
