/**
 * Codex MCP entry install/uninstall (#799, slice 2b of #768).
 *
 * Writes/removes the PDB MCP entry for Codex through the shared ownership manifest and safe
 * TOML primitives (`src/install/manifest.ts`, #767), preserving unrelated entries, comments and
 * layout. The installed `pdb-mcp` command is resolved from the running package (never a source
 * checkout, `tsx`, or a user-maintained `.mjs` helper); install refuses with
 * `UNSUPPORTED_SCOPE` before editing when the running package is not a real npm installation
 * rather than writing a command that cannot run. Project arguments are emitted for project
 * scope only, and Windows launches the packaged script through Node.
 */
import { readFile } from "node:fs/promises";
import { installedVersion } from "../updates/updates.js";
import {
  editTomlTable,
  readInstallManifest,
  removeTomlTable,
  writeInstallManifestRecord,
  type InstallEditErrorCode,
  type InstallScope,
  type ManifestRuntime,
} from "./manifest.js";
import type { InstallEditResult } from "./manifest.js";
import { acquireFileLock, type LockTiming } from "../config/filelock.js";

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
  platform?: NodeJS.Platform;
}): string {
  if (options.transport === "http") {
    const url = options.url ?? "http://127.0.0.1:4372/mcp";
    return `[mcp_servers.pdb]\nurl = ${tomlString(url)}\n`;
  }
  // Project args only for project scope: a user-wide registration must never carry a literal
  // "<root>" placeholder that mcpArguments resolves as a real filesystem path.
  const args: string[] = [];
  if (options.projectRoot !== undefined) {
    args.push("--project", options.projectRoot);
    if (options.entry) args.push("--entry", options.entry);
  }
  // Windows cannot execute a JavaScript file directly; launch it through Node.
  const platform = options.platform ?? process.platform;
  const command = platform === "win32" ? process.execPath : options.pdbMcp;
  const commandArgs = platform === "win32" ? [options.pdbMcp, ...args] : args;
  return `[mcp_servers.pdb]\ncommand = ${tomlString(command)}\nargs = ${JSON.stringify(commandArgs)}\n`;
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

export interface InstallEditResultLike {
  action: string;
  outcome: string;
  code: string | null;
  message: string;
  diff: string | null;
  manifestRecord: unknown;
}

/** A refusal with a fixed (redacted) message; never echoes paths or raw errors. */
function refusal(
  code: InstallEditErrorCode | "UNSUPPORTED_SCOPE",
  message: string,
): InstallEditResult {
  return {
    action: "kept",
    outcome: "refused",
    ownership: "absent",
    code: code as InstallEditErrorCode,
    message,
    diff: null,
    manifestRecord: null,
  };
}

const LOCK_TIMING: LockTiming = { waitMs: 5_000, pollMs: 50 };

/**
 * Serialize the full install/uninstall operation for one scope/client on the private manifest's
 * operation lock, so a concurrent uninstall cannot delete an ownership record an install just
 * saved (or vice versa). The lock file lives beside the private manifest, never on the native
 * config.
 */
async function withScopeLock<T>(
  manifestPath: string,
  runtime: ManifestRuntime | undefined,
  work: () => Promise<T>,
): Promise<{ status: "ok"; value: T } | { status: "refused"; reason: InstallEditResult }> {
  const fs = runtime?.fs;
  if (!fs || typeof fs.readFile !== "function") {
    return { status: "ok", value: await work() };
  }
  const now = runtime?.now ?? (() => new Date());
  const held = await acquireFileLock(
    {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, data) => fs.createSynced(p, data),
      unlink: (p) => fs.unlink(p),
    },
    `${manifestPath}.op.lock`,
    LOCK_TIMING,
    () => now().getTime(),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  if (held === null)
    return {
      status: "refused",
      reason: refusal("CONFLICT", "Another Codex installer operation holds the scope lock; retry."),
    };
  try {
    return { status: "ok", value: await work() };
  } finally {
    await held();
  }
}

/** Propagate an ownership-manifest persistence failure as an explicit partial outcome. */
function withManifestWrite(
  outcome: Awaited<ReturnType<typeof writeInstallManifestRecord>>,
  mcp: InstallEditResult,
): InstallEditResult {
  if (outcome.status === "written" || outcome.status === "committed-with-error") return mcp;
  return {
    action: mcp.action,
    outcome: "refused",
    ownership: mcp.ownership,
    code: "WRITE_FAILED",
    message:
      "The Codex MCP configuration was updated, but the private ownership record could not be saved; rerun to complete ownership tracking.",
    diff: null,
    manifestRecord: null,
  };
}

/** Raw configuration and ownership-manifest snapshot bound between preview and interactive apply (#768). */
export interface CodexInstallSnapshot {
  configRaw: string | null;
  manifestRaw: string | null;
}

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

/** Capture raw Codex `config.toml` and manifest contents for preview-to-apply conflict checks (#768). */
export async function readCodexInstallSnapshot(
  scope: InstallScope,
  manifestPath: string,
  fs?: ManifestRuntime["fs"],
): Promise<CodexInstallSnapshot> {
  return {
    configRaw: await readOptionalFile(codexConfigPath(scope), fs),
    manifestRaw: await readOptionalFile(manifestPath, fs),
  };
}

/** Whether the raw Codex `config.toml` or ownership manifest changed since a preview snapshot (#768). */
export const codexInstallSnapshotChanged = (
  expected: CodexInstallSnapshot,
  current: CodexInstallSnapshot,
): boolean =>
  expected.configRaw !== current.configRaw || expected.manifestRaw !== current.manifestRaw;

/** Install (or keep/replace) the PDB MCP entry in the scope's Codex `config.toml`. */
export async function installCodexMcp(params: {
  scope: InstallScope;
  options: CodexMcpOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  pdbMcp?: string | null;
  platform?: NodeJS.Platform;
  runtime?: ManifestRuntime;
  expectedSnapshot?: CodexInstallSnapshot;
}): Promise<CodexMcpResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime, expectedSnapshot } =
    params;
  const file = codexConfigPath(scope);
  const allowedRoot = codexConfigRoot(scope);
  // An STDIO registration without a resolvable installed command cannot run; refuse before any
  // edit instead of writing a broken command that could replace a working owned entry.
  if (options.transport === "stdio" && params.pdbMcp === undefined) {
    const pdbMcp = await resolveInstalledPdbMcp();
    if (!pdbMcp && !dryRun)
      return {
        mcp: refusal(
          "UNSUPPORTED_SCOPE",
          "The running PDB is not an npm installation, so the installed pdb-mcp command cannot be resolved; run the install from an installed package.",
        ),
      };
    params = { ...params, pdbMcp: pdbMcp ?? "" };
  }
  const pdbMcp = params.pdbMcp ?? "";
  const desiredBlock = buildCodexMcpBlock({
    pdbMcp,
    transport: options.transport,
    url: options.url,
    projectRoot: scope.kind === "project" ? scope.root : undefined,
    entry: options.entry,
    platform: params.platform,
  });
  // The read/edit/persist are one operation under the scope lock so a concurrent uninstall can't
  // delete an ownership record this install just saved (or vice versa).
  const guarded = await withScopeLock(manifestPath, runtime, async () => {
    if (!dryRun && expectedSnapshot) {
      const currentSnapshot = await readCodexInstallSnapshot(scope, manifestPath, runtime?.fs);
      if (codexInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
        return {
          mcp: refusal(
            "CONFLICT",
            "Codex configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          ),
        };
      }
    }
    const read = await readInstallManifest(manifestPath, runtime?.fs);
    if (read.status === "error")
      return {
        mcp: refusal(
          "MALFORMED_MANIFEST",
          "The private install manifest could not be read; refusing to edit without a trusted ownership record.",
        ),
      };
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
    // Persist the ownership record so a later uninstall/rerun recognizes this entry as owned; a
    // persistence failure is an explicit partial outcome, never unconditional success. Adopted
    // foreign tables carry an ownership record to save too.
    if (
      !dryRun &&
      (mcp.outcome === "applied" ||
        mcp.outcome === "adopted" ||
        mcp.outcome === "committed-with-error") &&
      mcp.manifestRecord
    ) {
      const wrote = await writeInstallManifestRecord(
        manifestPath,
        "codex",
        file,
        mcp.manifestRecord,
        runtime,
      );
      return { mcp: withManifestWrite(wrote, mcp) };
    }
    return { mcp };
  });
  if (guarded.status === "refused") return { mcp: guarded.reason };
  return guarded.value;
}

/** Remove the PDB MCP entry when it is owned; refuse edited/foreign per the manifest. */
export async function uninstallCodexMcp(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
  expectedSnapshot?: CodexInstallSnapshot;
}): Promise<CodexMcpResult> {
  const { scope, manifestPath, dryRun, runtime, expectedSnapshot } = params;
  const file = codexConfigPath(scope);
  const allowedRoot = codexConfigRoot(scope);
  // Read/edit/persist are one operation under the scope lock (see installCodexMcp).
  const guarded = await withScopeLock(manifestPath, runtime, async () => {
    if (!dryRun && expectedSnapshot) {
      const currentSnapshot = await readCodexInstallSnapshot(scope, manifestPath, runtime?.fs);
      if (codexInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
        return {
          mcp: refusal(
            "CONFLICT",
            "Codex configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
          ),
        };
      }
    }
    const read = await readInstallManifest(manifestPath, runtime?.fs);
    if (read.status === "error")
      return {
        mcp: refusal(
          "MALFORMED_MANIFEST",
          "The private install manifest could not be read; refusing to edit without a trusted ownership record.",
        ),
      };
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
    // A successful removal deletes the ownership record, so a repeated uninstall is `absent`; a
    // persistence failure is an explicit partial outcome.
    if (!dryRun && (mcp.outcome === "applied" || mcp.outcome === "committed-with-error")) {
      const wrote = await writeInstallManifestRecord(manifestPath, "codex", file, null, runtime);
      return { mcp: withManifestWrite(wrote, mcp) };
    }
    return { mcp };
  });
  if (guarded.status === "refused") return { mcp: guarded.reason };
  return guarded.value;
}
