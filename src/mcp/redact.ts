/**
 * Local-path redaction shared by the MCP adapter and `pdb serve` (doc/design/mcp.md, serve.md):
 * results may quote local directories, which never reach a remote consumer.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const pathPlaceholder = "<local checkout>";

/** Directories this server knows about whose names must not reach the MCP client. */
export function localPaths(...projects: (string | undefined)[]): string[] {
  const candidates = [
    ...projects.flatMap((project) => [project, project ? resolve(project) : undefined]),
    process.cwd(),
    homedir(),
  ];
  const paths = new Set<string>();
  for (const path of candidates) {
    if (!path) continue;
    paths.add(path);
    try {
      paths.add(realpathSync(path));
    } catch {
      // A directory that cannot be resolved is still redacted by its configured name.
    }
  }
  return [...paths];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact-prefix matcher for one verified directory, in POSIX and Windows separator forms. */
function knownPathPattern(path: string): RegExp | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  // A root ("/", "C:\\") or one-character path would match too much evidence to be useful.
  if (trimmed.length < 2 || /^[A-Za-z]:$/.test(trimmed)) return null;
  const separator = "[\\\\/]";
  const body = trimmed.split(/[\\/]/).map(escapeRegExp).join(separator);
  // Boundaries: not inside a longer path segment before or after the directory name.
  return new RegExp(
    `(?<![\\w.\\\\/-])${body}(?![\\w-]|\\.\\w)`,
    /^[A-Za-z]:/.test(trimmed) ? "gi" : "g",
  );
}

/**
 * Recursively replace verified local directories (the project, working directory and home
 * directory) in every string, including GitHub-authored evidence, where only an exact prefix
 * of a known directory can match. Other text is untouched.
 */
export function redactPaths<T>(value: T, known: readonly string[] = []): T {
  const patterns = [...known]
    .sort((a, b) => b.length - a.length)
    .map(knownPathPattern)
    .filter((pattern): pattern is RegExp => pattern !== null);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string")
      return patterns.reduce((text, pattern) => text.replace(pattern, pathPlaceholder), item);
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}

// Absolute paths not part of a URL: Windows drive or UNC paths, POSIX paths with at least two
// segments, and home-relative paths. The lookbehinds keep URL paths ("https://h/a/b") and
// repository names ("owner/name") intact.
const windowsPath = /(?<![\w/\\:])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>()|,;`]*/g;
const posixPath = /(?<![\w.:/~>\\-])\/(?:[^\s/"'<>()|,;`]+\/)+[^\s/"'<>()|,;`]*/g;
const homePath = /(?<![\w/])~[\\/][^\s"'<>()|,;`]*/g;

/** Replace a matched path, leaving sentence punctuation that followed it in place. */
const replacePath = (match: string): string => {
  const trailing = /[.:!?]+$/.exec(match)?.[0] ?? "";
  return pathPlaceholder + trailing;
};

/**
 * Replace any absolute path in one locally generated diagnostic (configuration and estimation
 * findings). Never applied to GitHub-authored fields, where "/api/v1/users" is evidence.
 */
export function redactLocalText(text: string): string {
  return text
    .replace(windowsPath, replacePath)
    .replace(posixPath, replacePath)
    .replace(homePath, replacePath);
}
