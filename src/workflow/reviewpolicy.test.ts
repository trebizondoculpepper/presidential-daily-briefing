/** Declared review policy fixture matrix (#301, doc/design/declared-review-policy.md). */
import { describe, expect, it } from "vite-plus/test";
import {
  evaluateReviewPolicy,
  observeProvider,
  policyNotRead,
  reviewPolicyText,
} from "./reviewpolicy.js";
import type { DeclaredReviewPolicy, ReviewEvidence } from "./reviewpolicy.js";

const head = "a".repeat(40);
const old = "b".repeat(40);
const or: DeclaredReviewPolicy = { state: "declared", policy: "codex-or-coderabbit" };
const legacy: DeclaredReviewPolicy = { state: "declared", policy: "legacy" };
const bot = (login: string) => ({ __typename: "Bot", login });
const user = (login: string) => ({ __typename: "User", login });
const marker = (sha: string, status = "completed", findings = false) =>
  `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status, commit_sha: sha, has_unresolved_findings: findings } })} -->`;
const codexReceipt = (
  sha = head,
  status = "completed",
  findings = false,
  author: { __typename?: string; login: string } = bot("chatgpt-codex-connector"),
) => ({
  author,
  body: marker(sha, status, findings),
  url: `https://github.com/o/r/pull/1#codex-${sha.slice(0, 3)}-${status}-${findings}`,
});
const rabbitReview = (
  state: string,
  commit = head,
  author: { __typename?: string; login: string } = bot("coderabbitai"),
) => ({
  author,
  state,
  commit,
  at: "2026-11-15T00:00:00Z",
  url: `https://github.com/o/r/pull/1#rabbit-${state}-${commit.slice(0, 3)}`,
});
const evidence = (over: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  head,
  reviews: [],
  comments: [],
  complete: true,
  ...over,
});
const run = (e: ReviewEvidence, d: DeclaredReviewPolicy = or) => evaluateReviewPolicy(d, e);
const states = (e: ReviewEvidence) => run(e).detail.providers.map((o) => [o.provider, o.state]);

describe("either-provider coverage", () => {
  it("Codex only clean satisfies coverage, naming its source", () => {
    const r = run(evidence({ comments: [codexReceipt()] }));
    expect(r.headReviewed).toBe(true);
    expect(r.detail.coverage).toBe("satisfied");
    expect(r.detail.satisfiedBy).toEqual([{ provider: "codex", head, source: codexReceipt().url }]);
    expect(states(evidence({ comments: [codexReceipt()] }))).toEqual([
      ["codex", "accepted"],
      ["coderabbit", "unknown"],
    ]);
  });

  it("CodeRabbit only approval of the current head satisfies coverage", () => {
    const r = run(evidence({ reviews: [rabbitReview("APPROVED")] }));
    expect(r.headReviewed).toBe(true);
    expect(r.detail.satisfiedBy.map((s) => s.provider)).toEqual(["coderabbit"]);
  });

  it("both providers clean list both", () => {
    const r = run(evidence({ comments: [codexReceipt()], reviews: [rabbitReview("APPROVED")] }));
    expect(r.detail.satisfiedBy.map((s) => s.provider)).toEqual(["codex", "coderabbit"]);
  });

  it("neither provider leaves coverage unsatisfied, not unknown", () => {
    const r = run(evidence());
    expect(r.headReviewed).toBe(false);
    expect(r.detail.coverage).toBe("unsatisfied");
  });

  it("a pending or stale optional provider does not block the other's acceptance", () => {
    const pending = run(
      evidence({
        comments: [codexReceipt(head, "in_progress")],
        reviews: [rabbitReview("APPROVED")],
      }),
    );
    expect(pending.headReviewed).toBe(true);
    expect(pending.detail.providers[0].state).toBe("pending");
    const stale = run(
      evidence({ comments: [codexReceipt(old)], reviews: [rabbitReview("APPROVED")] }),
    );
    expect(stale.headReviewed).toBe(true);
    expect(stale.detail.providers[0]).toMatchObject({ state: "stale", head: old });
  });

  it("a stale or pending provider alone is not coverage", () => {
    expect(run(evidence({ comments: [codexReceipt(old)] })).headReviewed).toBe(false);
    expect(run(evidence({ reviews: [rabbitReview("APPROVED", old)] })).headReviewed).toBe(false);
    expect(run(evidence({ comments: [codexReceipt(head, "in_progress")] })).headReviewed).toBe(
      false,
    );
  });
});

describe("neutral, quota and error evidence never satisfies coverage", () => {
  const rabbitCheck = (status: string | null, conclusion: string | null) => ({
    app: "coderabbitai",
    name: "CodeRabbit",
    status,
    conclusion,
    url: "https://github.com/o/r/runs/9",
  });
  it("classifies CodeRabbit's neutral rate-limited run as skipped", () => {
    const e = evidence({ checks: [rabbitCheck("COMPLETED", "NEUTRAL")] });
    expect(observeProvider("coderabbit", e).state).toBe("skipped");
    expect(run(e).headReviewed).toBe(false);
  });
  it("classifies a CodeRabbit review-limit notice as skipped, not a review", () => {
    const e = evidence({
      comments: [
        {
          author: bot("coderabbitai"),
          body: "Review limit reached. Please try again later.",
          url: "u",
        },
      ],
    });
    expect(observeProvider("coderabbit", e)).toMatchObject({ state: "skipped", source: "u" });
    expect(run(e).headReviewed).toBe(false);
  });
  it("a generic green CodeRabbit check without a review is not acceptance", () => {
    const e = evidence({ checks: [rabbitCheck("COMPLETED", "SUCCESS")] });
    expect(observeProvider("coderabbit", e).state).toBe("unknown");
    expect(run(e).headReviewed).toBe(false);
  });
  it("reports error and pending runs", () => {
    expect(
      observeProvider("coderabbit", evidence({ checks: [rabbitCheck("COMPLETED", "FAILURE")] }))
        .state,
    ).toBe("error");
    expect(
      observeProvider("coderabbit", evidence({ checks: [rabbitCheck("IN_PROGRESS", null)] })).state,
    ).toBe("pending");
  });
  it("a check from another app with the provider's name is ignored", () => {
    const e = evidence({
      checks: [{ ...rabbitCheck("COMPLETED", "NEUTRAL"), app: "github-actions" }],
    });
    expect(observeProvider("coderabbit", e).state).toBe("unknown");
  });
  it("a quota-skipped provider does not block the other's acceptance", () => {
    const r = run(
      evidence({ comments: [codexReceipt()], checks: [rabbitCheck("COMPLETED", "NEUTRAL")] }),
    );
    expect(r.headReviewed).toBe(true);
  });
});

describe("authentication and head binding", () => {
  it("rejects a copied Codex marker posted by a user and says so", () => {
    const r = run(
      evidence({ comments: [codexReceipt(head, "completed", false, user("mallory"))] }),
    );
    expect(r.headReviewed).toBe(false);
    expect(r.detail.unknowns.join()).toMatch(
      /ignored a Codex review-state marker posted by mallory/,
    );
  });
  it("rejects a user account named like the integration", () => {
    const spoof = run(
      evidence({
        comments: [codexReceipt(head, "completed", false, user("chatgpt-codex-connector"))],
      }),
    );
    expect(spoof.headReviewed).toBe(false);
    expect(
      run(evidence({ reviews: [rabbitReview("APPROVED", head, user("coderabbitai"))] }))
        .headReviewed,
    ).toBe(false);
  });
  it("an author with no recorded type cannot establish acceptance", () => {
    const e = evidence({
      comments: [codexReceipt(head, "completed", false, { login: "chatgpt-codex-connector" })],
    });
    const r = run(e);
    expect(r.headReviewed).toBe(false);
    expect(r.detail.unknowns.join()).toMatch(/author type unknown/);
  });
  it("binds to the full head: a short or mismatched SHA is not current", () => {
    expect(run(evidence({ comments: [codexReceipt(head.slice(0, 7))] })).headReviewed).toBe(false);
    expect(
      run(evidence({ reviews: [rabbitReview("APPROVED", head.slice(0, 12))] })).headReviewed,
    ).toBe(false);
  });
  it("a new head invalidates both earlier acceptances", () => {
    const e = evidence({ comments: [codexReceipt()], reviews: [rabbitReview("APPROVED")] });
    const moved = { ...e, head: "c".repeat(40) };
    expect(run(moved).headReviewed).toBe(false);
    expect(run(moved).detail.providers.map((o) => o.state)).toEqual(["stale", "stale"]);
  });
  it("a malformed receipt on the head is unknown, never acceptance", () => {
    const e = evidence({
      comments: [
        {
          author: bot("chatgpt-codex-connector"),
          body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}"}} -->`,
          url: "m",
        },
      ],
    });
    expect(observeProvider("codex", e).state).toBe("unknown");
    expect(run(e).headReviewed).toBe(false);
  });
  it("a human approval is not provider coverage under the declared policy", () => {
    expect(
      run(evidence({ reviews: [rabbitReview("APPROVED", head, user("someone"))] })).headReviewed,
    ).toBe(false);
  });
});

describe("findings veto across providers", () => {
  it("Codex findings block despite a CodeRabbit approval", () => {
    const r = run(
      evidence({
        comments: [codexReceipt(head, "completed", true)],
        reviews: [rabbitReview("APPROVED")],
      }),
    );
    expect(r.headReviewed).toBe(false);
    expect(r.headFindings).toBe(true);
    expect(r.detail.findings.map((f) => f.provider)).toEqual(["codex"]);
  });
  it("CodeRabbit changes requested block despite a clean Codex receipt", () => {
    const r = run(
      evidence({ comments: [codexReceipt()], reviews: [rabbitReview("CHANGES_REQUESTED")] }),
    );
    expect(r.headReviewed).toBe(false);
    expect(r.headFindings).toBe(true);
  });
  it("conflicting Codex receipts on the head are a finding, not whichever says clean", () => {
    const r = run(evidence({ comments: [codexReceipt(head, "completed", true), codexReceipt()] }));
    expect(r.detail.providers[0].state).toBe("findings");
    expect(r.headReviewed).toBe(false);
  });
  it("stale findings on an older head do not block a current acceptance", () => {
    const r = run(
      evidence({
        comments: [codexReceipt(old, "completed", true)],
        reviews: [rabbitReview("APPROVED")],
      }),
    );
    expect(r.headReviewed).toBe(true);
  });
});

describe("declared, legacy, undeclared and unknown policy", () => {
  const humanApproved = evidence({ reviews: [rabbitReview("APPROVED", head, user("someone"))] });
  it("legacy and undeclared keep the pre-#301 result", () => {
    for (const d of [
      legacy,
      policyNotRead,
      { state: "undeclared", scope: "repository-config" } as const,
    ]) {
      const r = evaluateReviewPolicy(d, humanApproved);
      expect(r.headReviewed).toBe(true);
      expect(r.detail.effective).toBe("legacy");
      expect(r.detail.satisfiedBy).toEqual([]);
    }
    expect(
      evaluateReviewPolicy(legacy, evidence({ reviews: [rabbitReview("CHANGES_REQUESTED")] }))
        .headFindings,
    ).toBe(false);
  });
  it("explicit legacy is distinguishable from absent configuration", () => {
    expect(reviewPolicyText(evaluateReviewPolicy(legacy, humanApproved).detail)).toMatch(
      /^Review policy legacy:/,
    );
    expect(reviewPolicyText(evaluateReviewPolicy(policyNotRead, humanApproved).detail)).toMatch(
      /^Review policy undeclared \(legacy; not-read\)/,
    );
  });
  it("unknown policy accepts nothing but still reports findings", () => {
    const d: DeclaredReviewPolicy = { state: "unknown", reason: "config unreadable" };
    const clean = evaluateReviewPolicy(
      d,
      evidence({ comments: [codexReceipt()], reviews: [rabbitReview("APPROVED")] }),
    );
    expect(clean.headReviewed).toBe(false);
    expect(clean.detail.coverage).toBe("unknown");
    expect(clean.detail.unknowns).toContain("review policy unknown: config unreadable");
    expect(
      evaluateReviewPolicy(d, evidence({ reviews: [rabbitReview("CHANGES_REQUESTED")] }))
        .headFindings,
    ).toBe(true);
  });
  it("incomplete finding evidence keeps coverage unknown", () => {
    const r = run(evidence({ comments: [codexReceipt()], complete: false }));
    expect(r.detail.coverage).toBe("unknown");
    expect(r.detail.unknowns.join()).toMatch(/incomplete/);
  });
  it("explains the satisfying provider with its source", () => {
    const text = reviewPolicyText(
      run(
        evidence({
          comments: [codexReceipt(head, "in_progress")],
          reviews: [rabbitReview("APPROVED")],
        }),
      ).detail,
    );
    expect(text).toBe(
      `Review policy codex-or-coderabbit: coverage satisfied by CodeRabbit ${rabbitReview("APPROVED").url} (Codex pending, CodeRabbit accepted)`,
    );
  });
});
