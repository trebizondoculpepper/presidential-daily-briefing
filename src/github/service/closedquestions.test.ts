import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import type { Rest } from "../github.js";
import type { GraphQuery } from "../../workflow/claims.js";
import { discoverClosedQuestions } from "../../briefing/closedquestions.js";
import { questionMarker } from "../../workflow/claims.js";

const sampleIssue = (number: number) => ({
  url: `https://github.com/o/r/issues/${number}`,
  number,
  state: "CLOSED",
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
});

const sampleComment = (id: string, body = "hello") => ({
  id,
  body,
  createdAt: "2026-11-18T00:00:00Z",
  url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
});

describe("typed GH service: closedQuestions (#899)", () => {
  it("lists closed issue pages, comment pages, unavailable issues, and permission lookups", async () => {
    const query: GraphQuery = async (gql, vars) => {
      if (gql.includes("filterBy:{since:")) {
        return {
          repository: {
            issues: {
              nodes: [sampleIssue(2)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      if (gql.includes("states:CLOSED")) {
        return {
          repository: {
            issues: {
              nodes: [sampleIssue(1)],
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
                nodes: [sampleComment("1")],
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
      issues: [sampleIssue(1)],
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
      comments: [sampleComment("1")],
      hasNextPage: false,
      endCursor: null,
    });
    expect(await gh.closedQuestions.listIssueComments("o/r", 999, { pageSize: 50 })).toBeNull();

    const perm = gh.closedQuestions.permissionOf("o/r");
    expect(await perm("alice")).toBe("write");
  });

  it("rejects malformed issue/comment nodes and honours AbortSignal", async () => {
    const gh = createGhService({
      query: async (gql) => {
        if (gql.includes("states:CLOSED")) {
          return {
            repository: {
              issues: {
                // Missing required `comments` object
                nodes: [{ url: "https://github.com/o/r/issues/1", number: 1, state: "CLOSED" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        return {
          repository: {
            issueOrPullRequest: {
              comments: {
                nodes: [{ id: "bad" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      },
    });
    await expect(gh.closedQuestions.listClosedIssues("o/r", { pageSize: 10 })).rejects.toThrow(
      /valid page|malformed/,
    );
    await expect(gh.closedQuestions.listIssueComments("o/r", 1, { pageSize: 10 })).rejects.toThrow(
      /malformed/,
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      gh.closedQuestions.listClosedIssues("o/r", { pageSize: 10, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("keeps budget-refused logins blocked on subsequent permission lookups", async () => {
    let permissionCalls = 0;
    const marker = questionMarker("0000000000000001", "o/r", 1);
    const body = `### Questions for the designer\n\nDesigner: \`owner\` · Raised by: \`alice\`\n\n**Why:** Undecided.\n\n1. Q?\n\n${marker}`;
    const gh = createGhService({
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                url: "https://github.com/o/r/issues/1",
                number: 1,
                state: "CLOSED",
                author: { __typename: "User", login: "alice" },
                comments: {
                  nodes: [
                    {
                      ...sampleComment("1", body),
                      author: { __typename: "User", login: "alice" },
                      databaseId: 1,
                    },
                    {
                      ...sampleComment("2", body.replace("0000000000000001", "0000000000000002")),
                      author: { __typename: "User", login: "alice" },
                      databaseId: 2,
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      rest: async () => {
        permissionCalls++;
        return { status: 200, body: { permission: "write" } };
      },
    });

    const result = await discoverClosedQuestions("o/r", {
      closedQuestions: gh.closedQuestions,
      bounds: { requests: 1 },
    });
    expect(permissionCalls).toBe(0);
    expect(result.coverage.permissionGaps).toBe(2);
    expect(result.coverage.requests).toBe(1);
  });
});
