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
  | { ok: false; reason: "missing" | "timeout" | "failed"; code?: number };

/** Runs `git` with an argument array (no shell) in `cwd`. */
export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd, timeoutMs) => gitWith("git", args, cwd, timeoutMs);

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
  // Transport overrides: only the empty GIT_ALLOW_PROTOCOL set below may apply.
  "GIT_ALLOW_PROTOCOL",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
];

/**
 * The exact argument array and environment for one read-only Git call. Repository selection
 * comes only from `cwd`; lazy fetching of missing objects in partial/promisor clones is off
 * (`GIT_NO_LAZY_FETCH`, Git 2.44+), and every transport is refused (`protocol.allow=never`) so
 * older Git fails on a missing object instead of reaching the network. An empty
 * `GIT_ALLOW_PROTOCOL` overrides any `protocol.<name>.allow` configuration as well.
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
      GIT_ALLOW_PROTOCOL: "",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  };
}

/** The real runner for a given executable; tests use it to simulate a missing Git. */
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
          const e = error as Omit<NodeJS.ErrnoException, "code"> & {
            killed?: boolean;
            code?: number | string;
          };
          if (e.code === "ENOENT") return resolve({ ok: false, reason: "missing" });
          if (e.killed) return resolve({ ok: false, reason: "timeout" });
          resolve({
            ok: false,
            reason: "failed",
            ...(typeof e.code === "number" ? { code: e.code } : {}),
          });
        },
      );
    } catch {
      resolve({ ok: false, reason: "failed" });
    }
  });
}

export interface Comparison {
  /** The local ref compared with, shown short, for example `origin/main`. */
  ref: string;
  /** The full ref name actually compared, for example `refs/remotes/origin/main`. */
  fullRef?: string;
  /**
   * `remote-default` came from `refs/remotes/<remote>/HEAD`; `fallback` is a present
   * `refs/remotes/<remote>/main`; `upstream` is the branch's own configured upstream.
   */
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
  /** null when Git could not say whether HEAD is attached. */
  detached: boolean | null;
  /** The remote whose refs are compared, or null when none could be chosen. */
  remote: string | null;
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
    detached: null,
    remote: null,
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

  const repo: string = root;
  const started = now();
  let calls = 0;
  let missing = false;
  let timedOut = false;
  // One bounded Git call: refused once the budget or deadline is spent.
  const call = async (args: string[]): Promise<string | null> => {
    const result = await raw(args);
    return result.ok ? result.stdout : null;
  };
  async function raw(args: string[]): Promise<GitResult> {
    const left = deadlineMs - (now() - started);
    if (calls >= gitCallLimit || left <= 0) {
      timedOut = true;
      return { ok: false, reason: "timeout" };
    }
    calls++;
    const timeout = Math.min(callTimeoutMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      git(args, repo, timeout),
      new Promise<GitResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeout + 50);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!result.ok && result.reason === "missing") missing = true;
    if (!result.ok && result.reason === "timeout") timedOut = true;
    return result;
  }

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

  // Attached or detached: exit 1 from `symbolic-ref -q` is the only proof of a detached HEAD.
  const head = await raw(["symbolic-ref", "-q", "HEAD"]);
  const branchRef = head.ok && head.stdout.startsWith("refs/heads/") ? head.stdout : null;
  result.branch = branchRef ? branchRef.slice("refs/heads/".length) : null;
  result.detached = head.ok ? false : head.reason === "failed" && head.code === 1 ? true : null;

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

  const unknown = (
    ref: string,
    source: Comparison["source"],
    reason: string,
    fullRef?: string,
  ): Comparison => ({
    ref,
    ...(fullRef ? { fullRef } : {}),
    source,
    state: "unknown",
    behind: null,
    ahead: null,
    reason,
  });
  const failure = (fallback: string) => (timedOut ? "Git timed out" : fallback);

  // Which remote: the branch upstream's remote, else the only configured remote.
  const remotesOut = await call(["remote"]);
  const remotes = (remotesOut ?? "").split(/\r?\n/).filter(Boolean).slice(0, 20);
  const patterns = remotes.flatMap((r) => [`refs/remotes/${r}/HEAD`, `refs/remotes/${r}/main`]);
  if (branchRef) patterns.push(branchRef);
  const refs =
    remotesOut === null
      ? null
      : await call([
          "for-each-ref",
          "--format=%(refname)%09%(symref)%09%(upstream)%09%(upstream:remotename)",
          ...patterns,
        ]);
  const rows = new Map(
    (refs ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, symref = "", upstream = "", remote = ""] = line.split("\t");
        return [name, { symref, upstream, remote }] as const;
      }),
  );
  const branchRow = branchRef ? rows.get(branchRef) : undefined;
  const upstreamRemote =
    branchRow?.remote && remotes.includes(branchRow.remote) ? branchRow.remote : null;
  result.remote = upstreamRemote ?? (remotes.length === 1 ? remotes[0] : null);
  const short = (full: string) => full.replace(/^refs\/(remotes|heads)\//, "");

  let defaultRef: { full: string; source: Comparison["source"] } | null = null;
  if (result.remote) {
    const symref = rows.get(`refs/remotes/${result.remote}/HEAD`)?.symref;
    if (symref?.startsWith(`refs/remotes/${result.remote}/`))
      defaultRef = { full: symref, source: "remote-default" };
    else if (rows.has(`refs/remotes/${result.remote}/main`))
      defaultRef = { full: `refs/remotes/${result.remote}/main`, source: "fallback" };
  }
  const upstreamFull =
    branchRow?.upstream && branchRow.upstream !== defaultRef?.full ? branchRow.upstream : null;

  // Capture HEAD and every compared ref by object ID; counts use those IDs, never names.
  const targets = [defaultRef?.full, upstreamFull].filter((r): r is string => !!r);
  // One call in the usual case; only if it fails is HEAD read alone, to tell unborn from unreadable.
  const capture = async (): Promise<{ head: string; ids: string[] | null } | null> => {
    if (targets.length) {
      const all = await call(["rev-parse", ...["HEAD", ...targets].map((t) => `${t}^{commit}`)]);
      if (all !== null) {
        const [head, ...ids] = all.split(/\r?\n/);
        return { head, ids };
      }
    }
    const head = await raw(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (head.ok) return { head: head.stdout, ids: targets.length ? null : [] };
    unborn = head.reason === "failed" && head.code === 1;
    return null;
  };
  // Proven unborn only by `rev-parse --verify -q` exiting 1 on an attached branch.
  let unborn = false;
  const first = await capture();
  result.commit = first?.head ?? null;

  const compare = async (
    full: string,
    index: number,
    source: Comparison["source"],
  ): Promise<Comparison> => {
    const ref = short(full);
    if (result.commit === null) return unknown(ref, source, "no commit checked out", full);
    if (shallow !== "false") return unknown(ref, source, "shallow or unknown history depth", full);
    const id = first?.ids?.[index];
    if (!id || !/^[0-9a-f]{40,64}$/.test(id))
      return unknown(ref, source, failure("ref unreadable"), full);
    const counts = await call(["rev-list", "--left-right", "--count", `${id}...${result.commit}`]);
    const m = /^(\d+)\s+(\d+)$/.exec(counts ?? "");
    if (!m) return unknown(ref, source, failure("comparison failed"), full);
    const behind = +m[1];
    const ahead = +m[2];
    const state =
      behind && ahead ? "diverged" : behind ? "behind" : ahead ? "ahead" : ("equal" as const);
    return { ref, fullRef: full, source, state, behind, ahead };
  };

  if (defaultRef) result.comparison = await compare(defaultRef.full, 0, defaultRef.source);
  else
    result.comparison = unknown(
      result.remote ? `${result.remote}/main` : "main",
      "fallback",
      refs === null
        ? failure("refs unreadable")
        : !remotes.length
          ? "no remote configured"
          : !result.remote
            ? "several remotes and no upstream remote to choose from"
            : "no remote-tracking ref",
    );
  if (upstreamFull) result.upstream = await compare(upstreamFull, defaultRef ? 1 : 0, "upstream");

  // HEAD or any compared ref moving during collection makes every count unreliable.
  const measured = [result.comparison, result.upstream].some((c) => c && c.state !== "unknown");
  if (result.commit && measured) {
    const again = await call([
      "rev-parse",
      "HEAD^{commit}",
      ...targets.map((t) => `${t}^{commit}`),
    ]);
    const before = [first?.head, ...(first?.ids ?? [])].join("\n");
    if (again !== before) {
      const why =
        again === null ? failure("ref unreadable") : "refs changed during inspection; retry";
      for (const key of ["comparison", "upstream"] as const) {
        const c = result[key];
        if (c) result[key] = unknown(c.ref, c.source, why, c.fullRef);
      }
    }
  }
  if (result.commit === null)
    result.reason = timedOut
      ? "Git timed out"
      : result.branch && unborn
        ? "no commit checked out (unborn HEAD)"
        : "HEAD unreadable";
  return result;
}

/** Detailed lines for `pdb version`. */
export function describeCheckout(s: CheckoutStatus): string[] {
  if (s.status !== "checkout") return [`Source checkout: ${s.status} — ${s.reason}`];
  const head =
    s.detached === true ? "detached HEAD" : s.branch ? `branch ${s.branch}` : "HEAD state unknown";
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
