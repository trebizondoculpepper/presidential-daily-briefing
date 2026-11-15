/**
 * Source-checkout freshness (#309). Contract: doc/design/source-install-diagnostics.md, "#309".
 *
 * When PDB runs from a source checkout (including through `npm link`), report the checkout's
 * branch and commit and how far it is behind or ahead of the repository default's local
 * remote-tracking ref, using local Git only. Never fetches, never touches the network, never
 * edits the repository. Every Git call has its own timeout, the whole probe has a deadline and
 * a call budget, and anything Git cannot establish is reported as unknown, never as current.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Contract limits: eight Git calls, one second each, three seconds overall. */
export const gitCallLimit = 8;
export const gitCallTimeoutMs = 1000;
export const probeDeadlineMs = 3000;
/** A remote-tracking ref whose last local fetch is older than this is reported as stale. */
export const staleAfterMs = 24 * 60 * 60 * 1000;
export const fetchCommand = "git fetch";
/** Disables only the source-checkout probe (the npm opt-outs disable both). */
export const checkoutOptOutEnv = "PDB_NO_CHECKOUT_CHECK";

/** Result of one Git call: its trimmed stdout, or why it gave none. */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "missing" | "timeout" | "failed" };

/** Runs `git` with an argument array (no shell) in `cwd`. */
export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd, timeoutMs) => gitWith("git", args, cwd, timeoutMs);

/** The real runner for a given executable; tests use it to simulate a missing Git. */
/** Variables that would make Git inspect some other repository than the one at `cwd`. */
const repositorySelection = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
];

/**
 * The exact argument array and environment for one read-only Git call. Repository selection
 * comes only from `cwd`; lazy fetching of missing objects in partial/promisor clones is off
 * (`GIT_NO_LAZY_FETCH`, Git 2.44+), and every transport is refused (`protocol.allow=never`) so
 * older Git fails on a missing object instead of reaching the network.
 */
export function gitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean))
    if (repositorySelection.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))
      delete clean[key];
  return {
    args: ["-c", "protocol.allow=never", "-c", "core.fsmonitor=false", ...args],
    env: {
      ...clean,
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  };
}

export function gitWith(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      const invocation = gitInvocation(args);
      execFile(
        binary,
        invocation.args,
        {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 64 * 1024,
          env: invocation.env,
        },
        (error, stdout) => {
          if (!error) return resolve({ ok: true, stdout: String(stdout).trim() });
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            ok: false,
            reason: e.code === "ENOENT" ? "missing" : e.killed ? "timeout" : "failed",
          });
        },
      );
    } catch {
      resolve({ ok: false, reason: "failed" });
    }
  });
}

export interface Comparison {
  /** The local ref compared with, for example `origin/main`. */
  ref: string;
  /** `remote-default` came from the remote's symbolic HEAD; `fallback` is a present origin/main. */
  source: "remote-default" | "fallback" | "upstream";
  state: "equal" | "behind" | "ahead" | "diverged" | "unknown";
  behind: number | null;
  ahead: number | null;
  reason?: string;
}

export interface CheckoutStatus {
  status: "checkout" | "unknown" | "skipped";
  reason?: string;
  branch: string | null;
  detached: boolean;
  commit: string | null;
  /** Comparison with the repository default branch's local remote-tracking ref. */
  comparison: Comparison | null;
  /** Comparison with the branch's own upstream when it differs from the default. */
  upstream: Comparison | null;
  /** Local evidence only: the FETCH_HEAD time, which need not describe this exact ref. */
  lastFetch: string | null;
  /** true when the last local fetch is older than a day, null when Git cannot tell. */
  stale: boolean | null;
  observedAt: string;
  fetchCommand: string;
}

export interface CheckoutOptions {
  /** The running installation's package root (from installedVersion). */
  root: string | null;
  /** true for an npm installation: those keep the registry check and get no Git probe. */
  installed: boolean;
  optOut?: boolean;
  git?: GitRunner;
  now?: () => number;
  callTimeoutMs?: number;
  deadlineMs?: number;
  /** Modification time of a file, or null; used for FETCH_HEAD. */
  mtime?: (path: string) => Promise<number | null>;
}

const defaultMtime = async (path: string) => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Probe the running source checkout. Never throws; a failure becomes an unknown field.
 */
export async function checkoutFreshness(options: CheckoutOptions): Promise<CheckoutStatus> {
  try {
    return await probe(options);
  } catch {
    return blank(options.now ?? Date.now, "unknown", "checkout probe failed");
  }
}

function blank(now: () => number, status: CheckoutStatus["status"], reason: string) {
  return {
    status,
    reason,
    branch: null,
    detached: false,
    commit: null,
    comparison: null,
    upstream: null,
    lastFetch: null,
    stale: null,
    observedAt: new Date(now()).toISOString(),
    fetchCommand,
  } satisfies CheckoutStatus;
}

async function probe({
  root,
  installed,
  optOut = false,
  git = runGit,
  now = Date.now,
  callTimeoutMs = gitCallTimeoutMs,
  deadlineMs = probeDeadlineMs,
  mtime = defaultMtime,
}: CheckoutOptions): Promise<CheckoutStatus> {
  if (installed) return blank(now, "skipped", "npm installation: registry check applies");
  if (optOut) return blank(now, "skipped", "disabled (opt-out or --no-update-check)");
  if (!root) return blank(now, "unknown", "installation root unknown");

  const started = now();
  let calls = 0;
  let missing = false;
  let timedOut = false;
  // One bounded Git call: refused once the budget or deadline is spent.
  const call = async (args: string[]): Promise<string | null> => {
    const left = deadlineMs - (now() - started);
    if (calls >= gitCallLimit || left <= 0) {
      timedOut = true;
      return null;
    }
    calls++;
    const timeout = Math.min(callTimeoutMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      git(args, root, timeout),
      new Promise<GitResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeout + 50);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!result.ok && result.reason === "missing") missing = true;
    if (!result.ok && result.reason === "timeout") timedOut = true;
    return result.ok ? result.stdout : null;
  };

  const info = await call([
    "rev-parse",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
    "--is-shallow-repository",
  ]);
  if (info === null)
    return blank(
      now,
      "unknown",
      missing ? "Git is not available" : timedOut ? "Git timed out" : "not a Git checkout",
    );
  const [, gitDir = "", commonDir = "", shallow = ""] = info.split(/\r?\n/);
  const result: CheckoutStatus = { ...blank(now, "checkout", ""), reason: undefined };

  result.commit = await call(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const branch = await call(["symbolic-ref", "-q", "--short", "HEAD"]);
  result.branch = branch || null;
  result.detached = !branch && result.commit !== null;

  // FETCH_HEAD lives in the common directory; a worktree's own git dir is checked too.
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p));
  // A stalled filesystem must not outlast the overall deadline either.
  const left = Math.max(0, deadlineMs - (now() - started));
  let fsTimer: ReturnType<typeof setTimeout> | undefined;
  const times = await Promise.race([
    Promise.all(
      [...new Set([commonDir, gitDir].filter(Boolean))].map((d) =>
        mtime(join(abs(d), "FETCH_HEAD")).catch(() => null),
      ),
    ),
    new Promise<null[]>((resolve) => {
      fsTimer = setTimeout(() => resolve([]), left);
    }),
  ]).finally(() => clearTimeout(fsTimer));
  const fetched = Math.max(...times.map((t) => t ?? -Infinity));
  if (Number.isFinite(fetched)) {
    result.lastFetch = new Date(fetched).toISOString();
    result.stale = now() - fetched > staleAfterMs;
  }

  const unknown = (ref: string, source: Comparison["source"], reason: string): Comparison => ({
    ref,
    source,
    state: "unknown",
    behind: null,
    ahead: null,
    reason,
  });
  const compare = async (ref: string, source: Comparison["source"]): Promise<Comparison> => {
    if (result.commit === null) return unknown(ref, source, "no commit checked out");
    if (shallow === "true") return unknown(ref, source, "shallow history");
    const counts = await call(["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
    const m = /^(\d+)\s+(\d+)$/.exec(counts ?? "");
    if (!m) return unknown(ref, source, timedOut ? "Git timed out" : "comparison failed");
    const behind = +m[1];
    const ahead = +m[2];
    const state =
      behind && ahead ? "diverged" : behind ? "behind" : ahead ? "ahead" : ("equal" as const);
    return { ref, source, state, behind, ahead };
  };

  // One call resolves origin/HEAD's target, whether origin/main exists and the branch's upstream.
  const patterns = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"];
  if (result.branch) patterns.push(`refs/heads/${result.branch}`);
  const refs = await call([
    "for-each-ref",
    "--format=%(refname)%09%(symref:lstrip=2)%09%(upstream:short)",
    ...patterns,
  ]);
  const rows = new Map(
    (refs ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, symref = "", upstream = ""] = line.split("\t");
        return [name, { symref, upstream }] as const;
      }),
  );
  // Prefer the remote's symbolic default; a present origin/main is an explicitly labelled fallback.
  const symbolic = rows.get("refs/remotes/origin/HEAD")?.symref;
  let defaultRef: { ref: string; source: Comparison["source"] } | null = null;
  if (symbolic) defaultRef = { ref: symbolic, source: "remote-default" };
  else if (rows.has("refs/remotes/origin/main"))
    defaultRef = { ref: "origin/main", source: "fallback" };
  result.comparison = defaultRef
    ? await compare(defaultRef.ref, defaultRef.source)
    : unknown(
        "origin/main",
        "fallback",
        refs === null ? (timedOut ? "Git timed out" : "refs unreadable") : "no remote-tracking ref",
      );

  // The branch's own upstream, reported separately: it may be another feature branch.
  const up = result.branch ? rows.get(`refs/heads/${result.branch}`)?.upstream : undefined;
  if (up && up !== defaultRef?.ref) result.upstream = await compare(up, "upstream");

  // HEAD moving during collection makes every comparison unreliable.
  const measured = [result.comparison, result.upstream].some((c) => c && c.state !== "unknown");
  if (result.commit && measured) {
    const again = await call(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (again !== result.commit) {
      const why = again === null ? "Git timed out" : "checkout changed during inspection; retry";
      if (result.comparison)
        result.comparison = unknown(result.comparison.ref, result.comparison.source, why);
      if (result.upstream)
        result.upstream = unknown(result.upstream.ref, result.upstream.source, why);
    }
  }
  if (result.commit === null)
    result.reason = timedOut ? "Git timed out" : "no commit checked out (unborn HEAD)";
  return result;
}

/** Detailed lines for `pdb version`. */
export function describeCheckout(s: CheckoutStatus): string[] {
  if (s.status !== "checkout") return [`Source checkout: ${s.status} — ${s.reason}`];
  const head = s.detached ? "detached HEAD" : s.branch ? `branch ${s.branch}` : "no branch";
  const lines = [
    `Source checkout: ${head} at ${s.commit ? s.commit.slice(0, 12) : "(no commit)"}`,
    `  ${comparisonLine(s.comparison)}`,
  ];
  if (s.upstream) lines.push(`  ${comparisonLine(s.upstream)}`);
  lines.push(
    s.lastFetch
      ? `  Last local fetch (FETCH_HEAD): ${s.lastFetch}${s.stale ? " — stale" : ""}`
      : "  Last local fetch: unknown",
    `  Local refs only; refresh them with: ${s.fetchCommand}`,
  );
  return lines;
}

function comparisonLine(c: Comparison | null): string {
  if (!c) return "Compared with main: unknown";
  const label = `${c.ref}${c.source === "fallback" ? " (fallback)" : c.source === "upstream" ? " (upstream)" : ""}`;
  if (c.state === "unknown") return `Compared with ${label}: unknown — ${c.reason}`;
  if (c.state === "equal") return `Compared with ${label}: same commit as the local ref`;
  return `Compared with ${label}: ${c.behind} behind, ${c.ahead} ahead (${c.state})`;
}

/**
 * The short routine warning: only for a proven behind or diverged default comparison.
 */
export function checkoutAdvisory(s: CheckoutStatus): string | null {
  const c = s.comparison;
  if (s.status !== "checkout" || !c || (c.state !== "behind" && c.state !== "diverged"))
    return null;
  const fetched = s.lastFetch ? `last fetched ${s.lastFetch}` : "last fetch unknown";
  return `pdb is running from a source checkout ${c.behind} commit${c.behind === 1 ? "" : "s"} behind ${c.ref} (${fetched}). Details: pdb version`;
}
