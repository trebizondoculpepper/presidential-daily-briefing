/** Read transport capabilities; the shared service is live, HTTP MCP currently cannot force refresh. */
import { readBriefing } from "../briefing/service.js";
import type { ReadRuntime } from "../briefing/service.js";
import type { Transport } from "./core.js";

export function serviceTransport(runtime: ReadRuntime): Transport {
  return {
    freshRead: true,
    read: async (input, signal) => {
      const result = await readBriefing(runtime, {
        repository: input.repository,
        agent: input.agent,
        platform: input.platform,
        role: input.role,
        limit: 10,
        maxChars: 7500,
        signal,
      });
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
