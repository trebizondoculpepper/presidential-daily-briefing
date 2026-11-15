/**
 * Source-checkout dependency readiness (#346). Contract: doc/design/source-install-diagnostics.md,
 * "#346".
 *
 * Compares the running source checkout's package-lock.json with npm's hidden lock
 * (node_modules/.package-lock.json) and confirms each runtime dependency named in the root
 * manifest still resolves under node_modules. Read-only: never runs npm, package scripts or
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

type Lock = Map<string, { version: string | null; dev: boolean; optional: boolean; link: boolean }>;

class Unknown extends Error {}

function parseLock(text: string, what: string): Lock {
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
  const lock: Lock = new Map();
  for (const [key, value] of Object.entries(record.packages as Record<string, unknown>)) {
    if (!key.startsWith("node_modules/") || typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    lock.set(key, {
      version: typeof entry.version === "string" ? entry.version : null,
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
  const expected = parseLock(lockText, "package-lock.json");

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
  const resolves = async (name: string) =>
    (await readText(join(root, "node_modules", ...name.split("/"), "package.json"))) !== null;

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
  for (const [key, want] of expected) {
    if (want.link) continue;
    const have = actual.get(key);
    if (!have) {
      if (want.optional) continue;
      (want.dev ? omittedDev : missing).push(key);
      continue;
    }
    if (want.version !== null && have.version !== want.version) mismatched.push(key);
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

  if (missing.length + mismatched.length + extraneous.length > 0) {
    const parts = [
      missing.length ? `missing: ${names(missing)}` : null,
      mismatched.length ? `version differs from package-lock.json: ${names(mismatched)}` : null,
      extraneous.length ? `not in package-lock.json: ${names(extraneous)}` : null,
      omittedDev.length ? `missing dev: ${names(omittedDev)}` : null,
    ].filter(Boolean);
    return {
      id: dependencyCheckId,
      status: missing.length ? "missing" : "invalid",
      source: "package-lock.json vs node_modules/.package-lock.json",
      detail: `Installed dependencies are out of date with package-lock.json (${parts.join("; ")}).`,
      ...fix,
    };
  }
  if (omittedDev.length)
    return unknown(
      "package-lock.json vs node_modules/.package-lock.json",
      `Development dependencies are not installed (${names(omittedDev)}), as after npm ci --omit=dev; runtime dependencies match.`,
    );
  return {
    id: dependencyCheckId,
    status: "ok",
    source: "package-lock.json vs node_modules/.package-lock.json",
    detail: `Installed dependencies match package-lock.json (${expected.size} packages; ${declared.length} runtime dependencies resolve). This is not a full integrity check.`,
    next: [],
  };
}
