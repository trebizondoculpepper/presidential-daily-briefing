/**
 * #382 (doc/design/safe-shared-file-writes.md): locked, durable JSON writes on the real
 * filesystem, with separate processes and injected failures at each step.
 */
import { describe, expect, it } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceCheckpoint,
  nodeSafeFs,
  overwriteJson,
  updateJsonFile,
  writeSnapshotCache,
  type SafeFs,
} from "./safejson.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "pdb-382-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const failing = (step: keyof Omit<SafeFs, "lock">, error = "EIO"): SafeFs => ({
  ...nodeSafeFs,
  [step]: async () => {
    throw Object.assign(new Error(error), { code: error });
  },
});

describe("locked durable JSON writes (#382)", () => {
  // Exercise more independent acquisition/release interleavings on Windows, where #729
  // exposed an immediate filesystem refusal. Every batch retains the exact 20-write assertion.
  it.each(process.platform === "win32" ? Array.from({ length: 100 }, (_, i) => i + 1) : [1])(
    "separate processes doing read-modify-write lose no update (batch %s)",
    async () => {
      await withDir(async (dir) => {
        const target = join(dir, "counter.json");
        // A file URL, not a path: a Windows path (C:\...) is not a valid module specifier.
        const module = new URL("./safejson.ts", import.meta.url).href;
        const script = join(dir, "worker.mts");
        await writeFile(
          script,
          `import { updateJsonFile, nodeSafeFs, type SafeFs } from ${JSON.stringify(module)};
let createRefusals = 0;
const fs: SafeFs = {
  ...nodeSafeFs,
  lock: {
    ...nodeSafeFs.lock,
    async writeFile(path, data, options) {
      try { await nodeSafeFs.lock.writeFile(path, data, options); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") createRefusals++;
        throw error;
      }
    },
  },
};
for (let i = 0; i < 5; i++) {
  const r = await updateJsonFile(${JSON.stringify(target)}, (c) => ({ write: { n: (c.state === "value" ? (c.value as { n: number }).n : 0) + 1 } }), { fs, lockWaitMs: 30000 });
  if (r.status !== "written") { console.error(JSON.stringify(r)); process.exit(1); }
}
if (createRefusals) console.log("Recovered JSON lock-create EPERM:", createRefusals);
`,
        );
        const tsx = import.meta.resolve("tsx");
        const run = () =>
          new Promise<number>((resolveExit) => {
            const child = spawn(process.execPath, ["--import", tsx, script], { stdio: "inherit" });
            child.on("exit", (code) => resolveExit(code ?? 1));
          });
        expect(await Promise.all([run(), run(), run(), run()])).toEqual([0, 0, 0, 0]);
        expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ n: 20 });
        // No leftover temporary or lock files.
        expect(await readdir(dir)).toEqual(["counter.json", "worker.mts"].sort());
      });
    },
    60_000,
  );

  it("reports lock acquisition syscall errors separately from a stuck writer", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "counter.json");
      await writeFile(target, JSON.stringify({ n: 7 }));
      const fs: SafeFs = {
        ...nodeSafeFs,
        lock: {
          ...nodeSafeFs.lock,
          writeFile: async () => {
            throw Object.assign(new Error("private system detail"), { code: "EPERM" });
          },
        },
      };
      const outcome = await updateJsonFile(target, () => ({ write: { n: 8 } }), {
        fs,
        lockWaitMs: 0,
      });
      expect(outcome).toMatchObject({
        status: "not-written",
        reason: expect.stringContaining("create: EPERM"),
      });
      expect(JSON.stringify(outcome)).not.toContain("private system detail");
      expect(JSON.stringify(outcome)).not.toContain("delete");
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ n: 7 });
      expect(await readdir(dir)).toEqual(["counter.json"]);
    });
  });
  it("a failure before the rename keeps the previous file and leaves no temporary file", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "a.json");
      await overwriteJson(target, { v: 1 });
      for (const step of ["createSynced", "rename"] as const) {
        const outcome = await overwriteJson(target, { v: 2 }, { fs: failing(step) });
        expect(outcome, step).toMatchObject({ status: "not-written" });
        expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 1 });
        expect(await readdir(dir)).toEqual(["a.json"]);
      }
      // Verification that reads back different bytes is refused before the commit too.
      const corrupt: SafeFs = {
        ...nodeSafeFs,
        readFile: async (p) => (p.endsWith(".tmp") ? "garbage" : nodeSafeFs.readFile(p)),
      };
      expect(await overwriteJson(target, { v: 3 }, { fs: corrupt })).toMatchObject({
        status: "not-written",
      });
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 1 });
    });
  });

  it("a failure after the rename is committed-with-error, never reported as rolled back", async () => {
    if (process.platform === "win32") return; // directory sync is a named Windows limitation
    await withDir(async (dir) => {
      const target = join(dir, "a.json");
      const outcome = await overwriteJson(target, { v: 2 }, { fs: failing("syncDirectory") });
      expect(outcome).toMatchObject({
        status: "committed-with-error",
        reason: expect.stringMatching(/durability is unconfirmed/),
      });
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 2 });
    });
  });

  it("never steals an old-looking lock; a stuck lock says how to recover", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "a.json");
      await overwriteJson(target, { v: 1 });
      const lock = `${target}.lock`;
      await writeFile(lock, JSON.stringify({ token: "another", pid: 1, at: 0 }));
      const old = new Date(Date.now() - 86_400_000);
      await utimes(lock, old, old);
      const outcome = await overwriteJson(target, { v: 2 }, { lockWaitMs: 150 });
      expect(outcome).toMatchObject({
        status: "not-written",
        reason: expect.stringMatching(
          /never removed automatically.*delete .*a\.json\.lock yourself/,
        ),
      });
      expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ token: "another" });
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 1 });
    });
  });

  it("losing the lock before the commit refuses; a failed release is reported, not hidden", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "a.json");
      await overwriteJson(target, { v: 1 });
      let reads = 0;
      const stolen: SafeFs = {
        ...nodeSafeFs,
        lock: {
          ...nodeSafeFs.lock,
          // The first read confirms acquisition; the pre-commit recheck sees another token.
          readFile: async (p, e) =>
            ++reads >= 2 ? JSON.stringify({ token: "intruder" }) : nodeSafeFs.lock.readFile(p, e),
        },
      };
      expect(await overwriteJson(target, { v: 2 }, { fs: stolen })).toMatchObject({
        status: "not-written",
        reason: expect.stringMatching(/no longer holds the lock/),
      });
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 1 });
      await rm(`${target}.lock`, { force: true });
      const stuck: SafeFs = {
        ...nodeSafeFs,
        lock: {
          ...nodeSafeFs.lock,
          unlink: async () => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          },
        },
      };
      const written = await overwriteJson(target, { v: 3 }, { fs: stuck });
      expect(written.status).toBe("written");
      expect(written.cleanup).toEqual([
        expect.stringMatching(/a\.json\.lock could not be removed after the write \(EACCES\)/),
      ]);
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ v: 3 });
    });
  });

  it("an unreadable existing file is never treated as empty", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "{not json");
      let seen: string | null = null;
      const outcome = await updateJsonFile(target, (current) => {
        seen = current.state;
        return { refuse: "unreadable" };
      });
      expect(seen).toBe("unreadable");
      expect(outcome.status).toBe("not-written");
      expect(await readFile(target, "utf8")).toBe("{not json");
    });
  });
});

describe("store semantics (#382)", () => {
  const snap = (startedAt: string, repository = "o/r") => ({ repository, startedAt });

  it("a snapshot cache never replaces a newer snapshot of the same repository, or an unreadable file", async () => {
    await withDir(async (dir) => {
      const cache = join(dir, "cache.json");
      expect((await writeSnapshotCache(cache, snap("2026-11-15T10:00:00Z"))).status).toBe(
        "written",
      );
      const older = await writeSnapshotCache(cache, snap("2026-11-15T09:00:00Z"));
      expect(older).toMatchObject({
        status: "kept",
        reason: expect.stringMatching(/newer snapshot/),
      });
      expect(JSON.parse(await readFile(cache, "utf8")).startedAt).toBe("2026-11-15T10:00:00Z");
      expect((await writeSnapshotCache(cache, snap("2026-11-15T11:00:00Z"))).status).toBe(
        "written",
      );
      await writeFile(cache, "{broken");
      expect((await writeSnapshotCache(cache, snap("2026-11-15T12:00:00Z"))).status).toBe(
        "not-written",
      );
      expect(await readFile(cache, "utf8")).toBe("{broken");
    });
  });

  it("a checkpoint advances monotonically for the same repository and refuses anything else", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "checkpoint.json");
      const at = (through: string, repository = "o/r") => ({
        schemaVersion: 1 as const,
        repository,
        through,
      });
      expect((await advanceCheckpoint(path, at("2026-11-15T10:00:00Z"))).status).toBe("written");
      expect((await advanceCheckpoint(path, at("2026-11-15T09:00:00Z"))).status).toBe("kept");
      expect((await advanceCheckpoint(path, at("2026-11-15T11:00:00Z"))).status).toBe("written");
      expect(JSON.parse(await readFile(path, "utf8")).through).toBe("2026-11-15T11:00:00Z");
      const other = await advanceCheckpoint(path, at("2026-11-15T12:00:00Z", "o/other"));
      expect(other).toMatchObject({
        status: "not-written",
        reason: expect.stringMatching(/not a valid checkpoint for o\/other/),
      });
      await writeFile(path, JSON.stringify({ schemaVersion: 2, repository: "o/r", through: "x" }));
      expect((await advanceCheckpoint(path, at("2026-11-15T13:00:00Z"))).status).toBe(
        "not-written",
      );
    });
  });
});
