import { mkdir, rmdir } from "node:fs/promises";
import { CaptureFailure } from "./failure.js";

export async function acquireCaptureLock(path: string): Promise<() => Promise<void>> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    throw new CaptureFailure(
      "Another capture owns the host-local lock, or it needs manual recovery. Never steal by age.",
    );
  }
  let released = false;
  return async () => {
    if (!released) {
      await rmdir(path);
      released = true;
    }
  };
}
