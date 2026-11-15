import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  checkoutAdvisory,
  checkoutFreshness,
  describeCheckout,
  gitWith,
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
    const { pathToFileURL } = await import("node:url");
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
    const s = await probe("x", { git: hung, callTimeoutMs: 50, deadlineMs: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s).toMatchObject({ status: "unknown", reason: "Git timed out" });

    let calls = 0;
    const slowAfterInfo: GitRunner = async (args) => {
      calls++;
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { ok: true, stdout: "/r\n.git\n.git\nfalse" };
      return new Promise(() => {});
    };
    const partial = await probe("x", { git: slowAfterInfo, callTimeoutMs: 40, deadlineMs: 150 });
    expect(partial.status).toBe("checkout");
    expect(partial.comparison?.state ?? "unknown").toBe("unknown");
    expect(calls).toBeLessThanOrEqual(8);
  });
});
