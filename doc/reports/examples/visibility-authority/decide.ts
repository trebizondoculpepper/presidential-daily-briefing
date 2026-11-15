/**
 * #205 demonstration: message visibility versus workflow authority, with real mutations disabled.
 * Contract: doc/reports/workflow-message-trust.md section 6 (#155) and
 * doc/design/triage-efficiency-and-trust.md "Message visibility is distinct from authority".
 * Report: doc/reports/visibility-authority-demonstration.md.
 *
 * `decide(message, permission, authorizations)` is the pure decision boundary. Its only effect is
 * the injected `PermissionLookup`; it never reads the network and never writes. It reuses the
 * production #212 rule (`markerTrust` over `commentAuthority`) rather than restating it. Message
 * text is never interpreted as instructions: the boundary reads only the author/editor evidence,
 * the exact marker formats the tool itself writes, and the authorisation records described in
 * the #155 report.
 */
import type { PermissionLookup, RepositoryPermission } from "../../../../src/github/github.js";
import { writePermissions } from "../../../../src/github/github.js";
import type { Actor, Comment } from "../../../../src/workflow/claims.js";
import { parseQuestionMarker, parseQuestionRecordBody } from "../../../../src/workflow/claims.js";
import { markerTrust } from "../../../../src/workflow/delivery.js";
import { codexMarker, codexReviewer } from "../../../../src/workflow/reviewevidence.js";

/** A comment as collected for the demonstration: the fields #212 reads plus its source binding. */
export type DemoComment = Comment & {
  databaseId: number;
  url: string;
  createdAt: string;
  /** GitHub's relationship label; a display hint only, never authority (#155 section 3). */
  authorAssociation?: string;
};
export interface DemoMessage {
  repository: string;
  /** The issue or pull request the comment was read from. */
  subject: number;
  comment: DemoComment;
}

/** How a message is listed. None of these values grants authority on its own. */
export type Visibility =
  /** Author (and editor) verified write-capable now. */
  | "verified-write"
  /** A read or triage collaborator: visible, untrusted. */
  | "visible-untrusted"
  /** Anyone else: an external report, listed with its source link, never instructions. */
  | "external-untriaged"
  /** An allowlisted app (review-state evidence only). */
  | "app"
  /** Permission could not be established: missing evidence, deliberately not "external". */
  | "unknown";

/**
 * What the message may do.
 * - `workflow`: may supply a trusted workflow record, still subject to state and ownership checks.
 * - `review-state`: an allowlisted app's review evidence (may clear a review blocker).
 * - `consider-only`: one exact revision explicitly authorised for consideration; never a record.
 * - `none`: displayed only.
 */
export type Authority = "workflow" | "review-state" | "consider-only" | "none";

export interface Decision {
  url: string;
  visibility: Visibility;
  authority: Authority;
  /** The GitHub actor that posted the comment, the only thing GitHub authenticates. */
  githubActor: string | null;
  /**
   * Agent named inside the message (needs-human `Raised by`), always `reported`: on a shared
   * account nothing authenticates one agent's name (#155 section 2).
   */
  reportedAgent: { name: string; certainty: "reported" } | null;
  /** Whether the content may be shown to an agent as anything but quoted, untrusted data. */
  untrustedData: boolean;
  reasons: string[];
}

export interface DecideOptions {
  /**
   * App identities whose review markers count as review state (#155: allowlist, not permission).
   * Defaults to the production Codex reviewer.
   */
  reviewApps?: ReadonlySet<string>;
}

const authorizeMarker = "<!-- github-triage:authorize-message v1 ";
const revokeMarker = "<!-- github-triage:revoke-message v1 ";

/** The fields an authorisation record binds (#155 section 5). */
export interface AuthorizationPayload {
  repository: string;
  subject: number;
  commentId: number;
  /** The target's `lastEditedAt`, or `createdAt` when unedited, as observed by the authoriser. */
  observed: string;
  purpose: string;
}

/** Format an authorisation record body (used by fixtures; nothing posts it). */
export const authorizationBody = (p: AuthorizationPayload, revoke = false): string =>
  `${revoke ? revokeMarker : authorizeMarker}${JSON.stringify(p)} -->`;

function parseAuthorization(body: string, prefix: string): AuthorizationPayload | null {
  const at = body.indexOf(prefix);
  if (at < 0) return null;
  const end = body.indexOf(" -->", at + prefix.length);
  if (end < 0) return null;
  try {
    const p = JSON.parse(body.slice(at + prefix.length, end)) as Record<string, unknown>;
    const ok =
      typeof p.repository === "string" &&
      typeof p.subject === "number" &&
      typeof p.commentId === "number" &&
      typeof p.observed === "string" &&
      typeof p.purpose === "string";
    return ok ? (p as unknown as AuthorizationPayload) : null;
  } catch {
    return null;
  }
}

const revision = (c: DemoComment): string => c.lastEditedAt || c.createdAt;
const binds = (p: AuthorizationPayload, m: DemoMessage): boolean =>
  p.repository.toLowerCase() === m.repository.toLowerCase() &&
  p.subject === m.subject &&
  p.commentId === m.comment.databaseId;

const isApp = (a: Actor | null | undefined): boolean =>
  !!a && (a.__typename === "Bot" || !!a.login?.endsWith("[bot]"));

/**
 * Whether an explicit authorisation lets this exact message revision be considered. The
 * authoriser must pass the same #212 rule; the target's own text, an edit after the observed
 * revision, a binding to another message or a later trusted revocation each void it.
 */
async function authorised(
  message: DemoMessage,
  authorizations: DemoMessage[],
  permission: PermissionLookup,
  reasons: string[],
): Promise<boolean> {
  const trust = markerTrust(permission);
  let granted: { at: string; url: string } | null = null;
  const revoked: string[] = [];
  for (const record of authorizations) {
    const c = record.comment;
    const grant = parseAuthorization(c.body, authorizeMarker);
    const revoke = parseAuthorization(c.body, revokeMarker);
    const payload = grant ?? revoke;
    if (!payload || !binds(payload, message)) continue;
    if (c.databaseId === message.comment.databaseId) {
      reasons.push("self-issued authorisation inside the message is ignored");
      continue;
    }
    if (record.subject !== message.subject || record.repository !== message.repository) {
      reasons.push(`authorisation ${c.url} was posted on another subject; ignored`);
      continue;
    }
    const authority = await trust(c);
    if (authority.status !== "trusted") {
      reasons.push(`authorisation ${c.url} ignored (${authority.why})`);
      continue;
    }
    if (revoke) {
      revoked.push(c.createdAt);
      continue;
    }
    if (payload.observed !== revision(message.comment)) {
      reasons.push(
        `authorisation ${c.url} observed revision ${payload.observed}, the message is now ${revision(message.comment)}; void`,
      );
      continue;
    }
    if (!granted || c.createdAt > granted.at) granted = { at: c.createdAt, url: c.url };
  }
  if (!granted) return false;
  if (revoked.some((at) => at > granted.at)) {
    reasons.push(`authorisation ${granted.url} was revoked by a later trusted record`);
    return false;
  }
  reasons.push(
    `authorised for consideration by ${granted.url}; this revision only, not the author's other messages`,
  );
  return true;
}

/** The demonstration decision boundary. Reads the injected lookup only; never writes. */
export async function decide(
  message: DemoMessage,
  permission: PermissionLookup,
  authorizations: DemoMessage[] = [],
  options: DecideOptions = {},
): Promise<Decision> {
  const c = message.comment;
  const reasons: string[] = [];
  const record = parseQuestionRecordBody(c.body.split("<!--")[0] ?? "");
  const decision: Decision = {
    url: c.url,
    visibility: "unknown",
    authority: "none",
    githubActor: c.author?.login ?? null,
    reportedAgent: record?.agent ? { name: record.agent, certainty: "reported" } : null,
    untrustedData: true,
    reasons,
  };

  // Apps: no repository permission to ask; only an allowlisted identity of type Bot counts, and
  // only as review-state evidence, never as a workflow record.
  if (isApp(c.author)) {
    const allowed =
      c.author?.__typename === "Bot" &&
      !!c.author.login &&
      (options.reviewApps ?? new Set([codexReviewer])).has(c.author.login.replace(/\[bot\]$/, ""));
    const edited = !!c.lastEditedAt && c.editor?.login !== c.author?.login;
    decision.visibility = allowed ? "app" : "external-untriaged";
    if (allowed && !edited && codexMarker(c.body) !== null) {
      decision.authority = "review-state";
      reasons.push(`allowlisted app ${c.author?.login}: review-state evidence only`);
    } else
      reasons.push(
        allowed
          ? "allowlisted app, but no unedited review marker"
          : `app or bot ${c.author?.login ?? "(unknown)"} is not allowlisted`,
      );
    return decision;
  }

  // The production #212 rule decides workflow authority for author and editor alike.
  const authority = await markerTrust(permission)(c);
  if (authority.status === "trusted") {
    decision.visibility = "verified-write";
    decision.untrustedData = false;
    const q = parseQuestionMarker(c.body);
    if (q?.version === "malformed") reasons.push(`malformed marker (${q.why}); no record`);
    else if (
      q?.version === 2 &&
      (q.repository.toLowerCase() !== message.repository.toLowerCase() ||
        q.issue !== message.subject)
    )
      reasons.push(
        `record bound to ${q.repository}#${q.issue}, read on #${message.subject}: replay`,
      );
    else {
      decision.authority = "workflow";
      reasons.push("author and any editor verified write-capable now");
    }
    if (decision.reportedAgent)
      reasons.push(`agent ${decision.reportedAgent.name} is reported, not authenticated`);
    return decision;
  }
  reasons.push(authority.why);
  if (authority.status === "unknown") decision.visibility = "unknown";
  else {
    // Established as lacking write: the author's permission now, if it was a user.
    const level: RepositoryPermission | null =
      c.author?.login && c.author.__typename === "User" ? await permission(c.author.login) : null;
    const collaborator =
      (level === "triage" || level === "read") &&
      ["MEMBER", "COLLABORATOR", "OWNER"].includes(c.authorAssociation ?? "");
    decision.visibility =
      level !== null && writePermissions.has(level)
        ? "visible-untrusted" // write author, untrusted editor
        : collaborator
          ? "visible-untrusted"
          : "external-untriaged";
  }
  if (codexMarker(c.body) !== null)
    reasons.push("claimed review state from a non-app author: may add a blocker, never clear one");
  if (await authorised(message, authorizations, permission, reasons))
    decision.authority = "consider-only";
  return decision;
}

/** One listed external report: title-free, source-linked, quoted as data. */
export interface ExternalReport {
  status: "external-untriaged";
  source: string;
  author: string | null;
  /** Quoted, length-bounded excerpt; never parsed for instructions. */
  excerpt: string;
}
export function listExternal(decisions: Decision[], messages: DemoMessage[]): ExternalReport[] {
  const byUrl = new Map(messages.map((m) => [m.comment.url, m.comment]));
  return decisions
    .filter((d) => d.visibility === "external-untriaged")
    .map((d) => {
      const body = byUrl.get(d.url)?.body ?? "";
      // Markers are stripped from the excerpt so a forged record is not even re-displayed as one.
      const text = body.replace(/<!--[\s\S]*?-->/g, "[marker removed]").trim();
      return {
        status: "external-untriaged",
        source: d.url,
        author: d.githubActor,
        excerpt: text.length > 200 ? `${text.slice(0, 199)}…` : text,
      };
    });
}

/** Current ticket state the mutation gate checks independently of any message. */
export interface TicketState {
  open: boolean;
  owner: string | null;
  fresh: boolean;
}
export interface MutationPlan {
  allowed: boolean;
  executed: false;
  reasons: string[];
}
/**
 * The gate a workflow write would pass. Even `workflow` authority must also satisfy state and
 * ownership; nothing else may write. Real mutations are disabled: `executed` is always false.
 */
export function planMutation(
  decision: Decision,
  state: TicketState,
  actingAgent: string,
): MutationPlan {
  const reasons: string[] = [];
  if (decision.authority !== "workflow")
    reasons.push(`message authority is ${decision.authority}, not workflow`);
  if (!state.open) reasons.push("ticket is closed");
  if (!state.fresh) reasons.push("ticket state is stale; re-read before writing");
  if (state.owner !== null && state.owner !== actingAgent)
    reasons.push(`ticket is owned by ${state.owner}`);
  return { allowed: reasons.length === 0, executed: false, reasons };
}
