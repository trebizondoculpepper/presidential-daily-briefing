/**
 * Per-OS-user global configuration service (#804, doc/design/configuration-service.md).
 *
 * The transport-neutral configuration service owns reading, listing, setting, typed defaults,
 * schema/type validation, revisioned change comparisons and safe locked atomic writes for the
 * global scope. It is separate from the repository configuration service in config.ts: global
 * values live in a per-user `pdb` config directory and never mix with identity settings,
 * repository workflow rules or `.github/triage.toml`.
 *
 * Read-only operations never create a file. Writes validate first, preserve unrelated supported
 * values, refuse malformed/future versions (never overwriting them) and replace the file
 * atomically under a non-stealing lock (doc/design/safe-shared-file-writes.md). Global keys
 * follow the reviewed global schema in doc/design/serve-startup-configuration.md.
 */

import { join } from "node:path";
import envPaths from "env-paths";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import { parseDuration } from "../github/changes.js";
import { nodeFileSystem, TOML_HEADER, type ConfigFileSystem } from "./config.js";
import {
  acquireFileLock,
  releaseProblem,
  stuckLockMessage,
  type HeldLock,
  type LockFs,
  type LockTiming,
} from "./filelock.js";

/** File name inside the per-OS-user `pdb` config directory. */
export const GLOBAL_CONFIG_FILE = "config.toml";
/** Schema version this build reads/writes global configuration. */
export const GLOBAL_SCHEMA_VERSION = 1;
/** Default global listening port (matches serve DEFAULT_PORT). */
export const GLOBAL_DEFAULT_PORT = 4372;
/** Default TTL text (matches serve --ttl default 5m). */
export const GLOBAL_DEFAULT_TTL = "5m";
/** Shortest accepted TTL for serve.ttl (owner: normal settings around five to ten minutes). */
export const MIN_GLOBAL_TTL_MS = 60_000;
/** Longest accepted TTL for serve.ttl. */
export const MAX_GLOBAL_TTL_MS = 10 * 60_000;

/** A registered project: host (default github.com), repository and optional verified root. */
export interface GlobalProject {
  readonly host: string;
  readonly repository: string;
  readonly localRoot?: string;
}

/** The typed values the global service knows. */
export type GlobalValue = number | string | GlobalProject[];

/** Kind of a registered global key, for typed parsing/validation/serialising. */
export type GlobalKeyKind = "port" | "ttl" | "projects";

/** A registered global key: its kind, effective default and help text. */
export interface GlobalKey {
  readonly key: string;
  readonly kind: GlobalKeyKind;
  readonly defaultValue: GlobalValue;
  readonly description: string;
}

/** The single registry of supported global keys. Extend here, never with special cases. */
export const GLOBAL_KEYS: readonly GlobalKey[] = [
  {
    key: "serve.port",
    kind: "port",
    defaultValue: GLOBAL_DEFAULT_PORT,
    description:
      "The port PDB serve listens on (1-65535). 0 stays an explicit CLI override, never a saved value.",
  },
  {
    key: "serve.ttl",
    kind: "ttl",
    defaultValue: GLOBAL_DEFAULT_TTL,
    description: `How long a collected result is reused (e.g. ${MIN_GLOBAL_TTL_MS / 60_000}m to ${MAX_GLOBAL_TTL_MS / 60_000}m).`,
  },
  {
    key: "serve.projects",
    kind: "projects",
    defaultValue: [],
    description:
      "Ordered registered projects: { host, repository, localRoot? }. An empty array clears registrations.",
  },
];

/** The resolved per-OS-user `pdb` configuration directory. */
export function globalConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PDB_CONFIG_DIR;
  if (override !== undefined && override.trim() !== "") return override.trim();
  // Application `pdb` with no package-name suffix (doc/design/serve-startup-configuration.md).
  return envPaths("pdb").config;
}

export type GlobalConfigFileSystem = ConfigFileSystem;

const lockFs = (fs: GlobalConfigFileSystem): LockFs => {
  const readFile = async (path: string, _encoding: string): Promise<string> => {
    const text = await fs.readText(path);
    if (text === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  };
  const writeFile = async (
    path: string,
    data: string,
    options: { flag?: string },
  ): Promise<void> => {
    await fs.writeText(path, data, options.flag === "wx" ? 0o600 : undefined);
  };
  return { readFile, writeFile, unlink: (p) => fs.remove(p) };
};

const LOCK_TIMING: LockTiming = { waitMs: 5_000, pollMs: 50 };

/** The effective value of one global key, saying whether it is explicit or the default. */
export interface EffectiveGlobalSetting {
  readonly key: string;
  readonly value: GlobalValue;
  readonly source: "explicit" | "default";
}

export interface LoadedGlobalConfig {
  /** Absolute path of the config.toml (never read if absent). */
  readonly path: string;
  /** Schema version on disk, or null when absent. */
  readonly storedVersion: number | null;
  /** Explicitly stored values, after in-memory validation. */
  readonly explicit: ReadonlyMap<string, GlobalValue>;
  readonly settings: readonly EffectiveGlobalSetting[];
  /** Raw file text as read; null when absent. Used for intervening-edit detection. */
  readonly raw: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

function findKey(key: string): GlobalKey {
  const entry = GLOBAL_KEYS.find((candidate) => candidate.key === key);
  if (!entry)
    throw new GlobalConfigError(
      "unknown-key",
      `Unknown global configuration key "${key}".`,
      `Supported keys: ${GLOBAL_KEYS.map((candidate) => candidate.key).join(", ")}.`,
    );
  return entry;
}

/** What the effective value of a key should be when nothing is stored: the registered default. */
function defaultValue(key: string): GlobalValue {
  return findKey(key).defaultValue;
}

/** Validate a value for a registered global key, returning the normalised stored value. */
export function validateGlobalValue(key: string, value: unknown): GlobalValue {
  const entry = findKey(key);
  switch (entry.kind) {
    case "port": {
      const number =
        typeof value === "bigint" && value > BigInt(0) && value <= BigInt(65535)
          ? Number(value)
          : value;
      if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 65535)
        throw globalInvalid(key, `expected an integer 1-65535, got ${describe(value)}`);
      return number;
    }
    case "ttl": {
      if (typeof value !== "string")
        throw globalInvalid(key, `expected duration text, got ${describe(value)}`);
      let ms: number;
      try {
        ms = parseDuration(value);
      } catch {
        throw globalInvalid(key, `expected duration text like 5m, got ${JSON.stringify(value)}`);
      }
      if (ms < MIN_GLOBAL_TTL_MS || ms > MAX_GLOBAL_TTL_MS)
        throw globalInvalid(
          key,
          `expected a duration of ${MIN_GLOBAL_TTL_MS / 60_000}m to ${MAX_GLOBAL_TTL_MS / 60_000}m, got ${value}`,
        );
      return value;
    }
    case "projects": {
      if (!Array.isArray(value))
        throw globalInvalid(key, `expected an array of tables, got ${describe(value)}`);
      return value.map((record) => validateProject(record, key));
    }
  }
}

function validateProject(value: unknown, key: string): GlobalProject {
  if (!isRecord(value))
    throw globalInvalid(key, `each project must be a table, got ${describe(value)}`);
  const extra = Object.keys(value).filter((k) => !["host", "repository", "localRoot"].includes(k));
  if (extra.length) throw globalInvalid(key, `unexpected project field "${extra[0]}".`);
  const { host, repository, localRoot } = value;
  if (host !== undefined && (typeof host !== "string" || host.trim() === ""))
    throw globalInvalid(key, `project "host" must be non-empty text, got ${describe(host)}`);
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw globalInvalid(
      key,
      `project "repository" must be owner/name, got ${describe(repository)}`,
    );
  if (localRoot !== undefined && (typeof localRoot !== "string" || localRoot === ""))
    throw globalInvalid(
      key,
      `project "localRoot" must be an absolute verified path, got ${describe(localRoot)}`,
    );
  return {
    host: host === undefined ? "github.com" : host,
    repository,
    ...(localRoot === undefined ? {} : { localRoot }),
  };
}

const globalInvalid = (key: string, detail: string): GlobalConfigError =>
  new GlobalConfigError(
    "invalid-value",
    `Invalid value for "${key}": ${detail}.`,
    GLOBAL_KEYS.find((k) => k.key === key)?.description ?? "",
  );

export type GlobalConfigErrorCode =
  | "malformed"
  | "unsupported-version"
  | "unknown-key"
  | "invalid-value"
  | "conflict"
  | "lock"
  | "filesystem";

/** A refusal for global configuration. The file is left untouched. */
export class GlobalConfigError extends Error {
  readonly code: GlobalConfigErrorCode;
  readonly recovery: string;
  constructor(code: GlobalConfigErrorCode, message: string, recovery: string) {
    super(message);
    this.name = "GlobalConfigError";
    this.code = code;
    this.recovery = recovery;
  }
}

function filesystemRefusal(path: string, error: unknown): GlobalConfigError | null {
  if (!(error instanceof Error)) return null;
  const { code } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || !/^E[A-Z]+$/.test(code)) return null;
  return new GlobalConfigError(
    "filesystem",
    `Could not access ${path}: ${code}.`,
    "Check the directory exists and is readable/writable by you, and that the disk has space; then retry. Nothing was changed.",
  );
}

function effective(explicit: ReadonlyMap<string, GlobalValue>): readonly EffectiveGlobalSetting[] {
  return GLOBAL_KEYS.map((entry) =>
    explicit.has(entry.key)
      ? { key: entry.key, value: explicit.get(entry.key)!, source: "explicit" }
      : { key: entry.key, value: entry.defaultValue, source: "default" },
  );
}

/** Read a dotted key from a parsed document or undefined when absent. */
function valueOf(document: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let node: unknown = document;
  for (const part of parts) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Read-only load of the global configuration. Missing file yields defaults; nothing is created.
 * Refuses malformed, future and (on read) unrelated-to-registry data rather than guessing.
 */
export async function loadGlobalConfig(
  dir: string,
  fs: GlobalConfigFileSystem = nodeFileSystem,
): Promise<LoadedGlobalConfig> {
  const path = join(dir, GLOBAL_CONFIG_FILE);
  const raw = await fs.readText(path).catch((error: unknown) => {
    const refusal = filesystemRefusal(path, error);
    if (refusal) throw refusal;
    throw error;
  });
  return parseGlobalConfig(raw, path);
}

/** Parse and validate global config text. Never writes. */
export function parseGlobalConfig(raw: string | null, path: string): LoadedGlobalConfig {
  const explicit = new Map<string, GlobalValue>();
  if (raw === null)
    return { path, storedVersion: null, explicit, settings: effective(explicit), raw };
  let document: unknown;
  try {
    document = parseToml(raw, { integersAsBigInt: true });
  } catch (error) {
    if (error instanceof TomlError) {
      throw new GlobalConfigError(
        "malformed",
        `${path} is not valid TOML: syntax error at line ${error.line}, column ${error.column}.`,
        `Remove or fix ${path}, then retry.`,
      );
    }
    throw error;
  }
  if (!isRecord(document) || document instanceof Date) {
    throw new GlobalConfigError(
      "malformed",
      `${path} is not a TOML table.`,
      `Remove or fix ${path}, then retry.`,
    );
  }
  const version = document.schemaVersion;
  const storedVersion = typeof version === "bigint" ? Number(version) : version;
  if (typeof storedVersion !== "number" || !Number.isInteger(storedVersion) || storedVersion < 1)
    throw new GlobalConfigError(
      "malformed",
      `${path} has no valid integer "schemaVersion".`,
      `Remove or fix ${path} (schema version 1), then retry.`,
    );
  if (storedVersion > GLOBAL_SCHEMA_VERSION)
    throw new GlobalConfigError(
      "unsupported-version",
      `${path} uses schema version ${storedVersion}; this build supports up to ${GLOBAL_SCHEMA_VERSION}.`,
      "Upgrade pdb to a release that supports this schema. The file was not changed.",
    );
  const body = { ...document };
  delete body.schemaVersion;
  for (const key of GLOBAL_KEYS.map((k) => k.key)) {
    const value = valueOf(body, key);
    if (value === undefined) {
      // Absent keys take the default; present keys are validated (including null-refused paths).
    } else {
      explicit.set(key, validateGlobalValue(key, value));
    }
  }
  return { path, storedVersion, explicit, settings: effective(explicit), raw };
}

/** Serialise the global document with the canonical header and schema version. */
export function serializeGlobal(values: ReadonlyMap<string, GlobalValue>): string {
  const document: Record<string, unknown> = { schemaVersion: GLOBAL_SCHEMA_VERSION };
  for (const key of GLOBAL_KEYS.map((k) => k.key)) {
    const parts = key.split(".");
    let node = document;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(node[part])) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = values.get(key);
  }
  return `${TOML_HEADER}# Global per-user pdb configuration.\n\n${stringifyToml(document)}\n`;
}

/** Changes to apply: a value sets the key, undefined unsets it (returning it to default). */
export type GlobalConfigChanges = ReadonlyMap<string, GlobalValue | undefined>;

export interface GlobalWriteOptions {
  readonly fs?: GlobalConfigFileSystem;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly expectedRaw?: string | null;
}

export interface GlobalWriteResult {
  readonly changed: boolean;
  readonly config: LoadedGlobalConfig;
}

const conflict = (path: string): GlobalConfigError =>
  new GlobalConfigError(
    "conflict",
    `${path} changed while this update was being prepared.`,
    "Review the new contents and retry the command; nothing was overwritten.",
  );

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A short-lived CLI never invents a baseline: this describes what changed since an in-memory
 * snapshot the caller keeps, which is exactly the revisioned change report #804 needs. */
export interface GlobalChange {
  readonly key: string;
  readonly oldValue: GlobalValue | undefined;
  readonly newValue: GlobalValue | undefined;
}

/** Compare an earlier in-memory snapshot to the current state (in-memory baseline, not persisted). */
export function globalChanges(
  baseline: ReadonlyMap<string, GlobalValue>,
  explicit: ReadonlyMap<string, GlobalValue>,
): GlobalChange[] {
  const effectiveValue = (source: ReadonlyMap<string, GlobalValue>, key: string): GlobalValue =>
    source.has(key) ? source.get(key)! : defaultValue(key);
  return GLOBAL_KEYS.map((entry) => entry.key)
    .filter(
      (key) =>
        JSON.stringify(effectiveValue(baseline, key)) !==
        JSON.stringify(effectiveValue(explicit, key)),
    )
    .map((key) => ({
      key,
      oldValue: baseline.has(key) ? baseline.get(key) : undefined,
      newValue: explicit.has(key) ? explicit.get(key) : undefined,
    }));
}

/**
 * Validate and apply changes to the global config, atomically and under a lock. Creates the
 * directory, acquires the lock, reads the latest state, validates, writes a same-directory
 * temporary file and renames it into place; equal writes are no-ops.
 */
export async function writeGlobalConfig(
  dir: string,
  changes: GlobalConfigChanges,
  options: GlobalWriteOptions = {},
): Promise<GlobalWriteResult> {
  const fs = options.fs ?? nodeFileSystem;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const path = join(dir, GLOBAL_CONFIG_FILE);
  if (typeof fs.makeDirectory !== "function")
    throw new GlobalConfigError(
      "filesystem",
      "The configuration filesystem cannot create directories.",
      "Nothing was changed.",
    );
  await fs.makeDirectory(dir).catch((error: unknown) => {
    const refusal = filesystemRefusal(dir, error);
    if (refusal) throw refusal;
    throw error;
  });
  const lock = `${path}.lock`;
  let held: HeldLock;
  try {
    const acquired = await acquireFileLock(lockFs(fs), lock, LOCK_TIMING, now, sleep);
    if (acquired === null)
      throw new GlobalConfigError(
        "lock",
        stuckLockMessage(lock),
        `Delete ${lock} yourself and retry.`,
      );
    held = acquired;
  } catch (error) {
    const refusal = filesystemRefusal(lock, error);
    if (refusal) throw refusal;
    throw error;
  }
  try {
    const current = await loadGlobalConfig(dir, fs);
    if (options.expectedRaw !== undefined && current.raw !== options.expectedRaw)
      throw conflict(path);
    const next = new Map(current.explicit);
    for (const [key, value] of changes) {
      if (value === undefined) {
        findKey(key);
        next.delete(key);
      } else {
        next.set(key, validateGlobalValue(key, value));
      }
    }
    const text = serializeGlobal(next);
    if (text === current.raw) return { changed: false, config: current };
    if (current.raw === null && next.size === 0) return { changed: false, config: current };
    const temporary = `${path}.${now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeText(temporary, text, 0o600);
    } catch (error) {
      const refusal = filesystemRefusal(temporary, error);
      if (refusal) throw refusal;
      throw error;
    }
    try {
      const latest = await fs.readText(path);
      if (latest !== current.raw) throw conflict(path);
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.remove(temporary).catch(() => undefined);
      throw error;
    }
    const written = await loadGlobalConfig(dir, fs);
    return { changed: true, config: written };
  } finally {
    const release = await held();
    const problem = releaseProblem(lock, release);
    if (problem)
      throw new GlobalConfigError("lock", problem, `Delete ${lock} yourself if it remains.`);
  }
}
