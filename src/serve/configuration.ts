/**
 * The read-only configuration view (#818, doc/design/serve-settings-page.md).
 *
 * One place that turns the shared configuration services into rows a page can render: the
 * global scope (per-OS-user `config.toml`) and one project's repository scope. It reports only
 * what the services say — value, registered default, source, type and description — and never
 * reads TOML itself, infers restart policy, or offers a write. Saving is a later ticket.
 */
import { join } from "node:path";
import {
  CONFIG_KEYS,
  loadConfig,
  retiredKeyNotices,
  type ConfigFileSystem,
  type ConfigValue,
} from "../config/config.js";
import {
  GLOBAL_CONFIG_FILE,
  GLOBAL_KEYS,
  globalConfigDirectory,
  loadGlobalConfig,
  type GlobalConfigFileSystem,
  type GlobalValue,
} from "../config/globalconfig.js";

export type ConfigurationScope = "global" | "project";

/** One registered setting, as a page shows it. */
export interface ConfigurationRow {
  readonly key: string;
  readonly scope: ConfigurationScope;
  /** Registered value type, from the registry (never inferred from the file). */
  readonly type: string;
  readonly value: ConfigValue | GlobalValue;
  readonly defaultValue: ConfigValue | GlobalValue;
  readonly source: "explicit" | "default";
  readonly description: string;
  readonly choices?: readonly string[];
}

/** The whole page's data: one scope, its rows, and what could not be read. */
export interface ConfigurationView {
  readonly schemaVersion: 1;
  readonly kind: "configuration";
  readonly scope: ConfigurationScope;
  readonly repository: string | null;
  /** Path of the file the service reads for this scope. */
  readonly path: string;
  /** Schema version on disk, or null when the file is absent (defaults apply). */
  readonly storedVersion: number | null;
  readonly rows: readonly ConfigurationRow[];
  /** Non-fatal findings: ignored retired keys, or an unreadable scope. */
  readonly warnings: readonly string[];
}

/** Boundaries the view reads through, injected so tests never touch a real user config. */
export interface ConfigurationRuntime {
  readonly env?: NodeJS.ProcessEnv;
  readonly globalFs?: GlobalConfigFileSystem;
  readonly repositoryFs?: ConfigFileSystem;
}

/** The global scope: every registered global key, defaults included. */
export async function globalConfiguration(
  runtime: ConfigurationRuntime = {},
): Promise<ConfigurationView> {
  const dir = globalConfigDirectory(runtime.env ?? process.env);
  const config = await loadGlobalConfig(dir, runtime.globalFs);
  const source = new Map(config.settings.map((setting) => [setting.key, setting.source]));
  const explicit = new Map(config.settings.map((setting) => [setting.key, setting.value]));
  return {
    schemaVersion: 1,
    kind: "configuration",
    scope: "global",
    repository: null,
    path: join(dir, GLOBAL_CONFIG_FILE),
    storedVersion: config.storedVersion,
    rows: GLOBAL_KEYS.map((entry) => ({
      key: entry.key,
      scope: "global" as const,
      type: entry.kind,
      value: explicit.get(entry.key) ?? entry.defaultValue,
      defaultValue: entry.defaultValue,
      source: source.get(entry.key) ?? "default",
      description: entry.description,
    })),
    warnings: [],
  };
}

/**
 * One project's repository scope. A project that cannot be read is reported as a warning with
 * the registered defaults, never as a silent empty table: missing evidence is not an answer.
 */
export async function projectConfiguration(
  project: string,
  repository: string,
  runtime: ConfigurationRuntime = {},
): Promise<ConfigurationView> {
  const warnings: string[] = [];
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig(project, runtime.repositoryFs);
  } catch (error) {
    warnings.push(
      `${project} could not be read: ${error instanceof Error ? error.message : String(error)} Showing registered defaults.`,
    );
  }
  if (config) warnings.push(...retiredKeyNotices(config).map((notice) => notice.detail));
  const explicit = config?.explicit ?? new Map<string, ConfigValue>();
  return {
    schemaVersion: 1,
    kind: "configuration",
    scope: "project",
    repository,
    path: config?.path ?? join(project, ".github", "triage.toml"),
    storedVersion: config?.storedVersion ?? null,
    rows: CONFIG_KEYS.map((entry) => ({
      key: entry.key,
      scope: "project" as const,
      type: entry.type,
      value: explicit.has(entry.key) ? explicit.get(entry.key)! : entry.defaultValue,
      defaultValue: entry.defaultValue,
      source: explicit.has(entry.key) ? "explicit" : "default",
      description: entry.description,
      ...(entry.choices ? { choices: entry.choices } : {}),
    })),
    warnings,
  };
}
