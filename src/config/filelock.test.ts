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

describe("bounded Windows exclusive-create refusals (#729)", () => {
  it("recovers EPERM with exclusive attempts and verifies ownership before proceeding", async () => {
    const f = memoryLock();
    const write = f.fs.writeFile.bind(f.fs);
    const attempts: { at: number; flag: string | undefined }[] = [];
    f.fs.writeFile = async (path, data, options) => {
      attempts.push({ at: f.now(), flag: options.flag });
      if (attempts.length <= 2) throw Object.assign(new Error("refused"), { code: "EPERM" });
      return write(path, data, options);
    };
    const outcome = await acquireFileLockResult(
      f.fs,
      "counter.lock",
      timing,
      f.now,
      f.sleep,
      "win32",
    );
    expect(outcome.status).toBe("acquired");
    expect(attempts).toEqual([
      { at: 0, flag: "wx" },
      { at: 2, flag: "wx" },
      { at: 4, flag: "wx" },
    ]);
    expect(f.removed).toEqual([]);
    if (outcome.status !== "acquired") throw new Error("expected ownership");
    expect(await outcome.lock.owned()).toBe(true);
    expect(await outcome.lock()).toEqual({ status: "released" });
  });

  it("retains permanent EPERM as a create failure and starts no retry at the deadline", async () => {
    const f = memoryLock();
    const attempts: number[] = [];
    f.fs.writeFile = async () => {
      attempts.push(f.now());
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    const outcome = await acquireFileLockResult(
      f.fs,
      "counter.lock",
      timing,
      f.now,
      f.sleep,
      "win32",
    );
    expect(outcome).toEqual({ status: "failed", phase: "create", code: "EPERM" });
    expect(attempts).toEqual([0, 2, 4, 6, 8]);
    expect(f.now()).toBe(10);
    expect(f.removed).toEqual([]);
    if (outcome.status === "acquired") throw new Error("unexpected ownership");
    expect(acquisitionProblem("counter.lock", outcome)).not.toContain("held");
    expect(acquisitionProblem("counter.lock", outcome)).not.toContain("delete");
  });

  it.each([0, 5])("caps sleeping by the remaining %i ms budget", async (waitMs) => {
    const f = memoryLock();
    let attempts = 0;
    f.fs.writeFile = async () => {
      attempts++;
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    expect(
      await acquireFileLockResult(
        f.fs,
        "counter.lock",
        { waitMs, pollMs: 10 },
        f.now,
        f.sleep,
        "win32",
      ),
    ).toEqual({ status: "failed", phase: "create", code: "EPERM" });
    expect(f.now()).toBe(waitMs);
    expect(attempts).toBe(1);
    expect(f.removed).toEqual([]);
  });

  it("does not restart the budget when permission refusals and contention alternate", async () => {
    const f = memoryLock();
    f.files.set("counter.lock", "another writer");
    const attempts: number[] = [];
    f.fs.writeFile = async () => {
      attempts.push(f.now());
      throw Object.assign(new Error("refused"), { code: attempts.length % 2 ? "EPERM" : "EEXIST" });
    };
    expect(
      await acquireFileLockResult(
        f.fs,
        "counter.lock",
        { waitMs: 8, pollMs: 2 },
        f.now,
        f.sleep,
        "win32",
      ),
    ).toEqual({ status: "busy" });
    expect(attempts).toEqual([0, 2, 4, 6]);
    expect(f.now()).toBe(8);
    expect(f.files.get("counter.lock")).toBe("another writer");
    expect(f.removed).toEqual([]);
  });

  it.each(["darwin", "linux", "freebsd"] as const)(
    "does not retry EPERM on %s",
    async (platform) => {
      const f = memoryLock();
      f.fs.writeFile = async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      };
      expect(
        await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep, platform),
      ).toEqual({ status: "failed", phase: "create", code: "EPERM" });
      expect(f.now()).toBe(0);
    },
  );

  it.each(["EACCES", "EIO", "EISDIR"])("does not retry Windows create %s", async (code) => {
    const f = memoryLock();
    f.fs.writeFile = async () => {
      throw Object.assign(new Error("denied"), { code });
    };
    expect(
      await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep, "win32"),
    ).toEqual({ status: "failed", phase: "create", code });
    expect(f.now()).toBe(0);
  });

  it("does not retry a verification EPERM or remove the unverified lock", async () => {
    const f = memoryLock();
    f.fs.readFile = async () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    expect(
      await acquireFileLockResult(f.fs, "counter.lock", timing, f.now, f.sleep, "win32"),
    ).toEqual({ status: "failed", phase: "verify", code: "EPERM" });
    expect(f.now()).toBe(0);
    expect(f.files.has("counter.lock")).toBe(true);
    expect(f.removed).toEqual([]);
  });
});

it("keeps the legacy wrapper compatible with Windows create recovery", async () => {
  const f = memoryLock();
  const write = f.fs.writeFile.bind(f.fs);
  let refused = false;
  f.fs.writeFile = async (path, data, options) => {
    if (!refused) {
      refused = true;
      throw Object.assign(new Error("refused"), { code: "EPERM" });
    }
    return write(path, data, options);
  };
  const held = await acquireFileLock(f.fs, "counter.lock", timing, f.now, f.sleep, "win32");
  expect(f.now()).toBe(2);
  expect(await held?.owned()).toBe(true);
  expect(await held?.()).toEqual({ status: "released" });
});
