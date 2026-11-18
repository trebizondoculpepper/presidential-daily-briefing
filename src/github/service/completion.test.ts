import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { Rest } from "../github.js";
import type { GraphQuery } from "../../workflow/claims.js";

describe("typed GH service: completion (#889)", () => {
  it("reads issues, delivery comments, PRs, default branches, containment, and executes typed completion writes", async () => {
    const restCalls: string[] = [];
    const runs: { args: string[]; guarded: boolean }[] = [];

    const query: GraphQuery = async (gql, vars) => {
      if (gql.includes("issueOrPullRequest")) {
        return {
          viewer: { __typename: "User", login: "alice" },
          repository: {
            issueOrPullRequest: {
              __typename: "Issue",
              number: 42,
              title: "Complete me",
              url: "https://github.com/o/r/issues/42",
              state: "OPEN",
              stateReason: null,
              labels: { nodes: [{ name: "status:ready" }] },
              timelineItems: { nodes: [] },
              comments: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
            },
          },
        };
      }
      if (gql.includes("resource(url:")) {
        return {
          resource: {
            __typename: "PullRequest",
            id: "PR_99",
            number: 99,
            url: "https://github.com/o/r/pull/99",
            state: "MERGED",
            merged: true,
            isDraft: false,
            baseRefName: "main",
            baseRepository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
            mergeCommit: { oid: "abc1234567890" },
          },
        };
      }
      if (gql.includes("defaultBranchRef")) {
        return { repository: { defaultBranchRef: { name: "main" } } };
      }
      if (gql.includes("issue(") && gql.includes("state")) {
        return { repository: { issue: { state: "OPEN", labels: { nodes: [] } } } };
      }
      throw new Error(`Unexpected query: ${JSON.stringify(vars)}`);
    };

    const rest: Rest = async (path) => {
      restCalls.push(path);
      return { status: 200, body: { status: "behind" } };
    };

    const gh = createGhService({
      query,
      rest,
      run: async (args, call) => {
        if (call?.guard) await call.guard();
        runs.push({ args, guarded: Boolean(call?.guard) });
      },
    });

    let count = 0;
    const counted = gh.completion.counted(() => {
      count++;
    });

    const read = await counted.readIssue("o/r", 42);
    expect(read.viewer?.login).toBe("alice");
    expect(read.item?.__typename).toBe("Issue");

    const pr = await counted.readPr("https://github.com/o/r/pull/99");
    expect(pr?.number).toBe(99);

    const branch = await counted.defaultBranch("o/r");
    expect(branch).toBe("main");

    const containment = await counted.targetContainment(
      { repository: "o/r", branch: "main" },
      "abc1234567890",
      async () => "main",
    );
    expect(containment.state).toBe("contained");
    expect(count).toBe(4);
    expect(restCalls).toEqual(["repos/o/r/compare/main...abc1234567890"]);

    await gh.completion.recordCompletion("o/r", 42, "Completion body");
    await gh.completion.closeIssue("o/r", 42);
    await gh.completion.removeLabel("o/r", 42, "status:awaiting-review");
    expect(runs).toEqual([
      {
        args: ["issue", "comment", "42", "--repo", "o/r", "--body", "Completion body"],
        guarded: true,
      },
      {
        args: ["issue", "close", "42", "--repo", "o/r", "--reason", "completed"],
        guarded: true,
      },
      {
        args: ["issue", "edit", "42", "--repo", "o/r", "--remove-label", "status:awaiting-review"],
        guarded: true,
      },
    ]);
  });

  it("routes typed writes through transport and env while preserving comment recovery", async () => {
    const transportCalls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const customEnv = { GH_HOST: "ghe.example.com" };
    let postedBody = "";
    const gh = createGhService({
      env: customEnv,
      transport: async (call) => {
        transportCalls.push({ args: call.args, env: call.env });
        if (call.args.includes("graphql") && call.args.some((a) => a.includes("viewerDidAuthor"))) {
          return {
            ok: true,
            stdout: JSON.stringify({
              data: {
                repository: {
                  issueOrPullRequest: {
                    comments: {
                      pageInfo: { hasPreviousPage: false },
                      nodes: [
                        {
                          url: "https://ghe.example.com/o/r/issues/7#issuecomment-1",
                          body: postedBody,
                          viewerDidAuthor: true,
                          createdAt: new Date().toISOString(),
                        },
                      ],
                    },
                  },
                },
              },
            }),
          };
        }
        if (call.args.includes("graphql")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              data: { repository: { issue: { state: "OPEN", labels: { nodes: [] } } } },
            }),
          };
        }
        if (call.args.includes("repos/o/r/issues/7/comments")) {
          const bodyArg = call.args.find((a) => a.startsWith("body="));
          if (bodyArg) postedBody = bodyArg.slice("body=".length);
          // Simulate a timeout after dispatch: withCommentRecovery recovers via receipt read-back.
          return {
            ok: false,
            kind: "timeout",
            exitCode: null,
            stdout: "",
            stderr: "",
          };
        }
        return { ok: true, stdout: "" };
      },
    });

    await gh.completion.recordCompletion("o/r", 7, "Completion body");
    await gh.completion.closeIssue("o/r", 7);

    expect(transportCalls.every((c) => c.env === customEnv)).toBe(true);
    expect(transportCalls.some((c) => c.args.includes("repos/o/r/issues/7/comments"))).toBe(true);
    expect(transportCalls.some((c) => c.args.includes("close"))).toBe(true);
  });
});
