/**
 * The `pdb serve` JSON read API (doc/design/serve.md "Read API", #373).
 *
 * Every data route resolves repository and identity per request, reads through the memory
 * cache, renders the caller's own projection with the injected clock, and wraps the unchanged
 * versioned CLI JSON in the `serve-read` envelope with a `freshness` block. Nothing here
 * mutates GitHub; refresh changes only the server's own memory.
 */
import { BriefingEngineError } from "../config/engine-setting.js";
import { validateHarness } from "../config/harness.js";
import type { Environment } from "../config/harness.js";
import { validateEntryKey } from "../config/identity.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { resolveReadIdentity } from "../config/readidentity.js";
import type { ReadIdentity } from "../config/readidentity.js";
import { roleNames } from "../briefing/roles.js";
import { pickupOrders } from "../briefing/ranking.js";
import type { PickupOrder } from "../briefing/ranking.js";
import { readBriefing } from "../briefing/service.js";
import type { ReadRuntime } from "../briefing/service.js";
import { permissionLookup } from "../github/github.js";
import type {
  collect as Collect,
  Query,
  QueryVariables,
  Rest,
  RestAnswer,
} from "../github/github.js";
import type { dependencyReport as DependencyReportFn } from "../github/dependencies.js";
import type { Snapshot } from "../github/types.js";
import { localPaths, redactLocalText, redactPaths } from "../mcp/redact.js";
import { markerTrust } from "../workflow/delivery.js";
import { readPullRequest, readReviewHistory, readTeam, readWho } from "../workflow/readservices.js";
import type { DeliveryBoundaries } from "../workflow/readservices.js";
import { defaultStaleHours } from "../workflow/team.js";
import { collect, ghQueryWith, ghRest } from "../github/github.js";
import { dependencyReport } from "../github/dependencies.js";
import type {
  RequestContext,
  Routes,
  ServedRepository,
  ServeExtensions,
  ServeRuntime,
  ServerFacts,
} from "../serve.js";
import { CollectionError, ServeCache } from "./cache.js";
import type { Freshness } from "./cache.js";
import { HttpFailure, readJsonBody, sendJson } from "./http.js";
import type { ServeError } from "./http.js";
import type { ServeOptions } from "./options.js";

/** GitHub-facing boundaries the read API uses; tests inject credential-free fakes. */
export interface ServeReadRuntime {
  collect: typeof Collect;
  dependencyReport: typeof DependencyReportFn;
  rest?: Rest;
  queryWith?: (signal?: AbortSignal) => Query;
  now: () => Date;
  env: Environment;
  git?: GitRunner;
  fs?: ConfigFileSystem;
  /** Local configuration readers rooted at a project (estimation and guide settings). */
  projectRuntime?: (project: string | undefined) => Pick<ReadRuntime, "estimation" | "guide">;
}

type View = "briefing" | "issue" | "dependencies" | "pull-request" | "who" | "team";
type Status = "complete" | "incomplete" | "error";

/** Envelope `selection`, the MCP `selectionSchema` shape. */
export interface Selection {
  repository: string | null;
  agent: string | null;
  identitySource: ReadIdentity["source"];
  triageRole: string | null;
  entry: string | null;
  identityDiagnostic: string | null;
}

/** The `serve-read` envelope of every data route. */
export interface ReadEnvelope {
  schemaVersion: 1;
  kind: "serve-read";
  view: View;
  status: Status;
  selection: Selection;
  freshness: Freshness | null;
  warnings: string[];
  result: unknown;
  error: ServeError | null;
}

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const agentPattern = /^[A-Za-z0-9][\w.-]*$/;
const sincePattern = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d{2}:\d{2})$/;

const isPickupOrder = (text: string): text is PickupOrder =>
  (pickupOrders as readonly string[]).includes(text);

const invalid = (message: string): HttpFailure => new HttpFailure(400, "INVALID_ARGUMENT", message);

/** Read query parameters, rejecting unknown or repeated ones. */
function parameters(url: URL, allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name))
      throw invalid(
        `Unknown query parameter ${JSON.stringify(name)}; allowed: ${allowed.join(", ")}.`,
      );
    if (values.has(name)) throw invalid(`Query parameter ${name} is repeated.`);
    values.set(name, value);
  }
  return values;
}

const booleanParam = (values: Map<string, string>, name: string): boolean => {
  const value = values.get(name);
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw invalid(`${name} must be true or false.`);
};

const integerParam = (
  values: Map<string, string>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number => {
  const value = values.get(name);
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max)
    throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  return Number(value);
};

const positiveParam = (values: Map<string, string>, name: string): number | undefined => {
  const value = values.get(name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(number) || number <= 0)
    throw invalid(`${name} must be a positive number.`);
  return number;
};

/** Repository per request: `repo` in the served set, else the single served one (#271). */
export function selectRepository(
  served: readonly ServedRepository[],
  repo: string | undefined,
): ServedRepository {
  if (repo !== undefined) {
    if (!repoPattern.test(repo)) throw invalid("repo must be owner/name.");
    const found = served.find((s) => s.repository.toLowerCase() === repo.toLowerCase());
    if (!found)
      throw new HttpFailure(
        403,
        "REPOSITORY_NOT_SERVED",
        `${repo} is not served by this server.`,
        served.map((s) => `?repo=${s.repository}`),
      );
    return found;
  }
  if (served.length === 1) return served[0]!;
  throw new HttpFailure(
    400,
    "REPOSITORY_UNRESOLVED",
    "This server serves more than one repository; choose one with ?repo=owner/name.",
    served.map((s) => `?repo=${s.repository}`),
  );
}

const noIdentity = (repository: string | null): Selection => ({
  repository,
  agent: null,
  identitySource: "unresolved",
  triageRole: null,
  entry: null,
  identityDiagnostic: null,
});

/** A live freshness block for a read that produced no cache entry (an unavailable issue). */
const liveNow = (cache: ServeCache, now: Date): Freshness => ({
  source: "live",
  observedAt: now.toISOString(),
  ageSeconds: 0,
  ttlSeconds: cache.ttlMs / 1000,
  expiresAt: new Date(now.getTime() + cache.ttlMs).toISOString(),
  stale: false,
  refreshError: null,
});

/** The CLI command that inspects the same read, for error guidance. */
function cliCommand(view: View, repository: string, number?: number): string {
  const repo = `--repo ${repository}`;
  switch (view) {
    case "briefing":
      return `pdb ${repo} --json`;
    case "issue":
      return `pdb --issue ${number} ${repo} --json`;
    case "dependencies":
      return `pdb deps ${number} ${repo} --json`;
    case "pull-request":
      return `pdb pr ${number} ${repo} --json`;
    case "who":
      return `pdb who ${number} ${repo} --json`;
    case "team":
      return `pdb team ${repo} --json`;
  }
}

const refreshScopes = {
  all: undefined,
  // The briefing, issue, who and team views share collected snapshots.
  briefing: ["collect"],
  issues: ["collect"],
  who: ["collect"],
  team: ["collect"],
  deps: ["deps"],
  prs: ["pr", "pr-history"],
} as const;

/** Build the read API routes over one cache. */
export function readApi(
  options: ServeOptions,
  runtime: ServeReadRuntime,
  cache: ServeCache,
): (facts: ServerFacts) => Routes {
  // Cached GitHub boundaries: whole collected results per key; auxiliary reads memoised in the
  // entry being presented.
  const cachedCollect: typeof Collect = (repository, collectOptions) => {
    const { signal, ...coverage } = collectOptions ?? {};
    return cache.read(
      { repository, collector: "collect", coverage },
      (inner) => runtime.collect(repository, { ...coverage, signal: inner }),
      signal,
    );
  };
  const cachedDependencies: typeof DependencyReportFn = (repository, number, depOptions) => {
    const { signal, ...coverage } = depOptions ?? {};
    return cache.read(
      { repository, collector: "deps", coverage: { n: number, ...coverage } },
      (inner) => runtime.dependencyReport(repository, number, { ...coverage, signal: inner }),
      signal,
    );
  };
  const memoRest: Rest | undefined = runtime.rest
    ? (path, restOptions) =>
        cache.memo<RestAnswer>(
          `rest\u0000${path}`,
          () => runtime.rest!(path, restOptions),
          // A failed lookup (no status) is unknown evidence; it is never kept.
          (answer) => answer.status !== null,
        )
    : undefined;
  const memoQueryWith = runtime.queryWith
    ? (signal?: AbortSignal): Query =>
        (query: string, variables: QueryVariables) =>
          cache.memo(
            `query\u0000${query}\u0000${JSON.stringify(variables)}`,
            () => runtime.queryWith!(signal)(query, variables),
            () => true,
          )
    : undefined;

  const known = localPaths(...options.projects);
  const redact = <T>(value: T): T => redactPaths(value, known);

  const readRuntime = (project: string | undefined): ReadRuntime => ({
    collect: cachedCollect,
    dependencyReport: cachedDependencies,
    rest: memoRest,
    queryWith: memoQueryWith,
    now: runtime.now,
    redactDiagnostic: redactLocalText,
    ...(runtime.projectRuntime?.(project) ??
      (project ? { estimation: { cwd: project }, guide: { cwd: project } } : {})),
  });

  const boundaries = (repository: string, signal: AbortSignal): DeliveryBoundaries =>
    memoRest && memoQueryWith
      ? {
          trust: markerTrust(permissionLookup(repository, memoRest, signal)),
          live: {
            query: memoQueryWith(signal),
            rest: (path, o) => memoRest(path, { ...o, signal: o?.signal ?? signal }),
          },
          signal,
        }
      : {};

  const identity = async (
    values: Map<string, string>,
    served: ServedRepository,
  ): Promise<Selection> => {
    const agent = values.get("agent");
    if (agent !== undefined && !agentPattern.test(agent))
      throw invalid("agent must be an agent name such as kavya_sabbagh.");
    const entry = values.get("entry");
    const harness = values.get("harness");
    if (entry !== undefined && harness !== undefined)
      throw invalid("Pass either entry or harness, not both.");
    try {
      if (entry !== undefined) validateEntryKey(entry);
      if (harness !== undefined) validateHarness(harness);
    } catch (error) {
      throw invalid(redactLocalText(error instanceof Error ? error.message : String(error)));
    }
    // A request-level entry or harness replaces both startup selectors (contract precedence).
    const requested = entry !== undefined || harness !== undefined;
    const resolved = await resolveReadIdentity({
      toolAgent: agent,
      startupAgent: options.agent,
      project: served.project,
      repository: served.repository,
      entry: requested ? entry : options.entry,
      harness: requested ? harness : options.harness,
      env: runtime.env,
      git: runtime.git,
      fs: runtime.fs,
    });
    return {
      repository: served.repository,
      agent: resolved.agent,
      identitySource: resolved.source,
      triageRole: resolved.triageRole,
      entry: resolved.entry,
      identityDiagnostic: resolved.diagnostic && redactLocalText(resolved.diagnostic),
    };
  };

  return (facts) => {
    const respond = (
      context: RequestContext,
      httpStatus: number,
      envelope: ReadEnvelope,
      headers: Record<string, string> = {},
    ): void => {
      context.source = envelope.freshness?.source;
      sendJson(context.response, httpStatus, envelope, headers);
    };

    /**
     * Run one data read under the cache's per-request scope and answer with the envelope;
     * collection failures map to the 502 family with CLI inspection guidance.
     */
    const dataRoute = async (
      context: RequestContext,
      view: View,
      allowed: readonly string[],
      number: number | undefined,
      read: (
        values: Map<string, string>,
        served: ServedRepository,
        setSelection: (selection: Selection) => void,
      ) => Promise<{ status: "complete" | "incomplete"; result: unknown }>,
    ): Promise<void> => {
      if (context.request.method !== "GET" && context.request.method !== "HEAD")
        throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
      let selection = noIdentity(null);
      let served: ServedRepository | undefined;
      try {
        const values = parameters(context.url, [...allowed, "repo", "refresh"]);
        served = selectRepository(facts.served, values.get("repo"));
        selection = noIdentity(served.repository);
        const refresh = booleanParam(values, "refresh");
        const chosen = served;
        const { value, freshness } = await cache.track(refresh, () =>
          read(values, chosen, (s) => (selection = s)),
        );
        const primary = freshness[0] ?? liveNow(cache, runtime.now());
        const stale = freshness.find((f) => f.stale);
        const warnings = stale
          ? [
              `Served a stale result observed at ${stale.observedAt} because the live read failed (${stale.refreshError?.code ?? "unknown"}); facts may have changed since.`,
            ]
          : [];
        respond(context, 200, {
          schemaVersion: 1,
          kind: "serve-read",
          view,
          status: stale ? "incomplete" : value.status,
          selection,
          freshness: stale ?? primary,
          warnings,
          result: redact(value.result),
          error: null,
        });
      } catch (error) {
        if (context.signal.aborted) {
          // Client gone or shutting down: nothing to answer, nothing is reported as complete.
          if (!context.response.headersSent) context.response.destroy();
          return;
        }
        let status = 502;
        let failure: ServeError;
        let headers: Record<string, string> = {};
        if (error instanceof HttpFailure) {
          // Argument and selection failures keep the data envelope of this view.
          status = error.status;
          failure = { code: error.code, message: error.message, next: error.next };
          headers = error.headers;
        } else if (error instanceof CollectionError && served) {
          failure = {
            code: error.code,
            message: error.message,
            next: [cliCommand(view, served.repository, number)],
          };
          if (error.resetAt) {
            const seconds = Math.ceil((Date.parse(error.resetAt) - runtime.now().getTime()) / 1000);
            if (seconds > 0) headers = { "retry-after": String(seconds) };
          }
        } else if (error instanceof BriefingEngineError) {
          status = 500;
          failure = {
            code: "INTERNAL",
            message: redactLocalText(error.message),
            next: [
              cliCommand(view, served?.repository ?? "owner/name", number),
              "pdb config get briefing.engine",
            ],
          };
        } else throw error;
        respond(
          context,
          status,
          {
            schemaVersion: 1,
            kind: "serve-read",
            view,
            status: "error",
            selection,
            freshness: null,
            warnings: [],
            result: null,
            error: failure,
          },
          headers,
        );
      }
    };

    const briefingResult = async (
      values: Map<string, string>,
      served: ServedRepository,
      setSelection: (selection: Selection) => void,
      signal: AbortSignal,
      issue?: number,
    ) => {
      const selection = await identity(values, served);
      setSelection(selection);
      const role = values.get("role");
      if (role !== undefined && !roleNames().includes(role))
        throw invalid(`role must be one of ${roleNames().join(", ")}.`);
      const order = values.get("order");
      if (order !== undefined && !isPickupOrder(order))
        throw invalid(`order must be one of ${pickupOrders.join(", ")}.`);
      const sinceText = values.get("since");
      if (
        sinceText !== undefined &&
        (!sincePattern.test(sinceText) || !Number.isFinite(Date.parse(sinceText)))
      )
        throw invalid("since must be an ISO timestamp with a time and timezone.");
      const read = await readBriefing(readRuntime(served.project), {
        repository: served.repository,
        agent: selection.agent ?? undefined,
        issue,
        since: sinceText === undefined ? undefined : new Date(sinceText).toISOString(),
        limit: integerParam(values, "limit", 1, 100, 10),
        maxChars: 10000,
        role,
        order: (order as PickupOrder | undefined) ?? "impact",
        signal,
      });
      return read;
    };

    return async (context) => {
      const path = context.url.pathname;
      if (path === "/api/v1/refresh") {
        if (context.request.method !== "POST")
          throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use POST.", [], { allow: "POST" });
        if (context.url.search) throw invalid("/api/v1/refresh takes a JSON body, not a query.");
        const body = await readJsonBody(context.request);
        if (typeof body !== "object" || body === null || Array.isArray(body))
          throw invalid('The body must be a JSON object such as {"repo":"owner/name"}.');
        const record = body as Record<string, unknown>;
        for (const name of Object.keys(record))
          if (name !== "repo" && name !== "scope")
            throw invalid(`Unknown body field ${JSON.stringify(name)}; allowed: repo, scope.`);
        if (record.repo !== undefined && typeof record.repo !== "string")
          throw invalid("repo must be owner/name.");
        const served =
          record.repo === undefined ? undefined : selectRepository(facts.served, record.repo);
        const scope = record.scope ?? "all";
        if (typeof scope !== "string" || !Object.hasOwn(refreshScopes, scope))
          throw invalid(`scope must be one of ${Object.keys(refreshScopes).join(", ")}.`);
        const evicted = cache.refresh(
          served?.repository,
          refreshScopes[scope as keyof typeof refreshScopes],
        );
        sendJson(context.response, 200, {
          schemaVersion: 1,
          kind: "serve-refresh",
          repository: served?.repository ?? null,
          scope,
          evicted,
        });
        return true;
      }
      if (path === "/api/v1/briefing") {
        await dataRoute(
          context,
          "briefing",
          ["agent", "entry", "harness", "role", "order", "since", "limit"],
          undefined,
          async (values, served, setSelection) => {
            const read = await briefingResult(values, served, setSelection, context.signal);
            // Only an issue read can be unavailable.
            if (read.kind !== "report") throw new Error("unexpected unavailable briefing");
            return {
              status: read.complete ? "complete" : "incomplete",
              // The CLI's --json briefing is the report plus its checkpoint field.
              result: { ...read.report, checkpoint: null },
            };
          },
        );
        return true;
      }
      if (path === "/api/v1/team") {
        await dataRoute(context, "team", ["staleHours"], undefined, async (values, served) => {
          const staleHours = positiveParam(values, "staleHours") ?? defaultStaleHours;
          const snapshot: Snapshot = await cachedCollect(served.repository, {
            signal: context.signal,
          });
          const read = await readTeam(
            snapshot,
            { staleHours, now: runtime.now(), offline: false },
            boundaries(served.repository, context.signal),
          );
          return { status: read.complete ? "complete" : "incomplete", result: read.report };
        });
        return true;
      }
      const match = /^\/api\/v1\/(issues|prs)\/([1-9]\d{0,15})(\/deps|\/who)?$/.exec(path);
      if (match && Number.isSafeInteger(Number(match[2]))) {
        const number = Number(match[2]);
        const [, kind, , sub] = match;
        if (kind === "prs" && sub) return false;
        if (kind === "prs") {
          await dataRoute(context, "pull-request", ["history"], number, async (values, served) => {
            const history = booleanParam(values, "history");
            if (!runtime.queryWith)
              throw new CollectionError("GITHUB_UNAVAILABLE", "No GitHub reader is configured.");
            // The whole PR report is the cached fact result: it has no identity projection.
            const read = await cache.read<{ report: unknown; complete: boolean }>(
              {
                repository: served.repository,
                collector: history ? "pr-history" : "pr",
                coverage: { n: number },
              },
              (inner): Promise<{ report: unknown; complete: boolean }> =>
                history
                  ? readReviewHistory(
                      served.repository,
                      number,
                      runtime.queryWith!(inner),
                      runtime.now,
                    )
                  : readPullRequest(
                      served.repository,
                      number,
                      runtime.queryWith!(inner),
                      runtime.rest
                        ? {
                            trust: markerTrust(
                              permissionLookup(served.repository, runtime.rest, inner),
                            ),
                            live: {
                              query: runtime.queryWith!(inner),
                              rest: (p, o) =>
                                runtime.rest!(p, { ...o, signal: o?.signal ?? inner }),
                            },
                            signal: inner,
                          }
                        : {},
                      runtime.now,
                    ),
              context.signal,
            );
            return { status: read.complete ? "complete" : "incomplete", result: read.report };
          });
          return true;
        }
        if (sub === "/deps") {
          await dataRoute(context, "dependencies", ["tree"], number, async (values, served) => {
            const tree = booleanParam(values, "tree");
            const report = await cachedDependencies(served.repository, number, {
              tree,
              signal: context.signal,
            });
            return { status: "complete", result: report };
          });
          return true;
        }
        if (sub === "/who") {
          await dataRoute(context, "who", ["staleHours"], number, async (values, served) => {
            const staleHours = positiveParam(values, "staleHours") ?? defaultStaleHours;
            const snapshot = await cachedCollect(served.repository, {
              issue: number,
              signal: context.signal,
            });
            const read = await readWho(
              snapshot,
              number,
              { staleHours, now: runtime.now(), offline: false },
              boundaries(served.repository, context.signal),
            );
            return { status: read.complete ? "complete" : "incomplete", result: read.report };
          });
          return true;
        }
        await dataRoute(
          context,
          "issue",
          ["agent", "entry", "harness", "includeTransferred"],
          number,
          async (values, served, setSelection) => {
            const follow = booleanParam(values, "includeTransferred");
            let chosen: Selection | undefined;
            const read = await briefingResult(
              values,
              served,
              (selection) => setSelection((chosen = selection)),
              context.signal,
              number,
            );
            if (read.kind === "report")
              return {
                status: read.complete ? "complete" : "incomplete",
                result: { ...read.report, checkpoint: null },
              };
            const diagnosis = read.diagnosis;
            // Transferred-out work is excluded by default; only an explicit opt-in follows it,
            // exactly as the CLI's --include-transferred does.
            if (
              diagnosis.state === "moved" &&
              follow &&
              Number.isSafeInteger(Number(diagnosis.destination.number))
            ) {
              const destination = await readBriefing(readRuntime(undefined), {
                repository: diagnosis.destination.repository,
                agent: chosen?.agent ?? undefined,
                issue: Number(diagnosis.destination.number),
                limit: 10,
                maxChars: 10000,
                order: "impact",
                signal: context.signal,
              });
              if (destination.kind === "report")
                return {
                  status: destination.complete ? "complete" : "incomplete",
                  result: { ...destination.report, checkpoint: null, transferredFrom: diagnosis },
                };
              return {
                status: "incomplete",
                result: { schemaVersion: 1, kind: "issue-unavailable", ...destination.diagnosis },
              };
            }
            return {
              status: "incomplete",
              result: { schemaVersion: 1, kind: "issue-unavailable", ...diagnosis },
            };
          },
        );
        return true;
      }
      return false;
    };
  };
}

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
    return {
      routes: readApi(options, read, cache)(facts),
      status: { cache: () => cache.status(), repositories: () => cache.repositories() },
      close: async () => cache.close(),
    };
  };
}
