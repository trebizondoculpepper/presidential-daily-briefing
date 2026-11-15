/**
 * Embedding-boundary examples for the Datalog rules (#339,
 * doc/reports/embedded-rule-testing-boundaries.md). These run the real adapter and DataScript
 * evaluator on frozen synthetic snapshots; no GitHub, network or model. They test the host side
 * of the boundary, which the native EDN scenarios (scenarios/*.edn) deliberately skip:
 * facts the host supplies, multi-valued relations, type conversion, missing versus false,
 * engine failure without fallback, and explanations that agree with the decision they explain.
 *
 * `it.fails` marks a confirmed defect: the body states the correct behaviour and fails today.
 * When the linked follow-up fixes it, Vitest reports the test as unexpectedly passing; then
 * change `it.fails` to `it`.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { ConfigFileSystem, GitRunner } from "../../config/config.js";
import type { Datom } from "datascript";
import type { MetricView, SubjectAssessments } from "../../briefing/assessments.js";
import type { Issue, Page, PullRequest, Snapshot } from "../../github/types.js";

// Capture exactly what the adapter hands the engine, without changing production code.
const handed: Datom[][] = [];
vi.mock("./engine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./engine.js")>();
  return {
    ...real,
    evaluatePolicy: (...args: Parameters<typeof real.evaluatePolicy>) => {
      handed.push(args[0].datoms);
      return real.evaluatePolicy(...args);
    },
  };
});
const { evaluateDatalog } = await import("./datalog.js");
const { evaluatePolicy, firstSubjectId, DatalogError } = await import("./engine.js");
const { presentBriefing } = await import("../../briefing/service.js");
const { BriefingEngineError } = await import("../../config/engine-setting.js");
const bundle = (await import("./policy.generated.json", { with: { type: "json" } })).default;

const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (number: number, labels = ["status:ready"], createdAt = "2026-01-01T00:00:00Z") =>
  ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: `https://github.com/o/r/issues/${number}`,
    state: "OPEN",
    createdAt,
    updatedAt: createdAt,
    labels: page(labels.map((name) => ({ name }))),
    comments: page(),
    blockedBy: page(),
    blocking: page(),
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    closedByPullRequestsReferences: page(),
  }) as Issue;
const pr = (n: number): PullRequest => ({
  ...issue(n, []),
  url: `https://github.com/o/r/pull/${n}`,
  headRefOid: `head${n}`,
  headRefName: "branch",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page(),
  reviewThreads: page(
    [true, false].map((isResolved) => ({ isResolved, isOutdated: false, comments: page() })),
  ),
  reviews: page([
    { body: "", url: `r${n}`, author: null, state: "APPROVED", commit: { oid: `head${n}` } },
  ]),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page([
              { name: "verify", conclusion: "SUCCESS" },
              { name: "lint", conclusion: "SUCCESS" },
            ]),
          },
        },
      },
    ],
  },
});
const snap = (issues: Issue[], pullRequests: PullRequest[] = [], warnings: string[] = []) =>
  ({
    schemaVersion: 1,
    repository: "o/r",
    startedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    issues,
    pullRequests,
    dependencies: [],
    changed: [],
    since: null,
    warnings,
    rateLimit: null,
  }) as Snapshot;
const metric = (size: MetricView["size"]): MetricView => ({
  size,
  state: size ? "current" : "unassessed",
  provenance: null,
});
const ready: SubjectAssessments = {
  impact: metric("M"),
  complexity: metric("M"),
  unlocks: 0,
  unlocksUnknown: [],
};
const assessed = (subjects: { url: string }[]) => new Map(subjects.map((s) => [s.url, ready]));
const run = (s: Snapshot, agent?: string, order?: "oldest") =>
  evaluateDatalog(s, assessed([...s.issues, ...s.pullRequests]), {
    role: "implementer",
    limit: 100,
    ...(agent !== undefined ? { agent } : {}),
    ...(order ? { order } : {}),
  });
const numbers = (r: ReturnType<typeof run>) =>
  r.items.map((x) => Number(x.target.split("/").pop()));

describe("host facts reaching the engine (#339)", () => {
  it("declares every attribute the adapter can repeat on one entity as cardinality-many", () => {
    // A ticket with two owners, two platforms, attention, a blocker, a dependent and a closing PR,
    // plus a PR with two checks, a review and two threads: every repeatable relation at once.
    const blocker = issue(2);
    const dependent = issue(3);
    const busy = {
      ...issue(1, [
        "status:ready",
        "agent:a",
        "agent:b",
        "platform:x",
        "platform:y",
        "attention:a",
        "attention:b",
      ]),
      blockedBy: page([{ number: 2, url: blocker.url, state: "OPEN", title: "" }]),
      blocking: page([{ number: 3, url: dependent.url, state: "OPEN", title: "" }]),
      closedByPullRequestsReferences: page([{ number: 9, url: pr(9).url, state: "OPEN" }]),
    } as Issue;
    handed.length = 0;
    run(snap([busy, blocker, dependent], [pr(9)]), "a");
    const repeated = new Set<string>();
    const seen = new Set<string>();
    for (const [e, a] of handed[0]) {
      const key = `${e} ${a}`;
      if (seen.has(key)) repeated.add(a as string);
      seen.add(key);
    }
    expect([...repeated].sort()).toEqual(
      ["attention", "check", "label", "owner", "platform", "thread"].sort(),
    );
    // A cardinality-one attribute keeps only its last value: a lost owner or check would change
    // decisions silently, so the schema must list each of these.
    for (const attribute of repeated) expect(bundle.schema).toHaveProperty(attribute);
  });

  it("keeps missing assessment evidence unknown, never unassessed or false", () => {
    const one = issue(1);
    handed.length = 0;
    evaluateDatalog(snap([one]), new Map(), { role: "implementer", limit: 10 });
    const facts = Object.fromEntries(
      handed[0].filter(([e]) => e === firstSubjectId).map(([, a, v]) => [a, v]),
    );
    expect(facts).toMatchObject({
      "impact-state": "unknown",
      "complexity-state": "unknown",
      "labels-complete": true,
    });
  });

  it("marks a PR incomplete only for warnings about that PR", () => {
    const facts = (warnings: string[]) => {
      handed.length = 0;
      run(snap([], [pr(1)], warnings));
      return handed[0].find(([e, a]) => e === firstSubjectId && a === "pr-complete")?.[2];
    };
    expect(facts([])).toBe(true);
    expect(facts(["https://github.com/o/r/pull/1: reviews exceed 100; incomplete."])).toBe(false);
  });

  it.fails("does not let a warning about PR 12 mark PR 1 incomplete (URL prefix match)", () => {
    handed.length = 0;
    run(snap([], [pr(1)], ["https://github.com/o/r/pull/12: reviews exceed 100; incomplete."]));
    expect(handed[0].find(([e, a]) => e === firstSubjectId && a === "pr-complete")?.[2]).toBe(true);
  });

  it("never treats a bare agent: label as the viewer's claim when no agent is given (#449)", () => {
    const r = run(
      snap([issue(1, ["status:ready", "agent:"]), issue(2, ["status:ready", "attention:"])]),
    );
    expect(r.items.map((x) => x.kind)).not.toContain("continue-implementation");
    expect(r.items.map((x) => x.kind)).not.toContain("addressed-response");
    // The empty claim still belongs to someone: the ticket is denied, not offered as ordinary work.
    expect(r.decisionEngine.denials).toContainEqual({
      target: issue(1).url,
      ruleId: "D-DENY-CLAIM",
    });
  });

  it.fails("one unparseable createdAt does not reorder the valid tickets", () => {
    const bad = issue(1, ["status:ready"], "not a date");
    // Two valid tickets created at the same time: normally ordered by number.
    const [two, three] = [issue(2), issue(3)];
    const valid = (r: ReturnType<typeof run>) => numbers(r).filter((n) => n !== 1);
    expect(valid(run(snap([bad, two, three]), "me", "oldest"))).toEqual(
      valid(run(snap([two, bad, three]), "me", "oldest")),
    );
  });
});

describe("engine failure and explanation consistency (#339)", () => {
  it("explains each decision with its own rule and the facts the host supplied", () => {
    const mixed = snap(
      [
        issue(1),
        issue(2, ["status:ready", "question"]),
        issue(3, ["status:parked", "attention:me"]),
      ],
      [pr(9)],
    );
    const r = run(mixed, "me");
    expect(r.items.length).toBeGreaterThan(1);
    for (const item of r.items) {
      expect(item.ruleIds).toEqual(item.why.ruleIds);
      expect(item.why.text).not.toMatch(/[{}]/);
      expect(item.reasonCodes.length).toBeGreaterThan(0);
      // Witness bindings are read back from the same database the decision came from.
      if ("impact" in item.why.facts) expect(item.why.facts.impact).toBe(ready.impact.size);
      expect(item.why.overriddenRuleIds).not.toContain(item.ruleIds[0]);
    }
  });

  it("raises a missing explanation binding as an engine error, never a partial text", () => {
    const policy = structuredClone(bundle) as typeof bundle;
    policy.definitions = policy.definitions.map((d) => ({ ...d, why: `${d.why} {nonexistent}` }));
    const t = firstSubjectId;
    expect(() =>
      evaluatePolicy(
        {
          viewer: { role: "implementer", agent: "me", platform: "", order: "impact" },
          datoms: [
            [1, "forward-complete", true],
            [t, "kind", "issue"],
            [t, "state", "OPEN"],
            [t, "number", 7],
            [t, "target", "issue-7"],
            [t, "created", 1],
            [t, "label", "status:ready"],
            [t, "labels-complete", true],
            [t, "native-complete", true],
            [t, "reverse-complete", true],
            [t, "blocking-complete", true],
            [t, "open-blockers", 0],
            [t, "impact-state", "current"],
            [t, "impact-size", "L"],
            [t, "complexity-state", "current"],
            [t, "complexity-size", "S"],
          ],
        },
        { policy: policy as never },
      ),
    ).toThrow(DatalogError);
  });

  it("surfaces an engine failure as decision-engine-failed with no TypeScript fallback", async () => {
    const root = "/repo";
    const fs: ConfigFileSystem = {
      readText: async () => null,
      writeText: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/o/r.git (fetch)\n";
    const failing = presentBriefing(
      snap([issue(1)]),
      {
        limit: 10,
        maxChars: 20000,
        agent: "me",
        engineSetting: { requested: "datalog", source: "config" },
      },
      { fs, git, cwd: root },
      new Date("2026-01-02T00:00:00Z"),
      undefined,
      undefined,
      undefined,
      async () => ({
        evaluateDatalog: () => {
          throw new Error("engine exploded");
        },
      }),
    );
    await expect(failing).rejects.toBeInstanceOf(BriefingEngineError);
    await expect(failing).rejects.toMatchObject({ code: "decision-engine-failed" });
    await expect(failing).rejects.toThrow(/engine exploded/);
  });
});
