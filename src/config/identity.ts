/**
 * Repository-local agent identity service (#70, doc/design/identity.md; PDB-owned store #319,
 * doc/design/pdb-owned-identity.md).
 *
 * Owns `<working-tree-root>/pdb.toml`: Git root resolution, explicit entry selection,
 * typed reads of the registered per-agent settings (`identity.name`, `identity.triage_role`)
 * and conflict-detecting atomic writes that preserve every other value and table.
 *
 * - The file lives only at the Git working-tree root (nested directories and linked worktrees
 *   with a `.git` file resolve through Git). There is no parent/sibling/global fallback, and a
 *   remote `--repo` alone never selects local storage: it must agree with the checkout.
 * - `pdb.toml` is canonical. A legacy Agent Inbox `agent-inbox.toml` at the same root is only
 *   ever read: read-only lookups may return its matching entry with source
 *   `legacy-not-imported`, and the first explicit write for an entry absent from `pdb.toml`
 *   imports that entry's `name` and valid `triage_role` once. The legacy file is never written,
 *   locked, renamed, untracked or removed.
 * - Reads never create, rewrite or repair anything. Read-only consumers (#38, #64, #25) call
 *   `readIdentity`/`lookupIdentity`.
 * - Writes establish Git exclusion before creating the file (repository-local
 *   `info/exclude`, never global settings), refuse a tracked file without untracking it, and
 *   never commit or delete.
 * - Parsing/serialising uses smol-toml. The serialiser keeps every key, table and typed value
 *   (integers as BigInt, floats, dates/times) but does NOT keep comments or layout: a write
 *   normalises formatting. This is documented rather than claiming byte preservation.
 * - Results only ever expose the selected entry's registered values; other agents' data,
 *   unknown keys and credentials are never returned. Paths are reported relative to the root.
 */

import { dirname, isAbsolute, join } from "node:path";
import { stringify } from "smol-toml";
import { ConfigError, nodeFileSystem, parseTomlTable } from "./config.js";
import { createGitService, GitError } from "../git/service.js";
import type { GitService } from "../git/service.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { acquireFileLock, releaseProblem, type LockFs, type LockTiming } from "./filelock.js";

/** Root-relative canonical identity file name, owned by pdb (#319). */
export const IDENTITY_FILE = "pdb.toml";

/** Root-relative legacy Agent Inbox identity file: read for import only, never written. */
export const LEGACY_IDENTITY_FILE = "agent-inbox.toml";

/** Schema version of `pdb.toml`; an absent version is read as 1, a future one is refused. */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Which store supplied a record's values. */
export type IdentitySource = "pdb" | "legacy-not-imported" | "none";

/** Permission bits for a newly created identity file (owner read/write only). */
const PRIVATE_FILE_MODE = 0o600;

/** Accepted `triage_role` values. Independent of any generic `role` key, which is preserved. */
export const TRIAGE_ROLES = ["implementer", "designer"] as const;
export type TriageRole = (typeof TRIAGE_ROLES)[number];

/** A registered per-agent setting and the table field it is stored in. */
export interface IdentityKey {
  readonly key: string;
  readonly field: "name" | "triage_role";
  readonly validValues: readonly string[] | "agent name";
  readonly description: string;
}

/** The single registry of per-agent settings routed to `[agents.KEY]`. */
export const IDENTITY_KEYS: readonly IdentityKey[] = [
  {
    key: "identity.name",
    field: "name",
    validValues: "agent name",
    description:
      "Stable workflow attribution name of the selected agent entry (letters, digits, '_', '.', '-'). Generated once when the entry is initialised; changing it never rewrites GitHub claims.",
  },
  {
    key: "identity.triage_role",
    field: "triage_role",
    validValues: TRIAGE_ROLES,
    description:
      "Default triage role of the selected agent entry (implementer or designer). Setting it initialises a missing file/entry with a generated name. Separate from any existing 'role' key, which is preserved.",
  },
];

export const isIdentityKey = (key: string): boolean => key.startsWith("identity.");

const ENTRY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Whether a value is a valid agent name: the same rule configuration enforces (at most 100). */
export const isAgentName = (value: string): boolean =>
  NAME_PATTERN.test(value) && value.length <= 100;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Validate an `--entry` key. Dotted keys such as `ori.review` are one quoted table key. */
export function validateEntryKey(entry: string): string {
  if (!ENTRY_PATTERN.test(entry) || RESERVED.has(entry) || entry.length > 100) {
    throw new ConfigError(
      "invalid-value",
      `Invalid --entry ${JSON.stringify(entry)}: use letters, digits, '_', '.' or '-'.`,
      "Pass the agent entry key, for example --entry codex or --entry ori.review.",
    );
  }
  return entry;
}

function identityKey(key: string): IdentityKey {
  const entry = IDENTITY_KEYS.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new ConfigError(
      "unknown-key",
      `Unknown identity setting "${key}".`,
      `Supported identity keys: ${IDENTITY_KEYS.map((k) => k.key).join(", ")}.`,
    );
  }
  return entry;
}

/** Validate a value for a registered identity key. */
export function validateIdentityValue(key: string, value: string): string {
  const entry = identityKey(key);
  const ok =
    entry.validValues === "agent name" ? isAgentName(value) : entry.validValues.includes(value);
  if (!ok) {
    throw new ConfigError(
      "invalid-value",
      `Invalid value for "${key}": ${JSON.stringify(value)}.`,
      `${entry.description} Valid: ${entry.validValues === "agent name" ? "an agent name" : entry.validValues.join(", ")}.`,
    );
  }
  return value;
}

/** A resolved working-tree root; `repository` is set only when `--repo` was verified. */
export interface IdentityTarget {
  readonly root: string;
  readonly repository: string | null;
}

/**
 * Resolve the Git working-tree root containing `cwd`. Works from nested directories and from
 * linked worktrees (`.git` file). Never walks to a parent/sibling project or a global location.
 * With `repository`, the checkout's GitHub remotes must include it.
 */
export async function resolveIdentityTarget(
  cwd: string,
  repository: string | undefined,
  git?: GitService | GitRunner,
): Promise<IdentityTarget> {
  // The typed Git service (#910): checkout root and remotes, parsed behind the facade.
  const service = gitServiceOf(git);
  let root = "";
  try {
    root = (await service.workingTreeRoot({ cwd })) ?? "";
  } catch (error) {
    if (error instanceof GitError && error.code === "cancelled") throw error;
    root = "";
  }
  if (!root) {
    throw new ConfigError(
      "not-a-repository",
      "The current directory is not inside a Git working tree, so there is no agent identity file to use.",
      "Run the command from inside the repository's local checkout (not a bare repository or its .git directory).",
    );
  }
  if (repository === undefined) return { root, repository: null };
  let repositories: string[] = [];
  try {
    repositories = (await service.remotes({ cwd: root })).flatMap((r) =>
      r.repository ? [r.repository.toLowerCase()] : [],
    );
  } catch (error) {
    if (error instanceof GitError && error.code === "cancelled") throw error;
    repositories = [];
  }
  const wanted = repository.toLowerCase();
  if (!repositories.includes(wanted)) {
    throw new ConfigError(
      "repository-mismatch",
      `The current checkout is not ${repository}; its local identity file cannot be selected by --repo alone.`,
      "Run from a local checkout of the intended repository.",
    );
  }
  return { root, repository: wanted };
}

/** The selected entry's registered values. Nothing else from the file is ever returned. */
export interface IdentityRecord {
  /** Root-relative path of the file the values came from, never an absolute private path. */
  readonly path: typeof IDENTITY_FILE | typeof LEGACY_IDENTITY_FILE;
  readonly entry: string;
  /**
   * `pdb` when the entry is in pdb.toml; `legacy-not-imported` when it is absent there and the
   * values come read-only from a matching legacy agent-inbox.toml entry; otherwise `none`.
   */
  readonly source: IdentitySource;
  /** Whether pdb.toml exists (the legacy file never counts). */
  readonly fileExists: boolean;
  /** Whether pdb.toml has the selected entry (the legacy file never counts). */
  readonly entryExists: boolean;
  /** Valid stored name, or null when absent/invalid. */
  readonly name: string | null;
  /** Valid stored triage role, or null when absent/invalid. */
  readonly triageRole: TriageRole | null;
  /** Non-secret problems such as an invalid stored triage_role (values are not echoed). */
  readonly problems: readonly string[];
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const malformed = (detail: string, file: string = IDENTITY_FILE): ConfigError =>
  new ConfigError(
    "malformed",
    `${file} is not valid for identity use: ${detail}`,
    file === IDENTITY_FILE
      ? `Fix or restore ${file} at the repository root by hand, then retry; nothing was changed.`
      : `Fix ${file} at the repository root by hand, or choose the entry and name explicitly (pdb config set identity.name NAME --entry KEY), then retry; nothing was changed and ${file} is never written by pdb.`,
  );

const parseAgents = (raw: string, file: string): Table => {
  const document = parseTomlTable(raw, (detail) => malformed(detail, file));
  if (document.agents !== undefined && !isTable(document.agents)) {
    throw malformed("'agents' is not a table.", file);
  }
  return document;
};

/**
 * Parse the whole pdb.toml document with types preserved (integers as BigInt). Never writes.
 * A schemaVersion other than 1 (or absent) is refused rather than reinterpreted as version 1.
 */
export function parseIdentityDocument(raw: string): Table {
  const document = parseAgents(raw, IDENTITY_FILE);
  const version = document.schemaVersion;
  if (version !== undefined && version !== BigInt(IDENTITY_SCHEMA_VERSION)) {
    throw new ConfigError(
      "unsupported-version",
      `${IDENTITY_FILE} declares a schemaVersion this pdb does not support (supported: ${IDENTITY_SCHEMA_VERSION}); it was not read or changed.`,
      "Upgrade pdb to a version that supports this identity file, or restore a supported copy by hand, then retry.",
    );
  }
  return document;
}

/** Parse the legacy Agent Inbox document (no pdb schema metadata). Never writes. */
export function parseLegacyIdentityDocument(raw: string): Table {
  return parseAgents(raw, LEGACY_IDENTITY_FILE);
}

/**
 * Serialise a pdb.toml document with `schemaVersion` first. Keys, tables and typed values
 * survive; comments/layout do not.
 */
export function serializeIdentityDocument(document: Table): string {
  const ordered: Table = Object.create(null);
  ordered.schemaVersion = BigInt(IDENTITY_SCHEMA_VERSION);
  for (const [name, value] of Object.entries(document)) {
    if (name !== "schemaVersion") ordered[name] = value;
  }
  return stringify(ordered, { numbersAsFloat: true });
}

function recordFor(
  document: Table | null,
  entry: string,
  file: typeof IDENTITY_FILE | typeof LEGACY_IDENTITY_FILE = IDENTITY_FILE,
): IdentityRecord {
  const agents = document?.agents as Table | undefined;
  const table = agents && Object.hasOwn(agents, entry) ? agents[entry] : undefined;
  const problems: string[] = [];
  if (table !== undefined && !isTable(table)) {
    problems.push(`agents.${entry} is not a table.`);
  }
  const values = isTable(table) ? table : {};
  let name: string | null = null;
  if (values.name !== undefined) {
    if (typeof values.name === "string" && NAME_PATTERN.test(values.name)) name = values.name;
    else problems.push("Stored name is not a valid agent name.");
  }
  let triageRole: TriageRole | null = null;
  if (values.triage_role !== undefined) {
    if (TRIAGE_ROLES.includes(values.triage_role as TriageRole)) {
      triageRole = values.triage_role as TriageRole;
    } else {
      problems.push(`Stored triage_role is not one of ${TRIAGE_ROLES.join(", ")}.`);
    }
  }
  return {
    path: file,
    entry,
    source: table !== undefined ? (file === IDENTITY_FILE ? "pdb" : "legacy-not-imported") : "none",
    fileExists: document !== null,
    entryExists: table !== undefined,
    name,
    triageRole,
    problems,
  };
}

/** Describe an unexpected read failure without paths or contents. */
const unreadable = (file: string, error: unknown): ConfigError =>
  new ConfigError(
    "filesystem",
    `${file} could not be read (${String((error as NodeJS.ErrnoException).code ?? "error")}); nothing was changed.`,
    `Check access to ${file} at the repository root, then retry.`,
  );

/**
 * Read-only lookup of one entry. pdb.toml is canonical: a present entry there (valid or not)
 * is returned as is and never replaced by legacy data. Only when the entry is absent from
 * pdb.toml is a matching legacy agent-inbox.toml entry returned, with source
 * `legacy-not-imported` (nothing is imported). A legacy file that cannot be read or parsed is
 * reported as a problem, never treated as absent and never written. Missing files/entries are
 * reported, never created.
 */
export async function readIdentity(
  root: string,
  entry: string,
  fs: ConfigFileSystem = nodeFileSystem,
): Promise<IdentityRecord> {
  validateEntryKey(entry);
  const raw = await fs.readText(join(root, IDENTITY_FILE));
  const record = recordFor(raw === null ? null : parseIdentityDocument(raw), entry);
  if (record.entryExists) return record;
  let legacy: Table | null;
  try {
    const legacyRaw = await fs.readText(join(root, LEGACY_IDENTITY_FILE));
    legacy = legacyRaw === null ? null : parseLegacyIdentityDocument(legacyRaw);
  } catch (error) {
    const problem =
      error instanceof ConfigError
        ? error.message
        : unreadable(LEGACY_IDENTITY_FILE, error).message;
    return { ...record, problems: [...record.problems, `Legacy identity unavailable: ${problem}`] };
  }
  const old = recordFor(legacy, entry, LEGACY_IDENTITY_FILE);
  if (!old.entryExists) return record;
  if (old.name === null) {
    return {
      ...record,
      problems: [
        ...record.problems,
        ...old.problems.map((problem) => `${LEGACY_IDENTITY_FILE}: ${problem}`),
        ...(old.problems.length ? [] : [`${LEGACY_IDENTITY_FILE} [agents.${entry}] has no name.`]),
      ],
    };
  }
  return {
    ...old,
    fileExists: record.fileExists,
    entryExists: false,
    problems: [...record.problems, ...old.problems.map((p) => `${LEGACY_IDENTITY_FILE}: ${p}`)],
  };
}

const BINDING_KEY_PATTERN = /^[a-z][a-z0-9-]{1,40}_[a-f0-9]{64}$/;

/** Binding keys contain a registered provider name and an opaque project-scoped digest. */
export function validateIdentityBindingKey(key: string): void {
  if (!BINDING_KEY_PATTERN.test(key))
    throw new ConfigError(
      "invalid-value",
      "Invalid local identity binding key.",
      "Select the logical entry explicitly with --entry KEY.",
    );
}

function bindingsFor(document: Table | null): Map<string, string> {
  const value = document?.agentBindings;
  if (value === undefined) return new Map();
  if (!isTable(value)) throw malformed("agentBindings is not a table.");
  const bindings = new Map<string, string>();
  for (const [key, entry] of Object.entries(value)) {
    // Unknown future metadata is preserved, but is not interpreted as a known binding.
    if (!BINDING_KEY_PATTERN.test(key)) continue;
    if (typeof entry !== "string") throw malformed("an agent binding has an invalid target entry.");
    try {
      validateEntryKey(entry);
    } catch {
      throw malformed("an agent binding has an invalid target entry.");
    }
    bindings.set(key, entry);
  }
  return bindings;
}

async function bindingDocument(root: string, fs: ConfigFileSystem): Promise<Table | null> {
  try {
    const path = join(root, IDENTITY_FILE);
    if (await fs.isSymbolicLink?.(path))
      throw new ConfigError(
        "unsafe-path",
        `${IDENTITY_FILE} is a symbolic link; no identity binding was selected.`,
        "Use a regular private identity file at the repository root.",
      );
    const raw = await fs.readText(path);
    return raw === null ? null : parseIdentityDocument(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw unreadable(IDENTITY_FILE, error);
  }
}

/** Internal selection evidence: entry keys only, never other agents' configuration values. */
export async function readIdentityBindings(
  root: string,
  fs: ConfigFileSystem = nodeFileSystem,
): Promise<ReadonlyMap<string, string>> {
  return bindingsFor(await bindingDocument(root, fs));
}

/** Read one binding and its canonical identity from the same atomic document snapshot. */
export async function readBoundIdentity(
  root: string,
  key: string,
  fs: ConfigFileSystem = nodeFileSystem,
): Promise<{ entry: string; record: IdentityRecord } | null> {
  validateIdentityBindingKey(key);
  const document = await bindingDocument(root, fs);
  return boundIdentity(document, key);
}

function boundIdentity(
  document: Table | null,
  key: string,
): { entry: string; record: IdentityRecord } | null {
  const entry = bindingsFor(document).get(key);
  if (entry === undefined) return null;
  const record = recordFor(document, entry);
  if (!record.entryExists || !record.name || !isAgentName(record.name) || record.problems.length)
    throw new ConfigError(
      "identity-unresolved",
      "The active identity binding has no valid canonical agent entry.",
      "Repair the selected identity entry or choose it explicitly with --entry KEY; no replacement name was allocated.",
    );
  return { entry, record };
}

const agentKeys = (document: Table | null): string[] =>
  document !== null && isTable(document.agents) ? Object.keys(document.agents) : [];

/** Canonical entry keys, bindings and bound record from one atomic document snapshot.
 * Legacy keys are needed only for an unbound session; their values never leave this reader.
 */
export async function readIdentityBindingSelection(
  root: string,
  key: string,
  fs: ConfigFileSystem = nodeFileSystem,
): Promise<{
  bindings: ReadonlyMap<string, string>;
  bound: { entry: string; record: IdentityRecord } | null;
  entries: string[];
}> {
  validateIdentityBindingKey(key);
  const document = await bindingDocument(root, fs);
  const bindings = bindingsFor(document);
  const bound = boundIdentity(document, key);
  const entries = agentKeys(document);
  if (bound) return { bindings, bound, entries };
  try {
    const raw = await fs.readText(join(root, LEGACY_IDENTITY_FILE));
    const legacy = agentKeys(raw === null ? null : parseLegacyIdentityDocument(raw));
    return { bindings, bound, entries: [...new Set([...entries, ...legacy])] };
  } catch (error) {
    throw error instanceof ConfigError ? error : unreadable(LEGACY_IDENTITY_FILE, error);
  }
}

/**
 * Entry keys present in pdb.toml and in a legacy agent-inbox.toml at the same root
 * (read-only; empty when both are absent). Only the keys are returned, never any entry's
 * values, so harness resolution (#38) can tell whether several logical entries share one
 * harness without seeing other agents' data. Both stores count because a legacy-only entry is
 * still a distinct logical agent that may be imported. A legacy file that cannot be read or
 * parsed throws (unknown is not absent) unless `canonical` (the entry key the caller would
 * select) is already in pdb.toml; explicit `--entry` does not need this list.
 */
export async function listEntryKeys(
  root: string,
  fs: ConfigFileSystem = nodeFileSystem,
  canonical?: string,
): Promise<string[]> {
  const raw = await fs.readText(join(root, IDENTITY_FILE));
  const keys = agentKeys(raw === null ? null : parseIdentityDocument(raw));
  let legacy: string[];
  try {
    const legacyRaw = await fs.readText(join(root, LEGACY_IDENTITY_FILE));
    legacy = agentKeys(legacyRaw === null ? null : parseLegacyIdentityDocument(legacyRaw));
  } catch (error) {
    // pdb.toml is canonical: once it holds the entry the caller would select, an unusable
    // legacy file is not needed to answer and must not block the lookup (#528 review).
    if (canonical !== undefined && keys.includes(canonical)) return keys;
    throw error instanceof ConfigError ? error : unreadable(LEGACY_IDENTITY_FILE, error);
  }
  return [...keys, ...legacy.filter((key) => !keys.includes(key))];
}

/** Read-only service for consumers (#38 detection, #64 doctor, #25 MCP): resolve then read. */
export async function lookupIdentity(options: {
  readonly cwd: string;
  readonly entry: string;
  readonly repository?: string;
  readonly git?: GitService | GitRunner;
  readonly fs?: ConfigFileSystem;
}): Promise<IdentityRecord & { readonly repository: string | null }> {
  const target = await resolveIdentityTarget(options.cwd, options.repository, options.git);
  const record = await readIdentity(target.root, options.entry, options.fs);
  return { ...record, repository: target.repository };
}

/** The value a registered key reads from a record. */
export function identityValue(record: IdentityRecord, key: string): string | null {
  return identityKey(key).field === "name" ? record.name : record.triageRole;
}

// Human-like generated names: first_last, lower case, checked against local names.
const GIVEN = [
  "amara",
  "bilal",
  "chen",
  "dalia",
  "emeka",
  "farah",
  "goran",
  "hana",
  "idris",
  "jonas",
  "keiko",
  "lars",
  "mira",
  "nadia",
  "omar",
  "priya",
  "quinn",
  "rosa",
  "samir",
  "talia",
  "uma",
  "viktor",
  "wren",
  "xenia",
  "yusuf",
  "zara",
  "anouk",
  "bruno",
  "celeste",
  "dario",
];
const FAMILY = [
  "abara",
  "bianchi",
  "castell",
  "dimitrov",
  "eklund",
  "ferreira",
  "gallo",
  "haddad",
  "ivanova",
  "jensen",
  "kowalski",
  "lindqvist",
  "moreau",
  "nakamura",
  "okafor",
  "petrov",
  "quaresma",
  "rahman",
  "sato",
  "tanaka",
  "ueda",
  "varga",
  "weber",
  "xu",
  "yilmaz",
  "zeller",
];

/** Generate a human-like name not already used by any local entry (case-insensitive). */
export function generateName(taken: ReadonlySet<string>, random: () => number): string {
  const pick = (list: readonly string[]) => list[Math.floor(random() * list.length)]!;
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${pick(GIVEN)}_${pick(FAMILY)}`;
    if (!taken.has(name)) return name;
  }
  throw new ConfigError(
    "conflict",
    "Could not generate an unused agent name.",
    "Choose one explicitly with pdb config set identity.name NAME --entry KEY.",
  );
}

/**
 * Names of legacy entries that are still legacy-only: an entry whose key is already in pdb.toml
 * (imported or renamed there) has been replaced and no longer holds its legacy name.
 */
function legacyOnlyNames(legacy: Table | null, current: Table, except: string): Set<string> {
  const replaced = new Set(agentKeys(current));
  const taken = new Set<string>();
  const agents = legacy !== null && isTable(legacy.agents) ? legacy.agents : {};
  for (const [key, table] of Object.entries(agents)) {
    if (key !== except && !replaced.has(key) && isTable(table) && typeof table.name === "string") {
      taken.add(table.name.toLowerCase());
    }
  }
  return taken;
}

function namesInUse(document: Table | null, except: string, taken = new Set<string>()) {
  const agents = document !== null && isTable(document.agents) ? document.agents : {};
  for (const [key, table] of Object.entries(agents)) {
    if (key !== except && isTable(table) && typeof table.name === "string") {
      taken.add(table.name.toLowerCase());
    }
  }
  return taken;
}

/** A typed Git answer, or null when Git could not answer (unknown is never "no"). */
async function known(answer: () => Promise<boolean>): Promise<boolean | null> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof GitError && error.code === "cancelled") throw error;
    return null;
  }
}

/** The typed Git service for a caller's injection: a shared service, a legacy runner, or none. */
export function gitServiceOf(git?: GitService | GitRunner): GitService {
  return typeof git === "object" ? git : createGitService(typeof git === "function" ? { git } : {});
}

/** Git standing of an identity file (pdb.toml by default): tracked, ignored, or neither. */
export async function identityGitState(
  root: string,
  git?: GitService | GitRunner,
  file: string = IDENTITY_FILE,
): Promise<{ tracked: boolean | null; ignored: boolean | null }> {
  const service = gitServiceOf(git);
  const context = { cwd: root };
  return {
    tracked: await known(() => service.isTracked(context, file)),
    ignored: await known(() => service.isIgnored(context, file)),
  };
}

/** Exclude rules this tool may add: the identity file and its same-directory temporary copies. */
const IDENTITY_RULE = `/${IDENTITY_FILE}`;
const TEMPORARY_RULE = `/${IDENTITY_FILE}.*.tmp`;
/** Root-relative lock serialising writers of the identity file (#165 review). */
export const IDENTITY_LOCK_FILE = `${IDENTITY_FILE}.lock`;
const LOCK_RULE = `/${IDENTITY_LOCK_FILE}`;
/**
 * Writers hold the lock only for local file reads, an import's Git tracking check and one
 * rename, so a few seconds is ample for an interactive command. The lock is never broken by
 * age (#382): an old-looking lock may belong to a live, slow writer, so a lock held beyond the
 * wait is reported as busy with manual recovery instead.
 */
export const IDENTITY_LOCK_TIMING: LockTiming = {
  waitMs: 5_000,
  staleMs: Number.POSITIVE_INFINITY,
  pollMs: 25,
};

/** Root-relative temporary copy name; always matched by `TEMPORARY_RULE`. */
export const temporaryIdentityName = (token: string): string => `${IDENTITY_FILE}.${token}.tmp`;

async function ignoredByGit(
  git: GitService | GitRunner,
  root: string,
  name: string,
): Promise<boolean | null> {
  return known(() => gitServiceOf(git).isIgnored({ cwd: root }, name));
}

/**
 * Ensure the identity file, its temporary copy AND its lock file are Git-ignored before any write. Reuses
 * existing ignore coverage; otherwise appends rules to the repository-local `info/exclude`
 * resolved by Git. The temporary copy holds the whole document (possibly other tools'
 * credentials) and lives beside the identity file so the final rename stays atomic on one
 * filesystem, so it must be ignored too: a copy left by an interrupted write is never
 * offered to a bulk `git add`. The exclude file is only appended to (never read-and-replaced),
 * so concurrent additions by other tools or linked worktrees are kept. A tracked file is
 * refused (never untracked, committed or deleted). Returns whether a rule was added.
 */
export async function ensureExcluded(
  root: string,
  git: GitService | GitRunner,
  fs: ConfigFileSystem,
  temporaryName: string,
): Promise<boolean> {
  const state = await identityGitState(root, git);
  if (state.tracked === true) {
    throw new ConfigError(
      "tracked",
      `${IDENTITY_FILE} is tracked by Git; local identity must not be versioned, so it was not changed.`,
      `Decide yourself whether to untrack it (for example: git rm --cached -- ${IDENTITY_FILE}) and commit that, then retry. This tool never untracks, commits or deletes it.`,
    );
  }
  const temporaryIgnored = await ignoredByGit(git, root, temporaryName);
  const lockIgnored = await ignoredByGit(git, root, IDENTITY_LOCK_FILE);
  if (
    state.tracked === null ||
    state.ignored === null ||
    temporaryIgnored === null ||
    lockIgnored === null
  ) {
    throw new ConfigError(
      "filesystem",
      `Could not determine whether ${IDENTITY_FILE} is tracked or ignored by Git; nothing was changed.`,
      "Check that git works in this checkout, then retry.",
    );
  }
  const missing = [
    ...(state.ignored ? [] : [IDENTITY_RULE]),
    ...(temporaryIgnored ? [] : [TEMPORARY_RULE]),
    ...(lockIgnored ? [] : [LOCK_RULE]),
  ];
  if (missing.length === 0) return false;
  if (!fs.appendText) {
    throw new ConfigError(
      "filesystem",
      `Cannot add a local Git exclude rule for ${IDENTITY_FILE} here; nothing was written.`,
      `Add ${missing.join(" and ")} to .git/info/exclude yourself, then retry.`,
    );
  }
  let excludePath = await gitServiceOf(git).gitPath({ cwd: root }, "info/exclude");
  if (!excludePath)
    throw new ConfigError(
      "filesystem",
      `Could not locate this checkout's info/exclude file; nothing was written.`,
      `Add the rules to .git/info/exclude yourself, then retry.`,
    );
  if (!isAbsolute(excludePath)) excludePath = join(root, excludePath);
  const existing = (await fs.readText(excludePath)) ?? "";
  const lines = existing.split(/\r?\n/);
  const rules = missing.filter((rule) => !lines.includes(rule));
  if (rules.length > 0) {
    await fs.makeDirectory(dirname(excludePath));
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await fs.appendText(excludePath, `${separator}${rules.join("\n")}\n`);
  }
  const after = await identityGitState(root, git);
  if (
    after.ignored !== true ||
    (await ignoredByGit(git, root, temporaryName)) !== true ||
    (await ignoredByGit(git, root, IDENTITY_LOCK_FILE)) !== true
  ) {
    throw new ConfigError(
      "not-ignored",
      `${IDENTITY_FILE}, its temporary copy or its lock is still not ignored after adding a local exclude rule (a negated ignore pattern may re-include it); nothing was written.`,
      `Remove the rule that re-includes ${IDENTITY_FILE}, ${TEMPORARY_RULE} or ${LOCK_RULE} from your ignore files, then retry.`,
    );
  }
  return true;
}

/**
 * smol-toml's TomlDate keeps only milliseconds, so a date-time/time literal with non-zero
 * sub-millisecond digits would be silently rounded by a rewrite. Refuse instead (#165 review).
 * Checked per occurrence, not per substring: string contents survive serialisation verbatim,
 * while a rounded literal loses its digits, so any drop in the occurrence count of a
 * high-precision time means a value would change.
 */
function assertLosslessRewrite(raw: string | null, text: string): void {
  if (raw === null) return;
  const pattern = /\d{2}:\d{2}:\d{2}\.\d{3}(\d+)/g;
  const count = (source: string, needle: string) => source.split(needle).length - 1;
  for (const match of raw.matchAll(pattern)) {
    if (/[1-9]/.test(match[1]!) && count(text, match[0]) < count(raw, match[0])) {
      throw new ConfigError(
        "incompatible",
        `${IDENTITY_FILE} contains a date or time with sub-millisecond precision that cannot be rewritten without changing it; nothing was changed.`,
        `Edit ${IDENTITY_FILE} by hand to set the identity value, or shorten that timestamp to milliseconds if the precision is not needed, then retry.`,
      );
    }
  }
}

export interface IdentityWriteOptions {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitService | GitRunner;
  /** Random source for name generation; injected for deterministic tests. */
  readonly random?: () => number;
  /** Unique temporary-file suffix; injected for deterministic tests. */
  readonly token?: () => string;
  /** Optional precondition: the raw text (null when absent) the caller observed earlier. */
  readonly expectedRaw?: string | null;
  /** Lock wait bound; injected for tests. The lock is never broken by age (#382). */
  readonly lockTiming?: Omit<LockTiming, "staleMs">;
  /**
   * `setup identity` (#314): refuse, before anything is written, an existing entry without a
   * valid name; this writer generates names only for absent entries, so setup could not finish.
   */
  readonly requireName?: boolean;
  /** Automatic setup reuses a valid name/default role won by an earlier writer. */
  readonly reuseExistingIdentity?: boolean;
  /** #677: persist a verified local binding in the same replacement as its identity. */
  readonly binding?: {
    readonly key: string;
    readonly expectedEntry: string | null;
    readonly allowRebind?: boolean;
  };
}

export interface IdentityWriteResult {
  /** #382: the write succeeded but its lock could not be removed (with the recovery step). */
  readonly lockCleanup?: string;
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly createdEntry: boolean;
  /** The name generated by the initializer for a new entry, if any. */
  readonly generatedName: string | null;
  /** The legacy file a new entry's name/triage_role were imported from, if any (read only). */
  readonly importedFrom: typeof LEGACY_IDENTITY_FILE | null;
  /**
   * Why an unusable legacy agent-inbox.toml was ignored when an explicit `identity.name` created
   * the entry (nothing imported, the legacy file unchanged); null otherwise.
   */
  readonly legacyIgnored: string | null;
  /**
   * Why an explicit name could not be checked against names in agent-inbox.toml (the file
   * exists but is unreadable or malformed, so its names are unknown); null when it was checked
   * or there is no legacy file.
   */
  readonly legacyNamesUnchecked: string | null;
  /** Whether a repository-local exclude rule was added before writing. */
  readonly excluded: boolean;
  readonly record: IdentityRecord;
}

const busy = (): ConfigError =>
  new ConfigError(
    "conflict",
    `Another update to ${IDENTITY_FILE} is in progress (${IDENTITY_LOCK_FILE} is held); nothing was changed.`,
    `Retry the command. The lock is never removed automatically: if no pdb command is still running (for example one crashed), delete ${IDENTITY_LOCK_FILE} at the repository root yourself, then retry.`,
  );

/** Lock operations over the identity filesystem boundary (exclusive create via writeText). */
function lockFs(fs: ConfigFileSystem): LockFs {
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    async readFile(path) {
      const text = await fs.readText(path);
      if (text === null) throw missing();
      return text;
    },
    writeFile: (path, data) => fs.writeText(path, data),
    unlink: (path) => fs.remove(path),
    async stat(path) {
      const at = await fs.modifiedAt?.(path);
      if (at === null) throw missing();
      if (at !== undefined) return { mtimeMs: at };
      // No mtime available (test doubles): use the holder's own timestamp.
      const text = await fs.readText(path);
      if (text === null) throw missing();
      try {
        const parsed = JSON.parse(text) as { at?: unknown };
        return { mtimeMs: typeof parsed.at === "number" ? parsed.at : 0 };
      } catch {
        return { mtimeMs: 0 };
      }
    },
  };
}

const conflict = (): ConfigError =>
  new ConfigError(
    "conflict",
    `${IDENTITY_FILE} changed while this update was being prepared.`,
    "Retry the command; nothing was overwritten.",
  );

/**
 * Names held in a legacy agent-inbox.toml, for collision checks only (read only). `raw` is the
 * text the names came from (null when absent); `unknown` says why they cannot be known.
 */
type LegacyNames =
  | { readonly raw: string | null; readonly document: Table | null; readonly unknown: null }
  | { readonly raw: null; readonly document: null; readonly unknown: string };

async function readLegacyNames(root: string, fs: ConfigFileSystem): Promise<LegacyNames> {
  let raw: string | null;
  try {
    raw = await fs.readText(join(root, LEGACY_IDENTITY_FILE));
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? "error");
    return {
      raw: null,
      document: null,
      unknown: `${LEGACY_IDENTITY_FILE} could not be read (${code})`,
    };
  }
  if (raw === null) return { raw: null, document: null, unknown: null };
  try {
    return { raw, document: parseLegacyIdentityDocument(raw), unknown: null };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { raw: null, document: null, unknown: error.message };
  }
}

const legacyNameTaken = (name: string, holder: string): ConfigError =>
  new ConfigError(
    "conflict",
    `The name ${JSON.stringify(name)} is already held by another agent entry in ${LEGACY_IDENTITY_FILE}${holder}; nothing was changed.`,
    "Choose a different name; names identify one logical agent each, including agents not yet imported from the legacy file.",
  );

/** A legacy entry to import into a new pdb.toml entry, with the bytes it was read from. */
interface LegacyImport {
  readonly raw: string;
  readonly name: string;
  readonly triageRole: TriageRole | null;
}

/** An unusable legacy file; `reason` states why without claiming what was (not) written. */
class LegacyRefusal extends ConfigError {
  readonly reason: string;
  constructor(reason: string, recovery: string) {
    super(
      "legacy-unsafe",
      `${reason}; nothing was imported and neither file was changed.`,
      recovery,
    );
    this.reason = reason;
  }
}

const legacyRefusal = (detail: string, recovery?: string): ConfigError =>
  new LegacyRefusal(
    `${LEGACY_IDENTITY_FILE} ${detail}`,
    recovery ??
      `Fix ${LEGACY_IDENTITY_FILE} by hand, or set the name explicitly with pdb config set identity.name NAME --entry KEY, then retry. pdb never writes ${LEGACY_IDENTITY_FILE}.`,
  );

/**
 * Read the selected entry of a legacy agent-inbox.toml for a one-time import. Read only: no
 * lock, write or Git change is ever made to the legacy file. `found` is null when the file or
 * the entry is absent, or the entry has no name; `document` (the parsed legacy file, or null
 * when absent) lets a generated name avoid legacy names too. Anything that cannot be judged safe (unreadable,
 * malformed, symlinked, tracked, Git state unknown, invalid name) refuses instead of letting a
 * generated name hide the existing identity.
 */
async function readLegacyImport(
  root: string,
  entry: string,
  fs: ConfigFileSystem,
  git: GitService | GitRunner,
): Promise<{ found: LegacyImport | null; document: Table | null }> {
  const path = join(root, LEGACY_IDENTITY_FILE);
  let raw: string | null;
  try {
    raw = await fs.readText(path);
  } catch (error) {
    throw legacyRefusal(
      `could not be read (${String((error as NodeJS.ErrnoException).code ?? "error")})`,
    );
  }
  if (raw === null) return { found: null, document: null };
  if ((await fs.isSymbolicLink?.(path)) === true) {
    throw legacyRefusal("is a symbolic link, so it is not imported");
  }
  const document = parseLegacyIdentityDocument(raw);
  const record = recordFor(document, entry, LEGACY_IDENTITY_FILE);
  if (!record.entryExists) return { found: null, document };
  if (record.problems.some((problem) => problem.endsWith("is not a table."))) {
    throw legacyRefusal(`[agents.${entry}] is not a table`);
  }
  const table = (document.agents as Table)[entry] as Table;
  if (table.name === undefined) return { found: null, document };
  if (record.name === null || !isAgentName(record.name)) {
    throw legacyRefusal(`[agents.${entry}] has a name that is not a valid agent name`);
  }
  const state = await identityGitState(root, git, LEGACY_IDENTITY_FILE);
  if (state.tracked === null) {
    throw legacyRefusal(
      "could not be checked for Git tracking",
      "Check that git works in this checkout, then retry.",
    );
  }
  if (state.tracked) {
    throw legacyRefusal(
      "is tracked by Git, so its identity is not private",
      `Decide yourself whether to untrack ${LEGACY_IDENTITY_FILE} (pdb never untracks, commits or writes it), or set the name explicitly with pdb config set identity.name NAME --entry KEY, then retry.`,
    );
  }
  return { found: { raw, name: record.name, triageRole: record.triageRole }, document };
}

/**
 * Set one registered identity setting on the selected entry of pdb.toml, preserving all other
 * data. Resolution for an entry absent from pdb.toml, under the lock:
 * 1. a valid matching legacy agent-inbox.toml entry supplies the name (unless this call sets
 *    `identity.name` explicitly) and a valid triage_role (unless this call sets it) — a
 *    one-time import, read only, never written back;
 * 2. otherwise setting `identity.triage_role` generates a locally unique name once.
 * A valid existing pdb.toml name is never regenerated or replaced by legacy data, and a
 * present-but-invalid pdb.toml entry is never silently replaced. Equal writes are no-ops.
 *
 * Several agents share one file, so read → resolve/import/generate → validate → write → rename
 * runs under a repository-local cross-process lock (`pdb.toml.lock`, Git-ignored before it is
 * created). The document is read only after the lock is taken, so a concurrent update to
 * another entry is merged rather than reverted, and a second same-entry initializer reuses the
 * first one's name. Before the rename, pdb.toml must be unchanged since it was read and an
 * imported legacy file must still hold the bytes imported. The lock is never broken by age; a
 * lock held beyond the wait refuses with a `conflict` (busy) error. The lock is always released.
 */
export async function setIdentity(
  target: IdentityTarget,
  entry: string,
  key: string,
  value: string,
  options: IdentityWriteOptions = {},
): Promise<IdentityWriteResult> {
  validateEntryKey(entry);
  if (options.binding) {
    validateIdentityBindingKey(options.binding.key);
    if (options.binding.expectedEntry !== null) validateEntryKey(options.binding.expectedEntry);
  }
  const field = identityKey(key).field;
  validateIdentityValue(key, value);
  const fs = options.fs ?? nodeFileSystem;
  const git = gitServiceOf(options.git);
  const token =
    options.token ?? (() => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const path = join(target.root, IDENTITY_FILE);
  const lockPath = join(target.root, IDENTITY_LOCK_FILE);

  // Never follow a symbolic link out of the verified project (a rename would replace the link,
  // a lock/temp create would follow it).
  for (const candidate of [path, lockPath]) {
    if ((await fs.isSymbolicLink?.(candidate)) === true) {
      throw new ConfigError(
        "unsafe-path",
        `${candidate === path ? IDENTITY_FILE : IDENTITY_LOCK_FILE} is a symbolic link; pdb does not write through links, so nothing was changed.`,
        `Replace the link with a regular file (or remove it) at the repository root yourself, then retry.`,
      );
    }
  }

  // Exclusion of the file, its temporary copy and the lock is established before any of them
  // is written, and before the lock is taken (Git is slow; the lock is held only briefly).
  const temporaryName = temporaryIdentityName(token());
  const excluded = await ensureExcluded(target.root, git, fs, temporaryName);
  const timing = options.lockTiming ?? IDENTITY_LOCK_TIMING;
  const release = await acquireFileLock(
    lockFs(fs),
    lockPath,
    { ...timing, staleMs: Number.POSITIVE_INFINITY },
    Date.now,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  if (release === null) throw busy();
  let result: IdentityWriteResult;
  try {
    result = await writeLocked();
  } catch (error) {
    // The primary failure stands; a cleanup problem never replaces it.
    await release();
    throw error;
  }
  // #382: a lock that could not be removed is reported with the successful write, not hidden.
  const cleanup = releaseProblem(IDENTITY_LOCK_FILE, await release());
  return cleanup ? { ...result, lockCleanup: cleanup } : result;

  async function writeLocked(): Promise<IdentityWriteResult> {
    const raw = await fs.readText(path);
    if (options.expectedRaw !== undefined && raw !== options.expectedRaw) throw conflict();
    const document: Table = raw === null ? Object.create(null) : parseIdentityDocument(raw);
    const before = recordFor(raw === null ? null : document, entry);
    if (before.entryExists && !isTable((document.agents as Table)[entry])) {
      throw malformed(`agents.${entry} is not a table.`);
    }
    // Checked under the lock, against the document about to be rewritten: nothing is written.
    if (options.requireName && before.entryExists && (!before.name || !isAgentName(before.name)))
      throw new ConfigError(
        "invalid-value",
        `Entry [agents.${entry}] in ${IDENTITY_FILE} has no valid name, so no identity was set up and nothing was changed.`,
        `Set one explicitly: pdb config set identity.name NAME --entry ${entry}`,
      );
    if (
      field === "name" &&
      !options.reuseExistingIdentity &&
      namesInUse(document, entry).has(value.toLowerCase())
    ) {
      throw new ConfigError(
        "conflict",
        `Another local agent entry already uses the name ${JSON.stringify(value)}.`,
        "Choose a different name; names identify one logical agent each.",
      );
    }
    let nextValue =
      options.reuseExistingIdentity && field === "name" && before.name
        ? before.name
        : options.reuseExistingIdentity && field === "triage_role" && before.triageRole
          ? before.triageRole
          : value;
    const bindings = options.binding ? bindingsFor(document) : new Map<string, string>();
    const currentBinding = options.binding ? (bindings.get(options.binding.key) ?? null) : null;
    if (options.binding) {
      if (currentBinding !== options.binding.expectedEntry && currentBinding !== entry)
        throw conflict();
      if (currentBinding !== null && currentBinding !== entry && !options.binding.allowRebind)
        throw conflict();
      if (currentBinding === entry && !before.entryExists)
        throw new ConfigError(
          "identity-unresolved",
          "The active binding points to a missing canonical entry.",
          "Repair the existing identity before retrying; no replacement name was allocated.",
        );
    }
    const bindingChanged = options.binding !== undefined && currentBinding !== entry;
    if (before.entryExists && identityValue(before, key) === nextValue && !bindingChanged) {
      // An unchanged value needs no collision check against the legacy file.
      // An unchanged value still refused a tracked file and established missing exclusion
      // above; the identity contents are left untouched.
      return {
        changed: false,
        createdFile: false,
        createdEntry: false,
        generatedName: null,
        importedFrom: null,
        legacyIgnored: null,
        legacyNamesUnchecked: null,
        excluded,
        record: before,
      };
    }

    let imported: LegacyImport | null = null;
    let legacyIgnored: string | null = null;
    // Names of agents that exist only in the legacy file must not be duplicated (#528 review).
    const legacyNames = await readLegacyNames(target.root, fs);
    const legacyTaken = (name: string) =>
      legacyOnlyNames(legacyNames.document, document, entry).has(name.toLowerCase());
    let legacyNamesUnchecked: string | null = null;
    if (field === "name") {
      if (!options.reuseExistingIdentity && legacyTaken(value)) throw legacyNameTaken(value, "");
      legacyNamesUnchecked = legacyNames.unknown;
    }
    let generatedName: string | null = null;
    if (!document.agents || !isTable(document.agents)) document.agents = Object.create(null);
    const agents = document.agents as Table;
    if (!before.entryExists) {
      let legacy: { found: LegacyImport | null; document: Table | null };
      try {
        legacy = await readLegacyImport(target.root, entry, fs, git);
      } catch (error) {
        // An explicit name is the way out of an unusable legacy file: nothing is imported or
        // generated, so nothing can hide the legacy identity. Other writes still refuse.
        if (field !== "name" || !(error instanceof ConfigError)) throw error;
        legacyIgnored = error instanceof LegacyRefusal ? error.reason : error.message;
        legacy = { found: null, document: null };
      }
      imported = legacy.found;
      if (options.reuseExistingIdentity && field === "name" && imported) nextValue = imported.name;
      const table: Table = Object.create(null);
      if (imported !== null) {
        if (field !== "name") {
          if (namesInUse(document, entry).has(imported.name.toLowerCase())) {
            throw new ConfigError(
              "conflict",
              `The name ${JSON.stringify(imported.name)} of [agents.${entry}] in ${LEGACY_IDENTITY_FILE} is already used by another entry in ${IDENTITY_FILE}; nothing was imported.`,
              `Resolve it explicitly: choose a different name with pdb config set identity.name NAME --entry ${entry}, or correct the other entry, then retry.`,
            );
          }
          if (legacyTaken(imported.name)) {
            throw legacyNameTaken(imported.name, ` besides [agents.${entry}]`);
          }
          table.name = imported.name;
        }
        if (field !== "triage_role" && imported.triageRole !== null) {
          table.triage_role = imported.triageRole;
        }
      } else if (field === "triage_role") {
        generatedName = generateName(
          new Set([
            ...namesInUse(document, entry),
            ...legacyOnlyNames(legacy.document, document, entry),
          ]),
          options.random ?? Math.random,
        );
        table.name = generatedName;
      }
      agents[entry] = table;
    }
    if (options.reuseExistingIdentity && field === "name") {
      if (namesInUse(document, entry).has(nextValue.toLowerCase()))
        throw new ConfigError(
          "conflict",
          "The selected identity name is already used by another entry.",
          "Repair the duplicate identity before retrying.",
        );
      if (legacyTaken(nextValue)) throw legacyNameTaken(nextValue, "");
    }
    (agents[entry] as Table)[field] = nextValue;
    if (options.binding && bindingChanged) {
      const table = isTable(document.agentBindings)
        ? document.agentBindings
        : (Object.create(null) as Table);
      table[options.binding.key] = entry;
      document.agentBindings = table;
    }
    const text = serializeIdentityDocument(document);
    assertLosslessRewrite(raw, text);

    const legacyCheckNeeded =
      imported !== null ||
      (legacyNames.unknown === null && (generatedName !== null || field === "name"));
    await replaceIdentityFile(target.root, fs, raw, text, temporaryName, async () => {
      // Collision checks and imports relied on the legacy bytes: they must be unchanged.
      // Unknown legacy names were never relied on, so there is nothing to recheck then.
      if (!legacyCheckNeeded) return;
      const legacyNow = await fs.readText(join(target.root, LEGACY_IDENTITY_FILE));
      if (
        (legacyNames.unknown === null && legacyNow !== legacyNames.raw) ||
        (imported !== null && legacyNow !== imported.raw)
      ) {
        throw new ConfigError(
          "conflict",
          `${LEGACY_IDENTITY_FILE} changed while this update was checking or importing its identities; nothing was written.`,
          "Retry the command to import the current legacy identity.",
        );
      }
    });
    return {
      changed: true,
      createdFile: raw === null,
      createdEntry: !before.entryExists,
      generatedName,
      importedFrom: imported === null ? null : LEGACY_IDENTITY_FILE,
      legacyIgnored,
      legacyNamesUnchecked,
      excluded,
      record: recordFor(parseIdentityDocument(text), entry),
    };
  }
}

/**
 * Atomically replace the private identity file with `text` (shared by every identity writer):
 * write a private temporary copy, verify the file is still `raw` and run `beforeRename` (further
 * unchanged-input checks), rename it into place and restore the private mode. Any failure
 * removes the temporary copy and leaves the original file untouched.
 */
async function replaceIdentityFile(
  root: string,
  fs: ConfigFileSystem,
  raw: string | null,
  text: string,
  temporaryName: string,
  beforeRename: () => Promise<void>,
): Promise<void> {
  const path = join(root, IDENTITY_FILE);
  // The file holds private names: keep it private. A new file is 0600; a replaced file keeps
  // its original mode, and the temporary copy is never more permissive than either. Mode
  // handling is a no-op where unsupported (Windows).
  const originalMode = raw === null ? null : ((await fs.fileMode?.(path)) ?? null);
  const finalMode = originalMode ?? PRIVATE_FILE_MODE;
  const temporary = join(root, temporaryName);
  try {
    await fs.writeText(temporary, text, finalMode & PRIVATE_FILE_MODE);
  } catch (error) {
    // A failed or partial write must not leave a copy behind; an existing file is not ours.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.remove(temporary).catch(() => undefined);
    }
    throw error;
  }
  try {
    if ((await fs.readText(path)) !== raw) throw conflict();
    await beforeRename();
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined);
    throw error;
  }
  await fs.setFileMode?.(path, finalMode);
}

/** The automatic session entry key format (#677): `<harness>.session_<sha256 hex>`. */
const sessionEntry = (harness: string) => new RegExp(`^${harness}\\.session_[0-9a-f]{64}$`);

export type SessionMigration =
  /** A valid canonical entry exists: it is the default; nothing was written. */
  | {
      readonly state: "canonical";
      readonly record: IdentityRecord;
      /** Recognized automatic bindings that still name another entry; reported, not rewritten. */
      readonly obsoleteBindings: number;
    }
  /** Recognized legacy session records agreed; the canonical entry was created from them. */
  | {
      readonly state: "migrated";
      readonly record: IdentityRecord;
      readonly retargeted: number;
      readonly lockCleanup?: string;
    }
  /** Neither a canonical entry nor recognized legacy session records exist. */
  | { readonly state: "none" };

/**
 * #1047 (doc/design/stable-harness-identity.md): establish the canonical default entry for a
 * harness from its recognized automatic session records, under the identity lock. Recognized
 * means a binding whose key is `<provider>_…` and whose value is a `<harness>.session_<hex>` entry
 * present in the file; nothing is found by agent name or by flattening every `<harness>.*` key.
 *
 * - A valid canonical entry wins and nothing is written.
 * - Otherwise, if the recognized records agree on one valid name and role, the canonical entry is
 *   created with that pair and only the recognized bindings are retargeted to it, in one guarded
 *   replacement. Legacy entries and every other setting are preserved.
 * - Different names or roles, an invalid record, or a canonical entry without a valid name stop
 *   with the candidate keys and the exact commands to resolve it; nothing is guessed or merged.
 */
export async function migrateSessionIdentity(
  target: IdentityTarget,
  harness: string,
  bindingPrefix: string,
  options: Pick<IdentityWriteOptions, "fs" | "git" | "token" | "lockTiming"> = {},
): Promise<SessionMigration> {
  validateEntryKey(harness);
  const fs = options.fs ?? nodeFileSystem;
  const recognize = (document: Table | null) => {
    const pattern = sessionEntry(harness);
    const agents = document !== null && isTable(document.agents) ? document.agents : {};
    const bindings = [...bindingsFor(document)].filter(
      ([key, entry]) =>
        key.startsWith(`${bindingPrefix}_`) && pattern.test(entry) && entry in agents,
    );
    return { bindings, entries: [...new Set(bindings.map(([, entry]) => entry))].sort() };
  };
  const decide = (
    document: Table | null,
  ):
    | SessionMigration
    | { state: "write"; name: string; role: TriageRole | null; legacy: string[] } => {
    const canonical = recordFor(document, harness);
    const { bindings, entries } = recognize(document);
    if (canonical.entryExists) {
      if (!canonical.name || !isAgentName(canonical.name) || canonical.problems.length)
        throw new ConfigError(
          "identity-unresolved",
          `The default entry [agents.${harness}] has no valid agent name; no replacement was allocated.`,
          `Repair it with pdb config set identity.name NAME --entry ${harness}, then retry.`,
        );
      return {
        state: "canonical",
        record: canonical,
        obsoleteBindings: bindings.filter(([, entry]) => entry !== harness).length,
      };
    }
    if (!entries.length) return { state: "none" };
    const records = entries.map((entry) => ({ entry, record: recordFor(document, entry) }));
    const pairs = new Set(
      records.map(({ record }) => JSON.stringify([record.name, record.triageRole])),
    );
    const invalid = records.some(
      ({ record }) => !record.name || !isAgentName(record.name) || record.problems.length,
    );
    if (invalid || pairs.size !== 1) {
      const first = records.find(({ record }) => record.name && isAgentName(record.name))?.record;
      throw new ConfigError(
        "identity-unresolved",
        `Earlier sessions recorded ${entries.length} automatic identit${entries.length === 1 ? "y" : "ies"} (${entries.join(", ")}) that ${invalid ? "include an invalid record" : "disagree on name or role"}; the default [agents.${harness}] was not created and nothing was merged or renamed.`,
        `Choose the default explicitly: pdb config set identity.name ${first?.name ?? "NAME"} --entry ${harness} and pdb config set identity.triage_role ${first?.triageRole ?? "ROLE"} --entry ${harness}, then retry.`,
      );
    }
    return {
      state: "write",
      name: records[0]!.record.name!,
      role: records[0]!.record.triageRole,
      legacy: entries,
    };
  };

  const path = join(target.root, IDENTITY_FILE);
  // A read decides first; only a needed migration takes the lock and re-decides under it.
  const firstRaw = await fs.readText(path);
  const initial = decide(firstRaw === null ? null : parseIdentityDocument(firstRaw));
  if (initial.state !== "write") return initial;

  for (const candidate of [path, join(target.root, IDENTITY_LOCK_FILE)])
    if ((await fs.isSymbolicLink?.(candidate)) === true)
      throw new ConfigError(
        "unsafe-path",
        `${candidate === path ? IDENTITY_FILE : IDENTITY_LOCK_FILE} is a symbolic link; pdb does not write through links, so nothing was changed.`,
        "Replace the link with a regular file (or remove it) at the repository root yourself, then retry.",
      );
  const git = gitServiceOf(options.git);
  const token =
    options.token ?? (() => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const temporaryName = temporaryIdentityName(token());
  await ensureExcluded(target.root, git, fs, temporaryName);
  const timing = options.lockTiming ?? IDENTITY_LOCK_TIMING;
  const release = await acquireFileLock(
    lockFs(fs),
    join(target.root, IDENTITY_LOCK_FILE),
    { ...timing, staleMs: Number.POSITIVE_INFINITY },
    Date.now,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  if (release === null) throw busy();
  let result: SessionMigration;
  try {
    const raw = await fs.readText(path);
    const document: Table = raw === null ? Object.create(null) : parseIdentityDocument(raw);
    // A concurrent initializer may have won: reconcile against what is actually there now.
    const decision = decide(raw === null ? null : document);
    if (decision.state !== "write") result = decision;
    else {
      const legacy = new Set(decision.legacy);
      const agents = document.agents as Table;
      const takenElsewhere = new Set<string>();
      for (const [key, table] of Object.entries(agents))
        if (key !== harness && !legacy.has(key) && isTable(table) && typeof table.name === "string")
          takenElsewhere.add(table.name.toLowerCase());
      const legacyNames = await readLegacyNames(target.root, fs);
      if (legacyNames.unknown !== null)
        throw new ConfigError(
          "identity-unresolved",
          "Legacy entries could not be checked before creating the default identity.",
          "Repair the legacy identity file or set the default entry explicitly.",
        );
      for (const name of legacyOnlyNames(legacyNames.document, document, harness))
        takenElsewhere.add(name);
      if (takenElsewhere.has(decision.name.toLowerCase()))
        throw new ConfigError(
          "conflict",
          `The name ${JSON.stringify(decision.name)} recorded by earlier sessions is used by another entry; the default was not created.`,
          `Choose the default explicitly: pdb config set identity.name NAME --entry ${harness}, then retry.`,
        );
      const table: Table = Object.create(null);
      table.name = decision.name;
      if (decision.role !== null) table.triage_role = decision.role;
      agents[harness] = table;
      const bindingTable = document.agentBindings as Table;
      let retargeted = 0;
      for (const [key] of recognize(document).bindings) {
        bindingTable[key] = harness;
        retargeted++;
      }
      const text = serializeIdentityDocument(document);
      assertLosslessRewrite(raw, text);
      await replaceIdentityFile(target.root, fs, raw, text, temporaryName, async () => {
        if ((await fs.readText(join(target.root, LEGACY_IDENTITY_FILE))) !== legacyNames.raw)
          throw new ConfigError(
            "conflict",
            `${LEGACY_IDENTITY_FILE} changed while the default identity was being created; nothing was written.`,
            "Retry the command.",
          );
      });
      // Readback: the canonical entry must now hold exactly the agreed pair.
      const after = recordFor(parseIdentityDocument((await fs.readText(path)) ?? ""), harness);
      if (after.name !== decision.name || after.triageRole !== decision.role)
        throw new ConfigError(
          "identity-unresolved",
          "The default identity could not be verified after writing it.",
          "Inspect pdb.toml and set the default entry explicitly if needed.",
        );
      result = { state: "migrated", record: after, retargeted };
    }
  } catch (error) {
    await release();
    throw error;
  }
  const cleanup = releaseProblem(IDENTITY_LOCK_FILE, await release());
  return cleanup && result.state === "migrated" ? { ...result, lockCleanup: cleanup } : result;
}
