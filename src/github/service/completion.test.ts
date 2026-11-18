import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { Rest } from "../github.js";
import type { GraphQuery } from "../../workflow/claims.js";

describe("typed GH service: completion (#889)", () => {
  it("reads issues, delivery comments, PRs, default branches, containment, and executes guarded steps", async () => {
    const queries: string[] = [];
    const restCalls: string[] = [];
    const runs: string[][] = [];

    const query: GraphQuery = async (gql, vars) => {
      queries.push(gql);
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
        runs.push(args);
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

    await gh.completion.executeStep("o/r", 42, ["issue", "close", "42"]);
    expect(runs).toEqual([["issue", "close", "42"]]);
  });

  it("routes completion.executeStep through the injected transport when provided", async () => {
    const calls: readonly string[][] = [];
    const transportCalls: (readonly string[])[] = [];
    const gh = createGhService({
      transport: async (call) => {
        transportCalls.push(call.args);
        if (call.args.includes("graphql")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              data: { repository: { issue: { state: "OPEN", labels: { nodes: [] } } } },
            }),
          };
        }
        return { ok: true, stdout: "" };
      },
    });

    await gh.completion.executeStep("o/r", 7, ["issue", "close", "7"]);
    expect(calls).toHaveLength(0);
    expect(transportCalls.some((args) => args.includes("close"))).toBe(true);
  });
});
