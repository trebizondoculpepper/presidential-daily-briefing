/**
 * Codex MCP entry install/uninstall (#799, slice 2b of #768).
 *
 * Writes/removes the PDB MCP entry for Codex through the shared ownership manifest and safe
 * TOML primitives (`src/install/manifest.ts`, #767), preserving unrelated entries, comments and
 * layout. The installed `pdb-mcp` command is resolved from the running package (never a source
 * checkout, `tsx`, or a user-maintained `.mjs` helper); the caller refuses with
 * `UNSUPPORTED_SCOPE` when the running package is not a real npm installation rather than
 * writing a command that cannot run.
 */
import { installedVersion } from "../updates/updates.js";
import {
  editTomlTable,
  readInstallManifest,
  removeTomlTable,
  writeInstallManifestRecord,
  type InstallScope,
  type ManifestRuntime,
} from "./manifest.js";
import type { InstallEditResult } from "./manifest.js";

/** The TOML table that holds the PDB MCP server under Codex's `config.toml`. */
export const codexMcpTablePath = ["mcp_servers", "pdb"] as const;

/** Resolve the installed `pdb-mcp` packaged command path, or null when not an npm install. */
export async function resolveInstalledPdbMcp(): Promise<string | null> {
  const installed = await installedVersion();
  if (!installed.installed || !installed.root) return null;
  // package.json `bin.pdb-mcp` points at dist/mcp.mjs; the packaged entry is the executable.
  return `${installed.root}/dist/mcp.mjs`;
}

export interface CodexMcpOptions {
  /** STDIO default; HTTP is explicit. */
  transport: "stdio" | "http";
  /** Explicit HTTP URL (transport http); unused for stdio. */
  url: string | null;
  /** The identity entry to pass via `--entry` on project install, when resolved. */
  entry: string | null;
  /** The verified project root, for `--project` args on project scope. */
  projectRoot?: string;
}

/** Build the canonical `[mcp_servers.pdb]` block for the given transport. */
export function buildCodexMcpBlock(options: {
  pdbMcp: string;
  transport: CodexMcpOptions["transport"];
  url: string | null;
  projectRoot?: string;
  entry?: string | null;
}): string {
  if (options.transport === "http") {
    const url = options.url ?? "http://127.0.0.1:4372/mcp";
    return `[mcp_servers.pdb]\nurl = ${tomlString(url)}\n`;
  }
  const args = ["--project", options.projectRoot ?? "<root>"];
  if (options.entry) args.push("--entry", options.entry);
  const argsJson = JSON.stringify(args);
  return `[mcp_servers.pdb]\ncommand = ${tomlString(options.pdbMcp)}\nargs = ${argsJson}\n`;
}

/** Single-line TOML string literal (double-quoted), escaping backslash and quote. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface CodexMcpResult {
  mcp: InstallEditResult;
}
/** The Codex `config.toml` path within a project or user-wide scope. */
const codexConfigPath = (scope: InstallScope): string =>
  scope.kind === "project" ? `${scope.root}/.codex/config.toml` : `${scope.homeDir}/config.toml`;
/** The root files are allowed to be written under (project root or user home). */
const codexConfigRoot = (scope: InstallScope): string =>
  scope.kind === "project" ? scope.root : scope.homeDir;

/** Install (or keep/replace) the PDB MCP entry in the scope's Codex `config.toml`. */
export async function installCodexMcp(params: {
  scope: InstallScope;
  options: CodexMcpOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  pdbMcp?: string;
  runtime?: ManifestRuntime;
}): Promise<CodexMcpResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime } = params;
  const file = codexConfigPath(scope);
  const allowedRoot = codexConfigRoot(scope);
  const pdbMcp = params.pdbMcp ?? (await resolveInstalledPdbMcp()) ?? "";
  const desiredBlock = buildCodexMcpBlock({
    pdbMcp,
    transport: options.transport,
    url: options.url,
    projectRoot: scope.kind === "project" ? scope.root : undefined,
    entry: options.entry,
  });
  const read = await readInstallManifest(manifestPath, runtime?.fs);
  const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
  const mcp = await editTomlTable({
    file,
    allowedRoot,
    tablePath: [...codexMcpTablePath],
    desiredBlock,
    kind: "mcp",
    manifestRecord,
    pdbVersion,
    dryRun,
    adopt,
    runtime,
  });
  // Persist the ownership record so a later uninstall/rerun recognizes this entry as owned.
  if (
    !dryRun &&
    (mcp.outcome === "applied" || mcp.outcome === "committed-with-error") &&
    mcp.manifestRecord
  )
    await writeInstallManifestRecord(manifestPath, "codex", file, mcp.manifestRecord, runtime);
  return { mcp };
}

/** Remove the PDB MCP entry when it is owned; refuse edited/foreign per the manifest. */
export async function uninstallCodexMcp(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<CodexMcpResult> {
  const { scope, manifestPath, dryRun, runtime } = params;
  const file = codexConfigPath(scope);
  const allowedRoot = codexConfigRoot(scope);
  const read = await readInstallManifest(manifestPath, runtime?.fs);
  const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
  const mcp = await removeTomlTable({
    file,
    allowedRoot,
    tablePath: [...codexMcpTablePath],
    kind: "mcp",
    manifestRecord,
    dryRun,
    runtime,
  });
  // A successful removal deletes the ownership record, so a repeated uninstall is `absent`.
  if (!dryRun && (mcp.outcome === "applied" || mcp.outcome === "committed-with-error"))
    await writeInstallManifestRecord(manifestPath, "codex", file, null, runtime);
  return { mcp };
}
