import { describe, expect, it } from "vite-plus/test";
import { resolveReference } from "./references.js";
import type { Query } from "../github.js";

// Synthetic GraphQL answers only.
const q = (node: unknown) =>
  (async () => ({ repository: { issueOrPullRequest: node } })) as unknown as Query;
const pr = (refs: unknown) => ({
  __typename: "PullRequest",
  number: 9,
  url: "u",
  state: "MERGED",
  merged: true,
  closingIssuesReferences: refs,
});
const ref = { number: 1, url: "u1", state: "CLOSED", repository: { nameWithOwner: "o/r" } };

describe("typed reference resolution (#922)", () => {
  it("resolves an issue and a pull request with its closing references", async () => {
    expect(
      await resolveReference(
        q({ __typename: "Issue", number: 1, url: "u1", state: "OPEN", stateReason: null }),
        "o/r",
        1,
      ),
    ).toEqual({ __typename: "Issue", number: 1, url: "u1", state: "OPEN", stateReason: null });
    expect(
      await resolveReference(q(pr({ nodes: [ref], pageInfo: { hasNextPage: false } })), "o/r", 9),
    ).toMatchObject({
      __typename: "PullRequest",
      merged: true,
      closingIssuesReferences: { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } },
    });
    expect(await resolveReference(q(pr(null)), "o/r", 9)).toMatchObject({
      closingIssuesReferences: null,
    });
  });

  it("is null only for an absent ticket", async () => {
    expect(await resolveReference(q(null), "o/r", 9)).toBeNull();
  });

  it("rejects malformed answers instead of filtering them into a complete-looking result", async () => {
    for (const node of [
      { __typename: "Issue", number: "9" },
      { __typename: "PullRequest", number: 9, url: "u", state: "OPEN" },
      pr({ nodes: [ref, { number: "bad" }], pageInfo: { hasNextPage: false } }),
      pr({ nodes: [ref] }),
    ])
      await expect(resolveReference(q(node), "o/r", 9)).rejects.toThrow(/malformed answer/);
  });
});
