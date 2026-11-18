/** Read transport capabilities; the shared service is live, HTTP MCP currently cannot force refresh. */
import { readBriefing } from "../briefing/service.js";
import type { ReadRuntime } from "../briefing/service.js";
import type { Transport } from "./core.js";
import { createGitService } from "../git/service.js";
import type { GitRunner } from "../config/config.js";
import type { GitContext, GitService } from "../git/service.js";

const bindGitServiceSignal = (svc: GitService, signal: AbortSignal): GitService => {
  const withSignal = (ctx: GitContext): GitContext => {
    signal.throwIfAborted();
    return { ...ctx, signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal };
  };
  return {
    workingTreeRoot: (ctx) => svc.workingTreeRoot(withSignal(ctx)),
    commonDirectory: (ctx) => svc.commonDirectory(withSignal(ctx)),
    remotes: (ctx) => svc.remotes(withSignal(ctx)),
    checkout: (ctx) => svc.checkout(withSignal(ctx)),
    revision: (ctx) => svc.revision(withSignal(ctx)),
    headRef: (ctx) => svc.headRef(withSignal(ctx)),
    isAncestor: (ctx, ancestor, descendant) =>
      svc.isAncestor(withSignal(ctx), ancestor, descendant),
    divergence: (ctx, left, right) => svc.divergence(withSignal(ctx), left, right),
    isIgnored: (ctx, path) => svc.isIgnored(withSignal(ctx), path),
    isTracked: (ctx, path) => svc.isTracked(withSignal(ctx), path),
    gitPath: (ctx, path) => svc.gitPath(withSignal(ctx), path),
  };
};

export function serviceTransport(runtime: ReadRuntime): Transport {
  return {
    freshRead: true,
    read: async (input, signal) => {
      const bind = <T extends { git?: GitService | GitRunner }>(
        readers: T | undefined,
      ): T | undefined => {
        if (!readers) return readers;
        // A reader's own typed service (the guide's gitService) gets this read's signal too.
        const own = (readers as { gitService?: GitService }).gitService;
        const typed = own ? { gitService: bindGitServiceSignal(own, signal) } : {};
        if (typeof readers.git === "object")
          return { ...readers, ...typed, git: bindGitServiceSignal(readers.git, signal) };
        // Nothing injected: the typed Git service's isolated default, never the raw runner (#933).
        if (readers.git === undefined)
          return {
            ...readers,
            ...typed,
            git: bindGitServiceSignal(own ?? createGitService(), signal),
          };
        const runner = readers.git;
        const git: GitRunner = (args, cwd) => {
          signal.throwIfAborted();
          return runner(args, cwd, signal);
        };
        return { ...readers, ...typed, git };
      };
      const result = await readBriefing(
        { ...runtime, guide: bind(runtime.guide), estimation: bind(runtime.estimation) },
        {
          repository: input.repository,
          agent: input.agent,
          platform: input.platform,
          role: input.role,
          limit: 10,
          maxChars: 7500,
          signal,
        },
      );
      if (result.kind !== "report") throw new Error("briefing-unavailable");
      return {
        selection: {
          repository: input.repository,
          agent: input.agent,
          platform: input.platform,
          role: input.role,
        },
        fresh: true,
        report: result.report,
        text: result.text,
      };
    },
  };
}
/** No HTTP MCP tool currently advertises a force-refresh argument or platform selection.
 * Refuse before any request; an ordinary cached call is not a fresh role/platform read. */
export const httpMcpTransport: Transport = {
  freshRead: false,
  read: async () => {
    throw new Error("fresh-read-unsupported");
  },
};
