/**
 * The read-only Configuration view (#818, doc/design/serve-settings-page.md and
 * serve-configuration-layers.md).
 *
 * One place that turns the shared configuration services into rows a page can render: the
 * per-OS-user global scope (serve startup settings) and one served repository's repository
 * scope. It reports only what the services say — value, registered default, source/source,
 * type/kind and description — and never reads TOML itself, infers restart policy or offers a
 * write. Saving is a later ticket (#584).
 *
 * Plumbing mirrors the Rules page's API-first read (`readRules`): the `/api/v1/configuration`
 * route reads this module and the Svelte component renders the returned document there.
 */
import { join } from "node:path";
import {
  ConfigError,
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
import { HttpFailure } from "./http.js";
import type { ServeErrorCode } from "./http.js";

/** The two scopes the page shows. */
export type ConfigurationScope = "global" | "project";

/**
 * How readable the scope is. `ok` means the file was read (or is absent so defaults apply).
 * `unsupported` means the scope has no local file to read (a repository served `--repo` only).
 * `degraded` means the file exists but could not be read; registered defaults are still shown so
 * a gap is never answered silently.
 */
export type ConfigurationState = "ok" | "unsupported" | "degraded";

/** One registered setting, as a page shows it. */
export interface ConfigurationRow {
  readonly key: string;
  readonly scope: ConfigurationScope;
  /** Registered value type/kind, from the registry (never inferred from the file). */
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
  readonly state: ConfigurationState;
  /** Path of the file the service reads for this scope (never the raw text). */
  readonly path: string;
  /** Schema version on disk, or null when the file is absent (defaults apply). */
  readonly storedVersion: number | null;
  readonly rows: readonly ConfigurationRow[];
  /** Non-fatal findings: ignored retired keys, or a readable problem with the scope. */
  readonly warnings: readonly string[];
}

/** Boundaries the view reads through, injected so tests never touch a real user config. */
export interface ConfigurationRuntime {
  readonly env?: NodeJS.ProcessEnv;
  readonly globalFs?: GlobalConfigFileSystem;
  readonly repositoryFs?: ConfigFileSystem;
  /** The verified per-OS-user config directory serve already resolved (#805), when available. */
  readonly globalDir?: string;
}

/**
 * Production boundaries derived from the serve runtime: when the runtime's verified global
 * configuration boundary is present, the page reads exactly that directory and filesystem, so
 * the served set, saved registrations and the page never disagree. Fall back to the process
 * environment and node filesystem otherwise.
 */
export const defaultConfigurationRuntime = (globalConfig?: {
  readonly dir: string;
  readonly fs?: ConfigFileSystem;
}): ConfigurationRuntime =>
  globalConfig ? { globalDir: globalConfig.dir, globalFs: globalConfig.fs } : {};

/**
 * The read the API route returns: the selected view, or a refusal (unknown parameter, a
 * repository that is not served, malformed scope selection).
 */
export type ConfigurationRead =
  | { ok: true; readonly selected: string | null; readonly view: ConfigurationView }
  | { ok: false; readonly status: number; readonly code: ServeErrorCode; readonly message: string };

const row = (
  scope: ConfigurationScope,
  entry: { key: string; description: string; defaultValue: ConfigValue | GlobalValue },
  value: ConfigValue | GlobalValue,
  source: "explicit" | "default",
  type: string,
  choices?: readonly string[],
): ConfigurationRow => ({
  key: entry.key,
  scope,
  type,
  value,
  defaultValue: entry.defaultValue,
  source,
  description: entry.description,
  ...(choices ? { choices } : {}),
});

/** The global scope: every registered global key, defaults included, nothing else. */
export async function globalConfiguration(
  runtime: ConfigurationRuntime = {},
): Promise<ConfigurationView> {
  const dir = runtime.globalDir ?? globalConfigDirectory(runtime.env ?? process.env);
  const warnings: string[] = [];
  let config: Awaited<ReturnType<typeof loadGlobalConfig>> | null = null;
  try {
    config = await loadGlobalConfig(dir, runtime.globalFs);
  } catch (error) {
    warnings.push(
      error instanceof ConfigError
        ? `${error.message} Showing registered defaults.`
        : `The global configuration could not be read (${error instanceof Error ? error.message : String(error)}). Showing registered defaults.`,
    );
  }
  const explicit = config?.explicit ?? new Map<string, GlobalValue>();
  const source = new Map((config?.settings ?? []).map((setting) => [setting.key, setting.source]));
  return {
    schemaVersion: 1,
    kind: "configuration",
    scope: "global",
    repository: null,
    state: config === null ? "degraded" : "ok",
    path: join(dir, GLOBAL_CONFIG_FILE),
    storedVersion: config?.storedVersion ?? null,
    rows: GLOBAL_KEYS.map((entry) =>
      row(
        "global",
        entry,
        explicit.get(entry.key) ?? entry.defaultValue,
        source.get(entry.key) ?? "default",
        entry.kind,
      ),
    ),
    warnings,
  };
}

/**
 * One repository's scope. A repository served without a local project (`--repo` only) has no file
 * to read: that is `unsupported` with the registered defaults, never a silent empty table. A
 * file that exists but cannot be read is `degraded` with a readable reason; missing evidence is
 * not an answer.
 */
export async function projectConfiguration(
  project: string | undefined,
  repository: string,
  runtime: ConfigurationRuntime = {},
): Promise<ConfigurationView> {
  const warnings: string[] = [];
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  if (project === undefined) {
    warnings.push(
      `${repository} is served without a local project (--repo only), so its repository settings are not read from disk. Run pdb config list in a checkout of ${repository} to see them, or serve it with --project.`,
    );
  } else {
    try {
      config = await loadConfig(project, runtime.repositoryFs);
      warnings.push(...retiredKeyNotices(config).map((notice) => notice.detail));
    } catch (error) {
      warnings.push(
        error instanceof ConfigError
          ? `${error.message} Showing registered defaults.`
          : `${repository} could not be read: ${error instanceof Error ? error.message : String(error)}. Showing registered defaults.`,
      );
    }
  }
  const explicit = config?.explicit ?? new Map<string, ConfigValue>();
  return {
    schemaVersion: 1,
    kind: "configuration",
    scope: "project",
    repository,
    state: config === null ? (project === undefined ? "unsupported" : "degraded") : "ok",
    path: config?.path ?? join(project ?? repository, ".github", "triage.toml"),
    storedVersion: config?.storedVersion ?? null,
    rows: CONFIG_KEYS.map((entry) =>
      row(
        "project",
        entry,
        explicit.has(entry.key) ? explicit.get(entry.key)! : entry.defaultValue,
        explicit.has(entry.key) ? "explicit" : "default",
        entry.type,
        entry.choices,
      ),
    ),
    warnings,
  };
}

/**
 * Read one Configuration view for a URL query (API route; never a browser script). Accepts only
 * the page's own `repo` parameter, once; `repo` absent means the Global scope, exactly as the
 * shared shell's selection resolves it. The served-project resolver is injected so the API and
 * the shell agree.
 */
export async function readConfiguration(
  query: URLSearchParams,
  served: readonly { repository: string; project?: string }[],
  runtime: ConfigurationRuntime,
  select: (
    served: readonly { repository: string; project?: string }[],
    repo: string | undefined,
  ) => { repository: string; project?: string },
): Promise<ConfigurationRead> {
  const refuse = (status: number, code: ServeErrorCode, message: string): ConfigurationRead => ({
    ok: false,
    status,
    code,
    message,
  });
  for (const key of query.keys())
    if (key !== "repo")
      return refuse(
        400,
        "INVALID_ARGUMENT",
        `Unknown parameter. The configuration page accepts repo.`,
      );
  if (query.getAll("repo").length > 1)
    return refuse(400, "INVALID_ARGUMENT", "Give repo at most once.");
  const repo = query.get("repo");
  if (repo === null) {
    const view = await globalConfiguration(runtime);
    return { ok: true, selected: null, view };
  }
  let selected: { repository: string; project?: string };
  try {
    selected = select(served, repo);
  } catch (error) {
    if (!(error instanceof HttpFailure)) throw error;
    return refuse(
      error.status,
      error.code,
      error.code === "REPOSITORY_NOT_SERVED"
        ? "That repository is not served by this server. Choose a served project."
        : "repo must be owner/name. Choose a served project.",
    );
  }
  const view = await projectConfiguration(selected.project, selected.repository, runtime);
  return { ok: true, selected: selected.repository, view };
}
