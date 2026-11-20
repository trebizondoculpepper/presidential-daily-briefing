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
import { readFile } from "node:fs/promises";
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

/** Resolve the installed `pdb` packaged CLI path, or null when not an npm install. */
export async function resolveInstalledPdb(): Promise<string | null> {
  const installed = await installedVersion();
  if (!installed.installed || !installed.root) return null;
  // package.json `bin.pdb` points at dist/cli.mjs; the packaged entry is the executable.
  return `${installed.root}/dist/cli.mjs`;
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
  platform?: NodeJS.Platform;
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
  // Windows cannot execute a JavaScript file directly; launch the packaged script through
  // Node (the same shape the package smoke test uses, scripts/package-test.ts).
  const platform = options.platform ?? process.platform;
  const command = platform === "win32" ? process.execPath : options.pdbMcp;
  const commandArgs = platform === "win32" ? [options.pdbMcp, ...args] : args;
  return { type: "stdio", command, args: commandArgs };
}

/** Canonical JSON text of the desired `mcpServers.pdb` entry. */
export function desiredClaudeMcpEntryText(options: {
  pdbMcp: string;
  transport: ClaudeMcpOptions["transport"];
  url: string | null;
  projectRoot?: string;
  entry?: string | null;
  platform?: NodeJS.Platform;
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

/** Raw Claude MCP config, hook settings and ownership-manifest snapshot bound between preview and apply (#769, #771). */
export interface ClaudeInstallSnapshot {
  configRaw: string | null;
  /** Raw Claude settings file holding the owned Stop hook, so a concurrent hook change is detected. */
  hooksRaw: string | null;
  manifestRaw: string | null;
}

const claudeTargetPath = (scope: InstallScope): string =>
  scope.kind === "project" ? claudeProjectMcpPath(scope) : claudeUserConfigFile(scope);

/** Claude settings path within a project or user-wide scope (mirrors claudehook.claudeSettingsPath). */
const claudeHookSettingsPath = (scope: InstallScope, claudeConfigDir?: boolean): string =>
  scope.kind === "project"
    ? `${scope.root}/.claude/settings.local.json`
    : claudeConfigDir
      ? `${scope.homeDir}/settings.json`
      : `${scope.homeDir}/.claude/settings.json`;

const readOptionalFile = async (
  path: string,
  fs?: ManifestRuntime["fs"],
): Promise<string | null> => {
  try {
    return fs ? await fs.readFile(path) : await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Capture raw Claude MCP config, hook settings and manifest contents for preview-to-apply conflict checks (#769). */
export async function readClaudeInstallSnapshot(
  scope: InstallScope,
  manifestPath: string,
  hookSettingsPath: string,
  fs?: ManifestRuntime["fs"],
): Promise<ClaudeInstallSnapshot> {
  return {
    configRaw: await readOptionalFile(claudeTargetPath(scope), fs),
    hooksRaw: await readOptionalFile(hookSettingsPath, fs),
    manifestRaw: await readOptionalFile(manifestPath, fs),
  };
}

/** Whether the raw Claude MCP config, hook settings or ownership manifest changed since a preview snapshot (#769). */
export const claudeInstallSnapshotChanged = (
  expected: ClaudeInstallSnapshot,
  current: ClaudeInstallSnapshot,
): boolean =>
  expected.configRaw !== current.configRaw ||
  expected.hooksRaw !== current.hooksRaw ||
  expected.manifestRaw !== current.manifestRaw;

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
  /** When true, the global scope's homeDir is an explicit CLAUDE_CONFIG_DIR. */
  claudeConfigDir?: boolean;
  /** Platform used to shape the STDIO command (win32 launches through Node); tests inject. */
  platform?: NodeJS.Platform;
  runtime?: ManifestRuntime;
  expectedSnapshot?: ClaudeInstallSnapshot;
}): Promise<ClaudeMcpResult> {
  const {
    scope,
    options,
    manifestPath,
    pdbVersion,
    dryRun,
    adopt,
    runtime,
    claudeConfigDir,
    expectedSnapshot,
  } = params;
  // Project scope uses the native project `.mcp.json`; --global targets the user config home.
  const file = claudeTargetPath(scope);
  const allowedRoot = scope.kind === "project" ? scope.root : scope.homeDir;
  const hookSettingsPath = claudeHookSettingsPath(scope, claudeConfigDir);
  if (!dryRun && expectedSnapshot) {
    const currentSnapshot = await readClaudeInstallSnapshot(
      scope,
      manifestPath,
      hookSettingsPath,
      runtime?.fs,
    );
    if (claudeInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
      return {
        mcp: {
          action: "kept",
          outcome: "refused",
          ownership: "absent",
          code: "CONFLICT",
          message:
            "Claude configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      };
    }
  }
  const pdbMcp = params.pdbMcp ?? (await resolveInstalledPdbMcp()) ?? "";
  const desired = buildClaudeMcpEntry({
    pdbMcp,
    transport: options.transport,
    url: options.url,
    projectRoot: scope.kind === "project" ? scope.root : undefined,
    entry: options.entry,
    platform: params.platform,
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
  claudeConfigDir?: boolean;
  expectedSnapshot?: ClaudeInstallSnapshot;
}): Promise<ClaudeMcpResult> {
  const { scope, manifestPath, dryRun, runtime, claudeConfigDir, expectedSnapshot } = params;
  const file = claudeTargetPath(scope);
  const allowedRoot = scope.kind === "project" ? scope.root : scope.homeDir;
  const hookSettingsPath = claudeHookSettingsPath(scope, claudeConfigDir);
  if (!dryRun && expectedSnapshot) {
    const currentSnapshot = await readClaudeInstallSnapshot(
      scope,
      manifestPath,
      hookSettingsPath,
      runtime?.fs,
    );
    if (claudeInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
      return {
        mcp: {
          action: "kept",
          outcome: "refused",
          ownership: "absent",
          code: "CONFLICT",
          message:
            "Claude configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          diff: null,
          manifestRecord: null,
        },
      };
    }
  }
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
