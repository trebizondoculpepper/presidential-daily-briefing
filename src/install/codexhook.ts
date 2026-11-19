/**
 * Codex `hooks.json` Stop-hook registration (#770).
 *
 * Installs or removes only PDB's owned Stop entry in the target hooks document
 * (project `.codex/hooks.json` or user `~/.codex/hooks.json`), invoking the
 * packaged `pdb rebrief codex-stop --installed` adapter. Codex hooks.json nests
 * each event under a top-level `hooks` object; `Stop` holds an array of hook
 * groups, each with a `hooks` list of command entries (verified in
 * codex-stop-hooks.md). Only the owned command entry is created/replaced or
 * removed; unrelated events, groups and keys are preserved exactly, and an
 * edited or foreign entry is refused, mirroring the MCP entry rules.
 *
 * The installed command carries no paths or session: `pdb rebrief codex-stop
 * --installed`, plus `--role R` and `--entry <key>` for project scope, with
 * native `timeout` 5 and the adapter's installed `--deadline-ms 4000` default
 * (codex-installer.md "Hook definition", attended-installer-delivery.md). No
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
import { refusal, withManifestWrite, withScopeLock } from "./codexmcp.js";

/** The hook event PDB registers for: the synchronous Codex Stop event. */
export const codexStopHookEvent = "Stop";

/** Native hook timeout in seconds: must exceed the adapter's 4 s installed deadline. */
export const codexHookNativeTimeout = 5;

/** The installed adapter deadline for `--installed` mode (codex-installer.md). */
export const codexInstalledDeadlineMs = 4000;

/** The exact `Stop` array PDB writes: one owned group holding one command entry. */
export function codexStopGroup(command: string): unknown[] {
  return [
    {
      hooks: [
        {
          type: "command",
          command,
          timeout: codexHookNativeTimeout,
        },
      ],
    },
  ];
}

/** The installed command for the owned Stop entry (no paths or session in it). */
export function codexStopCommand(options: {
  /** Pass `--role` for project scope only (identity resolution is runtime). */
  role?: string | null;
  /** Pass `--entry <key>` for project scope only. */
  entry?: string | null;
}): string {
  const args = [
    "rebrief",
    "codex-stop",
    "--installed",
    `--deadline-ms ${codexInstalledDeadlineMs}`,
  ];
  if (options.role) args.push(`--role ${options.role}`);
  if (options.entry) args.push(`--entry ${options.entry}`);
  return `pdb ${args.join(" ")}`;
}

/** Extract the owned hook entries text for classification, and whether it looks foreign. */
export function inspectCodexStopEntry(doc: Record<string, unknown>): {
  canonicalText: string | null;
  looksForeign: boolean;
} {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return { canonicalText: null, looksForeign: false };
  }
  const stop = (hooks as Record<string, unknown>)[codexStopHookEvent];
  if (!Array.isArray(stop)) return { canonicalText: null, looksForeign: false };
  const commandEntries: unknown[] = [];
  let pdbLookalike = false;
  for (const group of stop) {
    if (!group || typeof group !== "object") continue;
    const commands = (group as { hooks?: unknown[] }).hooks;
    if (!Array.isArray(commands)) continue;
    for (const entry of commands) {
      if (!entry || typeof entry !== "object") continue;
      const { type, command } = entry as { type?: unknown; command?: unknown };
      if (type === "command" && typeof command === "string") {
        commandEntries.push(entry);
        if (command.includes("codex-stop")) pdbLookalike = true;
      }
    }
  }
  if (commandEntries.length === 0) return { canonicalText: null, looksForeign: false };
  return {
    canonicalText: JSON.stringify(commandEntries),
    // A command invoking codex-stop without a manifest record is PDB-foreign and must be adopted,
    // never overwritten (codex-installer.md "Ownership and replacement"); unrelated hooks are
    // absent with respect to PDB and are preserved alongside the owned entry.
    looksForeign: pdbLookalike,
  };
}

/** The JSON-entry adapter for the owned Codex Stop command entry. */
export function codexHookAdapter(command: string): JsonEntryAdapter {
  return {
    kind: "hook",
    inspect: (doc) => inspectCodexStopEntry(doc),
    desiredCanonicalText: () => JSON.stringify([{ type: "command", command, timeout: 5 }]),
    validateSchema: (doc) => {
      if (!("hooks" in doc)) return null;
      if (typeof doc.hooks !== "object" || doc.hooks === null || Array.isArray(doc.hooks))
        return "hooks must be a JSON object.";
      return null;
    },
    apply: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      // Replace any owned codex-stop command entries and preserve unrelated hooks groups.
      const stopGroups = Array.isArray(existingHooks[codexStopHookEvent])
        ? (existingHooks[codexStopHookEvent] as unknown[]).filter((group) => {
            const commands = (group as { hooks?: unknown[] } | null)?.hooks;
            if (!Array.isArray(commands)) return true;
            return !commands.some(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                (entry as { type?: unknown }).type === "command" &&
                typeof (entry as { command?: unknown }).command === "string" &&
                (entry as { command: string }).command.includes("codex-stop"),
            );
          })
        : [];
      return {
        ...doc,
        hooks: {
          ...existingHooks,
          [codexStopHookEvent]: [...stopGroups, ...codexStopGroup(command)],
        },
      };
    },
    remove: (doc) => {
      const existingHooks =
        doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
          ? (doc.hooks as Record<string, unknown>)
          : {};
      const stopGroups = Array.isArray(existingHooks[codexStopHookEvent])
        ? (existingHooks[codexStopHookEvent] as unknown[]).filter((group) => {
            const commands = (group as { hooks?: unknown[] } | null)?.hooks;
            if (!Array.isArray(commands)) return true;
            return !commands.some(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                (entry as { type?: unknown }).type === "command" &&
                typeof (entry as { command?: unknown }).command === "string" &&
                (entry as { command: string }).command.includes("codex-stop"),
            );
          })
        : [];
      if (stopGroups.length === 0) {
        const next = { ...existingHooks };
        if (next[codexStopHookEvent] && Array.isArray(next[codexStopHookEvent]))
          delete next[codexStopHookEvent];
        const hooks = Object.keys(next).length === 0 ? undefined : next;
        return hooks ? { ...doc, hooks } : { ...doc, hooks };
      }
      return { ...doc, hooks: { ...existingHooks, [codexStopHookEvent]: stopGroups } };
    },
  };
}

/** Codex `hooks.json` path within a project or user-wide scope. */
const codexHooksPath = (scope: InstallScope): string =>
  scope.kind === "project" ? `${scope.root}/.codex/hooks.json` : `${scope.homeDir}/hooks.json`;
/** The root files are allowed to be written under (project root or user home). */
const codexHooksRoot = (scope: InstallScope): string =>
  scope.kind === "project" ? scope.root : scope.homeDir;

export interface CodexStopHookOptions {
  /** `--role` for project scope, matching the MCP registration. */
  role?: string | null;
  /** `--entry <key>` for project scope, matching the MCP registration. */
  entry?: string | null;
}

export interface CodexHookResult {
  hook: InstallEditResult;
}

/** Install (or keep/replace) the owned Codex Stop hook entry in the scope's `hooks.json`. */
export async function installCodexStopHook(params: {
  scope: InstallScope;
  options: CodexStopHookOptions;
  manifestPath: string;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  runtime?: ManifestRuntime;
}): Promise<CodexHookResult> {
  const { scope, options, manifestPath, pdbVersion, dryRun, adopt, runtime } = params;
  const file = codexHooksPath(scope);
  const allowedRoot = codexHooksRoot(scope);
  const command = codexStopCommand(options);
  const guarded = await withScopeLock(manifestPath, runtime, async () => {
    const read = await readInstallManifest(manifestPath, runtime?.fs);
    if (read.status === "error")
      return {
        hook: refusal(
          "MALFORMED_MANIFEST",
          "The private install manifest could not be read; refusing to edit without a trusted ownership record.",
        ),
      };
    const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
    const hook = await editJsonEntry({
      file,
      allowedRoot,
      adapter: codexHookAdapter(command),
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
        "codex",
        file,
        hook.manifestRecord,
        runtime,
      );
      return { hook: withManifestWrite(wrote, hook, "The Codex Stop hook") };
    }
    return { hook };
  });
  if (guarded.status === "refused") return { hook: guarded.reason };
  return guarded.value;
}

/** Remove PDB's owned Codex Stop hook entry when it is owned; preserve unrelated hooks. */
export async function uninstallCodexStopHook(params: {
  scope: InstallScope;
  manifestPath: string;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<CodexHookResult> {
  const { scope, manifestPath, dryRun, runtime } = params;
  const file = codexHooksPath(scope);
  const allowedRoot = codexHooksRoot(scope);
  const command = codexStopCommand({});
  const guarded = await withScopeLock(manifestPath, runtime, async () => {
    const read = await readInstallManifest(manifestPath, runtime?.fs);
    if (read.status === "error")
      return {
        hook: refusal(
          "MALFORMED_MANIFEST",
          "The private install manifest could not be read; refusing to remove without a trusted ownership record.",
        ),
      };
    const manifestRecord = read.status === "ok" ? read.manifest.records[file] : undefined;
    const hook = await removeJsonEntry({
      file,
      allowedRoot,
      adapter: codexHookAdapter(command),
      manifestRecord,
      dryRun,
      runtime,
    });
    // A successful removal deletes the ownership record; a persistence failure is explicit.
    if (!dryRun && (hook.outcome === "applied" || hook.outcome === "committed-with-error")) {
      const wrote = await writeInstallManifestRecord(manifestPath, "codex", file, null, runtime);
      return { hook: withManifestWrite(wrote, hook, "The Codex Stop hook") };
    }
    return { hook };
  });
  if (guarded.status === "refused") return { hook: guarded.reason };
  return guarded.value;
}
