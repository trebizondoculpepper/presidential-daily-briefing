#!/usr/bin/env node
/**
 * Experimental (#791): a supervised backend for the dev-server spike. Restarts the backend when a
 * watched directory changes, never touches the normal `pdb serve` on 4372, waits for the old child
 * before spawning a replacement, and stops cleanly on SIGINT/SIGTERM.
 *
 * Usage: node --import tsx spike/dev-server/supervise.ts <entry.ts> <watch-dir>
 */
import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";

const [entry, watchDir] = process.argv.slice(2);
if (!entry || !watchDir) {
  console.error("usage: supervise.ts <entry.ts> <watch-dir>");
  process.exit(2);
}

let child: ChildProcess | null = null;
let restarts = 0;
let restarting = false;
/** Set once shutdown starts: nothing may be spawned afterwards. */
let stopping = false;
let exiting = false;
let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;

/** A child killed by a signal has `exitCode` null but `signalCode` set. */
const hasExited = (process: ChildProcess): boolean =>
  process.exitCode !== null || process.signalCode !== null;

const start = (): void => {
  const spawned = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit" });
  child = spawned;
  spawned.on("exit", (code) => {
    if (code && code !== 0 && !restarting)
      console.error(`backend exited ${code}; waiting for the next edit`);
  });
};

/**
 * Restart only after the old child has exited: SIGTERM is asynchronous, and spawning the
 * replacement first races it for the listening port (EADDRINUSE), leaving nothing serving.
 */
const restart = (): void => {
  if (restarting || stopping) return;
  restarting = true;
  restarts += 1;
  console.log(`[supervise] restart ${restarts} (pid ${child?.pid ?? "none"} -> new)`);
  const old = child;
  const spawnNext = (): void => {
    if (stopping) {
      restarting = false;
      return;
    }
    start();
    restarting = false;
  };
  if (!old || hasExited(old)) return spawnNext();
  const guard = setTimeout(() => {
    console.error("[supervise] old backend ignored SIGTERM; killing it");
    old.kill("SIGKILL");
  }, 3000);
  old.once("exit", () => {
    clearTimeout(guard);
    spawnNext();
  });
  old.kill("SIGTERM");
};

const shutdown = (signal: NodeJS.Signals): void => {
  if (exiting) return;
  exiting = true;
  // Never spawn a replacement that shutdown would orphan.
  stopping = true;
  if (timer) clearTimeout(timer);
  watcher?.close();
  if (!child || hasExited(child)) process.exit(0);
  child.once("exit", () => process.exit(0));
  child.kill(signal);
  setTimeout(() => {
    child?.kill("SIGKILL");
    process.exit(1);
  }, 3000).unref();
};

// The watcher is created before the child so a bad path cannot leave an unsupervised backend.
try {
  watcher = watch(watchDir, { recursive: true }, () => {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(restart, 150);
  });
  watcher.on("error", (error) => {
    console.error(`[supervise] watcher failed: ${error.message}`);
    shutdown("SIGTERM");
  });
} catch (error) {
  console.error(`[supervise] cannot watch ${watchDir}: ${(error as Error).message}`);
  process.exit(2);
}
start();
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
