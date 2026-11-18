/**
 * The bounded offline probe Git facade (#940, doc/design/github-service-composition.md "Bounded
 * offline probe capability"). A private hardened transport (network refused, lazy fetch off,
 * sanitized repository selection) with a per-call timeout, a call budget and an overall deadline,
 * and the typed one-call reads the source-checkout probe needs. An exhausted budget or deadline
 * and a missing Git are typed failures, never empty answers. Nothing here fetches or writes.
 */
import { execFile } from "node:child_process";

/** Result of one Git call: its trimmed stdout, or why it gave none. */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "missing" | "timeout" | "failed"; code?: number };

/** The probe transport: runs `git` with an argument array (no shell) in `cwd`. */
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

/** Why a probe read gave no answer: the budget or deadline ran out, Git is absent, or it failed. */
export type ProbeFailure = "timeout" | "missing" | "failed";

/** The checkout layout from one `rev-parse`. */
export interface ProbeLayout {
  toplevel: string;
  gitDir: string;
  commonDir: string;
  /** `true`/`false` from Git, else unknown. */
  shallow: boolean | null;
}

/** One `for-each-ref` row: a ref's symbolic target, upstream and upstream remote. */
export interface ProbeRefRow {
  symref: string;
  upstream: string;
  remote: string;
}

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

export interface ProbeGitService {
  layout(): Promise<ProbeLayout | null>;
  /** The attached branch ref, or detached (proven by exit 1 only), or unknown. */
  headRef(): Promise<{ ref: string | null; detached: boolean | null }>;
  remoteNames(): Promise<string[] | null>;
  refRows(patterns: readonly string[]): Promise<Map<string, ProbeRefRow> | null>;
  /** HEAD and each named ref that exists, to its object ID; missing refs are omitted. */
  refSnapshot(refs: readonly string[]): Promise<Map<string, string> | null>;
  /** The HEAD commit, or proven unborn (exit 1), or unknown. */
  headCommit(): Promise<{ commit: string } | { unborn: true } | null>;
  divergence(left: string, right: string): Promise<{ behind: number; ahead: number } | null>;
  /** Whether any read hit the budget/deadline, or found Git missing. */
  readonly state: { timedOut: boolean; missing: boolean };
  /** Mark the probe as out of time (a bounded non-Git wait expired). */
  expire(): void;
  /** Milliseconds left before the overall deadline. */
  remainingMs(): number;
}

export interface ProbeGitOptions {
  root: string;
  runner?: GitRunner;
  callTimeoutMs: number;
  callBudget: number;
  deadlineMs: number;
  now: () => number;
}

/** Build one probe service for one probe run: its budget and deadline start now. */
export function createProbeGitService(options: ProbeGitOptions): ProbeGitService {
  const runner = options.runner ?? runGit;
  const started = options.now();
  let calls = 0;
  const state = { timedOut: false, missing: false };
  const remainingMs = () => options.deadlineMs - (options.now() - started);

  async function raw(args: string[]): Promise<GitResult> {
    const left = remainingMs();
    if (calls >= options.callBudget || left <= 0) {
      state.timedOut = true;
      return { ok: false, reason: "timeout" };
    }
    calls++;
    const timeout = Math.min(options.callTimeoutMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runner(args, options.root, timeout),
      new Promise<GitResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeout + 50);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!result.ok && result.reason === "missing") state.missing = true;
    if (!result.ok && result.reason === "timeout") state.timedOut = true;
    return result;
  }
  const text = async (args: string[]): Promise<string | null> => {
    const result = await raw(args);
    return result.ok ? result.stdout : null;
  };

  return {
    state,
    expire: () => {
      state.timedOut = true;
    },
    remainingMs: () => Math.max(0, remainingMs()),
    async layout() {
      const info = await text([
        "rev-parse",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "--is-shallow-repository",
      ]);
      if (info === null) return null;
      const [toplevel = "", gitDir = "", commonDir = "", shallow = ""] = info.split(/\r?\n/);
      return {
        toplevel,
        gitDir,
        commonDir,
        shallow: shallow === "true" ? true : shallow === "false" ? false : null,
      };
    },
    async headRef() {
      const head = await raw(["symbolic-ref", "-q", "HEAD"]);
      const ref = head.ok && head.stdout.startsWith("refs/heads/") ? head.stdout : null;
      return {
        ref,
        detached: head.ok ? false : head.reason === "failed" && head.code === 1 ? true : null,
      };
    },
    async remoteNames() {
      const out = await text(["remote"]);
      return out === null ? null : out.split(/\r?\n/).filter(Boolean);
    },
    async refRows(patterns) {
      const out = await text([
        "for-each-ref",
        "--format=%(refname)%09%(symref)%09%(upstream)%09%(upstream:remotename)",
        ...patterns,
      ]);
      if (out === null) return null;
      return new Map(
        out
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [name = "", symref = "", upstream = "", remote = ""] = line.split("\t");
            return [name, { symref, upstream, remote }] as const;
          }),
      );
    },
    async refSnapshot(refs) {
      const out = await text(["show-ref", "--head", ...refs]);
      if (out === null) return null;
      const ids = new Map<string, string>();
      for (const line of out.split(/\r?\n/)) {
        const [id = "", name = ""] = line.split(" ");
        if (name === "HEAD" || refs.includes(name)) ids.set(name, id);
      }
      return ids;
    },
    async headCommit() {
      const proof = await raw(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      if (proof.ok) return OBJECT_ID.test(proof.stdout) ? { commit: proof.stdout } : null;
      return proof.reason === "failed" && proof.code === 1 ? { unborn: true } : null;
    },
    async divergence(left, right) {
      if (!OBJECT_ID.test(left) || !OBJECT_ID.test(right)) return null;
      const counts = await text(["rev-list", "--left-right", "--count", `${left}...${right}`]);
      const m = /^(\d+)\s+(\d+)$/.exec(counts ?? "");
      return m ? { behind: +m[1]!, ahead: +m[2]! } : null;
    },
  };
}
