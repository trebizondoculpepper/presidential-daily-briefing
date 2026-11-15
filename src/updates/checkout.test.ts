import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  checkoutAdvisory,
  checkoutFreshness,
  describeCheckout,
  gitInvocation,
  gitWith,
  type GitResult,
  type GitRunner,
} from "./checkout.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString()
    .trim();

let n = 0;
async function commit(cwd: string) {
  await writeFile(join(cwd, "f.txt"), String(n++));
  git(cwd, "add", "f.txt");
  git(cwd, "commit", "-q", "-m", `c${n}`);
}

/** An origin with two commits on main and a clone of it; `origin/HEAD` points at main. */
async function cloned() {
  const base = await mkdtemp(join(tmpdir(), "pdb-checkout-"));
  dirs.push(base);
  const origin = join(base, "origin");
  const work = join(base, "work");
  git(base, "init", "-q", "-b", "main", origin);
  await commit(origin);
  await commit(origin);
  git(base, "clone", "-q", origin, work);
  return { origin, work };
}

const probe = (root: string, extra = {}) => checkoutFreshness({ root, installed: false, ...extra });

describe("source checkout freshness (#309)", () => {
  it("reports equal, then behind after a fetch, with branch, commit and fetch time", async () => {
    const { origin, work } = await cloned();
    let s = await probe(work);
    expect(s).toMatchObject({ status: "checkout", branch: "main", detached: false });
    expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(s.comparison).toMatchObject({
      ref: "origin/main",
      source: "remote-default",
      state: "equal",
      behind: 0,
      ahead: 0,
    });
    expect(checkoutAdvisory(s)).toBeNull();
    await commit(origin);
    await commit(origin);
    git(work, "fetch", "-q");
    s = await probe(work);
    expect(s.comparison).toMatchObject({ state: "behind", behind: 2, ahead: 0 });
    expect(s.lastFetch).not.toBeNull();
    expect(s.stale).toBe(false);
    expect(checkoutAdvisory(s)).toMatch(/2 commits behind origin\/main .*Details: pdb version/);
    expect(describeCheckout(s).join("\n")).toContain("git fetch");
  });

  it("reports ahead and diverged", async () => {
    const { origin, work } = await cloned();
    await commit(work);
    expect((await probe(work)).comparison).toMatchObject({ state: "ahead", behind: 0, ahead: 1 });
    await commit(origin);
    git(work, "fetch", "-q");
    const s = await probe(work);
    expect(s.comparison).toMatchObject({ state: "diverged", behind: 1, ahead: 1 });
    expect(checkoutAdvisory(s)).not.toBeNull();
  });

  it("marks a day-old fetch stale", async () => {
    const { work } = await cloned();
    git(work, "fetch", "-q");
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect((await probe(work, { now: () => later })).stale).toBe(true);
  });

  it("uses a present origin/main as a labelled fallback, and unknown with no remote ref", async () => {
    const { work } = await cloned();
    git(work, "remote", "set-head", "origin", "-d");
    expect((await probe(work)).comparison).toMatchObject({ source: "fallback", state: "equal" });
    git(work, "update-ref", "-d", "refs/remotes/origin/main");
    const s = await probe(work);
    expect(s.comparison).toMatchObject({ state: "unknown", behind: null, ahead: null });
    expect(checkoutAdvisory(s)).toBeNull();
    expect(describeCheckout(s).join("\n")).toMatch(/unknown/);
  });

  it("reports a detached HEAD", async () => {
    const { work } = await cloned();
    git(work, "checkout", "-q", "--detach", "HEAD~1");
    const s = await probe(work);
    expect(s).toMatchObject({ branch: null, detached: true });
    expect(s.comparison).toMatchObject({ state: "behind", behind: 1 });
    expect(describeCheckout(s)[0]).toContain("detached HEAD");
  });

  it("is unknown, never current, without Git or outside a repository", async () => {
    const { work } = await cloned();
    const missing: GitRunner = (args, cwd, t) => gitWith("pdb-no-such-git", args, cwd, t);
    expect(await probe(work, { git: missing })).toMatchObject({
      status: "unknown",
      reason: "Git is not available",
      comparison: null,
    });
    const plain = await mkdtemp(join(tmpdir(), "pdb-plain-"));
    dirs.push(plain);
    expect(await probe(plain)).toMatchObject({
      status: "unknown",
    });
    expect(await checkoutFreshness({ root: null, installed: false })).toMatchObject({
      status: "unknown",
    });
  });

  it("treats a package under node_modules as an npm installation, not a checkout", async () => {
    const { installedVersion } = await import("./updates.js");
    const { mkdir } = await import("node:fs/promises");
    const base = await mkdtemp(join(tmpdir(), "pdb-npm-"));
    dirs.push(base);
    const pkg = join(base, "node_modules", "@trebizondoculpepper", "presidential-daily-briefing");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@trebizondoculpepper/presidential-daily-briefing",
        version: "1.0.0",
      }),
    );
    const info = await installedVersion(pathToFileURL(join(pkg, "dist", "cli.mjs")).href);
    expect(info).toMatchObject({ installed: true, version: "1.0.0" });
    expect(
      await checkoutFreshness({ root: info.root ?? null, installed: info.installed }),
    ).toMatchObject({
      status: "skipped",
    });
  });

  it("reports an unborn HEAD as unknown", async () => {
    const base = await mkdtemp(join(tmpdir(), "pdb-unborn-"));
    dirs.push(base);
    git(base, "init", "-q", "-b", "main");
    const s = await probe(base);
    expect(s).toMatchObject({ status: "checkout", commit: null, branch: "main", detached: false });
    expect(s.reason).toMatch(/unborn/);
    expect(s.comparison?.state).toBe("unknown");
    expect(checkoutAdvisory(s)).toBeNull();
  });

  it("does not count commits in a shallow clone", async () => {
    const { origin } = await cloned();
    const base = await mkdtemp(join(tmpdir(), "pdb-shallow-"));
    dirs.push(base);
    const shallow = join(base, "s");
    git(base, "clone", "-q", "--depth", "1", pathToFileURL(origin).href, shallow);
    const s = await probe(shallow);
    expect(s.comparison).toMatchObject({
      state: "unknown",
      reason: expect.stringMatching(/shallow/),
      behind: null,
    });
  });

  it("works in a linked worktree whose .git is a file", async () => {
    const { work } = await cloned();
    const tree = join(work, "..", "tree");
    git(work, "worktree", "add", "-q", "-b", "side", tree, "HEAD~1");
    git(work, "fetch", "-q");
    const s = await probe(tree);
    expect(s).toMatchObject({ status: "checkout", branch: "side" });
    expect(s.comparison).toMatchObject({
      ref: "origin/main",
      state: "behind",
      behind: 1,
      ahead: 0,
    });
    expect(s.lastFetch).not.toBeNull();
  });

  it("bounds the FETCH_HEAD read by the overall deadline", async () => {
    const { work } = await cloned();
    const started = Date.now();
    const s = await probe(work, { mtime: () => new Promise(() => {}), deadlineMs: 1500 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(s).toMatchObject({ lastFetch: null, stale: null });
  });

  /** A scripted Git: the first matching prefix answers; `refIds` serve successive captures. */
  const scripted = (opts: {
    symref?: GitResult;
    captures?: string[];
    rows?: string;
    remotes?: string;
  }): GitRunner => {
    let capture = 0;
    return async (args) => {
      const a = args.join(" ");
      if (a.startsWith("rev-parse --show-toplevel"))
        return { ok: true, stdout: "/r\n.git\n.git\nfalse" };
      if (a.startsWith("symbolic-ref"))
        return opts.symref ?? { ok: true, stdout: "refs/heads/feat" };
      if (a === "remote") return { ok: true, stdout: opts.remotes ?? "origin" };
      if (a.startsWith("for-each-ref"))
        return {
          ok: true,
          stdout:
            opts.rows ??
            "refs/remotes/origin/HEAD\trefs/remotes/origin/main\t\t\nrefs/remotes/origin/main\t\t\t\nrefs/heads/feat\t\trefs/remotes/origin/feat\torigin",
        };
      if (a.startsWith("show-ref --head")) {
        const list = opts.captures ?? [];
        const ids = list[Math.min(capture++, list.length - 1)].split("\n");
        const names = ["HEAD", "refs/remotes/origin/main", "refs/remotes/origin/feat"];
        return {
          ok: true,
          stdout: ids
            .map((id, k) => (id ? `${id} ${names[k]}` : ""))
            .filter(Boolean)
            .join("\n"),
        };
      }
      if (a.startsWith("rev-list")) return { ok: true, stdout: "1\t0" };
      return { ok: false, reason: "failed", code: 128 };
    };
  };
  const [h1, h2, r1, r2, u1] = ["1", "2", "3", "4", "5"].map((c) => c.repeat(40));

  it("invalidates both comparisons when HEAD moves", async () => {
    const s = await probe("x", {
      git: scripted({ captures: [[h1, r1, u1].join("\n"), [h2, r1, u1].join("\n")] }),
      mtime: async () => null,
      samePath: async () => true,
    });
    expect(s.comparison).toMatchObject({
      state: "unknown",
      reason: expect.stringMatching(/changed/),
    });
    expect(s.upstream).toMatchObject({
      ref: "origin/feat",
      state: "unknown",
      reason: expect.stringMatching(/changed/),
    });
  });

  it("invalidates the counts when a compared ref moves, even with HEAD still", async () => {
    const steady = await probe("x", {
      git: scripted({ captures: [[h1, r1, u1].join("\n")] }),
      mtime: async () => null,
      samePath: async () => true,
    });
    expect(steady.comparison).toMatchObject({
      state: "behind",
      fullRef: "refs/remotes/origin/main",
    });
    const moved = await probe("x", {
      git: scripted({ captures: [[h1, r1, u1].join("\n"), [h1, r2, u1].join("\n")] }),
      mtime: async () => null,
      samePath: async () => true,
    });
    expect(moved.comparison).toMatchObject({
      state: "unknown",
      reason: expect.stringMatching(/changed/),
    });
    expect(moved.upstream?.state).toBe("unknown");
  });

  it("treats only a real 'not a symbolic ref' as detached; other failures are unknown", async () => {
    const run = (symref: GitResult) =>
      probe("x", {
        git: scripted({ symref, captures: [h1 + "\n" + r1] }),
        mtime: async () => null,
        samePath: async () => true,
      });
    expect(await run({ ok: false, reason: "failed", code: 1 })).toMatchObject({
      detached: true,
      branch: null,
    });
    for (const failed of [
      { ok: false, reason: "timeout" } as const,
      { ok: false, reason: "failed", code: 128 } as const,
    ]) {
      const s = await run(failed);
      expect(s).toMatchObject({ detached: null, branch: null });
      expect(describeCheckout(s)[0]).toContain("HEAD state unknown");
    }
  });

  it("still compares the upstream on the origin/main fallback path within the call budget", async () => {
    const { origin, work } = await cloned();
    git(work, "checkout", "-q", "-b", "feat");
    await commit(work);
    git(work, "push", "-q", "-u", "origin", "feat");
    await commit(origin);
    git(origin, "checkout", "-q", "feat");
    await commit(origin);
    git(work, "fetch", "-q");
    git(work, "remote", "set-head", "origin", "-d");
    let calls = 0;
    const counting: GitRunner = (a, c, t) => (calls++, gitWith("git", a, c, t));
    const s = await probe(work, { git: counting });
    expect(s.comparison).toMatchObject({
      ref: "origin/main",
      source: "fallback",
      state: "diverged",
      behind: 1,
      ahead: 1,
    });
    expect(s.upstream).toMatchObject({ ref: "origin/feat", state: "behind", behind: 1, ahead: 0 });
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("refuses every transport and lazy fetch, so a probe never reaches the network", async () => {
    const inv = gitInvocation(["status"], { PATH: "p" });
    expect(inv.args.slice(0, 2)).toEqual(["-c", "protocol.allow=never"]);
    expect(inv.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", PATH: "p" });
    // Even an explicit fetch through the probe's runner fails, here from a local file remote.
    const { work } = await cloned();
    expect(await gitWith("git", ["fetch", "origin"], work, 5000)).toMatchObject({ ok: false });
  });

  it("ignores inherited repository-selection variables", async () => {
    const inv = gitInvocation([], {
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "i",
      GIT_COMMON_DIR: "c",
      GIT_CONFIG_KEY_0: "k",
      HOME: "h",
    });
    for (const k of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_CONFIG_KEY_0",
    ])
      expect(inv.env[k]).toBeUndefined();
    expect(inv.env.HOME).toBe("h");
    const { work } = await cloned();
    const other = await cloned();
    git(other.work, "checkout", "-q", "-b", "elsewhere");
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other.work, ".git");
    process.env.GIT_WORK_TREE = other.work;
    try {
      expect(await probe(work)).toMatchObject({ status: "checkout", branch: "main" });
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
  });

  it("uses the configured remote, not an assumed origin", async () => {
    const { work } = await cloned();
    git(work, "remote", "rename", "origin", "upstream");
    let s = await probe(work);
    expect(s).toMatchObject({ remote: "upstream" });
    expect(s.comparison).toMatchObject({
      ref: "upstream/main",
      fullRef: "refs/remotes/upstream/main",
      state: "equal",
    });

    // Two remotes: the branch upstream's remote decides; detached, nothing does.
    const second = await cloned();
    git(work, "remote", "add", "fork", pathToFileURL(second.origin).href);
    git(work, "fetch", "-q", "fork");
    s = await probe(work);
    expect(s).toMatchObject({ remote: "upstream" });
    git(work, "checkout", "-q", "--detach");
    s = await probe(work);
    expect(s).toMatchObject({ remote: null, detached: true });
    expect(s.comparison).toMatchObject({
      state: "unknown",
      reason: expect.stringMatching(/several remotes/),
    });
  });

  it("compares full ref names, so a local branch named origin/main cannot shadow the remote ref", async () => {
    const { origin, work } = await cloned();
    await commit(origin);
    git(work, "fetch", "-q");
    git(work, "branch", "origin/main", "HEAD");
    const s = await probe(work);
    expect(s.comparison).toMatchObject({
      fullRef: "refs/remotes/origin/main",
      state: "behind",
      behind: 1,
    });
  });

  it("keeps every transport refused even when configuration allows one", async () => {
    const inv = gitInvocation([], {
      GIT_ALLOW_PROTOCOL: "file:https",
      GIT_PROTOCOL_FROM_USER: "1",
      GIT_SSH_COMMAND: "x",
    });
    expect(inv.env).toMatchObject({ GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0" });
    expect(inv.env.GIT_SSH_COMMAND).toBeUndefined();
    const { work } = await cloned();
    git(work, "config", "protocol.file.allow", "always");
    git(work, "config", "protocol.allow", "always");
    expect(await gitWith("git", ["fetch", "origin"], work, 5000)).toMatchObject({ ok: false });
  });

  it("does not report an unrelated repository that merely contains a copy of pdb", async () => {
    const { work } = await cloned();
    const copy = join(work, "vendor", "pdb");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(copy, { recursive: true });
    await writeFile(
      join(copy, "package.json"),
      JSON.stringify({
        name: "@trebizondoculpepper/presidential-daily-briefing",
        version: "0.1.0",
      }),
    );
    const s = await probe(copy);
    expect(s).toMatchObject({ status: "unknown", comparison: null, branch: null });
    expect(s.reason).toMatch(/not the top level/);
    expect(checkoutAdvisory(s)).toBeNull();
  });

  it("keeps the default comparison when the branch's upstream ref is missing", async () => {
    const { origin, work } = await cloned();
    git(work, "checkout", "-q", "-b", "feat");
    git(work, "push", "-q", "-u", "origin", "feat");
    await commit(origin);
    git(work, "fetch", "-q");
    git(work, "update-ref", "-d", "refs/remotes/origin/feat");
    const s = await probe(work);
    expect(s.comparison).toMatchObject({ ref: "origin/main", state: "behind", behind: 1 });
    expect(s.upstream).toMatchObject({
      ref: "origin/feat",
      state: "unknown",
      reason: expect.stringMatching(/missing/),
    });
  });

  it("bounds a stalled realpath by the overall deadline and reports unknown", async () => {
    const { work } = await cloned();
    const started = Date.now();
    const s = await probe(work, { samePath: () => new Promise(() => {}), deadlineMs: 1500 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(s).toMatchObject({ status: "unknown", comparison: null, branch: null });
    expect(s.reason).toMatch(/timed out/);
  });

  it("never probes an npm installation, and honours the opt-out", async () => {
    let calls = 0;
    const counting: GitRunner = async () => {
      calls++;
      return { ok: true, stdout: "" };
    };
    expect(await checkoutFreshness({ root: "x", installed: true, git: counting })).toMatchObject({
      status: "skipped",
    });
    expect(
      await checkoutFreshness({ root: "x", installed: false, optOut: true, git: counting }),
    ).toMatchObject({ status: "skipped" });
    expect(calls).toBe(0);
  });

  it("times out a hung Git call and stays within the call budget", async () => {
    const hung: GitRunner = () => new Promise(() => {});
    const started = Date.now();
    const s = await probe("x", {
      git: hung,
      callTimeoutMs: 50,
      deadlineMs: 200,
      samePath: async () => true,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s).toMatchObject({ status: "unknown", reason: "Git timed out" });

    let calls = 0;
    const slowAfterInfo: GitRunner = async (args) => {
      calls++;
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { ok: true, stdout: "/r\n.git\n.git\nfalse" };
      return new Promise(() => {});
    };
    const partial = await probe("x", {
      git: slowAfterInfo,
      callTimeoutMs: 40,
      deadlineMs: 150,
      samePath: async () => true,
    });
    expect(partial.status).toBe("checkout");
    expect(partial.comparison?.state ?? "unknown").toBe("unknown");
    expect(calls).toBeLessThanOrEqual(8);
  });
});

describe("main() and the checkout probe (#309)", () => {
  const behind = {
    status: "checkout" as const,
    branch: "main",
    detached: false,
    remote: "origin",
    commit: "a".repeat(40),
    comparison: {
      ref: "origin/main",
      source: "remote-default" as const,
      state: "behind" as const,
      behind: 4,
      ahead: 0,
    },
    upstream: null,
    lastFetch: null,
    stale: null,
    observedAt: "2026-11-15T00:00:00.000Z",
    fetchCommand: "git fetch",
  };
  const run = async (runtime: Record<string, unknown>, args: string[]) => {
    const { main } = await import("../cli.js");
    let err = "";
    // A failing command still reaches the advisory in main()'s finally block.
    await main(args, async () => {}, {
      collect: async () => {
        throw new Error("no");
      },
      currentRepository: async () => "o/r",
      updateCheck: async () => ({ status: "skipped", reason: "" }),
      stderr: (t: string) => {
        err += t;
      },
      ...runtime,
    } as never).catch(() => undefined);
    return err;
  };

  it("reports the source installation root in version --json, as in the text", async () => {
    const { main } = await import("../cli.js");
    let out = "";
    await main(["version", "--json", "--offline"], async (t) => void (out += t), {
      collect: async () => ({}),
      currentRepository: async () => "o/r",
      updateCheck: async () => ({ status: "skipped", reason: "" }),
      checkoutCheck: async () => behind,
      stderr: () => {},
    } as never);
    const doc = JSON.parse(out);
    expect(doc.installation).toEqual(expect.any(String));
    expect(doc.checkout.comparison.state).toBe("behind");
  });

  it("the suite disables the real probe", () => {
    expect(process.env.PDB_NO_CHECKOUT_CHECK).toBe("1");
  });

  it("prints the warning only when a test injects a behind probe", async () => {
    const args = ["config", "nonsense-subcommand"];
    expect(await run({}, args)).not.toMatch(/source checkout/);
    let seen: { optOut?: boolean } | undefined;
    const injected = await run(
      { checkoutCheck: async (o: { optOut?: boolean }) => ((seen = o), behind) },
      args,
    );
    expect(injected).toMatch(/source checkout 4 commits behind origin\/main/);
    expect(seen?.optOut).toBe(false);
  });
});
