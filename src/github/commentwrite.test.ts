/**
 * Bounded comment-write recovery (#345, doc/design/comment-write-recovery.md): injected post,
 * read-back, clock and timer boundaries only; no real waits and no GitHub writes.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  classifyAddComment,
  classifyCommentResponse,
  CommentWriteError,
  postCommentWithRecovery,
  withCommentRecovery,
} from "./commentwrite.js";
import type { CommentAttempt, CommentReceipt } from "./commentwrite.js";
import { parseGhResponse } from "./evidence.js";
import { applyPlan, claimText } from "../workflow/claims.js";
import type { ClaimPlan } from "../workflow/claims.js";
import { AuthenticationError } from "./github.js";
import { RateLimitError } from "./dependencies.js";

const T0 = Date.parse("2026-11-15T12:00:00Z");
const secondary = (over: Partial<Extract<CommentAttempt, { kind: "throttled" }>> = {}) =>
  ({
    kind: "throttled",
    secondary: true,
    retryAfterSeconds: null,
    retryAt: null,
    requestId: "R:1",
    ...over,
  }) as CommentAttempt;

/** A scripted target: each POST takes the next outcome; accepted posts land on the ticket. */
function scripted(outcomes: (CommentAttempt | "lost")[], receipts?: CommentReceipt[]) {
  let clock = T0;
  const sleeps: number[] = [];
  const posted: string[] = [];
  let posts = 0;
  return {
    sleeps,
    posted,
    posts: () => posts,
    boundaries: {
      post: async (): Promise<CommentAttempt> => {
        posts += 1;
        const next = outcomes.shift() ?? { kind: "posted", url: "https://c/1" };
        if (next === "lost") {
          posted.push("body");
          return { kind: "unknown", message: "The comment write got no GitHub response." };
        }
        if (next.kind === "posted") posted.push("body");
        return next;
      },
      readBack: async (): Promise<CommentReceipt> =>
        receipts?.shift() ??
        (posted.length ? { status: "found", url: "https://c/found" } : { status: "absent" }),
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe("postCommentWithRecovery (#345)", () => {
  it("retries a secondary refusal once after Retry-After and posts", async () => {
    const t = scripted([secondary({ retryAfterSeconds: 5 })]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(r).toMatchObject({ status: "posted", attempts: 2, waitedMs: 5000, url: "https://c/1" });
    expect(t.sleeps).toEqual([5000]);
    expect(t.posted).toHaveLength(1);
  });
  it("honours an HTTP-date retry time from the injected clock", async () => {
    const t = scripted([secondary({ retryAt: new Date(T0 + 12_000).toISOString() })]);
    expect(await postCommentWithRecovery(t.boundaries)).toMatchObject({ status: "posted" });
    expect(t.sleeps).toEqual([12_000]);
  });
  it("waits the later of Retry-After and a quota reset", async () => {
    const t = scripted([
      secondary({ retryAfterSeconds: 3, retryAt: new Date(T0 + 20_000).toISOString() }),
    ]);
    await postCommentWithRecovery(t.boundaries);
    expect(t.sleeps).toEqual([20_000]);
  });
  it("uses GitHub's 60-second minimum without timing, then reports partial with retry time", async () => {
    const t = scripted([secondary(), secondary()]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(r).toMatchObject({
      status: "throttled",
      acceptance: "not-accepted",
      category: "secondary-rate-limit",
      attempts: 2,
      defaultDelay: true,
      requestId: "R:1",
    });
    expect(t.sleeps).toEqual([60_000]);
    expect(r.retryAt).toBe(new Date(T0 + 120_000).toISOString());
    expect(r.message).toContain(`Retry after ${r.retryAt}`);
    expect(t.posts()).toBe(2);
  });
  it("returns promptly when the wait exceeds the deadline: zero early retries", async () => {
    const t = scripted([secondary({ retryAfterSeconds: 300 })]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(r).toMatchObject({ status: "throttled", attempts: 1 });
    expect(r.retryAt).toBe(new Date(T0 + 300_000).toISOString());
    expect(t.sleeps).toEqual([]);
  });
  it("honours a configured smaller budget", async () => {
    const t = scripted([secondary({ retryAfterSeconds: 5 })]);
    const r = await postCommentWithRecovery({ ...t.boundaries, policy: { deadlineMs: 3000 } });
    expect(r).toMatchObject({ status: "throttled", attempts: 1 });
  });
  it("does not retry a primary rate limit or a definite refusal", async () => {
    const primary = scripted([
      { ...(secondary({ retryAfterSeconds: 1 }) as object), secondary: false } as CommentAttempt,
    ]);
    expect(await postCommentWithRecovery(primary.boundaries)).toMatchObject({
      status: "throttled",
      category: "rate-limited",
      attempts: 1,
    });
    const auth = scripted([{ kind: "refused", category: "authentication", message: "login" }]);
    expect(await postCommentWithRecovery(auth.boundaries)).toMatchObject({
      status: "refused",
      category: "authentication",
      attempts: 1,
    });
    expect(auth.sleeps).toEqual([]);
  });
  it("finds a lost-reply comment by read-back and never posts it again", async () => {
    const t = scripted(["lost"]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(r).toMatchObject({ status: "posted", matchedReceipt: true, attempts: 1 });
    expect(t.posted).toHaveLength(1);
  });
  it("keeps an unconfirmed write unknown: no automatic repost", async () => {
    const t = scripted(["lost"], [{ status: "absent" }]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(r).toMatchObject({ status: "unknown", acceptance: "unknown", attempts: 1 });
    expect(t.posts()).toBe(1);
  });
  it("returns an existing receipt found after the wait instead of a second POST", async () => {
    const t = scripted([secondary({ retryAfterSeconds: 1 })], [{ status: "found", url: "u" }]);
    expect(await postCommentWithRecovery(t.boundaries)).toMatchObject({
      status: "posted",
      matchedReceipt: true,
      url: "u",
    });
    expect(t.posts()).toBe(1);
  });
  it("stops on duplicate receipts, an unreadable history or a changed operation", async () => {
    const dup = scripted(
      [secondary({ retryAfterSeconds: 1 })],
      [{ status: "duplicate", count: 2 }],
    );
    expect(await postCommentWithRecovery(dup.boundaries)).toMatchObject({ status: "unknown" });
    const blind = scripted([secondary({ retryAfterSeconds: 1 })], [{ status: "unreadable" }]);
    expect(await postCommentWithRecovery(blind.boundaries)).toMatchObject({ status: "throttled" });
    expect(blind.posts()).toBe(1);
    const moved = scripted([secondary({ retryAfterSeconds: 1 })]);
    expect(
      await postCommentWithRecovery({
        ...moved.boundaries,
        stillApplicable: async () => "the claim moved",
      }),
    ).toMatchObject({ status: "conflict" });
    expect(moved.posts()).toBe(1);
  });
  it("cancellation during the wait prevents any new dispatch", async () => {
    const controller = new AbortController();
    const t = scripted([secondary({ retryAfterSeconds: 1 })]);
    const r = await postCommentWithRecovery({
      ...t.boundaries,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    expect(r).toMatchObject({ status: "cancelled", attempts: 1 });
    expect(t.posts()).toBe(1);
  });
});

describe("classifying a comment write from structured signals (#345)", () => {
  const response = (status: number, headers: string[], body: unknown) =>
    parseGhResponse(
      `HTTP/2.0 ${status} X\r\n${headers.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`,
    );
  it("recognises GitHub's 'submitted too quickly' 422 as a secondary limit", () => {
    expect(
      classifyCommentResponse(
        response(422, ["X-Github-Request-Id: AB:1"], {
          message: "Validation Failed",
          errors: [
            {
              resource: "IssueComment",
              code: "unprocessable",
              message: "was submitted too quickly",
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "throttled", secondary: true, requestId: "AB:1" });
  });
  it("keeps a generic 422 a validation refusal and a 401 an auth refusal", () => {
    expect(
      classifyCommentResponse(
        response(422, [], {
          message: "Validation Failed",
          errors: [{ message: "body is too long" }],
        }),
      ),
    ).toMatchObject({ kind: "refused", category: "validation" });
    expect(
      classifyCommentResponse(response(401, [], { message: "Bad credentials" })),
    ).toMatchObject({ kind: "refused", category: "authentication" });
    expect(classifyCommentResponse(response(403, [], { message: "x" }))).toMatchObject({
      kind: "refused",
      category: "access",
    });
  });
  it("treats a secondary 403 with Retry-After as throttled with its timing", () => {
    expect(
      classifyCommentResponse(
        response(403, ["Retry-After: 30", "X-RateLimit-Remaining: 4000"], { message: "x" }),
      ),
    ).toMatchObject({ kind: "throttled", secondary: true, retryAfterSeconds: 30 });
  });
  it("treats 5xx, timeouts and a missing response as acceptance unknown", () => {
    expect(classifyCommentResponse(response(502, [], {}))).toMatchObject({ kind: "unknown" });
    expect(classifyCommentResponse(null, { timedOut: true })).toMatchObject({ kind: "unknown" });
    expect(classifyCommentResponse(null, { exitCode: 1 })).toMatchObject({ kind: "unknown" });
  });
  it("classifies GraphQL addComment answers by type, never by a body phrase", () => {
    expect(
      classifyAddComment(
        { data: null, errors: [{ type: "UNPROCESSABLE", message: "was submitted too quickly" }] },
        undefined,
      ),
    ).toMatchObject({ kind: "throttled", secondary: true });
    expect(
      classifyAddComment(
        { data: null, errors: [{ type: "UNPROCESSABLE", message: "nope" }] },
        null,
      ),
    ).toMatchObject({ kind: "refused" });
    expect(classifyAddComment({ data: null, errors: [{ message: "reset" }] }, null)).toMatchObject({
      kind: "unknown",
    });
  });
});

describe("the shared gh write boundary (#345)", () => {
  const comment = ["issue", "comment", "7", "--repo", "o/r", "--body", "hello <!-- op:1 -->"];
  function boundary(failures: unknown[], landed: string[] = []) {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let clock = T0;
    const run = withCommentRecovery({
      dispatch: async (args) => {
        calls.push(args);
        const failure = failures.shift();
        if (failure === "lost") {
          landed.push(args.at(-1)!);
          throw new Error("socket hang up");
        }
        if (failure) throw failure;
        landed.push(args.at(-1)!);
        return { url: "https://c/9" };
      },
      readBack: async (target) => {
        const n = landed.filter((b) => b === target.body).length;
        return n === 1
          ? { status: "found", url: "https://c/9" }
          : n
            ? { status: "duplicate", count: n }
            : { status: "absent" };
      },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { run, calls, sleeps, landed };
  }
  const throttle = () =>
    new RateLimitError(
      "limited",
      { retryAfterSeconds: 2 },
      {
        category: "secondary-rate-limit",
        quotaEvidence: null,
        errorTypes: [],
        httpStatus: 403,
        observation: {
          source: "response-header",
          resource: null,
          limit: null,
          remaining: null,
          used: null,
          resetAt: null,
          retryAfterSeconds: 2,
          retryAt: null,
          requestId: null,
        },
      },
    );
  it("passes non-comment commands through exactly once", async () => {
    const b = boundary([new Error("boom")]);
    await expect(b.run(["issue", "edit", "7"])).rejects.toThrow("boom");
    expect(b.calls).toHaveLength(1);
  });
  it("retries a throttled comment with the same frozen arguments", async () => {
    const b = boundary([throttle()]);
    await b.run(comment);
    expect(b.calls).toEqual([comment, comment]);
    expect(b.sleeps).toEqual([2000]);
    expect(b.landed).toHaveLength(1);
  });
  it("never retries an authentication failure", async () => {
    const b = boundary([new AuthenticationError("login")]);
    const error = await b.run(comment).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommentWriteError);
    expect((error as CommentWriteError).recovery).toMatchObject({
      status: "refused",
      category: "authentication",
      attempts: 1,
    });
    expect(b.calls).toHaveLength(1);
    expect(b.sleeps).toEqual([]);
  });
  it("confirms a lost reply by read-back without a duplicate", async () => {
    const b = boundary(["lost"]);
    expect(await b.run(comment)).toMatchObject({ status: "posted", matchedReceipt: true });
    expect(b.calls).toHaveLength(1);
    expect(b.landed).toHaveLength(1);
  });

  it("applyPlan reports a still-throttled comment as partial with when to retry", async () => {
    const b = boundary([throttle(), throttle()]);
    const plan: ClaimPlan = {
      ok: true,
      noop: false,
      facts: { number: 7, url: "https://github.com/o/r/issues/7", title: "t" },
      changes: [
        { step: "comment", command: comment },
        { step: "label", command: ["issue", "edit", "7", "--repo", "o/r", "--add-label", "x"] },
      ],
      notes: [],
      retry: "pdb release 7 --outcome done",
    } as unknown as ClaimPlan;
    const result = await applyPlan("o/r", plan, { run: b.run });
    expect(result.exitCode).toBe(1);
    const steps = "steps" in result ? result.steps! : [];
    expect(steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(steps[0]!.recovery).toMatchObject({ status: "throttled", attempts: 2 });
    const text = claimText(result);
    expect(text).toContain("secondary (content-creation) rate limit");
    expect(text).toContain(`Throttled by GitHub: re-run after ${steps[0]!.recovery!.retryAt}`);
    expect(text).not.toContain("Retry (safe;");
    expect(b.landed).toHaveLength(0);
  });
});
