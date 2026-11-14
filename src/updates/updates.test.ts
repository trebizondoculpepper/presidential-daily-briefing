import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { installedVersion } from "./updates.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { atomicJson, main } from "../cli.js";
import { issue, repo, snapshot } from "../testing/snapshots.js";

const root = join(import.meta.dirname, "..", "..");

describe("installedVersion manifest resolution (#335)", () => {
  it("finds the package manifest from a nested source module", async () => {
    const info = await installedVersion();
    expect(info.version).toEqual(expect.any(String));
    expect(info.reason).toBeUndefined();
  });

  it("still finds it from the bundle location one level below the root", async () => {
    const info = await installedVersion(pathToFileURL(join(root, "dist", "cli.mjs")).href);
    expect(info.version).toEqual(expect.any(String));
  });

  it("reports a missing manifest outside the package", async () => {
    const info = await installedVersion(pathToFileURL("/nonexistent/a/b/c/cli.mjs").href);
    expect(info.version).toBeNull();
    expect(info.reason).toBeDefined();
  });
});

describe("version check (#51, doc/design/updates.md)", () => {
  const installed = (version: string | null, isInstalled = true) => ({
    version,
    installed: isInstalled,
  });
  const registry = (tags: Record<string, string> | Error, seen: string[] = []) =>
    (async (url: string) => {
      seen.push(String(url));
      if (tags instanceof Error) throw tags;
      return { ok: true, status: 200, json: async () => tags } as Response;
    }) as unknown as typeof fetch;
  it("advises only when npm's matching channel is newer, never a downgrade", async () => {
    const { checkForUpdate, updateAdvisory } = await import("./updates.js");
    const tags = { latest: "0.2.0", next: "0.2.3-next.1" };
    const stable = await checkForUpdate({
      installed: installed("0.1.0"),
      fetchImpl: registry(tags),
    });
    expect(stable).toMatchObject({ status: "newer", available: "0.2.0", channel: "latest" });
    expect(updateAdvisory(stable)).toBe(
      "pdb 0.2.0 is available (installed 0.1.0). Update with: npm install -g @trebizondoculpepper/presidential-daily-briefing",
    );
    const pre = await checkForUpdate({
      installed: installed("0.2.1-next.1"),
      fetchImpl: registry(tags),
    });
    expect(pre).toMatchObject({
      status: "newer" as const,
      channel: "next",
      command: expect.stringMatching(/@next$/),
    });
    for (const v of ["0.2.0", "0.3.0"])
      expect(
        updateAdvisory(
          await checkForUpdate({ installed: installed(v), fetchImpl: registry(tags) }),
        ),
      ).toBeNull();
  });
  it("skips without any network call for checkouts, unknown versions, offline and opt-out", async () => {
    const { checkForUpdate } = await import("./updates.js");
    const seen: string[] = [];
    const cases = [
      { installed: installed("0.1.0", false) },
      { installed: installed(null) },
      { installed: installed("1.0.0-beta.1") },
      { installed: installed("0.1.0"), offline: true },
      { installed: installed("0.1.0"), optOut: true },
    ];
    for (const c of cases)
      expect(
        (await checkForUpdate({ ...c, fetchImpl: registry({ latest: "9.0.0" }, seen) })).status,
      ).toBe("skipped");
    expect(seen).toEqual([]);
  });
  it("treats registry failure as unknown, never as up to date, and sends only the package name", async () => {
    const { checkForUpdate } = await import("./updates.js");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(
      await checkForUpdate({ installed: installed("0.1.0"), fetchImpl: registry(timeout) }),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/did not answer/),
    });
    expect(
      (await checkForUpdate({ installed: installed("0.1.0"), fetchImpl: registry({}) })).status,
    ).toBe("unknown");
    const seen: string[] = [];
    await checkForUpdate({
      installed: installed("0.1.0"),
      fetchImpl: registry({ latest: "0.1.0" }, seen),
    });
    expect(seen).toEqual([
      "https://registry.npmjs.org/-/package/@trebizondoculpepper%2fpresidential-daily-briefing/dist-tags",
    ]);
  });
  it("prints the advisory on stderr after the command, keeping JSON stdout valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-version-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot([issue()], []));
      let out = "";
      const err: string[] = [];
      const runtime = {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        stderr: (t: string) => void err.push(t),
        updateCheck: async () => ({
          status: "newer" as const,
          installed: "0.1.0",
          available: "0.2.0",
          channel: "latest",
          command: "npm install -g @trebizondoculpepper/presidential-daily-briefing",
        }),
      };
      expect(
        await main(["--offline", "--cache", cache, "--json"], async (t) => void (out = t), runtime),
      ).toBe(0);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(err.join("")).toMatch(/^pdb 0\.2\.0 is available/);
      // Help does not wait on the network.
      let checked = 0;
      await main(["--help"], async () => {}, {
        ...runtime,
        updateCheck: (async () => (checked++, { status: "current" })) as never,
      });
      expect(checked).toBe(0);
      // --no-update-check is consumed before the command parses its own options.
      expect(
        await main(
          ["--no-update-check", "--offline", "--cache", cache, "--json"],
          async () => {},
          runtime,
        ),
      ).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("daily cached version check (#65, doc/design/updates.md)", () => {
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.parse("2026-11-13T12:00:00Z");
  const installed = (version: string) => ({ version, installed: true });
  const counting = (tags: Record<string, string> | Error, delayMs = 0) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (tags instanceof Error) throw tags;
      return { ok: true, status: 200, json: async () => tags } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const withDir = async (body: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "triage-update-cache-"));
    try {
      await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("checks on first use, reuses the result for 24 hours, then refreshes", async () => {
    const { cachedCheckForUpdate, cacheFileName } = await import("./updatecache.js");
    const { updateAdvisory } = await import("./updates.js");
    await withDir(async (cacheDir) => {
      let now = t0;
      const reg = counting({ latest: "0.2.0", next: "0.3.0-next.1" });
      const check = () =>
        cachedCheckForUpdate({
          cacheDir,
          installed: installed("0.1.0"),
          fetchImpl: reg.fetchImpl,
          now: () => now,
        });
      const first = await check();
      expect(first).toMatchObject({ status: "newer", available: "0.2.0", channel: "latest" });
      expect(updateAdvisory(first)).toMatch(/0\.2\.0 is available/);
      now += day - 1;
      const repeat = await check();
      expect(repeat).toMatchObject({ status: "newer", notify: false });
      expect(updateAdvisory(repeat)).toBeNull();
      expect(reg.calls).toHaveLength(1);
      now += 2;
      expect(updateAdvisory(await check())).not.toBeNull();
      expect(reg.calls).toHaveLength(2);
      // Human-readable, versioned, channel-keyed and free of anything but versions and times.
      const file = JSON.parse(await readFile(join(cacheDir, cacheFileName), "utf8"));
      expect(file).toEqual({
        schemaVersion: 1,
        channels: {
          latest: {
            lastAttempt: new Date(now).toISOString(),
            lastSuccess: new Date(now).toISOString(),
            available: "0.2.0",
            lastWarningVersion: "0.2.0",
            lastWarningAt: new Date(now).toISOString(),
          },
        },
      });
      // The prerelease channel has its own entry and its own lookup.
      expect(
        await cachedCheckForUpdate({
          cacheDir,
          installed: installed("0.2.1-next.1"),
          fetchImpl: reg.fetchImpl,
          now: () => now,
        }),
      ).toMatchObject({ status: "newer", channel: "next", available: "0.3.0-next.1" });
      expect(reg.calls).toHaveLength(3);
    });
  });

  it("stays silent when up to date and honours an upgrade against cached evidence", async () => {
    const { cachedCheckForUpdate } = await import("./updatecache.js");
    const { updateAdvisory } = await import("./updates.js");
    await withDir(async (cacheDir) => {
      const reg = counting({ latest: "0.2.0" });
      const opts = { cacheDir, fetchImpl: reg.fetchImpl, now: () => t0 };
      expect((await cachedCheckForUpdate({ ...opts, installed: installed("0.1.0") })).status).toBe(
        "newer",
      );
      // After upgrading, the same cached evidence says current: no obsolete notice, no lookup.
      const after = await cachedCheckForUpdate({ ...opts, installed: installed("0.2.0") });
      expect(after.status).toBe("current");
      expect(updateAdvisory(after)).toBeNull();
      // Never a downgrade.
      expect((await cachedCheckForUpdate({ ...opts, installed: installed("0.5.0") })).status).toBe(
        "current",
      );
      expect(reg.calls).toHaveLength(1);
    });
  });

  it("throttles failed lookups without caching them as up to date", async () => {
    const { cachedCheckForUpdate, readCache, cacheFileName } = await import("./updatecache.js");
    const nodeFs = await import("node:fs/promises");
    await withDir(async (cacheDir) => {
      let now = t0;
      const down = counting(new Error("offline"));
      const opts = { cacheDir, installed: installed("0.1.0"), now: () => now };
      expect(await cachedCheckForUpdate({ ...opts, fetchImpl: down.fetchImpl })).toMatchObject({
        status: "unknown",
      });
      const again = await cachedCheckForUpdate({ ...opts, fetchImpl: down.fetchImpl });
      expect(again).toMatchObject({ status: "unknown", reason: expect.stringMatching(/failed/) });
      expect(down.calls).toHaveLength(1);
      const state = (await readCache(nodeFs, join(cacheDir, cacheFileName))).channels.latest;
      expect(state.lastAttempt).toBeDefined();
      expect(state.lastSuccess).toBeUndefined();
      expect(state.available).toBeUndefined();
      // An absent channel is a failure too; after 24 hours the lookup is retried.
      now += day;
      const up = counting({ next: "1.0.0-next.1" });
      expect((await cachedCheckForUpdate({ ...opts, fetchImpl: up.fetchImpl })).status).toBe(
        "unknown",
      );
      expect(up.calls).toHaveLength(1);
    });
  });

  it("treats a corrupt or foreign cache as absent, never as up to date", async () => {
    const { cachedCheckForUpdate, cacheFileName } = await import("./updatecache.js");
    await withDir(async (cacheDir) => {
      for (const content of [
        "{not json",
        JSON.stringify({ schemaVersion: 99, channels: { latest: { available: "0.1.0" } } }),
        JSON.stringify({ schemaVersion: 1, channels: "x" }),
      ]) {
        await writeFile(join(cacheDir, cacheFileName), content);
        const reg = counting({ latest: "0.2.0" });
        expect(
          await cachedCheckForUpdate({
            cacheDir,
            installed: installed("0.1.0"),
            fetchImpl: reg.fetchImpl,
            now: () => t0,
          }),
        ).toMatchObject({ status: "newer" });
        expect(reg.calls).toHaveLength(1);
      }
    });
  });

  it("skips quietly, without hammering npm, when the cache cannot be written", async () => {
    const { cachedCheckForUpdate } = await import("./updatecache.js");
    const nodeFs = await import("node:fs/promises");
    await withDir(async (cacheDir) => {
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      const readOnly = { ...nodeFs, writeFile: async () => Promise.reject(denied) };
      const reg = counting({ latest: "0.2.0" });
      for (let i = 0; i < 3; i++)
        expect(
          await cachedCheckForUpdate({
            cacheDir,
            fs: readOnly as never,
            installed: installed("0.1.0"),
            fetchImpl: reg.fetchImpl,
            now: () => t0,
          }),
        ).toMatchObject({ status: "unknown", reason: expect.stringMatching(/not writable/) });
      expect(reg.calls).toEqual([]);
      const noDir = { ...nodeFs, mkdir: async () => Promise.reject(denied) };
      expect(
        (
          await cachedCheckForUpdate({
            cacheDir,
            fs: noDir as never,
            installed: installed("0.1.0"),
            fetchImpl: reg.fetchImpl,
          })
        ).status,
      ).toBe("unknown");
      // Renaming fails after the lock is held: the attempt cannot be remembered, so the daily
      // throttle cannot hold and npm is never contacted, however often the CLI runs.
      const noRename = { ...nodeFs, rename: async () => Promise.reject(denied) };
      const before = reg.calls.length;
      for (let i = 0; i < 3; i++) {
        const result = await cachedCheckForUpdate({
          cacheDir,
          fs: noRename as never,
          installed: installed("0.1.0"),
          fetchImpl: reg.fetchImpl,
          now: () => t0,
        });
        expect(result).toMatchObject({
          status: "unknown",
          reason: expect.stringMatching(/not writable/),
        });
      }
      expect(reg.calls.length).toBe(before);
      expect(await readdir(cacheDir)).toEqual([]);
    });
  });

  it("lets concurrent invocations share one lookup and one notice", async () => {
    const { cachedCheckForUpdate } = await import("./updatecache.js");
    const { updateAdvisory } = await import("./updates.js");
    await withDir(async (cacheDir) => {
      const reg = counting({ latest: "0.2.0" }, 50);
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          cachedCheckForUpdate({
            cacheDir,
            installed: installed("0.1.0"),
            fetchImpl: reg.fetchImpl,
            now: () => t0,
          }),
        ),
      );
      expect(reg.calls).toHaveLength(1);
      expect(results.map(updateAdvisory).filter(Boolean)).toHaveLength(1);
      expect((await readdir(cacheDir)).sort()).toEqual(["update-check.json"]);
    });
  });

  it("breaks a stale lock but does not wait long behind a live one", async () => {
    const { cachedCheckForUpdate, cacheFileName, lockWaitMs } = await import("./updatecache.js");
    const { utimes } = await import("node:fs/promises");
    await withDir(async (cacheDir) => {
      const lock = join(cacheDir, `${cacheFileName}.lock`);
      await writeFile(lock, "{}");
      const reg = counting({ latest: "0.2.0" });
      const opts = { cacheDir, installed: installed("0.1.0"), fetchImpl: reg.fetchImpl };
      const started = Date.now();
      expect(await cachedCheckForUpdate(opts)).toMatchObject({
        status: "unknown",
        reason: expect.stringMatching(/busy/),
      });
      expect(Date.now() - started).toBeLessThan(lockWaitMs + 500);
      expect(reg.calls).toEqual([]);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      expect((await cachedCheckForUpdate(opts)).status).toBe("newer");
      expect(await readdir(cacheDir)).toEqual([cacheFileName]);
    });
  });

  it("gives up quickly on a directory at the lock path, and the CLI command still completes", async () => {
    const { cachedCheckForUpdate, cacheFileName, lockWaitMs } = await import("./updatecache.js");
    const { utimes } = await import("node:fs/promises");
    await withDir(async (cacheDir) => {
      const lock = join(cacheDir, `${cacheFileName}.lock`);
      await mkdir(lock);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old); // stale, and unlink fails with EISDIR/EPERM
      const reg = counting({ latest: "0.2.0" });
      const opts = { cacheDir, installed: installed("0.1.0"), fetchImpl: reg.fetchImpl };
      const bounded = <T>(p: Promise<T>) =>
        Promise.race([
          p,
          new Promise<"hung">((r) => setTimeout(() => r("hung"), lockWaitMs + 1000)),
        ]);
      const started = Date.now();
      expect(await bounded(cachedCheckForUpdate(opts))).toMatchObject({ status: "unknown" });
      expect(Date.now() - started).toBeLessThan(lockWaitMs + 500);
      const cache = join(cacheDir, "snapshot.json");
      await atomicJson(cache, snapshot([issue()], []));
      const runtime = {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        stderr: () => {},
        updateCheck: ((o: object) =>
          cachedCheckForUpdate({ ...o, ...opts, offline: false })) as never,
      };
      expect(
        await bounded(main(["--offline", "--cache", cache, "--json"], async () => {}, runtime)),
      ).toBe(0);
      expect(reg.calls).toEqual([]);
    });
  });

  it("lets at most one of two contenders breaking the same stale lock proceed", async () => {
    const { acquireLock, lockStaleMs } = await import("./updatecache.js");
    let clock = 100_000;
    const files = new Map<string, { data: string; mtimeMs: number }>();
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const mem = {
      readFile: async (p: string) => {
        const f = files.get(p);
        if (!f) throw enoent();
        return f.data;
      },
      writeFile: async (p: string, data: string, o: { flag?: string }) => {
        if (o.flag === "wx" && files.has(p))
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        files.set(p, { data, mtimeMs: clock });
      },
      rename: async () => {},
      unlink: async (p: string) => {
        if (!files.delete(p)) throw enoent();
      },
      mkdir: async () => {},
      stat: async (p: string) => {
        const f = files.get(p);
        if (!f) throw enoent();
        return { mtimeMs: f.mtimeMs };
      },
    };
    const lock = "/cache/update-check.json.lock";
    files.set(lock, { data: '{"token":"crashed"}', mtimeMs: clock - lockStaleMs - 1 });
    const now = () => clock;
    const sleep = async (ms: number) => void (clock += ms);
    // B judges the crashed lock stale; meanwhile A breaks it and takes the lock. B's stat still
    // reports the stale lock it saw, the interleaving that let the old code delete A's lock.
    let a: (() => Promise<void>) | null = null;
    let fired = false;
    const raced = {
      ...mem,
      stat: async (p: string) => {
        const seen = await mem.stat(p);
        if (!fired) {
          fired = true;
          a = await acquireLock(mem, lock, now, sleep);
        }
        return seen;
      },
    };
    const b = await acquireLock(raced, lock, now, sleep);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const held = files.get(lock)!.data;
    // Release removes only a lock holding our own token.
    files.set(lock, { data: '{"token":"someone-else"}', mtimeMs: clock });
    await a!();
    expect(files.get(lock)?.data).toBe('{"token":"someone-else"}');
    files.set(lock, { data: held, mtimeMs: clock });
    await a!();
    expect(files.has(lock)).toBe(false);
  });

  it("makes no cache or network access when skipped, and uses a per-user cache directory", async () => {
    const { cachedCheckForUpdate, defaultCacheDir } = await import("./updatecache.js");
    await withDir(async (cacheDir) => {
      const reg = counting({ latest: "9.0.0" });
      for (const c of [
        { offline: true },
        { optOut: true },
        { installed: { version: "0.1.0", installed: false } },
      ])
        expect(
          (
            await cachedCheckForUpdate({
              cacheDir,
              installed: installed("0.1.0"),
              fetchImpl: reg.fetchImpl,
              ...c,
            })
          ).status,
        ).toBe("skipped");
      expect(reg.calls).toEqual([]);
      expect(await readdir(cacheDir)).toEqual([]);
    });
    expect(defaultCacheDir()).toMatch(/presidential-daily-briefing/);
    expect(defaultCacheDir().startsWith(process.cwd())).toBe(false);
  });
});
