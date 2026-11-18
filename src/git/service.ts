/**
 * The typed Git service (#897, doc/design/github-service-composition.md "Accepted Git
 * implementation and script exception").
 *
 * Application callers ask this service for facts, not for argv and stdout: it runs the installed
 * Git executable through the existing injected `GitRunner` transport, interprets the output
 * inside this boundary, and returns validated typed results. It distinguishes an absent answer
 * (an unborn branch, no such path) from an execution failure and from cancellation, preserves
 * explicit per-call checkout context and AbortSignal, and never shells out or writes.
 *
 * Construction performs no Git work and no remote lookup. One instance is safe for concurrent
 * calls because it holds no per-call state: every method takes its checkout explicitly.
 */
import { execFile } from "node:child_process";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { githubRepositories, type GitRunner } from "./remotes.js";

/** Why a Git read failed. Absence is a result, never an error code. */
export type GitErrorCode = "not-a-repository" | "not-a-checkout" | "cancelled" | "failed";

/** A Git read that could not produce an answer. */
export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly operation?: string,
    /** The child's exit status when Git ran but refused; undefined for spawn/cancel. */
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** One call's context: where to run, and how the caller cancels. */
export interface GitContext {
  /** Explicit checkout or working directory. Never a process-global selection. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** A configured remote and, when it is a GitHub URL, the repository it names. */
export interface GitRemote {
  readonly name: string;
  readonly url: string;
  /** Lower-case host from the URL, or null when the URL has no host form Git can parse. */
  readonly host: string | null;
  /** `owner/name` for a github.com remote; null for any other host or URL. */
  readonly repository: string | null;
}

/** A verified checkout identity, always taken from the checkout's own remotes. */
export interface CheckoutIdentity {
  readonly host: string;
  readonly repository: string;
}

/** Divergence between two revisions, from `git rev-list --left-right --count`. */
export interface Divergence {
  /** Commits reachable from the left revision only. */
  readonly left: number;
  /** Commits reachable from the right revision only. */
  readonly right: number;
}

/** The typed Git capabilities application callers use. */
export interface GitService {
  /** The checkout's working-tree root, or null when `cwd` is not inside one. */
  workingTreeRoot(context: GitContext): Promise<string | null>;
  /** The common Git directory (shared by worktrees), or null outside a checkout. */
  commonDirectory(context: GitContext): Promise<string | null>;
  /** A Git-owned path such as `info/exclude`, or null outside a checkout. */
  gitPath(context: GitContext, name: string): Promise<string | null>;
  /** Every configured remote, in `git remote -v` order, with duplicates removed. */
  remotes(context: GitContext): Promise<readonly GitRemote[]>;
  /** The checkout's GitHub identity from its own remotes, or null when it has none to trust. */
  checkout(context: GitContext): Promise<CheckoutIdentity | null>;
  /** The HEAD commit id, or null on an unborn branch. */
  revision(context: GitContext): Promise<string | null>;
  /** The checked-out branch name, or null when HEAD is detached. */
  headRef(context: GitContext): Promise<string | null>;
  /** Whether `ancestor` is reachable from `descendant`; false when either is unknown. */
  isAncestor(context: GitContext, ancestor: string, descendant: string): Promise<boolean>;
  /** Commits unique to each side of `left...right`, or null when either revision is unknown. */
  divergence(context: GitContext, left: string, right: string): Promise<Divergence | null>;
  /** Whether Git's ignore rules would ignore `path` in this checkout. */
  isIgnored(context: GitContext, path: string, options?: { noIndex?: boolean }): Promise<boolean>;
  /** Whether `path` is tracked in the index. */
  isTracked(context: GitContext, path: string): Promise<boolean>;
}

/** The transport and any fixed defaults the service is built from. */
export interface GitServiceOptions {
  /** Injected transport: the existing runner, faked in tests. */
  readonly git?: GitRunner;
  /**
   * The caller's inherited alternate index (`GIT_INDEX_FILE`, e.g. inside a commit hook), checked
   * in addition to the checkout's own index by `isTracked`. Defaults to the process's value when
   * no runner is injected; tests pass it with a runner.
   */
  readonly alternateIndex?: { file: string; runner: GitRunner };
}

/**
 * Variables that relocate Git's idea of which repository it is reading. Inheriting them would
 * let `GIT_DIR`/`GIT_WORK_TREE` make a call in checkout B read checkout A, which the explicit
 * checkout contract forbids.
 */
export const GIT_REPOSITORY_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
] as const;

/** A copy of `env` with the repository-location variables removed. Never mutates the input. */
export function sanitizedGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REPOSITORY_ENVIRONMENT) delete copy[name];
  return copy;
}

const runIsolatedGit = (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let outcome: { ok: true; stdout: string } | { ok: false; error: unknown } = {
      ok: false,
      error: new Error("git exited without an outcome"),
    };
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        signal,
        windowsHide: true,
        killSignal: "SIGKILL",
        env,
      },
      (error, stdout) => {
        outcome = error ? { ok: false, error } : { ok: true, stdout: String(stdout ?? "") };
      },
    );
    // Wait for `close` so an aborted/timed-out child is killed (SIGKILL) and reaped before settling.
    child.once("close", () => {
      if (signal?.aborted) {
        reject(
          signal.reason ??
            Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        );
      } else if (outcome.ok) {
        resolve(outcome.stdout);
      } else {
        reject(outcome.error);
      }
    });
  });
};

/**
 * The default transport: the installed binary, an argument array, no shell, an explicit cwd and
 * a sanitized environment. Each call gets its own copy, so concurrent calls cannot interfere.
 */
const isolatedNodeGit: GitRunner = (args, cwd, signal) =>
  runIsolatedGit(args, cwd, signal, sanitizedGitEnvironment());

/** A sanitized runner that reads one named index, for the alternate-index tracked check. */
const alternateIndexGit =
  (file: string): GitRunner =>
  (args, cwd, signal) =>
    runIsolatedGit(args, cwd, signal, { ...sanitizedGitEnvironment(), GIT_INDEX_FILE: file });

const alternateIndexOf = (file: string) => ({ file, runner: alternateIndexGit(file) });

const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;

/** Host of a Git remote URL (`https`, `ssh`, `git+ssh` and SCP-style), or null. */
export function remoteHost(url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return new URL(url).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  const scp = SCP.exec(url);
  // A single letter is a Windows drive, not a host.
  return scp && !/^[a-z]$/i.test(scp[1]!) ? scp[1]!.toLowerCase() : null;
}

/** Classify a transport rejection: cancellation, a missing checkout, or a real failure. */
function classify(error: unknown, operation: string): GitError {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError")
    return new GitError("cancelled", `${operation} was cancelled.`, operation);
  const exitCode = Number((error as { code?: unknown } | null)?.code);
  const exited = Number.isInteger(exitCode) ? exitCode : undefined;
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? "");
  if (/not a git repository/i.test(stderr))
    return new GitError(
      "not-a-repository",
      `${operation}: not inside a Git checkout.`,
      operation,
      exited,
    );
  if (
    /unknown revision|bad revision|ambiguous argument|Needed a single revision|Not a valid object name|Invalid symmetric difference expression|must be run in a work tree/i.test(
      stderr,
    )
  )
    return new GitError(
      "not-a-checkout",
      `${operation}: the revision is unknown.`,
      operation,
      exited,
    );
  const message = error instanceof Error ? error.message : String(error);
  return new GitError("failed", `${operation} failed: ${message}`, operation, exited);
}

/** Run one read and return trimmed stdout, or null when Git answered with nothing. */
async function read(
  git: GitRunner,
  args: readonly string[],
  context: GitContext,
  operation: string,
): Promise<string | null> {
  try {
    const output = (await git(args, context.cwd, context.signal)).trim();
    return output === "" ? null : output;
  } catch (error) {
    throw classify(error, operation);
  }
}

/**
 * Read a filesystem path: Git terminates output with one newline, and everything before it is the
 * path itself — trailing spaces are part of a real path and must survive.
 */
async function readPath(
  git: GitRunner,
  args: readonly string[],
  context: GitContext,
  operation: string,
): Promise<string | null> {
  try {
    const output = (await git(args, context.cwd, context.signal)).replace(/\r?\n$/, "");
    return output === "" ? null : output;
  } catch (error) {
    throw classify(error, operation);
  }
}

/** A path read where a missing checkout is an absence rather than a failure. */
async function maybePath(
  git: GitRunner,
  args: readonly string[],
  context: GitContext,
  operation: string,
): Promise<string | null> {
  try {
    return await readPath(git, args, context, operation);
  } catch (error) {
    if (error instanceof GitError && error.code !== "failed" && error.code !== "cancelled")
      return null;
    throw error;
  }
}

/** Whether a read that may legitimately find nothing answered at all. */
async function maybe(
  git: GitRunner,
  args: readonly string[],
  context: GitContext,
  operation: string,
): Promise<string | null> {
  try {
    return await read(git, args, context, operation);
  } catch (error) {
    // Only a missing checkout/revision is an absence here; anything else is still a failure.
    if (error instanceof GitError && error.code !== "failed" && error.code !== "cancelled")
      return null;
    throw error;
  }
}

/**
 * Build one Git service. Construction does no work: no process is spawned and no remote is
 * contacted until a method is called with an explicit context.
 */
export function createGitService(options: GitServiceOptions = {}): GitService {
  const git = options.git ?? isolatedNodeGit;
  const alternate =
    options.alternateIndex ??
    (!options.git && process.env.GIT_INDEX_FILE
      ? alternateIndexOf(resolvePath(process.cwd(), process.env.GIT_INDEX_FILE))
      : undefined);

  const remotes = async (context: GitContext): Promise<readonly GitRemote[]> => {
    const output = await maybe(git, ["remote", "-v"], context, "git remote");
    if (output === null) return [];
    const seen = new Set<string>();
    const found: GitRemote[] = [];
    for (const line of output.split(/\r?\n/)) {
      // `git remote -v` prints "<name>\t<url> (fetch|push)". Split on the first separator and
      // keep the rest verbatim: a local-path URL may itself contain spaces. A partial-clone
      // remote may append a trailing annotation after the (fetch) entry, e.g.
      // "origin <url> (fetch) [blob:none]"; accept and ignore anything after the direction.
      const parsed = /^(\S+)\s+(.*?)\s+\((?:fetch|push)\)(?:\s+.*)?$/.exec(line.trim());
      if (!parsed) continue;
      const [, name, url] = parsed as unknown as [string, string, string];
      // A remote may fetch from one repository and push to another; both URLs are facts, so
      // deduplicate identical name/URL pairs rather than every entry sharing a name.
      const identity = `${name}\u0000${url}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const host = remoteHost(url);
      const github =
        host === "github.com" ? (githubRepositories(`${name} ${url}`)[0] ?? null) : null;
      found.push({ name, url, host, repository: github });
    }
    return found;
  };

  /**
   * Whether an index file belongs to this context's checkout: it lies inside the checkout's own
   * Git directory or its common directory. A commit hook's index does; another checkout's never.
   */
  const ownsIndex = async (context: GitContext, file: string): Promise<boolean> => {
    const dirs = await Promise.all([
      maybePath(git, ["rev-parse", "--absolute-git-dir"], context, "git rev-parse"),
      maybePath(git, ["rev-parse", "--git-common-dir"], context, "git rev-parse"),
    ]);
    // Compare real paths, so a symlinked temporary or home directory cannot hide ownership.
    const real = async (path: string) => realpath(path).catch(() => path);
    const target = await real(resolvePath(file)).then(async (t) =>
      // A hook's index (index.lock) may not exist yet: resolve its directory instead.
      t === resolvePath(file)
        ? resolvePath(await real(dirname(resolvePath(file))), basename(file))
        : t,
    );
    for (const dir of dirs) {
      if (!dir) continue;
      const base = await real(resolvePath(context.cwd, dir));
      if (target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)) return true;
    }
    return false;
  };

  return {
    async workingTreeRoot(context) {
      return maybePath(git, ["rev-parse", "--show-toplevel"], context, "git rev-parse");
    },

    async commonDirectory(context) {
      return maybePath(git, ["rev-parse", "--git-common-dir"], context, "git rev-parse");
    },

    async gitPath(context, name) {
      if (!name.trim()) throw new GitError("failed", "git rev-parse needs a path name.");
      return maybePath(git, ["rev-parse", "--git-path", name], context, "git rev-parse");
    },

    remotes,

    async checkout(context) {
      const found = await remotes(context);
      const candidates = found.filter((remote) => remote.repository !== null);
      // Exactly one GitHub repository across the remotes is authoritative; forks and mirrors
      // that disagree are reported as "cannot tell" rather than silently choosing one.
      const repositories = [...new Set(candidates.map((remote) => remote.repository!))];
      if (repositories.length !== 1) return null;
      return { host: "github.com", repository: repositories[0]! };
    },

    async revision(context) {
      // An unborn branch has no HEAD commit. `-q` suppresses the diagnostic, so Git exits 1
      // silently: that exit status is the absence signal, and everything else still fails.
      try {
        return await maybe(git, ["rev-parse", "--verify", "-q", "HEAD"], context, "git rev-parse");
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 1) return null;
        throw error;
      }
    },

    async headRef(context) {
      // A detached HEAD is exit 1 with no output: absence, not a failure.
      try {
        return await maybe(git, ["symbolic-ref", "-q", "HEAD"], context, "git symbolic-ref");
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 1) return null;
        throw error;
      }
    },

    async isAncestor(context, ancestor, descendant) {
      try {
        await git(
          ["merge-base", "--is-ancestor", ancestor, descendant],
          context.cwd,
          context.signal,
        );
        return true;
      } catch (error) {
        const classified = classify(error, "git merge-base");
        // Exit 1 is the documented "not an ancestor" answer; anything else is a failure.
        if (classified.exitCode === 1) return false;
        if (classified.code !== "cancelled" && classified.code !== "failed") return false;
        throw classified;
      }
    },

    async divergence(context, left, right) {
      const output = await maybe(
        git,
        ["rev-list", "--left-right", "--count", `${left}...${right}`],
        context,
        "git rev-list",
      );
      if (output === null) return null;
      const [first, second] = output.split(/\s+/);
      const counts = [Number(first), Number(second)];
      if (counts.some((count) => !Number.isInteger(count) || count < 0))
        throw new GitError("failed", "git rev-list returned counts this build cannot read.");
      return { left: counts[0]!, right: counts[1]! };
    },

    async isIgnored(context, path, options) {
      if (!path.trim()) throw new GitError("failed", "An ignore check needs a path.");
      try {
        // check-ignore rejects `--literal-pathspecs` ("pathspec magic not supported"), so its
        // argument keeps Git's pathspec semantics; ls-files below can be made literal.
        await git(
          ["check-ignore", "--quiet", ...(options?.noIndex ? ["--no-index"] : []), "--", path],
          context.cwd,
          context.signal,
        );
        return true;
      } catch (error) {
        const classified = classify(error, "git check-ignore");
        // Exit 1 is "not ignored"; 128 means this checkout has no ignore support to ask.
        if (classified.exitCode === 1) return false;
        if (classified.code === "not-a-repository") return false;
        throw classified;
      }
    },

    async isTracked(context, path) {
      if (!path.trim()) throw new GitError("failed", "A tracked check needs a path.");
      const ask = async (runner: GitRunner): Promise<boolean> => {
        try {
          await runner(
            ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path],
            context.cwd,
            context.signal,
          );
          return true;
        } catch (error) {
          const classified = classify(error, "git ls-files");
          // Exit 1 is "not tracked"; a missing checkout cannot answer, and is not tracked.
          if (classified.exitCode === 1) return false;
          if (classified.code === "not-a-repository") return false;
          throw classified;
        }
      };
      if (await ask(git)) return true;
      // An inherited alternate index (a commit hook's) may track what the checkout's own index
      // does not: tracked in either is tracked, and an alternate that cannot answer is a failure,
      // so a tracked-file guard refuses rather than writing.
      if (!alternate || !(await ownsIndex(context, alternate.file))) return false;
      return ask(alternate.runner);
    },
  };
}
