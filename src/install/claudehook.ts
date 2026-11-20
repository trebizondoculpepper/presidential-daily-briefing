/**
 * Claude Code Stop-hook registration (#771).
 *
 * Installs or removes only PDB's owned Stop entry in the target Claude settings
 * document (project `.claude/settings.local.json` or user `~/.claude/settings.json`),
 * invoking the packaged `pdb rebrief claude-stop --installed` adapter. Claude Code
 * registers hooks under a `hooks` object; each event (Stop, SessionStart) holds an
 * array of matcher groups, each group holding its own `hooks` command list
 * (`hooks.Stop: [{ hooks: [{ type, command }] }]`). Only the owned command entry is
 * created/replaced or removed; unrelated events, groups, commands and keys are
 * preserved exactly, and an edited or foreign entry is refused, mirroring the MCP
 * entry rules and the Codex Stop hook (#770).
 *
 * The installed command carries no paths or session: `pdb rebrief claude-stop
 * --installed`, plus `--role R` and `--entry <key>` for project scope. No
 * session-budget creation, counter reset, natural-stop fabrication or transcript
 * inference happens here: the hook only binds the reviewed installed invocation.
 */
import {
  editJsonEntry,
  readInstallManifest,
  removeJsonEntry,
  writeInstallManifestRecord,
  type InstallEditResult,
  type InstallEditErrorCode,
  type InstallFs,
  type InstallScope,
  type JsonEntryAdapter,
  type ManifestRuntime,
} from "./manifest.js";
import { resolveInstalledPdb } from "./claudemcp.js";
import { withScopeLock } from "./codexmcp.js";
import { nodeSafeFs } from "../config/safejson.js";

/** Refuse an edit when the ownership manifest itself cannot be trusted (#970 pattern). */
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
  subject: string,
  hook: InstallEditResult,
): InstallEditResult {
  if (outcome.status === "written") return hook;
  // A committed-with-error write is still a partial outcome: report it rather than clean success
  // (it counts as written for uninstall but must surface the diagnostic and exit non-zero).
  if (outcome.status === "committed-with-error")
    return { ...hook, outcome: "committed-with-error" as const };
  return {
    action: hook.action,
    outcome: "refused",
    ownership: hook.ownership,
    code: "WRITE_FAILED",
    message: `${subject} was updated, but the private ownership record could not be saved (${outcome.reason}). Rerun to complete ownership tracking.`,
    diff: hook.diff,
    manifestRecord: null,
  };
}

/** Read a file's raw text, or null when it is absent; other read failures propagate. */
async function readOptionalText(path: string, fs?: InstallFs): Promise<string | null> {
  try {
    return await (fs ?? nodeSafeFs).readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The hook event PDB registers for: the synchronous Claude Code Stop event. */
export const claudeStopHookEvent = "Stop";

/** Native hook timeout in seconds (native default 600; an explicit short bound per the shared core). */
export const claudeHookNativeTimeout = 10;

/** The installed adapter deadline for `--installed` mode (must stay under the native timeout). */
export const claudeInstalledDeadlineMs = 4000;

/** The owned Stop group PDB writes: one matcher group holding one command entry (native shape). */
export function claudeStopEntry(command: string): unknown[] {
  return [
    {
      hooks: [
        {
          type: "command",
          command,
          timeout: claudeHookNativeTimeout,
        },
      ],
    },
  ];
}

/** Construct the installed command invoking the resolved packaged `pdb` CLI (never a bare PATH name). */
export function claudeStopCommand(options: {
  /** The absolute installed `pdb` CLI path (package.json bin, dist/cli.mjs). */
  pdbPath: string;
  /** Pass `--role` for project scope only (identity resolution is runtime). */
  role?: string | null;
  /** Pass `--entry <key>` for project scope only. */
  entry?: string | null;
  /** Windows executes the packaged .mjs through Node (used by the native shell runner). */
  platform?: NodeJS.Platform;
}): string {
  const args = [
    "rebrief",
    "claude-stop",
    "--installed",
    `--deadline-ms ${claudeInstalledDeadlineMs}`,
  ];
  if (options.role) args.push(`--role ${options.role}`);
  if (options.entry) args.push(`--entry ${options.entry}`);
  // The installed command carries no session paths; the executable is the running package's pdb,
  // quoted for a native shell (attended-installer-delivery.md resolves from the running package).
  // Windows launches the packaged .mjs through Node: both the Node executable and the script path
  // are quoted so paths containing spaces are forwarded literally.
  const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const executable =
    (options.platform ?? process.platform) === "win32"
      ? `${quote(process.execPath)} ${quote(options.pdbPath)}`
      : quote(options.pdbPath);
  return `${executable} ${args.join(" ")}`;
}

/** Whether a command entry is PDB's owned Stop command. */
const isOwnedClaudeEntry = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  (entry as { type?: unknown }).type === "command" &&
  typeof (entry as { command?: unknown }).command === "string" &&
  (entry as { command: string }).command.includes("claude-stop");

/** Extract the owned hook entries text for classification, and whether it looks foreign. */
export function inspectClaudeStopEntry(doc: Record<string, unknown>): {
  canonicalText: string | null;
  looksForeign: boolean;
} {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return { canonicalText: null, looksForeign: false };
  }
  const stop = (hooks as Record<string, unknown>)[claudeStopHookEvent];
  if (!Array.isArray(stop)) return { canonicalText: null, looksForeign: false };
  // Claude Code nests command hooks inside matcher groups (hooks.Stop: [{ hooks: [...] }]).
  // Only PDB-looking entries participate in ownership classification; unrelated commands and
  // groups are preserved and never conflate the owned entry's canonical text.
  const pdbEntries: unknown[] = [];
  for (const group of stop) {
    if (!group || typeof group !== "object") continue;
    const commands = (group as { hooks?: unknown[] }).hooks;
    if (!Array.isArray(commands)) continue;
    for (const entry of commands) {
      if (isOwnedClaudeEntry(entry)) pdbEntries.push(entry);
    }
  }
  if (pdbEntries.length === 0) return { canonicalText: null, looksForeign: false };
  return {
    canonicalText: JSON.stringify(pdbEntries),
    // A command invoking claude-stop without a manifest record is PDB-foreign and must be
    // adopted, never overwritten; unrelated hooks are absent with respect to PDB.
    looksForeign: true,
  };
}

/** The JSON-entry adapter for the owned Claude Stop command entry. */
export function claudeHookAdapter(command: string): JsonEntryAdapter {
  return {
    kind: "hook",
    inspect: (doc) => inspectClaudeStopEntry(doc),
    desiredCanonicalText: () =>
      JSON.stringify([{ type: "command", command, timeout: claudeHookNativeTimeout }]),
    validateSchema: (doc) => {
      if (!("hooks" in doc)) return null;
      if (typeof doc.hooks !== "object" || doc.hooks === null || Array.isArray(doc.hooks))
        return "hooks must be a JSON object.";
      // A Stop value that exists but is not an array is an unsupported native shape: refuse it
      // rather than replacing its contents (mirrors the Codex Stop hook review, #770/#1124).
      if (
        claudeStopHookEvent in (doc.hooks as Record<string, unknown>) &&
        !Array.isArray((doc.hooks as Record<string, unknown>)[claudeStopHookEvent])
      )
        return `${claudeStopHookEvent} must be a JSON array of matcher groups.`;
      return null;
    },
    apply: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      // Replace any owned claude-stop command entries and preserve unrelated hooks, including
      // unrelated commands co-located in the same matcher group (reviewed #1124 pattern).
      const stopGroups = Array.isArray(existingHooks[claudeStopHookEvent])
        ? (existingHooks[claudeStopHookEvent] as unknown[]).flatMap((group) => {
            if (!group || typeof group !== "object") return [group];
            const commands = (group as { hooks?: unknown[] }).hooks;
            if (!Array.isArray(commands)) return [group];
            const kept = commands.filter((entry) => !isOwnedClaudeEntry(entry));
            // A surviving group with unrelated commands keeps its other metadata (matcher, ...)
            // and only replaces the hooks array; an emptied group is dropped.
            return kept.length === commands.length
              ? [group]
              : kept.length > 0
                ? [{ ...group, hooks: kept }]
                : [];
          })
        : [];
      return {
        ...doc,
        hooks: {
          ...existingHooks,
          [claudeStopHookEvent]: [...stopGroups, ...claudeStopEntry(command)],
        },
      };
    },
    remove: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      const stopGroups = Array.isArray(existingHooks[claudeStopHookEvent])
        ? (existingHooks[claudeStopHookEvent] as unknown[]).flatMap((group) => {
            if (!group || typeof group !== "object") return [group];
            const commands = (group as { hooks?: unknown[] }).hooks;
            if (!Array.isArray(commands)) return [group];
            const kept = commands.filter((entry) => !isOwnedClaudeEntry(entry));
            return kept.length === commands.length
              ? [group]
              : kept.length > 0
                ? [{ ...group, hooks: kept }]
                : [];
          })
        : [];
      if (stopGroups.length === 0) {
        const next = { ...existingHooks };
        if (next[claudeStopHookEvent] && Array.isArray(next[claudeStopHookEvent]))
          delete next[claudeStopHookEvent];
        return { ...doc, hooks: next };
      }
      return { ...doc, hooks: { ...existingHooks, [claudeStopHookEvent]: stopGroups } };
    },
  };
}

/** Claude settings path within a project or user-wide scope (gitignored for project). */
export function claudeSettingsPath(scope: InstallScope, claudeConfigDir?: boolean): string {
  return scope.kind === "project"
    ? `${scope.root}/.claude/settings.local.json`
    : claudeConfigDir
      ? `${scope.homeDir}/settings.json`
      : `${scope.homeDir}/.claude/settings.json`;
}
/** The root files are allowed to be written under (project root or user home). */
const claudeSettingsRoot = (scope: InstallScope): string =>
  scope.kind === "project" ? scope.root : scope.homeDir;

export interface ClaudeStopHookOptions {
  /** `--role` for project scope only. */
  role?: string | null;
  /** `--entry <key>` for project scope only. */
  entry?: string | null;
}

export interface ClaudeHookResult {
  hook: InstallEditResult;
}

/** Install (or keep/replace) the owned Claude Stop hook entry in the scope's settings file. */
export async function installClaudeStopHook(params: {
  scope: InstallScope;
  options: ClaudeStopHookOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  /** True when the global scope's homeDir is an explicit CLAUDE_CONFIG_DIR. */
  claudeConfigDir?: boolean;
  /** Injected installed pdb path for tests; resolves from the running package when omitted. */
  pdbPath?: string;
  /** The approved preview's hook-settings raw text, when an interactive preview was shown. */
  expectedHooksRaw?: string | null;
  runtime?: ManifestRuntime;
}): Promise<ClaudeHookResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, claudeConfigDir, runtime } =
    params;
  const file = claudeSettingsPath(scope, claudeConfigDir);
  const allowedRoot = claudeSettingsRoot(scope);
  // The installed command must invoke this running package's pdb, not another PATH version;
  // a non-preview install refuses when it cannot be resolved (attended-installer-delivery.md).
  const installedPdb = params.pdbPath ?? (await resolveInstalledPdb());
  if (!dryRun && !installedPdb)
    return {
      hook: {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "UNSUPPORTED_SCOPE" as InstallEditErrorCode,
        message:
          "The running PDB is not an npm installation, so the installed pdb command cannot be resolved; refusing to write a Stop hook that cannot run.",
        diff: null,
        manifestRecord: null,
      },
    };
  const command = claudeStopCommand({ ...options, pdbPath: installedPdb ?? "" });
  const guarded = await withScopeLock(
    manifestPath,
    runtime,
    async () => {
      // Under the operation lock, re-verify the hook settings against what the preview approved:
      // another installer may have changed the hook or its ownership record while the MCP phase ran
      // or while this command waited for the lock, and that new state must be refused, not adopted
      // as the baseline (reviewed #1126 finding).
      if (!dryRun && params.expectedHooksRaw !== undefined) {
        const current = await readOptionalText(file, runtime?.fs);
        if (current !== params.expectedHooksRaw) {
          return {
            hook: {
              action: "kept" as const,
              outcome: "refused" as const,
              ownership: "absent" as const,
              code: "CONFLICT" as const,
              message:
                "The Claude settings changed since the preview; re-run to inspect the updated plan.",
              diff: null,
              manifestRecord: null,
            },
          };
        }
      }
      const read = await readInstallManifest(manifestPath, runtime?.fs);
      const manifestBlocked = manifestReadRefusal(read, file);
      if (manifestBlocked) return { hook: manifestBlocked };
      const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
      const hook = await editJsonEntry({
        file,
        allowedRoot,
        adapter: claudeHookAdapter(command),
        manifestRecord,
        pdbVersion,
        dryRun,
        adopt,
        runtime,
      });
      // Persist the ownership record so a later uninstall/rerun recognizes this entry as owned; a
      // persistence failure is an explicit partial outcome, never unconditional success.
      if (
        !dryRun &&
        (hook.outcome === "applied" ||
          hook.outcome === "adopted" ||
          hook.outcome === "committed-with-error") &&
        hook.manifestRecord
      ) {
        const wrote = await writeInstallManifestRecord(
          manifestPath,
          "claude",
          file,
          hook.manifestRecord,
          runtime,
        );
        return { hook: manifestWriteRefusal(wrote, "The Claude Stop hook", hook) };
      }
      return { hook };
    },
    dryRun,
  );
  if (guarded.status === "refused") return { hook: guarded.reason };
  return guarded.value;
}

/** Remove PDB's owned Claude Stop hook entry when it is owned; preserve unrelated hooks. */
export async function uninstallClaudeStopHook(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  /** True when the global scope's homeDir is an explicit CLAUDE_CONFIG_DIR. */
  claudeConfigDir?: boolean;
  /** The approved preview's hook-settings raw text, when an interactive preview was shown. */
  expectedHooksRaw?: string | null;
  runtime?: ManifestRuntime;
}): Promise<ClaudeHookResult> {
  const { scope, manifestPath, dryRun, claudeConfigDir, runtime } = params;
  const file = claudeSettingsPath(scope, claudeConfigDir);
  const allowedRoot = claudeSettingsRoot(scope);
  // Classification matches the claude-stop entry by command substring, so removal works regardless
  // of the package path; no resolution is needed to delete an owned (possibly broken) hook.
  const command = claudeStopCommand({ pdbPath: "" });
  const guarded = await withScopeLock(
    manifestPath,
    runtime,
    async () => {
      // Re-verify the hook settings against the approved preview under the lock, exactly as install
      // does: a concurrent hook/ownership edit after the preview must be refused, not removed over.
      if (!dryRun && params.expectedHooksRaw !== undefined) {
        const current = await readOptionalText(file, runtime?.fs);
        if (current !== params.expectedHooksRaw) {
          return {
            hook: {
              action: "kept" as const,
              outcome: "refused" as const,
              ownership: "absent" as const,
              code: "CONFLICT" as const,
              message:
                "The Claude settings changed since the preview; re-run to inspect the updated plan.",
              diff: null,
              manifestRecord: null,
            },
          };
        }
      }
      const read = await readInstallManifest(manifestPath, runtime?.fs);
      const manifestBlocked = manifestReadRefusal(read, file);
      if (manifestBlocked) return { hook: manifestBlocked };
      const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
      const hook = await removeJsonEntry({
        file,
        allowedRoot,
        adapter: claudeHookAdapter(command),
        manifestRecord,
        dryRun,
        runtime,
      });
      // A successful removal deletes the ownership record; a persistence failure is explicit.
      if (!dryRun && (hook.outcome === "applied" || hook.outcome === "committed-with-error")) {
        const wrote = await writeInstallManifestRecord(manifestPath, "claude", file, null, runtime);
        return { hook: manifestWriteRefusal(wrote, "The Claude Stop hook", hook) };
      }
      return { hook };
    },
    dryRun,
  );
  if (guarded.status === "refused") return { hook: guarded.reason };
  return guarded.value;
}
