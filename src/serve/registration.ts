/**
 * Project resolution and registration at `pdb serve` startup (#805).
 *
 * The served set is the union of saved global registrations (`serve.projects` in the per-user
 * config), explicit `--repo`/`--project` targets and the verified Git repository of the working
 * directory. This module owns that union: canonicalising, de-duplicating, refining a repo-only
 * entry with a verified local root, refusing two different roots for one repository, and
 * persisting newly verified registrations through the shared global configuration service.
 *
 * `doc/design/serve-startup-configuration.md` is the contract. Two limits are deliberate:
 * nothing here fetches issues, pull requests or comments, and a failing explicit target fails
 * the whole startup before anything is written — a smaller served set is never reported as the
 * full request.
 */
import { join } from "node:path";
import {
  GLOBAL_CONFIG_FILE,
  loadGlobalConfig,
  writeGlobalConfig,
  type GlobalProject,
} from "../config/globalconfig.js";
import type { GitRunner } from "../config/config.js";
import type { ServedRepository, GlobalConfigBoundary } from "./types.js";
import { EXIT_USAGE } from "./options.js";

/** A startup failure found while resolving or registering projects, with its exit status. */
export class RegistrationError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The global configuration boundary, injected so tests never touch a real user config. */

/** Boundaries registration needs beyond the arguments themselves. */
export interface RegistrationRuntime {
  /** Invoking working directory. */
  readonly cwd?: string;
  /** Git runner used to resolve a subdirectory to its real working-tree root. */
  readonly git?: GitRunner;
  /** Resolve a local checkout to `owner/name`. */
  readonly currentRepository: (cwd?: string, signal?: AbortSignal) => Promise<string>;
  /** Absent when the caller has no verified global configuration boundary. */
  readonly globalConfig?: GlobalConfigBoundary;
}

/** What one startup resolved, and what it recorded. */
export interface RegistrationResult {
  /** The repositories this invocation serves, in the contract's order. */
  readonly served: readonly ServedRepository[];
  /** Registrations now saved, in stored order. */
  readonly saved: readonly GlobalProject[];
  /** Registrations this invocation added, in the order they were appended. */
  readonly registered: readonly GlobalProject[];
  /** Non-fatal findings for stderr: a saved root that has moved or gone. */
  readonly diagnostics: readonly string[];
  /** Whether the global file was created because it did not exist. */
  readonly initialized: boolean;
}

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

const canonical = (repository: string): string => repository.toLowerCase();

/** One container for the accumulated served set, keyed by canonical repository. */
class ServedSet {
  private readonly entries = new Map<string, ServedRepository>();

  /** Add a repository, refining a repo-only entry with a verified root. */
  add(repository: string, project: string | undefined, origin: string): void {
    const key = canonical(repository);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, project ? { repository, project } : { repository });
      return;
    }
    if (!project) return;
    if (!existing.project) {
      this.entries.set(key, { repository: existing.repository, project });
      return;
    }
    if (existing.project !== project) {
      throw new RegistrationError(
        EXIT_USAGE,
        `${repository} resolves to two local checkouts (${existing.project} from ${origin}, ${project} from this request). Pass one of them, or update the saved registration with pdb config set serve.projects before starting the server.`,
      );
    }
  }

  values(): ServedRepository[] {
    return [...this.entries.values()];
  }
}

/** Resolve one `--project` path to its verified Git root and repository. */
async function resolveProject(
  path: string,
  runtime: RegistrationRuntime,
): Promise<{ root: string; repository: string }> {
  let root = path;
  if (runtime.git) {
    try {
      root = (await runtime.git(["rev-parse", "--show-toplevel"], path)).trim() || path;
    } catch {
      throw new RegistrationError(
        EXIT_USAGE,
        `${path} is not inside a Git checkout. Run from or pass --project pointing to a local Git checkout.`,
      );
    }
  }
  let repository: string;
  try {
    repository = (await runtime.currentRepository(root)).trim();
  } catch {
    throw new RegistrationError(
      EXIT_USAGE,
      `--project ${root} does not resolve to a GitHub repository; check the path and gh authentication.`,
    );
  }
  if (!repositoryPattern.test(repository))
    throw new RegistrationError(
      EXIT_USAGE,
      `--project ${root} does not resolve to a GitHub repository.`,
    );
  return { root, repository };
}

/**
 * The verified Git repository of the working directory, or null. A working directory outside a
 * checkout is not an error: explicit and saved targets may still give a served set.
 */
async function cwdRepository(
  runtime: RegistrationRuntime,
): Promise<{ root: string; repository: string } | null> {
  if (!runtime.cwd || !runtime.git) return null;
  let root = "";
  try {
    root = (await runtime.git(["rev-parse", "--show-toplevel"], runtime.cwd)).trim();
  } catch {
    return null;
  }
  if (!root) return null;
  try {
    const repository = (await runtime.currentRepository(root)).trim();
    return repositoryPattern.test(repository) ? { root, repository } : null;
  } catch {
    return null;
  }
}

/** A host as it is compared: an absent host means github.com. */
const canonicalHost = (host: string | undefined): string => (host ?? "github.com").toLowerCase();

/** Registrations are the same only when host, repository and local root all match. */
const sameRegistration = (left: GlobalProject, right: GlobalProject): boolean =>
  canonicalHost(left.host) === canonicalHost(right.host) &&
  canonical(left.repository) === canonical(right.repository) &&
  (left.localRoot ?? null) === (right.localRoot ?? null);

/**
 * Resolve the served set and persist verified registrations.
 *
 * Order is the contract's: saved registrations first (in stored order), then explicit `--repo`
 * and `--project` targets in argument order, then the working directory's repository. An empty
 * union is a usage failure that names the supported ways to register a project, and an invalid
 * explicit target fails before any write, so a partial registration never happens.
 */
export async function resolveServeProjects(
  options: { readonly repos: readonly string[]; readonly projects: readonly string[] },
  runtime: RegistrationRuntime,
): Promise<RegistrationResult> {
  const boundary = runtime.globalConfig;
  if (!boundary)
    throw new RegistrationError(EXIT_USAGE, "no global configuration boundary was provided.");

  const path = join(boundary.dir, GLOBAL_CONFIG_FILE);
  let stored: GlobalProject[];
  let initialized = false;
  let baseline: string | null = null;
  try {
    const loaded = await loadGlobalConfig(boundary.dir, boundary.fs);
    initialized = loaded.raw === null;
    stored = [...((loaded.explicit.get("serve.projects") as GlobalProject[] | undefined) ?? [])];
    baseline = loaded.raw;
  } catch (error) {
    throw new RegistrationError(
      EXIT_USAGE,
      `${path} cannot be used: ${error instanceof Error ? error.message : String(error)} Nothing was registered.`,
    );
  }

  const diagnostics: string[] = [];
  const served = new ServedSet();
  const saved: GlobalProject[] = [];
  // Saved registrations first, in their stored order. A root that has moved, gone, or now
  // belongs to another repository is reported and the repository is still served; cwd is never
  // substituted for another project's root. A root whose identity cannot be read right now (a
  // transient gh failure) is kept: losing a registration to a network blip is worse than
  // serving it unverified, and the next startup re-checks it.
  for (const entry of stored) {
    const root = entry.localRoot;
    // This build serves github.com only. Another registered host is kept in the configuration
    // (never dropped by a read) but cannot be served as if it were github.com.
    if (entry.host.toLowerCase() !== "github.com") {
      diagnostics.push(
        `saved project ${entry.repository} is registered for ${entry.host}, which this build cannot serve; it is kept in the configuration and not served.`,
      );
      saved.push(entry);
      continue;
    }
    const saved_without_root = (message: string): void => {
      diagnostics.push(message);
      saved.push({ ...entry, localRoot: undefined });
      served.add(entry.repository, undefined, "the saved registration");
    };
    if (root === undefined) {
      saved.push(entry);
      served.add(entry.repository, undefined, "the saved registration");
      continue;
    }
    let present = true;
    if (runtime.git) {
      try {
        await runtime.git(["rev-parse", "--show-toplevel"], root);
      } catch {
        present = false;
      }
    }
    if (!present) {
      saved_without_root(
        `saved project ${root} for ${entry.repository} is missing or no longer a Git checkout; serving ${entry.repository} without a local project. Re-register it with pdb config set serve.projects, or start the server with --project PATH.`,
      );
      continue;
    }
    let resolved: string | null = null;
    try {
      resolved = (await runtime.currentRepository(root)).trim();
    } catch {
      resolved = null;
    }
    if (resolved === null) {
      diagnostics.push(
        `saved project ${root} could not be identified as ${entry.repository} right now (gh or the network did not answer); serving it as saved. Check gh auth status if this persists.`,
      );
      saved.push(entry);
      served.add(entry.repository, root, "the saved registration");
      continue;
    }
    if (resolved.toLowerCase() !== entry.repository.toLowerCase()) {
      saved_without_root(
        `saved project ${root} is now ${resolved || "not a GitHub repository"}, not ${entry.repository}; serving ${entry.repository} without that local project. Update the registration with pdb config set serve.projects, or start the server with --project PATH.`,
      );
      continue;
    }
    saved.push(entry);
    served.add(entry.repository, root, "the saved registration");
  }

  // Explicit targets: a repo-only entry never erases a saved local root, and a verified root
  // refines a repo-only one.
  const explicit: GlobalProject[] = [];
  for (const repository of options.repos) {
    if (!repositoryPattern.test(repository))
      throw new RegistrationError(EXIT_USAGE, "--repo must be owner/name.");
    served.add(repository, undefined, "this request");
    explicit.push({ host: "github.com", repository });
  }
  const verified: GlobalProject[] = [...explicit];
  for (const path of options.projects) {
    const project = await resolveProject(path, runtime);
    served.add(project.repository, project.root, "this request");
    verified.push({
      host: "github.com",
      repository: project.repository,
      localRoot: project.root,
    });
  }
  const cwd = await cwdRepository(runtime);
  if (cwd) {
    served.add(cwd.repository, cwd.root, "the working directory");
    verified.push({ host: "github.com", repository: cwd.repository, localRoot: cwd.root });
  }

  const merged = served.values();

  // Refine a repo-only saved entry with the root verified this run; append genuinely new ones.
  // Two different roots for one repository were already refused by ServedSet.add above.
  const next: GlobalProject[] = saved.map((entry) => ({ ...entry }));
  for (const entry of verified) {
    // Match the host too: a github.com target must not refine an enterprise registration that
    // happens to name the same owner/name, and must not be lost behind it.
    const index = next.findIndex(
      (existing) =>
        canonicalHost(existing.host) === canonicalHost(entry.host) &&
        canonical(existing.repository) === canonical(entry.repository),
    );
    if (index === -1) next.push(entry);
    else if (!next[index]!.localRoot) next[index] = { ...next[index]!, localRoot: entry.localRoot };
  }
  const registered = next.filter(
    (entry) => !stored.some((existing) => sameRegistration(existing, entry)),
  );

  if (!merged.length)
    throw new RegistrationError(
      EXIT_USAGE,
      `nothing to serve: no --repo, --project, saved registration or Git repository in ${runtime.cwd ?? "the working directory"}. Register one with pdb config set serve.projects '[{ repository = "owner/name" }]', or pass --repo owner/name (or --project PATH) to this command.`,
    );

  // Persist once, atomically, under the shared lock discipline. A failure here fails startup:
  // the server never claims a registration it did not record.
  const changed =
    next.length !== stored.length || next.some((entry, i) => !sameRegistration(entry, stored[i]!));
  if (changed || initialized) {
    try {
      await writeGlobalConfig(boundary.dir, new Map([["serve.projects", next]]), {
        ...(boundary.fs ? { fs: boundary.fs } : {}),
        // Refuse rather than overwrite a registration another startup or `config set` wrote
        // after we read it: a merge from a stale baseline would drop that change.
        expectedRaw: baseline,
      });
    } catch (error) {
      throw new RegistrationError(
        EXIT_USAGE,
        `${path} could not be updated: ${error instanceof Error ? error.message : String(error)} Nothing was registered and no server was started.`,
      );
    }
  }

  return { served: merged, saved: next, registered, diagnostics, initialized };
}
