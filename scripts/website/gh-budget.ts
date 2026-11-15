import { CaptureFailure } from "./failure.js";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

export interface GhBudget {
  schemaVersion: 1;
  requests: number;
  deadline: number;
  maximum: number;
  refused: boolean;
}
export async function readBudget(path: string): Promise<GhBudget> {
  const raw = await readFile(path, "utf8");
  if (raw.length > 1024) throw new CaptureFailure("Invalid capture budget.");
  const x = JSON.parse(raw) as Partial<GhBudget>;
  if (
    x.schemaVersion !== 1 ||
    !Number.isSafeInteger(x.requests) ||
    !Number.isSafeInteger(x.deadline) ||
    !Number.isSafeInteger(x.maximum) ||
    x.requests! < 0 ||
    x.maximum! < 1 ||
    x.maximum! > 50 ||
    typeof x.refused !== "boolean"
  )
    throw new CaptureFailure("Invalid capture budget.");
  return x as GhBudget;
}
/** No stale-lock stealing: a broken capture fails rather than exceeding its shared allowance. */
export async function reserveGhRead(
  path: string,
  allowed: boolean,
  now = Date.now,
): Promise<number> {
  const lock = `${path}.lock`;
  const lockDeadline = now() + 2_000;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || now() >= lockDeadline)
        throw new CaptureFailure("Capture budget lock unavailable.");
      await wait(10);
    }
  }
  try {
    const budget = await readBudget(path);
    if (
      !allowed ||
      budget.refused ||
      now() >= budget.deadline ||
      budget.requests >= budget.maximum
    ) {
      budget.refused = true;
      await writeFile(path, JSON.stringify(budget), { mode: 0o600 });
      throw new CaptureFailure("Capture GitHub policy or budget refused the read.");
    }
    budget.requests++;
    await writeFile(path, JSON.stringify(budget), { mode: 0o600 });
    return budget.deadline;
  } finally {
    await rmdir(lock);
  }
}
