/**
 * Contributor routing guidance (#672, doc/design/human-assignment-safeguard.md "Assignment triage
 * comes first"). Reads the verified project's root `CONTRIBUTORS.md` and reports what it says,
 * with provenance. It is a reader only: no assignment, no routing decision and no workflow policy
 * (the native rules and #673 decide; the implementer judges the closest area).
 *
 * The file stays human-readable prose. What is recognised:
 *
 * - **accounts:** every GitHub mention `@login` (letters, digits and single hyphens);
 * - **areas:** each `##` or `###` heading starts an area. Its accounts are the mentions in its
 *   section; an optional `Paths:` (or `Subtrees:`) line lists subtrees in backticks;
 * - **default:** only an explicit line `Default: @login` (optionally bulleted or bold). Prose such
 *   as "use this account as the default" is not interpreted. Two different defaults are
 *   ambiguous, never resolved by order.
 *
 * Evidence, never guesses: a missing, unreadable, oversized (truncated), symlinked or non-file
 * guidance is reported as such, and the content digest plus git revision let a caller detect a
 * change before acting on what it read. Ticket text is not an input here.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { nodeGit, resolveRepositoryTarget, type GitRunner } from "./config.js";

export const contributorsFile = "CONTRIBUTORS.md";
/** Guidance is a short document; anything larger is reported truncated rather than half-read. */
export const contributorsMaxBytes = 64 * 1024;

export interface GuidanceArea {
  title: string;
  accounts: string[];
  paths: string[];
}

export type ContributorGuidance =
  | {
      state: "available";
      repository: string;
      path: string;
      /** sha256 of the exact bytes read; compare before acting on this guidance. */
      digest: string;
      /** The checkout's HEAD when read, or null when git could not say. */
      revision: string | null;
      accounts: string[];
      areas: GuidanceArea[];
      default:
        | { state: "explicit"; account: string }
        | { state: "none" }
        | { state: "ambiguous"; accounts: string[] };
      /** Evidence problems that do not make the guidance unreadable (an area with no account). */
      problems: string[];
    }
  | {
      state: "missing" | "unreadable" | "unsafe" | "truncated";
      repository: string;
      path: string;
      reason: string;
    };

const login = /(?<![\w/.@-])@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})\b/g;
const defaultLine =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?default(?: human)?(?: owner)?(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})\b/i;
const pathsLine = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:paths|subtrees)(?:\*\*|__)?\s*:(.*)$/i;
const heading = /^(#{2,3})\s+(.+?)\s*#*\s*$/;

const mentions = (text: string): string[] => [...text.matchAll(login)].map((m) => m[1]!);
const unique = (items: string[]): string[] => [...new Set(items.map((a) => a.toLowerCase()))];

/** Parse guidance text (pure). */
export function parseContributors(
  text: string,
): Pick<
  Extract<ContributorGuidance, { state: "available" }>,
  "accounts" | "areas" | "default" | "problems"
> {
  // Code blocks are examples, not guidance.
  const lines = text.replace(/```[\s\S]*?```/g, "").split(/\r?\n/);
  const areas: GuidanceArea[] = [];
  const defaults: string[] = [];
  let current: GuidanceArea | null = null;
  for (const line of lines) {
    const h = heading.exec(line);
    if (h) {
      current = { title: h[2]!.trim(), accounts: [], paths: [] };
      areas.push(current);
      continue;
    }
    const d = defaultLine.exec(line);
    // The default is file-wide, not ownership of the area it happens to follow.
    if (d) {
      defaults.push(d[1]!.toLowerCase());
      continue;
    }
    if (current) {
      current.accounts.push(...mentions(line));
      const p = pathsLine.exec(line);
      if (p) current.paths.push(...[...p[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()));
    }
  }
  for (const a of areas) a.accounts = unique(a.accounts);
  const distinctDefaults = unique(defaults);
  return {
    accounts: unique(mentions(lines.join("\n"))),
    areas,
    default:
      distinctDefaults.length === 0
        ? { state: "none" }
        : distinctDefaults.length === 1
          ? { state: "explicit", account: distinctDefaults[0]! }
          : { state: "ambiguous", accounts: distinctDefaults },
    problems: [
      ...areas
        .filter((a) => !a.accounts.length)
        .map((a) => `area "${a.title}" names no GitHub account`),
      ...(distinctDefaults.length > 1
        ? [
            `several defaults are given (${distinctDefaults.map((a) => `@${a}`).join(", ")}); none is used`,
          ]
        : []),
    ],
  };
}

export interface ContributorsRuntime {
  readFile?: (path: string) => Promise<Buffer>;
  lstat?: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  /** HEAD of the checkout; null when unknown. */
  revision?: (root: string) => Promise<string | null>;
}

/**
 * Read the guidance of `repository` from `root`, which the caller has already verified to be a
 * checkout of that repository (resolveRepositoryTarget). Never reads outside the root file.
 */
export async function readContributors(
  repository: string,
  root: string,
  runtime: ContributorsRuntime = {},
): Promise<ContributorGuidance> {
  const path = contributorsFile;
  const full = join(root, contributorsFile);
  const base = { repository, path };
  let info: { isFile(): boolean; isSymbolicLink(): boolean; size: number };
  try {
    info = await (runtime.lstat ?? lstat)(full);
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? { ...base, state: "missing", reason: `${path} does not exist at the project root` }
      : { ...base, state: "unreadable", reason: `${path} cannot be inspected` };
  }
  if (info.isSymbolicLink())
    return {
      ...base,
      state: "unsafe",
      reason: `${path} is a symbolic link; guidance is read only from the project's own file`,
    };
  if (!info.isFile()) return { ...base, state: "unsafe", reason: `${path} is not a regular file` };
  if (info.size > contributorsMaxBytes)
    return {
      ...base,
      state: "truncated",
      reason: `${path} is larger than ${contributorsMaxBytes} bytes; it was not read`,
    };
  let bytes: Buffer;
  try {
    bytes = await (runtime.readFile ?? readFile)(full);
  } catch {
    return { ...base, state: "unreadable", reason: `${path} cannot be read` };
  }
  if (bytes.length > contributorsMaxBytes)
    return {
      ...base,
      state: "truncated",
      reason: `${path} grew past ${contributorsMaxBytes} bytes while read`,
    };
  const revision = runtime.revision ? await runtime.revision(root).catch(() => null) : null;
  return {
    ...base,
    state: "available",
    digest: createHash("sha256").update(bytes).digest("hex"),
    revision,
    ...parseContributors(bytes.toString("utf8")),
  };
}

/**
 * Whether guidance changed since it was read: compare before any assignment based on it. Unknown
 * (anything not available now) counts as changed, so stale guidance is never acted on.
 */
export const guidanceChanged = (read: ContributorGuidance, now: ContributorGuidance): boolean =>
  read.state !== "available" || now.state !== "available" || read.digest !== now.digest;

/** Text report for `pdb contributors`. */
export function contributorsText(g: ContributorGuidance): string {
  if (g.state !== "available")
    return `Contributor guidance for ${g.repository}: ${g.state.toUpperCase()} — ${g.reason}\n`;
  const lines = [
    `Contributor guidance for ${g.repository} (${g.path}, sha256 ${g.digest.slice(0, 12)}${g.revision ? `, at ${g.revision.slice(0, 7)}` : ""})`,
    `Accounts: ${g.accounts.length ? g.accounts.map((a) => `@${a}`).join(", ") : "none"}`,
    `Default: ${g.default.state === "explicit" ? `@${g.default.account}` : g.default.state === "ambiguous" ? `AMBIGUOUS (${g.default.accounts.map((a) => `@${a}`).join(", ")}); none is used` : 'none (no "Default: @login" line)'}`,
    "Areas:",
    ...g.areas.map(
      (a) =>
        `  ${a.title}: ${a.accounts.length ? a.accounts.map((x) => `@${x}`).join(", ") : "no account"}${a.paths.length ? `; paths ${a.paths.join(", ")}` : ""}`,
    ),
    ...g.problems.map((p) => `PROBLEM: ${p}`),
    "Read-only. Routing judges the closest area; the native rules decide what happens.",
  ];
  return lines.join("\n") + "\n";
}

export const contributorsUsage = "Usage: pdb contributors [--repo owner/name] [--json]";

/**
 * `pdb contributors`: report the guidance of the verified local checkout. Read-only; no GitHub
 * request. Exit 0 available, 2 not available (missing, unsafe, truncated, unreadable) or no
 * matching checkout, 1 bad usage is reported as 2 like other read commands' prerequisites.
 */
export async function runContributors(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: { git?: GitRunner; cwd?: string } = {},
  read: ContributorsRuntime = {},
): Promise<number> {
  let values: { repo?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { repo: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
    }));
  } catch (error) {
    await output(`pdb contributors: ${(error as Error).message}\n${contributorsUsage}\n`);
    return 2;
  }
  if (values.help) {
    await output(
      `${contributorsUsage}\n\nReads the project-root CONTRIBUTORS.md of this verified checkout: GitHub accounts (@login), areas (## or ### headings, optional "Paths:" with backticked subtrees) and an explicit "Default: @login" line. Read-only; nothing is assigned.\n`,
    );
    return 0;
  }
  const git = runtime.git ?? nodeGit;
  let target: { root: string; repository: string };
  try {
    target = await resolveRepositoryTarget(runtime.cwd ?? process.cwd(), values.repo, git);
  } catch (error) {
    await output(
      `pdb contributors: ${(error as Error).message} Guidance is read only from a checkout of the target repository; another checkout's file is never used.\n`,
    );
    return 2;
  }
  const guidance = await readContributors(target.repository, target.root, {
    revision: async (root) => (await git(["rev-parse", "HEAD"], root)).trim() || null,
    ...read,
  });
  await output(
    values.json
      ? JSON.stringify({ schemaVersion: 1, kind: "contributor-guidance", ...guidance }, null, 2) +
          "\n"
      : contributorsText(guidance),
  );
  return guidance.state === "available" ? 0 : 2;
}
