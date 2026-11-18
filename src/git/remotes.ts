/**
 * The Git process boundary and remote-URL parsing (#904): the injectable runner and the
 * github.com remote parser, shared by the typed Git service and configuration. Kept free of
 * application imports so the service and its consumers never form an import cycle.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Git boundary: runs `git` with arguments in a directory and returns stdout. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

const run = promisify(execFile);
export const nodeGit: GitRunner = async (args, cwd, signal) =>
  (await run("git", [...args], { cwd, signal, windowsHide: true })).stdout;

/** Parse one remote URL; returns `owner/name` only when the host is exactly github.com. */
export function githubRepositoryFromUrl(url: string): string | null {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    // SCP-style `git@github.com:owner/name.git`; a single letter is a Windows drive.
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  if (host.toLowerCase() !== "github.com") return null;
  const match = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(path);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Extract `owner/name` from `git remote -v` output (https, ssh and scp-like forms). */
export function githubRepositories(remotes: string): string[] {
  const found = new Set<string>();
  for (const line of remotes.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const url = fields.length >= 2 ? fields[1]! : fields[0]!;
    const repository = url ? githubRepositoryFromUrl(url) : null;
    if (repository) found.add(repository);
  }
  return [...found];
}
