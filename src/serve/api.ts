import { cachedIssueFacts } from "./issue-facts.js";
/**
 * The `pdb serve` JSON read API (doc/design/serve.md "Read API", #373).
 *
 * Every data route resolves repository and identity per request, reads through the memory
 * cache, renders the caller's own projection with the injected clock, and wraps the unchanged
 * versioned CLI JSON in the `serve-read` envelope with a `freshness` block. Nothing here
 * mutates GitHub; refresh changes only the server's own memory.
 */
import { BriefingArgumentError } from "../briefing/compact.js";
import { noCheckout } from "../config/project-rules-setting.js";
import { resolveReviewPolicy } from "../config/review-setting.js";
import type { DeclaredReviewPolicy } from "../workflow/reviewpolicy.js";
import {
  BriefingEngineError,
  safeEngineCause,
  safeEngineCauseText,
} from "../config/engine-setting.js";
import { validateHarness } from "../config/harness.js";
import { validateEntryKey } from "../config/identity.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { resolveReadIdentity } from "../config/readidentity.js";
import type { ReadIdentity } from "../config/readidentity.js";
import { briefingRoleNames, roleSectionIds } from "../briefing/roles.js";
import { pickupOrders } from "../briefing/ranking.js";
import type { PickupOrder } from "../briefing/ranking.js";
import { readBriefing } from "../briefing/service.js";
import {
  humanContextEnabled,
  serverHumanContext,
  type HumanContext,
} from "../config/humancontext.js";
import type { ReadRuntime } from "../briefing/service.js";
import {
  collectIssueFocus as CollectIssueFocus,
  IssueUnavailable,
  locateIssue,
  permissionLookup,
  SubjectUnavailable,
} from "../github/github.js";
import type {
  collect as Collect,
  Query,
  QueryVariables,
  Rest,
  RestAnswer,
} from "../github/github.js";
import type { dependencyReport as DependencyReportFn } from "../github/dependencies.js";
import { legacyTreeText, notReadText, treeIncompleteText } from "../github/dependencies.js";
import { readProfiles } from "../github/readplan.js";
import type { Snapshot } from "../github/types.js";
import { localPaths, redactLocalText, redactPaths } from "../mcp/redact.js";
import { markerTrust } from "../workflow/delivery.js";
import {
  readPullRequest,
  readReviewHistory,
  readTeam,
  readWhoLive,
} from "../workflow/readservices.js";
import type { DeliveryBoundaries } from "../workflow/readservices.js";
import { defaultStaleHours } from "../workflow/team.js";
import { readTicketStatus, ticketLimits } from "../workflow/ticketstatus.js";
import type {
  RequestContext,
  Routes,
  ServedRepository,
  ServeReadRuntime,
  ServerFacts,
} from "./types.js";
import { CollectionError, ServeCache, UnservedRepository } from "./cache.js";
import type { Freshness } from "./cache.js";
import { HttpFailure, readJsonBody, sendJson } from "./http.js";
import type { ServeError } from "./http.js";
import type { ServeOptions } from "./options.js";

/** GitHub-facing boundaries the read API uses; defined in serve/types.ts (#445). */
export type { ServeReadRuntime } from "./types.js";

const githubUrlRepository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:[/?#]|$)/i;

/** The repository a GraphQL read names through its variables, if any. */
export function queryRepository(variables: QueryVariables): string | null {
  const { owner, name, url } = variables as Record<string, unknown>;
  if (typeof owner === "string" && typeof name === "string") return `${owner}/${name}`;
  if (typeof url === "string") return githubUrlRepository.exec(url)?.[1] ?? null;
  return null;
}

/**
 * Only definitive REST answers are memoised: success, and the negative answers GitHub gives
 * for something that does not exist or is gone (404, 410). A failed request (no status), a
 * rate limit (429, or 403 which can carry one) and server errors (5xx) are retried next time.
 */
export const definitiveRest = (answer: RestAnswer): boolean =>
  answer.status !== null &&
  ((answer.status >= 200 && answer.status < 300) || answer.status === 404 || answer.status === 410);

/** GraphQL confined to served repositories: any other is refused before gh runs. */
export function servedOnlyQuery(
  queryWith: (signal?: AbortSignal) => Query,
  isServed: (repository: string) => boolean,
): (signal?: AbortSignal) => Query {
  return (signal) => {
    const query = queryWith(signal);
    return async (source, variables) => {
      const repository = queryRepository(variables);
      if (repository !== null && !isServed(repository)) throw new UnservedRepository(repository);
      return query(source, variables);
    };
  };
}

/** REST confined to served repositories; any other answers as unknown (no status). */
export function servedOnlyRest(rest: Rest, isServed: (repository: string) => boolean): Rest {
  return async (path, options) => {
    const repository = /^\/?repos\/([\w.-]+\/[\w.-]+)(?:[/?]|$)/.exec(path)?.[1];
    if (repository !== undefined && !isServed(repository)) return { status: null, body: null };
    return rest(path, options);
  };
}

/** The stand-in checkout root of a repository served without a local project. */
export const NO_PROJECT_ROOT = "<no local project>";

const refuseWrite = async (): Promise<never> => {
  throw new Error("pdb serve never writes local configuration.");
};

/**
 * Configuration readers for a repository served only by --repo: they see an empty checkout of
 * exactly that repository, so every setting takes its default. Without them the estimation and
 * workflow-guide readers fall back to the process working directory, which #271 forbids: the
 * directory pdb serve was started in says nothing about the requested repository.
 */
export function noLocalProject(
  repository: string,
): Pick<ReadRuntime, "estimation" | "guide" | "reviewPolicy" | "projectRules"> {
  const git: GitRunner = async (args) =>
    args[0] === "rev-parse"
      ? `${NO_PROJECT_ROOT}\n`
      : `origin\thttps://github.com/${repository}.git (fetch)\n`;
  const fs: ConfigFileSystem = {
    readText: async () => null,
    writeText: refuseWrite,
    rename: refuseWrite,
    remove: refuseWrite,
    makeDirectory: refuseWrite,
  };
  const readers = { cwd: NO_PROJECT_ROOT, git, fs };
  // #301: no verified project, so no declared review policy: explicitly undeclared.
  return {
    estimation: readers,
    guide: readers,
    reviewPolicy: { state: "undeclared", scope: "no-matching-project" },
    // #516: whether project preferences are enabled cannot be read without the checkout.
    projectRules: { enabled: "unavailable", reason: noCheckout(repository) },
  };
}

/**
 * The declared review policy of one served repository (#301): read from its --project's own
 * configuration; with --repo only, explicitly undeclared. Never from the working directory (#271).
 */
export async function servedReviewPolicy(
  readers: Pick<ReadRuntime, "guide" | "reviewPolicy">,
  repository: string,
): Promise<DeclaredReviewPolicy> {
  return readers.reviewPolicy ?? resolveReviewPolicy(repository, readers.guide ?? {});
}

type View = "briefing" | "issue" | "dependencies" | "pull-request" | "who" | "team" | "ticket";
type Status = "complete" | "incomplete" | "error";

/** Envelope `selection`, the MCP `selectionSchema` shape. */
export interface Selection {
  repository: string | null;
  agent: string | null;
  identitySource: ReadIdentity["source"];
  triageRole: string | null;
  entry: string | null;
  identityDiagnostic: string | null;
  /** Additive (#319): store category of a persisted name; never a path. */
  identityStore?: "pdb" | "legacy-not-imported";
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
const platformPattern = /^[\w.-]+$/;
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
    case "ticket":
      return `pdb ticket ${number} ${repo} --json`;
  }
}

const refreshScopes = {
  all: undefined,
  // The briefing, issue, who and team views share collected snapshots.
  briefing: ["collect", "discovery", "issue-facts"],
  issues: ["collect", "discovery", "issue-facts"],
  who: ["collect", "who"],
  team: ["collect"],
  deps: ["deps"],
  prs: ["pr", "pr-history"],
  // The consolidated ticket detail (#454) is its own whole result.
  tickets: ["ticket"],
} as const;

/**
 * Cached GitHub boundaries over one cache, shared by the JSON API and HTTP MCP: whole collected
 * results per key, and auxiliary reads memoised in the entry being presented. Every GitHub read
 * is confined to the served set (`isServed`): an indirection (a transfer, a dependency edge, a
 * delivery record naming another repository) never reaches a repository the user did not
 * choose to serve (#373 review).
 */
export function cachedBoundaries(
  runtime: ServeReadRuntime,
  cache: ServeCache,
  isServed: (repository: string) => boolean,
) {
  const guardedQueryWith = runtime.queryWith && servedOnlyQuery(runtime.queryWith, isServed);
  const guardedRest = runtime.rest && servedOnlyRest(runtime.rest, isServed);
  const cachedCollect: typeof Collect = (repository, collectOptions) => {
    const { signal, ...coverage } = collectOptions ?? {};
    return cache.read(
      {
        repository,
        collector: "collect",
        coverage: {
          ...coverage,
          profile: "compatibility-full-v1",
          version: readProfiles["compatibility-full-v1"].version,
        },
      },
      (inner) => runtime.collect(repository, { ...coverage, signal: inner }),
      signal,
    );
  };
  const cachedShortlist: ServeReadRuntime["collectShortlist"] = runtime.collectShortlist
    ? (repository, options, _query, now) =>
        runtime.collectShortlist!(
          repository,
          {
            ...options,
            issueFacts: (request, produce, signal) =>
              cachedIssueFacts(cache, guardedQueryWith, request, produce, signal),
            discovery: (request, produce, signal) =>
              cache.read(
                {
                  repository,
                  collector: "discovery",
                  coverage: {
                    profile: "briefing-shortlist-v1",
                    version: readProfiles["briefing-shortlist-v1"].version,
                    source: request.source,
                    pageSize: request.pageSize,
                    pages: request.pages,
                  },
                },
                (inner) => {
                  if (!guardedQueryWith)
                    throw new CollectionError(
                      "GITHUB_UNAVAILABLE",
                      "No GitHub reader is configured.",
                    );
                  return produce(guardedQueryWith(inner), inner);
                },
                signal,
                (facts) => facts.complete,
              ),
          },
          guardedQueryWith?.(options.signal),
          now,
        )
    : undefined;
  const cachedDependencies: typeof DependencyReportFn = (repository, number, depOptions) => {
    const { signal, ...coverage } = depOptions ?? {};
    return cache.read(
      {
        repository,
        collector: "deps",
        coverage: {
          n: number,
          ...coverage,
          profile: coverage.tree ? "dependency-tree-v1" : "dependency-direct-v1",
          version:
            readProfiles[coverage.tree ? "dependency-tree-v1" : "dependency-direct-v1"].version,
        },
      },
      async (inner) => {
        const report = await runtime.dependencyReport(repository, number, {
          ...coverage,
          signal: inner,
          follow: isServed,
        });
        // A tree walk that stopped on a quota refusal returns a partial report rather than
        // throwing: start the shared cooldown before this collection slot is released, exactly
        // as the who and ticket routes do (#196).
        const quota = report.collection?.quota;
        if (quota) cache.noteQuotaRefusal(quota);
        return report;
      },
      signal,
      // Never store a partial tree or a quota-stopped read as the answer (#196).
      (report) =>
        !report.collection?.quota && (!report.tree || report.treeBounds?.complete === true),
    );
  };
  const memoRest: Rest | undefined = guardedRest
    ? (path, restOptions) =>
        cache.memo<RestAnswer>(
          `rest\u0000${path}`,
          () => guardedRest(path, restOptions),
          definitiveRest,
        )
    : undefined;
  const memoQueryWith = guardedQueryWith
    ? (signal?: AbortSignal): Query =>
        (query: string, variables: QueryVariables) =>
          cache.memo(
            `query\u0000${query}\u0000${JSON.stringify(variables)}`,
            () => guardedQueryWith(signal)(query, variables),
            () => true,
          )
    : undefined;

  return {
    collect: cachedCollect,
    collectShortlist: cachedShortlist,
    dependencyReport: cachedDependencies,
    rest: memoRest,
    queryWith: memoQueryWith,
    /** Uncached but confined boundaries, for whole-result collectors (pull requests). */
    guardedQueryWith,
    guardedRest,
  };
}

/** Project-rooted local configuration readers (estimation and workflow-guide settings). */
export const projectReaders = (
  runtime: ServeReadRuntime,
  project: string | undefined,
  repository: string,
): Pick<ReadRuntime, "estimation" | "guide" | "reviewPolicy" | "projectRules"> =>
  project
    ? (runtime.projectRuntime?.(project) ?? {
        estimation: { cwd: project },
        guide: { cwd: project },
      })
    : noLocalProject(repository);

/** Build the read API routes over one cache. */
export function readApi(
  options: ServeOptions,
  runtime: ServeReadRuntime,
  cache: ServeCache,
): (facts: ServerFacts) => Routes {
  // The served set, known once listening.
  let servedSet: readonly ServedRepository[] = [];
  // #664: the one execution-human context of this process, known once listening.
  let serverHuman: HumanContext | undefined;
  const isServed = (repository: string): boolean =>
    servedSet.some((s) => s.repository.toLowerCase() === repository.toLowerCase());
  const {
    collect: cachedCollect,
    collectShortlist: cachedShortlist,
    dependencyReport: cachedDependencies,
    rest: memoRest,
    queryWith: memoQueryWith,
    guardedQueryWith,
    guardedRest,
  } = cachedBoundaries(runtime, cache, isServed);
  const known = localPaths(...options.projects);
  const redact = <T>(value: T): T => redactPaths(value, known);

  const readRuntime = (project: string | undefined, repository: string): ReadRuntime => ({
    ...(serverHuman ? { humanContext: async () => serverHuman! } : {}),
    collect: cachedCollect,
    collectShortlist: cachedShortlist,
    dependencyReport: cachedDependencies,
    rest: memoRest,
    queryWith: memoQueryWith,
    now: runtime.now,
    engineClock: runtime.engineClock,
    redactDiagnostic: redactLocalText,
    ...(runtime.loadEngine ? { loadEngine: runtime.loadEngine } : {}),
    ...projectReaders(runtime, project, repository),
    closedQuestions: cache.closedQuestions.slot(project, repository),
    // The scan's reads bypass page memoisation: its watermark must not outrun the evidence.
    ...(guardedQueryWith ? { closedQueryWith: guardedQueryWith } : {}),
  });

  /** Boundaries with the served repository's declared review policy (#301). */
  const policyBoundaries = async (
    served: { project?: string; repository: string },
    signal: AbortSignal,
  ): Promise<DeliveryBoundaries> => ({
    ...boundaries(served.repository, signal),
    reviewPolicy: await servedReviewPolicy(
      projectReaders(runtime, served.project, served.repository),
      served.repository,
    ),
  });

  const boundaries = (repository: string, signal: AbortSignal): DeliveryBoundaries =>
    memoRest && memoQueryWith
      ? {
          trust: markerTrust(permissionLookup(repository, memoRest, signal)),
          trustWith: (rest: Rest) => markerTrust(permissionLookup(repository, rest, signal)),
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
      ...(resolved.store ? { identityStore: resolved.store } : {}),
    };
  };

  return (facts) => {
    servedSet = facts.served;
    if (humanContextEnabled()) serverHuman = serverHumanContext(facts.auth, facts.startedAt);
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
      ) => Promise<{ status: "complete" | "incomplete"; result: unknown; warnings?: string[] }>,
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
        const warnings = [
          ...(stale
            ? [
                `Served a stale result observed at ${stale.observedAt} because the live read failed (${stale.refreshError?.code ?? "unknown"}); facts may have changed since.`,
              ]
            : []),
          ...(value.warnings ?? []),
        ];
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
        if (error instanceof UnservedRepository) {
          status = 403;
          failure = { code: "REPOSITORY_NOT_SERVED", message: error.message, next: [] };
        } else if (error instanceof SubjectUnavailable) {
          // The pull request or issue does not exist (or cannot be read) in this repository.
          status = 404;
          failure = { code: "NOT_FOUND", message: error.message, next: [] };
          if (served) failure.next = [cliCommand(view, served.repository, number)];
        } else if (error instanceof HttpFailure) {
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
          const cause = safeEngineCause(error);
          failure = {
            code: "INTERNAL",
            message: cause ? safeEngineCauseText(cause) : redactLocalText(error.message),
            ...(cause ? { cause } : {}),
            next: [
              ...(cause?.recovery ?? []),
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
      if (role !== undefined && !briefingRoleNames().includes(role))
        throw invalid(`role must be one of ${briefingRoleNames().join(", ")}.`);
      // #311: one registered section, validated exactly as CLI --section and the MCP input.
      const section = values.get("section");
      if (section !== undefined) {
        if (issue !== undefined || role === "human")
          throw invalid("section applies to a role briefing, not a ticket or the human view.");
        const ids = roleSectionIds(role ?? "implementer");
        if (role !== undefined && !ids.includes(section))
          throw invalid(`section for role ${role} must be one of: ${ids.join(", ")}.`);
      }
      const order = values.get("order");
      if (order !== undefined && !isPickupOrder(order))
        throw invalid(`order must be one of ${pickupOrders.join(", ")}.`);
      const sinceText = values.get("since");
      if (
        sinceText !== undefined &&
        (!sincePattern.test(sinceText) || !Number.isFinite(Date.parse(sinceText)))
      )
        throw invalid("since must be an ISO timestamp with a time and timezone.");
      const read = await readBriefing(readRuntime(served.project, served.repository), {
        repository: served.repository,
        // The human role names its human only explicitly (doc/design/human-briefing.md).
        agent:
          role === "human" && selection.identitySource !== "tool"
            ? undefined
            : (selection.agent ?? undefined),
        issue,
        since: sinceText === undefined ? undefined : new Date(sinceText).toISOString(),
        limit: integerParam(values, "limit", 1, 100, 10),
        maxChars: 10000,
        role,
        ...(section !== undefined ? { section } : {}),
        order: (order as PickupOrder | undefined) ?? "impact",
        signal,
      }).catch((error: unknown) => {
        // An ID the resolved role does not register is the caller's argument, not a failure.
        if (error instanceof BriefingArgumentError) throw invalid(error.message);
        throw error;
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
          ["agent", "entry", "harness", "role", "section", "order", "since", "limit"],
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
            await policyBoundaries(served, context.signal),
          );
          return { status: read.complete ? "complete" : "incomplete", result: read.report };
        });
        return true;
      }
      const ticketMatch = /^\/api\/v1\/tickets\/([1-9]\d{0,15})$/.exec(path);
      if (ticketMatch && Number.isSafeInteger(Number(ticketMatch[1]))) {
        const number = Number(ticketMatch[1]);
        // The consolidated ticket detail (#454, doc/design/consolidated-ticket-view.md): the
        // shared #197 `readTicketStatus` service, its `ticket-status` document unchanged.
        await dataRoute(
          context,
          "ticket",
          ["agent", "entry", "harness", "platform", "limitPrs"],
          number,
          async (values, served, setSelection) => {
            const platform = values.get("platform");
            if (platform !== undefined && !platformPattern.test(platform))
              throw invalid("platform must be a platform name such as claude-code.");
            const limitPrs = integerParam(
              values,
              "limitPrs",
              1,
              ticketLimits.maxPullRequests,
              ticketLimits.defaultPullRequests,
            );
            // Every argument is validated before identity resolution and before any read.
            const selection = await identity(values, served);
            setSelection(selection);
            if (!runtime.collectIssueFocus && !guardedQueryWith)
              throw new CollectionError("GITHUB_UNAVAILABLE", "No GitHub reader is configured.");
            const agent = selection.agent ?? undefined;
            let read: Awaited<ReturnType<typeof readTicketStatus>>;
            try {
              read = await cache.read<Awaited<ReturnType<typeof readTicketStatus>>>(
                {
                  repository: served.repository,
                  collector: "ticket",
                  coverage: {
                    n: number,
                    profile: "ticket-status-v1",
                    limitPrs,
                    agent: agent ?? null,
                    platform: platform ?? null,
                  },
                },
                async (inner) => {
                  const result = await readTicketStatus(
                    served.repository,
                    number,
                    {
                      staleHours: defaultStaleHours,
                      now: runtime.now(),
                      limitPrs,
                      signal: inner,
                      ...(agent ? { agent } : {}),
                      ...(platform ? { platform } : {}),
                      ...(guardedRest
                        ? {
                            locate: (repository: string, n: number) =>
                              locateIssue(repository, n, (p, o) =>
                                guardedRest(p, { ...o, signal: o?.signal ?? inner }),
                              ),
                          }
                        : {}),
                    },
                    await policyBoundaries(served, inner),
                    guardedQueryWith
                      ? guardedQueryWith(inner)
                      : async () => {
                          throw new CollectionError(
                            "GITHUB_UNAVAILABLE",
                            "No GitHub reader is configured.",
                          );
                        },
                    runtime.now,
                    runtime.collectIssueFocus ?? CollectIssueFocus,
                  );
                  // A quota refusal the read stopped on starts the shared cooldown before this
                  // collection slot is released, exactly as the who route does.
                  const quota = result.report.collection.quota;
                  if (quota) cache.noteQuotaRefusal(quota);
                  return result;
                },
                context.signal,
                // Only a complete answer is stored, and never one that stopped on quota.
                (result) => result.complete && !result.report.collection.quota,
              );
            } catch (error) {
              // A missing, transferred or inaccessible ticket keeps its diagnosis; a transfer is
              // never followed here (the CLI does not follow it either).
              if (!(error instanceof IssueUnavailable)) throw error;
              return {
                status: "incomplete",
                result: { schemaVersion: 1, kind: "issue-unavailable", ...error.diagnosis },
              };
            }
            return { status: read.complete ? "complete" : "incomplete", result: read.report };
          },
        );
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
            if (!guardedQueryWith)
              throw new CollectionError("GITHUB_UNAVAILABLE", "No GitHub reader is configured.");
            // The whole PR report is the cached fact result: it has no identity projection.
            const read = await cache.read<{ report: unknown; complete: boolean }>(
              {
                repository: served.repository,
                collector: history ? "pr-history" : "pr",
                coverage: { n: number },
              },
              async (inner): Promise<{ report: unknown; complete: boolean }> => {
                const result = await (history
                  ? readReviewHistory(
                      served.repository,
                      number,
                      guardedQueryWith!(inner),
                      runtime.now,
                    )
                  : readPullRequest(
                      served.repository,
                      number,
                      guardedQueryWith!(inner),
                      guardedRest
                        ? {
                            trust: markerTrust(
                              permissionLookup(served.repository, guardedRest, inner),
                            ),
                            trustWith: (rest: Rest) =>
                              markerTrust(permissionLookup(served.repository, rest, inner)),
                            live: {
                              query: guardedQueryWith!(inner),
                              rest: (p, o) => guardedRest!(p, { ...o, signal: o?.signal ?? inner }),
                            },
                            signal: inner,
                            reviewPolicy: await servedReviewPolicy(
                              projectReaders(runtime, served.project, served.repository),
                              served.repository,
                            ),
                          }
                        : {
                            reviewPolicy: await servedReviewPolicy(
                              projectReaders(runtime, served.project, served.repository),
                              served.repository,
                            ),
                          },
                      runtime.now,
                    ));
                // A quota refusal inside a PR read that still answered (delivery or permission
                // evidence left unknown) starts the shared cooldown too (#196 review).
                const quota = (
                  result.report as {
                    collection?: { quota?: Parameters<typeof cache.noteQuotaRefusal>[0] | null };
                  }
                ).collection?.quota;
                if (quota) cache.noteQuotaRefusal(quota);
                return result;
              },
              context.signal,
              // Its delivery evidence is read inside this whole result: an incomplete report
              // may only reflect a transient failure, so only a complete one is stored.
              (report) => report.complete,
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
            const skipped = report.unfollowed ?? [];
            // A capped, quota-stopped or unserved tree is partial (#196): same verdict as the CLI.
            const bounds = report.treeBounds;
            const truncated = report.tree && bounds?.complete !== true;
            const warnings = [
              ...(skipped.length
                ? [
                    `${skipped.length} dependency node(s) in repositories this server does not serve were not read: ${skipped.map((n) => `${n.repository}#${n.number}`).join(", ")}.`,
                  ]
                : []),
              ...(truncated
                ? bounds
                  ? [
                      treeIncompleteText(bounds),
                      ...(bounds.notRead ? [notReadText(bounds).trim()] : []),
                    ]
                  : [legacyTreeText]
                : []),
            ];
            return skipped.length || truncated
              ? { status: "incomplete", result: report, warnings }
              : { status: "complete", result: report };
          });
          return true;
        }
        if (sub === "/who") {
          await dataRoute(context, "who", ["staleHours"], number, async (values, served) => {
            const staleHours = positiveParam(values, "staleHours") ?? defaultStaleHours;
            const focus = runtime.collectIssueFocus ?? CollectIssueFocus;
            if (!runtime.collectIssueFocus && !guardedQueryWith)
              throw new CollectionError("GITHUB_UNAVAILABLE", "No GitHub reader is configured.");
            let read: { report: unknown; complete: boolean };
            try {
              // issue-detail-v1 (#367): only the ticket, its linked open PRs and its delivery
              // records; the whole report is the cached result, keyed by profile and options.
              read = await cache.read<Awaited<ReturnType<typeof readWhoLive>>>(
                {
                  repository: served.repository,
                  collector: "who",
                  coverage: {
                    n: number,
                    profile: "issue-detail-v1",
                    version: readProfiles["issue-detail-v1"].version,
                    staleHours,
                  },
                },
                async (inner) => {
                  const result = await readWhoLive(
                    served.repository,
                    number,
                    {
                      staleHours,
                      now: runtime.now(),
                      signal: inner,
                      ...(guardedRest
                        ? {
                            locate: (repository: string, n: number) =>
                              locateIssue(repository, n, (p, o) =>
                                guardedRest(p, { ...o, signal: o?.signal ?? inner }),
                              ),
                          }
                        : {}),
                    },
                    await policyBoundaries(served, inner),
                    guardedQueryWith
                      ? guardedQueryWith(inner)
                      : async () => {
                          throw new CollectionError(
                            "GITHUB_UNAVAILABLE",
                            "No GitHub reader is configured.",
                          );
                        },
                    runtime.now,
                    focus,
                  );
                  // A quota refusal the read stopped on (it returns an incomplete answer rather
                  // than throwing) starts the same cooldown as a thrown RateLimitError, before
                  // this collection slot is released.
                  const quota = result.report.collection.quota;
                  if (quota) cache.noteQuotaRefusal(quota);
                  return result;
                },
                context.signal,
                // Delivery is read inside this result: only a complete one is stored, and never
                // one that stopped on a quota refusal.
                (result) => result.complete && !result.report.collection.quota,
              );
            } catch (error) {
              // As the issue route: a missing, transferred or inaccessible issue is answered
              // with its diagnosis, never a server error.
              if (!(error instanceof IssueUnavailable)) throw error;
              return {
                status: "incomplete",
                result: { schemaVersion: 1, kind: "issue-unavailable", ...error.diagnosis },
              };
            }
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
            // Never read a repository outside the served set, even by following a transfer.
            if (
              diagnosis.state === "moved" &&
              follow &&
              !isServed(diagnosis.destination.repository)
            )
              return {
                status: "incomplete",
                result: { schemaVersion: 1, kind: "issue-unavailable", ...diagnosis },
                warnings: [
                  `Not following the transfer: ${diagnosis.destination.repository} is not served by this server. Restart pdb serve with --repo ${diagnosis.destination.repository} to read it.`,
                ],
              };
            if (
              diagnosis.state === "moved" &&
              follow &&
              Number.isSafeInteger(Number(diagnosis.destination.number))
            ) {
              const destination = await readBriefing(
                readRuntime(
                  servedSet.find(
                    (s) =>
                      s.repository.toLowerCase() === diagnosis.destination.repository.toLowerCase(),
                  )?.project,
                  diagnosis.destination.repository,
                ),
                {
                  repository: diagnosis.destination.repository,
                  agent: chosen?.agent ?? undefined,
                  issue: Number(diagnosis.destination.number),
                  limit: 10,
                  maxChars: 10000,
                  order: "impact",
                  signal: context.signal,
                },
              );
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
