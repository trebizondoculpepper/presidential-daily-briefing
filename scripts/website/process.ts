import { CaptureFailure } from "./failure.js";
import { spawn } from "node:child_process";

export interface ProcessRequest {
  file: string;
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunProcess = (request: ProcessRequest) => Promise<ProcessResult>;

/** Never interpolate a shell or expose raw child errors. Kill the owned POSIX process group. */
export const runProcess: RunProcess = async (request) => {
  request.signal?.throwIfAborted();
  if (request.timeoutMs < 1 || request.timeoutMs > 120_000)
    throw new CaptureFailure("Invalid process deadline.");
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.file, [...request.argv], {
      cwd: request.cwd,
      env: request.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      failure: string | undefined;
    const stop = (why: string): void => {
      failure ??= why;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* A process may have exited between observation and cancellation. */
      }
    };
    const accept = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > (request.maxBytes ?? 2 * 1024 * 1024))
        stop("Capture process output limit exceeded.");
      else if (!failure) target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => accept(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => accept(stderr, chunk));
    const abort = (): void => stop("Capture process cancelled.");
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Capture process timed out."), request.timeoutMs);
    child.once("error", () => {
      failure = "Capture process could not start.";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (failure) reject(new CaptureFailure(failure));
      else
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    if (request.signal?.aborted) abort();
  });
};
