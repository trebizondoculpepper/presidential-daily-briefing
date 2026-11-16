/** #676: one target-bound native check policy across direct reports and briefings. */
import { describe, expect, it } from "vite-plus/test";
import { pullRequestStatus, prStatus } from "./prstatus.js";
import { requiredCheckEvidence } from "../github/requiredchecks.js";
import { evaluateCheckPolicy } from "../rules/datalog/engine.js";
import { evaluateDatalog } from "../rules/datalog/datalog.js";
import { briefing } from "../briefing/briefing.js";
import { page, pr, repo, snapshot } from "../testing/snapshots.js";

function target(required: boolean) {
  const p = pr();
  p.closingIssuesReferences = page([]);
  p.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page([
    { name: "CI gate", databaseId: 7, conclusion: "SUCCESS" },
  ]);
  p.requiredChecks = {
    head: p.headRefOid,
    base: p.baseRefName,
    expected: required ? [{ context: "CI gate", appId: 5 }] : [],
    gaps: [],
    checks: [
      { name: "CI gate", databaseId: 7, appId: 5, required: required ? "required" : "advisory" },
    ],
  };
  return p;
}
describe("target required-check parity (#676)", () => {
  it.each([false, true])("does not invent verify with required=%s", (required) => {
    const p = target(required);
    const native = evaluateCheckPolicy(requiredCheckEvidence(p));
    const report = prStatus(repo, p as never);
    expect(report.checks.policy).toEqual(native);
    expect(report.blockers).toEqual([]);
    expect(report.completeness.complete).toBe(true);
    expect(
      briefing(snapshot([], [p]), { limit: 100 }).actions.items.some(
        (f) => f.rule === "pr-inspect-merge",
      ),
    ).toBe(true);
    expect(
      evaluateDatalog(snapshot([], [p]), new Map(), { role: "implementer", limit: 10 }).items.some(
        (a) => a.ruleIds.includes("D-PR-MERGE"),
      ),
    ).toBe(true);
  });
  it("projects a never-reported requirement in standalone native evaluation", () => {
    const p = target(true);
    p.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page([]);
    p.requiredChecks!.checks = [];
    const report = prStatus(repo, p as never);
    expect(report.checks.requirements?.complete).toBe(true);
    expect(report.blockers).toContain("Required check not yet reported: CI gate");
    // No host checkRequiredness map: this is the trial/standalone adapter path.
    expect(
      evaluateDatalog(snapshot([], [p]), new Map(), { role: "implementer", limit: 10 }).items.some(
        (a) => a.ruleIds.includes("D-PR-MERGE"),
      ),
    ).toBe(false);
  });
  it("keeps unread requirements unknown even with green checks and CLEAN mergeability", () => {
    const p = target(false);
    p.requiredChecks!.expected = null;
    p.requiredChecks!.gaps = ["effective rules unavailable"];
    const report = prStatus(repo, p as never);
    expect(report.checks.policy?.ready).toBe(false);
    expect(report.blockers.join(" ")).toContain("effective rules unavailable");
    expect(report.blockers.join(" ")).not.toContain("verify");
    expect(
      briefing(snapshot([], [p]), { limit: 100 }).actions.items.some(
        (f) => f.rule === "pr-inspect-merge",
      ),
    ).toBe(false);
    expect(
      evaluateDatalog(snapshot([], [p]), new Map(), { role: "implementer", limit: 10 }).items.some(
        (a) => a.ruleIds.includes("D-PR-MERGE"),
      ),
    ).toBe(false);
  });
  it("direct reads collect one shared target policy and bound run evidence through injected boundaries", async () => {
    const p = target(true);
    delete p.requiredChecks;
    const calls: string[] = [];
    const query = async (source: string) => {
      if (source.includes("branchProtectionRule")) {
        calls.push("legacy");
        return { repository: { ref: { branchProtectionRule: null } } };
      }
      if (source.includes("databaseId isRequired")) {
        calls.push("requiredness");
        return {
          repository: {
            pullRequest: {
              headRefOid: p.headRefOid,
              baseRefName: p.baseRefName,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              name: "CI gate",
                              databaseId: 7,
                              isRequired: true,
                              checkSuite: { app: { databaseId: 5 } },
                            },
                          ],
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }
      calls.push("selected");
      return { repository: { pullRequest: p } };
    };
    const rest = async (path: string) => {
      calls.push(path);
      return {
        status: 200,
        body: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "CI gate", integration_id: 5 }] },
          },
        ],
      };
    };
    const report = await pullRequestStatus(
      repo,
      p.number,
      query as never,
      undefined,
      undefined,
      undefined,
      rest as never,
    );
    expect(report.checks.policy?.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls).toContain(`repos/${repo}/rules/branches/main?per_page=100`);
  });
});
