/**
 * Ori MCP entry install/uninstall (#772).
 *
 * Writes/removes the PDB MCP entry for Ori through the shared ownership manifest and safe JSON
 * primitives (`src/install/manifest.ts`, #767), preserving unrelated entries and comments. Ori
 * uses the recorded `.ori/mcp.json` `mcpServers` shape (ori-mcp-acceptance.md): a project scope
 * `.ori/mcp.json` and an explicitly selected user-wide `.ori/mcp.json` under the home directory
 * for `--global`. The installed `pdb-mcp` command is resolved from the running package (never a
 * source checkout, `tsx`, or a user-maintained `.mjs` helper); install refuses with
 * `UNSUPPORTED_SCOPE` before editing when the running package is not a real npm installation
 * rather than writing a command that cannot run (attended-installer-delivery.md). Ori records no
 * native Stop hook: none is invented here, and a missing hook is reported as unsupported rather
 * than fabricated (attended-installer-delivery.md "do not invent one").
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installedVersion } from "../updates/updates.js";
import {
  editJsonEntry,
  readInstallManifest,
  removeJsonEntry,
  writeInstallManifestRecord,
  type InstallEditErrorCode,
  type InstallEditResult,
  type InstallScope,
  type JsonEntryAdapter,
  type ManifestRuntime,
} from "./manifest.js";
import { withScopeLock } from "./codexmcp.js";

/** The JSON path holding PDB under Ori's `mcpServers` map. */
export const oriMcpEntryKey = "pdb";

/** The recorded Ori project MCP file within a verified project root. */
const oriProjectMcpPath = (scope: Extract<InstallScope, { kind: "project" }>): string =>
  `${scope.root}/.ori/mcp.json`;
/** The user-wide Ori MCP file under the native home directory (explicit user scope). */
const oriUserMcpPath = (scope: Extract<InstallScope, { kind: "global" }>): string =>
  `${scope.homeDir}/.ori/mcp.json`;

export const oriMcpTargetPath = (scope: InstallScope): string =>
  scope.kind === "project" ? oriProjectMcpPath(scope) : oriUserMcpPath(scope);

/** The root the target file may be written under (project root or user home). */
export const oriMcpRoot = (scope: InstallScope): string =>
  scope.kind === "project" ? scope.root : scope.homeDir;

export interface OriMcpOptions {
  /** STDIO default; HTTP is explicit (no auto-detection). */
  transport: "stdio" | "http";
  /** Explicit HTTP URL (transport http). */
  url: string | null;
  /** The identity entry to pass via `--entry` on project install, when resolved. */
  entry: string | null;
  /** The verified project root, for `--project` args on project scope. */
  projectRoot?: string;
  /** Windows executes the packaged .mjs through Node (used by the native shell runner). */
  platform?: NodeJS.Platform;
}

/** What the `mcpServers.pdb` value looks like for the chosen transport. */
export function buildOriMcpEntry(options: {
  pdbMcp: string;
  transport: OriMcpOptions["transport"];
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
  // Windows cannot execute a JavaScript file directly; launch the packaged script through Node.
  const platform = options.platform ?? process.platform;
  const command = platform === "win32" ? process.execPath : options.pdbMcp;
  const commandArgs = platform === "win32" ? [options.pdbMcp, ...args] : args;
  return { type: "stdio", command, args: commandArgs };
}

/** Canonical JSON text of the desired `mcpServers.pdb` entry. */
export function desiredOriMcpEntryText(options: {
  pdbMcp: string;
  transport: OriMcpOptions["transport"];
  url: string | null;
  projectRoot?: string;
  entry?: string | null;
  platform?: NodeJS.Platform;
}): string {
  return JSON.stringify(buildOriMcpEntry(options));
}

/** A JSON entry adapter over `.ori/mcp.json`'s `mcpServers.pdb` (project and user-wide homes). */
export function oriMcpJsonAdapter(desired: Record<string, unknown>): JsonEntryAdapter {
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
      // Any existing value at the managed key is foreign without an ownership record: it must
      // never be silently overwritten (attended-installer-delivery.md "owned-only replacement").
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

export interface OriMcpResult {
  mcp: InstallEditResult;
}

/** Resolve the installed `pdb-mcp` packaged command path, or null when not an npm install. */
export async function resolveInstalledOriMcp(): Promise<string | null> {
  const installed = await installedVersion();
  if (!installed.installed || !installed.root) return null;
  // package.json `bin.pdb-mcp` points at dist/mcp.mjs; the packaged entry is the executable.
  return join(installed.root, "dist", "mcp.mjs");
}

/** Refuse an edit when the ownership manifest itself cannot be trusted (#970 finding 5). */
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

/** Raw Ori MCP config and ownership-manifest snapshot bound between preview and apply (#772). */
export interface OriInstallSnapshot {
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

/** Capture raw Ori MCP config and manifest contents for preview-to-apply conflict checks (#772). */
export async function readOriInstallSnapshot(
  scope: InstallScope,
  manifestPath: string,
  fs?: ManifestRuntime["fs"],
): Promise<OriInstallSnapshot> {
  return {
    configRaw: await readOptionalFile(oriMcpTargetPath(scope), fs),
    manifestRaw: await readOptionalFile(manifestPath, fs),
  };
}

/** Whether the raw Ori MCP config or ownership manifest changed since a preview snapshot (#772). */
export const oriInstallSnapshotChanged = (
  expected: OriInstallSnapshot,
  current: OriInstallSnapshot,
): boolean =>
  expected.configRaw !== current.configRaw || expected.manifestRaw !== current.manifestRaw;

/**
 * Install (or keep/replace) the PDB MCP entry in the project `.ori/mcp.json` (project scope) or
 * the user-wide `.ori/mcp.json` (--global). One serialized read/edit/persist under the shared
 * scope lock, refusing a concurrent change since the preview.
 */
export async function installOriMcp(params: {
  scope: InstallScope;
  options: OriMcpOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  pdbMcp?: string;
  runtime?: ManifestRuntime;
  expectedSnapshot?: OriInstallSnapshot;
}): Promise<OriMcpResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime, expectedSnapshot } =
    params;
  const file = oriMcpTargetPath(scope);
  const allowedRoot = oriMcpRoot(scope);
  // Only a STDIO entry launches pdb-mcp; an HTTP entry is a URL and never needs the packaged
  // executable (attended-installer-delivery.md transport distinction).
  const pdbMcp = params.pdbMcp ?? (await resolveInstalledOriMcp());
  if (!dryRun && options.transport === "stdio" && !pdbMcp)
    return {
      mcp: {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "UNSUPPORTED_SCOPE" as InstallEditErrorCode,
        message:
          "The running PDB is not an npm installation, so the installed pdb-mcp command cannot be resolved; refusing to write an MCP entry that cannot run.",
        diff: null,
        manifestRecord: null,
      },
    };
  const guarded = await withScopeLock(
    manifestPath,
    runtime,
    async () => {
      if (!dryRun && expectedSnapshot) {
        const currentSnapshot = await readOriInstallSnapshot(scope, manifestPath, runtime?.fs);
        if (oriInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
          return {
            mcp: {
              action: "kept" as const,
              outcome: "refused" as const,
              ownership: "absent" as const,
              code: "CONFLICT" as const,
              message:
                "Ori configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
              diff: null,
              manifestRecord: null,
            },
          };
        }
      }
      const desired = buildOriMcpEntry({
        pdbMcp: pdbMcp ?? "",
        transport: options.transport,
        url: options.url,
        projectRoot: scope.kind === "project" ? scope.root : undefined,
        entry: options.entry,
        platform: options.platform,
      });
      const adapter = oriMcpJsonAdapter(desired);
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
          "ori",
          file,
          mcp.manifestRecord,
          runtime,
        );
        return { mcp: manifestWriteRefusal(wrote, file, mcp) };
      }
      return { mcp };
    },
    dryRun,
  );
  if (guarded.status === "refused") return { mcp: guarded.reason };
  return guarded.value;
}

/** Remove the PDB MCP entry when owned; refuse edited/foreign entries per the manifest. */
export async function uninstallOriMcp(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
  expectedSnapshot?: OriInstallSnapshot;
}): Promise<OriMcpResult> {
  const { scope, manifestPath, dryRun, runtime, expectedSnapshot } = params;
  const file = oriMcpTargetPath(scope);
  const allowedRoot = oriMcpRoot(scope);
  const guarded = await withScopeLock(
    manifestPath,
    runtime,
    async () => {
      if (!dryRun && expectedSnapshot) {
        const currentSnapshot = await readOriInstallSnapshot(scope, manifestPath, runtime?.fs);
        if (oriInstallSnapshotChanged(expectedSnapshot, currentSnapshot)) {
          return {
            mcp: {
              action: "kept" as const,
              outcome: "refused" as const,
              ownership: "absent" as const,
              code: "CONFLICT" as const,
              message:
                "Ori configuration or ownership manifest changed since the preview; re-run to inspect the updated plan.",
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
      const adapter = oriMcpJsonAdapter({});
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
        const wrote = await writeInstallManifestRecord(manifestPath, "ori", file, null, runtime);
        return { mcp: manifestWriteRefusal(wrote, file, mcp) };
      }
      return { mcp };
    },
    dryRun,
  );
  if (guarded.status === "refused") return { mcp: guarded.reason };
  return guarded.value;
}
