import { describe, expect, it } from "vite-plus/test";
import { deliverableIssue, olderCommentsPage, pullByUrl } from "./delivery.js";
import type { Query } from "../github.js";

// Synthetic GraphQL answers only.
const q = (data: unknown) => (async () => data) as unknown as Query;
const comment = {
  databaseId: 1,
  url: "c",
  body: "b",
  createdAt: "t",
  author: { login: "a" },
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
};
const issue = {
  __typename: "Issue",
  number: 4,
  title: "t",
  url: "u",
  state: "OPEN",
  labels: { nodes: [{ name: "x" }], pageInfo: { hasNextPage: false } },
  closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  comments: { nodes: [comment], pageInfo: { hasPreviousPage: false, startCursor: null } },
};
const pr = {
  __typename: "PullRequest",
  id: "PR_1",
  number: 9,
  url: "p",
  state: "OPEN",
  merged: false,
  mergeCommit: null,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  baseRepository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
};

describe("typed deliverables reads (#943 part 2)", () => {
  it("reads the viewer and issue, a pull request in its place, or nothing", async () => {
    const read = await deliverableIssue(
      q({ viewer: { login: "me" }, repository: { issueOrPullRequest: issue } }),
      "o/r",
      4,
    );
    expect(read.viewer?.login).toBe("me");
    expect(read.item).toMatchObject({ __typename: "Issue", comments: { nodes: [{ body: "b" }] } });
    expect(
      (
        await deliverableIssue(
          q({
            viewer: null,
            repository: { issueOrPullRequest: { __typename: "PullRequest", url: "p" } },
          }),
          "o/r",
          4,
        )
      ).item,
    ).toEqual({ __typename: "PullRequest", url: "p" });
    expect(
      (
        await deliverableIssue(
          q({ viewer: null, repository: { issueOrPullRequest: null } }),
          "o/r",
          4,
        )
      ).item,
    ).toBeNull();
  });

  it("rejects a malformed issue or comment instead of planning from it", async () => {
    for (const item of [
      { ...issue, number: "4" },
      {
        ...issue,
        comments: { nodes: [{ ...comment, url: undefined }], pageInfo: { hasPreviousPage: false } },
      },
      { ...issue, labels: { nodes: [{ name: 1 }] } },
    ])
      await expect(
        deliverableIssue(q({ viewer: null, repository: { issueOrPullRequest: item } }), "o/r", 4),
      ).rejects.toThrow(/malformed/);
  });

  it("validates older comment pages and pull requests by URL", async () => {
    const page = (comments: unknown) => q({ repository: { issue: { comments } } });
    expect(
      await olderCommentsPage(
        page({ nodes: [comment], pageInfo: { hasPreviousPage: true, startCursor: "c0" } }),
        "o/r",
        4,
        "c1",
      ),
    ).toMatchObject({ pageInfo: { hasPreviousPage: true, startCursor: "c0" } });
    expect(await olderCommentsPage(q({ repository: { issue: null } }), "o/r", 4, "c1")).toBeNull();
    await expect(olderCommentsPage(page({ nodes: [{}] }), "o/r", 4, "c1")).rejects.toThrow(
      /malformed/,
    );
    expect(await pullByUrl(q({ resource: pr }), "p")).toMatchObject({ number: 9 });
    expect(await pullByUrl(q({ resource: { ...pr, headRefOid: 1 } }), "p")).toBeNull();
    expect(await pullByUrl(q({ resource: { __typename: "Issue" } }), "p")).toBeNull();
  });
});
