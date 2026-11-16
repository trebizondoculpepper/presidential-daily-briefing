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
