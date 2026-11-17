import { describe, expect, it } from "vite-plus/test";
import { evaluatePrReadiness, type PrReadinessInput } from "./engine.js";

const baseInput = (over: Partial<PrReadinessInput> = {}): PrReadinessInput => ({
  state: "OPEN",
  closedLabel: "closed",
  draft: false,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  unresolvedThreadCount: 0,
  pendingCount: 0,
  checkEvidence: { complete: true, gaps: [], missing: [], checks: [] },
  policy: {
    effective: "legacy",
    headReviewed: false,
    hasFindings: false,
    summary: "",
    findings: [],
  },
  codex: {
    findingsOnHead: false,
    staleHead: false,
    runningStatus: null,
  },
  reviewRequestStatus: null,
  ...over,
});

describe("native PR readiness diagnostics (#707)", () => {
  it("returns ready with no blockers for a clean open PR", () => {
    const res = evaluatePrReadiness(baseInput());
    expect(res.ready).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.reasons).toEqual([]);
    expect(res.verdict).toContain("No blocker found");
  });

  it("reports only closed/merged state for non-open PRs", () => {
    const res = evaluatePrReadiness(
      baseInput({ state: "MERGED", closedLabel: "merged", draft: true, mergeable: "CONFLICTING" }),
    );
    expect(res.ready).toBe(false);
    expect(res.reasons).toEqual([{ ruleId: "PR-CLOSED", text: "pull request is merged" }]);
  });

  it("covers draft, failed, cancelled, pending, conflicts, merge state, changes requested, required review, and threads", () => {
    const res = evaluatePrReadiness(
      baseInput({
        draft: true,
        mergeable: "CONFLICTING",
        mergeStateStatus: "BEHIND",
        reviewDecision: "CHANGES_REQUESTED",
        unresolvedThreadCount: 2,
        pendingCount: 1,
        checkEvidence: {
          complete: true,
          gaps: [],
          missing: ["verify"],
          checks: [
            { name: "lint", outcome: "FAILURE", required: "required" },
            { name: "win", outcome: "CANCELLED", required: "required" },
          ],
        },
        noRunTimeChecks: [false, true],
      }),
    );
    expect(res.ready).toBe(false);
    const ids = res.reasons.map((r) => r.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "PR-DRAFT",
        "RC-MISSING",
        "RC-OUTCOME",
        "PR-CHECK-FAILED",
        "PR-CHECK-CANCELLED",
        "PR-CHECK-PENDING",
        "PR-CONFLICTS",
        "PR-BEHIND",
        "PR-CHANGES-REQUESTED",
        "PR-UNRESOLVED-THREADS",
      ]),
    );
    expect(res.blockers).toContain(
      "check win cancelled without running (likely infrastructure, not a code defect): verification incomplete",
    );
    expect(res.blockers).toContain("branch is behind main: update it before merging");

    const reviewReq = evaluatePrReadiness(baseInput({ reviewDecision: "REVIEW_REQUIRED" }));
    expect(reviewReq.reasons.map((r) => r.ruleId)).toContain("PR-REVIEW-REQUIRED");
  });

  it("covers every review-policy case, Codex state, review request, and BLOCKED fallback", () => {
    const legacyCodex = evaluatePrReadiness(
      baseInput({
        codex: { findingsOnHead: true, staleHead: false, runningStatus: "in_progress" },
      }),
    );
    expect(legacyCodex.reasons.map((r) => r.ruleId)).toEqual(
      expect.arrayContaining(["PR-CODEX-FINDINGS", "PR-CODEX-RUNNING"]),
    );

    const declaredUnsatisfied = evaluatePrReadiness(
      baseInput({
        policy: {
          effective: "codex-or-copilot",
          headReviewed: false,
          hasFindings: false,
          summary: "Codex pending, Copilot skipped",
          findings: [],
        },
        reviewRequestStatus: "no reaction yet",
      }),
    );
    expect(declaredUnsatisfied.reasons.map((r) => r.ruleId)).toEqual(
      expect.arrayContaining(["PR-POLICY-UNSATISFIED", "PR-REVIEW-REQUEST-NONE"]),
    );

    const declaredFindings = evaluatePrReadiness(
      baseInput({
        policy: {
          effective: "codex-or-copilot",
          headReviewed: false,
          hasFindings: true,
          summary: "Codex accepted, Copilot findings",
          findings: [{ provider: "copilot", label: "Copilot", source: "https://example/r/1" }],
        },
      }),
    );
    expect(declaredFindings.reasons.map((r) => r.ruleId)).toContain("PR-PROVIDER-FINDINGS");

    const unknownPolicy = evaluatePrReadiness(
      baseInput({
        policy: {
          effective: "unknown",
          headReviewed: false,
          hasFindings: false,
          summary: "",
          unknownReason: "invalid toml",
          findings: [],
        },
      }),
    );
    expect(unknownPolicy.reasons.map((r) => r.ruleId)).toContain("PR-POLICY-UNKNOWN");

    const blockedFallback = evaluatePrReadiness(baseInput({ mergeStateStatus: "BLOCKED" }));
    expect(blockedFallback.reasons).toEqual([
      {
        ruleId: "PR-BLOCKED",
        text: "GitHub reports merging is blocked (branch protection); inspect the rules",
      },
    ]);
  });
});
