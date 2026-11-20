import { projectSelectionScript } from "./serve/project-selection.js";
import {
  captureProcessIdentity,
  readPackageBuildIdentity,
  withProcessIdentity,
} from "./serve/process-footer.js";
import { disabledEffectiveHuman } from "./config/effectiveidentity.js";
import { startLocalIdentity } from "./config/serveridentity.js";
import { humanContextEnabled, serverHumanContext } from "./config/humancontext.js";
import { servedPages, shellContext, selectionErrorPage } from "./serve/shell.js";
/**
 * `pdb serve`: a foreground local HTTP server (doc/design/serve.md, #373).
 *
 * This module owns the lifecycle: startup selection and authentication context, the
 * `node:http` listener with its DNS-rebinding guard, the banner, signal handling and graceful
 * shutdown. Every outside boundary (gh, clock, output, signals, exit) is injected so tests run
 * on an ephemeral port without GitHub.
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { AuthenticationError } from "./github/github.js";
import { createAppServices } from "./composition.js";
import type { AppServices } from "./composition.js";
import { gitServiceOf } from "./config/identity.js";
import { systemClock } from "./mcp/polling.js";
import { installedVersion } from "./updates/updates.js";
import { defaultReadRuntime, readServices } from "./serve/services.js";
import { selectRepository } from "./serve/api.js";
import {
  allowedHostnames,
  errorDocument,
  guardRequest,
  HttpFailure,
  sendJson,
} from "./serve/http.js";
import {
  EXIT_FORCED,
  EXIT_PORT,
  EXIT_USAGE,
  HEADERS_TIMEOUT_MS,
  isLoopback,
  serveArguments,
  serveHelp,
  ServeUsageError,
  SHUTDOWN_GRACE_MS,
} from "./serve/options.js";
import type { ServeOptions } from "./serve/options.js";
import { RegistrationError, resolveServeProjects } from "./serve/registration.js";
import {
  globalConfigDirectory,
  loadGlobalConfig,
  type GlobalValue,
  type LoadedGlobalConfig,
} from "./config/globalconfig.js";
import { createApplicationState } from "./serve/appstate.js";
import type {
  AuthContext,
  RequestContext,
  Routes,
  RunningServer,
  ServedRepository,
  ServeExtensions,
  ServeRuntime,
  ServerFacts,
  StatusSource,
} from "./serve/types.js";
import { defaultRulesPageRuntime, readRules, rulesBootstrapHtml } from "./serve/rules-page.js";
import { readWebAssets } from "./serve/webassets.js";
import { pipelineAssets, pipelineBootstrapHtml } from "./serve/pipeline-page.js";
import { workPreviewAssets, workPreviewBootstrapHtml } from "./serve/work-preview-page.js";
import { timingAssets, timingBootstrapHtml } from "./serve/timing-page.js";
import { overviewAssets, overviewBootstrapHtml } from "./serve/overview-page.js";
import { discussionAssets, discussionBootstrapHtml } from "./serve/discussion-page.js";
import type { LiveApplicationResult } from "./serve/liveapp.js";
import { setupPage, setupScript } from "./serve/setup-page.js";
import {
  dashboardCss,
  dashboardPage,
  dashboardScript,
  dashboardSecurityPolicy,
} from "./serve/dashboard.js";
import { ticketPage, ticketScript } from "./serve/ticket-page.js";
import { humanPage, humanScript } from "./serve/human-page.js";
import { activityPage, activityScript } from "./serve/activity-page.js";
import { diagnosticsPage, diagnosticsScript } from "./serve/diagnostics-page.js";
import { quotasPage, quotasScript } from "./serve/quotas-page.js";

export { serveHelp } from "./serve/options.js";

// The shared serve interfaces live in serve/types.ts (#445); re-exported for existing importers.
export type {
  AuthContext,
  RequestContext,
  Routes,
  RunningServer,
  ServedRepository,
  ServeExtensions,
  ServeRuntime,
  ServerFacts,
  ServeServices,
  SignalSource,
  StatusSource,
} from "./serve/types.js";

// Production authentication context: `gh api user`, shared with the human resolver (#664).
import { ghAuthContext } from "./github/ghauth.js";
export { ghAuthContext };

/**
 * The production serve runtime over one shared application composition (#870): the same typed
 * Git service serves identity, project resolution and registration, and the same GH service the
 * checkout repository and authenticated account. Nothing is read until startup asks.
 */
export const defaultServeRuntime = (services: AppServices = createAppServices()): ServeRuntime => ({
  ...(!process.env.PDB_NO_EFFECTIVE_IDENTITY
    ? { identityRuntime: { env: process.env, git: services.git } }
    : {}),
  cwd: process.cwd(),
  git: services.git,
  globalConfig: { dir: globalConfigDirectory() },
  currentRepository: (cwd, signal) => services.gh.repos.fromCheckout(cwd, signal),
  authContext: (signal) => services.gh.account.current(signal),
  clock: systemClock,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signals: process,
  exit: (code) => process.exit(code),
  version: async () => (await installedVersion()).version,
  buildIdentity: readPackageBuildIdentity,
  platform: process.platform,
});

/** The `--ttl` text for the application-state override, from the accepted milliseconds. */
const ttlText = (ttlMs: number): string =>
  ttlMs % 60_000 === 0 ? `${ttlMs / 60_000}m` : `${ttlMs / 1000}s`;

/** A startup failure with its exit status (2 usage, 3 port, 1 otherwise). */
export class ServeStartupError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

const emptyStatus: StatusSource = {
  cache: () => ({
    entries: 0,
    approxBytes: 0,
    hits: 0,
    misses: 0,
    coalesced: 0,
    evictions: 0,
    inflight: 0,
  }),
  repositories: () => ({}),
};

/** Resolve the served set: every --repo, then each --project's repository, deduplicated. */
async function servedSet(
  options: ServeOptions,
  runtime: ServeRuntime,
): Promise<ServedRepository[]> {
  // With a verified global configuration boundary, the served set is saved registrations,
  // explicit targets and the working directory's repository (#805). Without one — every test
  // that does not opt in — only the explicit targets are used, exactly as before.
  if (runtime.globalConfig) {
    try {
      const resolution = await resolveServeProjects(options, runtime);
      for (const line of resolution.diagnostics) runtime.stderr(`pdb serve: ${line}\n`);
      return [...resolution.served];
    } catch (error) {
      if (error instanceof RegistrationError)
        throw new ServeStartupError(error.exitCode, error.message);
      throw error;
    }
  }
  const served = new Map<string, ServedRepository>();
  for (const repository of options.repos)
    if (!served.has(repository.toLowerCase())) served.set(repository.toLowerCase(), { repository });
  for (const project of options.projects) {
    let resolvedProject = project;
    if (runtime.git) {
      let root = "";
      try {
        // The typed Git service (#870): null outside a checkout.
        root = (await gitServiceOf(runtime.git).workingTreeRoot({ cwd: project })) ?? "";
      } catch {
        root = "";
      }
      if (!root)
        throw new ServeStartupError(
          EXIT_USAGE,
          `${project} is not inside a Git checkout. Run from or pass --project pointing to a local Git checkout.`,
        );
      resolvedProject = root;
    }
    let repository: string;
    try {
      repository = (await runtime.currentRepository(resolvedProject)).trim();
    } catch {
      throw new ServeStartupError(
        EXIT_USAGE,
        `--project ${resolvedProject} does not resolve to a GitHub repository; check the path and gh authentication.`,
      );
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new ServeStartupError(
        EXIT_USAGE,
        `--project ${resolvedProject} does not resolve to a GitHub repository.`,
      );
    const existing = served.get(repository.toLowerCase());
    if (existing?.project && existing.project !== resolvedProject)
      throw new ServeStartupError(
        EXIT_USAGE,
        `--project ${resolvedProject} and --project ${existing.project} are both ${repository}; pass one.`,
      );
    served.set(repository.toLowerCase(), {
      repository: existing?.repository ?? repository,
      project: resolvedProject,
    });
  }
  // Without a configuration boundary there is nothing else to serve (#805), so an empty set is
  // still a usage error rather than a server with no repository.
  if (!served.size)
    throw new ServeStartupError(EXIT_USAGE, "pdb serve needs --repo owner/name or --project PATH");
  return [...served.values()];
}

const urlHost = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);

/** The dashboard (#374): three same-origin static responses, built once per server. */
const dashboardFiles = (): Map<string, { type: string; body: string }> =>
  new Map([
    [
      "/project-selection.js",
      { type: "text/javascript; charset=utf-8", body: projectSelectionScript() },
    ],
    ["/dashboard.css", { type: "text/css; charset=utf-8", body: dashboardCss }],
    ["/dashboard.js", { type: "text/javascript; charset=utf-8", body: dashboardScript() }],
    // The consolidated ticket detail (#454): another static page under the same policy.
    ["/ticket.js", { type: "text/javascript; charset=utf-8", body: ticketScript() }],
    // Copy buttons of the agent setup page (#391); the page works without it.
    ["/setup.js", { type: "text/javascript; charset=utf-8", body: setupScript() }],
    // The human attention view (#458): its page is rendered per request, its script is static.
    ["/human.js", { type: "text/javascript; charset=utf-8", body: humanScript() }],
    // The read-only Activity view (#456): its page is rendered per request, its script is static.
    ["/activity.js", { type: "text/javascript; charset=utf-8", body: activityScript() }],
    // The account-scoped quota meters (#548): the page reads nothing until Refresh.
    ["/quotas.js", { type: "text/javascript; charset=utf-8", body: quotasScript() }],
    ["/diagnostics.js", { type: "text/javascript; charset=utf-8", body: diagnosticsScript() }],
  ]);

/**
 * Start the server: resolve selection and authentication, bind, and return the running
 * server. No GitHub data is collected at startup.
 */
export async function startServe(
  options: ServeOptions,
  runtime: ServeRuntime,
  extensions: ServeExtensions = () => ({}),
): Promise<RunningServer> {
  const served = await servedSet(options, runtime);
  let auth: AuthContext;
  try {
    auth = await runtime.authContext();
  } catch (error) {
    throw new ServeStartupError(
      1,
      error instanceof AuthenticationError
        ? "cannot read the GitHub login from gh; run gh auth login (check with gh auth status) and retry."
        : "cannot read the GitHub login from gh (GitHub or the network did not answer); check the connection and gh auth status, then retry.",
    );
  }
  // "localhost" binds the IPv4 loopback address only, so the URL is stable on every platform.
  const bindHost = options.host === "localhost" ? "127.0.0.1" : options.host;
  const lifecycle = new AbortController();
  let shutting = false;
  let status = emptyStatus;
  let routes: Routes = async () => false;
  let allowed: string[] = [];
  let port = 0;
  // Filled in once listening; routes are only reached after that.
  const facts: ServerFacts = {
    version: await runtime.version(),
    startedAt: runtime.clock.now(),
    url: "",
    exposed: !isLoopback(options.host),
    served,
    ttlMs: options.ttlMs,
    auth,
  };

  // #816: the one application-state service of this process, when a verified global
  // configuration boundary exists. Its startup snapshot is the configuration `serve` resolved
  // from (the same boundary registration uses). The applied snapshot reports what this process
  // actually runs for the launch-fixed settings (#459): the port and TTL always reflect the
  // effective CLI values (given or built-in default), not the saved ones — a saved `serve.port`
  // or `serve.ttl` that differs from the running value is reported as overridden, never wrongly
  // in-sync. Live application (#808) records into it.
  if (runtime.globalConfig) {
    try {
      const startup = await loadGlobalConfig(runtime.globalConfig.dir, runtime.globalConfig.fs);
      const overrides = new Map<string, GlobalValue>([
        ["serve.port", options.port],
        ["serve.ttl", ttlText(options.ttlMs)],
      ]);
      facts.applicationState = createApplicationState(startup, overrides, () =>
        runtime.clock.now(),
      );
    } catch {
      // An unreadable startup configuration leaves application state unset (absent live
      // application); the server itself still reports the refusal at first use (#804).
    }
  }
  // #808: bumped on every successful live application; the read path guards on it.
  facts.contextVersion = { value: 0 };
  facts.contextRevisions = new Map();

  let buildIdentity = {};
  try {
    buildIdentity = (await runtime.buildIdentity?.()) ?? {};
  } catch {
    // Optional provenance is unavailable; the running server still starts with honest unknowns.
  }
  const processIdentity = captureProcessIdentity(facts, buildIdentity);
  facts.effectiveHuman = humanContextEnabled()
    ? { context: serverHumanContext(auth, facts.startedAt), authenticationFailed: false }
    : disabledEffectiveHuman(auth.host);
  if (runtime.identityRuntime) {
    const localProjects = served.filter((entry) => entry.project !== undefined);
    const selected =
      localProjects.length === 1 ? localProjects[0] : served.length === 1 ? served[0] : undefined;
    facts.identitySession = await startLocalIdentity(
      {
        project: selected?.project,
        repository: selected?.repository,
        agent: options.agent,
        entry: options.entry,
        harness: options.harness,
        role: options.role,
      },
      { ...runtime.identityRuntime, human: async () => facts.effectiveHuman! },
    );
    const startup = facts.identitySession.startup;
    for (const notice of startup.setup.notices) runtime.stderr(`pdb serve startup: ${notice}\n`);
    if (startup.diagnostic)
      runtime.stderr(
        `pdb serve startup: ${startup.diagnostic.message} ${startup.diagnostic.recovery}\n`,
      );
  }

  const dashboard = dashboardFiles();
  // #853: the built frontend assets, read once from the packaged (or checkout) dist.
  for (const [path, asset] of await (runtime.webAssets ?? readWebAssets)())
    dashboard.set(path, asset);
  const statusDocument = () => ({
    schemaVersion: 1,
    kind: "serve-status",
    version: facts.version,
    build: {
      revision: processIdentity.revision,
      dirty: processIdentity.dirty,
      source: processIdentity.source,
    },
    publicIp: processIdentity.publicIp,
    startedAt: facts.startedAt.toISOString(),
    url: facts.url,
    exposed: facts.exposed,
    repositories: served.map((entry) => {
      const known = status.repositories()[entry.repository.toLowerCase()];
      return {
        repository: entry.repository,
        default: served.length === 1,
        localProject: entry.project !== undefined,
        observedAt: known?.observedAt ?? null,
        lastError: known?.lastError ?? null,
      };
    }),
    ttlSeconds: options.ttlMs / 1000,
    auth: { host: facts.auth.host, login: facts.auth.login },
    // Whose work this process does (#669): the execution human, its source and freshness;
    // separate from any agent name or role and from ticket assignees.
    human: humanContextEnabled()
      ? (facts.effectiveHuman?.context ?? serverHumanContext(facts.auth, facts.startedAt))
      : { state: "disabled" },
    ...(facts.identitySession
      ? {
          identityStartup: { phase: "local-server-startup", result: facts.identitySession.startup },
        }
      : {}),
    cache: status.cache(),
    ...(status.diagnostics ? { diagnostics: status.diagnostics() } : {}),
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = Date.now();
    const disconnected = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) disconnected.abort();
    });
    const context: RequestContext = {
      request,
      response,
      // Placeholder until the target is validated below.
      url: new URL("http://localhost/"),
      signal: AbortSignal.any([lifecycle.signal, disconnected.signal]),
    };
    let pathForLog = "(invalid)";
    response.on("finish", () =>
      // Path only: query values may carry local paths or agent names. Never headers.
      runtime.stderr(
        `${request.method ?? "?"} ${pathForLog} ${response.statusCode} ${context.source ?? "-"} ${Date.now() - started}ms\n`,
      ),
    );
    try {
      // Origin-form targets only: an absolute-form target ("GET http://evil/ HTTP/1.1") could
      // otherwise disagree with the Host header the guard checked.
      const target = request.url ?? "";
      if (!target.startsWith("/") || target.startsWith("//"))
        throw new HttpFailure(400, "INVALID_ARGUMENT", "Request target must be a path.");
      const guarded = guardRequest(request.headers, allowed, port);
      if (guarded) throw guarded;
      context.url = new URL(target, `http://${urlHost(bindHost)}:${port}`);
      pathForLog = context.url.pathname;
      const path = context.url.pathname;
      if (shutting) {
        sendJson(
          response,
          503,
          path === "/healthz"
            ? { ok: false }
            : errorDocument({
                code: "SHUTTING_DOWN",
                message: "pdb serve is shutting down.",
                next: [],
              }),
          { connection: "close" },
        );
        return;
      }
      const getOnly = (): void => {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
        if (context.url.search)
          throw new HttpFailure(400, "INVALID_ARGUMENT", `${path} takes no query parameters.`);
      };
      if (path === "/healthz") {
        getOnly();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/api/v1/status") {
        getOnly();
        sendJson(response, 200, statusDocument());
        return;
      }
      const registeredPage = servedPages.find((p) => p.shipped && p.path === path);
      const selectedPage = registeredPage
        ? shellContext(registeredPage.id, served, context.url.searchParams)
        : null;
      if (selectedPage) {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
        const selection = selectedPage.selection;
        if (
          selection.status !== 200 ||
          (registeredPage!.scope === "project" && !selection.repository)
        ) {
          response.writeHead(selection.status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy": dashboardSecurityPolicy,
          });
          response.end(
            request.method === "HEAD"
              ? undefined
              : withProcessIdentity(
                  selectionErrorPage(selectedPage),
                  processIdentity,
                  selectedPage,
                ),
          );
          return;
        }
        // Canonical spelling is used by renderers and all generated navigation.
        context.url.search = selection.query.toString();
        if (path === "/" || path === "/ticket") {
          const html = path === "/" ? dashboardPage(selectedPage) : ticketPage(selectedPage);
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy": dashboardSecurityPolicy,
          });
          response.end(
            request.method === "HEAD"
              ? undefined
              : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
          );
          return;
        }
      }
      const file = dashboard.get(path);
      if (file) {
        getOnly();
        response.writeHead(200, {
          "content-type": file.type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(request.method === "HEAD" ? undefined : file.body);
        return;
      }
      if (path === "/setup") {
        // The agent setup page (#391): local only, no GitHub request, nothing written.
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const page = setupPage(context.url.searchParams, facts.url, served, selectRepository);
        response.writeHead(page.status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(page.html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/api/v1/rules") {
        // #853: the shared rules read as versioned data; local only, no GitHub request.
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const read = await readRules(
          context.url.searchParams,
          served,
          runtime.rulesPage ?? defaultRulesPageRuntime(),
          selectRepository,
        );
        if (!read.ok) throw new HttpFailure(read.status, read.code, read.message);
        sendJson(response, 200, {
          schemaVersion: 1,
          kind: "rules",
          selected: read.selected,
          filters: read.filters,
          view: read.view,
        });
        return;
      }
      if (path === "/pipeline") {
        // Pipeline Health (#684): a static bootstrap after the shell's project selection check;
        // the component reads /api/v1/metrics?view=inventory. No GitHub read loading the page.
        const html = pipelineBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has(pipelineAssets.script) && dashboard.has(pipelineAssets.stylesheet),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/work-preview") {
        // Svelte Work preview (#753): a static bootstrap after the shell's project selection
        // check; the component reads /api/v1/briefing and /api/v1/tickets/N. No GitHub read here.
        const html = workPreviewBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has(workPreviewAssets.script) && dashboard.has(workPreviewAssets.stylesheet),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/timing") {
        // Timing (#820): a static bootstrap after the shell's project selection check; the
        // component reads /api/v1/metrics?view=timing. No GitHub read loading the page.
        const html = timingBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has(timingAssets.script) && dashboard.has(timingAssets.stylesheet),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/overview") {
        // Overview (#824): a static bootstrap after the shell's project selection check; the
        // component reads /api/v1/metrics?view=news. No GitHub read loading the page.
        const html = overviewBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has(overviewAssets.script) && dashboard.has(overviewAssets.stylesheet),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/discussion") {
        // Discussion (#1103): a static bootstrap after the shell's project selection check; the
        // component reads /api/v1/discussion. No GitHub read loading the page.
        const html = discussionBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has(discussionAssets.script) && dashboard.has(discussionAssets.stylesheet),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/rules") {
        // The rules page (#392, #853): a static bootstrap; the component reads /api/v1/rules.
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const html = rulesBootstrapHtml(
          served,
          context.url.searchParams,
          dashboard.has("/web/rules.js") && dashboard.has("/web/rules.css"),
        );
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/diagnostics") {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
        const page = diagnosticsPage(context.url.searchParams, served);
        response.writeHead(page.status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(request.method === "HEAD" ? undefined : page.html);
        return;
      }
      if (path === "/quotas") {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const page = quotasPage(
          context.url.searchParams,
          {
            host: facts.auth.host,
            login: facts.auth.login,
          },
          served,
        );
        response.writeHead(page.status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(page.html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/human") {
        // The human mode of the Work page (#458): validated server-side, read by its script.
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const page = humanPage(
          context.url.searchParams,
          served,
          selectRepository,
          Boolean(options.allowEdits),
        );
        response.writeHead(page.status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(page.html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (path === "/activity") {
        // The read-only Activity/Agents view (#456): validated server-side, read by its script.
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], {
            allow: "GET, HEAD",
          });
        const page = activityPage(context.url.searchParams, served, selectRepository);
        response.writeHead(page.status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardSecurityPolicy,
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : withProcessIdentity(page.html, processIdentity, selectedPage ?? undefined),
        );
        return;
      }
      if (await routes(context)) return;
      throw new HttpFailure(404, "NOT_FOUND", `No route ${path}.`, ["GET /api/v1/status"]);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpFailure)
        sendJson(
          response,
          error.status,
          errorDocument({ code: error.code, message: error.message, next: error.next }),
          error.headers,
        );
      else {
        // Unexpected: report a sanitized message only; the details stay out of the response.
        runtime.stderr(`pdb serve: internal error on ${pathForLog}\n`);
        sendJson(
          response,
          500,
          errorDocument({ code: "INTERNAL", message: "Internal error.", next: [] }),
        );
      }
    }
  };

  const server: Server = createHttpServer({ headersTimeout: HEADERS_TIMEOUT_MS }, (req, res) => {
    void handle(req, res);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: options.port, host: bindHost }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE")
      throw new ServeStartupError(
        EXIT_PORT,
        `port ${options.port} on ${options.host} is already in use; is another pdb serve running? Stop it or pass --port N (0 picks a free port).`,
      );
    if (code === "EACCES")
      throw new ServeStartupError(
        EXIT_PORT,
        `port ${options.port} on ${options.host} is not permitted; pass --port N above 1023 (0 picks a free port).`,
      );
    if (code === "EADDRNOTAVAIL")
      throw new ServeStartupError(1, `${options.host} is not an address of this machine.`);
    throw new ServeStartupError(1, `cannot listen on ${options.host}: ${code ?? "unknown error"}.`);
  }
  port = (server.address() as AddressInfo).port;
  allowed = allowedHostnames(bindHost);
  facts.url = `http://${urlHost(bindHost)}:${port}/`;
  const services = extensions(facts);
  routes = services.routes ?? routes;
  status = services.status ?? status;

  // #808: the one live-application entry point of the running server. It reconciles a fresh
  // saved configuration against the served set (never re-adding startup targets) through the
  // composition's live application service, which commits the new served set, per-repository
  // context revisions, the request-context generation and the cache invalidation atomically in
  // one synchronous step, so in-flight reads for an obsolete context are rejected.
  //
  // Applications are serialized: two callers applying successive revisions must not let the
  // older verification complete later, re-read the then-current set and install an older
  // configuration over a newer one.
  let applyTail: Promise<unknown> = Promise.resolve();
  const applyLiveConfiguration = (config: LoadedGlobalConfig): Promise<LiveApplicationResult> => {
    if (!services.live)
      throw new Error(
        "this serve build has no live configuration application (no cache owner or global configuration boundary); restart the server instead.",
      );
    const run = applyTail.then(() => services.live!.apply(config));
    // Keep only the success path on the chain: a rejected application must not wedge the next
    // one, but its error still propagates to the caller.
    applyTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let closing: Promise<void> | null = null;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => (finish = resolve));
  const close = (): Promise<void> => {
    closing ??= (async () => {
      shutting = true;
      // Stop accepting, then abort every in-flight collection (terminating gh children).
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      lifecycle.abort(new Error("pdb serve is shutting down."));
      // A failure here must not block shutdown, but it is reported, never swallowed.
      await services.close?.().catch(() => runtime.stderr("pdb serve: closing sessions failed.\n"));
      server.closeIdleConnections();
      let timer: unknown;
      const grace = new Promise<void>((resolve) => {
        timer = runtime.clock.setTimeout(resolve, SHUTDOWN_GRACE_MS);
      });
      await Promise.race([stopped, grace]);
      runtime.clock.clearTimeout(timer);
      // Responses still open after the grace period are cut off.
      server.closeAllConnections();
      await stopped;
      finish();
    })();
    return closing;
  };
  return { facts, port, close, closed, applyLiveConfiguration, shuttingDown: () => shutting };
}

/** The banner: one fact per line on stdout; the first line is stable and machine-parsable. */
export function banner(facts: ServerFacts): string {
  const repositories = facts.served
    .map((s) => (facts.served.length === 1 ? `${s.repository} (default)` : s.repository))
    .join(", ");
  return [
    `pdb serve ${facts.version ?? "(unknown version)"} listening on ${facts.url}`,
    `  repositories: ${repositories}`,
    `  cache: memory only, ttl ${facts.ttlMs / 60_000}m; restart clears it`,
    `  mcp: ${facts.url}mcp`,
    `  rules: ${facts.url}rules`,
    `  agent setup: ${facts.url}setup`,
    "  stop: Ctrl-C",
    "",
  ].join("\n");
}

/** Remote-exposure warning (stderr), from the security contract. */
export const remoteWarning = (url: string): string =>
  `WARNING: pdb serve is reachable from other machines at ${url}. It has no authentication; anyone who can reach it can read private repository data that your gh login can see.\n`;

/**
 * Signals that start a graceful shutdown. Windows delivers SIGINT for Ctrl-C and SIGBREAK for
 * Ctrl-Break in the console; a kill from another process cannot be caught there.
 */
export const shutdownSignals = (platform: NodeJS.Platform): string[] =>
  platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

/** Run `pdb serve` until a signal stops it; returns the exit status. */
export async function runServe(
  args: string[],
  runtime: ServeRuntime = defaultServeRuntime(),
  extensions: (options: ServeOptions, runtime: ServeRuntime) => ServeExtensions = (o, r) =>
    readServices(o, r, r.read ?? defaultReadRuntime(r)),
): Promise<number> {
  let options: ServeOptions & { help?: boolean };
  try {
    options = serveArguments(args, runtime.cwd);
  } catch (error) {
    if (!(error instanceof ServeUsageError)) throw error;
    runtime.stderr(`pdb serve: ${error.message}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    runtime.stdout(serveHelp);
    return 0;
  }
  let running: RunningServer;
  try {
    running = await startServe(options, runtime, extensions(options, runtime));
  } catch (error) {
    if (!(error instanceof ServeStartupError)) throw error;
    runtime.stderr(`pdb serve: ${error.message}\n`);
    return error.exitCode;
  }
  let signalled = 0;
  const onSignal = () => {
    signalled++;
    if (signalled > 1) {
      runtime.stderr("pdb serve: second signal; exiting now.\n");
      runtime.exit(EXIT_FORCED);
      return;
    }
    runtime.stderr("pdb serve: shutting down (Ctrl-C again to exit now).\n");
    void running.close();
  };
  const signals = shutdownSignals(runtime.platform);
  for (const signal of signals) runtime.signals.on(signal, onSignal);
  runtime.stdout(banner(running.facts));
  if (running.facts.exposed) runtime.stderr(remoteWarning(running.facts.url));
  try {
    await running.closed;
  } finally {
    for (const signal of signals) runtime.signals.off(signal, onSignal);
  }
  runtime.stderr("pdb serve: stopped.\n");
  return 0;
}
