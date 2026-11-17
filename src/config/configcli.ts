/**
 * `config get|set|list|help` (#117, doc/design/repository-configuration.md).
 *
 * Thin command layer over the configuration service in config.ts: this module parses
 * arguments, converts command-line text into typed values and renders text/JSON results.
 * Validation, defaults, migration, conflict detection, atomic writes and repository-target
 * verification all stay in the service.
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  CONVERT_COMMAND,
  ConfigError,
  convertConfig,
  LEGACY_CONFIG_PATH,
  TOML_CONFIG_PATH,
  DEFAULT_SCHEMA,
  loadConfig,
  retiredKeyNotices,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
  filesystemRefusal,
  updateConfig,
  validateValue,
} from "./config.js";
import {
  IDENTITY_FILE,
  LEGACY_IDENTITY_FILE,
  IDENTITY_KEYS,
  identityValue,
  isIdentityKey,
  readIdentity,
  resolveIdentityTarget,
  setIdentity,
  TRIAGE_ROLES,
  validateEntryKey,
  validateIdentityValue,
} from "./identity.js";
import { resolveEntry, SUPPORTED_HARNESSES, validateHarness } from "./harness.js";
import type { EntryResolution, Environment } from "./harness.js";
import type { IdentityKey, IdentityRecord } from "./identity.js";
import {
  GLOBAL_KEYS,
  GLOBAL_CONFIG_FILE,
  GlobalConfigError,
  globalConfigDirectory,
  loadGlobalConfig,
  validateGlobalValue,
  writeGlobalConfig,
  type EffectiveGlobalSetting,
  type GlobalValue,
} from "./globalconfig.js";
import type {
  ConfigFormat,
  LoadedConfig,
  ConfigErrorCode,
  ConfigFileSystem,
  ConfigKey,
  ConfigValue,
  EffectiveSetting,
  GitRunner,
} from "./config.js";

/** Injected boundaries; tests replace all three so the real checkout is never touched. */
export interface ConfigRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  /** Random source for generated agent names (identity initializer). */
  readonly random?: () => number;
  /** Environment for harness detection (#38); tests always inject one. */
  readonly env?: Environment;
}

export const configUsage = `Usage: pdb config get KEY [--scope repository|global] [--entry KEY | --harness NAME] [--json] [--repo owner/name]
       pdb config set KEY VALUE [--scope repository|global] [--entry KEY | --harness NAME] [--json] [--repo owner/name]
       pdb config list [--scope repository|global] [--entry KEY | --harness NAME] [--json] [--repo owner/name]
       pdb config convert [--prefer toml|json] [--json] [--repo owner/name]
       pdb config help [KEY] [--json]
identity.* keys use the [agents.KEY] entry of the root pdb.toml selected by --entry KEY,
else by --harness ${SUPPORTED_HARNESSES.join("|")}, else by the detected harness.
The global scope (--scope global) reads/writes the per-OS-user ${GLOBAL_CONFIG_FILE} and
rejects identity keys and convert.`;

type Parsed =
  | { command: "help"; key?: string; json: boolean }
  | ({ command: "get"; key: string; json: boolean; repo?: string; scope: ConfigScope } & Selection)
  | ({
      command: "set";
      key: string;
      value: string;
      json: boolean;
      repo?: string;
      scope: ConfigScope;
    } & Selection)
  | ({ command: "list"; json: boolean; repo?: string; scope: ConfigScope } & Selection)
  | { command: "convert"; json: boolean; repo?: string; prefer?: ConfigFormat };

/** The supported configuration scopes (#804): repository (implicit) and global (per-user). */
export type ConfigScope = "repository" | "global";

/** Explicit entry selection; both absent means harness detection decides. */
interface Selection {
  entry?: string;
  harness?: string;
}

type ErrorCode = ConfigErrorCode | "usage" | "unsupported-scope";

/** A refusal before the service is reached: bad syntax or a non-repository scope. */
class ConfigUsageError extends Error {
  readonly code: ErrorCode;
  readonly recovery: string;
  constructor(code: ErrorCode, message: string, recovery = configUsage) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}

const scopeRecovery = `Repository scope is the implicit default; global settings use --scope global (per-OS-user config, see doc/design/configuration-service.md).\n${configUsage}`;

/** Parse `config ...` arguments (after the word `config`). Throws ConfigUsageError. */
export function configArgumentsFor(args: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        entry: { type: "string" },
        harness: { type: "string" },
        prefer: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        scope: { type: "string" },
        global: { type: "boolean" },
        system: { type: "boolean" },
        machine: { type: "boolean" },
        user: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new ConfigUsageError("usage", (error as Error).message);
  }
  const { values, positionals } = parsed;
  const json = !!values.json;
  const other = (["global", "system", "machine", "user"] as const).find((flag) => values[flag]);
  if (other) {
    throw new ConfigUsageError(
      "unsupported-scope",
      `Unsupported configuration scope "${other}"; use --scope global or --scope repository.`,
      scopeRecovery,
    );
  }
  const scope: ConfigScope = values.scope === "global" ? "global" : "repository";
  if (values.scope !== undefined && values.scope !== "repository" && values.scope !== "global")
    throw new ConfigUsageError(
      "unsupported-scope",
      `Unsupported configuration scope "${values.scope}"; use --scope global or --scope repository.`,
      scopeRecovery,
    );
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
    throw new ConfigUsageError("usage", "--repo must be owner/name.");
  }
  const [command, ...operands] = positionals;
  if (values.help || command === undefined || command === "help") {
    const key = command === "help" ? operands[0] : undefined;
    if (
      operands.length > (command === "help" ? 1 : 0) ||
      values.repo !== undefined ||
      values.entry !== undefined ||
      values.harness !== undefined ||
      scope === "global"
    )
      throw new ConfigUsageError(
        "usage",
        "config help takes at most one KEY and no --repo/--entry/--harness/--scope.",
      );
    return { command: "help", key, json };
  }
  const { repo, entry, harness, prefer } = values;
  if (prefer !== undefined && command !== "convert")
    throw new ConfigUsageError("usage", "--prefer applies only to config convert.");
  if (command === "convert") {
    if (operands.length !== 0 || entry !== undefined || harness !== undefined || scope === "global")
      throw new ConfigUsageError(
        "usage",
        scope === "global"
          ? "config convert is a repository operation; there is no global file to convert."
          : "config convert takes no KEY and no --entry/--harness.",
      );
    if (prefer !== undefined && prefer !== "toml" && prefer !== "json")
      throw new ConfigUsageError("usage", "--prefer must be toml or json.");
    return { command, json, repo, prefer };
  }
  if (entry !== undefined && harness !== undefined)
    throw new ConfigUsageError("usage", "Pass either --entry or --harness, not both.");
  if (
    (command === "get" || command === "set") &&
    (entry !== undefined || harness !== undefined) &&
    !isIdentityKey(operands[0] ?? "")
  )
    throw new ConfigUsageError("usage", "--entry and --harness apply only to identity.* keys.");
  if (scope === "global" && (entry !== undefined || harness !== undefined))
    throw new ConfigUsageError(
      "usage",
      "--entry and --harness do not apply to the global scope.",
      `${configUsage}`,
    );
  if (command === "get" && operands.length === 1)
    return { command, key: operands[0]!, json, repo, scope, entry, harness };
  if (command === "set" && operands.length === 2)
    return { command, key: operands[0]!, value: operands[1]!, json, repo, scope, entry, harness };
  if (command === "list" && operands.length === 0)
    return { command, json, repo, scope, entry, harness };
  throw new ConfigUsageError(
    "usage",
    ["get", "set", "list"].includes(command)
      ? `Wrong number of arguments for config ${command}.`
      : `Unknown config command "${command}".`,
  );
}

const keyEntry = (key: string): ConfigKey => {
  const entry = DEFAULT_SCHEMA.keys.find((candidate) => candidate.key === key);
  // Unknown keys are refused by the service, with its own list of supported keys.
  if (!entry) validateValue(DEFAULT_SCHEMA, key, undefined);
  return entry!;
};

const valueSyntax = (entry: ConfigKey): string =>
  entry.type === "boolean" ? "true|false" : "VALUE";

/** Convert command-line text into the key's typed value; the service validates the result. */
function typedValue(entry: ConfigKey, text: string): ConfigValue {
  if (entry.type !== "boolean") return text;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new ConfigUsageError(
    "invalid-value",
    `Invalid value for "${entry.key}": expected true or false, got ${JSON.stringify(text)}.`,
    `pdb config set ${entry.key} ${valueSyntax(entry)}`,
  );
}

const display = (value: ConfigValue): string => (value === null ? "(unset)" : String(value));

const settingJson = (setting: EffectiveSetting) => {
  const entry = keyEntry(setting.key);
  return { ...setting, type: entry.type, defaultValue: entry.defaultValue };
};

const settingText = (setting: EffectiveSetting): string =>
  `${setting.key} = ${display(setting.value)} (${setting.source})`;

const identityKeyEntry = (key: string): IdentityKey => {
  const entry = IDENTITY_KEYS.find((candidate) => candidate.key === key);
  if (!entry) validateIdentityValue(key, "");
  return entry!;
};

const identityHelp = (entry: IdentityKey) => ({
  key: entry.key,
  scope: "agent" as const,
  path: IDENTITY_FILE,
  type: "string" as const,
  validValues: entry.validValues,
  description: entry.description,
  set: `pdb config set ${entry.key} ${entry.validValues === "agent name" ? "NAME" : entry.validValues.join("|")} --entry KEY`,
});

function helpResult(key: string | undefined) {
  const identity = key ? (isIdentityKey(key) ? [identityKeyEntry(key)] : []) : IDENTITY_KEYS;
  const keys = key ? (isIdentityKey(key) ? [] : [keyEntry(key)]) : DEFAULT_SCHEMA.keys;
  return {
    schemaVersion: 1,
    kind: "config-help",
    scope: "repository",
    path: TOML_CONFIG_PATH,
    // Additive (#160): the earlier JSON store, read until converted, and the conversion command.
    legacyPath: LEGACY_CONFIG_PATH,
    convert: CONVERT_COMMAND,
    usage: configUsage,
    keys: keys.map((entry) => ({
      key: entry.key,
      type: entry.type,
      nullable: entry.nullable,
      defaultValue: entry.defaultValue,
      validValues: entry.type === "boolean" ? [true, false] : "non-empty text",
      description: entry.description,
      set: `pdb config set ${entry.key} ${valueSyntax(entry)}`,
    })),
    identityKeys: identity.map(identityHelp),
  };
}

function helpText(result: ReturnType<typeof helpResult>): string {
  const keys = result.keys
    .map(
      (entry) =>
        `  ${entry.key} (${entry.type}; default ${display(entry.defaultValue)}; valid: ${entry.type === "boolean" ? "true, false" : "non-empty text"})\n    ${entry.description}\n    Set: ${entry.set}`,
    )
    .join("\n");
  const identity = result.identityKeys
    .map(
      (entry) =>
        `  ${entry.key} (valid: ${entry.validValues === "agent name" ? "an agent name" : entry.validValues.join(", ")})\n    ${entry.description}\n    Set: ${entry.set}`,
    )
    .join("\n");
  return `${result.usage}
Repository settings stored in ${TOML_CONFIG_PATH} of the current checkout (repository scope only;
global/machine scopes are not supported). Use these commands rather than editing the file:
values are validated, older schemas migrated and concurrent edits refused. Changes are not
committed; review and commit the file with Git. get/list never modify or convert the file.
An earlier ${LEGACY_CONFIG_PATH} is still read, and set in place, until you run
${CONVERT_COMMAND}: it writes and verifies ${TOML_CONFIG_PATH}, then removes the JSON
file. Both files present is refused; convert removes a JSON file the TOML file agrees with,
and --prefer toml|json chooses which file's settings to keep when they disagree.
Keys:
${keys}
Per-agent identity keys, stored in the [agents.KEY] table selected by --entry KEY in
${IDENTITY_FILE} at the Git working-tree root (local, Git-ignored, never committed). Writes
preserve other agents and unknown values but normalise formatting and drop comments.
get/list never create the file. Until an entry is in ${IDENTITY_FILE}, get/list show a
matching legacy ${LEGACY_IDENTITY_FILE} entry as legacy-not-imported. Setting an identity key
on a missing entry imports that legacy entry's name and valid triage_role once (the legacy
file is never changed); otherwise setting identity.triage_role generates a name once:
${identity}
Exit: 0 success (including an unchanged set); 1 invalid arguments, unsupported scope,
unknown key, invalid value, unreadable file, write conflict, both settings files present,
incomplete conversion or wrong repository.
`;
}

/** Run a config subcommand. Returns the exit code; output is either text or one JSON value. */
export async function runConfig(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: ConfigRuntime = {},
): Promise<number> {
  const json = args.includes("--json");
  try {
    const parsed = configArgumentsFor(args);
    if (parsed.command === "help") {
      const result = helpResult(parsed.key);
      await output(parsed.json ? JSON.stringify(result, null, 2) + "\n" : helpText(result));
      return 0;
    }
    const fs = runtime.fs ?? nodeFileSystem;
    if (parsed.command !== "convert" && parsed.scope === "global") {
      if ((parsed.command === "get" || parsed.command === "set") && isIdentityKey(parsed.key))
        throw new ConfigUsageError(
          "invalid-value",
          "Global configuration does not hold identity keys.",
          `Identity keys use the [agents.KEY] entry selected by --entry KEY: pdb config ${parsed.command} ${parsed.key} --entry KEY.`,
        );
      await output(await runGlobal(parsed, runtime));
      return 0;
    }
    if ((parsed.command === "get" || parsed.command === "set") && isIdentityKey(parsed.key)) {
      await output(await runIdentity(parsed, runtime));
      return 0;
    }
    // Reads verify the target too: a remote --repo never selects an unrelated checkout.
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      parsed.repo,
      runtime.git ?? nodeGit,
    );
    const at = (config: LoadedConfig) => ({
      repository: target.repository,
      path: join(target.root, config.path),
      // Additive (#160): which store was read, and the conversion still to run for JSON.
      storage: storageJson(config),
    });
    if (parsed.command === "convert") {
      const converted = await convertConfig(target, { fs, prefer: parsed.prefer });
      const result = {
        schemaVersion: 1,
        kind: "config-convert",
        ...at(converted.config),
        status: converted.status,
        wroteToml: converted.wroteToml,
        removedJson: converted.removedJson,
        droppedRetired: converted.droppedRetired,
        settings: converted.config.settings.map(settingJson),
      };
      await output(parsed.json ? JSON.stringify(result, null, 2) + "\n" : convertText(result));
      return 0;
    }
    if (parsed.command === "get") {
      const config = await loadConfig(target.root, fs);
      const setting = settingFor(config, parsed.key);
      const where = at(config);
      const result = { schemaVersion: 1, kind: "config-get", ...where, ...settingJson(setting) };
      await output(
        parsed.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `${settingText(setting)}\n${legacyNotice(config)}`,
      );
      return 0;
    }
    if (parsed.command === "list") {
      const config = await loadConfig(target.root, fs);
      const where = at(config);
      const identity = await identityListing(parsed, target.root, fs, runtime);
      const result = {
        schemaVersion: 1,
        kind: "config-list",
        ...where,
        storedVersion: config.storedVersion,
        settings: config.settings.map(settingJson),
        // Additive (#153): ignored retired keys, each with the command that removes it.
        retired: retiredKeyNotices(config),
        identity,
      };
      await output(
        parsed.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `Configuration for ${target.repository} (${where.path}${config.storedVersion === null ? ", not present: all defaults" : ""}):\n${config.settings.map((s) => `  ${settingText(s)}`).join("\n")}\n${result.retired.map((r) => `  Ignored: ${r.detail} Next: ${r.next}\n`).join("")}${legacyNotice(config)}${identityListText(identity)}`,
      );
      return 0;
    }
    const entry = keyEntry(parsed.key);
    const write = await updateConfig(
      target,
      new Map([[entry.key, typedValue(entry, parsed.value)]]),
      { fs },
    );
    const setting = settingFor(write.config, entry.key);
    const where = at(write.config);
    const result = {
      schemaVersion: 1,
      kind: "config-set",
      ...where,
      changed: write.changed,
      ...settingJson(setting),
    };
    await output(
      parsed.json
        ? JSON.stringify(result, null, 2) + "\n"
        : `${settingText(setting)} — ${write.changed ? `written to ${where.path} (not committed)` : "unchanged"}\n${legacyNotice(write.config)}`,
    );
    return 0;
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError || error instanceof ConfigUsageError)) throw error;
    if (!json) throw new Error(`${error.message}\n${error.recovery}`, { cause: error });
    await output(
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "config-error",
          code: error.code,
          message: error.message,
          recovery: error.recovery,
        },
        null,
        2,
      ) + "\n",
    );
    return 1;
  }
}

/** Which store a result came from; `next` is the conversion command while JSON is in use. */
const storageJson = (config: LoadedConfig) => ({
  format: config.format,
  path: config.path,
  legacy: config.format === "json",
  next: config.format === "json" ? CONVERT_COMMAND : null,
});

const legacyNotice = (config: LoadedConfig): string =>
  config.format === "json"
    ? `  Note: ${LEGACY_CONFIG_PATH} is the earlier JSON format; convert it to ${TOML_CONFIG_PATH} with: ${CONVERT_COMMAND}\n`
    : "";

const convertSummary: Record<string, string> = {
  "nothing-to-convert": `No ${LEGACY_CONFIG_PATH} or ${TOML_CONFIG_PATH}: nothing to convert; no file was created.`,
  "already-toml": `Already converted: settings are in ${TOML_CONFIG_PATH}; nothing was changed.`,
  converted: `Converted ${LEGACY_CONFIG_PATH} to ${TOML_CONFIG_PATH}, verified every setting, and removed ${LEGACY_CONFIG_PATH}.`,
  "removed-json": `Kept ${TOML_CONFIG_PATH} and removed ${LEGACY_CONFIG_PATH}.`,
  "replaced-toml": `Replaced ${TOML_CONFIG_PATH} with the settings from ${LEGACY_CONFIG_PATH}, verified them, and removed ${LEGACY_CONFIG_PATH}.`,
};

function convertText(result: {
  repository: string;
  status: string;
  wroteToml: boolean;
  removedJson: boolean;
  droppedRetired: readonly string[];
  settings: readonly EffectiveSetting[];
}): string {
  const lines = [
    `${result.repository}: ${convertSummary[result.status]}`,
    ...result.settings.map((s) => `  ${settingText(s)}`),
    ...result.droppedRetired.map((key) => `  Dropped retired key ${key} (ignored since #153).`),
  ];
  if (result.wroteToml || result.removedJson)
    lines.push(`Not committed: review and commit the change with Git.`);
  return `${lines.join("\n")}\n`;
}

const flags = (parsed: { repo?: string }, entry: string): string =>
  ` --entry ${entry}${parsed.repo ? ` --repo ${parsed.repo}` : ""}`;

type Unresolved = Extract<EntryResolution, { status: "unresolved" }>;

/** Exact explicit-selection commands for an unresolved entry (no shell comments). */
const selectionCommands = (
  command: string,
  parsed: { repo?: string },
  resolution: Unresolved,
): string[] =>
  resolution.candidates.length === 0 && resolution.create
    ? // #310: no entry for this harness exists; create one rather than select another's.
      [`${resolution.create}${parsed.repo ? ` --repo ${parsed.repo}` : ""}`]
    : (resolution.candidates.length > 0 ? resolution.candidates : ["KEY"]).map(
        (key) => `${command}${flags(parsed, key)}`,
      );

const unresolvedText = (resolution: Unresolved): string =>
  `${resolution.message}${resolution.signals.length ? ` Signals present: ${resolution.signals.join(", ")}.` : ""}`;

const unresolved = (command: string, parsed: { repo?: string }, resolution: Unresolved) =>
  new ConfigError(
    "identity-unresolved",
    unresolvedText(resolution),
    `${resolution.create && !resolution.candidates.length ? "Create this agent's own entry" : "Select the [agents.KEY] entry explicitly"}:\n${selectionCommands(command, parsed, resolution).join("\n")}`,
  );

/** The shared resolver over this runtime: explicit selection, then detection. */
const resolveFor = (parsed: Selection, root: string, runtime: ConfigRuntime) =>
  resolveEntry({
    entry: parsed.entry,
    harness: parsed.harness,
    env: runtime.env ?? process.env,
    root,
    fs: runtime.fs ?? nodeFileSystem,
  });

/** Non-secret account of what selected the entry: source, harness and signal names. */
const selectionJson = (resolution: Extract<EntryResolution, { status: "resolved" }>) => ({
  selection: resolution.source,
  harness: resolution.harness,
  signals: resolution.signals,
});

const selectionText = (selected: ReturnType<typeof selectionJson>): string =>
  selected.selection === "--entry"
    ? "selected by --entry"
    : selected.selection === "--harness"
      ? `selected by --harness ${selected.harness}`
      : `detected ${selected.harness} from ${selected.signals.join(", ")}`;

/** Read-only notice for a legacy identity: what it is and the one-time import command. */
const legacyNote = (record: IdentityRecord, entry: string): string =>
  `legacy-not-imported: read from ${record.path} because ${IDENTITY_FILE} has no [agents.${entry}] entry; nothing was imported. Import it once (that file is never changed): pdb config set identity.triage_role ${record.triageRole ?? "implementer|designer"} --entry ${entry}`;

const identitySetting = (record: IdentityRecord, key: string) => {
  const value = identityValue(record, key);
  return { key, value, source: value === null ? ("unset" as const) : ("explicit" as const) };
};

/** `config get|set identity.*`: routed to the selected [agents.KEY] table. */
async function runIdentity(
  parsed: Extract<Parsed, { command: "get" | "set" }>,
  runtime: ConfigRuntime,
): Promise<string> {
  const command =
    parsed.command === "get"
      ? `pdb config get ${parsed.key}`
      : `pdb config set ${parsed.key} ${parsed.value}`;
  // Validate the key (and value) first so an unknown key gets its own refusal.
  if (parsed.command === "set") validateIdentityValue(parsed.key, parsed.value);
  else identityKeyEntry(parsed.key);
  if (parsed.entry !== undefined) validateEntryKey(parsed.entry);
  const fs = runtime.fs ?? nodeFileSystem;
  // Project selection precedes entry lookup: only this checkout's root file is consulted.
  const target = await resolveIdentityTarget(
    runtime.cwd ?? process.cwd(),
    parsed.repo,
    runtime.git ?? nodeGit,
  );
  const resolution = await resolveFor(parsed, target.root, runtime);
  if (resolution.status === "unresolved") throw unresolved(command, parsed, resolution);
  const entry = resolution.entry;
  const where = {
    scope: "agent",
    repository: target.repository,
    path: IDENTITY_FILE,
    entry,
    ...selectionJson(resolution),
  };
  if (parsed.command === "get") {
    identityKeyEntry(parsed.key);
    const record = await readIdentity(target.root, entry, fs);
    const setting = identitySetting(record, parsed.key);
    const result = {
      schemaVersion: 1,
      kind: "config-get",
      ...where,
      // Additive (#319): the file the value came from and its store category.
      path: record.path,
      store: record.source,
      fileExists: record.fileExists,
      entryExists: record.entryExists,
      ...setting,
      problems: record.problems,
    };
    if (parsed.json) return JSON.stringify(result, null, 2) + "\n";
    const notes = [
      record.source === "legacy-not-imported" ? legacyNote(record, entry) : "",
      !record.fileExists ? `${IDENTITY_FILE} not present` : "",
      record.fileExists && !record.entryExists
        ? `no [agents.${entry}] entry in ${IDENTITY_FILE}`
        : "",
      ...record.problems,
    ].filter(Boolean);
    return `${parsed.key} = ${setting.value ?? "(unset)"} (${setting.source}; entry ${entry} in ${record.path}, ${selectionText(where)})${notes.length ? `\n  ${notes.join("\n  ")}\n  Set: ${record.entryExists ? `pdb config set ${parsed.key} ${parsed.key === "identity.name" ? "NAME" : "implementer|designer"}` : "pdb config set identity.triage_role implementer|designer"}${flags(parsed, entry)}` : ""}\n`;
  }
  const write = await setIdentity(target, entry, parsed.key, parsed.value, {
    fs,
    git: runtime.git ?? nodeGit,
    random: runtime.random,
  });
  const setting = identitySetting(write.record, parsed.key);
  const result = {
    schemaVersion: 1,
    kind: "config-set",
    ...where,
    changed: write.changed,
    createdFile: write.createdFile,
    createdEntry: write.createdEntry,
    generatedName: write.generatedName,
    importedFrom: write.importedFrom,
    legacyIgnored: write.legacyIgnored,
    legacyNamesUnchecked: write.legacyNamesUnchecked,
    excludeRuleAdded: write.excluded,
    ...(write.lockCleanup ? { lockCleanup: write.lockCleanup } : {}),
    ...setting,
  };
  if (parsed.json) return JSON.stringify(result, null, 2) + "\n";
  const extra = [
    write.generatedName ? `generated name ${write.generatedName} for new entry ${entry}` : "",
    write.importedFrom
      ? `imported the name${write.record.triageRole !== null && parsed.key !== "identity.triage_role" ? " and triage_role" : ""} of [agents.${entry}] from ${write.importedFrom} once (that file was not changed)`
      : "",
    write.legacyIgnored
      ? `ignored the legacy identity file (nothing imported; it was not changed): ${write.legacyIgnored}`
      : "",
    write.legacyNamesUnchecked && !write.legacyIgnored
      ? `could not check the name against agent-inbox.toml names: ${write.legacyNamesUnchecked}`
      : "",
    write.excluded ? `added /${IDENTITY_FILE} to this repository's local Git exclude file` : "",
    write.lockCleanup ?? "",
  ].filter(Boolean);
  return `${parsed.key} = ${setting.value} (entry ${entry}, ${selectionText(where)}) — ${write.changed ? `written to ${IDENTITY_FILE} (local, not committed)` : "unchanged"}${extra.map((line) => `\n  ${line}`).join("")}\n`;
}

/**
 * Parse command-line text for a global key into its typed value, before the service validates
 * it. Port parses as a decimal integer; ttl and projects are validated text (projects are not
 * settable from one CLI string; use `pdb config set serve.projects ...` with a JSON array).
 */
function parsedGlobalValue(kind: string, key: string, text: string): GlobalValue {
  if (kind === "port") {
    if (!/^\d{1,5}$/.test(text.trim()))
      throw new GlobalConfigError(
        "invalid-value",
        `Invalid value for "${key}": expected an integer 1-65535, got ${JSON.stringify(text)}.`,
        `pdb config set ${key} 1-65535 --scope global`,
      );
    return validateGlobalValue(key, Number(text.trim()));
  }
  if (kind === "projects") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GlobalConfigError(
        "invalid-value",
        `Invalid value for "${key}": expected a JSON array of projects, got ${JSON.stringify(text)}.`,
        `pdb config set ${key} '[{"repository":"owner/name"}]' --scope global`,
      );
    }
    return validateGlobalValue(key, parsed);
  }
  return validateGlobalValue(key, text);
}

/**
 * `config get|set|list --scope global` (#804): the per-OS-user global configuration service.
 * Reads are read-only (no file created); set validates first and writes atomically under a
 * lock. Identity keys, --entry/--harness and convert do not apply to the global scope.
 */
async function runGlobal(
  parsed: Extract<Parsed, { command: "get" | "set" | "list" }>,
  runtime: ConfigRuntime,
): Promise<string> {
  const fs = runtime.fs ?? nodeFileSystem;
  const dir = globalConfigDirectory(runtime.env ?? process.env);
  const on = (config: Awaited<ReturnType<typeof loadGlobalConfig>>) => ({
    scope: "global",
    path: config.path,
    storedVersion: config.storedVersion,
  });
  const display = (value: GlobalValue): string =>
    Array.isArray(value) ? JSON.stringify(value) : String(value);
  const settingJson = (setting: EffectiveGlobalSetting) => {
    const entry = GLOBAL_KEYS.find((k) => k.key === setting.key)!;
    return { ...setting, valueKind: entry.kind, defaultValue: display(entry.defaultValue) };
  };
  const text = (settings: readonly EffectiveGlobalSetting[]): string =>
    settings.map((s) => `${s.key} = ${display(s.value)} (${s.source})`).join("\n");
  if (parsed.command === "get") {
    const config = await loadGlobalConfig(dir, fs);
    const setting = config.settings.find((s) => s.key === parsed.key);
    if (!setting)
      throw new GlobalConfigError(
        "unknown-key",
        `Unknown global configuration key "${parsed.key}".`,
        `Supported keys: ${GLOBAL_KEYS.map((k) => k.key).join(", ")}.`,
      );
    const result = {
      schemaVersion: 1,
      kind: "config-get",
      ...on(config),
      ...settingJson(setting),
    };
    return parsed.json
      ? JSON.stringify(result, null, 2) + "\n"
      : `${setting.key} = ${display(setting.value)} (${setting.source}; global)\n`;
  }
  if (parsed.command === "list") {
    // A long-lived consumer's baseline is the snapshot at listing time; changes are reported
    // against that in-memory snapshot on demand (doc/design/configuration-service.md).
    const config = await loadGlobalConfig(dir, fs);
    const result = {
      schemaVersion: 1,
      kind: "config-list",
      ...on(config),
      settings: config.settings.map(settingJson),
    };
    return parsed.json
      ? JSON.stringify(result, null, 2) + "\n"
      : `Global configuration (${config.path}${config.storedVersion === null ? ", not present: all defaults" : ""}):\n${text(config.settings)}\n`;
  }
  const entry = GLOBAL_KEYS.find((k) => k.key === parsed.key);
  if (!entry)
    throw new GlobalConfigError(
      "unknown-key",
      `Unknown global configuration key "${parsed.key}".`,
      `Supported keys: ${GLOBAL_KEYS.map((k) => k.key).join(", ")}.`,
    );
  const value = parsedGlobalValue(entry.kind, parsed.key, parsed.value);
  const write = await writeGlobalConfig(dir, new Map([[parsed.key, value]]), { fs });
  const setting = write.config.settings.find((s) => s.key === parsed.key)!;
  const result = {
    schemaVersion: 1,
    kind: "config-set",
    ...on(write.config),
    changed: write.changed,
    ...settingJson(setting),
  };
  return parsed.json
    ? JSON.stringify(result, null, 2) + "\n"
    : `${setting.key} = ${display(setting.value)} — ${write.changed ? `written to ${write.config.path} (global, not committed)` : "unchanged"}\n`;
}

/** Identity section of `config list`: only registered values of the selected entry. */
async function identityListing(
  parsed: { repo?: string } & Selection,
  root: string,
  fs: ConfigFileSystem,
  runtime: ConfigRuntime,
) {
  // Invalid selection syntax is a usage error for the whole command; anything else (malformed
  // or unreadable identity file) stays local to the identity section whatever the source.
  if (parsed.entry !== undefined) validateEntryKey(parsed.entry);
  if (parsed.harness !== undefined) validateHarness(parsed.harness);
  let resolution: EntryResolution;
  try {
    resolution = await resolveFor(parsed, root, runtime);
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    return {
      resolved: false as const,
      path: IDENTITY_FILE,
      error: { code: error.code, message: error.message, recovery: error.recovery },
    };
  }
  if (resolution.status === "unresolved") {
    return {
      resolved: false as const,
      path: IDENTITY_FILE,
      reason: resolution.reason,
      message: unresolvedText(resolution),
      recovery: selectionCommands("pdb config list", parsed, resolution).join("\n"),
    };
  }
  const entry = resolution.entry;
  try {
    const record = await readIdentity(root, entry, fs);
    return {
      resolved: true as const,
      path: record.path,
      entry,
      ...selectionJson(resolution),
      store: record.source,
      fileExists: record.fileExists,
      entryExists: record.entryExists,
      settings: IDENTITY_KEYS.map((key) => identitySetting(record, key.key)),
      problems: record.problems,
    };
  } catch (caught) {
    // Unreadable identity (malformed TOML or an expected filesystem failure such as EACCES)
    // never breaks the repository listing; programming errors still propagate.
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    return {
      resolved: false as const,
      path: IDENTITY_FILE,
      entry,
      error: { code: error.code, message: error.message, recovery: error.recovery },
    };
  }
}

function identityListText(identity: Awaited<ReturnType<typeof identityListing>>): string {
  if (!identity.resolved) {
    return "error" in identity && identity.error
      ? `Agent identity (${IDENTITY_FILE}${"entry" in identity ? `, entry ${identity.entry}` : ""}): ${identity.error.message}\n  ${identity.error.recovery}\n`
      : `Agent identity: no entry selected. ${"message" in identity ? identity.message : ""}\n  Select one explicitly:\n${("recovery" in
        identity
          ? identity.recovery
          : ""
        )
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n`;
  }
  return `Agent identity (entry ${identity.entry} in ${identity.path}${identity.store === "legacy-not-imported" ? ", legacy-not-imported" : identity.fileExists ? "" : ", not present"}; ${selectionText(identity)}):\n${identity.settings.map((s) => `  ${s.key} = ${s.value ?? "(unset)"} (${s.source})`).join("\n")}\n${identity.problems.map((p) => `  ${p}\n`).join("")}`;
}

export const setupUsage =
  "Usage: pdb setup identity --role implementer|designer [--entry KEY | --harness NAME] [--dry-run] [--json] [--repo owner/name]";

/**
 * `pdb setup identity` (#314, doc/design/identity.md "setup identity"): the one documented way
 * for a new agent to obtain its own persistent identity. It resolves the project and logical
 * entry through the shared resolver, then initializes through the same locked writer as
 * `config set identity.triage_role`: a missing entry gets a locally unique generated name once
 * (or imports a matching legacy entry once), a rerun keeps the existing name, and another
 * harness's entry is never borrowed. Local only: no service is contacted and nothing is
 * reserved. `--dry-run` writes nothing.
 */
export async function runSetup(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: ConfigRuntime = {},
): Promise<number> {
  const json = args.includes("--json");
  try {
    let values: {
      role?: string;
      entry?: string;
      harness?: string;
      repo?: string;
      json?: boolean;
      "dry-run"?: boolean;
    };
    let positionals: string[];
    try {
      ({ values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          role: { type: "string" },
          entry: { type: "string" },
          harness: { type: "string" },
          repo: { type: "string" },
          json: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
      }));
    } catch (caught) {
      throw new ConfigUsageError("usage", (caught as Error).message, setupUsage);
    }
    if (positionals.length !== 1 || positionals[0] !== "identity")
      throw new ConfigUsageError("usage", "pdb setup takes one subject: identity.", setupUsage);
    const role = values.role;
    if (!role || !(TRIAGE_ROLES as readonly string[]).includes(role))
      throw new ConfigUsageError(
        "usage",
        `--role is required: one of ${TRIAGE_ROLES.join(", ")}.`,
        setupUsage,
      );
    if (values.entry !== undefined && values.harness !== undefined)
      throw new ConfigUsageError("usage", "Use --entry or --harness, not both.", setupUsage);
    if (values.entry !== undefined) validateEntryKey(values.entry);
    if (values.harness !== undefined) validateHarness(values.harness);
    if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new ConfigUsageError("usage", "--repo must be owner/name.", setupUsage);
    const parsed = { entry: values.entry, harness: values.harness, repo: values.repo };
    const fs = runtime.fs ?? nodeFileSystem;
    const target = await resolveIdentityTarget(
      runtime.cwd ?? process.cwd(),
      values.repo,
      runtime.git ?? nodeGit,
    );
    const resolution = await resolveFor(parsed, target.root, runtime);
    const repoFlag = values.repo ? ` --repo ${values.repo}` : "";
    if (resolution.status === "unresolved") {
      // No entry for this harness (Ori): name this agent's own key; never borrow another's.
      const harness = resolution.harnesses[0];
      const recovery =
        resolution.create && !resolution.candidates.length && harness
          ? `Create this agent's own entry (SERVER: this ${harness} server's name):\npdb setup identity --role ${role} --entry ${harness}.SERVER${repoFlag}`
          : `Select the entry explicitly:\n${(resolution.candidates.length ? resolution.candidates : ["KEY"]).map((key) => `pdb setup identity --role ${role} --entry ${key}${repoFlag}`).join("\n")}`;
      throw new ConfigError("identity-unresolved", unresolvedText(resolution), recovery);
    }
    const entry = resolution.entry;
    const before = await readIdentity(target.root, entry, fs);
    const dryRun = !!values["dry-run"];
    // The preview refuses what the write would refuse (the writer re-checks under its lock):
    // an existing entry without a valid name is never "initialized" with a generated one.
    if (dryRun && before.entryExists && !before.name)
      throw new ConfigError(
        "invalid-value",
        `Entry [agents.${entry}] in ${IDENTITY_FILE} has no valid name, so no identity was set up and nothing was changed.`,
        `Set one explicitly: pdb config set identity.name NAME --entry ${entry}${repoFlag}`,
      );
    const write = dryRun
      ? null
      : await setIdentity(target, entry, "identity.triage_role", role, {
          fs,
          git: runtime.git ?? nodeGit,
          random: runtime.random,
          requireName: true,
        });
    const record = write?.record ?? before;
    // Where the name comes from: kept, imported once from the legacy file, or generated.
    const nameSource = write?.generatedName
      ? "generated"
      : write?.importedFrom
        ? "legacy-import"
        : before.source === "pdb" && before.name
          ? "existing"
          : before.source === "legacy-not-imported" && before.name
            ? "legacy-import"
            : "generated";
    const name = record.name;
    if (!dryRun && !name)
      throw new ConfigError(
        "invalid-value",
        `Entry [agents.${entry}] in ${IDENTITY_FILE} has no valid name, so no identity was set up.`,
        `Set one explicitly: pdb config set identity.name NAME --entry ${entry}${repoFlag}`,
      );
    const next = name
      ? [`pdb --agent ${name} --role ${role}${repoFlag}`, `pdb claim N --agent ${name}${repoFlag}`]
      : [];
    const unchanged = before.source === "pdb" && !!before.name && before.triageRole === role;
    const result = {
      schemaVersion: 1,
      kind: "setup-identity",
      repository: target.repository,
      path: IDENTITY_FILE,
      entry,
      ...selectionJson(resolution),
      dryRun,
      name,
      nameSource,
      triageRole: role,
      previousTriageRole: before.triageRole,
      changed: write ? write.changed : !unchanged,
      createdEntry: write?.createdEntry ?? false,
      excludeRuleAdded: write?.excluded ?? false,
      ...(write?.lockCleanup ? { lockCleanup: write.lockCleanup } : {}),
      next,
    };
    if (json) {
      await output(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    const who = name
      ? `${name}${nameSource === "existing" ? " (existing name, kept)" : nameSource === "legacy-import" ? ` (imported once from ${LEGACY_IDENTITY_FILE})` : " (newly generated)"}`
      : "a newly generated, locally unique name (chosen when written; nothing is reserved)";
    const roleNote =
      before.triageRole && before.triageRole !== role ? ` (was ${before.triageRole})` : "";
    const lead = dryRun
      ? "Dry run, nothing written: would set up"
      : result.changed
        ? "Set up"
        : "Already set up";
    await output(
      `${lead} identity ${who} for entry ${entry} in ${IDENTITY_FILE} (${selectionText(selectionJson(resolution))}), triage role ${role}${roleNote}.${write?.excluded ? `\n  added /${IDENTITY_FILE} to this repository's local Git exclude file` : ""}${write?.lockCleanup ? `\n  ${write.lockCleanup}` : ""}${next.length ? `\nNext:\n${next.map((c) => `  ${c}`).join("\n")}` : "\nRun without --dry-run to write it, then use the reported name with --agent."}\n`,
    );
    return 0;
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError || error instanceof ConfigUsageError)) throw error;
    if (!json) throw new Error(`${error.message}\n${error.recovery}`, { cause: error });
    await output(
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "config-error",
          code: error.code,
          message: error.message,
          recovery: error.recovery,
        },
        null,
        2,
      ) + "\n",
    );
    return 1;
  }
}
