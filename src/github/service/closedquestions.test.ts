import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { Rest } from "../github.js";
import type { GraphQuery } from "../../workflow/claims.js";

describe("typed GH service: closedQuestions (#899)", () => {
  it("lists closed issue pages, comment pages, unavailable issues, and permission lookups", async () => {
    const query: GraphQuery = async (gql, vars) => {
      if (gql.includes("filterBy:{since:")) {
        return {
          repository: {
            issues: {
              nodes: [{ url: "https://github.com/o/r/issues/2", number: 2, state: "CLOSED" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      if (gql.includes("states:CLOSED")) {
        return {
          repository: {
            issues: {
              nodes: [{ url: "https://github.com/o/r/issues/1", number: 1, state: "CLOSED" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        };
      }
      if (gql.includes("issueOrPullRequest")) {
        if ((vars as { number?: number }).number === 999) {
          return { repository: { issueOrPullRequest: null } };
        }
        return {
          repository: {
            issueOrPullRequest: {
              comments: {
                nodes: [{ id: "C_1", body: "hello" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${gql}`);
    };
    const rest: Rest = async () => ({
      status: 200,
      body: { permission: "write" },
    });

    const gh = createGhService({ query, rest });

    const baseline = await gh.closedQuestions.listClosedIssues("o/r", { pageSize: 50 });
    expect(baseline).toEqual({
      issues: [{ url: "https://github.com/o/r/issues/1", number: 1, state: "CLOSED" }],
      hasNextPage: true,
      endCursor: "c1",
    });

    const refresh = await gh.closedQuestions.listClosedIssues("o/r", {
      pageSize: 50,
      since: "2026-11-18T00:00:00Z",
    });
    expect(refresh.issues).toHaveLength(1);
    expect(refresh.hasNextPage).toBe(false);

    const comments = await gh.closedQuestions.listIssueComments("o/r", 1, { pageSize: 50 });
    expect(comments).toEqual({
      comments: [{ id: "C_1", body: "hello" }],
      hasNextPage: false,
      endCursor: null,
    });
    expect(await gh.closedQuestions.listIssueComments("o/r", 999, { pageSize: 50 })).toBeNull();

    const perm = gh.closedQuestions.permissionOf("o/r");
    expect(await perm("alice")).toBe("write");
  });

  it("rejects immediately when AbortSignal is already aborted", async () => {
    const gh = createGhService({
      query: async () => {
        throw new Error("should not run");
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      gh.closedQuestions.listClosedIssues("o/r", { pageSize: 10, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
