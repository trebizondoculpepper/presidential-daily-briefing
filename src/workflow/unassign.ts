/**
 * Shared native Human-view Unassign preview/apply service (#588, doc/design/human-unassign.md).
 *
 * Releases only the selected agent claim (`agent:NAME` label) after recording explicit human
 * unassign intent, while preserving all human assignees, ticket state, readiness labels,
 * blockers, questions, estimates, work links and other agents' claims.
 */
import { createHash } from "node:crypto";
import { isAgentName } from "../config/identity.js";
import { ghAuthContext } from "../github/ghauth.js";
import { ghRun } from "../github/dependencies.js";
import { ghQuery, permissionLookup, type PermissionLookup, type Query } from "../github/github.js";
import type { TicketReads } from "../github/service/tickets.js";
import { issueWrites, type WriteRun } from "../github/service/issuewrites.js";
import type { UnassignDecision, UnassignPermission } from "../rules/datalog/unassign.js";
import {
  claimPolicy,
  claimStart,
  commentHistory,
  newestTrusted,
  reaches,
  readTicket,
  ticketGuard,
  type Comment,
} from "./claims.js";

const UNASSIGN_MARKER_PREFIX = "<!-- github-triage:human-unassign v1 ";
const UNASSIGN_MARKER_SUFFIX = " -->";

export interface HumanUnassignMarker {
  operationId: string;
  repository: string;
  number: number;
  agent: string;
  claimStart: string | null;
  actor: string;
  expectedRevision: string;
  overrideUnknownHistory?: boolean;
}

/** Parse a `human-unassign` hidden marker from a ticket comment body (#588). */
export function parseHumanUnassignMarker(body: string): HumanUnassignMarker | null {
  const start = body.indexOf(UNASSIGN_MARKER_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(UNASSIGN_MARKER_SUFFIX, start + UNASSIGN_MARKER_PREFIX.length);
  if (end < 0) return null;
  const raw = body.slice(start + UNASSIGN_MARKER_PREFIX.length, end).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<HumanUnassignMarker>;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.repository !== "string" ||
      typeof parsed.number !== "number" ||
      typeof parsed.agent !== "string" ||
      typeof parsed.actor !== "string" ||
      typeof parsed.expectedRevision !== "string"
    )
      return null;
    return {
      operationId: parsed.operationId,
      repository: parsed.repository,
      number: parsed.number,
      agent: parsed.agent,
      claimStart: typeof parsed.claimStart === "string" ? parsed.claimStart : null,
      actor: parsed.actor,
      expectedRevision: parsed.expectedRevision,
      ...(typeof parsed.overrideUnknownHistory === "boolean"
        ? { overrideUnknownHistory: parsed.overrideUnknownHistory }
        : {}),
    };
  } catch {
    return null;
  }
}

export function formatHumanUnassignComment(marker: HumanUnassignMarker): string {
  const claimNote = marker.claimStart ? ` (claimed ${marker.claimStart})` : "";
  const overrideLine = marker.overrideUnknownHistory
    ? "\nOverride: unknown claim history acknowledged by human.\n"
    : "";
  return [
    `Human unassign intent by \`${marker.actor}\`: releasing claim for \`${marker.agent}\`${claimNote} (removing \`agent:${marker.agent}\` next).`,
    overrideLine,
    "Preserved: human assignees, ticket state, readiness labels, blockers, questions and work links.",
    "",
    `${UNASSIGN_MARKER_PREFIX}${JSON.stringify(marker)}${UNASSIGN_MARKER_SUFFIX}`,
  ].join("\n");
}

export interface UnassignDependencies {
  query?: Query | TicketReads;
  permission?: PermissionLookup;
  run?: WriteRun;
  /** Authenticated serving user login passed to `permission(login)` (#588). */
  actorLogin?: string;
  resolveLogin?: () => Promise<string | null>;
}

export interface UnassignPreviewRequest {
  repository: string;
  number: number;
  agent: string;
  trustedHumanContext: boolean;
  overrideUnknownHistory?: boolean;
}

export interface UnassignPreservedState {
  state: "OPEN" | "CLOSED";
  humanAssignees: string[];
  labels: string[];
  otherAgents: string[];
}

export interface UnassignPreviewResult {
  kind: "human-unassign-preview";
  repository: string;
  number: number;
  url: string;
  title: string;
  agent: string;
  claimPresent: boolean;
  claimStart: string | null;
  claimHistoryComplete: boolean;
  preserved: UnassignPreservedState;
  revision: string;
  decision: UnassignDecision;
  confirmationNote: string;
}

export interface UnassignApplyRequest {
  repository: string;
  number: number;
  agent: string;
  actor: string;
  operationId: string;
  expectedClaimStart: string | null;
  expectedRevision: string;
  trustedHumanContext: boolean;
  overrideUnknownHistory?: boolean;
}

export type UnassignApplyStatus = "applied" | "noop" | "refused" | "partial" | "unknown";

export interface UnassignApplyResult {
  kind: "human-unassign-result";
  status: UnassignApplyStatus;
  code:
    | "UNASSIGN_APPLIED"
    | "UNASSIGN_NOOP"
    | "CLAIM_REPLACED"
    | "REVISION_CONFLICT"
    | "OPERATION_CONFLICT"
    | "MARKER_UNVERIFIED"
    | "INVALID_INPUT"
    | "TICKET_NOT_FOUND"
    | "NOT_AN_ISSUE"
    | "WRITE_PARTIAL"
    | "WRITE_UNKNOWN"
    | UnassignDecision["code"];
  operationId: string;
  repository: string;
  number: number;
  agent: string;
  claimStart: string | null;
  revision: string | null;
  recordOutcome: "applied" | "kept" | "failed" | "not-attempted" | "unknown";
  labelOutcome: "removed" | "absent" | "failed" | "not-attempted" | "unknown";
  preserved: UnassignPreservedState | null;
  message: string;
  error: string | null;
  next: string[];
}

function computeRevision(input: {
  repository: string;
  number: number;
  state: string;
  agent: string;
  claimPresent: boolean;
  claimStart: string | null;
  claimHistoryComplete: boolean;
  labels: string[];
  humanAssignees: string[];
}): string {
  const canonical = JSON.stringify({
    ...input,
    labels: [...input.labels].sort(),
    humanAssignees: [...input.humanAssignees].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

async function resolvePermissionState(
  permission: PermissionLookup,
  deps: UnassignDependencies,
): Promise<UnassignPermission> {
  try {
    const login =
      deps.actorLogin ??
      (deps.resolveLogin ? await deps.resolveLogin() : (await ghAuthContext()).login);
    if (!login || login.includes("/")) return "unknown";
    const level = await permission(login);
    if (level === "admin" || level === "maintain" || level === "write") return "allow";
    if (level === "triage" || level === "read" || level === "none") return "deny";
    return "unknown";
  } catch {
    return "unknown";
  }
}

interface TicketSnapshot {
  ok: true;
  url: string;
  title: string;
  claimPresent: boolean;
  claimStart: string | null;
  claimHistoryComplete: boolean;
  preserved: UnassignPreservedState;
  revision: string;
  comments: Comment[];
}

type TicketSnapshotOrError =
  | TicketSnapshot
  | { ok: false; code: "TICKET_NOT_FOUND" | "NOT_AN_ISSUE"; message: string };

async function readUnassignSnapshot(
  repository: string,
  number: number,
  agent: string,
  query: Query | TicketReads,
): Promise<TicketSnapshotOrError> {
  const mine = claimPolicy.owner(agent);
  const ticket = await readTicket(repository, number, agent, query, "", claimPolicy.incomplete);
  const item = ticket.item;
  if (!item) {
    return {
      ok: false,
      code: "TICKET_NOT_FOUND",
      message: `Issue #${number} was not found in ${repository}.`,
    };
  }
  if (item.__typename !== "Issue") {
    return {
      ok: false,
      code: "NOT_AN_ISSUE",
      message: `#${number} is not an issue; claims live on issues only.`,
    };
  }
  const labels = item.labels.nodes.map((l) => l.name);
  const labelsComplete = !item.labels.pageInfo?.hasNextPage;
  const assigneesComplete = !item.assignees?.pageInfo?.hasNextPage;
  const humanAssignees = (item.assignees?.nodes ?? [])
    .map((a) => a.login)
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  const claimPresent = labels.includes(mine);
  const history = await claimStart(repository, number, mine, item, query);
  const since = history.since;
  const claimHistoryComplete = history.complete && labelsComplete && assigneesComplete;
  const recorded = since
    ? await commentHistory(repository, number, item, reaches(since), query)
    : { comments: item.comments.nodes, complete: true };
  const ownerPrefix = claimPolicy.owner("");
  const otherAgents = labels
    .filter((o) => o.startsWith(ownerPrefix) && o !== mine)
    .map((o) => o.slice(ownerPrefix.length));
  const preserved: UnassignPreservedState = {
    state: item.state === "CLOSED" ? "CLOSED" : "OPEN",
    humanAssignees,
    labels,
    otherAgents,
  };
  const revision = computeRevision({
    repository,
    number,
    state: preserved.state,
    agent,
    claimPresent,
    claimStart: since,
    claimHistoryComplete: claimHistoryComplete && recorded.complete,
    labels,
    humanAssignees,
  });
  return {
    ok: true,
    url: item.url,
    title: item.title,
    claimPresent,
    claimStart: since,
    claimHistoryComplete: claimHistoryComplete && recorded.complete,
    preserved,
    revision,
    comments: recorded.comments,
  };
}

/** Preview a Human-view Unassign operation without mutating GitHub (#588). */
export async function previewUnassign(
  request: UnassignPreviewRequest,
  deps: UnassignDependencies = {},
): Promise<
  | { ok: true; preview: UnassignPreviewResult }
  | { ok: false; code: "INVALID_INPUT" | "TICKET_NOT_FOUND" | "NOT_AN_ISSUE"; message: string }
> {
  if (!Number.isInteger(request.number) || request.number <= 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Issue number must be a positive integer.",
    };
  }
  if (!isAgentName(request.agent)) {
    return { ok: false, code: "INVALID_INPUT", message: `Invalid agent name: ${request.agent}` };
  }
  const query = deps.query ?? ghQuery;
  const permission = deps.permission ?? permissionLookup(request.repository);
  const snap = await readUnassignSnapshot(request.repository, request.number, request.agent, query);
  if (!snap.ok) return snap;
  const permState = await resolvePermissionState(permission, deps);
  const { evaluateUnassignDecision } = await import("../rules/datalog/datalog.js");
  const decision = evaluateUnassignDecision({
    issueNumber: request.number,
    issueState: snap.preserved.state,
    agent: request.agent,
    claimPresent: snap.claimPresent,
    claimStart: snap.claimStart,
    claimHistoryComplete: snap.claimHistoryComplete,
    trustedHumanContext: request.trustedHumanContext,
    permission: permState,
    overrideUnknownHistory: Boolean(request.overrideUnknownHistory),
  });
  return {
    ok: true,
    preview: {
      kind: "human-unassign-preview",
      repository: request.repository,
      number: request.number,
      url: snap.url,
      title: snap.title,
      agent: request.agent,
      claimPresent: snap.claimPresent,
      claimStart: snap.claimStart,
      claimHistoryComplete: snap.claimHistoryComplete,
      preserved: snap.preserved,
      revision: snap.revision,
      decision,
      confirmationNote:
        "Releasing this agent claim will preserve all human assignees, ticket state, readiness labels, blockers, questions and estimates.",
    },
  };
}

async function findTrustedMatchingMarker(
  comments: Comment[],
  operationId: string,
  permission: PermissionLookup,
): Promise<{ marker: HumanUnassignMarker | null; unverified: string[] }> {
  const candidates: { comment: Comment; marker: HumanUnassignMarker }[] = [];
  for (const comment of comments) {
    const marker = parseHumanUnassignMarker(comment.body ?? "");
    if (marker && marker.operationId === operationId) {
      candidates.push({ comment, marker });
    }
  }
  if (!candidates.length) return { marker: null, unverified: [] };
  const verdicts = await newestTrusted(candidates, (c) => c.comment, permission);
  return {
    marker: verdicts.trusted?.marker ?? null,
    unverified: verdicts.unverified,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute a confirmed Human-view Unassign: re-read live facts, evaluate native rules, record
 * unassign intent first, and remove only `agent:NAME` while preserving human assignees & state.
 */
export async function applyUnassign(
  request: UnassignApplyRequest,
  deps: UnassignDependencies = {},
): Promise<UnassignApplyResult> {
  const base = {
    kind: "human-unassign-result" as const,
    operationId: request.operationId,
    repository: request.repository,
    number: request.number,
    agent: request.agent,
  };
  if (
    !Number.isInteger(request.number) ||
    request.number <= 0 ||
    !isAgentName(request.agent) ||
    !request.actor.trim() ||
    !request.operationId.trim() ||
    !request.expectedRevision.trim()
  ) {
    return {
      ...base,
      status: "refused",
      code: "INVALID_INPUT",
      claimStart: request.expectedClaimStart,
      revision: null,
      recordOutcome: "not-attempted",
      labelOutcome: "not-attempted",
      preserved: null,
      message:
        "Unassign requires valid issue number, agent, explicit actor, operationId and expectedRevision.",
      error: null,
      next: ["Refresh the Human view and open the Unassign confirmation again."],
    };
  }

  const query = deps.query ?? ghQuery;
  const permission = deps.permission ?? permissionLookup(request.repository);
  const run = deps.run ?? ghRun;

  const snap = await readUnassignSnapshot(request.repository, request.number, request.agent, query);
  if (!snap.ok) {
    return {
      ...base,
      status: "refused",
      code: snap.code,
      claimStart: request.expectedClaimStart,
      revision: null,
      recordOutcome: "not-attempted",
      labelOutcome: "not-attempted",
      preserved: null,
      message: snap.message,
      error: null,
      next: ["Inspect the repository issue directly."],
    };
  }

  const recovered = await findTrustedMatchingMarker(snap.comments, request.operationId, permission);
  if (!recovered.marker && recovered.unverified.length) {
    return {
      ...base,
      status: "refused",
      code: "MARKER_UNVERIFIED",
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome: "unknown",
      labelOutcome: snap.claimPresent ? "not-attempted" : "absent",
      preserved: snap.preserved,
      message: `A matching unassign record for operationId ${request.operationId} could not be verified (${recovered.unverified.join("; ")}); refusing to recover without trusted authority.`,
      error: null,
      next: ["Inspect the comment history on GitHub and confirm with a fresh operation."],
    };
  }
  const existingMarker = recovered.marker;
  if (existingMarker) {
    if (
      existingMarker.repository.toLowerCase() !== request.repository.toLowerCase() ||
      existingMarker.number !== request.number ||
      existingMarker.agent !== request.agent ||
      existingMarker.claimStart !== request.expectedClaimStart ||
      existingMarker.actor !== request.actor.trim() ||
      existingMarker.expectedRevision !== request.expectedRevision ||
      Boolean(existingMarker.overrideUnknownHistory) !== Boolean(request.overrideUnknownHistory)
    ) {
      return {
        ...base,
        status: "refused",
        code: "OPERATION_CONFLICT",
        claimStart: snap.claimStart,
        revision: snap.revision,
        recordOutcome: "kept",
        labelOutcome: snap.claimPresent ? "not-attempted" : "absent",
        preserved: snap.preserved,
        message:
          "The supplied operationId was already used for a different claim; refusing to reuse it.",
        error: null,
        next: ["Refresh the ticket and confirm with a fresh operation."],
      };
    }
    if (!snap.claimPresent) {
      return {
        ...base,
        status: "noop",
        code: "UNASSIGN_NOOP",
        claimStart: snap.claimStart,
        revision: snap.revision,
        recordOutcome: "kept",
        labelOutcome: "absent",
        preserved: snap.preserved,
        message: `Operation ${request.operationId} already completed: agent:${request.agent} is absent and human owners/state were preserved.`,
        error: null,
        next: [],
      };
    }
  }

  // Newer/replaced claim is ALWAYS a conflict — never remove a claim whose start changed.
  if (snap.claimPresent && snap.claimStart !== request.expectedClaimStart) {
    return {
      ...base,
      status: "refused",
      code: "CLAIM_REPLACED",
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome: "not-attempted",
      labelOutcome: "not-attempted",
      preserved: snap.preserved,
      message: `Claim for ${request.agent} changed since preview (was ${request.expectedClaimStart ?? "unknown"}, now ${snap.claimStart ?? "unknown"}); refusing to release the newer claim.`,
      error: null,
      next: ["Refresh the Human view and preview the current claim before confirming again."],
    };
  }

  const permState = await resolvePermissionState(permission, deps);
  const { evaluateUnassignDecision } = await import("../rules/datalog/datalog.js");
  const decision = evaluateUnassignDecision({
    issueNumber: request.number,
    issueState: snap.preserved.state,
    agent: request.agent,
    claimPresent: snap.claimPresent,
    claimStart: snap.claimStart,
    claimHistoryComplete: snap.claimHistoryComplete,
    trustedHumanContext: request.trustedHumanContext,
    permission: permState,
    overrideUnknownHistory: Boolean(request.overrideUnknownHistory),
  });

  if (decision.verdict === "noop") {
    return {
      ...base,
      status: "noop",
      code: "UNASSIGN_NOOP",
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome: existingMarker ? "kept" : "not-attempted",
      labelOutcome: "absent",
      preserved: snap.preserved,
      message: decision.reason,
      error: null,
      next: [],
    };
  }

  if (decision.verdict === "refuse") {
    return {
      ...base,
      status: "refused",
      code: decision.code,
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome: existingMarker ? "kept" : "not-attempted",
      labelOutcome: "not-attempted",
      preserved: snap.preserved,
      message: decision.reason,
      error: null,
      next: ["Resolve the precondition above, refresh the Human view and retry."],
    };
  }

  // If this is a fresh attempt (no prior matching record) and the ticket revision changed since
  // preview, refuse cleanly with REVISION_CONFLICT so the user sees the updated state first.
  if (!existingMarker && snap.revision !== request.expectedRevision) {
    return {
      ...base,
      status: "refused",
      code: "REVISION_CONFLICT",
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome: "not-attempted",
      labelOutcome: "not-attempted",
      preserved: snap.preserved,
      message: `Issue #${request.number} changed since preview; refresh and inspect the current state before unassigning.`,
      error: null,
      next: ["Refresh the Human view and preview again."],
    };
  }

  const writes = issueWrites(run);
  const guard = ticketGuard(request.repository, request.number, query);
  const mine = claimPolicy.owner(request.agent);

  let recordOutcome: UnassignApplyResult["recordOutcome"] = existingMarker
    ? "kept"
    : "not-attempted";
  if (!existingMarker) {
    const body = formatHumanUnassignComment({
      operationId: request.operationId,
      repository: request.repository,
      number: request.number,
      agent: request.agent,
      claimStart: snap.claimStart,
      actor: request.actor.trim(),
      expectedRevision: request.expectedRevision,
      overrideUnknownHistory: Boolean(request.overrideUnknownHistory),
    });
    try {
      await writes.apply(
        { kind: "comment", repository: request.repository, number: request.number, body },
        { guard },
      );
      recordOutcome = "applied";
    } catch (error) {
      return {
        ...base,
        status: "unknown",
        code: "WRITE_UNKNOWN",
        claimStart: snap.claimStart,
        revision: snap.revision,
        recordOutcome: "unknown",
        labelOutcome: "not-attempted",
        preserved: snap.preserved,
        message:
          "Recording the unassign comment did not complete cleanly; inspect the issue before retrying.",
        error: errorMessage(error),
        next: [
          `Inspect #${request.number} in ${request.repository} for operationId ${request.operationId} before retrying.`,
        ],
      };
    }
  }

  // Revalidate claim-start identity after recording intent and immediately before label removal
  // so a claim reacquired mid-flight is never deleted as if it were the previewed claim (#588).
  if (!existingMarker) {
    let preRemoval: TicketSnapshotOrError;
    try {
      preRemoval = await readUnassignSnapshot(
        request.repository,
        request.number,
        request.agent,
        query,
      );
    } catch (error) {
      return {
        ...base,
        status: "partial",
        code: "WRITE_PARTIAL",
        claimStart: snap.claimStart,
        revision: snap.revision,
        recordOutcome,
        labelOutcome: "not-attempted",
        preserved: snap.preserved,
        message:
          "Unassign intent was recorded, but revalidating the claim before label removal failed.",
        error: errorMessage(error),
        next: [`Inspect #${request.number} in ${request.repository} before retrying.`],
      };
    }
    if (!preRemoval.ok) {
      return {
        ...base,
        status: "partial",
        code: "WRITE_PARTIAL",
        claimStart: snap.claimStart,
        revision: snap.revision,
        recordOutcome,
        labelOutcome: "not-attempted",
        preserved: snap.preserved,
        message:
          "Unassign intent was recorded, but revalidating the claim before label removal failed.",
        error: preRemoval.message,
        next: [`Inspect #${request.number} in ${request.repository} before retrying.`],
      };
    }
    if (!preRemoval.claimPresent) {
      return {
        ...base,
        status: "noop",
        code: "UNASSIGN_NOOP",
        claimStart: preRemoval.claimStart,
        revision: preRemoval.revision,
        recordOutcome,
        labelOutcome: "absent",
        preserved: preRemoval.preserved,
        message: `Unassign intent was recorded and ${mine} is already absent on #${request.number}.`,
        error: null,
        next: [],
      };
    }
    if (preRemoval.claimStart !== request.expectedClaimStart) {
      return {
        ...base,
        status: "refused",
        code: "CLAIM_REPLACED",
        claimStart: preRemoval.claimStart,
        revision: preRemoval.revision,
        recordOutcome,
        labelOutcome: "not-attempted",
        preserved: preRemoval.preserved,
        message: `Claim for ${request.agent} changed while recording unassign intent (was ${request.expectedClaimStart ?? "unknown"}, now ${preRemoval.claimStart ?? "unknown"}); refusing to remove the replacement claim.`,
        error: null,
        next: ["Refresh the Human view and preview the current claim before confirming again."],
      };
    }
  }

  let labelOutcome: UnassignApplyResult["labelOutcome"] = "not-attempted";
  try {
    await writes.apply(
      {
        kind: "labels-edit",
        repository: request.repository,
        number: request.number,
        add: [],
        remove: [mine],
      },
      { guard },
    );
    labelOutcome = "removed";
  } catch (error) {
    return {
      ...base,
      status: "partial",
      code: "WRITE_PARTIAL",
      claimStart: snap.claimStart,
      revision: snap.revision,
      recordOutcome,
      labelOutcome: "unknown",
      preserved: snap.preserved,
      message: `Unassign intent was recorded (${recordOutcome}), but removing label ${mine} did not complete cleanly (outcome unknown). Re-running with the same operationId and claimStart will complete label removal safely.`,
      error: errorMessage(error),
      next: [`Retry with operationId ${request.operationId}, or remove ${mine} manually.`],
    };
  }

  // Re-read to confirm actual preserved state rather than assuming success.
  let after: TicketSnapshotOrError;
  try {
    after = await readUnassignSnapshot(request.repository, request.number, request.agent, query);
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      code: "WRITE_UNKNOWN",
      claimStart: snap.claimStart,
      revision: null,
      recordOutcome,
      labelOutcome,
      preserved: snap.preserved,
      message:
        "Unassign writes completed, but re-reading the issue failed; verify current labels on GitHub.",
      error: errorMessage(error),
      next: [`Inspect #${request.number} in ${request.repository} directly.`],
    };
  }
  if (!after.ok) {
    return {
      ...base,
      status: "unknown",
      code: "WRITE_UNKNOWN",
      claimStart: snap.claimStart,
      revision: null,
      recordOutcome,
      labelOutcome,
      preserved: snap.preserved,
      message:
        "Unassign writes completed, but re-reading the issue failed; verify current labels on GitHub.",
      error: after.message,
      next: [`Inspect #${request.number} in ${request.repository} directly.`],
    };
  }
  if (after.claimPresent) {
    return {
      ...base,
      status: "partial",
      code: "WRITE_PARTIAL",
      claimStart: after.claimStart,
      revision: after.revision,
      recordOutcome,
      labelOutcome: "failed",
      preserved: after.preserved,
      message: `Unassign intent was recorded, but ${mine} is still present on #${request.number}.`,
      error: null,
      next: [`Retry with operationId ${request.operationId} or inspect #${request.number}.`],
    };
  }

  return {
    ...base,
    status: "applied",
    code: "UNASSIGN_APPLIED",
    claimStart: snap.claimStart,
    revision: after.revision,
    recordOutcome,
    labelOutcome: "removed",
    preserved: after.preserved,
    message: `Released claim ${mine} on #${request.number}; preserved ${after.preserved.humanAssignees.length} human assignee(s), state ${after.preserved.state} and all other labels.`,
    error: null,
    next: [],
  };
}
