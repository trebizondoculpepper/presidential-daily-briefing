/** Explicit diagnostic-run API and adapters (#585); passive diagnostics stay unchanged. */
import { localDoctor, type LocalDoctorRuntime } from "../config/localdoctor.js";
import { resolveReviewPolicy } from "../config/review-setting.js";
import { metricStatus } from "../estimation/complexitylabels.js";
import { impactMetric } from "../estimation/metrics.js";
import { ReadMeter } from "../github/readplan.js";
import type { Query, Rest } from "../github/github.js";
import { permissionLookup } from "../github/github.js";
import { markerTrust } from "../workflow/delivery.js";
import { doctorStaleHours } from "../workflow/ticketdoctor.js";
import { readTicketDoctor } from "../workflow/readservices.js";
import { localPaths, redactLocalText, redactPaths } from "../mcp/redact.js";
import { projectReaders, selectRepository, servedOnlyQuery, servedOnlyRest } from "./api.js";
import { DiagnosticRuns } from "./runs.js";
import type { RunContext, RunRequest } from "./runs.js";
import { HttpFailure, readJsonBody, sendJson } from "./http.js";
import { CollectionError } from "./cache.js";
import type { ServeCache } from "./cache.js";
import type { Routes, ServerFacts, ServeReadRuntime, ServeRuntime } from "./types.js";

const prefix = "/api/v1/diagnostic-runs";
const invalid = (message: string) => new HttpFailure(400, "INVALID_ARGUMENT", message);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Give a JSON object.");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid(`Only ${allowed.join(", ")} are accepted.`);
};

/** Registered repositories and CLI option ranges only; never a path, executable or command. */
export function diagnosticRunRequest(raw: unknown, facts: Pick<ServerFacts, "served">): RunRequest {
  const body = object(raw);
  keys(body, ["kind", "repo", "options"]);
  if (body.kind !== "doctor" && body.kind !== "ticket-doctor")
    throw invalid("kind must be doctor or ticket-doctor.");
  if (
    body.repo !== null &&
    body.repo !== undefined &&
    (typeof body.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(body.repo))
  )
    throw invalid("repo must be owner/name.");
  if (body.kind === "ticket-doctor" && (body.repo === null || body.repo === undefined))
    throw new HttpFailure(
      400,
      "PROJECT_REQUIRED",
      "Select a registered project for Ticket Doctor.",
    );
  const selected = typeof body.repo === "string" ? selectRepository(facts.served, body.repo) : null;
  const options = body.options === undefined ? {} : object(body.options);
  keys(options, body.kind === "doctor" ? [] : ["staleHours", "limit"]);
  if (body.kind === "doctor")
    return { kind: body.kind, repo: selected?.repository ?? null, options: {} };
  const staleHours = options.staleHours === undefined ? doctorStaleHours : options.staleHours,
    limit = options.limit === undefined ? 30 : options.limit;
  if (typeof staleHours !== "number" || !Number.isFinite(staleHours) || staleHours <= 0)
    throw invalid("staleHours must be a positive number.");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
    throw invalid("limit must be a positive integer.");
  return { kind: body.kind, repo: selected!.repository, options: { staleHours, limit } };
}
function latestRequest(url: URL, facts: ServerFacts): RunRequest {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!["kind", "repo", "staleHours", "limit"].includes(key) || Object.hasOwn(query, key))
      throw invalid("Give each supported latest parameter once.");
    query[key] = value;
  }
  return diagnosticRunRequest(
    {
      kind: query.kind,
      repo: query.repo,
      options: {
        ...(query.staleHours !== undefined ? { staleHours: Number(query.staleHours) } : {}),
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
      },
    },
    facts,
  );
}

/** Local Doctor diagnostics may name unknown paths; GitHub-authored ticket text keeps its meaning. */
function redactReport<T>(value: T, known: string[]): T {
  const clean = redactPaths(value, known);
  const local =
    !!clean &&
    typeof clean === "object" &&
    "scope" in clean &&
    clean.scope === "local-configuration";
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactLocalText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v)]));
    return item;
  };
  // Progress is host-generated too. Ticket Doctor reports are GitHub evidence, not local errors.
  return (
    local || (!!clean && typeof clean === "object" && "step" in clean) ? walk(clean) : clean
  ) as T;
}

/** Bound once to the serving process; every execution stays within registered read services. */
export function diagnosticRunServices(
  facts: ServerFacts,
  serve: ServeRuntime,
  read: ServeReadRuntime,
  cache: ServeCache,
  services?: { git?: LocalDoctorRuntime["git"]; gh?: LocalDoctorRuntime["gh"] },
) {
  const isServed = (repo: string) =>
    facts.served.some((p) => p.repository.toLowerCase() === repo.toLowerCase());
  const queryWith = read.queryWith && servedOnlyQuery(read.queryWith, isServed);
  const rest = read.rest && servedOnlyRest(read.rest, isServed);
  const known = localPaths(...facts.served.map((p) => p.project));
  const heldContext = (request: RunRequest): RunContext => {
    const auth = cache.currentVerifiedAuth();
    return {
      host: auth?.host ?? cache.currentAuth().host,
      login: auth?.login ?? null,
      repository: request.repo,
    };
  };
  const runs = new DiagnosticRuns({
    clock: serve.clock,
    redact: (value) => redactReport(value, known),
    execute: async (request, context, signal, onStep) => {
      const selected = request.repo ? selectRepository(facts.served, request.repo) : null;
      if (request.kind === "doctor") {
        const git = services?.git ?? (typeof serve.git === "object" ? serve.git : undefined);
        const gh = services?.gh;
        const result = await localDoctor(selected ? { repo: selected.repository } : {}, {
          ...(!serve.doctor?.probe && git ? { git } : {}),
          ...(!serve.doctor?.probe && gh ? { gh } : {}),
          ...serve.doctor,
          env: serve.doctor?.env ?? read.env,
          cwd: selected?.project ?? serve.cwd ?? process.cwd(),
          signal,
          onStep,
          projectUnavailable: selected?.project
            ? undefined
            : selected
              ? "This registered project has no local checkout; project and identity checks were skipped."
              : "Select a registered project with a local checkout for project and identity checks.",
        });
        return {
          result,
          complete: !result.checks.some(
            (c) => c.status === "unknown" || c.status === "unsupported",
          ),
        };
      }
      if (!selected) throw new HttpFailure(400, "PROJECT_REQUIRED", "Select a registered project.");
      const before = cache.currentVerifiedAuth();
      if (!before || before.host !== context.host || before.login !== context.login)
        throw new HttpFailure(
          503,
          "CACHE_INVALIDATED",
          "The verified login changed before the run started.",
        );
      const tracked = await cache.track(true, () =>
        cache.read(
          {
            repository: selected.repository,
            collector: "diagnostic-ticket-doctor",
            coverage: request.options,
          },
          async (inner) => {
            signal.throwIfAborted();
            inner.throwIfAborted();
            // Auth can change while the shared collection budget is occupied by other reads.
            const admitted = cache.currentVerifiedAuth();
            if (!admitted || admitted.host !== context.host || admitted.login !== context.login)
              throw new CollectionError(
                "CACHE_INVALIDATED",
                "The verified login changed while this run waited.",
              );
            onStep({ step: "collect", state: "running", detail: null });
            const meter = new ReadMeter(
              "compatibility-full-v1",
              "ticket-doctor",
              read.now,
              undefined,
              inner,
            );
            let notified = false;
            const observeQuota = () => {
              if (notified || !meter.refused || inner.aborted) return;
              const quota = meter.collection().quota;
              if (quota) {
                cache.noteQuotaRefusal(quota);
                notified = true;
              }
            };
            const rawQuery = queryWith?.(inner);
            const measuredQuery =
              rawQuery && meter.query(rawQuery, "ticket-doctor", selected.repository);
            const query: Query | undefined = measuredQuery
              ? async (source, variables) => {
                  try {
                    return await measuredQuery(source, variables);
                  } finally {
                    observeQuota();
                  }
                }
              : undefined;
            const rawRest: Rest | undefined = rest
              ? (path, options) => rest(path, { ...options, signal: inner })
              : undefined;
            const measuredRest =
              rawRest && meter.rest(rawRest, "ticket-doctor", selected.repository);
            const liveRest: Rest | undefined = measuredRest
              ? async (path, options) => {
                  try {
                    return await measuredRest(path, options);
                  } finally {
                    observeQuota();
                  }
                }
              : undefined;
            const snapshot = await read.collect(
              selected.repository,
              { signal: inner, ...(liveRest ? { rest: liveRest } : {}) },
              query,
              read.now,
            );
            inner.throwIfAborted();
            if (snapshot.repository.toLowerCase() !== selected.repository.toLowerCase())
              throw new CollectionError(
                "CACHE_INVALIDATED",
                "The collector returned a different repository.",
              );
            onStep({
              step: "collect",
              state: "done",
              detail: `${snapshot.issues.length} open tickets collected`,
            });
            const readers = projectReaders(read, selected.project, selected.repository);
            snapshot.reviewPolicy = await resolveReviewPolicy(
              selected.repository,
              readers.guide ?? {},
            );
            const impact = await metricStatus(
              impactMetric,
              selected.repository,
              readers.estimation,
            ).catch(() => "unknown" as const);
            inner.throwIfAborted();
            const result = await readTicketDoctor(
              snapshot,
              {
                staleHours: request.options.staleHours!,
                limit: request.options.limit!,
                now: read.now(),
                offline: false,
                impactEnabled: impact !== "disabled",
              },
              {
                signal: inner,
                onStep,
                ...(liveRest && query
                  ? {
                      trust: markerTrust(permissionLookup(selected.repository, liveRest, inner)),
                      live: { query, rest: liveRest },
                    }
                  : {}),
              },
            );
            return {
              result: result.report,
              complete: result.complete,
              quotaRefused: meter.refused,
            };
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      const auth = cache.currentVerifiedAuth();
      if (!auth || auth.host !== context.host || auth.login !== context.login)
        throw new HttpFailure(
          503,
          "CACHE_INVALIDATED",
          "The run's verified read context changed; run it again.",
        );
      if (tracked.freshness.some((f) => f.refreshError?.code === "GITHUB_RATE_LIMITED"))
        throw new HttpFailure(
          429,
          "GITHUB_RATE_LIMITED",
          "GitHub quota prevented a fresh diagnostic run.",
        );
      if (tracked.freshness.some((f) => f.stale))
        throw new HttpFailure(503, "CACHE_INVALIDATED", "No fresh diagnostic result is available.");
      return tracked.value;
    },
  });
  const routes: Routes = async (context) => {
    const path = context.url.pathname;
    if (path !== prefix && !path.startsWith(prefix + "/")) return false;
    const method = context.request.method;
    if (path === prefix) {
      if (method !== "POST")
        throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use POST to run diagnostics.", [], {
          allow: "POST",
        });
      if (context.url.search) throw invalid("The run request takes JSON, not query parameters.");
      const request = diagnosticRunRequest(await readJsonBody(context.request), facts);
      context.signal.throwIfAborted();
      const verified = await cache.verifiedAuth(false);
      context.signal.throwIfAborted();
      if (!verified.auth && request.kind === "ticket-doctor")
        throw new HttpFailure(
          503,
          "GITHUB_UNAVAILABLE",
          "Verify gh authentication on the server before running Ticket Doctor.",
          ["gh auth status"],
        );
      const status = runs.start(request, heldContext(request));
      const abort = () => runs.cancel(status.waiterId!);
      const remove = () => context.signal.removeEventListener("abort", abort);
      context.signal.addEventListener("abort", abort, { once: true });
      context.response.once("finish", remove);
      context.response.once("close", remove);
      sendJson(context.response, 202, status);
      return true;
    }
    if (path === prefix + "/latest") {
      if (method !== "GET" && method !== "HEAD")
        throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET.", [], { allow: "GET, HEAD" });
      const request = latestRequest(context.url, facts);
      sendJson(context.response, 200, runs.latest(request, heldContext(request)));
      return true;
    }
    const match = /^\/api\/v1\/diagnostic-runs\/waiters\/([A-Za-z0-9-]{1,100})$/.exec(path);
    if (!match) throw new HttpFailure(404, "NOT_FOUND", "No such diagnostic route.");
    if (context.url.search) throw invalid("Waiter routes take no query parameters.");
    if (method === "GET" || method === "HEAD") {
      sendJson(context.response, 200, runs.get(match[1]));
      return true;
    }
    if (method === "DELETE") {
      runs.cancel(match[1]);
      context.response.writeHead(204, { "cache-control": "no-store" });
      context.response.end();
      return true;
    }
    throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use GET or DELETE for this waiter.", [], {
      allow: "GET, HEAD, DELETE",
    });
  };
  return { runs, routes, close: () => runs.close() };
}
