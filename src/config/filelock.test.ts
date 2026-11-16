import { describe, expect, it } from "vite-plus/test";
import {
  acquireFileLock,
  acquireFileLockResult,
  acquisitionProblem,
  type LockFs,
} from "./filelock.js";

function memoryLock() {
  const files = new Map<string, string>();
  let time = 0;
  const removed: string[] = [];
  const fs: LockFs = {
    async readFile(path) {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path)!;
    },
    async writeFile(path, data) {
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, data);
    },
    async unlink(path) {
      removed.push(path);
      files.delete(path);
    },
  };
  return {
    fs,
    files,
    removed,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
const timing = { waitMs: 10, pollMs: 2 };

describe("file lock acquisition evidence (#729)", () => {
  it("distinguishes an immediate create error from contention without disclosing error text", async () => {
    const f = memoryLock();
    f.fs.writeFile = async () => {
      throw Object.assign(new Error("private diagnostic content"), { code: "EACCES" });
    };
    const outcome = await acquireFileLockResult(
      f.fs,
      "/private/counter.lock",
      timing,
      f.now,
      f.sleep,
    );
    expect(outcome).toEqual({ status: "failed", phase: "create", code: "EACCES" });
    expect(f.now()).toBe(0);
    if (outcome.status === "acquired") throw new Error("unexpected lock");
    expect(acquisitionProblem("/private/counter.lock", outcome)).toContain("create: EACCES");
    expect(acquisitionProblem("/private/counter.lock", outcome)).not.toContain("/private/");
    expect(acquisitionProblem("/private/counter.lock", outcome)).not.toContain(
      "private diagnostic content",
    );
    expect(acquisitionProblem("/private/counter.lock", outcome)).not.toContain("delete");
    expect(await acquireFileLock(f.fs, "counter.lock", timing, f.now, f.sleep)).toBeNull();
  });
  it("preserves a readback error and never removes an unverified lock", async () => {
    const f = memoryLock();
    f.fs.readFile = async () => {
      throw Object.assign(new Error("I/O"), { code: "EIO" });
    };
    expect(await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep)).toEqual({
      status: "failed",
      phase: "verify",
      code: "EIO",
    });
    expect(f.files.has("counter.lock")).toBe(true);
    expect(f.removed).toEqual([]);
  });
  it("reports deadline exhaustion only for a busy lock and never steals it", async () => {
    const f = memoryLock();
    f.files.set("counter.lock", "another writer");
    expect(await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep)).toEqual({
      status: "busy",
    });
    expect(f.now()).toBe(timing.waitMs);
    expect(f.files.get("counter.lock")).toBe("another writer");
    expect(f.removed).toEqual([]);
  });
  it("distinguishes a replaced token and preserves the replacement", async () => {
    const f = memoryLock();
    f.fs.readFile = async (path) => {
      f.files.set(path, "replacement");
      return "replacement";
    };
    expect(await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep)).toEqual({
      status: "replaced",
    });
    expect(f.files.get("counter.lock")).toBe("replacement");
    expect(f.removed).toEqual([]);
  });
  it("keeps the existing held-lock release interface compatible", async () => {
    const f = memoryLock();
    const held = await acquireFileLock(f.fs, "counter.lock", timing, f.now, f.sleep);
    expect(await held?.owned()).toBe(true);
    expect(await held?.()).toEqual({ status: "released" });
    expect(f.files.has("counter.lock")).toBe(false);
  });
});
