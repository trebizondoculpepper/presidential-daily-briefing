/**
 * Shared PDB installer ownership manifests and safe JSON/TOML entry edits (#767).
 *
 * Contracts: doc/design/codex-installer.md ("Ownership and replacement", "File edits") and
 * doc/design/attended-installer-delivery.md. Reuses `updateJsonFile` and `updateTextFile`
 * (`src/config/safejson.ts`), refuses symlinks and path escapes (`UNSAFE_PATH`), validates
 * before/after structures, and preserves unrelated bytes, comments, and entries.
 */
import { createHash } from "node:crypto";
import { lstat as fsLstat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { nodeGit, type GitRunner } from "../config/config.js";
import { nodeSafeFs, updateJsonFile, updateTextFile } from "../config/safejson.js";
import type { SafeFs, WriteOutcome } from "../config/safejson.js";

export type InstallItemKind = "hook" | "mcp";
export type EntryOwnership = "owned" | "edited" | "foreign" | "absent" | "missing";

export type InstallScope =
  | { kind: "project"; root: string; gitCommonDir: string }
  | { kind: "global"; stateDir: string; homeDir: string };

export interface ManifestRecord {
  file: string;
  kind: InstallItemKind;
  format: "json" | "toml";
  canonicalText: string;
  sha256: string;
  pdbVersion: string;
  recordedAt: string;
}

export interface InstallManifest {
  schemaVersion: 1;
  client: string;
  records: Record<string, ManifestRecord>;
}

export type InstallEditErrorCode =
  | "UNSAFE_PATH"
  | "MALFORMED_MANIFEST"
  | "FUTURE_MANIFEST_VERSION"
  | "MALFORMED_CONFIG"
  | "UNSUPPORTED_SCHEMA"
  | "OWNED_ENTRY_EDITED"
  | "FOREIGN_ENTRY"
  | "UNSAFE_TOML_EDIT"
  | "CONFLICT"
  | "WRITE_FAILED";

export type InstallEditOutcome =
  | "applied"
  | "kept"
  | "adopted"
  | "planned"
  | "refused"
  | "failed"
  | "committed-with-error";

export interface InstallEditResult {
  action: "create" | "replace" | "remove" | "kept" | "absent";
  outcome: InstallEditOutcome;
  ownership: EntryOwnership;
  code: InstallEditErrorCode | null;
  message: string;
  diff: string | null;
  manifestRecord: ManifestRecord | null;
}

export interface InstallFs extends SafeFs {
  lstat?: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
}

export interface ManifestRuntime {
  fs?: InstallFs;
  now?: () => Date;
  lockWaitMs?: number;
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Resolve `<git-common-dir>` for a verified project root. */
export async function resolveProjectGitCommonDir(
  projectRoot: string,
  git: GitRunner = nodeGit,
): Promise<string> {
  const raw = (await git(["rev-parse", "--git-common-dir"], projectRoot)).trim();
  if (!raw) throw new Error(`Cannot resolve --git-common-dir for ${projectRoot}.`);
  return isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
}

/** Resolve the private user-wide state directory (`codex-installer.md`). */
export function defaultUserStateDir(
  env: Record<string, string | undefined> = process.env,
  homeDir = "",
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local && win32.isAbsolute(local)) return win32.resolve(local);
    return win32.resolve(homeDir, "AppData", "Local");
  }
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg && posix.isAbsolute(xdg)) return posix.resolve(xdg);
  return posix.resolve(homeDir, ".local", "state");
}

/** Private manifest path per scope and client. */
export function manifestPath(scope: InstallScope, client: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(client))
    throw new Error(`Invalid installer client name: ${JSON.stringify(client)}.`);
  const base = scope.kind === "project" ? scope.gitCommonDir : scope.stateDir;
  return join(base, "pdb", "install", `${client}.json`);
}

const isMissingError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

/**
 * Verify that `targetPath` is inside `allowedRoot` and has no symbolic link along its path
 * segments inside `allowedRoot` (or on `targetPath` itself). Throws with `UNSAFE_PATH` detail.
 */
export async function assertSafeInstallPath(
  targetPath: string,
  allowedRoot: string,
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }> = fsLstat,
): Promise<string> {
  const resolvedRoot = resolve(allowedRoot);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`UNSAFE_PATH: ${resolvedTarget} resolves outside ${resolvedRoot}.`);
  const segments = rel ? rel.split(sep).filter(Boolean) : [];
  let current = resolvedRoot;
  const check = async (pathToCheck: string) => {
    try {
      const stat = await lstat(pathToCheck);
      if (stat.isSymbolicLink()) throw new Error(`UNSAFE_PATH: ${pathToCheck} is a symbolic link.`);
    } catch (error) {
      if (isMissingError(error)) return;
      if (error instanceof Error && error.message.startsWith("UNSAFE_PATH:")) throw error;
      throw new Error(`UNSAFE_PATH: cannot inspect ${pathToCheck}.`);
    }
  };
  await check(current);
  for (const segment of segments) {
    current = join(current, segment);
    await check(current);
  }
  return resolvedTarget;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read and validate a private install manifest. Absent returns null. */
export async function readInstallManifest(
  path: string,
  fs: InstallFs = nodeSafeFs,
): Promise<
  | { status: "absent" }
  | { status: "ok"; manifest: InstallManifest; raw: string }
  | { status: "error"; code: "MALFORMED_MANIFEST" | "FUTURE_MANIFEST_VERSION"; message: string }
> {
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    if (isMissingError(error)) return { status: "absent" };
    return {
      status: "error",
      code: "MALFORMED_MANIFEST",
      message: `Cannot read install manifest ${path}: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "error",
      code: "MALFORMED_MANIFEST",
      message: `Install manifest ${path} is malformed JSON.`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      status: "error",
      code: "MALFORMED_MANIFEST",
      message: `Install manifest ${path} must be a JSON object.`,
    };
  }
  const version = parsed.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      status: "error",
      code: "MALFORMED_MANIFEST",
      message: `Install manifest ${path} has invalid schemaVersion.`,
    };
  }
  if (version > 1) {
    return {
      status: "error",
      code: "FUTURE_MANIFEST_VERSION",
      message: `Install manifest ${path} uses newer schemaVersion ${version}; upgrade pdb before editing.`,
    };
  }
  if (typeof parsed.client !== "string" || !isPlainObject(parsed.records)) {
    return {
      status: "error",
      code: "MALFORMED_MANIFEST",
      message: `Install manifest ${path} is missing client or records.`,
    };
  }
  return { status: "ok", manifest: parsed as unknown as InstallManifest, raw };
}

/** Persist one record update (or removal when `record === null`) into the private manifest. */
export async function writeInstallManifestRecord(
  path: string,
  client: string,
  itemKey: string,
  record: ManifestRecord | null,
  rt: ManifestRuntime = {},
): Promise<WriteOutcome> {
  const fs = rt.fs ?? nodeSafeFs;
  return updateJsonFile(
    path,
    (current) => {
      if (current.state === "unreadable") return { refuse: `MALFORMED_MANIFEST: ${current.why}` };
      let base: InstallManifest;
      if (current.state === "absent") {
        base = { schemaVersion: 1, client, records: {} };
      } else {
        if (!isPlainObject(current.value))
          return { refuse: "MALFORMED_MANIFEST: top-level value must be an object." };
        const v = current.value.schemaVersion;
        if (typeof v === "number" && v > 1)
          return { refuse: `FUTURE_MANIFEST_VERSION: schemaVersion ${v} is unsupported.` };
        if (typeof current.value.client !== "string" || !isPlainObject(current.value.records))
          return { refuse: "MALFORMED_MANIFEST: missing client or records." };
        base = {
          schemaVersion: 1,
          client: current.value.client,
          records: { ...(current.value.records as Record<string, ManifestRecord>) },
        };
      }
      if (record === null) delete base.records[itemKey];
      else base.records[itemKey] = record;
      return { write: base };
    },
    {
      fs,
      now: rt.now ? () => rt.now!().getTime() : undefined,
      lockWaitMs: rt.lockWaitMs,
    },
  );
}

/** Classify an entry's ownership against the manifest record and observed native file entry. */
export function classifyEntry(
  record: ManifestRecord | undefined,
  observedCanonicalText: string | null,
  looksForeign: boolean,
): EntryOwnership {
  if (record) {
    if (observedCanonicalText === null) return "missing";
    if (
      observedCanonicalText === record.canonicalText &&
      sha256Hex(observedCanonicalText) === record.sha256
    )
      return "owned";
    return "edited";
  }
  if (observedCanonicalText !== null && looksForeign) return "foreign";
  return "absent";
}

/** Produce a compact line-by-line preview diff between `before` and `after`. */
export function previewDiff(file: string, before: string | null, after: string | null): string {
  const oldLines = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const newLines = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  const header = `--- ${before === null ? "/dev/null" : file}\n+++ ${after === null ? "/dev/null" : file}`;
  const body = [...oldLines.map((l) => `- ${l}`), ...newLines.map((l) => `+ ${l}`)].join("\n");
  return `${header}\n${body}`;
}

export interface JsonEntryAdapter {
  kind: InstallItemKind;
  /** Extract the managed entry's canonical text (or null if absent) and whether it looks like PDB. */
  inspect(doc: Record<string, unknown>): {
    canonicalText: string | null;
    looksForeign: boolean;
  };
  /** Validate schema invariants before/after editing. Return error message or null if valid. */
  validateSchema?(doc: Record<string, unknown>): string | null;
  /** Produce the updated document with the managed entry installed/replaced. */
  apply(doc: Record<string, unknown>): Record<string, unknown>;
  /** Produce the updated document with only the owned entry removed. */
  remove(doc: Record<string, unknown>): Record<string, unknown>;
  /** Canonical JSON text of the entry being installed (stored in manifest). */
  desiredCanonicalText(): string;
}

function outcomeFromWrite(
  writeOutcome: WriteOutcome,
  action: InstallEditResult["action"],
  ownership: EntryOwnership,
  diff: string | null,
  manifestRecord: ManifestRecord | null,
): InstallEditResult {
  if (writeOutcome.status === "written")
    return {
      action,
      outcome: "applied",
      ownership,
      code: null,
      message: `${action} succeeded.`,
      diff,
      manifestRecord,
    };
  if (writeOutcome.status === "kept")
    return {
      action: "kept",
      outcome: "kept",
      ownership,
      code: null,
      message: writeOutcome.reason,
      diff: null,
      manifestRecord,
    };
  if (writeOutcome.status === "committed-with-error")
    return {
      action,
      outcome: "committed-with-error",
      ownership,
      code: "WRITE_FAILED",
      message: writeOutcome.reason,
      diff,
      manifestRecord,
    };
  const isConflict =
    writeOutcome.reason.startsWith("CONFLICT:") ||
    writeOutcome.reason.startsWith("the file changed while it was being updated");
  return {
    action,
    outcome: isConflict ? "refused" : "failed",
    ownership,
    code: isConflict ? "CONFLICT" : "WRITE_FAILED",
    message: writeOutcome.reason,
    diff: null,
    manifestRecord: null,
  };
}

/**
 * Plan or apply a safe JSON entry install/replace/adopt (`dryRun` never writes).
 * Preserves unrelated keys and key order; refuses symlinks, escapes, malformed JSON, and conflicts.
 */
export async function editJsonEntry(params: {
  file: string;
  allowedRoot: string;
  adapter: JsonEntryAdapter;
  manifestRecord: ManifestRecord | undefined;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  runtime?: ManifestRuntime;
}): Promise<InstallEditResult> {
  const fs: InstallFs = params.runtime?.fs ?? nodeSafeFs;
  const now = params.runtime?.now ?? (() => new Date());
  let safeFile: string;
  try {
    safeFile = await assertSafeInstallPath(params.file, params.allowedRoot, fs.lstat);
  } catch (error) {
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "UNSAFE_PATH",
      message: error instanceof Error ? error.message : String(error),
      diff: null,
      manifestRecord: null,
    };
  }

  let originalText: string | null = null;
  let doc: Record<string, unknown> = {};
  try {
    originalText = await fs.readFile(safeFile);
    const parsed: unknown = JSON.parse(originalText);
    if (!isPlainObject(parsed)) {
      return {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "UNSUPPORTED_SCHEMA",
        message: `${safeFile} must be a JSON object.`,
        diff: null,
        manifestRecord: null,
      };
    }
    doc = parsed;
  } catch (error) {
    if (!isMissingError(error)) {
      return {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "MALFORMED_CONFIG",
        message: `${safeFile} is malformed JSON: ${error instanceof Error ? error.message : String(error)}.`,
        diff: null,
        manifestRecord: null,
      };
    }
  }

  const schemaProblem = params.adapter.validateSchema?.(doc) ?? null;
  if (schemaProblem) {
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "UNSUPPORTED_SCHEMA",
      message: schemaProblem,
      diff: null,
      manifestRecord: null,
    };
  }

  const inspected = params.adapter.inspect(doc);
  const ownership = classifyEntry(
    params.manifestRecord,
    inspected.canonicalText,
    inspected.looksForeign,
  );
  const desired = params.adapter.desiredCanonicalText();

  // Adopt a foreign entry without touching the native file: record the observed
  // entry, so a later re-install can replace it (codex-installer.md "Ownership and replacement").
  if (ownership === "foreign" && params.adopt) {
    const record: ManifestRecord = {
      file: safeFile,
      kind: params.adapter.kind,
      format: "json",
      canonicalText: inspected.canonicalText ?? "",
      sha256: sha256Hex(inspected.canonicalText ?? ""),
      pdbVersion: params.pdbVersion,
      recordedAt: now().toISOString(),
    };
    return {
      action: "kept",
      outcome: "adopted",
      ownership,
      code: null,
      message: `Adopted existing foreign ${params.adapter.kind} entry in ${safeFile} without changing it.`,
      diff: null,
      manifestRecord: record,
    };
  }

  if (ownership === "edited") {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "OWNED_ENTRY_EDITED",
      message: `Owned ${params.adapter.kind} entry in ${safeFile} was edited outside pdb; restore or remove it before reinstalling.`,
      diff: previewDiff(safeFile, inspected.canonicalText, desired),
      manifestRecord: null,
    };
  }
  if (ownership === "foreign" && !params.adopt) {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "FOREIGN_ENTRY",
      message: `Existing ${params.adapter.kind} entry in ${safeFile} is not managed by pdb; rerun with --adopt to adopt it.`,
      diff: null,
      manifestRecord: null,
    };
  }

  // If adopting an existing foreign entry without replacing, record its observed text.
  if (ownership === "owned" && inspected.canonicalText === desired) {
    return {
      action: "kept",
      outcome: "kept",
      ownership,
      code: null,
      message: `${params.adapter.kind} entry in ${safeFile} is already owned and current.`,
      diff: null,
      manifestRecord: params.manifestRecord ?? null,
    };
  }

  const updatedDoc = params.adapter.apply(doc);
  const postSchemaProblem = params.adapter.validateSchema?.(updatedDoc) ?? null;
  if (postSchemaProblem) {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "UNSUPPORTED_SCHEMA",
      message: postSchemaProblem,
      diff: null,
      manifestRecord: null,
    };
  }
  const nextText = `${JSON.stringify(updatedDoc, null, 2)}\n`;
  const action = ownership === "owned" || ownership === "foreign" ? "replace" : "create";
  const diff = previewDiff(safeFile, originalText, nextText);
  const record: ManifestRecord = {
    file: safeFile,
    kind: params.adapter.kind,
    format: "json",
    canonicalText: desired,
    sha256: sha256Hex(desired),
    pdbVersion: params.pdbVersion,
    recordedAt: now().toISOString(),
  };

  if (params.dryRun) {
    return {
      action,
      outcome: "planned",
      ownership,
      code: null,
      message: `Planned ${action} of ${params.adapter.kind} in ${safeFile}.`,
      diff,
      manifestRecord: record,
    };
  }

  const writeOutcome = await updateTextFile(
    safeFile,
    (current) => {
      if (current.state === "unreadable") return { refuse: current.why };
      const currentText = current.state === "absent" ? null : current.text;
      if (currentText !== originalText)
        return { refuse: `CONFLICT: ${safeFile} changed concurrently before write.` };
      return { write: nextText };
    },
    {
      fs,
      now: () => now().getTime(),
      lockWaitMs: params.runtime?.lockWaitMs,
      checkUnchanged: true,
    },
  );
  return outcomeFromWrite(writeOutcome, action, ownership, diff, record);
}

/**
 * Plan or apply safe removal of an owned JSON entry.
 * Preserves unrelated keys; refuses edited or foreign entries.
 */
export async function removeJsonEntry(params: {
  file: string;
  allowedRoot: string;
  adapter: JsonEntryAdapter;
  manifestRecord: ManifestRecord | undefined;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<InstallEditResult> {
  const fs: InstallFs = params.runtime?.fs ?? nodeSafeFs;
  const now = params.runtime?.now ?? (() => new Date());
  let safeFile: string;
  try {
    safeFile = await assertSafeInstallPath(params.file, params.allowedRoot, fs.lstat);
  } catch (error) {
    return {
      action: "absent",
      outcome: "refused",
      ownership: "absent",
      code: "UNSAFE_PATH",
      message: error instanceof Error ? error.message : String(error),
      diff: null,
      manifestRecord: null,
    };
  }

  let originalText: string | null = null;
  let doc: Record<string, unknown> = {};
  try {
    originalText = await fs.readFile(safeFile);
    const parsed: unknown = JSON.parse(originalText);
    if (!isPlainObject(parsed)) {
      return {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "UNSUPPORTED_SCHEMA",
        message: `${safeFile} must be a JSON object.`,
        diff: null,
        manifestRecord: null,
      };
    }
    doc = parsed;
  } catch (error) {
    if (isMissingError(error)) {
      return {
        action: "absent",
        outcome: "kept",
        ownership: params.manifestRecord ? "missing" : "absent",
        code: null,
        message: `${safeFile} is absent; nothing to remove.`,
        diff: null,
        manifestRecord: null,
      };
    }
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "MALFORMED_CONFIG",
      message: `${safeFile} is malformed JSON: ${error instanceof Error ? error.message : String(error)}.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const inspected = params.adapter.inspect(doc);
  const ownership = classifyEntry(
    params.manifestRecord,
    inspected.canonicalText,
    inspected.looksForeign,
  );
  if (ownership === "absent" || ownership === "missing") {
    return {
      action: "absent",
      outcome: "kept",
      ownership,
      code: null,
      message: `${params.adapter.kind} entry is already absent from ${safeFile}.`,
      diff: null,
      manifestRecord: null,
    };
  }
  if (ownership === "edited") {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "OWNED_ENTRY_EDITED",
      message: `Owned ${params.adapter.kind} entry in ${safeFile} was edited outside pdb; remove it manually.`,
      diff: null,
      manifestRecord: null,
    };
  }
  if (ownership === "foreign") {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "FOREIGN_ENTRY",
      message: `Existing ${params.adapter.kind} entry in ${safeFile} is not managed by pdb; leaving it untouched.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const updatedDoc = params.adapter.remove(doc);
  const nextText = `${JSON.stringify(updatedDoc, null, 2)}\n`;
  const diff = previewDiff(safeFile, originalText, nextText);
  if (params.dryRun) {
    return {
      action: "remove",
      outcome: "planned",
      ownership,
      code: null,
      message: `Planned removal of ${params.adapter.kind} from ${safeFile}.`,
      diff,
      manifestRecord: null,
    };
  }

  const writeOutcome = await updateTextFile(
    safeFile,
    (current) => {
      if (current.state === "unreadable") return { refuse: current.why };
      const currentText = current.state === "absent" ? null : current.text;
      if (currentText !== originalText)
        return { refuse: `CONFLICT: ${safeFile} changed concurrently before removal.` };
      return { write: nextText };
    },
    {
      fs,
      now: () => now().getTime(),
      lockWaitMs: params.runtime?.lockWaitMs,
      checkUnchanged: true,
    },
  );
  return outcomeFromWrite(writeOutcome, "remove", ownership, diff, null);
}

/** Find `[tableHeader]` line range `[startLine, endLineExclusive)` in TOML text (top-level table). */
function findTomlTableRange(
  lines: readonly string[],
  tableHeader: string,
): { start: number; end: number } | null {
  const headerLine = `[${tableHeader}]`;
  const start = lines.findIndex((l) => l.trim() === headerLine);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^\[[^\]]+\]$/.test(trimmed) && !trimmed.startsWith(`[${tableHeader}.`)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function getNestedTomlTable(
  parsed: Record<string, unknown>,
  tablePath: readonly string[],
): Record<string, unknown> | null {
  let cur: unknown = parsed;
  for (const key of tablePath) {
    if (!isPlainObject(cur) || !(key in cur)) return null;
    cur = cur[key];
  }
  return isPlainObject(cur) ? cur : null;
}

function withoutNestedTomlTable(
  parsed: Record<string, unknown>,
  tablePath: readonly string[],
): Record<string, unknown> {
  if (tablePath.length === 0) return parsed;
  const [head, ...tail] = tablePath;
  const copy: Record<string, unknown> = { ...parsed };
  if (tail.length === 0) {
    delete copy[head!];
    return copy;
  }
  const child = copy[head!];
  if (isPlainObject(child)) {
    const nextChild = withoutNestedTomlTable(child, tail);
    if (Object.keys(nextChild).length === 0) delete copy[head!];
    else copy[head!] = nextChild;
  }
  return copy;
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => stableEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && stableEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Bounded TOML table block edit (`[mcp_servers.pdb]`).
 * Preserves unrelated comments, blank lines, and ordering; verifies before/after parses via `smol-toml`.
 */
export async function editTomlTable(params: {
  file: string;
  allowedRoot: string;
  tablePath: readonly string[];
  desiredBlock: string;
  kind?: InstallItemKind;
  manifestRecord: ManifestRecord | undefined;
  pdbVersion: string;
  dryRun?: boolean;
  adopt?: boolean;
  runtime?: ManifestRuntime;
}): Promise<InstallEditResult> {
  const fs: InstallFs = params.runtime?.fs ?? nodeSafeFs;
  const now = params.runtime?.now ?? (() => new Date());
  const kind = params.kind ?? "mcp";
  const tableHeader = params.tablePath.join(".");
  let safeFile: string;
  try {
    safeFile = await assertSafeInstallPath(params.file, params.allowedRoot, fs.lstat);
  } catch (error) {
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "UNSAFE_PATH",
      message: error instanceof Error ? error.message : String(error),
      diff: null,
      manifestRecord: null,
    };
  }

  let originalText: string | null = null;
  let parsedOriginal: Record<string, unknown> = {};
  try {
    originalText = await fs.readFile(safeFile);
    parsedOriginal = parseToml(originalText) as Record<string, unknown>;
  } catch (error) {
    if (!isMissingError(error)) {
      return {
        action: "kept",
        outcome: "refused",
        ownership: "absent",
        code: "MALFORMED_CONFIG",
        message: `${safeFile} is malformed TOML: ${error instanceof Error ? error.message : String(error)}.`,
        diff: null,
        manifestRecord: null,
      };
    }
  }

  let parsedDesiredTable: Record<string, unknown>;
  try {
    const parsedDesired = parseToml(params.desiredBlock) as Record<string, unknown>;
    const table = getNestedTomlTable(parsedDesired, params.tablePath);
    if (!table) throw new Error(`Desired block does not define [${tableHeader}].`);
    parsedDesiredTable = table;
  } catch (error) {
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "UNSAFE_TOML_EDIT",
      message: error instanceof Error ? error.message : String(error),
      diff: null,
      manifestRecord: null,
    };
  }

  const lines = originalText === null ? [] : originalText.replace(/\r\n/g, "\n").split("\n");
  const range = findTomlTableRange(lines, tableHeader);
  const existingTableValue = getNestedTomlTable(parsedOriginal, params.tablePath);
  const observedBlock = range ? lines.slice(range.start, range.end).join("\n").trimEnd() : null;
  const canonicalDesired = params.desiredBlock.trimEnd();
  const ownership = classifyEntry(
    params.manifestRecord,
    observedBlock,
    existingTableValue !== null || range !== null,
  );

  // Adopt a foreign table without touching the native file: record the observed
  // block, so a later re-install can replace it (codex-installer.md "Ownership and replacement").
  if (ownership === "foreign" && params.adopt) {
    const record: ManifestRecord = {
      file: safeFile,
      kind,
      format: "toml",
      canonicalText: observedBlock ?? "",
      sha256: sha256Hex(observedBlock ?? ""),
      pdbVersion: params.pdbVersion,
      recordedAt: now().toISOString(),
    };
    return {
      action: "kept",
      outcome: "adopted",
      ownership,
      code: null,
      message: `Adopted existing foreign [${tableHeader}] in ${safeFile} without changing it.`,
      diff: null,
      manifestRecord: record,
    };
  }

  if (ownership === "edited") {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "OWNED_ENTRY_EDITED",
      message: `Owned [${tableHeader}] in ${safeFile} was edited outside pdb; restore or remove it before reinstalling.`,
      diff: previewDiff(safeFile, observedBlock, canonicalDesired),
      manifestRecord: null,
    };
  }
  if (ownership === "foreign" && !params.adopt) {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "FOREIGN_ENTRY",
      message: `Existing [${tableHeader}] in ${safeFile} is not managed by pdb; rerun with --adopt to adopt it.`,
      diff: null,
      manifestRecord: null,
    };
  }
  if (ownership === "owned" && observedBlock === canonicalDesired) {
    return {
      action: "kept",
      outcome: "kept",
      ownership,
      code: null,
      message: `[${tableHeader}] in ${safeFile} is already owned and current.`,
      diff: null,
      manifestRecord: params.manifestRecord ?? null,
    };
  }

  const blockLines = canonicalDesired.split("\n");
  let nextText: string;
  if (range) {
    const updatedLines = [...lines.slice(0, range.start), ...blockLines, ...lines.slice(range.end)];
    nextText = updatedLines.join("\n");
    if (!nextText.endsWith("\n")) nextText += "\n";
  } else if (originalText === null || !originalText.trim()) {
    nextText = `${canonicalDesired}\n`;
  } else {
    const trimmed = originalText.replace(/\r\n/g, "\n").trimEnd();
    nextText = `${trimmed}\n\n${canonicalDesired}\n`;
  }

  // Validate that the TOML edit changed ONLY `[tableHeader]`.
  try {
    const parsedNext = parseToml(nextText) as Record<string, unknown>;
    const nextTable = getNestedTomlTable(parsedNext, params.tablePath);
    if (
      !nextTable ||
      !stableEqual(nextTable, parsedDesiredTable) ||
      !stableEqual(
        withoutNestedTomlTable(parsedOriginal, params.tablePath),
        withoutNestedTomlTable(parsedNext, params.tablePath),
      )
    ) {
      return {
        action: "kept",
        outcome: "refused",
        ownership,
        code: "UNSAFE_TOML_EDIT",
        message: `Refused TOML edit on ${safeFile}: post-edit parse differed outside [${tableHeader}].`,
        diff: null,
        manifestRecord: null,
      };
    }
  } catch {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "UNSAFE_TOML_EDIT",
      message: `Refused TOML edit on ${safeFile}: result failed TOML validation.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const action = ownership === "owned" || ownership === "foreign" ? "replace" : "create";
  const diff = previewDiff(safeFile, originalText, nextText);
  const record: ManifestRecord = {
    file: safeFile,
    kind,
    format: "toml",
    canonicalText: canonicalDesired,
    sha256: sha256Hex(canonicalDesired),
    pdbVersion: params.pdbVersion,
    recordedAt: now().toISOString(),
  };

  if (params.dryRun) {
    return {
      action,
      outcome: "planned",
      ownership,
      code: null,
      message: `Planned ${action} of [${tableHeader}] in ${safeFile}.`,
      diff,
      manifestRecord: record,
    };
  }

  const writeOutcome = await updateTextFile(
    safeFile,
    (current) => {
      if (current.state === "unreadable") return { refuse: current.why };
      const currentText = current.state === "absent" ? null : current.text;
      if (currentText !== originalText)
        return { refuse: `CONFLICT: ${safeFile} changed concurrently before write.` };
      return { write: nextText };
    },
    {
      fs,
      now: () => now().getTime(),
      lockWaitMs: params.runtime?.lockWaitMs,
      checkUnchanged: true,
    },
  );
  return outcomeFromWrite(writeOutcome, action, ownership, diff, record);
}

/** Safe removal of an owned TOML table block; preserves all unrelated comments and tables. */
export async function removeTomlTable(params: {
  file: string;
  allowedRoot: string;
  tablePath: readonly string[];
  kind?: InstallItemKind;
  manifestRecord: ManifestRecord | undefined;
  dryRun?: boolean;
  runtime?: ManifestRuntime;
}): Promise<InstallEditResult> {
  const fs: InstallFs = params.runtime?.fs ?? nodeSafeFs;
  const now = params.runtime?.now ?? (() => new Date());
  const tableHeader = params.tablePath.join(".");
  let safeFile: string;
  try {
    safeFile = await assertSafeInstallPath(params.file, params.allowedRoot, fs.lstat);
  } catch (error) {
    return {
      action: "absent",
      outcome: "refused",
      ownership: "absent",
      code: "UNSAFE_PATH",
      message: error instanceof Error ? error.message : String(error),
      diff: null,
      manifestRecord: null,
    };
  }

  let originalText: string | null = null;
  let parsedOriginal: Record<string, unknown> = {};
  try {
    originalText = await fs.readFile(safeFile);
    parsedOriginal = parseToml(originalText) as Record<string, unknown>;
  } catch (error) {
    if (isMissingError(error)) {
      return {
        action: "absent",
        outcome: "kept",
        ownership: params.manifestRecord ? "missing" : "absent",
        code: null,
        message: `${safeFile} is absent; nothing to remove.`,
        diff: null,
        manifestRecord: null,
      };
    }
    return {
      action: "kept",
      outcome: "refused",
      ownership: "absent",
      code: "MALFORMED_CONFIG",
      message: `${safeFile} is malformed TOML: ${error instanceof Error ? error.message : String(error)}.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const lines = originalText.replace(/\r\n/g, "\n").split("\n");
  const range = findTomlTableRange(lines, tableHeader);
  const existingTableValue = getNestedTomlTable(parsedOriginal, params.tablePath);
  const observedBlock = range ? lines.slice(range.start, range.end).join("\n").trimEnd() : null;
  const ownership = classifyEntry(
    params.manifestRecord,
    observedBlock,
    existingTableValue !== null || range !== null,
  );
  if (ownership === "absent" || ownership === "missing") {
    return {
      action: "absent",
      outcome: "kept",
      ownership,
      code: null,
      message: `[${tableHeader}] is already absent from ${safeFile}.`,
      diff: null,
      manifestRecord: null,
    };
  }
  if (ownership === "edited") {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "OWNED_ENTRY_EDITED",
      message: `Owned [${tableHeader}] in ${safeFile} was edited outside pdb; remove it manually.`,
      diff: null,
      manifestRecord: null,
    };
  }
  if (ownership === "foreign" || !range) {
    return {
      action: "kept",
      outcome: "refused",
      ownership: "foreign",
      code: "FOREIGN_ENTRY",
      message: `Existing [${tableHeader}] in ${safeFile} is not managed by pdb; leaving it untouched.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const before = lines.slice(0, range.start);
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  const after = lines.slice(range.end);
  const combined = [...before, ...after].join("\n").trimEnd();
  const nextText = combined ? `${combined}\n` : "";

  try {
    const parsedNext = (nextText ? parseToml(nextText) : {}) as Record<string, unknown>;
    if (
      getNestedTomlTable(parsedNext, params.tablePath) !== null ||
      !stableEqual(withoutNestedTomlTable(parsedOriginal, params.tablePath), parsedNext)
    ) {
      return {
        action: "kept",
        outcome: "refused",
        ownership,
        code: "UNSAFE_TOML_EDIT",
        message: `Refused TOML removal on ${safeFile}: post-edit parse differed outside [${tableHeader}].`,
        diff: null,
        manifestRecord: null,
      };
    }
  } catch {
    return {
      action: "kept",
      outcome: "refused",
      ownership,
      code: "UNSAFE_TOML_EDIT",
      message: `Refused TOML removal on ${safeFile}: result failed TOML validation.`,
      diff: null,
      manifestRecord: null,
    };
  }

  const diff = previewDiff(safeFile, originalText, nextText);
  if (params.dryRun) {
    return {
      action: "remove",
      outcome: "planned",
      ownership,
      code: null,
      message: `Planned removal of [${tableHeader}] from ${safeFile}.`,
      diff,
      manifestRecord: null,
    };
  }

  const writeOutcome = await updateTextFile(
    safeFile,
    (current) => {
      if (current.state === "unreadable") return { refuse: current.why };
      const currentText = current.state === "absent" ? null : current.text;
      if (currentText !== originalText)
        return { refuse: `CONFLICT: ${safeFile} changed concurrently before removal.` };
      return { write: nextText };
    },
    {
      fs,
      now: () => now().getTime(),
      lockWaitMs: params.runtime?.lockWaitMs,
      checkUnchanged: true,
    },
  );
  return outcomeFromWrite(writeOutcome, "remove", ownership, diff, null);
}
