/**
 * Opt-in served-write anti-CSRF session & request boundary (#588,
 * doc/design/dashboard-assessment-edits.md, doc/design/human-unassign.md).
 *
 * Uses standard `node:crypto` random tokens in memory with a 30-minute idle TTL. Restarting
 * clears all sessions. Never reveals or reuses the private registration control token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpFailure } from "./http.js";
import type { UnassignApplyResult } from "../workflow/unassign.js";

export const WRITE_SESSION_COOKIE = "pdb_write_session";
export const WRITE_CSRF_HEADER = "x-pdb-csrf";
export const WRITE_SESSION_IDLE_MS = 30 * 60_000;

interface SessionEntry {
  csrfToken: string;
  lastActiveMs: number;
}

interface CompletedOperation {
  intentKey: string;
  result: UnassignApplyResult;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * In-memory served-write session & operation coalescer for `pdb serve --allow-edits`.
 */
export class WriteSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly inFlight = new Map<
    string,
    { intentKey: string; promise: Promise<UnassignApplyResult> }
  >();
  private readonly completed = new Map<string, CompletedOperation>();
  private readonly boundIntents = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(nowMs: number): void {
    for (const [id, entry] of this.sessions) {
      if (nowMs - entry.lastActiveMs > WRITE_SESSION_IDLE_MS) this.sessions.delete(id);
    }
  }

  /** Issue a new write session cookie + CSRF token (or refresh an active valid session). */
  issue(
    headers: IncomingMessage["headers"],
    secure = false,
  ): {
    cookieHeader: string;
    csrfToken: string;
  } {
    const nowMs = this.now();
    this.prune(nowMs);
    const cookies = parseCookies(headers.cookie);
    const existingId = cookies[WRITE_SESSION_COOKIE];
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    const sessionId = existing ? existingId! : randomBytes(24).toString("base64url");
    const csrfToken = existing ? existing.csrfToken : randomBytes(24).toString("base64url");
    this.sessions.set(sessionId, { csrfToken, lastActiveMs: nowMs });
    const cookieParts = [
      `${WRITE_SESSION_COOKIE}=${sessionId}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      ...(secure ? ["Secure"] : []),
    ];
    return { cookieHeader: cookieParts.join("; "), csrfToken };
  }

  /**
   * Enforce same-origin, JSON content-type, valid session cookie and matching `X-PDB-CSRF`
   * header before any GitHub operation runs.
   */
  requireWriteAuthorization(headers: IncomingMessage["headers"]): void {
    if (!headers.origin) {
      throw new HttpFailure(
        403,
        "FORBIDDEN_ORIGIN",
        "Write requests require a same-origin Origin header.",
      );
    }
    const contentType = String(headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new HttpFailure(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Write requests require Content-Type: application/json.",
      );
    }
    const nowMs = this.now();
    this.prune(nowMs);
    const cookies = parseCookies(headers.cookie);
    const sessionId = cookies[WRITE_SESSION_COOKIE];
    const headerToken = headers[WRITE_CSRF_HEADER];
    const token = typeof headerToken === "string" ? headerToken.trim() : "";
    if (!sessionId || !token) {
      throw new HttpFailure(
        403,
        "CSRF_REQUIRED",
        "Missing write session cookie or X-PDB-CSRF header; refresh the Human view and retry.",
      );
    }
    const entry = this.sessions.get(sessionId);
    if (!entry || nowMs - entry.lastActiveMs > WRITE_SESSION_IDLE_MS) {
      this.sessions.delete(sessionId);
      throw new HttpFailure(
        403,
        "CSRF_REQUIRED",
        "Write session expired; refresh the Human view and retry.",
      );
    }
    if (!safeEqualText(entry.csrfToken, token)) {
      throw new HttpFailure(
        403,
        "CSRF_REQUIRED",
        "Invalid X-PDB-CSRF token; refresh the Human view and retry.",
      );
    }
    entry.lastActiveMs = nowMs;
  }

  /** Coalesce duplicate HTTP delivery for the same operationId + intent; reject mismatched reuse. */
  async runIdempotent(
    operationId: string,
    intentKey: string,
    execute: () => Promise<UnassignApplyResult>,
  ): Promise<UnassignApplyResult> {
    const done = this.completed.get(operationId);
    if (done) {
      if (done.intentKey !== intentKey) {
        throw new HttpFailure(
          409,
          "CONFLICT",
          "The supplied operationId was already used with different unassign parameters.",
        );
      }
      return done.result;
    }
    const bound = this.boundIntents.get(operationId);
    if (bound && bound !== intentKey) {
      throw new HttpFailure(
        409,
        "CONFLICT",
        "The supplied operationId was already used with different unassign parameters.",
      );
    }
    const active = this.inFlight.get(operationId);
    if (active) {
      if (active.intentKey !== intentKey) {
        throw new HttpFailure(
          409,
          "CONFLICT",
          "An unassign request with this operationId and different parameters is already in flight.",
        );
      }
      return active.promise;
    }
    this.boundIntents.set(operationId, intentKey);
    const promise = execute().then(
      (result) => {
        this.inFlight.delete(operationId);
        if (result.status === "applied" || result.status === "noop") {
          this.completed.set(operationId, { intentKey, result });
        }
        return result;
      },
      (error) => {
        this.inFlight.delete(operationId);
        throw error;
      },
    );
    this.inFlight.set(operationId, { intentKey, promise });
    return promise;
  }
}
