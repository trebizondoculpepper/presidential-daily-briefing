/**
 * #514 source boundary only (doc/design/native-project-rules.md).
 * This does NOT validate helper/preference semantics or activate/evaluate a policy.
 * A parsed envelope must pass the separate native compiler before any evaluation.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { EdnSourceError, printEdn, readOne } from "../edn.js";

export const projectRulesFile = "pdb.rules.edn";
export const sourceLimits = {
  bytes: 65536,
  depth: 20,
  nodes: 10000,
  alternatives: 100,
  preferences: 50,
} as const;
export class ProjectSourceError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(`${projectRulesFile}: ${code}: ${detail}`);
  }
}
function fail(code: string, detail: string): never {
  throw new ProjectSourceError(code, detail);
}

export interface BaseIdentity {
  policyVersion: number;
  rulesHash: string;
}
/** Deliberately unvalidated clauses: never pass this envelope directly to the engine. */
export interface ParsedProjectSource {
  phase: "parsed-source";
  formatVersion: 1 | 2;
  projectionVersion: 1;
  basePolicyVersion: number;
  baseRulesHash: string;
  canonicalSource: string;
  sourceDigest: string;
  rules: unknown[];
  preferences: unknown[];
}
const keys = [
  "format-version",
  "projection-version",
  "base-policy-version",
  "base-rules-hash",
  "rules",
  "preferences",
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Bound nesting BEFORE the recursive EDN reader; strings and comments are not delimiters. */
function boundDepth(text: string) {
  let depth = 0,
    quoted = false,
    escaped = false,
    comment = false;
  for (const c of text) {
    if (comment) {
      if (c === "\n" || c === "\r") comment = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === ";") {
      comment = true;
      continue;
    }
    if (c === "\\") fail("unsupported-edn", "Native character literals are unsupported");
    if (c === '"') {
      quoted = true;
      continue;
    }
    if ("([{".includes(c)) {
      if (++depth > sourceLimits.depth) fail("source-depth", "Nesting exceeds the supported limit");
    } else if (")]}".includes(c)) depth--;
  }
}

/** Normalize map order recursively, reject duplicate keys and bound AST size. */
function canonicalForm(form: unknown): unknown {
  let nodes = 0;
  const walk = (value: unknown): unknown => {
    if (++nodes > sourceLimits.nodes) fail("source-nodes", "Too many parsed forms");
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      if ("map" in value && Array.isArray(value.map)) {
        const seen = new Set<string>();
        const pairs = (value.map as unknown[][]).map(([key, entry]) => {
          const k = walk(key),
            v = walk(entry),
            printed = printEdn(k, projectRulesFile);
          if (seen.has(printed)) fail("duplicate-key", "A map contains duplicate keys");
          seen.add(printed);
          return { printed, pair: [k, v] };
        });
        pairs.sort((a, b) => (a.printed < b.printed ? -1 : a.printed > b.printed ? 1 : 0));
        return { map: pairs.map((p) => p.pair) };
      }
      if ("list" in value && Array.isArray(value.list)) return { list: value.list.map(walk) };
      if ("set" in value && Array.isArray(value.set)) return { set: value.set.map(walk) };
    }
    return value;
  };
  return walk(form);
}

export function parseProjectSource(text: string, base: BaseIdentity): ParsedProjectSource {
  if (Buffer.byteLength(text, "utf8") > sourceLimits.bytes)
    fail("source-bytes", "Source exceeds 64 KiB UTF-8");
  boundDepth(text);
  let form: unknown;
  try {
    form = canonicalForm(readOne(text, projectRulesFile));
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw new ProjectSourceError(
      "invalid-edn",
      "Inspect the selected source syntax",
      error instanceof EdnSourceError ? error.line : undefined,
      error instanceof EdnSourceError ? error.column : undefined,
    );
  }
  if (!form || typeof form !== "object" || !("map" in form) || !Array.isArray(form.map))
    fail("source-map", "Expected one map");
  const fields = new Map<string, unknown>();
  for (const [k, v] of form.map as unknown[][]) {
    if (
      !k ||
      typeof k !== "object" ||
      !("key" in k) ||
      typeof k.key !== "string" ||
      !keys.includes(k.key)
    )
      fail("source-key", "Unknown or non-keyword source key");
    fields.set(k.key, v);
  }
  if (keys.some((k) => !fields.has(k))) fail("missing-key", "A required source field is missing");
  const formatVersion = fields.get("format-version");
  if ((formatVersion !== 1 && formatVersion !== 2) || fields.get("projection-version") !== 1)
    fail("source-version", "Unsupported format or projection version");
  if (
    !Number.isSafeInteger(base.policyVersion) ||
    base.policyVersion < 1 ||
    !/^[0-9a-f]{64}$/.test(base.rulesHash)
  )
    fail("base-identity", "Invalid shipped base identity");
  if (
    fields.get("base-policy-version") !== base.policyVersion ||
    fields.get("base-rules-hash") !== base.rulesHash
  )
    fail(
      "base-mismatch",
      "Source must be reviewed against the current shipped policy version and hash",
    );
  const rules = fields.get("rules"),
    preferences = fields.get("preferences");
  if (!Array.isArray(rules) || !Array.isArray(preferences))
    fail("source-vectors", "Rules and preferences must be vectors");
  if (rules.length > sourceLimits.alternatives || preferences.length > sourceLimits.preferences)
    fail("source-count", "Too many alternatives or preferences");
  let canonicalSource: string;
  try {
    canonicalSource = printEdn(form, projectRulesFile);
  } catch {
    return fail("unsupported-edn", "Source contains an unsupported native value");
  }
  return {
    phase: "parsed-source",
    formatVersion,
    projectionVersion: 1,
    basePolicyVersion: base.policyVersion,
    baseRulesHash: base.rulesHash,
    canonicalSource,
    sourceDigest: digest(canonicalSource),
    rules,
    preferences,
  };
}

/** The filesystem boundary reads at most limit+1 bytes and never executes source. */
export interface ProjectSourceIO {
  realpath(path: string): Promise<string>;
  read(path: string, limit: number): Promise<Uint8Array>;
}
const sourceIO: ProjectSourceIO = {
  realpath,
  async read(path, limit) {
    // Reject special files before opening; NONBLOCK also guards a raced FIFO replacement.
    if (!(await lstat(path)).isFile()) fail("source-file", "Selected source is not a regular file");
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail("source-file", "Selected source is not a regular file");
      if (stat.size > limit) fail("source-bytes", "Source exceeds 64 KiB UTF-8");
      const bytes = Buffer.alloc(limit + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      return bytes.subarray(0, used);
    } finally {
      await handle.close();
    }
  },
};
/** Caller supplies the explicitly selected, verified checkout; no cwd or Git/identity lookup. */
export async function readProjectSource(
  projectRoot: string,
  base: BaseIdentity,
  io: ProjectSourceIO = sourceIO,
): Promise<ParsedProjectSource> {
  if (!isAbsolute(projectRoot))
    fail("project-root", "An explicit absolute verified project root is required");
  try {
    const root = await io.realpath(projectRoot);
    const file = await io.realpath(join(root, projectRulesFile));
    if (!isAbsolute(root) || !isAbsolute(file))
      fail("source-escape", "Resolved source identity is not absolute");
    const inside = relative(root, file);
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
      fail("source-escape", "Source resolves outside the selected project");
    const bytes = await io.read(file, sourceLimits.bytes);
    if (bytes.byteLength > sourceLimits.bytes) fail("source-bytes", "Source exceeds 64 KiB UTF-8");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("source-encoding", "Source must be valid UTF-8");
    }
    return parseProjectSource(text, base);
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw new ProjectSourceError("source-unreadable", "Cannot read selected project source");
  }
}
