/**
 * Source-checkout freshness (#309). Contract: doc/design/source-install-diagnostics.md, "#309".
 *
 * When PDB runs from a source checkout (including through `npm link`), report the checkout's
 * branch and commit and how far it is behind or ahead of the repository default's local
 * remote-tracking ref, using local Git only. Never fetches, never touches the network, never
 * edits the repository. Every Git call has its own timeout, the whole probe has a deadline and
 * a call budget, and anything Git cannot establish is reported as unknown, never as current.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Contract limits: eight Git calls, one second each, three seconds overall. */
export const gitCallLimit = 8;
export const gitCallTimeoutMs = 1000;
export const probeDeadlineMs = 3000;
/** A remote-tracking ref whose last local fetch is older than this is reported as stale. */
export const staleAfterMs = 24 * 60 * 60 * 1000;
export const fetchCommand = "git fetch";
/** Disables only the source-checkout probe (the npm opt-outs disable both). */
export const checkoutOptOutEnv = "PDB_NO_CHECKOUT_CHECK";

// The hardened probe transport lives behind the probe Git facade (#940); re-exported for
// existing importers and tests.
export { gitInvocation, gitWith, runGit } from "../git/probe.js";
export type { GitResult, GitRunner } from "../git/probe.js";
import { createProbeGitService } from "../git/probe.js";
import type { GitRunner } from "../git/probe.js";

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
  /** Whether two paths name the same directory (real paths, case-insensitive on Windows). */
  samePath?: (a: string, b: string) => Promise<boolean>;
}

export async function sameDirectory(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return resolve(p);
    }
  };
  const [x, y] = await Promise.all([real(a), real(b)]);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
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
  git,
  now = Date.now,
  callTimeoutMs = gitCallTimeoutMs,
  deadlineMs = probeDeadlineMs,
  mtime = defaultMtime,
  samePath = sameDirectory,
}: CheckoutOptions): Promise<CheckoutStatus> {
  if (installed) return blank(now, "skipped", "npm installation: registry check applies");
  if (optOut) return blank(now, "skipped", "disabled (opt-out or --no-update-check)");
  if (!root) return blank(now, "unknown", "installation root unknown");

  // The bounded offline probe facade (#940): every Git read is typed, hardened and budgeted.
  const repo = createProbeGitService({
    root,
    ...(git ? { runner: git } : {}),
    callTimeoutMs,
    callBudget: gitCallLimit,
    deadlineMs,
    now,
  });

  /**
   * Every non-Git await (filesystem reads) goes through this: it settles with `fallback` when
   * the remaining overall budget runs out first, or when the operation throws.
   */
  async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        repo.expire();
        resolve(fallback);
      }, repo.remainingMs());
    });
    return Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => fallback),
      expired,
    ]).finally(() => clearTimeout(timer));
  }

  const layout = await repo.layout();
  if (layout === null)
    return blank(
      now,
      "unknown",
      repo.state.missing
        ? "Git is not available"
        : repo.state.timedOut
          ? "Git timed out"
          : "not a Git checkout",
    );
  const { toplevel, gitDir, commonDir, shallow } = layout;
  // The repository found must be this installation itself, not one that merely contains a
  // copy of it (for example pdb vendored or unpacked inside some other project).
  const same = await bounded<boolean | null>(() => samePath(toplevel, root), null);
  if (same === null)
    return blank(now, "unknown", "timed out checking the installation root against Git");
  if (!same)
    return blank(now, "unknown", "installation root is not the top level of a Git checkout");
  const result: CheckoutStatus = { ...blank(now, "checkout", ""), reason: undefined };

  // Attached or detached: exit 1 from `symbolic-ref -q` is the only proof of a detached HEAD.
  const head = await repo.headRef();
  const branchRef = head.ref;
  result.branch = branchRef ? branchRef.slice("refs/heads/".length) : null;
  result.detached = head.detached;

  // FETCH_HEAD lives in the common directory; a worktree's own git dir is checked too.
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p));
  // A stalled filesystem must not outlast the overall deadline either.
  const times = await bounded(
    () =>
      Promise.all(
        [...new Set([commonDir, gitDir].filter(Boolean))].map((d) =>
          mtime(join(abs(d), "FETCH_HEAD")).catch(() => null),
        ),
      ),
    [] as (number | null)[],
  );
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
  const failure = (fallback: string) => (repo.state.timedOut ? "Git timed out" : fallback);

  // Which remote: the branch upstream's remote, else the only configured remote.
  const names = await repo.remoteNames();
  const remotes = (names ?? []).slice(0, 20);
  const patterns = remotes.flatMap((r) => [`refs/remotes/${r}/HEAD`, `refs/remotes/${r}/main`]);
  if (branchRef) patterns.push(branchRef);
  const rows = names === null ? null : await repo.refRows(patterns);
  const branchRow = branchRef ? rows?.get(branchRef) : undefined;
  const upstreamRemote =
    branchRow?.remote && remotes.includes(branchRow.remote) ? branchRow.remote : null;
  result.remote = upstreamRemote ?? (remotes.length === 1 ? remotes[0]! : null);
  const short = (full: string) => full.replace(/^refs\/(remotes|heads)\//, "");

  let defaultRef: { full: string; source: Comparison["source"] } | null = null;
  if (result.remote) {
    const symref = rows?.get(`refs/remotes/${result.remote}/HEAD`)?.symref;
    if (symref?.startsWith(`refs/remotes/${result.remote}/`))
      defaultRef = { full: symref, source: "remote-default" };
    else if (rows?.has(`refs/remotes/${result.remote}/main`))
      defaultRef = { full: `refs/remotes/${result.remote}/main`, source: "fallback" };
  }
  const upstreamFull =
    branchRow?.upstream && branchRow.upstream !== defaultRef?.full ? branchRow.upstream : null;

  // Capture HEAD and every compared ref by object ID; counts use those IDs, never names.
  const targets = [defaultRef?.full, upstreamFull].filter((r): r is string => !!r);
  // One call in the usual case; only if it fails is HEAD read alone, to tell unborn from
  // unreadable. A missing target leaves the other comparison intact. Exact names only.
  let unborn = false;
  const capture = async (): Promise<{ head: string; ids: Map<string, string> } | null> => {
    const ids = await repo.refSnapshot(targets);
    const headId = ids?.get("HEAD");
    if (ids && headId) return { head: headId, ids };
    if (ids === null && repo.state.timedOut) return null;
    const proof = await repo.headCommit();
    if (proof && "commit" in proof) return { head: proof.commit, ids: new Map() };
    // Proven unborn only by `rev-parse --verify -q` exiting 1 on an attached branch.
    unborn = proof !== null && "unborn" in proof;
    return null;
  };
  const first = await capture();
  result.commit = first?.head ?? null;

  const compare = async (full: string, source: Comparison["source"]): Promise<Comparison> => {
    const ref = short(full);
    if (result.commit === null) return unknown(ref, source, "no commit checked out", full);
    if (shallow !== false) return unknown(ref, source, "shallow or unknown history depth", full);
    const id = first?.ids.get(full);
    if (!id || !/^[0-9a-f]{40,64}$/.test(id))
      return unknown(ref, source, failure("ref missing or unreadable"), full);
    const counts = await repo.divergence(id, result.commit);
    if (!counts) return unknown(ref, source, failure("comparison failed"), full);
    const { behind, ahead } = counts;
    const state =
      behind && ahead ? "diverged" : behind ? "behind" : ahead ? "ahead" : ("equal" as const);
    return { ref, fullRef: full, source, state, behind, ahead };
  };

  if (defaultRef) result.comparison = await compare(defaultRef.full, defaultRef.source);
  else
    result.comparison = unknown(
      result.remote ? `${result.remote}/main` : "main",
      "fallback",
      rows === null
        ? failure("refs unreadable")
        : !remotes.length
          ? "no remote configured"
          : !result.remote
            ? "several remotes and no upstream remote to choose from"
            : "no remote-tracking ref",
    );
  if (upstreamFull) result.upstream = await compare(upstreamFull, "upstream");

  // HEAD or any compared ref moving during collection makes every count unreliable.
  const measured = [result.comparison, result.upstream].some((c) => c && c.state !== "unknown");
  if (result.commit && measured) {
    const now2 = await repo.refSnapshot(targets);
    const key = (m: Map<string, string> | null | undefined) =>
      m ? ["HEAD", ...targets].map((t) => m.get(t) ?? "").join("\n") : null;
    const again = key(now2);
    const before = key(first?.ids && new Map([...first.ids, ["HEAD", first.head]]));
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
    result.reason = repo.state.timedOut
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
