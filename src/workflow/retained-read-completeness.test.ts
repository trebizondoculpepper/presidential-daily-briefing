import { expect, it } from "vite-plus/test";
import { snapshot, issue, time } from "../testing/snapshots.js";
import { readTeam, readWho } from "./readservices.js";

it("failed live activity reads make team/who incomplete even when delivery evidence is complete", async () => {
  const data = snapshot([issue(1, ["status:in-progress", "agent:reader"])], []);
  const options = { staleHours: 48, now: new Date(time), offline: false };
  const teamBaseline = await readTeam(data, options, {});
  const whoBaseline = await readWho(data, 1, options, {});
  expect(teamBaseline.complete).toBe(true);
  expect(whoBaseline.complete).toBe(true);
  const live = {
    query: async () => {
      throw new Error("activity request timed out");
    },
    rest: async () => {
      throw new Error("unexpected REST request");
    },
  };
  const team = await readTeam(data, options, { live });
  const who = await readWho(data, 1, options, { live });
  for (const result of [team, who]) {
    expect(result.complete).toBe(false);
    expect(result.report.completeness.complete).toBe(false);
    expect(result.report.completeness.warnings.join(" ")).toContain(
      "Claim activity for reader on #1 could not be verified",
    );
    expect(result.text).toContain("activity request timed out");
  }
});

it("who directly verifies a closed ticket's recorded owner without inventing unknown activity", async () => {
  const closed = { ...issue(2, ["agent:reader"]), state: "CLOSED" };
  let requests = 0;
  const result = await readWho(
    snapshot([closed], []),
    2,
    { staleHours: 48, now: new Date(time), offline: false },
    {
      live: {
        query: async () => {
          requests++;
          return {
            repository: {
              issueOrPullRequest: { ...closed, __typename: "Issue" },
              claims: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          };
        },
        rest: async () => {
          throw new Error("unexpected REST request");
        },
      },
    },
  );
  expect(requests).toBe(1);
  expect(result.complete).toBe(true);
  expect(result.report.claimActivity).toEqual([
    { agent: "reader", state: "not-owned", reason: "reader has no open claim on #2" },
  ]);
});
