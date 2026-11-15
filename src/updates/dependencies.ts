/**
 * Source-checkout dependency readiness (#346). Contract: doc/design/source-install-diagnostics.md,
 * "#346".
 *
 * Compares the running source checkout's package-lock.json with npm's hidden lock
 * (node_modules/.package-lock.json) and confirms each runtime dependency named in the root
 * manifest still has its entry point (exports or main) under node_modules. Lock identity
 * (`resolved` and `integrity`) is compared as well as the version. Read-only: never runs npm, package scripts or
 * any other process, and never writes. Every read shares one deadline; anything that cannot be
 * established is unknown, never "up to date".
 *
 * Supported lockfiles: lockfileVersion 2 and 3 (the `packages` map). Normalization: entries
 * keyed `node_modules/...` (including nested ones) are compared by `version`; links and the
 * root entry are ignored. An optional package (npm's platform-specific binaries) may be absent
 * without being reported; a dev package may be absent only when every absent package is dev,
 * which is how an `--omit=dev` install looks, and that is reported as unknown rather than ok.
 * The check confirms selected required modules, not full tree integrity.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One doctor check, structurally the same as the Doctor's LocalCheck (no import cycle). */
export interface LocalCheck {
  id: string;
  status: "ok" | "missing" | "invalid" | "access" | "unsupported" | "unknown";
  source: string;
  detail: string;
  next: string[];
}

export const dependencyCheckId = "install.dependencies";
export const dependencyDeadlineMs = 2000;
/** How many package names a report names before summarising the rest. */
export const namedPackageLimit = 5;
export const supportedLockfileVersions = [2, 3];

/** Reads a text file: its contents, or null when it does not exist. Throws when unreadable. */
export type ReadText = (path: string) => Promise<string | null>;

export const nodeReadText: ReadText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export interface DependencyOptions {
  /** The running installation's package root (from installedVersion), or null when unknown. */
  root: string | null;
  /** true for a published npm installation: npm manages its dependencies, not this checkout. */
  installed: boolean;
  /** true when running the built bundle, so a rebuild must follow `npm ci`. */
  executingDist?: boolean;
  readText?: ReadText;
  deadlineMs?: number;
}

type Lock = Map<
  string,
  {
    version: string | null;
    /** Lock identity: where the package came from and its content hash. */
    resolved: string | null;
    integrity: string | null;
    dev: boolean;
    optional: boolean;
    link: boolean;
    bundled: boolean;
  }
>;

/**
 * The entry file a package's own manifest names for `import`: `exports` ("." or a bare
 * conditions object, taking the first of import, node or default in the package's key order) or else `main`, else index.js.
 * Returns null when `exports` exists but names no file this check can follow.
 */
const supportedConditions = new Set(["import", "node", "default"]);

export function entryPoint(manifest: Record<string, unknown>): string[] | null {
  const pick = (target: unknown): string | null => {
    if (typeof target === "string") return target;
    if (Array.isArray(target)) {
      for (const t of target) {
        const found = pick(t);
        if (found) return found;
      }
      return null;
    }
    if (typeof target !== "object" || target === null) return null;
    const conditions = target as Record<string, unknown>;
    // As Node does: the package's own key order decides, taking the first key in our set.
    for (const [condition, value] of Object.entries(conditions))
      if (supportedConditions.has(condition)) return pick(value);
    return null;
  };
  const exports = manifest.exports;
  if (exports !== undefined && exports !== null) {
    const root =
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((k) => k.startsWith("."))
        ? (exports as Record<string, unknown>)["."]
        : exports;
    const file = pick(root);
    return file ? [file] : null;
  }
  const main = typeof manifest.main === "string" && manifest.main ? manifest.main : "index.js";
  return main.endsWith(".js") ||
    main.endsWith(".mjs") ||
    main.endsWith(".cjs") ||
    main.endsWith(".json")
    ? [main]
    : [main, `${main}.js`, `${main}/index.js`];
}

class Unknown extends Error {}

function parseLock(text: string, what: string, requireRoot = false): Lock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Unknown(`${what} is not valid JSON`);
  }
  const record = parsed as { lockfileVersion?: unknown; packages?: unknown };
  if (
    typeof record !== "object" ||
    record === null ||
    !supportedLockfileVersions.includes(record.lockfileVersion as number) ||
    typeof record.packages !== "object" ||
    record.packages === null
  )
    throw new Unknown(`${what} has an unsupported lockfileVersion (supported: 2, 3)`);
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const packages = record.packages;
  // A malformed lock is unknown, never compared: packages must be a plain object of plain
  // objects, and package-lock.json itself must carry its root ("") entry.
  if (
    !plain(packages) ||
    (requireRoot && !plain(packages[""])) ||
    Object.values(packages).some((entry) => !plain(entry))
  )
    throw new Unknown(`${what} is malformed`);
  const lock: Lock = new Map();
  for (const [key, value] of Object.entries(record.packages as Record<string, unknown>)) {
    if (!key.startsWith("node_modules/")) continue;
    const entry = value as Record<string, unknown>;
    lock.set(key, {
      version: typeof entry.version === "string" ? entry.version : null,
      resolved: typeof entry.resolved === "string" ? entry.resolved : null,
      integrity: typeof entry.integrity === "string" ? entry.integrity : null,
      bundled: entry.inBundle === true,
      dev: entry.dev === true || entry.devOptional === true,
      optional: entry.optional === true,
      link: entry.link === true,
    });
  }
  return lock;
}

/** The package name of a lock key such as `node_modules/a/node_modules/@s/b`. */
const packageName = (key: string) => key.slice(key.lastIndexOf("node_modules/") + 13);

function names(keys: string[]): string {
  const unique = [...new Set(keys.map(packageName))].sort();
  const shown = unique.slice(0, namedPackageLimit).join(", ");
  return unique.length > namedPackageLimit
    ? `${shown} and ${unique.length - namedPackageLimit} more`
    : shown;
}

/** Diagnose dependency readiness. Never throws. */
export async function dependencyReadiness(options: DependencyOptions): Promise<LocalCheck> {
  const deadlineMs = options.deadlineMs ?? dependencyDeadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<LocalCheck>((resolve) => {
    timer = setTimeout(
      () => resolve(unknown("deadline", `Reading dependency evidence took over ${deadlineMs} ms.`)),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([
      check(options).catch((error: unknown) =>
        unknown(
          "unreadable",
          error instanceof Unknown
            ? `${error.message}.`
            : "Dependency evidence could not be read (details not shown).",
        ),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function unknown(source: string, detail: string): LocalCheck {
  return {
    id: dependencyCheckId,
    status: "unknown",
    source,
    detail: `${detail} Dependency readiness cannot be established, so it is not reported as up to date.`,
    next: [],
  };
}

async function check({
  root,
  installed,
  executingDist = false,
  readText = nodeReadText,
}: DependencyOptions): Promise<LocalCheck> {
  if (installed)
    return {
      id: dependencyCheckId,
      status: "unsupported",
      source: "npm installation",
      detail:
        "Published npm installation: its dependencies are managed by npm, so this source-checkout check does not apply. If a module is missing, reinstall the published package.",
      next: [],
    };
  if (!root) return unknown("installation root", "The running installation root is unknown.");

  const manifestText = await readText(join(root, "package.json"));
  const lockText = await readText(join(root, "package-lock.json"));
  if (lockText === null)
    return unknown("package-lock.json", "This source checkout has no package-lock.json.");
  const expected = parseLock(lockText, "package-lock.json", true);

  const fix = {
    next: [
      "npm ci   (at the PDB source checkout root, not the target project)",
      ...(executingDist ? ["npm run build"] : []),
    ],
  };
  let declared: string[] = [];
  if (manifestText !== null) {
    try {
      const deps = (JSON.parse(manifestText) as { dependencies?: unknown }).dependencies;
      if (typeof deps === "object" && deps !== null) declared = Object.keys(deps);
    } catch {
      throw new Unknown("package.json is not valid JSON");
    }
  }
  /** Whether a runtime dependency's own entry point exists, or unknown when it cannot tell. */
  const resolve = async (name: string): Promise<"ok" | "missing" | "unknown"> => {
    const dir = join(root, "node_modules", ...name.split("/"));
    const text = await readText(join(dir, "package.json"));
    if (text === null) return "missing";
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      return "unknown";
    }
    if (typeof manifest !== "object" || manifest === null) return "unknown";
    const candidates = entryPoint(manifest as Record<string, unknown>);
    if (!candidates) return "unknown";
    let failed = false;
    for (const file of candidates) {
      if (file.split(/[\\/]/).includes("..")) return "unknown";
      try {
        if ((await readText(join(dir, ...file.split("/")))) !== null) return "ok";
      } catch {
        failed = true; // A directory or an unreadable file: try the next candidate.
      }
    }
    return failed ? "unknown" : "missing";
  };
  const unresolvable: string[] = [];
  const resolves = async (name: string) => {
    const result = await resolve(name);
    if (result === "unknown") unresolvable.push(`node_modules/${name}`);
    return result !== "missing";
  };

  const hiddenText = await readText(join(root, "node_modules", ".package-lock.json"));
  if (hiddenText === null) {
    // No hidden lock: a runtime dependency that does not resolve is proof enough; otherwise
    // npm simply did not record one and nothing can be compared.
    const absent: string[] = [];
    for (const name of declared) if (!(await resolves(name))) absent.push(`node_modules/${name}`);
    if (absent.length)
      return {
        id: dependencyCheckId,
        status: "missing",
        source: "package.json dependencies",
        detail: `Dependencies are not installed (missing: ${names(absent)}).`,
        ...fix,
      };
    return unknown(
      "node_modules/.package-lock.json",
      "npm's installed lock (node_modules/.package-lock.json) is absent, so the install cannot be compared with package-lock.json; if node_modules is missing, run npm ci at the PDB source checkout root.",
    );
  }
  const actual = parseLock(hiddenText, "node_modules/.package-lock.json");

  const missing: string[] = [];
  const mismatched: string[] = [];
  const omittedDev: string[] = [];
  /** Packages whose lock identity cannot be compared: neither side shares resolved/integrity. */
  const unverifiable: string[] = [];
  for (const [key, want] of expected) {
    if (want.link) continue;
    const have = actual.get(key);
    if (!have) {
      if (want.optional) continue;
      (want.dev ? omittedDev : missing).push(key);
      continue;
    }
    if (want.version !== null && have.version !== want.version) {
      mismatched.push(key);
      continue;
    }
    if (want.bundled) continue;
    // Same version: the lock identity (source and content hash) must match too, on whatever
    // fields both sides record.
    const shared = (["resolved", "integrity"] as const).filter(
      (f) => want[f] !== null && have[f] !== null,
    );
    if (shared.length === 0) unverifiable.push(key);
    else if (shared.some((f) => want[f] !== have[f])) mismatched.push(key);
  }
  const extraneous = [...actual.keys()].filter(
    (key) => !expected.has(key) && !actual.get(key)!.link,
  );

  // A hidden lock is only a hint: the runtime dependencies must still resolve on disk.
  if (manifestText === null) throw new Unknown("package.json could not be found");
  const unresolved: string[] = [];
  for (const name of declared) {
    const key = `node_modules/${name}`;
    if (!missing.includes(key) && !(await resolves(name))) unresolved.push(key);
  }
  missing.push(...unresolved);

  // Running dist: the lazily loaded Datalog chunk that dist/cli.mjs imports must exist too.
  const chunk = executingDist ? await engineChunk(root, readText) : "ok";
  if (chunk === "missing" && missing.length + mismatched.length + extraneous.length === 0)
    return {
      id: dependencyCheckId,
      status: "missing",
      source: "dist/cli.mjs Datalog chunk import",
      detail:
        "The built Datalog engine chunk that dist/cli.mjs imports is missing; the build is incomplete or stale.",
      next: ["npm run build   (at the PDB source checkout root)"],
    };

  if (missing.length + mismatched.length + extraneous.length > 0) {
    const parts = [
      missing.length ? `missing: ${names(missing)}` : null,
      mismatched.length
        ? `version, source or integrity differs from package-lock.json: ${names(mismatched)}`
        : null,
      extraneous.length ? `not in package-lock.json: ${names(extraneous)}` : null,
      omittedDev.length ? `missing dev: ${names(omittedDev)}` : null,
      chunk === "missing" ? "built Datalog engine chunk missing" : null,
    ].filter(Boolean);
    return {
      id: dependencyCheckId,
      status: missing.length ? "missing" : "invalid",
      source: "package-lock.json vs node_modules/.package-lock.json",
      detail: `Installed dependencies are out of date with package-lock.json (${parts.join("; ")}).`,
      ...fix,
    };
  }
  if (chunk === "unknown")
    return unknown(
      "dist/cli.mjs Datalog chunk import",
      "The built Datalog engine chunk could not be identified or read from dist/cli.mjs.",
    );
  if (unresolvable.length)
    return unknown(
      "runtime dependency entry points",
      `The entry point of ${names(unresolvable)} could not be established from its own package.json.`,
    );
  if (unverifiable.length)
    return unknown(
      "package-lock.json vs node_modules/.package-lock.json",
      `Neither lock records a comparable source or integrity for ${names(unverifiable)}.`,
    );
  if (omittedDev.length)
    return unknown(
      "package-lock.json vs node_modules/.package-lock.json",
      `Development dependencies are not installed (${names(omittedDev)}), as after npm ci --omit=dev; runtime dependencies match.`,
    );
  return {
    id: dependencyCheckId,
    status: "ok",
    source: "package-lock.json vs node_modules/.package-lock.json",
    detail: `Installed dependencies match package-lock.json (${expected.size} packages; ${declared.length} runtime dependency entry points exist). This is not a full integrity check.`,
    next: [],
  };
}

/** The chunk specifier dist/cli.mjs lazily imports for the Datalog engine. */
const chunkImport = /import\(\s*["']\.\/(datalog-[\w-]+\.mjs)["']\s*\)/g;

/**
 * Whether the Datalog chunk that the built CLI imports exists: read the bundle, take its one
 * `import("./datalog-*.mjs")` specifier and check that file. Unknown when the bundle cannot be
 * read or names no single chunk.
 */
export async function engineChunk(
  root: string,
  readText: ReadText,
): Promise<"ok" | "missing" | "unknown"> {
  try {
    const bundle = await readText(join(root, "dist", "cli.mjs"));
    if (bundle === null) return "missing";
    const chunks = new Set([...bundle.matchAll(chunkImport)].map((m) => m[1]!));
    if (chunks.size !== 1) return "unknown";
    const [file] = [...chunks];
    return (await readText(join(root, "dist", file!))) === null ? "missing" : "ok";
  } catch {
    return "unknown";
  }
}
