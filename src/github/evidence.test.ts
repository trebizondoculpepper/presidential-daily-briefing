/**
 * Same-response GitHub evidence (#293, doc/design/github-request-telemetry.md): framing, the
 * header allowlist, classification from structured signals, honest messages, and the gh
 * transport keeping all of it on the error. Synthetic fixtures only; no live snapshot.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  classifyGhFailure,
  GhResponseFramingError,
  parseGhResponse,
  quotaObservation,
  rateLimitMessage,
} from "./evidence.js";
import { RateLimitError } from "./dependencies.js";
import { ghQueryWith } from "./github.js";

const secret = "API rate limit already exceeded for user ID 783193.";
const headers = (h: Record<string, string>, status = "HTTP/2.0 200 OK") =>
  [status, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`)].join("\n");
const response = (h: Record<string, string>, body: unknown, status?: string) =>
  `${headers(h, status)}\n\n${JSON.stringify(body)}`;
const quota = (remaining: number, extra: Record<string, string> = {}) => ({
  "X-Ratelimit-Limit": "5000",
  "X-Ratelimit-Remaining": String(remaining),
  "X-Ratelimit-Used": String(5000 - remaining),
  "X-Ratelimit-Reset": "1794710456",
  "X-Ratelimit-Resource": "graphql",
  "X-Github-Request-Id": "EE3B:6B152:1C923B2:2C490F4:6AF91209",
  ...extra,
});
const limited = { errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: secret }] };

describe("gh --include framing", () => {
  it("separates the final response block from the body, with case-insensitive headers", () => {
    const parsed = parseGhResponse(response({ "X-RateLimit-Remaining": "7" }, { data: {} }));
    expect(parsed).toMatchObject({ status: 200, body: '{"data":{}}' });
    expect(parsed.headers.get("x-ratelimit-remaining")).toBe("7");
  });

  it("accepts CRLF, interim blocks and output without headers", () => {
    const crlf = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 403 Forbidden\r\nRetry-After: 9\r\n\r\n{}";
    expect(parseGhResponse(crlf)).toMatchObject({ status: 403, body: "{}" });
    expect(parseGhResponse(crlf).headers.get("retry-after")).toBe("9");
    expect(parseGhResponse('{"data":{}}')).toMatchObject({ status: null, body: '{"data":{}}' });
  });

  it("refuses malformed framing instead of splitting at arbitrary text", () => {
    expect(() => parseGhResponse("HTTP/2.0 200 OK\nX-A: 1")).toThrow(GhResponseFramingError);
    expect(() => parseGhResponse("HTTP/2.0 two hundred\n\n{}")).toThrow(GhResponseFramingError);
    expect(() => parseGhResponse("HTTP/2.0 200 OK\nnot a header\n\n{}")).toThrow(
      GhResponseFramingError,
    );
  });
});

describe("allowlisted quota evidence", () => {
  it("keeps validated numbers, the reset, the resource and the request id; missing is null", () => {
    expect(quotaObservation(parseGhResponse(response(quota(0), {})).headers)).toEqual({
      source: "response-header",
      resource: "graphql",
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: new Date(1794710456 * 1000).toISOString(),
      retryAfterSeconds: null,
      retryAt: null,
      requestId: "EE3B:6B152:1C923B2:2C490F4:6AF91209",
    });
    expect(quotaObservation(new Map())).toMatchObject({ remaining: null, resetAt: null });
  });

  it("treats malformed values as unknown and keeps Retry-After duration and date apart", () => {
    const odd = new Map([
      ["x-ratelimit-remaining", "-1"],
      ["x-ratelimit-limit", "lots"],
      ["x-ratelimit-resource", "graph ql; token=ghp_x"],
      ["retry-after", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ]);
    expect(quotaObservation(odd)).toMatchObject({
      remaining: null,
      limit: null,
      resource: null,
      retryAfterSeconds: null,
      retryAt: "2026-10-21T07:28:00.000Z",
    });
    expect(quotaObservation(new Map([["retry-after", "120"]])).retryAfterSeconds).toBe(120);
  });
});

describe("classification from structured evidence", () => {
  const classify = (h: Record<string, string>, body: unknown, status?: string, extra = {}) =>
    classifyGhFailure({ response: parseGhResponse(response(h, body, status)), ...extra });

  it("RATE_LIMIT with the same response's quota exhausted is primary, with its reset", () => {
    const c = classify(quota(0), limited);
    expect(c).toMatchObject({ category: "rate-limited", quotaEvidence: "exhausted" });
    expect(rateLimitMessage(c)).toBe(
      `GitHub query was rate limited: quota exhausted (graphql); this response reports a reset at ${new Date(1794710456 * 1000).toISOString()}.`,
    );
  });

  it("a refusal while the same response reports quota left is inconsistent, never a guessed reset", () => {
    // The #293 reproduction: RATE_LIMIT / graphql_rate_limit with remaining=5000, used=0.
    const c = classify(quota(5000), limited);
    expect(c).toMatchObject({ category: "rate-limited", quotaEvidence: "inconsistent" });
    const message = rateLimitMessage(c);
    expect(message).toBe(
      "GitHub refused the query as rate limited, but this same response reported 5000 of 5000 remaining (graphql); the cause and retry time are unproven.",
    );
    expect(message).not.toContain("783193");
  });

  it("recognises both GraphQL spellings and the code; missing quota is unknown", () => {
    for (const body of [
      { errors: [{ type: "RATE_LIMITED" }] },
      { errors: [{ code: "graphql_rate_limit" }] },
    ])
      expect(classify({}, body)).toMatchObject({
        category: "rate-limited",
        quotaEvidence: "unknown",
      });
    expect(rateLimitMessage(classify({}, limited))).toBe(
      "GitHub query was rate limited; this response reported no quota or reset.",
    );
  });

  it("separates secondary, resource, auth, access, server and unknown failures", () => {
    const secondary = classify(
      { "Retry-After": "60" },
      {
        message: "slow down",
        documentation_url: "https://docs.github.com/rest/#secondary-rate-limits",
      },
      "HTTP/2.0 403 Forbidden",
    );
    expect(secondary.category).toBe("secondary-rate-limit");
    expect(rateLimitMessage(secondary)).toBe(
      "GitHub applied a secondary rate limit; it asked to retry after 60s.",
    );
    expect(classify({}, { errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED" }] }).category).toBe(
      "resource-limit",
    );
    expect(classify({}, {}, "HTTP/2.0 429 Too Many Requests").category).toBe("rate-limited");
    expect(classify(quota(0), { message: "x" }, "HTTP/2.0 403 Forbidden")).toMatchObject({
      category: "rate-limited",
      quotaEvidence: "exhausted",
    });
    expect(
      classify(quota(10), { message: "Resource not accessible" }, "HTTP/2.0 403 Forbidden")
        .category,
    ).toBe("access");
    expect(classify({}, { message: "Bad credentials" }, "HTTP/2.0 401 Unauthorized").category).toBe(
      "authentication",
    );
    expect(classifyGhFailure({ response: null, exitCode: 4 }).category).toBe("authentication");
    expect(classify({}, {}, "HTTP/2.0 502 Bad Gateway").category).toBe("server");
    expect(classifyGhFailure({ response: null, timedOut: true }).category).toBe("timeout");
    expect(classifyGhFailure({ response: null, aborted: true }).category).toBe("cancelled");
    expect(classifyGhFailure({ response: null }).category).toBe("no-response");
    expect(classify({}, { errors: [{ type: "SOMETHING_NEW", message: secret }] })).toMatchObject({
      category: "unknown",
      errorTypes: ["OTHER"],
    });
  });

  it("never classifies from repository content in a body", () => {
    const content = {
      data: { repository: { issue: { body: "API rate limit exceeded; RATE_LIMITED" } } },
    };
    expect(classify(quota(4000), content).category).toBe("unknown");
  });
});

describe("gh transport keeps the same-response evidence (#293)", () => {
  /** A fake gh printing `output` and exiting `code`, checking --include is requested. */
  async function withGh(output: string, code: number, run: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "triage-gh-evidence-"));
    const path = process.env.PATH;
    try {
      await writeFile(join(dir, "out"), output);
      await writeFile(
        join(dir, "gh"),
        `#!/bin/sh\ncase " $* " in *" --include "*) ;; *) exit 97 ;; esac\ncat "${join(dir, "out")}"\nexit ${code}\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${dir}:${path}`;
      await run();
    } finally {
      process.env.PATH = path;
      await rm(dir, { recursive: true });
    }
  }

  it.skipIf(process.platform === "win32")(
    "an inconsistent refusal becomes a RateLimitError with the evidence and no reset",
    async () => {
      await withGh(response(quota(5000), limited), 1, async () => {
        const error = await ghQueryWith()("query{viewer{login}}", {}).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RateLimitError);
        const limit = error as RateLimitError;
        expect(limit.retry).toEqual({ retryAfterSeconds: null, resetAt: null });
        expect(limit.evidence).toMatchObject({
          category: "rate-limited",
          quotaEvidence: "inconsistent",
          observation: { remaining: 5000, resource: "graphql" },
        });
        expect(limit.message).toContain("the cause and retry time are unproven");
        expect(JSON.stringify(limit)).not.toContain("783193");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "an exhausted quota keeps its reset; success and NOT_FOUND-only answers are unchanged",
    async () => {
      await withGh(response(quota(0), limited), 1, async () => {
        const error = (await ghQueryWith()("q", {}).catch((e: unknown) => e)) as RateLimitError;
        expect(error.retry.resetAt).toBe(new Date(1794710456 * 1000).toISOString());
      });
      await withGh(response(quota(4000), { data: { viewer: { login: "x" } } }), 0, async () => {
        expect(await ghQueryWith()("q", {})).toEqual({ viewer: { login: "x" } });
      });
      const notFound = { data: { repository: { issue: null } }, errors: [{ type: "NOT_FOUND" }] };
      await withGh(response(quota(4000), notFound), 1, async () => {
        expect(await ghQueryWith()("q", {})).toEqual({ repository: { issue: null } });
      });
    },
  );
});
