import { evaluateCheckPolicy } from "../rules/datalog/engine.js";
import { requiredCheckEvidence } from "./requiredchecks.js";
/**
 * #497: every PR evidence source's completeness reaches the shared follow-up facts, and the
 * TypeScript snapshot, `pr N` report and native Datalog projections agree on unknown versus
 * proven acceptance.
 */
import { describe, expect, it } from "vite-plus/test";
import { prEvidenceGaps } from "./previdence.js";
import type { Issue, Page, PullRequest, Snapshot } from "./types.js";
import {
  classifyFollowUp,
  reportFollowUpFacts,
  snapshotFollowUpFacts,
} from "../workflow/deliveryread.js";
import type { PrStatusReport } from "../workflow/prstatus.js";
import { evaluateDatalog } from "../rules/datalog/datalog.js";
import type { SubjectAssessments } from "../briefing/assessments.js";

const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const receipt = (head: string, findings: boolean) => ({
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status: "completed", commit_sha: head, has_unresolved_findings: findings } })} -->`,
  url: "c",
  author: { login: "chatgpt-codex-connector" },
});

type Shape = { verify?: string; reviewed?: boolean; mergeState?: string };
/** A complete PR: by default verify passed, a clean Codex receipt on the head, merge CLEAN. */
function pr(n: number, shape: Shape = {}): PullRequest {
  const head = `head${n}`;
  return {
    number: n,
    title: `PR ${n}`,
    body: "",
    url: url(n),
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: page(),
    comments: page(shape.reviewed === false ? [] : [receipt(head, false)]),
    headRefOid: head,
    requiredChecks: {
      head: head,
      base: "main",
      expected: [{ context: "verify", appId: null }],
      checks: [{ name: "verify", databaseId: null, appId: null, required: "required" }],
      gaps: [],
    },
    headRefName: "branch",
    baseRefName: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: shape.mergeState ?? "CLEAN",
    reviewDecision: null,
    closingIssuesReferences: page(),
    reviewThreads: page([{ isResolved: true, isOutdated: false, comments: page() }]),
    reviews: page(),
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: page([{ name: "verify", conclusion: shape.verify ?? "SUCCESS" }]),
            },
          },
        },
      ],
    },
  } as PullRequest;
}

const snap = (p: PullRequest, warnings: string[] = []) =>
  ({
    schemaVersion: 1,
    repository: "o/r",
    startedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    issues: [] as Issue[],
    pullRequests: [p],
    dependencies: [],
    changed: [],
    since: null,
    warnings,
    rateLimit: null,
  }) as Snapshot;
const assessed: SubjectAssessments = {
  impact: { size: "M", state: "current", provenance: null },
  complexity: { size: "M", state: "current", provenance: null },
  unlocks: 0,
  unlocksUnknown: [],
};

/** Native verdict: merge/integrate proposals are proven acceptance; neither is unknown. */
function nativeAccepts(p: PullRequest, warnings: string[] = []): boolean {
  const r = evaluateDatalog(snap(p, warnings), new Map([[p.url, assessed]]), {
    role: "implementer",
    limit: 100,
  });
  return r.items.some(
    (i) => i.target === p.url && /D-PR-(MERGE|INTEGRATE)/.test(i.ruleIds.join(" ")),
  );
}
/** The same PR's `pr N` report projection, carrying the completeness the shared gaps found. */
function report(p: PullRequest, warnings: string[] = []): PrStatusReport {
  const f = snapshotFollowUpFacts(p, warnings);
  const gaps = prEvidenceGaps(p, warnings);
  return {
    pullRequest: {
      draft: f.draft,
      head: p.headRefOid,
      mergeable: f.mergeable,
      mergeState: f.mergeState,
      reviewDecision: p.reviewDecision,
    },
    checks: {
      policy: evaluateCheckPolicy(requiredCheckEvidence(p)),
      required: { outcome: f.verified ? "SUCCESS" : f.failing ? "FAILURE" : "" },
      counts: { failed: f.failing ? 1 : 0, pending: f.pending ? 1 : 0, unknown: 0 },
    },
    threads: { unresolved: f.unresolvedThreads ? [{}] : [], omitted: 0 },
    headReviewed: f.headReviewed,
    headFindings: f.headFindings,
    completeness: { complete: !gaps.length, warnings: gaps },
  } as unknown as PrStatusReport;
}
const follow = (p: PullRequest, warnings: string[] = []) =>
  classifyFollowUp(snapshotFollowUpFacts(p, warnings));

/** Each source independently: another page (either direction) or not requested at all. */
const sources: [string, (p: PullRequest, how: "next" | "previous" | "missing") => void][] = [
  ["comments", (p, how) => mutate(p, "comments", how)],
  ["reviews", (p, how) => mutate(p, "reviews", how)],
  ["review threads", (p, how) => mutate(p, "reviewThreads", how)],
  [
    "head checks",
    (p, how) => {
      if (how === "missing") Reflect.deleteProperty(p, "commits");
      else mutate(p.commits.nodes[0].commit.statusCheckRollup!, "contexts", how);
    },
  ],
];
function mutate<T extends object>(o: T, key: keyof T, how: "next" | "previous" | "missing") {
  if (how === "missing") Reflect.deleteProperty(o, key);
  else {
    const c = o[key] as Page<unknown>;
    c.pageInfo = {
      hasNextPage: how === "next",
      endCursor: "x",
      ...(how === "previous" ? { hasPreviousPage: true } : {}),
    } as Page<unknown>["pageInfo"];
  }
}

describe("PR evidence completeness across every source (#497)", () => {
  it("leaves complete fixtures proven and agreeing: accepted, waiting and failed", () => {
    const accepted = pr(1);
    expect(prEvidenceGaps(accepted, [])).toEqual([]);
    expect(follow(accepted)).toEqual([
      "actionable",
      "accepted on the current head but not merged: inspect, then consider merge",
    ]);
    expect(classifyFollowUp(reportFollowUpFacts(report(accepted)))).toEqual(follow(accepted));
    expect(nativeAccepts(accepted)).toBe(true);

    const waiting = pr(2, { reviewed: false, mergeState: "BLOCKED" });
    expect(follow(waiting)).toEqual(["waiting", "awaiting current-head review"]);
    expect(classifyFollowUp(reportFollowUpFacts(report(waiting)))).toEqual(follow(waiting));
    expect(nativeAccepts(waiting)).toBe(false);

    const failed = pr(3, { verify: "FAILURE" });
    expect(follow(failed)).toEqual(["actionable", "failing checks on the current head"]);
    expect(classifyFollowUp(reportFollowUpFacts(report(failed)))).toEqual(follow(failed));
    expect(nativeAccepts(failed)).toBe(false);
  });

  for (const [label, damage] of sources)
    for (const how of ["next", "previous", "missing"] as const)
      it(`keeps an accepted-looking first page unknown when ${label} is ${how}`, () => {
        // The visible page holds a clean receipt on the head; an unseen page may hold a finding.
        const p = pr(4);
        damage(p, how);
        expect(prEvidenceGaps(p, [])).toEqual([label]);
        expect(follow(p)[0]).toBe("unknown");
        expect(classifyFollowUp(reportFollowUpFacts(report(p)))[0]).toBe("unknown");
        expect(nativeAccepts(p)).toBe(false);
      });

  it("treats a null check rollup as no checks and waits for the explicit requirement", () => {
    const p = pr(5);
    p.commits.nodes[0].commit.statusCheckRollup = null;
    expect(prEvidenceGaps(p, [])).toEqual([]);
    expect(follow(p)).toEqual(["waiting", "awaiting checks"]);
    expect(nativeAccepts(p)).toBe(false);
  });

  it("matches warnings by exact PR URL prefix, never a longer number (#448)", () => {
    const p = pr(1);
    const other = [`${url(12)}: reviews exceed 100; review/merge evidence incomplete.`];
    expect(prEvidenceGaps(p, other)).toEqual([]);
    expect(follow(p, other)[0]).toBe("actionable");
    expect(nativeAccepts(p, other)).toBe(true);
    const own = [`${url(1)}: reviews exceed 100; review/merge evidence incomplete.`];
    expect(prEvidenceGaps(p, own)).toEqual(["warnings"]);
    expect(follow(p, own)[0]).toBe("unknown");
    expect(nativeAccepts(p, own)).toBe(false);
  });
});
