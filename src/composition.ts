/**
 * Shared application composition (#870, doc/design/github-service-composition.md, #898): one
 * typed Git service and one typed GH service per application lifetime. Construction is pure: no
 * process is spawned and no request is made until a method is called, so CLI, MCP and serve
 * entrypoints can all use it without starting a listener or creating serve-only state.
 */
import { createGitService } from "./git/service.js";
import type { GitService, GitServiceOptions } from "./git/service.js";
import { createGhService, ghService } from "./github/service/service.js";
import type { GhService, GhServiceOptions } from "./github/service/service.js";

/** The shared facades an entrypoint injects into its services. */
export interface AppServices {
  readonly git: GitService;
  readonly gh: GhService;
}

/**
 * Build the application's shared facades. Without options the production GH service instance is
 * reused (it already owns the process's one transport); options build isolated instances, for
 * tests and alternative hosts.
 */
export function createAppServices(
  options: { git?: GitServiceOptions; gh?: GhServiceOptions } = {},
): AppServices {
  return {
    git: createGitService(options.git ?? {}),
    gh: options.gh ? createGhService(options.gh) : ghService,
  };
}
