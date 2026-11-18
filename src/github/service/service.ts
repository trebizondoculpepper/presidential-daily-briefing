/**
 * The typed GH service (#869, doc/design/github-service-composition.md): application callers
 * use named capabilities with validated results instead of gh argument arrays or raw JSON.
 * Built by a factory over the injectable transport; no process-global repository, account or
 * agent. Initial capabilities: the authenticated account and the repository of a checkout. The
 * remaining capability groups arrive with their migration tickets (#878-#891).
 */

import { ghQueryFailure, ghRest, permissionLookup } from "../github.js";
import type { PermissionLookup, Rest } from "../github.js";
import { execFileTransport } from "./transport.js";
import type { GhTransport } from "./transport.js";
import { repositoryFromCheckout, throwIfCancelled } from "./repository.js";

export interface GhAccount {
  host: string;
  login: string;
}

export interface GhService {
  account: {
    /** The authenticated gh account (host and login only, never a token): `GET /user`. */
    current(signal?: AbortSignal): Promise<GhAccount>;
  };
  repos: {
    /**
     * The `owner/name` gh resolves for a checkout. A local step (gh reads the checkout's remotes
     * and its own configuration) followed by a repository lookup, not a single API call.
     */
    fromCheckout(cwd?: string, signal?: AbortSignal): Promise<string>;
    /**
     * A cached lookup of a login's permission on the repository:
     * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Unknown, never guessed.
     */
    permissionOf(repository: string, signal?: AbortSignal): PermissionLookup;
  };
}

export interface GhServiceOptions {
  transport?: GhTransport;
  /** The environment gh itself reads (GH_HOST selects the host); injected for isolation. */
  env?: NodeJS.ProcessEnv;
  /** The REST reader behind REST capabilities (production: ghRest); injected for tests and serve. */
  rest?: Rest;
}

const LOGIN = /^[\w.-]+$/;

export function createGhService(options: GhServiceOptions = {}): GhService {
  const transport = options.transport ?? execFileTransport;
  const env = options.env ?? process.env;
  const rest = options.rest ?? ghRest;
  return {
    account: {
      async current(signal) {
        const outcome = await transport({
          args: ["api", "user"],
          // gh runs with the same environment that names the host below, so the account
          // queried and the host reported can never disagree.
          env,
          timeoutMs: 30_000,
          maxBufferBytes: 1024 * 1024,
          signal,
        });
        throwIfCancelled(outcome, signal);
        if (!outcome.ok)
          // Typed as before: authentication, rate limit, or a generic failure. The existing
          // classifier reads the same code/stdout/stderr an execFile error carried.
          throw ghQueryFailure({
            code: outcome.exitCode,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
          });
        let login: unknown;
        try {
          login = (JSON.parse(outcome.stdout) as { login?: unknown }).login;
        } catch {
          throw new Error("gh api user returned an unreadable response.");
        }
        if (typeof login !== "string" || !LOGIN.test(login))
          throw new Error("gh api user returned no login.");
        // GH_HOST selects the host gh talks to; without it gh uses github.com.
        const host = env.GH_HOST?.trim() || "github.com";
        return { host, login };
      },
    },
    repos: {
      fromCheckout(cwd, signal) {
        return repositoryFromCheckout(transport, cwd, signal, env);
      },
      permissionOf(repository, signal) {
        return permissionLookup(repository, rest, signal);
      },
    },
  };
}

/** The process's default service over the production transport and environment. */
export const ghService: GhService = createGhService();
