/**
 * Claude MCP entry install/uninstall (#769, focused adapter slice; doc/design/attended-installer-delivery.md).
 *
 * Writes/removes the PDB MCP entry for Claude Code through the shared ownership manifest and safe JSON
 * primitives (`src/install/manifest.ts`, #767), preserving unrelated entries and layout. Project scope
 * uses the native `.mcp.json` `mcpServers.pdb` entry; `--global` targets the user-wide Claude config.
 * The installed `pdb-mcp` command is resolved from the running package (never a source checkout, `tsx`,
 * or a user-maintained `.mjs` helper); the caller refuses with `UNSUPPORTED_SCOPE` when the running
 * package is not a real npm installation rather than writing a command that cannot run.
 *
 * Per attended-installer-delivery.md, no Claude Stop entry is invented: the hook item stays
 * `not-attempted`/`HOOK_NOT_AVAILABLE` until a packaged session-bound adapter exists.
 */
import { installedVersion } from "../updates/updates.js";
import {
  editJsonEntry,
  readInstallManifest,
  removeJsonEntry,
  sha256Hex,
  writeInstallManifestRecord,
  type InstallScope,
  type JsonEntryAdapter,
  type ManifestRuntime,
} from "./manifest.js";
import type { InstallEditResult } from "./manifest.js";

/** Resolve the installed `pdb-mcp` packaged command path, or null when not an npm install. */
export async function resolveInstalledPdbMcp(): Promise<string | null> {
  const installed = await installedVersion();
  if (!installed.installed || !installed.root) return null;
  // package.json `bin.pdb-mcp` points at dist/mcp.mjs; the packaged entry is the executable.
  return `${installed.root}/dist/mcp.mjs`;
}

export interface ClaudeMcpOptions {
  /** STDIO default; HTTP is explicit (no auto-detection). */
  transport: "stdio" | "http";
  /** Explicit HTTP URL (transport http). */
  url: string | null;
  /** The identity entry to pass via `--entry` on project install, when resolved. */
  entry: string | null;
  /** The verified project root, for `--project` args on project scope. */
  projectRoot?: string;
}

/** What the `mcpServers.pdb` value looks like for the chosen transport. */
export function buildClaudeMcpEntry(options: {
  pdbMcp: string;
  transport: ClaudeMcpOptions["transport"];
  url: string | null;
  projectRoot?: string;
  entry?: string | null;
}): Record<string, unknown> {
  if (options.transport === "http") {
    const url = options.url ?? "http://127.0.0.1:4372/mcp";
    return { type: "http", url };
  }
  const args: string[] = [];
  if (options.projectRoot !== undefined) {
    args.push("--project", options.projectRoot);
    if (options.entry) args.push("--entry", options.entry);
  }
  return { type: "stdio", command: options.pdbMcp, args };
}

/** Canonical JSON text of the desired `mcpServers.pdb` entry. */
export function desiredClaudeMcpEntryText(options: {
  pdbMcp: string;
  transport: ClaudeMcpOptions["transport"];
  url: string | null;
  projectRoot?: string;
  entry?: string | null;
}): string {
  return JSON.stringify(buildClaudeMcpEntry(options));
}

/** A JSON entry adapter over `.mcp.json`'s `mcpServers.pdb` (project and user-wide homes). */
export function claudeMcpJsonAdapter(desired: Record<string, unknown>): JsonEntryAdapter {
  return {
    kind: "mcp",
    validateSchema(doc) {
      if (
        "mcpServers" in doc &&
        (typeof doc.mcpServers !== "object" ||
          doc.mcpServers === null ||
          Array.isArray(doc.mcpServers))
      )
        return "mcpServers must be a JSON object.";
      return null;
    },
    inspect(doc) {
      const servers = doc.mcpServers as Record<string, unknown> | undefined;
      const entry = servers?.pdb;
      if (entry === undefined) return { canonicalText: null, looksForeign: false };
      const canonicalText = JSON.stringify(entry);
      // Any existing value at the managed key is foreign when there is no ownership record:
      // an HTTP entry or a command whose path does not contain "pdb" must never be silently
      // overwritten (attended-installer-delivery.md "owned-only replacement").
      return { canonicalText, looksForeign: true };
    },
    apply(doc) {
      const existing = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
      return { ...doc, mcpServers: { ...existing, pdb: desired } };
    },
    remove(doc) {
      const existing = { ...(doc.mcpServers as Record<string, unknown> | undefined) };
      delete existing.pdb;
      const next = { ...doc };
      if (Object.keys(existing).length === 0) delete next.mcpServers;
      else next.mcpServers = existing;
      return next;
    },
    desiredCanonicalText: () => JSON.stringify(desired),
  };
}

export interface ClaudeMcpResult {
  mcp: InstallEditResult;
}

/** The Claude project `.mcp.json` path within a project scope. */
const claudeProjectMcpPath = (scope: Extract<InstallScope, { kind: "project" }>): string =>
  `${scope.root}/.mcp.json`;
/** The user-wide Claude config file (native user home; no invented sub-path). */
const claudeUserConfigFile = (scope: Extract<InstallScope, { kind: "global" }>): string =>
  `${scope.homeDir}/.claude.json`;

/** Refuse an edit when the ownership manifest itself cannot be trusted (#970 finding 5). An
 * absent manifest is the normal first-install state and is not a refusal; only a present but
 * malformed or future-schema manifest blocks the edit. */
function manifestReadRefusal(
  read: Awaited<ReturnType<typeof readInstallManifest>>,
  file: string,
): InstallEditResult | null {
  if (read.status !== "error") return null;
  const code =
    read.code === "FUTURE_MANIFEST_VERSION" ? "FUTURE_MANIFEST_VERSION" : "MALFORMED_MANIFEST";
  return {
    action: "kept",
    outcome: "refused",
    ownership: "absent",
    code,
    message: `${file}: ownership manifest is unreadable (${read.message}); refusing to edit without a trusted ownership record.`,
    diff: null,
    manifestRecord: null,
  };
}

/** Propagate an ownership-manifest persistence failure as an explicit partial outcome. */
function manifestWriteRefusal(
  outcome: Awaited<ReturnType<typeof writeInstallManifestRecord>>,
  file: string,
  mcp: InstallEditResult,
): InstallEditResult {
  if (outcome.status === "written" || outcome.status === "committed-with-error") return mcp;
  return {
    action: mcp.action,
    outcome: "refused",
    ownership: mcp.ownership,
    code: "WRITE_FAILED",
    message: `${file}: configuration was ${mcp.action} but the ownership record could not be saved (${outcome.reason}). Rerun to complete ownership tracking.`,
    diff: mcp.diff,
    manifestRecord: null,
  };
}

/**
 * Install (or keep/replace) the PDB MCP entry in the project `.mcp.json` (project scope) or the
 * user-wide Claude config (--global). The hook item is never touched here.
 */
export async function installClaudeMcp(params: {
  scope: InstallScope;
  options: ClaudeMcpOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  pdbMcp?: string;
  runtime?: ManifestRuntime;
}): Promise<ClaudeMcpResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime } = params;
  // Project scope uses the native project `.mcp.json`; --global targets the user config home.
  const file = scope.kind === "project" ? claudeProjectMcpPath(scope) : claudeUserConfigFile(scope);
  const allowedRoot = scope.kind === "project" ? scope.root : scope.homeDir;
  const pdbMcp = params.pdbMcp ?? (await resolveInstalledPdbMcp()) ?? "";
  const desired = buildClaudeMcpEntry({
    pdbMcp,
    transport: options.transport,
    url: options.url,
    projectRoot: scope.kind === "project" ? scope.root : undefined,
    entry: options.entry,
  });
  const adapter = claudeMcpJsonAdapter(desired);
  const read = await readInstallManifest(manifestPath, runtime?.fs);
  const manifestBlocked = manifestReadRefusal(read, file);
  if (manifestBlocked) return { mcp: manifestBlocked };
  const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
  const mcp = await editJsonEntry({
    file,
    allowedRoot,
    adapter,
    manifestRecord,
    pdbVersion,
    dryRun,
    adopt,
    runtime,
  });
  // Persist the ownership record so a later uninstall/rerun recognizes this entry as owned;
  // a persistence failure is an explicit partial outcome, never unconditional success.
  if (
    !dryRun &&
    (mcp.outcome === "applied" || mcp.outcome === "committed-with-error") &&
    mcp.manifestRecord
  ) {
    const wrote = await writeInstallManifestRecord(
      manifestPath,
      "claude",
      file,
      mcp.manifestRecord,
      runtime,
    );
    return { mcp: manifestWriteRefusal(wrote, file, mcp) };
  }
  return { mcp };
}

/** Remove the PDB MCP entry when owned; refuse edited/foreign entries per the manifest. */
export async function uninstallClaudeMcp(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<ClaudeMcpResult> {
  const { scope, manifestPath, dryRun, runtime } = params;
  const file = scope.kind === "project" ? claudeProjectMcpPath(scope) : claudeUserConfigFile(scope);
  const allowedRoot = scope.kind === "project" ? scope.root : scope.homeDir;
  const read = await readInstallManifest(manifestPath, runtime?.fs);
  const manifestBlocked = manifestReadRefusal(read, file);
  if (manifestBlocked) return { mcp: manifestBlocked };
  const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
  const adapter = claudeMcpJsonAdapter({});
  const mcp = await removeJsonEntry({
    file,
    allowedRoot,
    adapter,
    manifestRecord,
    dryRun,
    runtime,
  });
  // A successful removal deletes the ownership record, so repeated uninstall is `absent`; a
  // persistence failure is an explicit partial outcome.
  if (!dryRun && (mcp.outcome === "applied" || mcp.outcome === "committed-with-error")) {
    const wrote = await writeInstallManifestRecord(manifestPath, "claude", file, null, runtime);
    return { mcp: manifestWriteRefusal(wrote, file, mcp) };
  }
  return { mcp };
}

export { sha256Hex };
