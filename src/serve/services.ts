import { serverHumanContext, humanContextEnabled } from "../config/humancontext.js";
/**
 * The services `pdb serve` builds once listening (doc/design/serve.md): one memory cache shared
 * by the JSON read API and HTTP MCP, and the status counters.
 */
import { collect, ghQueryWith, ghRest } from "../github/github.js";
import { collectShortlist } from "../github/shortlist.js";
import { dependencyReport } from "../github/dependencies.js";
import type { ServeExtensions, ServeRuntime } from "./types.js";
import { readApi, selectRepository } from "./api.js";
import type { ServeReadRuntime } from "./api.js";
import { randomUUID } from "node:crypto";
import { ServeCache } from "./cache.js";
import { HttpFailure } from "./http.js";
import { diagnosticRunServices } from "./diagnostic-runs.js";
import { diagnosticViews, diagnosticsApi } from "./diagnostics.js";
import type { RulesDiagnostic, SettingDiagnostic } from "./diagnostics.js";
import { STALE_WINDOW_MS } from "./options.js";
import { MAX_ENTRIES } from "./cache.js";
import { defaultEngine } from "../config/engine-setting.js";
import { briefingRoleNames } from "../briefing/roles.js";
import { httpMcp } from "./mcp.js";
import { QuotaService } from "../github/quotas.js";
import { createGhService } from "../github/service/service.js";
import { quotasApi } from "./quotas-page.js";
import type { ServeOptions } from "./options.js";
import { applyLiveApplication } from "./liveapp.js";
import { verifySavedRoot } from "./registration.js";

/** Production read boundaries: authenticated gh through the existing argument-array runners. */
export const defaultReadRuntime = (serve: ServeRuntime): ServeReadRuntime => ({
  collect,
  collectShortlist,
  dependencyReport,
  rest: ghRest,
  queryWith: ghQueryWith,
  now: () => serve.clock.now(),
  env: process.env,
  // The serve composition's shared Git service for read-time identity (#934, #870).
  ...(serve.git ? { git: serve.git } : {}),
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
      onAuthObservation: (observation) => {
        if (!humanContextEnabled()) return;
        if (observation.state === "verified") {
          facts.effectiveHuman = {
            context: serverHumanContext(observation.auth, observation.observedAt),
            authenticationFailed: false,
          };
        } else if (observation.state === "refused" || facts.effectiveHuman?.authenticationFailed) {
          facts.effectiveHuman = {
            context: {
              state: "unresolved",
              host: facts.auth.host,
              login: null,
              source: "none",
              reason:
                "The gh login was refused and has not been verified again; run gh auth status.",
            },
            authenticationFailed: true,
          };
        } else {
          const previous =
            facts.effectiveHuman?.context ?? serverHumanContext(facts.auth, facts.startedAt);
          facts.effectiveHuman = {
            context:
              previous.state === "unresolved"
                ? previous
                : {
                    ...previous,
                    state: "last-known",
                    reason:
                      "The current gh account is unavailable; reporting previously verified server context.",
                  },
            authenticationFailed: false,
          };
        }
      },
    });
    const api = readApi(options, read, cache)(facts);
    // One typed GH service per server (#939) over its REST boundary; construction reads nothing.
    const gh = createGhService({
      rest:
        read.rest ??
        (async () => {
          throw new Error("no REST boundary");
        }),
      now: () => serve.clock.now(),
    });
    // #548: one quota service per server for its verified gh login; nothing runs until asked.
    const quotas = quotasApi(
      new QuotaService({
        // The typed rate-limit capability (#923, #939) over this server's REST boundary.
        rateLimits: (signal) => gh.account.rateLimits(signal),
        now: () => serve.clock.now(),
        telemetry: (context) => cache.quotaTelemetry(context),
      }),
      async (mode) => {
        // Offline makes no request, not even an identity read: the held login only.
        if (mode === "offline")
          return {
            context: { host: facts.auth.host, login: facts.auth.login },
            contextRequests: 0,
          };
        // A refresh re-reads the gh login first; an unreadable login is unverified (not reused).
        const { auth, read: identityRead } = await cache.verifiedAuth(mode === "refresh");
        return {
          context: auth
            ? { host: auth.host, login: auth.login }
            : { host: facts.auth.host, login: null },
          contextRequests: identityRead ? 1 : 0,
        };
      },
    );
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
      rules: (repository) =>
        rulesIdentity(
          serveSettings(options, facts.served, repository),
          facts.served.find((s) => s.repository === repository)?.project !== undefined,
        ),
      instanceId: randomUUID(),
      now: () => serve.clock.now(),
    });
    const activeDiagnostics = diagnosticRunServices(facts, serve, read, cache);
    return {
      routes: async (context) => {
        if (context.url.pathname === "/mcp") {
          await mcp.handle(context);
          return true;
        }
        if (await diagnostics(context)) return true;
        if (await activeDiagnostics.routes(context)) return true;
        if (await quotas(context)) return true;
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
      live: serve.globalConfig
        ? {
            apply: (saved) => {
              // #816: observe the fresh saved snapshot before recording its application, so
              // the acknowledgement is accepted for the observed revision and the view reports
              // the applied values and revision instead of the startup ones.
              facts.applicationState?.observe(saved);
              return applyLiveApplication(saved, {
                currentServed: () => facts.served,
                // Bump the repository epoch and drop its entries so reads started before the
                // change cannot insert as fresh facts.
                invalidate: (repository) => cache.refresh(repository),
                // Conservative cross-repository invalidation: cache.read drops the collector
                // `deps` entries of this repository (see #808 doc).
                invalidateDependencies: (repository) => cache.refresh(repository, ["deps"]),
                // The verified-checkout boundary registration reuses: a moved or reassigned
                // saved root serves the repository repo-only, exactly as at startup.
                ...(serve.git || serve.currentRepository
                  ? {
                      verifyProject: (repository, localRoot) =>
                        verifySavedRoot(repository, localRoot, {
                          cwd: serve.cwd,
                          git: serve.git,
                          currentRepository: serve.currentRepository,
                          globalConfig: serve.globalConfig,
                        }),
                    }
                  : {}),
                // #816: record live-key application against the observed saved snapshot.
                ...(facts.applicationState
                  ? {
                      record: (result) => facts.applicationState!.recordApplication(result),
                    }
                  : {}),
              });
            },
          }
        : undefined,
      // Sessions first, then in-flight collections; dropping sessions never drops entries.
      close: async () => {
        activeDiagnostics.close();
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
  // The source is whether the argument was given, not whether its value equals the default.
  const held = (value: number, given: boolean | undefined): SettingDiagnostic => ({
    value,
    source: given ? "argument" : "default",
    known: true,
  });
  const local = served.find((s) => s.repository === repository)?.project !== undefined;
  const repositorySetting = (fallback: string | boolean): SettingDiagnostic =>
    local
      ? { value: null, source: "unknown", known: false }
      : { value: fallback, source: "default", known: true };
  return {
    settings: {
      "serve.port": held(options.port, options.given?.port),
      "serve.ttlSeconds": held(options.ttlMs / 1000, options.given?.ttl),
      "serve.staleWindowSeconds": { value: STALE_WINDOW_MS / 1000, source: "default", known: true },
      "serve.cacheEntries": { value: MAX_ENTRIES, source: "default", known: true },
      "briefing.engine": repositorySetting(defaultEngine()),
      processGuide: repositorySetting(false),
      "complexity.enabled": repositorySetting(true),
      "impact.enabled": repositorySetting(true),
      // #516: without the checkout, whether project rules are enabled is not known, never false.
      "rules.project.enabled": { value: null, source: "unknown", known: false },
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
async function rulesIdentity(
  config: ReturnType<typeof serveSettings>,
  local: boolean,
): Promise<{ rules: RulesDiagnostic; warnings: string[] }> {
  const { rulesHash, policyVersion } = await import("../rules/datalog/datalog.js");
  const engine = config.settings["briefing.engine"]!;
  const rules: RulesDiagnostic = {
    // The same effective setting the config view reports: the repository's engine when held,
    // never the default passed off as a project's configuration.
    configuredEngine: engine,
    policyVersion,
    rulesHash,
    supportedRoles: briefingRoleNames(),
    validation: {
      state: "build-checked",
      detail:
        "Validated by npm run rules:build --check before packaging; the server does not re-run it.",
    },
    englishRules: { cli: "pdb rules", page: "/rules" },
    // #516: project preferences are read from the checkout for each briefing, never held here.
    projectPolicy: local
      ? {
          state: "per-request",
          detail:
            "Read from the project's configuration and pdb.rules.edn for each briefing; the /rules page and each briefing's decisionEngine.effectivePolicy show the effective revision.",
        }
      : {
          state: "unknown",
          detail:
            "Served without a local project (--repo only): whether project preferences are enabled cannot be read; briefings report effectivePolicy state unavailable. Serve it with --project.",
        },
  };
  return { rules, warnings: engine.known ? [] : config.warnings };
}
