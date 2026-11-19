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
    const noStatusFindings = {
      author: bot("chatgpt-codex-connector"),
      body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, has_unresolved_findings: true } })} -->`,
      url: "https://github.com/o/r/pull/1#codex-no-status",
    };
    const legacyVetoed = evaluateReviewPolicy(
      legacy,
      evidence({
        reviews: [rabbitReview("APPROVED", head, user("someone"))],
        comments: [noStatusFindings],
      }),
    );
    expect(legacyVetoed.headFindings).toBe(true);
    expect(legacyVetoed.headReviewed).toBe(false);
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

describe("review findings (#556 review)", () => {
  const thread = (author: { __typename?: string; login: string }) => ({
    author,
    url: "https://t/1",
  });
  it("a later COMMENTED review keeps a CodeRabbit change request outstanding", () => {
    const r = run(
      evidence({
        comments: [codexReceipt()],
        reviews: [rabbitReview("CHANGES_REQUESTED"), rabbitReview("COMMENTED")],
      }),
    );
    expect(r.detail.providers[1].state).toBe("findings");
    expect(r.headReviewed).toBe(false);
  });
  it("only a later APPROVED or DISMISSED review clears it", () => {
    const approved = run(
      evidence({
        reviews: [
          rabbitReview("CHANGES_REQUESTED"),
          rabbitReview("COMMENTED"),
          rabbitReview("APPROVED"),
        ],
      }),
    );
    expect(approved.headReviewed).toBe(true);
    const dismissed = run(
      evidence({
        comments: [codexReceipt()],
        reviews: [rabbitReview("CHANGES_REQUESTED"), rabbitReview("DISMISSED")],
      }),
    );
    expect(dismissed.headFindings).toBe(false);
    expect(dismissed.headReviewed).toBe(true);
  });
  it("an unauthenticated Codex findings marker cannot veto declared coverage", () => {
    for (const author of [user("chatgpt-codex-connector"), { login: "chatgpt-codex-connector" }]) {
      const r = run(
        evidence({
          comments: [codexReceipt(head, "completed", true, author)],
          reviews: [rabbitReview("APPROVED")],
        }),
      );
      expect(r.headFindings).toBe(false);
      expect(r.headReviewed).toBe(true);
      expect(r.detail.unknowns.join()).toMatch(/ignored a Codex review-state marker/);
    }
    // Legacy keeps its login-only rule.
    expect(
      evaluateReviewPolicy(
        legacy,
        evidence({
          comments: [codexReceipt(head, "completed", true, user("chatgpt-codex-connector"))],
        }),
      ).headFindings,
    ).toBe(true);
  });
  it("incomplete evidence never reports headReviewed beside unknown coverage", () => {
    const r = run(evidence({ comments: [codexReceipt()], complete: false }));
    expect(r.headReviewed).toBe(false);
    expect(r.detail.coverage).toBe("unknown");
  });
  it("an unresolved thread opened by a provider is a finding; another author's is not", () => {
    const flagged = run(
      evidence({ comments: [codexReceipt()], unresolvedThreads: [thread(bot("coderabbitai"))] }),
    );
    expect(flagged.headFindings).toBe(true);
    expect(flagged.headReviewed).toBe(false);
    expect(
      run(
        evidence({ comments: [codexReceipt()], unresolvedThreads: [thread(user("coderabbitai"))] }),
      ).headReviewed,
    ).toBe(true);
  });
});

describe("real-shaped snapshot reads authenticate providers (#556 review)", () => {
  it("collect requests author types, so a Bot reviewer and Codex receipt authenticate", async () => {
    const { collect } = await import("../github/github.js");
    const { pr, page, repo, time } = await import("../testing/snapshots.js");
    const pull = pr();
    pull.headRefOid = head;
    // GitHub returns only what a query selects: author types appear only when requested.
    const author = (source: string, field: RegExp, login: string) =>
      field.test(source) ? { __typename: "Bot", login } : { login };
    const query = async (source: string) => {
      if (source.includes("pullRequests(first")) {
        const reviews = author(
          source,
          /reviews\(first:100\)\{nodes\{[^}]*author\{__typename login\}/,
          "coderabbitai",
        );
        const comments = author(
          source,
          /comments\(first:100\)\{nodes\{[^}]*author\{__typename login\}/,
          "chatgpt-codex-connector",
        );
        return {
          repository: {
            pullRequests: page([
              {
                ...pull,
                reviews: page([
                  {
                    body: "",
                    url: "r",
                    author: reviews,
                    state: "APPROVED",
                    submittedAt: time,
                    commit: { oid: head },
                  },
                ]),
                comments: page([{ body: marker(head), url: "c", author: comments }]),
              },
            ]),
          },
        };
      }
      return { repository: { issues: page([]) } };
    };
    const snap = await collect(repo, {}, query as never, () => new Date(time));
    const [collected] = snap.pullRequests;
    expect(collected.reviews.nodes[0].author).toEqual({ __typename: "Bot", login: "coderabbitai" });
    const { snapshotReviewEvidence } = await import("./reviewpolicy.js");
    const r = run(snapshotReviewEvidence(collected, true));
    expect(r.detail.providers.map((o) => o.state)).toEqual(["accepted", "accepted"]);
    expect(r.headReviewed).toBe(true);
  });
});

describe("Codex receipt reconciliation (#647) and Copilot normalization (#694)", () => {
  const cleanReceiptBody = (sha = head.slice(0, 10)) =>
    `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${sha}\``;

  it("reconciles a stale Codex running summary with a later clean codex-review-receipt", () => {
    const e = evidence({
      comments: [
        codexReceipt(head, "running", false),
        {
          author: bot("chatgpt-codex-connector"),
          body: cleanReceiptBody(),
          url: "https://github.com/o/r/pull/1#codex-receipt",
        },
      ],
    });
    expect(observeProvider("codex", e)).toMatchObject({
      provider: "codex",
      state: "accepted",
      head,
      source: "https://github.com/o/r/pull/1#codex-receipt",
    });
    expect(run(e, legacy).headReviewed).toBe(true);
  });

  it("does not grant coverage from an abbreviated receipt without a unique full-SHA running summary", () => {
    const bareShort = evidence({
      comments: [
        {
          author: bot("chatgpt-codex-connector"),
          body: cleanReceiptBody(head.slice(0, 10)),
          url: "https://github.com/o/r/pull/1#bare-short",
        },
      ],
    });
    expect(observeProvider("codex", bareShort).state).toBe("stale");
    expect(run(bareShort, legacy).headReviewed).toBe(false);

    const collidingOld = `${head.slice(0, 12)}${"c".repeat(28)}`;
    const colliding = evidence({
      comments: [
        codexReceipt(collidingOld, "completed", false),
        codexReceipt(head, "running", false),
        {
          author: bot("chatgpt-codex-connector"),
          body: cleanReceiptBody(head.slice(0, 10)),
          url: "https://github.com/o/r/pull/1#colliding",
        },
      ],
    });
    expect(observeProvider("codex", colliding).state).toBe("pending");
    expect(run(colliding, legacy).headReviewed).toBe(false);
  });

  it("keeps ambiguous codex-review-receipt prose unknown and ignores forged receipts", () => {
    const ambiguous = evidence({
      comments: [
        {
          author: bot("chatgpt-codex-connector"),
          body: `<!-- codex-review-receipt:v1 -->\n\nLooks interesting.\n\n**Reviewed commit:** \`${head}\``,
          url: "https://github.com/o/r/pull/1#ambiguous",
        },
      ],
    });
    expect(observeProvider("codex", ambiguous).state).toBe("unknown");

    const notes: string[] = [];
    const forged = evidence({
      comments: [
        {
          author: user("chatgpt-codex-connector"),
          body: cleanReceiptBody(),
          url: "https://github.com/o/r/pull/1#forged",
        },
      ],
    });
    expect(observeProvider("codex", forged, notes).state).toBe("unknown");
    expect(notes.some((n) => /ignored a Codex review-state marker/.test(n))).toBe(true);
  });

  it("keeps head findings ahead of a clean codex-review-receipt and marks older receipts stale", () => {
    const findings = evidence({
      comments: [
        codexReceipt(head, "completed", true),
        {
          author: bot("chatgpt-codex-connector"),
          body: cleanReceiptBody(),
          url: "https://github.com/o/r/pull/1#codex-receipt",
        },
      ],
    });
    expect(observeProvider("codex", findings).state).toBe("findings");

    const stale = evidence({
      comments: [
        {
          author: bot("chatgpt-codex-connector"),
          body: cleanReceiptBody(old.slice(0, 10)),
          url: "https://github.com/o/r/pull/1#old-receipt",
        },
      ],
    });
    expect(observeProvider("codex", stale)).toMatchObject({
      state: "stale",
      head: old.slice(0, 10),
    });
  });

  it("normalizes trusted Copilot reviews, threads, checks and failures without deciding acceptance", () => {
    const copilotReview = (
      state: string,
      commit = head,
      author: { __typename?: string; login: string } = bot("copilot-pull-request-reviewer"),
    ) => ({
      author,
      state,
      commit,
      at: "2026-11-16T00:00:00Z",
      url: `https://github.com/o/r/pull/1#copilot-${state}`,
    });

    expect(
      observeProvider(
        "copilot",
        evidence({
          reviews: [copilotReview("COMMENTED")],
          unresolvedThreads: [
            {
              author: bot("copilot-pull-request-reviewer"),
              url: "https://github.com/o/r/pull/1#thread-1",
            },
          ],
        }),
      ),
    ).toMatchObject({
      provider: "copilot",
      state: "findings",
      head,
      source: "https://github.com/o/r/pull/1#thread-1",
    });

    // COMMENTED with 0 unresolved threads stays unknown in TS normalization (policy belongs in native rules).
    expect(
      observeProvider("copilot", evidence({ reviews: [copilotReview("COMMENTED")] })),
    ).toMatchObject({
      provider: "copilot",
      state: "unknown",
      head,
      source: "https://github.com/o/r/pull/1#copilot-COMMENTED",
    });

    // Non-Bot impersonator is ignored.
    expect(
      observeProvider(
        "copilot",
        evidence({
          reviews: [copilotReview("APPROVED", head, user("copilot-pull-request-reviewer"))],
        }),
      ),
    ).toMatchObject({ provider: "copilot", state: "unknown", head: null, source: null });

    // Runtime check failures are normalized as error, pending as pending, neutral as skipped.
    expect(
      observeProvider(
        "copilot",
        evidence({
          checks: [
            {
              app: "copilot-pull-request-reviewer",
              name: "Copilot",
              status: "COMPLETED",
              conclusion: "FAILURE",
              url: "https://github.com/o/r/runs/1",
            },
          ],
        }),
      ),
    ).toMatchObject({ provider: "copilot", state: "error" });

    expect(
      observeProvider(
        "copilot",
        evidence({
          checks: [
            {
              app: "copilot-pull-request-reviewer",
              name: "Copilot",
              status: "IN_PROGRESS",
              conclusion: null,
              url: "https://github.com/o/r/runs/2",
            },
          ],
        }),
      ),
    ).toMatchObject({ provider: "copilot", state: "pending" });

    expect(
      observeProvider("copilot", evidence({ reviews: [copilotReview("COMMENTED", old)] })),
    ).toMatchObject({ provider: "copilot", state: "stale", head: old });
  });

  it("evaluates declared codex-or-copilot policy without requiring CodeRabbit", () => {
    const codexOrCopilot: DeclaredReviewPolicy = { state: "declared", policy: "codex-or-copilot" };
    const cleanCodex = run(evidence({ comments: [codexReceipt()] }), codexOrCopilot);
    expect(cleanCodex.headReviewed).toBe(true);
    expect(cleanCodex.detail.providers.map((o) => o.provider)).toEqual(["codex", "copilot"]);
    expect(cleanCodex.detail.satisfiedBy).toEqual([
      { provider: "codex", head, source: codexReceipt().url },
    ]);

    const copilotFindings = run(
      evidence({
        comments: [codexReceipt()],
        unresolvedThreads: [
          {
            author: bot("copilot-pull-request-reviewer"),
            url: "https://github.com/o/r/pull/1#copilot-thread",
          },
        ],
      }),
      codexOrCopilot,
    );
    expect(copilotFindings.headReviewed).toBe(false);
    expect(copilotFindings.headFindings).toBe(true);

    const commentedOnly = run(
      evidence({
        reviews: [
          {
            author: bot("copilot-pull-request-reviewer"),
            state: "COMMENTED",
            commit: head,
            at: "2026-11-16T00:00:00Z",
            url: "https://github.com/o/r/pull/1#copilot-commented",
          },
        ],
      }),
      codexOrCopilot,
    );
    expect(commentedOnly.headReviewed).toBe(false);
    expect(commentedOnly.headFindings).toBe(false);
  });
});
