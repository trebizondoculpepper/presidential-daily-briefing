import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { GhCall, GhOutcome } from "./transport.js";
import { CommentWriteError } from "../commentwrite.js";

// Synthetic gh answers only; no network, no real comment is ever posted.
const http = (status: string, headers: string[], body: unknown): string =>
  [`HTTP/2.0 ${status}`, ...headers, "", JSON.stringify(body)].join("\r\n");
const posted: GhOutcome = {
  ok: true,
  stdout: http("201 Created", ["Content-Type: application/json"], {
    html_url: "https://example.test/c/1",
  }),
};
const refused = (status: string, headers: string[], body: unknown): GhOutcome => ({
  ok: false,
  kind: "exit",
  exitCode: 1,
  stdout: http(status, headers, body),
  stderr: "",
});

function service(answers: GhOutcome[]) {
  const calls: GhCall[] = [];
  const svc = createGhService({
    env: { GH_HOST: "ghe.example" },
    transport: async (call) => {
      calls.push(call);
      return answers.shift() ?? posted;
    },
    // No receipt is ever found: the comment list is empty and complete.
    query: async () => ({
      repository: {
        issueOrPullRequest: { comments: { pageInfo: { hasPreviousPage: false }, nodes: [] } },
      },
    }),
    commentRecovery: { sleep: async () => undefined, nonce: () => "nonce-1" },
  });
  return { svc, calls };
}
const target = { repository: "o/r", number: 5, body: "hello" };

describe("typed comment writes (#918)", () => {
  it("posts once over the service's transport and environment, with this write's nonce", async () => {
    const { svc, calls } = service([posted]);
    const result = await svc.comments.create(target);
    expect(result).toMatchObject({
      status: "posted",
      attempts: 1,
      url: "https://example.test/c/1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toEqual({ GH_HOST: "ghe.example" });
    expect(calls[0]!.args.slice(0, 5)).toEqual([
      "api",
      "--include",
      "--method",
      "POST",
      "repos/o/r/issues/5/comments",
    ]);
    expect(calls[0]!.args[6]).toBe("body=hello\n\n<!-- github-triage:write:nonce-1 -->");
  });

  it("rejects a plain refusal without retrying", async () => {
    const { svc, calls } = service([
      refused("422 Unprocessable Entity", ["Content-Type: application/json"], {
        message: "Validation Failed",
      }),
    ]);
    await expect(svc.comments.create(target)).rejects.toBeInstanceOf(CommentWriteError);
    expect(calls).toHaveLength(1);
  });

  it("retries once after a secondary rate limit when the guard is unchanged", async () => {
    const { svc, calls } = service([
      refused("403 Forbidden", ["Content-Type: application/json", "Retry-After: 1"], {
        message: "You have exceeded a secondary rate limit.",
      }),
      posted,
    ]);
    const result = await svc.comments.create(target, { guard: async () => "same" });
    expect(result).toMatchObject({ status: "posted", attempts: 2 });
    expect(calls).toHaveLength(2);
  });
  it("treats a 2xx without a readable comment as unknown and reads back instead of re-posting", async () => {
    const { svc, calls } = service([
      { ok: true, stdout: http("201 Created", ["Content-Type: application/json"], {}) },
    ]);
    await expect(svc.comments.create(target)).rejects.toBeInstanceOf(CommentWriteError);
    expect(calls).toHaveLength(1);
  });

  it("never allows more than one retry, whatever policy is supplied", async () => {
    const limited = refused("403 Forbidden", ["Content-Type: application/json", "Retry-After: 1"], {
      message: "You have exceeded a secondary rate limit.",
    });
    const calls: GhCall[] = [];
    const svc = createGhService({
      env: {},
      transport: async (call) => {
        calls.push(call);
        return limited;
      },
      query: async () => ({
        repository: {
          issueOrPullRequest: { comments: { pageInfo: { hasPreviousPage: false }, nodes: [] } },
        },
      }),
      commentRecovery: {
        sleep: async () => undefined,
        nonce: () => "n",
        policy: { maxAttempts: 5 },
      },
    });
    await expect(svc.comments.create(target, { guard: async () => "same" })).rejects.toBeInstanceOf(
      CommentWriteError,
    );
    expect(calls).toHaveLength(2);
  });

  it("reads receipts on pull requests as well as issues", async () => {
    let asked = "";
    const svc = createGhService({
      env: {},
      transport: async () => ({
        ok: false,
        kind: "timeout",
        exitCode: null,
        stdout: "",
        stderr: "",
      }),
      query: async (q: string) => {
        asked = q;
        return {
          repository: {
            issueOrPullRequest: {
              comments: {
                pageInfo: { hasPreviousPage: false },
                nodes: [
                  {
                    url: "https://example.test/pr-c",
                    body: "hello\n\n<!-- github-triage:write:nonce-pr -->",
                    viewerDidAuthor: true,
                    createdAt: new Date(Date.now() + 1000).toISOString(),
                  },
                ],
              },
            },
          },
        };
      },
      commentRecovery: { sleep: async () => undefined, nonce: () => "nonce-pr" },
    });
    // The POST's reply was lost (timeout), but the read-back finds this write on the PR.
    expect(await svc.comments.create(target)).toMatchObject({
      status: "posted",
      url: "https://example.test/pr-c",
    });
    expect(asked).toContain("... on PullRequest");
  });
});
