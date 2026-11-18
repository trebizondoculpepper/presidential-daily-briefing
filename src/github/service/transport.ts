/**
 * The internal GH transport (#869, doc/design/github-service-composition.md): one injectable
 * argument-array runner for `gh`. It runs the executable directly with no shell, with an explicit
 * context (cwd, timeout, output bound, cancellation), and reports what happened as a typed
 * outcome. It is infrastructure behind the typed capabilities, never the application-facing API.
 */

import { execFile } from "node:child_process";

export interface GhCall {
  /** Literal arguments after `gh`; never joined into a shell command. */
  args: readonly string[];
  cwd?: string;
  /** The environment gh runs with (GH_HOST, GH_TOKEN selection); the process's when omitted. */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload (e.g. for `--input -`); written without failing on EPIPE. */
  stdin?: string;
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
}

/** Bounded stderr kept for classification; never shown verbatim to application callers. */
const STDERR_LIMIT = 8 * 1024;

export type GhOutcome =
  | { ok: true; stdout: string }
  | {
      ok: false;
      /**
       * spawn: gh could not be started. exit: gh ran and exited non-zero (its output is kept for
       * classification). timeout: gh was stopped at the deadline. cancelled: the caller aborted.
       */
      kind: "spawn" | "exit" | "timeout" | "cancelled";
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

export type GhTransport = (call: GhCall) => Promise<GhOutcome>;

const text = (v: unknown): string =>
  typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : "";

/** Production transport over `execFile("gh", args)`. */
export const execFileTransport: GhTransport = (call) =>
  new Promise((resolve) => {
    if (call.signal?.aborted) {
      resolve({ ok: false, kind: "cancelled", exitCode: null, stdout: "", stderr: "" });
      return;
    }
    try {
      let outcome: GhOutcome = {
        ok: false,
        kind: "spawn",
        exitCode: null,
        stdout: "",
        stderr: "",
      };
      const child = execFile(
        "gh",
        [...call.args],
        {
          cwd: call.cwd,
          env: call.env,
          timeout: call.timeoutMs,
          maxBuffer: call.maxBufferBytes,
          signal: call.signal,
          killSignal: "SIGKILL",
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const out = text(stdout);
          const err = text(stderr).slice(0, STDERR_LIMIT);
          if (!error) {
            outcome = { ok: true, stdout: out };
            return;
          }
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          let kind: "spawn" | "exit" | "timeout" | "cancelled";
          if (call.signal?.aborted || e.name === "AbortError") kind = "cancelled";
          // Node's own ERR_* codes (an output bound exceeded) mean gh ran and was stopped.
          else if (typeof e.code === "string" && e.code.startsWith("ERR_")) kind = "exit";
          else if (typeof e.code === "string") kind = "spawn"; // ENOENT, EACCES: never started
          else if (e.killed) kind = "timeout";
          else kind = "exit";
          outcome = {
            ok: false,
            kind,
            exitCode: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: err,
          };
        },
      );
      // Wait for `close` so a timed-out or cancelled child is killed (SIGKILL) and reaped before settling.
      child.once("close", () => resolve(outcome));
      if (call.stdin !== undefined && child.stdin) {
        child.stdin.on("error", () => {
          // EPIPE/ECONNRESET: gh exited without reading; the exit outcome decides refused vs unknown.
        });
        child.stdin.end(call.stdin);
      }
    } catch {
      resolve({ ok: false, kind: "spawn", exitCode: null, stdout: "", stderr: "" });
    }
  });
