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
import { HttpFailure } from "./http.js";
import { diagnosticViews, diagnosticsApi } from "./diagnostics.js";
import type { RulesDiagnostic, SettingDiagnostic } from "./diagnostics.js";
import { DEFAULT_PORT, DEFAULT_TTL_MS, STALE_WINDOW_MS } from "./options.js";
import { MAX_ENTRIES } from "./cache.js";
import { defaultEngine } from "../config/engine-setting.js";
import { briefingRoleNames } from "../briefing/roles.js";
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
    const diagnostics = diagnosticsApi({
      facts,
      held: () => cache.diagnostics(),
      select: (repo) => {
        try {
          return selectRepository(facts.served, repo).repository;
        } catch (error) {
          // Same status, code and choices, but diagnostics never echo the supplied value (#459).
          if (error instanceof HttpFailure)
            throw new HttpFailure(
              error.status,
              error.code,
              error.code === "REPOSITORY_NOT_SERVED"
                ? "That repository is not served by this server."
                : error.code === "INVALID_ARGUMENT"
                  ? "repo must be owner/name."
                  : error.message,
              error.next,
              error.headers,
            );
          throw error;
        }
      },
      config: (repository) => serveSettings(options, facts.served, repository),
      rules: rulesIdentity,
      instanceId: randomUUID(),
      now: () => serve.clock.now(),
    });
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

/**
 * Allowlisted effective settings for one served repository (#459 "Config"). Server settings
 * are held; repository-local ones are read per request from a project, so they are reported
 * as unknown there, or as the applicable defaults when the repository has no local project.
 */
function serveSettings(
  options: ServeOptions,
  served: readonly { repository: string; project?: string }[],
  repository: string,
): { settings: Record<string, SettingDiagnostic>; warnings: string[] } {
  const held = (value: number, fallback: number): SettingDiagnostic => ({
    value,
    source: value === fallback ? "default" : "argument",
    known: true,
  });
  const local = served.find((s) => s.repository === repository)?.project !== undefined;
  const repositorySetting = (fallback: string | boolean): SettingDiagnostic =>
    local
      ? { value: null, source: "unknown", known: false }
      : { value: fallback, source: "default", known: true };
  return {
    settings: {
      "serve.port": held(options.port, DEFAULT_PORT),
      "serve.ttlSeconds": held(options.ttlMs / 1000, DEFAULT_TTL_MS / 1000),
      "serve.staleWindowSeconds": { value: STALE_WINDOW_MS / 1000, source: "default", known: true },
      "serve.cacheEntries": { value: MAX_ENTRIES, source: "default", known: true },
      "briefing.engine": repositorySetting(defaultEngine()),
      processGuide: repositorySetting(false),
      "complexity.enabled": repositorySetting(true),
      "impact.enabled": repositorySetting(true),
    },
    warnings: local
      ? ["Repository settings are read from the project for each request and are not held here."]
      : ["No local project: repository-local settings were not read; defaults are shown."],
  };
}

/**
 * The bundled policy's identity, from the same lazily loaded evaluator chunk briefings use (so
 * the main bundle stays unchanged); nothing is evaluated.
 */
async function rulesIdentity(): Promise<RulesDiagnostic> {
  const { rulesHash, policyVersion } = await import("../rules/datalog/datalog.js");
  return {
    configuredEngine: defaultEngine(),
    policyVersion,
    rulesHash,
    supportedRoles: briefingRoleNames(),
    validation: {
      state: "build-checked",
      detail:
        "Validated by npm run rules:build --check before packaging; the server does not re-run it.",
    },
    englishRules: { cli: "pdb rules", page: null },
  };
}
