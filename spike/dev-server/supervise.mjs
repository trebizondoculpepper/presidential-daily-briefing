#!/usr/bin/env node
/**
 * Experimental (#791): a supervised backend for the dev-server spike. It restarts the backend
 * process when a watched file changes, and never touches the normal `pdb serve` on port 4372.
 *
 * Usage: node spike/dev-server/supervise.mjs <entry.ts> <watch-path> [--extra-arg ...]
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";

const [entry, watchPath] = process.argv.slice(2);
if (!entry || !watchPath) {
  console.error("usage: supervise.mjs <entry.ts> <watch-path>");
  process.exit(2);
}
let child = null;
let restarts = 0;
let restarting = false;
const start = () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit" });
  const spawned = child;
  spawned.on("exit", (code) => {
    if (code && code !== 0 && !restarting)
      console.error(`backend exited ${code}; waiting for the next edit`);
  });
};
/**
 * Restart only after the old child has exited: SIGTERM is asynchronous, and spawning the
 * replacement first races it for the listening port (EADDRINUSE), leaving nothing serving
 * (reviewed #1200 finding).
 */
const restart = () => {
  if (restarting) return;
  restarting = true;
  restarts += 1;
  console.log(`[supervise] restart ${restarts} (pid ${child?.pid ?? "none"} -> new)`);
  const old = child;
  const spawnNext = () => {
    start();
    restarting = false;
  };
  if (!old || old.exitCode !== null) return spawnNext();
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
start();
let timer = null;
watch(watchPath, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(restart, 150);
});
// Both signals share one shutdown path and wait for the child: a task runner that stops the
// supervisor with SIGTERM must not leave the backend holding its port (reviewed #1200 finding).
let exiting = false;
const shutdown = (signal) => {
  if (exiting) return;
  exiting = true;
  if (!child || child.exitCode !== null) process.exit(0);
  child.once("exit", () => process.exit(0));
  child.kill(signal);
  // Never hang forever if the child ignores the signal.
  setTimeout(() => {
    child.kill("SIGKILL");
    process.exit(1);
  }, 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
