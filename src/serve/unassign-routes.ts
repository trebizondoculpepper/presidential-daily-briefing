/**
 * Protected HTTP routes for Human-view Unassign (#588, doc/design/human-unassign.md).
 *
 * Disabled by default (`options.allowEdits !== true`); when enabled at server startup, requires
 * same-origin Origin, JSON Content-Type, bounded JSON body without unknown fields, HttpOnly
 * SameSite=Strict session cookie + matching X-PDB-CSRF header, literal served repository selection,
 * and verified serving-user write permission before any GitHub operation.
 */
import type { GhService } from "../github/service/service.js";
import { applyUnassign, previewUnassign, type UnassignApplyResult } from "../workflow/unassign.js";
import { selectRepository } from "./api.js";
import type { ServeCache } from "./cache.js";
import { HttpFailure, readJsonBody, sendJson } from "./http.js";
import { serviceMutation, type WriteOutcome } from "./mutations.js";
import type { ServeOptions } from "./options.js";
import type { Routes, ServeRuntime, ServerFacts } from "./types.js";
import { WriteSessionStore } from "./write-session.js";

const PREVIEW_FIELDS = new Set(["agent"]);
const APPLY_FIELDS = new Set([
  "operationId",
  "actor",
  "agent",
  "expectedClaimStart",
  "expectedRevision",
  "overrideUnknownHistory",
]);

function assertObjectWithAllowedKeys(
  raw: unknown,
  allowed: Set<string>,
  required: string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpFailure(400, "INVALID_ARGUMENT", "Request body must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", `Unknown request field: ${key}.`);
    }
  }
  for (const key of required) {
    if (!(key in obj)) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", `Missing required field: ${key}.`);
    }
  }
  return obj;
}

function unassignWriteOutcome(result: UnassignApplyResult): WriteOutcome {
  if (result.recordOutcome === "applied") {
    return result.status === "applied" ? "applied" : "partial";
  }
  if (result.status === "applied") return "applied";
  if (result.status === "noop") return "unchanged";
  if (result.status === "partial") return "partial";
  if (result.status === "unknown") return "unknown";
  return "refused";
}

function httpStatusForApply(result: UnassignApplyResult): number {
  if (result.status === "applied" || result.status === "noop") return 200;
  if (result.status === "partial" || result.status === "unknown") return 502;
  if (
    result.code === "CLAIM_REPLACED" ||
    result.code === "REVISION_CONFLICT" ||
    result.code === "OPERATION_CONFLICT"
  ) {
    return 409;
  }
  if (
    result.code === "PERMISSION_DENIED" ||
    result.code === "PERMISSION_UNKNOWN" ||
    result.code === "HUMAN_CONTEXT_REQUIRED"
  ) {
    return 403;
  }
  if (result.code === "TICKET_NOT_FOUND") return 404;
  return 400;
}

/** Build the protected Human-view Unassign routes for `pdb serve` (#588). */
export function unassignRoutes(
  options: ServeOptions,
  serve: ServeRuntime,
  cache: ServeCache,
  gh?: Pick<GhService, "account" | "tickets" | "repos" | "run">,
): (facts: ServerFacts) => Routes {
  const sessions = new WriteSessionStore(() => serve.clock.now().getTime());
  return (facts) => async (context) => {
    const path = context.url.pathname;
    const previewMatch = /^\/api\/v1\/tickets\/([1-9]\d*)\/unassign\/preview$/.exec(path);
    const applyMatch = /^\/api\/v1\/tickets\/([1-9]\d*)\/unassign$/.exec(path);
    const isSession = path === "/api/v1/session";
    if (!isSession && !previewMatch && !applyMatch) return false;

    if (context.request.method !== "POST") {
      throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use POST.", [], { allow: "POST" });
    }
    if (!options.allowEdits) {
      throw new HttpFailure(
        403,
        "EDITS_DISABLED",
        "Served edits are disabled; start pdb serve with --allow-edits to enable Human-view Unassign.",
      );
    }

    if (isSession) {
      if (!context.request.headers.origin) {
        throw new HttpFailure(
          403,
          "FORBIDDEN_ORIGIN",
          "Session bootstrap requires a same-origin Origin header.",
        );
      }
      await readJsonBody(context.request);
      const issued = sessions.issue(context.request.headers, context.url.protocol === "https:");
      sendJson(
        context.response,
        200,
        { kind: "write-session", csrfToken: issued.csrfToken },
        {
          "set-cookie": issued.cookieHeader,
        },
      );
      return true;
    }

    sessions.requireWriteAuthorization(context.request.headers);
    const repoParam = context.url.searchParams.get("repo") ?? undefined;
    const selected = selectRepository(facts.served, repoParam);
    const deps = {
      query: serve.unassign?.query ?? gh?.tickets,
      permission:
        serve.unassign?.permission?.(selected.repository) ??
        gh?.repos.permissionOf(selected.repository),
      run: serve.unassign?.run ?? gh?.run,
      ...(gh && !serve.unassign
        ? { resolveLogin: async () => (await gh.account.current()).login }
        : { actorLogin: facts.auth.login }),
    };

    if (previewMatch) {
      const number = Number(previewMatch[1]);
      const rawBody = await readJsonBody(context.request);
      const body = assertObjectWithAllowedKeys(rawBody, PREVIEW_FIELDS, ["agent"]);
      if (typeof body.agent !== "string" || !body.agent.trim()) {
        throw new HttpFailure(400, "INVALID_ARGUMENT", "agent must be a non-empty string.");
      }
      const preview = await previewUnassign(
        {
          repository: selected.repository,
          number,
          agent: body.agent.trim(),
          trustedHumanContext: true,
        },
        deps,
      );
      if (!preview.ok) {
        const status = preview.code === "TICKET_NOT_FOUND" ? 404 : 400;
        throw new HttpFailure(status, "INVALID_ARGUMENT", preview.message);
      }
      sendJson(context.response, 200, { kind: "human-unassign-preview", preview: preview.preview });
      return true;
    }

    const number = Number(applyMatch![1]);
    const rawBody = await readJsonBody(context.request);
    const body = assertObjectWithAllowedKeys(rawBody, APPLY_FIELDS, [
      "operationId",
      "actor",
      "agent",
      "expectedClaimStart",
      "expectedRevision",
    ]);
    const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
    const actor = typeof body.actor === "string" ? body.actor.trim() : "";
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const expectedClaimStart =
      body.expectedClaimStart === null
        ? null
        : typeof body.expectedClaimStart === "string"
          ? body.expectedClaimStart
          : undefined;
    const expectedRevision =
      typeof body.expectedRevision === "string" ? body.expectedRevision.trim() : "";
    const overrideUnknownHistory = body.overrideUnknownHistory === true;

    if (!operationId || !actor || !agent || expectedClaimStart === undefined || !expectedRevision) {
      throw new HttpFailure(
        400,
        "INVALID_ARGUMENT",
        "operationId, actor, agent, expectedClaimStart (string|null) and expectedRevision are required.",
      );
    }

    const intentKey = JSON.stringify({
      repository: selected.repository.toLowerCase(),
      number,
      actor,
      agent,
      expectedClaimStart,
      expectedRevision,
      overrideUnknownHistory,
    });
    const result = await sessions.runIdempotent(operationId, intentKey, () =>
      serviceMutation(
        cache,
        () =>
          applyUnassign(
            {
              repository: selected.repository,
              number,
              agent,
              actor,
              operationId,
              expectedClaimStart,
              expectedRevision,
              trustedHumanContext: true,
              overrideUnknownHistory,
            },
            deps,
          ),
        unassignWriteOutcome,
      ),
    );
    sendJson(context.response, httpStatusForApply(result), result);
    return true;
  };
}
