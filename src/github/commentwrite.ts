/**
 * Bounded workflow comment-write recovery (#345, doc/design/comment-write-recovery.md).
 *
 * One shared boundary for every command that posts a workflow comment, over both transports
 * (gh argument-array `issue comment` steps and GraphQL `addComment`). The transport classifies one
 * attempt from structured evidence; this module owns only the recovery budget: at most one
 * automatic retry, only after an explicit secondary (content-creation) throttling refusal, only
 * after waiting at least the observed timing (or GitHub's 60-second minimum), only within the
 * overall deadline, and only after a read-back finds no receipt of the frozen comment and the
 * caller's applicability check still passes. An attempt whose acceptance is unknown is never
 * reposted. No issue lock or exactly-once delivery is claimed.
 *
 * Pure: no gh, no clock and no timer of its own; everything is injected. It imports nothing from
 * the gh transport modules, so it joins no import cycle.
 */
import { classifyGhFailure } from "./evidence.js";
import type { FailureClassification, GhResponse } from "./evidence.js";

/** One POST attempt's outcome, classified by the transport from structured evidence only. */
export type CommentAttempt =
  /** GitHub returned the created comment (its URL when known). */
  | { kind: "posted"; url: string | null }
  /** An attributable rate-limit refusal: nothing was created. Only `secondary` is retried. */
  | {
      kind: "throttled";
      secondary: boolean;
      retryAfterSeconds: number | null;
      /** An HTTP-date Retry-After, as ISO. */
      retryAt: string | null;
      /** The primary quota's reset, only when this same response showed it exhausted. */
      resetAt?: string | null;
      requestId: string | null;
    }
  /** Definitely refused and not retryable (validation, permission, authentication). */
  | { kind: "refused"; category: string; message: string }
  /** The write may or may not have been accepted (transport loss, timeout, malformed answer). */
  | { kind: "unknown"; message: string };

/** What a read-back of the target found for the frozen comment's trusted receipt. */
export type CommentReceipt =
  | { status: "found"; url: string | null }
  | { status: "absent" }
  /** More than one matching receipt: stop for inspection, never choose one. */
  | { status: "duplicate"; count: number }
  /** History missing, truncated or denied: absence is not proven. */
  | { status: "unreadable" };

export interface CommentRecoveryPolicy {
  /** POST attempts in total, including the first (contract: 2). */
  maxAttempts: number;
  /** Overall recovery deadline from the first dispatch, waits and read-backs included. */
  deadlineMs: number;
  /** Delay used when an explicit secondary refusal carries no usable timing (GitHub: 60s). */
  defaultDelayMs: number;
}
export const commentRecoveryPolicy: CommentRecoveryPolicy = {
  maxAttempts: 2,
  deadlineMs: 90_000,
  defaultDelayMs: 60_000,
};

export interface CommentRecoveryBoundaries {
  /** Dispatch the frozen comment once. Must not throw (classify instead). */
  post: () => Promise<CommentAttempt>;
  /** Find this operation's trusted receipt on the same ticket; absent means "not found". */
  readBack?: () => Promise<CommentReceipt>;
  /** Fresh operation guards after a wait: null when still applicable, else why not. */
  stillApplicable?: () => Promise<string | null>;
  /**
   * A fresh read of the command's guarded state, compared before and after the wait: any
   * difference (claimed elsewhere, closed, labels changed, a record appeared) stops the retry.
   * Without this or `stillApplicable` a throttled comment is never retried.
   */
  guard?: () => Promise<string>;
  /** Monotonic-enough milliseconds (production: Date.now). */
  now?: () => number;
  /** Abortable wait (production: a timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  policy?: Partial<CommentRecoveryPolicy>;
}

export type CommentRecoveryStatus =
  | "posted"
  | "throttled"
  | "refused"
  | "unknown"
  | "conflict"
  | "cancelled";

/** Bounded, redacted recovery details reported by every comment-posting command. */
export interface CommentRecovery {
  status: CommentRecoveryStatus;
  /** Whether the comment is known to exist, known not to, or may exist. */
  acceptance: "confirmed" | "not-accepted" | "unknown";
  category: string | null;
  attempts: number;
  waitedMs: number;
  /** Earliest time a retry may be sent (ISO), when throttled. */
  retryAt: string | null;
  /** The exhausted primary quota's reset reported by the refusing response (ISO). */
  resetAt: string | null;
  /** The retry time is the conservative default, not GitHub's own timing. */
  defaultDelay: boolean;
  requestId: string | null;
  url: string | null;
  /** The comment was found by read-back rather than by the POST's own reply. */
  matchedReceipt: boolean;
  /** One sentence for the step reason: what happened and when to retry. */
  message: string;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

/** Post one frozen comment with the bounded recovery of doc/design/comment-write-recovery.md. */
export async function postCommentWithRecovery(
  b: CommentRecoveryBoundaries,
): Promise<CommentRecovery> {
  const policy = { ...commentRecoveryPolicy, ...b.policy };
  const now = b.now ?? Date.now;
  const sleep = b.sleep ?? realSleep;
  const start = now();
  let attempts = 0;
  let waitedMs = 0;
  const done = (
    status: CommentRecoveryStatus,
    message: string,
    extra: Partial<CommentRecovery> = {},
  ): CommentRecovery => ({
    status,
    acceptance:
      status === "posted"
        ? "confirmed"
        : status === "unknown" || status === "cancelled"
          ? "unknown"
          : "not-accepted",
    category: null,
    attempts,
    waitedMs,
    retryAt: null,
    resetAt: null,
    defaultDelay: false,
    requestId: null,
    url: null,
    matchedReceipt: false,
    message,
    ...extra,
  });
  const fromReceipt = (receipt: CommentReceipt, why: string): CommentRecovery | null => {
    if (receipt.status === "found")
      return done("posted", "The comment was found on the ticket; it was not posted again.", {
        url: receipt.url,
        matchedReceipt: true,
      });
    if (receipt.status === "duplicate")
      return done(
        "unknown",
        `${why}; ${receipt.count} matching comments were found, so nothing was posted again. Inspect the ticket.`,
      );
    return null;
  };
  const readBack = async (): Promise<CommentReceipt> => {
    if (!b.readBack) return { status: "unreadable" };
    try {
      return await b.readBack();
    } catch {
      return { status: "unreadable" };
    }
  };

  for (;;) {
    if (b.signal?.aborted)
      return done("cancelled", "Cancelled before the comment was sent; nothing was posted.", {
        acceptance: "not-accepted",
      });
    attempts += 1;
    const attempt = await b.post();
    if (attempt.kind === "posted") return done("posted", "Posted.", { url: attempt.url });
    if (attempt.kind === "refused")
      return done("refused", attempt.message, { category: attempt.category });
    if (attempt.kind === "unknown") {
      // Acceptance unknown: a receipt proves the post, but its absence never permits a repost.
      if (b.signal?.aborted)
        return done("unknown", `${attempt.message} The comment may have been posted.`);
      const found = fromReceipt(await readBack(), attempt.message);
      return (
        found ??
        done(
          "unknown",
          `${attempt.message} The comment may have been posted; it was not sent again. Inspect the ticket before re-running.`,
        )
      );
    }

    // Throttled: the earliest retry is the latest of every applicable lower bound.
    const at = now();
    const bounds: number[] = [];
    if (attempt.retryAfterSeconds !== null) bounds.push(at + attempt.retryAfterSeconds * 1000);
    const retryAtMs = attempt.retryAt ? Date.parse(attempt.retryAt) : NaN;
    // Wall-clock bounds are compared on the injected clock's own scale.
    if (Number.isFinite(retryAtMs)) bounds.push(retryAtMs);
    // An exhausted primary quota on the same response is a lower bound too: never earlier.
    const resetMs = attempt.resetAt ? Date.parse(attempt.resetAt) : NaN;
    if (Number.isFinite(resetMs)) bounds.push(resetMs);
    const defaultDelay = bounds.length === 0;
    if (defaultDelay) bounds.push(at + policy.defaultDelayMs);
    const earliest = Math.max(...bounds);
    const retryAt = new Date(earliest).toISOString();
    const category = attempt.secondary ? "secondary-rate-limit" : "rate-limited";
    const throttled = (why: string) =>
      done(
        "throttled",
        `GitHub's ${attempt.secondary ? "secondary (content-creation) rate limit" : "rate limit"} refused the comment after ${attempts} attempt${attempts === 1 ? "" : "s"}${why}; nothing was posted. Retry after ${retryAt}${defaultDelay ? " (a default delay: GitHub reported no retry time)" : ""}.`,
        {
          category,
          retryAt,
          resetAt: attempt.resetAt ?? null,
          defaultDelay,
          requestId: attempt.requestId,
        },
      );
    if (!attempt.secondary) return throttled("");
    if (attempts >= policy.maxAttempts) return throttled("");
    if (earliest - start > policy.deadlineMs)
      return throttled(" (the required wait exceeds the recovery deadline)");
    // No way to re-check this command's guards after a wait: never retry it blind.
    if (!b.guard && !b.stillApplicable) return throttled("");
    let before: string | null = null;
    if (b.guard) {
      try {
        before = await b.guard();
      } catch {
        return throttled(" (its state could not be read before waiting)");
      }
    }

    try {
      const ms = Math.max(0, earliest - now());
      await sleep(ms, b.signal);
      waitedMs += ms;
    } catch {
      return done("cancelled", "Cancelled while waiting to retry; nothing was posted.", {
        acceptance: "not-accepted",
        category,
        retryAt,
        defaultDelay,
        requestId: attempt.requestId,
      });
    }
    if (b.signal?.aborted)
      return done("cancelled", "Cancelled while waiting to retry; nothing was posted.", {
        acceptance: "not-accepted",
      });
    // Before any retry: a receipt means it already landed; an unreadable history stops.
    const receipt = await readBack();
    const found = fromReceipt(receipt, "Throttled");
    if (found) return found;
    if (receipt.status === "unreadable" && b.readBack)
      return throttled(" (the ticket could not be re-read before retrying)");
    let conflict = b.stillApplicable
      ? await b.stillApplicable().catch(() => "its state could not be re-read")
      : null;
    if (!conflict && b.guard) {
      const after = await b.guard().catch(() => null);
      if (after === null) conflict = "its state could not be re-read";
      else if (after !== before)
        conflict = "the ticket changed during the wait (state, labels or comments)";
    }
    if (conflict)
      return done(
        "conflict",
        `The comment was throttled and, after waiting, is no longer applicable (${conflict}); nothing was posted.`,
        { category },
      );
    if (now() - start > policy.deadlineMs)
      return throttled(" (the recovery deadline passed before retrying)");
  }
}

/** Classify a thrown write failure from its structured fields only, never its message text. */
export function attemptFromError(error: unknown): CommentAttempt {
  const field = (key: string): unknown =>
    typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : null;
  const own = field("commentAttempt");
  if (typeof own === "object" && own !== null && "kind" in own) return own as CommentAttempt;
  if (field("authentication") === true)
    return {
      kind: "refused",
      category: "authentication",
      message: "GitHub refused the gh login. Run gh auth status (or gh auth login), then retry.",
    };
  if (field("rateLimited") === true) {
    const evidence = field("evidence") as FailureClassification | undefined;
    const retry = (field("retry") ?? {}) as {
      retryAfterSeconds?: number | null;
      resetAt?: string | null;
    };
    return {
      kind: "throttled",
      secondary: evidence?.category === "secondary-rate-limit",
      retryAfterSeconds: retry.retryAfterSeconds ?? null,
      retryAt: retry.resetAt ?? null,
      resetAt: evidence?.observation.remaining === 0 ? evidence.observation.resetAt : null,
      requestId: evidence?.observation.requestId ?? null,
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "The comment write failed.",
  };
}

/** A comment write that did not end posted; carries the bounded recovery details. */
export class CommentWriteError extends Error {
  readonly rateLimited: boolean;
  constructor(readonly recovery: CommentRecovery) {
    super(recovery.message);
    this.rateLimited = recovery.status === "throttled";
  }
}

/** `gh issue comment N --repo R --body B` as its parts, else null. */
export function commentCommand(
  args: readonly string[],
): { repository: string; number: number; body: string } | null {
  if (args[0] !== "issue" || args[1] !== "comment") return null;
  const number = Number(args[2]);
  const repo = args.indexOf("--repo");
  const body = args.indexOf("--body");
  if (!Number.isInteger(number) || repo < 0 || body < 0) return null;
  const repository = args[repo + 1];
  const text = args[body + 1];
  if (typeof repository !== "string" || typeof text !== "string") return null;
  return { repository, number, body: text };
}

/** Per-write options a command passes to the shared gh boundary. */
export interface CommentCallOptions {
  /** Fresh read of the command's guarded state; without it a throttled comment is not retried. */
  guard?: () => Promise<string>;
}

export interface CommentRunOptions {
  /** One raw dispatch of the frozen command; throws on failure (classified by its fields). */
  dispatch: (args: string[]) => Promise<unknown>;
  /** Read the ticket for this exact frozen body authored by the authenticated viewer. */
  readBack?: (target: {
    repository: string;
    number: number;
    body: string;
  }) => Promise<CommentReceipt>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  policy?: Partial<CommentRecoveryPolicy>;
}

/**
 * The shared gh write boundary with comment recovery: `issue comment` commands go through
 * postCommentWithRecovery with their body frozen; every other command is dispatched once, as
 * before. Throws CommentWriteError when a comment does not end posted.
 */
export function withCommentRecovery(
  options: CommentRunOptions,
): (args: string[], call?: CommentCallOptions) => Promise<CommentRecovery | undefined> {
  return async (args, call) => {
    const target = commentCommand(args);
    if (!target) {
      await options.dispatch(args);
      return undefined;
    }
    const frozen = [...args];
    const result = await postCommentWithRecovery({
      post: async () => {
        try {
          const answer = await options.dispatch([...frozen]);
          const url =
            typeof answer === "object" && answer !== null && "url" in answer
              ? (answer as { url: unknown }).url
              : null;
          return { kind: "posted", url: typeof url === "string" ? url : null };
        } catch (error) {
          return attemptFromError(error);
        }
      },
      ...(options.readBack ? { readBack: () => options.readBack!(target) } : {}),
      ...(call?.guard ? { guard: call.guard } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    });
    if (result.status !== "posted") throw new CommentWriteError(result);
    return result;
  };
}

/** Normalize comment text the way GitHub stores it, for exact receipt comparison. */
export const sameCommentBody = (stored: string, frozen: string): boolean =>
  stored.replace(/\r\n/g, "\n").trim() === frozen.replace(/\r\n/g, "\n").trim();

/**
 * GitHub's content-creation refusal ("submitted too quickly") as a structured error entry: the
 * exact message of a REST validation error or a GraphQL UNPROCESSABLE error, never text found in
 * a body, comment or issue. GitHub documents no other code for it; a generic 422 or
 * UNPROCESSABLE with any other message is a validation failure.
 */
const SUBMITTED_TOO_QUICKLY = "was submitted too quickly";
const isRecordLike = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const tooQuickly = (errors: unknown): boolean =>
  Array.isArray(errors) &&
  errors.some((e) => isRecordLike(e) && e.message === SUBMITTED_TOO_QUICKLY);

/**
 * Classify one failed REST comment POST from `gh api --include` output and gh's exit status.
 * Structured signals only: HTTP status, allowlisted headers, documentation link and error fields.
 */
export function classifyCommentResponse(
  response: GhResponse | null,
  outcome: { exitCode?: unknown; timedOut?: boolean } = {},
): CommentAttempt {
  if (outcome.timedOut) return { kind: "unknown", message: "The comment write timed out." };
  if (!response || response.status === null) {
    if (outcome.exitCode === 4)
      return {
        kind: "refused",
        category: "authentication",
        message: "GitHub refused the gh login. Run gh auth status (or gh auth login), then retry.",
      };
    // A nonzero gh exit without a response proves nothing about acceptance.
    return { kind: "unknown", message: "The comment write got no GitHub response." };
  }
  const c = classifyGhFailure({ response, exitCode: outcome.exitCode });
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = null;
  }
  const o = c.observation;
  const timed = o.retryAfterSeconds !== null || o.retryAt !== null;
  const throttled = (secondary: boolean): CommentAttempt => ({
    kind: "throttled",
    secondary,
    retryAfterSeconds: o.retryAfterSeconds,
    retryAt: o.retryAt,
    // A quota reset is a lower bound only when this same response shows the quota exhausted.
    resetAt: o.remaining === 0 ? o.resetAt : null,
    requestId: o.requestId,
  });
  const status = response.status;
  if (c.category === "secondary-rate-limit") return throttled(true);
  if (status === 422 && isRecordLike(body) && tooQuickly(body.errors)) return throttled(true);
  // GitHub's secondary limits answer 403/429 with Retry-After while quota remains.
  if ((status === 403 || status === 429) && timed && o.remaining !== 0) return throttled(true);
  if (c.category === "rate-limited") return throttled(false);
  if (c.category === "authentication")
    return {
      kind: "refused",
      category: "authentication",
      message: "GitHub refused the gh login. Run gh auth status (or gh auth login), then retry.",
    };
  if (c.category === "access")
    return {
      kind: "refused",
      category: "access",
      message: "GitHub denied permission to comment on this ticket.",
    };
  if (status >= 400 && status < 500)
    return {
      kind: "refused",
      category: "validation",
      message: `GitHub refused the comment (HTTP ${status}).`,
    };
  return {
    kind: "unknown",
    message: `The comment write failed${status >= 500 ? ` (HTTP ${status})` : ""}.`,
  };
}

/** Timing and identity a GraphQL mutation's own response carried (optional, from --include). */
export interface MutationResponseMeta {
  status: number | null;
  retryAfterSeconds: number | null;
  retryAt: string | null;
  requestId: string | null;
}

/**
 * Classify one GraphQL addComment answer: posted only with a returned comment URL; a typed
 * rate-limit or UNPROCESSABLE "submitted too quickly" error is throttling; other typed errors
 * are definite refusals; an untyped error (transport failure) or a missing result is unknown.
 */
export function classifyAddComment(
  answer: {
    data: unknown;
    errors: readonly { type?: string; message?: string }[];
    response?: MutationResponseMeta;
  },
  url: unknown,
): CommentAttempt {
  if (typeof url === "string" && url) return { kind: "posted", url };
  const meta = answer.response;
  const throttled = (secondary: boolean): CommentAttempt => ({
    kind: "throttled",
    secondary,
    retryAfterSeconds: meta?.retryAfterSeconds ?? null,
    retryAt: meta?.retryAt ?? null,
    requestId: meta?.requestId ?? null,
  });
  const types = answer.errors.map((e) => e.type);
  if (answer.errors.some((e) => e.type === "UNPROCESSABLE" && e.message === SUBMITTED_TOO_QUICKLY))
    return throttled(true);
  if (types.some((t) => t === "RATE_LIMITED" || t === "RATE_LIMIT")) return throttled(false);
  if (
    meta &&
    (meta.status === 403 || meta.status === 429) &&
    (meta.retryAfterSeconds !== null || meta.retryAt !== null)
  )
    return throttled(true);
  const typed = answer.errors.find((e) => typeof e.type === "string");
  if (typed)
    return {
      kind: "refused",
      category: typed.type === "FORBIDDEN" ? "access" : "validation",
      message: `${typed.type}: ${typed.message ?? "GitHub returned an error"}`,
    };
  return {
    kind: "unknown",
    message: answer.errors[0]?.message ?? "GitHub returned no comment for the write.",
  };
}
