/** Credential-free POSIX parent-death probe; no PDB, auth or service setup. Node 26+. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const file = fileURLToPath(import.meta.url);
const [mode, directory, nonce] = process.argv.slice(2);

if (mode === "worker") {
  if (!directory || !nonce) throw new Error("probe worker arguments missing");
  const deadline = performance.now() + 5000;
  for (let beat = 1; performance.now() < deadline; beat++) {
    try {
      if ((await readFile(join(directory, "stop"), "utf8")) === nonce) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(
      join(directory, "heartbeat.json"),
      JSON.stringify({ pid: process.pid, nonce, beat }),
    );
    await sleep(100);
  }
} else if (mode === "launcher") {
  if (!directory || !nonce) throw new Error("probe launcher arguments missing");
  const worker = spawn(process.execPath, [file, "worker", directory, nonce], {
    detached: true,
    stdio: "ignore",
  });
  if (!worker.pid) throw new Error("probe worker did not spawn");
  worker.unref();
  // Keep this disposable launcher alive until the outer probe kills it.
  await sleep(5000);
} else {
  if (process.platform === "win32")
    throw new Error("This probe covers POSIX only; Windows untested.");
  const dir = await mkdtemp(join(tmpdir(), "pdb-background-probe-"));
  const token = randomUUID();
  const launcher = spawn(process.execPath, [file, "launcher", dir, token], { stdio: "ignore" });
  const ended = new Promise<void>((resolve) => launcher.once("exit", () => resolve()));
  let workerPid: number | undefined;
  const heartbeat = async (): Promise<{ pid: number; nonce: string; beat: number }> => {
    const raw: unknown = JSON.parse(await readFile(join(dir, "heartbeat.json"), "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("nonce" in raw) ||
      raw.nonce !== token ||
      !("pid" in raw) ||
      !Number.isSafeInteger(raw.pid) ||
      Number(raw.pid) <= 1 ||
      !("beat" in raw) ||
      !Number.isSafeInteger(raw.beat)
    )
      throw new Error("invalid probe heartbeat");
    return raw as { pid: number; nonce: string; beat: number };
  };
  try {
    const deadline = performance.now() + 2500;
    let before: Awaited<ReturnType<typeof heartbeat>> | undefined;
    while (performance.now() < deadline && !before) {
      try {
        before = await heartbeat();
      } catch {
        await sleep(50);
      }
    }
    if (!before) throw new Error("probe worker never became ready");
    workerPid = before.pid;
    launcher.kill("SIGKILL");
    await Promise.race([
      ended,
      sleep(1000).then(() => {
        throw new Error("launcher did not exit");
      }),
    ]);
    await sleep(350);
    const after = await heartbeat();
    if (after.pid !== workerPid || after.beat <= before.beat)
      throw new Error("worker did not survive parent death");
    console.log(
      JSON.stringify({
        platform: process.platform,
        node: process.version,
        parentKilled: true,
        sameWorker: true,
        heartbeatAdvanced: true,
        boundary: "synthetic launcher SIGKILL only; IDE, logout, sleep and reboot not tested",
      }),
    );
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    if (workerPid) {
      // Ask this nonce-bound probe to exit; never signal a guessed/reused worker PID.
      await writeFile(join(dir, "stop"), token);
      const deadline = performance.now() + 1000;
      let alive = true;
      while (performance.now() < deadline && alive) {
        try {
          process.kill(workerPid, 0);
          await sleep(25);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          alive = false;
        }
      }
      if (alive)
        throw new Error("probe worker cleanup not confirmed; inspect the disposable worker");
    }
    await rm(dir, { recursive: true, force: true });
  }
}
