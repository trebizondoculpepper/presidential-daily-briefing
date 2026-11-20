/**
 * Claim-to-employing-human binding (#690, doc/design/human-assignment-safeguard.md: "Shared claim
 * evidence records the employing human for each agent claim, bound to host/repository/issue,
 * agent and claim-start identity, with provenance").
 *
 * `pdb claim` appends one versioned binding marker to the claim comment it posts. The marker
 * names the repository, issue, agent and the claim marker it accompanies, and the employing human
 * as the shared #664 resolver reported it (current, last-known or unresolved, with observation
 * time). The claim marker itself is unchanged, so existing claims and idempotent retries still
 * match.
 *
 * The reader states facts only. It considers only the claim comment of the current acquisition
 * (posted at or after the claim start), and a binding counts only when that comment's author and
 * any editor have write authority (#212). Missing (legacy), malformed, mismatched, untrusted or
 * unresolved bindings are an explicit unknown with the reason, never a guess from the current gh
 * login, the issue author or a PR author, and never grounds to remove a claim.
 */
import type { HumanContext } from "../config/humancontext.js";

/** The parts of an issue comment the reader needs (structurally `claims.ts`'s Comment). */
export interface BindingComment {
  body: string;
  createdAt?: string;
  url?: string;
  author?: { login?: string } | null;
}

export const claimHumanMarkerPrefix = "<!-- github-triage:claim-human v1 ";

/** The employing human recorded with a claim, as the #664 resolver reported it at claim time. */
export type RecordedHuman =
  | { provenance: "current" | "last-known"; host: string; login: string; observedAt: string }
  | { provenance: "unresolved"; host: string; login: null; reason: string };

export interface ClaimHumanBinding {
  v: 1;
  repository: string;
  issue: number;
  agent: string;
  /** The id of the claim marker this binding accompanies (`github-triage:claim:<id>`). */
  claim: string;
  human: RecordedHuman;
}

/** The binding to record for a claim from the resolved human context. */
export function recordedHuman(context: HumanContext): RecordedHuman {
  return context.state === "unresolved"
    ? { provenance: "unresolved", host: context.host, login: null, reason: context.reason }
    : {
        provenance: context.state,
        host: context.host,
        login: context.login,
        observedAt: context.observedAt,
      };
}

export const claimHumanMarker = (binding: ClaimHumanBinding): string =>
  `${claimHumanMarkerPrefix}${JSON.stringify(binding)} -->`;

const repoName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const exactKeys = (o: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(o).sort().join() === [...keys].sort().join();

/**
 * Parse a binding marker; null when the comment has none. Anything present but not exactly the
 * v1 shape is malformed (with the reason), never read loosely.
 */
export function parseClaimHumanMarker(
  body: string,
): { ok: true; binding: ClaimHumanBinding } | { ok: false; why: string } | null {
  const at = body.indexOf(claimHumanMarkerPrefix);
  if (at < 0) return null;
  const rest = body.slice(at + claimHumanMarkerPrefix.length);
  const end = rest.indexOf(" -->");
  if (end < 0) return { ok: false, why: "binding marker is not terminated" };
  let p: unknown;
  try {
    p = JSON.parse(rest.slice(0, end));
  } catch {
    return { ok: false, why: "binding is not JSON" };
  }
  if (typeof p !== "object" || p === null || Array.isArray(p))
    return { ok: false, why: "binding is not an object" };
  const b = p as Record<string, unknown>;
  if (
    !exactKeys(b, ["v", "repository", "issue", "agent", "claim", "human"]) ||
    b.v !== 1 ||
    typeof b.repository !== "string" ||
    !repoName.test(b.repository) ||
    typeof b.issue !== "number" ||
    !Number.isSafeInteger(b.issue) ||
    b.issue <= 0 ||
    !nonEmpty(b.agent) ||
    typeof b.claim !== "string" ||
    !/^[0-9a-f]{16}$/.test(b.claim)
  )
    return { ok: false, why: "binding fields are missing or invalid" };
  const h = b.human as Record<string, unknown> | null;
  if (typeof h !== "object" || h === null || Array.isArray(h) || !nonEmpty(h.host))
    return { ok: false, why: "binding human is invalid" };
  const human =
    h.provenance === "unresolved"
      ? exactKeys(h, ["provenance", "host", "login", "reason"]) &&
        h.login === null &&
        nonEmpty(h.reason)
      : (h.provenance === "current" || h.provenance === "last-known") &&
        exactKeys(h, ["provenance", "host", "login", "observedAt"]) &&
        nonEmpty(h.login) &&
        nonEmpty(h.observedAt) &&
        !Number.isNaN(Date.parse(h.observedAt));
  if (!human) return { ok: false, why: "binding human is invalid" };
  return { ok: true, binding: b as unknown as ClaimHumanBinding };
}

export type ClaimBindingUnknown =
  /** No claim comment of the current acquisition was found. */
  | "no-claim-comment"
  /** The claim comment carries no binding (claimed before #690, or by an older pdb). */
  | "legacy"
  | "malformed"
  /** The binding names another repository, issue, agent or claim. */
  | "mismatch"
  /** The comment's author or editor lacks write authority, or that could not be established. */
  | "untrusted"
  /** The claim recorded that its employing human could not be resolved. */
  | "unresolved"
  /** The comment history since the claim start was not read completely. */
  | "incomplete";

export type ClaimBinding =
  | {
      state: "bound";
      host: string;
      login: string;
      provenance: "current" | "last-known";
      observedAt: string;
      /** The claim comment that records it. */
      source: { url: string | null; author: string | null; at: string | null };
    }
  | { state: "unknown"; reason: ClaimBindingUnknown; why: string };

export interface ClaimBindingQuery {
  repository: string;
  issue: number;
  agent: string;
  /** The claim marker id of this agent on this issue (`claimMarkerFor`'s id). */
  claim: string;
  /** Claim start: the time the agent's label was last added; earlier comments are not read. */
  since: string | null;
  /** Whether `comments` hold the complete history since the claim start. */
  complete: boolean;
}

/** The employing human bound to the agent's current claim on the issue, or why it is unknown. */
export async function readClaimBinding<C extends BindingComment>(
  comments: readonly C[],
  q: ClaimBindingQuery,
  trust: (comment: C) => Promise<{ status: "trusted" } | { status: string; why: string }>,
): Promise<ClaimBinding> {
  const unknown = (reason: ClaimBindingUnknown, why: string): ClaimBinding => ({
    state: "unknown",
    reason,
    why,
  });
  const claimMarker = `<!-- github-triage:claim:${q.claim} -->`;
  const since = q.since ? Date.parse(q.since) : null;
  const current = comments.filter(
    (c) =>
      c.body.includes(claimMarker) &&
      (since === null || (c.createdAt !== undefined && Date.parse(c.createdAt) >= since)),
  );
  // The newest claim comment of this acquisition is the one a retry would have repaired.
  const latest = current.at(-1);
  if (!latest)
    return q.complete
      ? unknown("no-claim-comment", `No claim comment by ${q.agent} since the claim started.`)
      : unknown("incomplete", "The comments since the claim started were not read completely.");
  const parsed = parseClaimHumanMarker(latest.body);
  if (parsed === null)
    return unknown(
      "legacy",
      `The claim by ${q.agent} records no employing human (claimed before #690 or by an older pdb).`,
    );
  if (!parsed.ok)
    return unknown("malformed", `The claim's employing-human binding: ${parsed.why}.`);
  const b = parsed.binding;
  if (
    b.repository.toLowerCase() !== q.repository.toLowerCase() ||
    b.issue !== q.issue ||
    b.agent !== q.agent ||
    b.claim !== q.claim
  )
    return unknown(
      "mismatch",
      `The binding names ${b.repository}#${b.issue} for ${b.agent}, not this claim.`,
    );
  const authority = await trust(latest);
  if (authority.status !== "trusted")
    return unknown(
      "untrusted",
      `The claim comment cannot be trusted: ${"why" in authority ? authority.why : "no authority"}.`,
    );
  if (b.human.provenance === "unresolved")
    return unknown(
      "unresolved",
      `The employing human was not resolved at claim time: ${b.human.reason}.`,
    );
  return {
    state: "bound",
    host: b.human.host,
    login: b.human.login,
    provenance: b.human.provenance,
    observedAt: b.human.observedAt,
    source: {
      url: latest.url ?? null,
      author: latest.author?.login ?? null,
      at: latest.createdAt ?? null,
    },
  };
}
