#!/usr/bin/env node
/**
 * Experimental (#791): proves a real HMR module update with no full reload. Connects to the Vite
 * HMR socket, edits one component, records the first `update` message and restores the file
 * whatever happens.
 *
 * Usage: node spike/dev-server/hmr-probe.mjs <file> [ws-url]
 */
import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
const url = process.argv[3] ?? "ws://127.0.0.1:5199/";
if (!file) {
  console.error("usage: hmr-probe.mjs <file> [ws-url]");
  process.exit(2);
}

const original = await readFile(file, "utf8");
// Vite sends HMR updates only for modules a client has loaded, so request the page and the
// module first; otherwise the probe would wait for an update the server has no reason to send.
const base = url.replace(/^ws/, "http").replace(/\/$/, "/");
const modulePath = `/${file.replace(/^.*spike\/dev-server\//, "")}`;
await fetch(base).then((r) => r.text());
await fetch(new URL(modulePath, base)).then((r) => r.text());
const socket = new WebSocket(url, "vite-hmr");
const messages = [];
socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await new Promise((r) => setTimeout(r, 500));
  const sent = Date.now();
  // A real markup edit the browser must apply without reloading: a probe attribute on the button.
  const edited = original.includes("spike")
    ? original.replace("spike", `spike ${Date.now()}`)
    : `${original}\n<!-- hmr probe ${Date.now()} -->\n`;
  await writeFile(file, edited);
  let update = null;
  for (let i = 0; i < 100 && !update; i++) {
    await new Promise((r) => setTimeout(r, 100));
    update = messages.find((m) => m.type === "update") ?? null;
  }
  const received = Date.now();
  console.log(
    JSON.stringify(
      {
        connected: messages.some((m) => m.type === "connected"),
        updates: messages
          .filter((m) => m.type === "update")
          .map((m) => m.updates.map((u) => u.path)),
        fullReload: messages.some((m) => m.type === "full-reload"),
        editToUpdateMs: update ? received - sent : null,
      },
      null,
      2,
    ),
  );
  process.exitCode = update ? 0 : 1;
} finally {
  await writeFile(file, original);
  socket.close();
}
