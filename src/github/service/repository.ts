/**
 * The repository of a checkout (#869): the `repos.fromCheckout` capability's implementation. It
 * depends only on the transport, so both the typed service and `currentRepository` in
 * github.ts can use it without an import cycle.
 */

import type { GhOutcome, GhTransport } from "./transport.js";

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** Throw the caller's abort reason when the outcome was a cancellation. */
export function throwIfCancelled(outcome: GhOutcome, signal?: AbortSignal): void {
  if (!outcome.ok && outcome.kind === "cancelled") {
    signal?.throwIfAborted();
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

/**
 * The `owner/name` gh resolves for a checkout: a local step (gh reads the checkout's remotes and
 * its own configuration) then a repository lookup, not a single API call.
 */
export async function repositoryFromCheckout(
  transport: GhTransport,
  cwd?: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const outcome = await transport({
    args: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    cwd,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 64 * 1024,
    signal,
  });
  throwIfCancelled(outcome, signal);
  const repository = outcome.ok ? outcome.stdout.trim() : "";
  if (!outcome.ok || !REPOSITORY.test(repository))
    throw new Error(
      "Cannot resolve repository. Supply --repo owner/name and check gh authentication.",
    );
  return repository;
}
