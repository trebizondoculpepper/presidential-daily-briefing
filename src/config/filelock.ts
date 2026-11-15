/**
 * Short-lived cross-process exclusive file lock with bounded waiting (#382,
 * doc/design/safe-shared-file-writes.md). Shared by the daily update cache (#65), identity
 * writes (#70) and safe JSON writes.
 *
 * The lock file is created with the exclusive `wx` flag (portable, including Windows) and holds
 * a fresh random token. A lock is **never** removed or taken over because it looks old, its PID
 * is absent or a clock moved: an old-looking holder may be slow, paused or on another machine.
 * A crashed holder therefore leaves a stuck lock, which waiters report (`stuckLockMessage`) and
 * an operator removes deliberately. A writer proceeds only if the lock it created still holds
 * its own token, and releases only a lock holding its token; release reports what happened
 * instead of swallowing failures.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";

/** The filesystem operations the lock needs; `node:fs/promises` satisfies it. */
export interface LockFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag?: string }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unused since #382 (locks are never judged by age); kept so existing adapters compile. */
  stat?(path: string): Promise<{ mtimeMs: number }>;
}

export interface LockTiming {
  /** How long to wait for another holder before giving up. */
  readonly waitMs: number;
  /** Ignored since #382: a lock is never broken by age. Kept for compatible call sites. */
  readonly staleMs?: number;
  /** Delay between attempts. */
  readonly pollMs: number;
}

/**
 * What releasing found: `released` (ours, removed), `missing` (already gone), `replaced` (the
 * lock now holds another token: left alone), or `failed` (reading or removing it failed; the
 * lock may still be present, and later writers will report it as stuck).
 */
export type ReleaseOutcome =
  | { status: "released" }
  | { status: "missing" }
  | { status: "replaced" }
  | { status: "failed"; code: string };

/** A held lock: call it to release; `owned()` rechecks that it still holds this writer's token. */
export type HeldLock = (() => Promise<ReleaseOutcome>) & { owned(): Promise<boolean> };

/** The operator message for a lock that was not released within the wait. */
export const stuckLockMessage = (lock: string): string =>
  `${basename(lock)} is held by another writer, or was left behind by one that stopped; it is never removed automatically. Make sure no pdb process is writing this file, then delete ${lock} yourself and retry.`;

/**
 * Take the lock. Returns a release function, or null when the lock could not be taken within
 * `waitMs` (busy, or stuck: see `stuckLockMessage`) or an unexpected filesystem error occurred.
 */
export async function acquireFileLock(
  fs: LockFs,
  lock: string,
  timing: LockTiming,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<HeldLock | null> {
  const token = randomBytes(16).toString("hex");
  const deadline = now() + timing.waitMs;
  const holder = async (): Promise<string | undefined> => {
    const text = await fs.readFile(lock, "utf8"); // filesystem errors propagate
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && typeof parsed.token === "string" ? parsed.token : text;
    } catch {
      return text; // a torn or foreign lock is identified by its content
    }
  };
  const release = async (): Promise<ReleaseOutcome> => {
    let current: string | undefined;
    try {
      current = await holder();
    } catch (error) {
      return code(error) === "ENOENT"
        ? { status: "missing" }
        : { status: "failed", code: codeText(error) };
    }
    // Never unlink a replacement lock.
    if (current !== token) return { status: "replaced" };
    try {
      await fs.unlink(lock);
      return { status: "released" };
    } catch (error) {
      return code(error) === "ENOENT"
        ? { status: "missing" }
        : { status: "failed", code: codeText(error) };
    }
  };
  for (;;) {
    try {
      await fs.writeFile(lock, JSON.stringify({ token, pid: process.pid, at: now() }), {
        flag: "wx",
      });
      // Proceed only if the lock still holds our token.
      try {
        if ((await holder()) !== token) return null;
        // `owned` lets a writer recheck, just before its commit point, that the lock is still its.
        const owned = async () => {
          try {
            return (await holder()) === token;
          } catch {
            return false;
          }
        };
        return Object.assign(release, { owned });
      } catch {
        return null;
      }
    } catch (error) {
      if (code(error) !== "EEXIST") return null;
    }
    if (now() >= deadline) return null;
    await sleep(timing.pollMs);
  }
}

/** Whether a release left something for an operator to look at. */
export const releaseProblem = (lock: string, outcome: ReleaseOutcome): string | null =>
  outcome.status === "failed"
    ? `${basename(lock)} could not be removed after the write (${outcome.code}); ${stuckLockMessage(lock)}`
    : null;

const code = (error: unknown) => (isRecord(error) ? error.code : undefined);
/** A filesystem error code as text, for reports; never an object's default string. */
const codeText = (error: unknown): string => {
  const c = code(error);
  return typeof c === "string" || typeof c === "number" ? String(c) : "unknown";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
