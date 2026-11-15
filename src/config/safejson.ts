/**
 * Safe shared JSON writes (#382, doc/design/safe-shared-file-writes.md).
 *
 * One locked read-modify-write per target: take the target's own lock (never stolen by age),
 * read the current state (absent, a value, or unreadable: never treated as empty), let the
 * store decide, then write a fresh private temporary file in the same directory, fsync and
 * verify it, recheck lock ownership, rename it over the target (the commit point), fsync the
 * directory where supported, and release. Failure before the rename is `not-written` and keeps
 * the previous file; failure after it is `committed-with-error`. Cleanup problems are additive.
 *
 * Each store keeps its own semantics through its `decide` callback; there is no generic merge.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { acquireFileLock, releaseProblem, stuckLockMessage } from "./filelock.js";

/** The current state of the target, read under its lock. */
export type CurrentState =
  | { state: "absent" }
  | { state: "value"; value: unknown }
  | { state: "unreadable"; why: string };

/** A store's decision: write this value, keep the current file, or refuse. */
export type Decision = { write: unknown } | { keep: string } | { refuse: string };

export type WriteOutcome =
  | { status: "written"; cleanup: string[] }
  | { status: "kept"; reason: string; cleanup: string[] }
  | { status: "not-written"; reason: string; cleanup: string[] }
  | { status: "committed-with-error"; reason: string; cleanup: string[] };

/** The filesystem steps, injectable so each step's failure can be tested. */
export interface SafeFs {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Create exclusively with private permissions, write, and fsync. */
  createSynced(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** fsync a directory; throws when unsupported or failed. */
  syncDirectory(path: string): Promise<void>;
  /** The lock's own operations. */
  lock: {
    readFile(path: string, encoding: "utf8"): Promise<string>;
    writeFile(path: string, data: string, options: { flag?: string }): Promise<void>;
    unlink(path: string): Promise<void>;
  };
}

const code = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown";

export const nodeSafeFs: SafeFs = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  readFile: (path) => readFile(path, "utf8"),
  async createSynced(path, data) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  unlink,
  async syncDirectory(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  lock: { readFile, writeFile: (p, d, o) => writeFile(p, d, o), unlink },
};

/** Directory fsync is not available on Windows; these codes there are a named limitation. */
const unsupportedDirectorySync = (error: unknown): boolean =>
  process.platform === "win32" && ["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(code(error));

/** Transient sharing refusals a Windows rename can return while another reader has the file. */
const transientRename = (error: unknown): boolean =>
  process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(code(error));

export interface UpdateOptions {
  fs?: SafeFs;
  /** How long to wait for another writer of this exact target (default 5 s). */
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Re-read the target just before the commit and refuse if it changed since it was read (#351):
   * for files that people and tools edit without honouring the lock, such as AGENTS.md. This
   * narrows, but cannot portably close, the window between that re-read and the rename.
   */
  checkUnchanged?: boolean;
}

/** Serialize exactly as the files have always been written. */
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/**
 * Locked, durable read-modify-write of one JSON file. `decide` sees the current state read under
 * the lock and returns what to do; the outcome says whether the target changed.
 */
export const updateJsonFile = (
  target: string,
  decide: (current: CurrentState) => Decision,
  options: UpdateOptions = {},
): Promise<WriteOutcome> =>
  updateTextFile(
    target,
    (current) => {
      let state: CurrentState;
      if (current.state !== "text") state = current;
      else
        try {
          state = { state: "value", value: JSON.parse(current.text) };
        } catch {
          state = { state: "unreadable", why: "the existing file is not valid JSON" };
        }
      const decision = decide(state);
      return "write" in decision ? { write: serialize(decision.write) } : decision;
    },
    options,
  );

/** The current text of a file, read under its lock. */
export type TextState =
  | { state: "absent" }
  | { state: "text"; text: string }
  | { state: "unreadable"; why: string };
export type TextDecision = { write: string } | { keep: string } | { refuse: string };

/**
 * Locked, durable read-modify-write of one text file (#382): the same sequence for JSON stores
 * and for managed sections of text files such as AGENTS.md (#351).
 */
export async function updateTextFile(
  target: string,
  decide: (current: TextState) => TextDecision,
  options: UpdateOptions = {},
): Promise<WriteOutcome> {
  const fs = options.fs ?? nodeSafeFs;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const path = resolve(target);
  const dir = dirname(path);
  const lockPath = `${path}.lock`;
  const cleanup: string[] = [];
  try {
    await fs.mkdir(dir);
  } catch (error) {
    return { status: "not-written", reason: `cannot create ${dir} (${code(error)})`, cleanup };
  }
  const release = await acquireFileLock(
    fs.lock,
    lockPath,
    { waitMs: options.lockWaitMs ?? 5000, pollMs: 50 },
    now,
    sleep,
  );
  if (!release) return { status: "not-written", reason: stuckLockMessage(lockPath), cleanup };
  const finish = async (outcome: WriteOutcome): Promise<WriteOutcome> => {
    const problem = releaseProblem(lockPath, await release());
    return problem ? { ...outcome, cleanup: [...outcome.cleanup, problem] } : outcome;
  };

  // 1. Current state: absent, text, or unreadable (never treated as empty).
  let current: TextState;
  try {
    current = { state: "text", text: await fs.readFile(path) };
  } catch (error) {
    current =
      code(error) === "ENOENT"
        ? { state: "absent" }
        : { state: "unreadable", why: `the existing file cannot be read (${code(error)})` };
  }

  // 2. The store's decision.
  const decision = decide(current);
  if ("keep" in decision) return finish({ status: "kept", reason: decision.keep, cleanup });
  if ("refuse" in decision)
    return finish({ status: "not-written", reason: decision.refuse, cleanup });
  const text = decision.write;

  // 3-4. A fresh private temporary file, written, synced and verified.
  const temporary = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const dropTemporary = async () => {
    try {
      await fs.unlink(temporary);
    } catch (error) {
      if (code(error) !== "ENOENT")
        cleanup.push(`temporary file ${temporary} was left behind (${code(error)})`);
    }
  };
  try {
    await fs.createSynced(temporary, text);
    if ((await fs.readFile(temporary)) !== text) throw new Error("verification mismatch");
  } catch (error) {
    await dropTemporary();
    return finish({
      status: "not-written",
      reason: `writing the new file failed (${code(error)}); the previous file is unchanged`,
      cleanup,
    });
  }

  // 5. Still ours? Then rename: the commit point.
  if (!(await release.owned())) {
    await dropTemporary();
    return finish({
      status: "not-written",
      reason:
        "this writer no longer holds the lock (it was removed or replaced) before the commit; nothing was replaced",
      cleanup,
    });
  }
  if (options.checkUnchanged) {
    let now: TextState;
    try {
      now = { state: "text", text: await fs.readFile(path) };
    } catch (error) {
      now = code(error) === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: "" };
    }
    const same =
      now.state === current.state &&
      (now.state !== "text" || (current.state === "text" && now.text === current.text));
    if (!same || now.state === "unreadable") {
      await dropTemporary();
      return finish({
        status: "not-written",
        reason: "the file changed while it was being updated; nothing was replaced, so retry",
        cleanup,
      });
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, path);
      break;
    } catch (error) {
      if (transientRename(error) && attempt < 3) {
        await sleep(50);
        continue;
      }
      await dropTemporary();
      return finish({
        status: "not-written",
        reason: `replacing the file failed (${code(error)}); the previous file is unchanged`,
        cleanup,
      });
    }
  }

  // 6. Directory durability, after the commit point.
  try {
    await fs.syncDirectory(dir);
  } catch (error) {
    if (!unsupportedDirectorySync(error))
      return finish({
        status: "committed-with-error",
        reason: `the new file is in place, but its directory could not be synced (${code(error)}); durability is unconfirmed`,
        cleanup,
      });
  }
  return finish({ status: "written", cleanup });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Plain overwrite (plan files and similar): any readable or absent target is replaced; an
 * unreadable one is replaced too, as those files always were.
 */
export const overwriteJson = (path: string, value: unknown, options?: UpdateOptions) =>
  updateJsonFile(path, () => ({ write: value }), options);

/**
 * An explicit snapshot cache: a coherent replacement that never replaces a newer snapshot of
 * the same repository, and never overwrites a file it cannot read.
 */
export const writeSnapshotCache = (
  path: string,
  snapshot: { repository: string; startedAt: string },
  options?: UpdateOptions,
) =>
  updateJsonFile(
    path,
    (current) => {
      if (current.state === "unreadable")
        return { refuse: `${current.why}; it was not overwritten. Move or delete ${path} first.` };
      if (current.state === "value" && isRecord(current.value)) {
        const existing = current.value;
        if (
          existing.repository === snapshot.repository &&
          typeof existing.startedAt === "string" &&
          Date.parse(existing.startedAt) > Date.parse(snapshot.startedAt)
        )
          return {
            keep: `${path} already holds a newer snapshot (started ${existing.startedAt}); it was kept`,
          };
      }
      return { write: snapshot };
    },
    options,
  );

/**
 * Advance a checkpoint monotonically: same schema and repository, never moving backwards. An
 * invalid, future-schema or other-repository checkpoint is refused, not repaired.
 */
export const advanceCheckpoint = (
  path: string,
  checkpoint: { schemaVersion: 1; repository: string; through: string },
  options?: UpdateOptions,
) =>
  updateJsonFile(
    path,
    (current) => {
      if (current.state === "unreadable")
        return { refuse: `the checkpoint ${current.why}; it was not advanced` };
      if (current.state === "absent") return { write: checkpoint };
      const existing = current.value;
      if (
        !isRecord(existing) ||
        existing.schemaVersion !== 1 ||
        existing.repository !== checkpoint.repository ||
        typeof existing.through !== "string" ||
        !Number.isFinite(Date.parse(existing.through))
      )
        return {
          refuse: `the checkpoint at ${path} is not a valid checkpoint for ${checkpoint.repository}; it was not advanced`,
        };
      if (Date.parse(existing.through) >= Date.parse(checkpoint.through))
        return {
          keep: `the checkpoint is already at ${existing.through}; it was not moved back`,
        };
      return { write: checkpoint };
    },
    options,
  );
