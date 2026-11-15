/** Private process-per-hook state. Never stores briefing data, raw session/event IDs or credentials. */
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { stateSchema } from "./core.js";
import type { SessionState } from "./core.js";

export class StateUnavailable extends Error {}
/** The caller creates a disposable directory with mkdtemp; reject links, public dirs and repo paths. */
export async function withPrivateState<T>(
  directory: string,
  work: (state: SessionState | null, save: (state: SessionState) => Promise<void>) => Promise<T>,
): Promise<T> {
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
  const lockPath = join(dir, "lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new StateUnavailable();
  }
  const path = join(dir, "state.json");
  try {
    let state: SessionState | null = null;
    try {
      const st = await lstat(path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.size > 65536 ||
        (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))
      )
        throw new StateUnavailable();
      state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw new StateUnavailable();
    }
    const save = async (next: SessionState) => {
      const temporary = join(dir, `${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(stateSchema.parse(next)));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    };
    return await work(state, save);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
