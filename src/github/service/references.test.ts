import { describe, expect, it } from "vite-plus/test";
import { resolveReference } from "./references.js";
import type { Query } from "../github.js";

// Synthetic GraphQL answers only.
const q = (node: unknown) =>
  (async () => ({ repository: { issueOrPullRequest: node } })) as unknown as Query;

describe("typed reference resolution (#922)", () => {
  it("resolves an issue and a pull request with validated closing references", async () => {
    expect(
      await resolveReference(
        q({ __typename: "Issue", number: 1, url: "u1", state: "OPEN", stateReason: null }),
        "o/r",
        1,
      ),
    ).toEqual({ __typename: "Issue", number: 1, url: "u1", state: "OPEN", stateReason: null });
    const pr = await resolveReference(
      q({
        __typename: "PullRequest",
        number: 2,
        url: "u2",
        state: "MERGED",
        merged: true,
        closingIssuesReferences: {
          nodes: [
            { number: 1, url: "u1", state: "CLOSED", repository: { nameWithOwner: "o/r" } },
            { number: "bad" },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
      "o/r",
      2,
    );
    expect(pr).toMatchObject({
      __typename: "PullRequest",
      merged: true,
      closingIssuesReferences: { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } },
    });
  });

  it("is null for an absent or malformed answer, never a guessed ticket", async () => {
    expect(await resolveReference(q(null), "o/r", 9)).toBeNull();
    expect(await resolveReference(q({ __typename: "Issue", number: "9" }), "o/r", 9)).toBeNull();
    expect(
      await resolveReference(
        q({ __typename: "PullRequest", number: 9, url: "u", state: "OPEN" }),
        "o/r",
        9,
      ),
    ).toBeNull();
  });
});
