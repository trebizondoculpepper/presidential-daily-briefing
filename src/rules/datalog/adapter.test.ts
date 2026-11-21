/**
 * Host adapter tests (doc/design/rules-component.md): Snapshot facts reach the engine faithfully
 * (missing stays unknown, supplied scores are ignored), and decisions are rendered with the right
 * commands, limits and diagnostics. Policy decisions themselves are tested by the native EDN
 * scenarios in scenarios/*.edn (rules.test.ts) and end to end by parity.test.ts.
 */
import { describe, it, expect } from "vite-plus/test";
import { evaluateDatalog } from "./datalog.js";
import type { Snapshot, Issue, Page, PullRequest } from "../../github/types.js";
import type { SubjectAssessments, MetricView } from "../../briefing/assessments.js";
const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (number: number, labels = ["status:ready"]): Issue => ({
  number,
  title: `Ticket ${number}`,
  body: "",
  url: `https://github.com/o/r/issues/${number}`,
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: page(labels.map((name) => ({ name }))),
  comments: page(),
  blockedBy: page(),
  blocking: page(),
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  closedByPullRequestsReferences: page(),
});
const snap = (issues: Issue[], pullRequests: PullRequest[] = []): Snapshot => ({
  schemaVersion: 1,
  repository: "o/r",
  startedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  issues,
  pullRequests,
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
});
const metric = (
  size: MetricView["size"] = null,
  state: MetricView["state"] = size ? "current" : "unassessed",
): MetricView => ({ size, state, provenance: null });
const pair = (impact = metric(), complexity = metric()): SubjectAssessments => ({
  impact,
  complexity,
  unlocks: 999,
  unlocksUnknown: [],
});
const pr = (n: number, checks: string[] = ["SUCCESS"]): PullRequest => ({
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
  reviewThreads: page(),
  reviews: page(),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page(
              checks.map((conclusion, i) => ({
                name: i === 0 ? "verify" : `test${i}`,
                conclusion,
              })),
            ),
          },
        },
      },
    ],
  },
});
const run = (
  issues: Issue[],
  as: Map<string, SubjectAssessments> = new Map(),
  opts: Partial<Parameters<typeof evaluateDatalog>[2]> = {},
  prs: PullRequest[] = [],
) => evaluateDatalog(snap(issues, prs), as, { role: "implementer", limit: 100, ...opts });
const implementations = (r: ReturnType<typeof run>) =>
  r.items.filter((x) => x.kind === "implement");
describe("Datalog host adapter", () => {
  it("unknown native, label and closing coverage cannot permit implementation", () => {
    const a = issue(1);
    delete a.blockedBy;
    expect(implementations(run([a]))).toHaveLength(0);
    const b = issue(2);
    b.labels.pageInfo.hasNextPage = true;
    expect(implementations(run([b]))).toHaveLength(0);
    const c = issue(3);
    delete c.closedByPullRequestsReferences;
    const p = pr(4);
    p.closingIssuesReferences.pageInfo.hasNextPage = true;
    expect(implementations(run([c], new Map(), {}, [p]))).toHaveLength(0);
  });
  it("bounds scope, reports soft budget and honors cancellation", () => {
    expect(() => run(Array.from({ length: 501 }, (_, i) => issue(i)))).toThrow(
      "experimental-scope-exceeded",
    );
    let clock = 0;
    expect(
      run([issue(1)], new Map(), { now: () => (clock += 3000) }).decisionEngine.diagnostics[0],
    ).toContain("soft");
    const c = new AbortController();
    c.abort();
    expect(() => run([], new Map(), { signal: c.signal })).toThrow();
  });
  it("ignores closed retained claims when planning a new pickup", () => {
    const old = issue(1, ["agent:me"]);
    old.state = "CLOSED";
    const a = issue(2);
    const row = implementations(run([old, a], new Map(), { agent: "me" }))[0];
    expect(row.nextCommand).toContain("claim 2");
    expect(row.thenCommand).toBeNull();
  });
  it("routes PR attention and designer duties to PR inspection", () => {
    for (const label of ["attention:me", "design:decision-needed", "design:documentation-needed"]) {
      const p = pr(1, ["IN_PROGRESS"]);
      p.labels = page([{ name: label }]);
      const row = run([], new Map(), { agent: "me", role: "designer" }, [p]).items[0];
      expect(row.nextCommand).toBe("pdb pr 1 --repo o/r");
    }
  });
  it("ignores a supplied unlock score: unlocks come only from collected dependencies", () => {
    const a = issue(1);
    const [row] = run([a], new Map([[a.url, pair(metric("L"), metric("S"))]])).items;
    expect(row.unlocks).toBe(0);
    expect(row.why.ruleIds).toEqual(["D-EASY"]);
  });
});

describe("refinement facts reach the native queue (#1098)", () => {
  const open = {
    state: "open" as const,
    estimated: false,
    question: { trust: "trusted" as const, version: 2 as const, outcome: "none" as const },
  };
  const settled = { ...open, question: { ...open.question, outcome: "resolved" as const } };
  type Request = Omit<typeof open, "question"> & {
    question: { trust: "trusted"; version: 2; outcome: "none" | "resolved" | "withdrawn" };
  };
  const facts = (requests: Request[], complete = true) => ({ requests, complete });
  const url = (n: number) => issue(n).url;

  it("gives the designer D-REFINE with the refine status command, ahead of ordinary design", () => {
    const r = run(
      [issue(1, ["status:ready", "refinement:needed"]), issue(2, ["status:needs-design"])],
      new Map(),
      {
        role: "designer",
        agent: "me",
        refinements: new Map([[url(1), facts([open])]]),
      },
    );
    const refine = r.items.find((x) => x.ruleIds.includes("D-REFINE"))!;
    expect(refine.nextCommand).toBe("pdb refine status 1 --repo o/r");
    expect(refine.why.text).toMatch(/assuming its dependencies were met/);
    const design = r.items.findIndex((x) => x.ruleIds.includes("D-DESIGN"));
    if (design >= 0) expect(r.items.indexOf(refine)).toBeLessThan(design);
  });

  it("denies implementation pickup while refinement is open, whatever the ready label says", () => {
    const r = run([issue(1, ["status:ready", "refinement:needed"])], new Map(), {
      agent: "me",
      refinements: new Map([[url(1), facts([open])]]),
    });
    expect(implementations(r)).toHaveLength(0);
    expect(JSON.stringify(r)).toContain("D-DENY-REFINEMENT");
  });

  it("offers resolve once every question is settled, and fails closed on incomplete facts", () => {
    const resolve = run([issue(1, ["refinement:needed"])], new Map(), {
      role: "designer",
      agent: "me",
      refinements: new Map([[url(1), facts([settled])]]),
    });
    expect(resolve.items.some((x) => x.ruleIds.includes("D-REFINE-RESOLVE"))).toBe(true);
    const incomplete = run([issue(1, ["status:ready", "refinement:needed"])], new Map(), {
      agent: "me",
      refinements: new Map([[url(1), facts([settled], false)]]),
    });
    expect(implementations(incomplete)).toHaveLength(0);
  });
});
