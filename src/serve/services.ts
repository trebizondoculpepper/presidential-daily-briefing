/**
 * The services `pdb serve` builds once listening (doc/design/serve.md): one memory cache shared
 * by the JSON read API and HTTP MCP, and the status counters.
 */
import { collect, ghQueryWith, ghRest } from "../github/github.js";
import { dependencyReport } from "../github/dependencies.js";
import type { ServeExtensions, ServeRuntime } from "../serve.js";
import { readApi, selectRepository } from "./api.js";
import type { ServeReadRuntime } from "./api.js";
import { randomUUID } from "node:crypto";
import { ServeCache } from "./cache.js";
import { diagnosticViews, diagnosticsApi } from "./diagnostics.js";
import { httpMcp } from "./mcp.js";
import type { ServeOptions } from "./options.js";

/** Production read boundaries: authenticated gh through the existing argument-array runners. */
export const defaultReadRuntime = (serve: ServeRuntime): ServeReadRuntime => ({
  collect,
  dependencyReport,
  rest: ghRest,
  queryWith: ghQueryWith,
  now: () => serve.clock.now(),
  env: process.env,
});

/** The cache, read routes and status counters, built once the server is listening. */
export function readServices(
  options: ServeOptions,
  serve: ServeRuntime,
  read: ServeReadRuntime,
): ServeExtensions {
  return (facts) => {
    const cache = new ServeCache({
      ttlMs: options.ttlMs,
      clock: serve.clock,
      authContext: serve.authContext,
      initialAuth: facts.auth,
      // A different gh login (gh auth switch) cleared the cache; status shows the new one.
      onAuthChange: (auth) => (facts.auth = auth),
    });
    const api = readApi(options, read, cache)(facts);
    const mcp = httpMcp(options, facts, read, cache, serve.clock, serve.stderr);
    // Public, random per process: scopes diagnostic cursors; not a credential (#459).
    const diagnostics = diagnosticsApi(
      facts,
      () => cache.diagnostics(),
      (repo) => selectRepository(facts.served, repo).repository,
      randomUUID(),
      () => serve.clock.now(),
    );
    return {
      routes: async (context) => {
        if (context.url.pathname === "/mcp") {
          await mcp.handle(context);
          return true;
        }
        if (await diagnostics(context)) return true;
        return api(context);
      },
      status: {
        cache: () => ({
          ...cache.status(),
          mcpSessions: mcp.size,
          mcpSessionsInitializing: mcp.initializing,
        }),
        repositories: () => cache.repositories(),
        diagnostics: () => diagnosticViews.map((v) => `/api/v1/diagnostics/${v}`),
      },
      // Sessions first, then in-flight collections; dropping sessions never drops entries.
      close: async () => {
        await mcp.close();
        cache.close();
      },
    };
  };
}
