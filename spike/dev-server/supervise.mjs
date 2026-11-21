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
const start = () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`backend exited ${code}; waiting for the next edit`);
  });
};
const restart = () => {
  restarts += 1;
  console.log(`[supervise] restart ${restarts} (pid ${child?.pid ?? "none"} -> new)`);
  child?.kill("SIGTERM");
  start();
};
start();
let timer = null;
watch(watchPath, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(restart, 150);
});
process.on("SIGINT", () => {
  child?.kill("SIGTERM");
  process.exit(0);
});
