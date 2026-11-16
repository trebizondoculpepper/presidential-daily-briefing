/**
 * #343 (doc/design/required-advisory-checks.md): requiredness from GitHub, a shared classifier,
 * bounded collection, and the waiting decision. Injected boundaries only.
 */
import { describe, expect, it } from "vite-plus/test";
import { classifyChecks, hydrateRequiredChecks, requiredCheckEvidence } from "./requiredchecks.js";
import type { RequiredChecks } from "./requiredchecks.js";
import type { PullRequest } from "./types.js";
import { briefing } from "../briefing/briefing.js";
import { page, pr, snapshot, time } from "../testing/snapshots.js";

const ACTIONS = 15368;
const withChecks = (
  checks: { name: string; status?: string; conclusion?: string | null; databaseId?: number }[],
  evidence?: Partial<RequiredChecks> | null,
): PullRequest => {
  const base = pr();
  base.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page(checks);
  if (evidence !== null)
    base.requiredChecks = {
      head: base.headRefOid,
      base: base.baseRefName,
      checks: [],
      expected: [],
      gaps: [],
      ...evidence,
    };
  else delete base.requiredChecks;
  return base;
};
const run = (name: string, required: "required" | "advisory" | "unknown", appId = ACTIONS) => ({
  name,
  databaseId: null,
  appId,
  required,
});

describe("classifying checks (#343)", () => {
  it("separates required, advisory and unknown pending checks", () => {
    const p = withChecks(
      [
        { name: "verify", status: "IN_PROGRESS", conclusion: null },
        { name: "test (freebsd)", status: "IN_PROGRESS", conclusion: null },
        { name: "lint", status: "QUEUED", conclusion: null },
      ],
      {
        checks: [
          run("verify", "required"),
          run("test (freebsd)", "advisory"),
          run("lint", "unknown"),
        ],
      },
    );
    expect(classifyChecks(p)).toEqual({
      requiredPending: ["verify"],
      advisoryPending: ["test (freebsd)"],
      unknownPending: ["lint"],
      missingRequired: [],
    });
  });

  it("evidence for another head or none at all leaves every pending check unknown", () => {
    const pending = [{ name: "test", status: "IN_PROGRESS", conclusion: null }];
    expect(classifyChecks(withChecks(pending, null)).unknownPending).toEqual(["test"]);
    const stale = withChecks(pending, { head: "older", checks: [run("test", "advisory")] });
    expect(classifyChecks(stale)).toMatchObject({ advisoryPending: [], unknownPending: ["test"] });
  });

  it("an expected required check not yet reported, or reported by another app, is missing", () => {
    const green = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
    const p = withChecks(green, {
      checks: [run("test", "advisory"), run("verify", "advisory", 999)],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    expect(classifyChecks(p).missingRequired).toEqual(["verify"]);
  });

  it("a name is advisory only when every pending run with that name is advisory", () => {
    const p = withChecks(
      [
        { name: "test", status: "IN_PROGRESS", conclusion: null, databaseId: 1 },
        { name: "test", status: "IN_PROGRESS", conclusion: null, databaseId: 2 },
      ],
      {
        checks: [
          { name: "test", databaseId: 1, appId: ACTIONS, required: "required" as const },
          { name: "test", databaseId: 2, appId: ACTIONS, required: "advisory" as const },
        ],
      },
    );
    expect(classifyChecks(p)).toMatchObject({ requiredPending: ["test"], advisoryPending: [] });
  });

  it("a required run that appeared after the snapshot is unexamined: missing and waiting", () => {
    const p = withChecks([{ name: "test", status: "IN_PROGRESS", conclusion: null }], {
      checks: [run("test", "advisory"), run("verify", "required")],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    expect(classifyChecks(p)).toMatchObject({
      advisoryPending: ["test"],
      unknownPending: ["verify"],
      missingRequired: ["verify"],
    });
  });

  it("ambiguous duplicates stay unknown", () => {
    const p = withChecks([{ name: "test", status: "IN_PROGRESS", conclusion: null }], {
      checks: [run("test", "required"), run("test", "advisory")],
    });
    expect(classifyChecks(p).unknownPending).toEqual(["test"]);
  });
});

describe("collecting required-check evidence (#343)", () => {
  const pending = (n: number, baseRefName = "main", headRefOid = `h${n}`): PullRequest => {
    const p = withChecks(
      [{ name: "test (freebsd)", status: "IN_PROGRESS", conclusion: null, databaseId: n }],
      null,
    );
    return { ...p, number: n, url: `https://github.com/o/r/pull/${n}`, baseRefName, headRefOid };
  };
  const fake = (
    options: {
      rules?: { status: number | null; body: unknown };
      legacy?: unknown;
      legacyFails?: boolean;
      head?: (n: number) => string;
    } = {},
  ) => {
    const calls = { rest: 0, legacy: 0, pr: [] as number[] };
    const query = async (source: string, vars: Record<string, string | number>) => {
      if (source.includes("branchProtectionRule")) {
        calls.legacy++;
        if (options.legacyFails) throw new Error("FORBIDDEN");
        return { repository: { ref: { branchProtectionRule: options.legacy ?? null } } };
      }
      const n = Number(vars.number);
      calls.pr.push(n);
      return {
        repository: {
          pullRequest: {
            headRefOid: options.head?.(n) ?? `h${n}`,
            baseRefName: "main",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test (freebsd)",
                            databaseId: n,
                            isRequired: false,
                            checkSuite: { app: { databaseId: ACTIONS } },
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
    };
    const rest = async () => {
      calls.rest++;
      return (
        options.rules ?? {
          status: 200,
          body: [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "verify", integration_id: ACTIONS }],
              },
            },
          ],
        }
      );
    };
    return { query, rest, calls };
  };

  it("reads green and unfinished open non-draft PRs, sharing one base-policy read per base", async () => {
    const draft = { ...pending(3), isDraft: true };
    const green = withChecks(
      [{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
      null,
    );
    green.number = 4;
    green.headRefOid = "h4";
    const f = fake();
    const prs = [pending(1), pending(2), draft, green];
    expect(await hydrateRequiredChecks("o/r", prs, f)).toEqual([]);
    expect(f.calls).toEqual({ rest: 1, legacy: 1, pr: [1, 2, 4] });
    expect(prs[0]!.requiredChecks).toMatchObject({
      head: "h1",
      checks: [{ name: "test (freebsd)", required: "advisory", appId: ACTIONS }],
      expected: [{ context: "verify", appId: ACTIONS }],
      gaps: [],
    });
    expect(draft.requiredChecks).toBeUndefined();
    // A distinct base gets its own policy read.
    const other = fake();
    await hydrateRequiredChecks("o/r", [pending(1), pending(2, "release")], other);
    expect(other.calls.rest).toBe(2);
  });

  it("merges legacy protection with rulesets; a null legacy rule is no rule", async () => {
    const f = fake({
      legacy: {
        requiresStatusChecks: true,
        requiredStatusChecks: [{ context: "deploy-gate", app: null }],
      },
    });
    const prs = [pending(1)];
    await hydrateRequiredChecks("o/r", prs, f);
    expect(prs[0]!.requiredChecks!.expected).toEqual([
      { context: "verify", appId: ACTIONS },
      { context: "deploy-gate", appId: null },
    ]);
  });

  it("unreadable sources are named gaps that mark the PR incomplete, never an empty required set", async () => {
    for (const [options, gap] of [
      [{ legacyFails: true }, /legacy protection for main could not be read/],
      [{ rules: { status: 403, body: {} } }, /effective rules for main answered 403/],
      [
        { rules: { status: 200, body: Array.from({ length: 100 }, () => ({ type: "deletion" })) } },
        /more than 100 effective rules/,
      ],
      [{ head: () => "moved" }, /head or base changed/],
    ] as const) {
      const prs = [pending(1)];
      const warnings = await hydrateRequiredChecks("o/r", prs, fake(options));
      expect(warnings).toEqual([
        expect.stringMatching(
          /^https:\/\/github\.com\/o\/r\/pull\/1: required-check evidence incomplete/,
        ),
      ]);
      expect(warnings[0]).toMatch(gap);
      if (!String(gap).includes("head")) expect(prs[0]!.requiredChecks!.expected).toBeNull();
    }
  });
});

describe("waiting on required checks only (#343, TypeScript rules)", () => {
  const findings = (p: PullRequest) =>
    briefing(snapshot([], [p]), { limit: 100 }, new Date(time)).actions.items.filter(
      (a) => a.target === p.url,
    );
  const verifyPassed = { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" };
  const freebsd = { name: "test (freebsd)", status: "IN_PROGRESS", conclusion: null };

  it("an advisory job alone does not make the PR wait", () => {
    const advisory = withChecks([verifyPassed, freebsd], {
      checks: [run("verify", "required"), run("test (freebsd)", "advisory")],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    expect(findings(advisory).some((f) => f.rule === "pr-pending")).toBe(false);
  });

  it("unknown requiredness and a missing required check keep it waiting", () => {
    expect(findings(withChecks([verifyPassed, freebsd], null)).map((f) => f.rule)).toContain(
      "pr-pending",
    );
    const missing = withChecks([{ ...verifyPassed, name: "test" }], {
      checks: [run("test", "advisory")],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    const wait = findings(missing).find((f) => f.rule === "pr-pending");
    expect(wait?.reason).toBe("Required, not yet reported: verify");
  });
});

describe("both engines decide the same way (#343)", () => {
  const verifyPassed = { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" };
  const freebsd = { name: "test (freebsd)", status: "IN_PROGRESS", conclusion: null };
  const present = async (p: PullRequest, engine: "datalog" | "typescript") => {
    const { presentBriefing } = await import("../briefing/service.js");
    const { report } = await presentBriefing(
      snapshot([], [p]),
      {
        limit: 10,
        maxChars: 10000,
        role: "implementer",
        engineSetting: { requested: engine, source: "config" as const },
      },
      undefined,
      new Date(time),
    );
    return report as { actions: { items: string[] } };
  };
  it("an advisory job alone leaves the PR actionable; unknown requiredness keeps it waiting", async () => {
    const advisory = withChecks([verifyPassed, freebsd], {
      checks: [run("verify", "required"), run("test (freebsd)", "advisory")],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    const unknown = withChecks([verifyPassed, freebsd], null);
    // Same name, one run required: still waiting in both engines.
    const sameName = withChecks(
      [verifyPassed, { ...freebsd, databaseId: 1 }, { ...freebsd, databaseId: 2 }],
      {
        checks: [
          run("verify", "required"),
          { name: "test (freebsd)", databaseId: 1, appId: ACTIONS, required: "required" as const },
          { name: "test (freebsd)", databaseId: 2, appId: ACTIONS, required: "advisory" as const },
        ],
        expected: [{ context: "verify", appId: ACTIONS }],
      },
    );
    for (const engine of ["datalog", "typescript"] as const) {
      expect((await present(advisory, engine)).actions.items, engine).toContain(advisory.url);
      expect((await present(unknown, engine)).actions.items, engine).not.toContain(unknown.url);
      expect((await present(sameName, engine)).actions.items, engine).not.toContain(sameName.url);
    }
  });
});

describe("delivery follow-up and metering use the same model (#343)", () => {
  it("delivery follow-up waits only for required, unknown or missing checks", async () => {
    const { snapshotFollowUpFacts } = await import("../workflow/deliveryread.js");
    const freebsd = { name: "test (freebsd)", status: "IN_PROGRESS", conclusion: null };
    const verifyPassed = { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" };
    const advisory = withChecks([verifyPassed, freebsd], {
      checks: [run("verify", "required"), run("test (freebsd)", "advisory")],
      expected: [{ context: "verify", appId: ACTIONS }],
    });
    expect(snapshotFollowUpFacts(advisory, []).pending).toBe(false);
    expect(snapshotFollowUpFacts(withChecks([verifyPassed, freebsd], null), []).pending).toBe(true);
  });

  it("the rules read goes through the collector's meter, and a quota refusal is a named gap", async () => {
    const { collect } = await import("./github.js");
    const open = withChecks([{ name: "test", status: "IN_PROGRESS", conclusion: null }], null);
    delete open.requiredChecks;
    const query = async (source: string) => {
      if (source.includes("isRequired") || source.includes("branchProtectionRule"))
        return { repository: { ref: { branchProtectionRule: null }, pullRequest: null } };
      return {
        repository: {
          issues: page([]),
          pullRequests: page(source.includes("pullRequests(first") ? [open] : []),
        },
      };
    };
    const rest = async () => ({ status: 429, body: { message: "rate limited" } });
    const data = await collect("o/r", { rest }, query as never, () => new Date(time));
    const calls = data.collection!.telemetry.calls.filter((c) => c.source === "required-checks");
    expect(calls).toEqual([
      expect.objectContaining({ route: "rest", outcome: "rate-limited", status: 429 }),
    ]);
    expect(data.warnings.join(" ")).toMatch(/required-check evidence incomplete .*answered 429/);
  });
});

describe("target-bound required-check facts (#676)", () => {
  it("distinguishes a known empty set from unread requirements even without verify", () => {
    const known = withChecks([{ name: "CI gate", conclusion: "SUCCESS" }], {
      checks: [run("CI gate", "advisory")],
      expected: [],
    });
    expect(requiredCheckEvidence(known)).toMatchObject({ complete: true, missing: [] });
    known.requiredChecks!.expected = null;
    expect(requiredCheckEvidence(known)).toMatchObject({ complete: false });
  });
  it("binds app-qualified duplicate names to their actual run identities", () => {
    const p = withChecks(
      [
        { name: "build", databaseId: 1, conclusion: "SUCCESS" },
        { name: "build", databaseId: 2, status: "IN_PROGRESS", conclusion: null },
      ],
      {
        expected: [{ context: "build", appId: 2 }],
        checks: [
          { name: "build", databaseId: 1, appId: 1, required: "advisory" },
          { name: "build", databaseId: 2, appId: 2, required: "required" },
        ],
      },
    );
    expect(requiredCheckEvidence(p)).toMatchObject({
      complete: true,
      missing: [],
      checks: [
        { required: "advisory", outcome: "SUCCESS" },
        { required: "required", outcome: "IN_PROGRESS" },
      ],
    });
    p.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.pop();
    expect(requiredCheckEvidence(p)).toMatchObject({ complete: false, missing: ["build"] });
  });
  it("does not borrow a duplicate's identity, stale base, or conflicting source answer", () => {
    const p = withChecks(
      [
        { name: "build", conclusion: "SUCCESS" },
        { name: "build", conclusion: "SUCCESS" },
      ],
      {
        checks: [run("build", "required")],
        expected: [{ context: "build", appId: null }],
      },
    );
    expect(requiredCheckEvidence(p).complete).toBe(false);
    p.requiredChecks!.base = "another-base";
    expect(requiredCheckEvidence(p).complete).toBe(false);
    const conflict = withChecks([{ name: "build", conclusion: "SUCCESS" }], {
      checks: [run("build", "advisory")],
      expected: [{ context: "build", appId: null }],
    });
    expect(requiredCheckEvidence(conflict).gaps).toContain("conflicting requiredness for build");
    conflict.requiredChecks!.expected = [];
    conflict.requiredChecks!.checks[0]!.required = "required";
    expect(requiredCheckEvidence(conflict).complete).toBe(false);
  });
  it("preserves complete no-check heads separately from absent observed coverage", () => {
    const p = withChecks([], { checks: [], expected: [] });
    p.commits.nodes[0]!.commit.statusCheckRollup = null;
    expect(requiredCheckEvidence(p)).toMatchObject({ complete: true, checks: [], missing: [] });
    p.commits.nodes = [];
    expect(requiredCheckEvidence(p).complete).toBe(false);
  });
});
