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
import { ConfigError } from "../config/config.js";
import type { ConfigRuntime } from "../config/configcli.js";
import { resolveIdentityTarget } from "../config/identity.js";
import { resolveProjectGitCommonDir } from "./manifest.js";
import type { InstallItemKind } from "./manifest.js";

/** A registered installer client; only Codex is implemented in this slice. */
export type InstallClient = "codex";

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
  kind: InstallItemKind;
  file: string | null;
  action: InstallItemAction;
  outcome: InstallItemOutcome;
  code: InstallErrorCode | null;
  message: string;
  diff: string | null;
  retry: string | null;
}

export interface InstallResult {
  schemaVersion: 1;
  kind: "install-result";
  client: InstallClient;
  operation: "install" | "uninstall";
  scope: { kind: "project"; root: string; repository: string } | { kind: "global"; home: string };
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
  const client = (positionals[0] ?? "codex") as InstallClient;
  if (client !== "codex")
    throw new Error(`Unsupported installer client ${JSON.stringify(client)}; supported: codex.`);
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

export const installHelp = (operation: "install" | "uninstall"): string =>
  operation === "install"
    ? `Usage: pdb install codex [--global] [--transport stdio|http] [--url URL] [--role implementer|designer]
                    [--entry KEY | --harness NAME] [--repo owner/name] [--dry-run] [--json] [--yes]
Configure the PDB MCP connection for Codex (identity and hook follow in later slices). Default
scope is the current repository; --global uses the user-wide Codex home. STDIO is the default;
--transport http with --url is explicit. --dry-run previews exact changes and writes nothing.`
    : `Usage: pdb uninstall codex [--global] [--dry-run] [--json] [--yes]
Remove only PDB-managed Codex entries in the selected scope; identity, project settings and
unrelated entries survive. Already absent is a no-op. --global is required to touch user-wide
entries.`;

/** Resolve the installer scope: project root (default) or user-wide Codex home (--global). */
export async function resolveInstallScope(
  args: InstallArguments,
  runtime: ConfigRuntime,
): Promise<InstallResult["scope"]> {
  if (args.global) {
    const homeDir = process.env.HOME ?? homedir();
    const codexHome = process.env.CODEX_HOME?.trim();
    const home = codexHome ? resolveHome(codexHome, homeDir) : homeDir;
    return { kind: "global", home };
  }
  try {
    const target = await resolveIdentityTarget(
      runtime.cwd ?? process.cwd(),
      args.repo ?? undefined,
      runtime.git,
    );
    if (!target.root) throw new Error("NO_PROJECT: no Git working-tree root.");
    const root = target.root;
    const repository = target.repository ?? args.repo ?? "";
    if (!repository)
      throw new Error(
        "NO_PROJECT: the repository could not be resolved; run from the checkout or pass --repo owner/name.",
      );
    await resolveProjectGitCommonDir(root, runtime.git);
    return { kind: "project", root, repository };
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`NO_PROJECT: ${error.message}`);
    throw error;
  }
}

function resolveHome(path: string, homeDir: string): string {
  if (path.startsWith("~/")) return path.replace(/^~/, homeDir);
  return path;
}

/** Build a not-yet-implemented install result for slice 2a (no file writes). */
export async function runCodexInstallSurface(
  args: InstallArguments,
  runtime: ConfigRuntime,
  output: (text: string) => Promise<void>,
): Promise<number> {
  const scope = await resolveInstallScope(args, runtime);
  const items: InstallItem[] = [
    {
      kind: "mcp",
      file:
        scope.kind === "project" ? `${scope.root}/.codex/config.toml` : `${scope.home}/config.toml`,
      action: "create",
      outcome: args.dryRun ? "planned" : "not-attempted",
      code: args.dryRun ? null : "HOOK_NOT_AVAILABLE",
      message: args.dryRun
        ? "MCP entry planned (slice 2b implements the write)."
        : "MCP entry write not implemented in this slice (slice 2b).",
      diff: args.dryRun ? `[mcp_servers.pdb]\ncommand = "..."` : null,
      retry: null,
    },
    {
      kind: "hook",
      file:
        scope.kind === "project" ? `${scope.root}/.codex/hooks.json` : `${scope.home}/hooks.json`,
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
      "This slice only establishes the command surface; no Codex configuration was written.",
      "Slice 2b implements the MCP entry; slice 2c the identity and next-step text.",
      args.dryRun
        ? "Remove --dry-run when the write slices ship."
        : "Re-run once the write slices ship.",
    ],
  };
  if (args.json) {
    await output(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  await output(
    `pdb install codex: command surface only (no configuration written).\nScope: ${scope.kind === "project" ? `project ${scope.repository} at ${scope.root}` : `global ${scope.home}`}\nItems:\n${result.items
      .map((i) => `  ${i.kind} (${i.outcome}${i.code ? `, ${i.code}` : ""}): ${i.message}`)
      .join("\n")}\nNext:\n${result.next.map((n) => `  - ${n}`).join("\n")}\n`,
  );
  return 0;
}
