/**
 * Claude Code Stop-hook registration (#771).
 *
 * Installs or removes only PDB's owned Stop entry in the target Claude settings
 * document (project `.claude/settings.local.json` or user `~/.claude/settings.json`),
 * invoking the packaged `pdb rebrief claude-stop --installed` adapter. Claude Code
 * registers hooks under a `hooks` object; each event (Stop, SessionStart) holds a flat
 * array of command entries (verified in claude-code-stop-hooks.md). Only the owned
 * command entry is created/replaced or removed; unrelated events, hooks and keys are
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
  type InstallScope,
  type JsonEntryAdapter,
  type ManifestRuntime,
} from "./manifest.js";

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
  if (outcome.status === "written" || outcome.status === "committed-with-error") return hook;
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

/** The hook event PDB registers for: the synchronous Claude Code Stop event. */
export const claudeStopHookEvent = "Stop";

/** Native hook timeout in seconds (native default 600; an explicit short bound per the shared core). */
export const claudeHookNativeTimeout = 10;

/** The installed adapter deadline for `--installed` mode (must stay under the native timeout). */
export const claudeInstalledDeadlineMs = 4000;

/** The owned Stop entry PDB writes: one command entry under `hooks.Stop`. */
export function claudeStopEntry(command: string): unknown[] {
  return [
    {
      type: "command",
      command,
      timeout: claudeHookNativeTimeout,
    },
  ];
}

/** The installed command for the owned Stop entry (no paths or session in it). */
export function claudeStopCommand(options: {
  /** Pass `--role` for project scope only (identity resolution is runtime). */
  role?: string | null;
  /** Pass `--entry <key>` for project scope only. */
  entry?: string | null;
}): string {
  const args = [
    "rebrief",
    "claude-stop",
    "--installed",
    `--deadline-ms ${claudeInstalledDeadlineMs}`,
  ];
  if (options.role) args.push(`--role ${options.role}`);
  if (options.entry) args.push(`--entry ${options.entry}`);
  return `pdb ${args.join(" ")}`;
}

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
  // Only PDB-looking entries participate in ownership classification; unrelated command hooks
  // are preserved and never conflate the canonical text (a foreign/owned entry is the one that
  // invokes the PDB adapter).
  const pdbEntries = stop.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "command" &&
      typeof (entry as { command?: unknown }).command === "string" &&
      (entry as { command: string }).command.includes("claude-stop"),
  );
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
        return `${claudeStopHookEvent} must be a JSON array of command hooks.`;
      return null;
    },
    apply: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      const stopEntries = Array.isArray(existingHooks[claudeStopHookEvent])
        ? (existingHooks[claudeStopHookEvent] as unknown[]).filter(
            (entry) =>
              !(
                typeof entry === "object" &&
                entry !== null &&
                (entry as { type?: unknown }).type === "command" &&
                typeof (entry as { command?: unknown }).command === "string" &&
                (entry as { command: string }).command.includes("claude-stop")
              ),
          )
        : [];
      return {
        ...doc,
        hooks: {
          ...existingHooks,
          [claudeStopHookEvent]: [...stopEntries, ...claudeStopEntry(command)],
        },
      };
    },
    remove: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      const stopEntries = Array.isArray(existingHooks[claudeStopHookEvent])
        ? (existingHooks[claudeStopHookEvent] as unknown[]).filter(
            (entry) =>
              !(
                typeof entry === "object" &&
                entry !== null &&
                (entry as { type?: unknown }).type === "command" &&
                typeof (entry as { command?: unknown }).command === "string" &&
                (entry as { command: string }).command.includes("claude-stop")
              ),
          )
        : [];
      if (stopEntries.length === 0) {
        const nextHooks = { ...existingHooks };
        if (nextHooks[claudeStopHookEvent] && Array.isArray(nextHooks[claudeStopHookEvent]))
          delete nextHooks[claudeStopHookEvent];
        return { ...doc, hooks: nextHooks };
      }
      return { ...doc, hooks: { ...existingHooks, [claudeStopHookEvent]: stopEntries } };
    },
  };
}

/** Claude settings path within a project or user-wide scope (gitignored for project). */
const claudeSettingsPath = (scope: InstallScope): string =>
  scope.kind === "project"
    ? `${scope.root}/.claude/settings.local.json`
    : `${scope.homeDir}/.claude/settings.json`;
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
  runtime?: ManifestRuntime;
}): Promise<ClaudeHookResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime } = params;
  const file = claudeSettingsPath(scope);
  const allowedRoot = claudeSettingsRoot(scope);
  const command = claudeStopCommand(options);
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
}

/** Remove PDB's owned Claude Stop hook entry when it is owned; preserve unrelated hooks. */
export async function uninstallClaudeStopHook(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<ClaudeHookResult> {
  const { scope, manifestPath, dryRun, runtime } = params;
  const file = claudeSettingsPath(scope);
  const allowedRoot = claudeSettingsRoot(scope);
  const command = claudeStopCommand({});
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
}
