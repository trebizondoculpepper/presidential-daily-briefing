import { CaptureFailure } from "./failure.js";
import { spawn } from "node:child_process";
import { allowGhRead } from "./gh-policy.js";
import { reserveGhRead } from "./gh-budget.js";

try {
  const argv = process.argv.slice(2);
  const budget = process.env.PDB_SITE_BUDGET;
  const realGh = process.env.PDB_SITE_REAL_GH;
  if (!budget || !realGh) throw new CaptureFailure("Capture transport configuration missing.");
  let allowed = process.env.PDB_SITE_GH_ALLOWED === "1";
  try {
    allowGhRead(argv);
  } catch {
    allowed = false;
  }
  const deadline = await reserveGhRead(budget, allowed);
  const child = spawn(realGh, argv, { stdio: "inherit", env: process.env });
  const stop = (): void => {
    child.kill("SIGKILL");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const timer = setTimeout(stop, Math.min(30_000, Math.max(1, deadline - Date.now())));
  process.exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
} catch {
  // Never echo argv, queries, tokens or raw transport failures from a public capture job.
  process.stderr.write("Capture read refused or failed.\n");
  process.exitCode = 1;
}
