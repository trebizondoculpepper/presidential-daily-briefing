/**
 * The authenticated gh account (host and login only, never a token): one bounded `gh api user`
 * through the argument-array runner. Shared by `pdb serve` (its authentication context), `pdb
 * quotas` and the employing-human resolver (#664). Moved from serve.ts unchanged.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghQueryFailure } from "./github.js";

const execute = promisify(execFile);

export async function ghAuthContext(
  signal?: AbortSignal,
): Promise<{ host: string; login: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execute("gh", ["api", "user"], { timeout: 30_000, signal }));
  } catch (error) {
    signal?.throwIfAborted();
    // Typed: an authentication failure, a rate limit, or anything else (outage, timeout, 5xx).
    throw ghQueryFailure(error);
  }
  const login: unknown = (JSON.parse(stdout) as { login?: unknown }).login;
  if (typeof login !== "string" || !/^[\w.-]+$/.test(login))
    throw new Error("gh api user returned no login.");
  // GH_HOST selects the host gh talks to; without it gh uses github.com.
  const host = process.env.GH_HOST?.trim() || "github.com";
  return { host, login };
}
