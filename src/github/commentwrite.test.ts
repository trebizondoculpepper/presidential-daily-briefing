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
  retryWait,
  withCommentRecovery,
} from "./commentwrite.js";
import type { CommentAttempt, CommentReceipt } from "./commentwrite.js";
import { parseGhResponse } from "./evidence.js";
import { applyPlan, claimText } from "../workflow/claims.js";
import type { ClaimPlan } from "../workflow/claims.js";
import { AuthenticationError, mutationMeta } from "./github.js";
import { ghCommentReceipt, RateLimitError } from "./dependencies.js";

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
      guard: async () => "unchanged",
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe("retryWait: the single wait formula (#345)", () => {
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
  const s = 1000;
  // [case, Retry-After seconds, Retry-After date, exhausted reset, expected wait, default used]
  const table: [string, number | null, string | null, string | null, number, boolean][] = [
    ["nothing", null, null, null, 60 * s, true],
    ["seconds only", 10, null, null, 10 * s, false],
    ["seconds beyond the default", 120, null, null, 120 * s, false],
    ["date only", null, iso(15 * s), null, 15 * s, false],
    ["seconds and a later date", 5, iso(20 * s), null, 20 * s, false],
    ["seconds and an earlier date", 30, iso(20 * s), null, 30 * s, false],
    ["zero seconds", 0, null, null, 60 * s, true],
    ["past date", null, iso(-5 * s), null, 60 * s, true],
    ["unparsable date", null, "not a date", null, 60 * s, true],
    ["reset sooner than the default, no Retry-After", null, null, iso(10 * s), 60 * s, true],
    ["reset later than the default, no Retry-After", null, null, iso(90 * s), 90 * s, true],
    ["reset with an invalid Retry-After", 0, iso(-1 * s), iso(10 * s), 60 * s, true],
    ["reset later than seconds", 10, null, iso(45 * s), 45 * s, false],
    ["reset earlier than seconds", 50, null, iso(45 * s), 50 * s, false],
    ["reset later than a date", null, iso(12 * s), iso(40 * s), 40 * s, false],
    ["past reset with seconds", 10, null, iso(-1 * s), 10 * s, false],
    ["past reset alone", null, null, iso(-1 * s), 60 * s, true],
    ["all three", 10, iso(25 * s), iso(35 * s), 35 * s, false],
  ];
  it.each(table)("%s", (_, retryAfterSeconds, retryAt, resetAt, wait, defaultDelay) => {
    expect(retryWait({ retryAfterSeconds, retryAt, resetAt }, T0, 60 * s)).toEqual({
      earliest: T0 + wait,
      defaultDelay,
    });
  });
  it("is what recovery waits for: a sooner reset never shortens the 60s default", async () => {
    const t = scripted([secondary({ resetAt: iso(10 * s) })]);
    await postCommentWithRecovery(t.boundaries);
    expect(t.sleeps).toEqual([60 * s]);
  });
});

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
  it("treats a past Retry-After date, a passed reset or a zero delay as the 60s default", async () => {
    for (const over of [
      { retryAt: new Date(T0 - 5_000).toISOString() },
      { resetAt: new Date(T0 - 1_000).toISOString() },
      { retryAfterSeconds: 0 },
    ]) {
      const t = scripted([secondary(over)]);
      const r = await postCommentWithRecovery(t.boundaries);
      expect(t.sleeps).toEqual([60_000]);
      expect(r).toMatchObject({ status: "posted", attempts: 2 });
    }
    const t = scripted([secondary({ retryAt: new Date(T0 - 5_000).toISOString() }), secondary()]);
    expect(await postCommentWithRecovery(t.boundaries)).toMatchObject({
      status: "throttled",
      defaultDelay: true,
    });
  });
  /** A deadline timer that fires as soon as `fire()` is called, advancing the injected clock. */
  function slowDeadline() {
    let fire: () => void = () => {};
    return {
      fire: () => fire(),
      deadlineTimer: (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          fire = resolve;
          signal.addEventListener("abort", () => reject(new Error("cleared")), { once: true });
        }),
    };
  }
  it("reports a POST still in flight at the deadline as may-have-been-posted", async () => {
    const d = slowDeadline();
    let posts = 0;
    const pending = postCommentWithRecovery({
      post: () => {
        posts += 1;
        return new Promise<CommentAttempt>(() => {});
      },
      readBack: async () => ({ status: "absent" }),
      deadlineTimer: d.deadlineTimer,
    });
    await Promise.resolve();
    d.fire();
    const r = await pending;
    expect(r).toMatchObject({ status: "unknown", acceptance: "unknown", attempts: 1 });
    expect(r.message).toContain("may have been posted");
    expect(posts).toBe(1);
  });
  it("stops without retrying when a recovery read outlives the deadline", async () => {
    const d = slowDeadline();
    const t = scripted([secondary({ retryAfterSeconds: 1 })]);
    const pending = postCommentWithRecovery({
      ...t.boundaries,
      readBack: () => {
        setTimeout(() => d.fire(), 0);
        return new Promise<CommentReceipt>(() => {});
      },
      deadlineTimer: d.deadlineTimer,
    });
    const r = await pending;
    expect(r).toMatchObject({ status: "throttled", acceptance: "not-accepted", attempts: 1 });
    expect(t.posts()).toBe(1);
  });
  it("stops when the guard re-read outlives the deadline", async () => {
    const d = slowDeadline();
    const t = scripted([secondary({ retryAfterSeconds: 1 })]);
    let reads = 0;
    const r = await postCommentWithRecovery({
      ...t.boundaries,
      guard: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve("s");
        setTimeout(() => d.fire(), 0);
        return new Promise<string>(() => {});
      },
      deadlineTimer: d.deadlineTimer,
    });
    expect(r).toMatchObject({ status: "conflict" });
    expect(r.message).toContain("within the deadline");
    expect(t.posts()).toBe(1);
  });
  it("takes the guard baseline before the first POST, so a change while it is pending counts", async () => {
    let state = "unclaimed";
    let posts = 0;
    const reads: string[] = [];
    const r = await postCommentWithRecovery({
      post: async () => {
        posts += 1;
        // A competing claim lands while the first POST is in flight, then GitHub throttles it.
        if (posts === 1) state = "claimed by bob";
        return posts === 1 ? secondary({ retryAfterSeconds: 1 }) : { kind: "posted", url: "u" };
      },
      readBack: async () => ({ status: "absent" }),
      guard: async () => {
        reads.push(state);
        return state;
      },
      sleep: async () => {},
    });
    expect(reads[0]).toBe("unclaimed");
    expect(r).toMatchObject({ status: "conflict", attempts: 1 });
    expect(posts).toBe(1);
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
  it("cancellation during the pre-retry read-back stops at once: no re-check, no retry", async () => {
    const controller = new AbortController();
    const t = scripted([secondary({ retryAfterSeconds: 1 })]);
    let rechecks = 0;
    const r = await postCommentWithRecovery({
      ...t.boundaries,
      signal: controller.signal,
      readBack: () => {
        setTimeout(() => controller.abort(), 0);
        return new Promise<CommentReceipt>(() => {});
      },
      stillApplicable: async () => {
        rechecks += 1;
        return null;
      },
    });
    expect(r).toMatchObject({ status: "cancelled", acceptance: "not-accepted", attempts: 1 });
    expect(rechecks).toBe(0);
    expect(t.posts()).toBe(1);
  });
  it("cancellation during a lost reply's read-back reports may-have-been-posted", async () => {
    const controller = new AbortController();
    const t = scripted(["lost"]);
    const r = await postCommentWithRecovery({
      ...t.boundaries,
      signal: controller.signal,
      readBack: () => {
        setTimeout(() => controller.abort(), 0);
        return new Promise<CommentReceipt>(() => {});
      },
    });
    expect(r).toMatchObject({ status: "cancelled", acceptance: "unknown", attempts: 1 });
    expect(r.message).toContain("may have been posted");
    expect(t.posts()).toBe(1);
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
  it("keeps an exhausted primary reset on a secondary refusal and waits for the later", async () => {
    const reset = Math.floor(T0 / 1000) + 45;
    const attempt = classifyCommentResponse(
      response(
        403,
        ["Retry-After: 10", "X-RateLimit-Remaining: 0", `X-RateLimit-Reset: ${reset}`],
        { documentation_url: "https://docs.github.com/rest#secondary-rate-limits" },
      ),
    );
    expect(attempt).toMatchObject({
      kind: "throttled",
      secondary: true,
      retryAfterSeconds: 10,
      resetAt: new Date(reset * 1000).toISOString(),
    });
    const t = scripted([attempt, attempt]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(t.sleeps).toEqual([45_000]);
    expect(r).toMatchObject({ status: "throttled", resetAt: new Date(reset * 1000).toISOString() });
  });
  it("treats 5xx, timeouts and a missing response as acceptance unknown", () => {
    expect(classifyCommentResponse(response(502, [], {}))).toMatchObject({ kind: "unknown" });
    expect(classifyCommentResponse(null, { timedOut: true })).toMatchObject({ kind: "unknown" });
    expect(classifyCommentResponse(null, { exitCode: 1 })).toMatchObject({ kind: "unknown" });
  });
  it("treats a server-side or unregistered addComment error as acceptance unknown", () => {
    for (const type of ["INTERNAL", "SERVICE_UNAVAILABLE", "SOMETHING_NEW"])
      expect(
        classifyAddComment({ data: { addComment: null }, errors: [{ type, message: "x" }] }, null),
      ).toMatchObject({ kind: "unknown" });
    expect(
      classifyAddComment({ data: null, errors: [{ type: "FORBIDDEN", message: "x" }] }, null),
    ).toMatchObject({ kind: "refused", category: "access" });
    expect(
      classifyAddComment({ data: null, errors: [{ type: "NOT_FOUND", message: "x" }] }, null),
    ).toMatchObject({ kind: "refused" });
  });
  it("keeps an exhausted reset on a throttled GraphQL comment and waits for the later", async () => {
    const reset = Math.floor(T0 / 1000) + 40;
    const meta = mutationMeta(
      parseGhResponse(
        `HTTP/2.0 200 OK\r\nRetry-After: 10\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${reset}\r\n\r\n{}`,
      ),
    );
    expect(meta).toMatchObject({
      retryAfterSeconds: 10,
      resetAt: new Date(reset * 1000).toISOString(),
    });
    const attempt = classifyAddComment(
      {
        data: { addComment: null },
        errors: [{ type: "UNPROCESSABLE", message: "was submitted too quickly" }],
        response: meta,
      },
      null,
    );
    expect(attempt).toMatchObject({ kind: "throttled", secondary: true, resetAt: meta.resetAt });
    const t = scripted([attempt, attempt]);
    const r = await postCommentWithRecovery(t.boundaries);
    expect(t.sleeps).toEqual([40_000]);
    expect(r).toMatchObject({ status: "throttled", resetAt: meta.resetAt });
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
  function boundary(failures: unknown[], landed: string[] = [], onWait?: () => void) {
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
        onWait?.();
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
    await b.run(comment, { guard: async () => "same" });
    // Both attempts send the same frozen arguments, the body carrying one per-run nonce.
    expect(b.calls[0]).toEqual(b.calls[1]);
    expect(b.calls[0]!.at(-1)).toMatch(
      /^hello <!-- op:1 -->\n\n<!-- github-triage:write:[\w-]+ -->$/,
    );
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

  it("does not retry a throttled comment whose command supplies no re-check", async () => {
    const b = boundary([throttle()]);
    const error = await b.run(comment).catch((e: unknown) => e);
    expect((error as CommentWriteError).recovery).toMatchObject({
      status: "throttled",
      attempts: 1,
    });
    expect((error as CommentWriteError).message).toContain("Retry after");
    expect(b.calls).toHaveLength(1);
    expect(b.sleeps).toEqual([]);
  });

  /** A fake ticket read through the command's own injected query. */
  function ticket() {
    const state = {
      state: "OPEN",
      labels: ["status:ready"],
      assignees: [] as string[],
      comments: 3,
    };
    const query = async () => ({
      repository: {
        issue: {
          state: state.state,
          labels: {
            totalCount: state.labels.length,
            nodes: state.labels.map((name) => ({ name })),
          },
          assignees: { nodes: state.assignees.map((login) => ({ login })) },
          comments: { totalCount: state.comments },
        },
      },
    });
    return { state, query };
  }
  const plan = (step: string, retry: string) =>
    ({
      ok: true,
      noop: false,
      facts: { number: 7, url: "https://github.com/o/r/issues/7", title: "t" },
      changes: [
        { step: "comment", command: comment },
        { step, command: ["issue", "edit", "7", "--repo", "o/r", "--add-label", "x"] },
      ],
      notes: [],
      retry,
    }) as unknown as ClaimPlan;

  it("applyPlan retries after the wait when the ticket is unchanged", async () => {
    const t = ticket();
    const b = boundary([throttle()]);
    const result = await applyPlan("o/r", plan("label", "pdb claim 7"), {
      run: b.run,
      query: t.query,
    });
    const steps = "steps" in result ? result.steps! : [];
    expect(steps[0]!.status).toBe("done");
    expect(b.landed.filter((x) => x.startsWith(comment.at(-1)!))).toHaveLength(1);
    expect(b.sleeps).toEqual([2000]);
  });
  it("applyPlan reports a still-throttled comment as partial with when to retry", async () => {
    const t = ticket();
    const b = boundary([throttle(), throttle()]);
    const result = await applyPlan("o/r", plan("label", "pdb release 7 --outcome done"), {
      run: b.run,
      query: t.query,
    });
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
  it("claim: does not post when someone else claims the ticket during the wait", async () => {
    const t = ticket();
    const b = boundary([throttle()], [], () => {
      t.state.labels.push("agent:someone-else");
      t.state.assignees.push("someone-else");
    });
    const result = await applyPlan("o/r", plan("label", "pdb claim 7"), {
      run: b.run,
      query: t.query,
    });
    const steps = "steps" in result ? result.steps! : [];
    expect(steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(steps[0]!.recovery).toMatchObject({ status: "conflict", attempts: 1 });
    expect(steps[0]!.reason).toContain("changed during the wait");
    expect(b.calls).toHaveLength(1);
    expect(b.landed).toHaveLength(0);
  });
  it("release: does not post when the ticket is closed or a record appears during the wait", async () => {
    for (const change of [
      (s: { state: string }) => void (s.state = "CLOSED"),
      (s: { comments: number }) => void (s.comments += 1),
    ]) {
      const t = ticket();
      const b = boundary([throttle()], [], () => change(t.state));
      const result = await applyPlan("o/r", plan("label", "pdb release 7 --outcome done"), {
        run: b.run,
        query: t.query,
      });
      expect(result.exitCode).toBe(1);
      const steps = "steps" in result ? result.steps! : [];
      expect(steps[0]!.recovery).toMatchObject({ status: "conflict" });
      expect(b.calls).toHaveLength(1);
    }
  });
  describe("release, reclaim, throttle and retry: receipts bound to this attempt", () => {
    const claimBody = "Claimed by `ana` on `fix/7`. <!-- github-triage:claim:abc123 -->";
    const claim = ["issue", "comment", "7", "--repo", "o/r", "--body", claimBody];
    function reclaim(failures: unknown[]) {
      let clock = T0;
      const sleeps: number[] = [];
      // The earlier acquisition's identical claim comment, an hour before this attempt.
      const comments = [{ body: claimBody, createdAt: new Date(T0 - 3_600_000).toISOString() }];
      const query = async () => ({
        repository: {
          issue: {
            comments: {
              pageInfo: { hasPreviousPage: false },
              nodes: comments.map((c, i) => ({
                ...c,
                url: `https://c/${i}`,
                viewerDidAuthor: true,
              })),
            },
          },
        },
      });
      let posts = 0;
      const run = withCommentRecovery({
        dispatch: async (args) => {
          posts += 1;
          const failure = failures.shift();
          const body = args.at(-1)!;
          if (failure === "lost") {
            comments.push({ body, createdAt: new Date(clock).toISOString() });
            throw new Error("socket hang up");
          }
          if (failure) throw failure;
          comments.push({ body, createdAt: new Date(clock).toISOString() });
          return { url: `https://c/${comments.length - 1}` };
        },
        readBack: (target, since) => ghCommentReceipt(target, since, query),
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      });
      return { run, comments, posts: () => posts, sleeps };
    }
    it("does not take the earlier claim comment as this throttled claim's receipt", async () => {
      const t = reclaim([throttle()]);
      expect(await t.run(claim, { guard: async () => "same" })).toMatchObject({
        status: "posted",
        matchedReceipt: false,
        attempts: 2,
      });
      expect(t.posts()).toBe(2);
      expect(t.comments).toHaveLength(2);
      expect(t.sleeps).toEqual([2000]);
    });
    it("confirms only this attempt's lost-reply claim, not the earlier one", async () => {
      const t = reclaim(["lost"]);
      expect(await t.run(claim, { guard: async () => "same" })).toMatchObject({
        status: "posted",
        matchedReceipt: true,
        url: "https://c/1",
      });
      expect(t.posts()).toBe(1);
      expect(t.comments).toHaveLength(2);
    });
    it("ignores an identical earlier comment even inside the clock-skew window", async () => {
      const t = reclaim(["lost"]);
      // The earlier claim landed one second before this run: the time check alone would match it.
      t.comments[0]!.createdAt = new Date(T0 - 1_000).toISOString();
      t.comments[0]!.body = `${claimBody}\n\n<!-- github-triage:write:earlier-run -->`;
      expect(await t.run(claim, { guard: async () => "same" })).toMatchObject({
        status: "posted",
        url: "https://c/1",
      });
      const bare = reclaim([new Error("socket hang up")]);
      bare.comments[0]!.createdAt = new Date(T0 - 1_000).toISOString();
      const error = await bare.run(claim).catch((e: unknown) => e);
      expect((error as CommentWriteError).recovery).toMatchObject({ status: "unknown" });
    });
    it("reports a lost reply as unknown when only the earlier claim exists", async () => {
      const t = reclaim([new Error("socket hang up")]);
      const error = await t.run(claim).catch((e: unknown) => e);
      expect((error as CommentWriteError).recovery).toMatchObject({ status: "unknown" });
      expect(t.posts()).toBe(1);
    });
  });
});
