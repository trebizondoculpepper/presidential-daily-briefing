import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GitHub answers only.
describe("typed required-check reads (#926)", () => {
  it("reads branch rules and legacy protection through the service's executors", async () => {
    const paths: string[] = [];
    const svc = createGhService({
      env: {},
      rest: async (path) => {
        paths.push(path);
        return {
          status: 200,
          body: [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "verify", integration_id: 15368 }],
              },
            },
          ],
        };
      },
      query: async () => ({ repository: { ref: { branchProtectionRule: null } } }),
    });
    const policy = await svc.checks.branchRequiredChecks("o/r", "main");
    expect(policy).toEqual({ expected: [{ context: "verify", appId: 15368 }], gaps: [] });
    expect(paths).toEqual(["repos/o/r/rules/branches/main?per_page=100"]);
  });

  it("reports gaps, never an empty requirement, when a source cannot be read", async () => {
    const svc = createGhService({
      env: {},
      rest: async () => ({ status: 403, body: {} }),
      query: async () => {
        throw new Error("boom");
      },
    });
    const policy = await svc.checks.branchRequiredChecks("o/r", "main");
    expect(policy.expected).toBeNull();
    expect(policy.gaps.join(" ")).toMatch(/answered 403/);
    expect(policy.gaps.join(" ")).toMatch(/legacy protection for main could not be read/);
  });

  it("marks a missing requiredness answer unknown, never advisory", async () => {
    const svc = createGhService({
      env: {},
      query: async () => ({
        repository: {
          pullRequest: {
            headRefOid: "abc",
            baseRefName: "main",
            commits: {
              nodes: [
                {
                  commit: {
                    oid: "abc",
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "verify",
                            databaseId: 1,
                            isRequired: null,
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
      }),
    });
    const read = await svc.checks.headRequiredness("o/r", {
      number: 5,
      headRefOid: "abc",
      baseRefName: "main",
    });
    expect(read).toMatchObject({
      head: "abc",
      gaps: [],
      checks: [{ name: "verify", required: "unknown" }],
    });
  });
});
