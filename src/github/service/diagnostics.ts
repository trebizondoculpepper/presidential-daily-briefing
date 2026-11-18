/**
 * Typed GitHub CLI diagnostic capabilities (#891, doc/design/github-service-composition.md).
 *
 * Local `gh --version` and `gh auth status` probes remain non-API operations inside the service
 * adapter, preserving exit-code-only evidence without exposing raw CLI output.
 */
import type { GhTransport } from "./transport.js";
import { throwIfCancelled } from "./repository.js";

export interface GhDiagnostics {
  /** Check whether `gh` is installed and runnable (`gh --version`); exitCode is null when missing/failed to start. */
  version(
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; timedOut?: boolean }>;
  /** Check whether `gh` has an active login for `hostname` (`gh auth status`); exitCode is null when unable to run. */
  authStatus(
    hostname: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; timedOut?: boolean }>;
}

const DIAGNOSTIC_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_MAX_BYTES = 1024 * 1024;

/** Build typed GH diagnostic capabilities over a GH transport and environment. */
export function ghDiagnostics(transport: GhTransport, env?: NodeJS.ProcessEnv): GhDiagnostics {
  const run = async (
    args: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; timedOut?: boolean }> => {
    signal?.throwIfAborted();
    const outcome = await transport({
      args,
      cwd,
      env,
      timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
      maxBufferBytes: DIAGNOSTIC_MAX_BYTES,
      signal,
    });
    signal?.throwIfAborted();
    throwIfCancelled(outcome, signal);
    return {
      exitCode: outcome.ok ? 0 : outcome.kind === "exit" ? outcome.exitCode : null,
      ...(!outcome.ok && outcome.kind === "timeout" ? { timedOut: true } : {}),
    };
  };
  return {
    version: (cwd, signal) => run(["--version"], cwd, signal),
    authStatus: (hostname, cwd, signal) =>
      run(["auth", "status", "--active", "--hostname", hostname], cwd, signal),
  };
}
