/** Private process-per-hook state. Never stores briefing data, raw session/event IDs or credentials. */
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eventRecordSchema, metaSchema, stateSchema } from "./core.js";
import type { SessionMeta, SessionState, SessionStore } from "./core.js";

export class StateUnavailable extends Error {}
/** The caller creates a disposable directory with mkdtemp; reject links, public dirs and repo paths. */
/** Verify the caller's private session directory: absolute, owned, private, outside any repo. */
async function verifiedDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new StateUnavailable();
  const dir = await realpath(directory);
  const base = await realpath(tmpdir());
  const rel = relative(base, dir);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new StateUnavailable();
  if ((await lstat(directory)).isSymbolicLink()) throw new StateUnavailable();
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new StateUnavailable();
  for (let ancestor = dir; ancestor !== base; ancestor = dirname(ancestor)) {
    let inGit = false;
    try {
      await lstat(join(ancestor, ".git"));
      inGit = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw new StateUnavailable();
    }
    if (inGit) throw new StateUnavailable();
  }
  return dir;
}

/** Run `work` under the directory's exclusive lock; a held lock is unavailable, never broken. */
async function underLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lockPath = join(dir, "lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new StateUnavailable();
  }
  try {
    return await work();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Read one private, owned, regular file of at most `limit` bytes; null when absent. */
async function readPrivate(path: string, limit: number): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.size > limit ||
      (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))
    )
      throw new StateUnavailable();
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw new StateUnavailable();
  }
}

/** Atomically replace `path` with private text (temporary file, fsync, rename). */
async function writePrivate(dir: string, path: string, text: string): Promise<void> {
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function withPrivateState<T>(
  directory: string,
  work: (state: SessionState | null, save: (state: SessionState) => Promise<void>) => Promise<T>,
): Promise<T> {
  const dir = await verifiedDirectory(directory);
  return underLock(dir, async () => {
    const path = join(dir, "state.json");
    const raw = await readPrivate(path, 65536);
    let state: SessionState | null = null;
    if (raw !== null) {
      try {
        state = stateSchema.parse(JSON.parse(raw));
      } catch {
        throw new StateUnavailable();
      }
    }
    const save = (next: SessionState) =>
      writePrivate(dir, path, JSON.stringify(stateSchema.parse(next)));
    return await work(state, save);
  });
}

/** What a session directory holds: nothing yet, legacy v1 state, or v2 metadata. */
export type StoredSession =
  | { version: "none" }
  | { version: 1; state: SessionState; save: (state: SessionState) => Promise<void> }
  | { version: 2; store: SessionStore };

/**
 * Open the session directory under its lock (#657). v1 state stays readable under its own
 * restrictions and is never upgraded here; v2 metadata opens a digest-keyed record store; an
 * unknown or future schema is unavailable and never overwritten. `create` initializes v2
 * metadata in an empty directory only.
 */
export async function withSessionStore<T>(
  directory: string,
  work: (
    session: StoredSession,
    create: (meta: SessionMeta) => Promise<SessionStore>,
  ) => Promise<T>,
): Promise<T> {
  const dir = await verifiedDirectory(directory);
  return underLock(dir, async () => {
    const path = join(dir, "state.json");
    const raw = await readPrivate(path, 65536);
    const store = fileStore(dir, path);
    const create = async (meta: SessionMeta) => {
      if ((await readPrivate(path, 65536)) !== null) throw new StateUnavailable();
      await store.saveMeta(meta);
      return store;
    };
    if (raw === null) return work({ version: "none" }, create);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StateUnavailable();
    }
    const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version === 1) {
      const state = stateSchema.safeParse(parsed);
      if (!state.success) throw new StateUnavailable();
      const save = (next: SessionState) =>
        writePrivate(dir, path, JSON.stringify(stateSchema.parse(next)));
      return work({ version: 1, state: state.data, save }, create);
    }
    if (version === 2 && metaSchema.safeParse(parsed).success)
      return work({ version: 2, store }, create);
    throw new StateUnavailable();
  });
}

/** Digest-keyed private record files beside the metadata; each read is one bounded file. */
function fileStore(dir: string, metaPath: string): SessionStore {
  const record = (prefix: "e" | "f", key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new StateUnavailable();
    return join(dir, `${prefix}-${key}.json`);
  };
  const parsed = <T>(raw: string | null, parse: (v: unknown) => T): T | null => {
    if (raw === null) return null;
    try {
      return parse(JSON.parse(raw));
    } catch {
      throw new StateUnavailable();
    }
  };
  return {
    meta: async () => parsed(await readPrivate(metaPath, 65536), (v) => metaSchema.parse(v)),
    saveMeta: (meta) => writePrivate(dir, metaPath, JSON.stringify(metaSchema.parse(meta))),
    event: async (key) =>
      parsed(await readPrivate(record("e", key), 4096), (v) => eventRecordSchema.parse(v)),
    saveEvent: (key, r) =>
      writePrivate(dir, record("e", key), JSON.stringify(eventRecordSchema.parse(r))),
    acknowledged: async (fingerprint) =>
      (await readPrivate(record("f", fingerprint), 4096)) !== null,
    saveAcknowledged: (fingerprint) =>
      writePrivate(dir, record("f", fingerprint), JSON.stringify({ acknowledged: true })),
  };
}
