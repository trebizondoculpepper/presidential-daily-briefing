import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { type Query } from "../github/github.js";
import { issue, repo, time } from "../testing/snapshots.js";

describe("pr status: why is a PR not progressing (#59)", () => {
  const head = "a".repeat(40);
  const run = (name: string, extra: Record<string, unknown> = {}) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    isRequired: true,
    conclusion: "SUCCESS",
    detailsUrl: `https://ci/${name}`,
    startedAt: time,
    ...extra,
  });
  const codexComment = (sha: string, status = "completed", unresolved = false) => ({
    author: { login: "chatgpt-codex-connector" },
    createdAt: "2026-11-12T09:00:00Z",
    url: "https://c/1",
    body: `summary <!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":${unresolved},"has_unresolved_findings":${unresolved},"status":"${status}"}} -->`,
  });
  const pull = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    headRefOid: head,
    requiredChecks: {
      head,
      base: "main",
      expected: [
        { context: "verify", appId: null },
        ...(o.checks ?? [])
          .filter(
            (c: { name: string; isRequired?: boolean }) =>
              c.name !== "verify" && c.isRequired === true,
          )
          .map((c: { name: string }) => ({ context: c.name, appId: null })),
      ],
      checks: (o.checks ?? [run("verify")]).map((c: { name: string; isRequired?: boolean }) => ({
        name: c.name,
        databaseId: null,
        appId: null,
        required:
          c.name === "verify"
            ? "required"
            : c.isRequired === true
              ? "required"
              : c.isRequired === false
                ? "advisory"
                : "unknown",
      })),
      gaps: [],
    },
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: { nodes: o.checks ?? [run("verify")], pageInfo: { hasNextPage: false } },
            },
          },
        },
      ],
    },
    reviews: { nodes: o.reviews ?? [] },
    reviewThreads: { nodes: o.threads ?? [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [] },
    closingIssuesReferences: { nodes: o.issues ?? [] },
    ...o.pr,
  });
  it("computes head acceptance over every receipt before the display limit (#192)", async () => {
    const { prStatus } = await import("./prstatus.js");
    const bots = [1, 2, 3, 4].map((n) => ({
      author: { login: "coderabbitai[bot]" },
      createdAt: `2026-11-12T10:0${n}:00Z`,
      url: `https://c/b${n}`,
      body: `note ${n}`,
    }));
    const r = prStatus(repo, pull({ comments: [codexComment(head), ...bots] }));
    expect(r.receipts).toHaveLength(3);
    expect(r.receipts.some((c: { codexState: unknown }) => c.codexState)).toBe(false);
    expect(r.headReviewed).toBe(true);
    expect(r.headFindings).toBe(false);
    const flagged = prStatus(
      repo,
      pull({ comments: [codexComment(head, "completed", true), ...bots] }),
    );
    expect(flagged.headFindings).toBe(true);
    expect(flagged.headReviewed).toBe(false);
  });

  it("classifies checks: passed, pending, cancelled, failed, unknown", async () => {
    const { classifyCheck } = await import("./prstatus.js");
    expect(classifyCheck(run("a"))).toBe("passed");
    expect(classifyCheck(run("a", { status: "IN_PROGRESS", conclusion: null }))).toBe("pending");
    expect(classifyCheck({ context: "x", state: "PENDING" })).toBe("pending");
    expect(classifyCheck(run("a", { conclusion: "CANCELLED" }))).toBe("cancelled");
    expect(classifyCheck(run("a", { conclusion: "FAILURE" }))).toBe("failed");
    expect(classifyCheck(run("a", { conclusion: "WEIRD" }))).toBe("unknown");
  });
  it("lists every blocker at once, distinguishing missing, pending and cancelled verification", async () => {
    const { prStatus } = await import("./prstatus.js");
    const r = prStatus(
      repo,
      pull({
        checks: [
          run("unit", { conclusion: "FAILURE" }),
          run("mac", { conclusion: "CANCELLED", startedAt: null }),
        ],
        pr: { mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" },
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            path: "src/a.js",
            line: 3,
            first: {
              totalCount: 2,
              nodes: [
                {
                  author: { login: "coderabbitai" },
                  body: "Bug here",
                  createdAt: time,
                  url: "https://t/1",
                },
              ],
            },
            latest: {
              nodes: [{ author: { login: "kavya" }, createdAt: time, url: "https://t/2" }],
            },
          },
        ],
      }),
      { now: new Date(time) },
    );
    expect(r.blockers).toEqual([
      "Required check mac is CANCELLED",
      "Required check not yet reported: verify",
      "Required check unit is FAILURE",
      "check unit failed",
      "check mac cancelled without running (likely infrastructure, not a code defect): verification incomplete",
      "merge conflicts with the base branch",
      "changes requested",
      "1 unresolved review thread(s)",
    ]);
    expect(r.threads.unresolved[0]).toMatchObject({
      by: "coderabbitai",
      replies: 1,
      lastSpeaker: "kavya",
    });
    const pending = prStatus(
      repo,
      pull({ checks: [run("unit", { status: "QUEUED", conclusion: null })] }),
    );
    expect(pending.blockers).toContain("Required check not yet reported: verify");
  });
  it("a running job GitHub reports as not required is shown, never a waiting blocker (#343)", async () => {
    const { prStatus } = await import("./prstatus.js");
    const running = { status: "IN_PROGRESS", conclusion: null };
    const advisory = prStatus(
      repo,
      pull({ checks: [run("verify"), run("test (freebsd)", { ...running, isRequired: false })] }),
    );
    expect(advisory.checks.counts).toMatchObject({ "advisory-pending": 1, pending: 0 });
    expect(advisory.blockers.join(" ")).not.toMatch(/still pending/);
    // Unknown (absent) or required stays a waiting blocker.
    for (const isRequired of [undefined, null, true]) {
      const r = prStatus(
        repo,
        pull({ checks: [run("verify"), run("test (freebsd)", { ...running, isRequired })] }),
      );
      expect(r.blockers, String(isRequired)).toContain("1 check(s) still pending: waiting");
    }
  });

  it("tracks which commit each reviewer reviewed and whether Codex covered the head", async () => {
    const { prStatus } = await import("./prstatus.js");
    const reviews = [
      {
        author: { login: "codex" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T08:00:00Z",
        commit: { oid: "b".repeat(40) },
      },
      {
        author: { login: "codex" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T09:00:00Z",
        commit: { oid: head },
      },
      {
        author: { login: "rabbit" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T07:00:00Z",
        commit: { oid: "c".repeat(40) },
      },
    ];
    const request = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "https://c/2",
    };
    const old = prStatus(
      repo,
      pull({ reviews, comments: [codexComment("b".repeat(40)), request] }),
    );
    expect(old.reviews.map((r) => [r.reviewer, r.current])).toEqual([
      ["codex", true],
      ["rabbit", false],
    ]);
    expect(old.blockers).toContain(
      "Codex's latest review is for an older commit; current head not yet covered",
    );
    expect(old.reviewRequest!.status).toBe("no reaction yet");
    const dirty = prStatus(
      repo,
      pull({ comments: [codexComment(head, "completed", true), request] }),
    );
    expect(dirty.blockers).toEqual(["Codex reports unresolved findings on the current head"]);
    expect(dirty.reviewRequest!.status).toBe("current head reviewed (Codex)");
    const running = prStatus(repo, pull({ comments: [codexComment(head, "running"), request] }));
    expect(running.reviewRequest!.status).toMatch(/in progress/);
  });
  it("an automatically started Codex review still running is a blocker without any request", async () => {
    const { prStatus } = await import("./prstatus.js");
    const auto = prStatus(repo, pull({ comments: [codexComment(head, "running")] }));
    expect(auto.reviewRequest).toBeNull();
    expect(auto.blockers).toEqual([
      "waiting for Codex's review of the current head to finish (running)",
    ]);
    expect(auto.verdict).toMatch(/^Blocked/);
  });
  it("text output shows each receipt's summary and source URL", async () => {
    const { prStatus, prStatusText } = await import("./prstatus.js");
    const receipt = {
      author: { login: "coderabbitai" },
      body: "Actionable comments posted: 2. Please fix the null check.",
      createdAt: "2026-11-12T11:00:00Z",
      url: "https://c/receipt",
    };
    const text = prStatusText(prStatus(repo, pull({ comments: [receipt] })));
    expect(text).toContain(
      "Receipt coderabbitai 2026-11-12T11:00:00Z: Actionable comments posted: 2. Please fix the null check. https://c/receipt",
    );
  });
  it("green evidence is only a merge consideration, and closed PRs report only their state", async () => {
    const { prStatus } = await import("./prstatus.js");
    const green = prStatus(
      repo,
      pull({
        comments: [codexComment(head)],
        issues: [
          {
            number: 5,
            url: issue(5).url,
            title: "T",
            state: "OPEN",
            labels: { nodes: [{ name: "agent:kavya" }] },
          },
        ],
      }),
    );
    expect(green.blockers).toEqual([]);
    expect(green.verdict).toMatch(/not approval/);
    expect(green.linkedIssues[0].owners).toEqual(["kavya"]);
    const merged = prStatus(
      repo,
      pull({ pr: { state: "MERGED", merged: true, mergeable: "UNKNOWN" }, checks: [] }),
    );
    expect(merged.blockers).toEqual(["pull request is merged"]);
  });
  it("runs through the injected query and validates arguments", async () => {
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("no briefing");
      },
      currentRepository: async () => repo,
      query: (async () => ({ repository: { pullRequest: pull() } })) as Query,
    };
    expect(await main(["pr", "12", "--json"], async (t) => void (text = t), runtime)).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ kind: "pr-status", schemaVersion: 1, blockers: [] });
    for (const bad of [["pr"], ["pr", "x"], ["pr", "1", "2"]])
      await expect(main(bad, async () => {}, runtime)).rejects.toThrow("Usage");
    const missing = {
      ...runtime,
      query: (async () => ({ repository: { pullRequest: null } })) as Query,
    };
    await expect(main(["pr", "99"], async () => {}, missing)).rejects.toThrow("unavailable");
  });
});

describe("pr status: truncation and requested-reviewer matching", () => {
  const head = "a".repeat(40);
  const base = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    headRefOid: head,
    requiredChecks: {
      head,
      base: "main",
      expected: [],
      checks: [{ name: "verify", databaseId: null, appId: null, required: "advisory" as const }],
      gaps: [],
    },
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "verify",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    startedAt: time,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: !!o.moreReviews } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasPreviousPage: !!o.moreComments } },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: !!o.moreIssues } },
  });
  it("reports truncated comments, reviews and linked issues as incomplete", async () => {
    const { prStatus } = await import("./prstatus.js");
    expect(prStatus(repo, base()).completeness.complete).toBe(true);
    const r = prStatus(repo, base({ moreComments: true, moreReviews: true, moreIssues: true }));
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.warnings).toHaveLength(3);
  });
  it("counts only the requested service as answering a review request", async () => {
    const { prStatus } = await import("./prstatus.js");
    const request = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u1",
    };
    const codecov = {
      author: { login: "codecov[bot]" },
      body: "Coverage 90%",
      createdAt: "2026-11-12T11:00:00Z",
      url: "u2",
    };
    const unrelated = prStatus(repo, base({ comments: [request, codecov] }));
    expect(unrelated.reviewRequest!.status).toBe("no reaction yet");
    expect(unrelated.blockers).toContain("a review was requested and has had no reaction");
    const rabbit = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u3",
    };
    const answer = {
      author: { login: "coderabbitai" },
      body: "Review complete",
      createdAt: "2026-11-12T11:00:00Z",
      url: "u4",
    };
    expect(prStatus(repo, base({ comments: [rabbit, answer] })).reviewRequest!.status).toBe(
      "a reviewer has posted since the request",
    );
  });
});

describe("pr status: formal reviews and in-progress reviews", () => {
  it("counts a formal review by the requested service and blocks while Codex is running", async () => {
    const { prStatus } = await import("./prstatus.js");
    const head = "a".repeat(40);
    const pr = (comments: any[], reviews: any[]) => ({
      number: 12,
      title: "Fix",
      url: `https://github.com/${repo}/pull/12`,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: head,
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: time,
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: time,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        ],
      },
      reviews: { nodes: reviews, pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: comments, pageInfo: { hasPreviousPage: false } },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    });
    const request = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u",
    };
    const review = {
      author: { login: "coderabbitai" },
      state: "COMMENTED",
      submittedAt: "2026-11-12T11:00:00Z",
      url: "r",
      commit: { oid: head },
    };
    expect(prStatus(repo, pr([request], [review])).reviewRequest!.status).toBe(
      "a reviewer has posted since the request",
    );
    const codexReq = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u",
    };
    const running = {
      author: { login: "chatgpt-codex-connector[bot]" },
      body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","status":"running"}} -->`,
      createdAt: "2026-11-12T10:05:00Z",
      url: "c",
    };
    expect(
      prStatus(repo, pr([codexReq, running], [])).blockers.some((b: string) =>
        b.startsWith("waiting for the requested review"),
      ),
    ).toBe(true);
  });
});

describe("pr status: required approvals, verify success and review scoping", () => {
  const head = "a".repeat(40);
  const make = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: o.mergeState ?? "CLEAN",
    reviewDecision: o.decision ?? null,
    headRefOid: head,
    requiredChecks: {
      head,
      base: "main",
      expected: [{ context: "verify", appId: null }],
      checks: [{ name: "verify", databaseId: null, appId: null, required: "required" as const }],
      gaps: [],
    },
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "verify",
                    status: "COMPLETED",
                    conclusion: o.verify ?? "SUCCESS",
                    startedAt: time,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: o.reviews ?? [], pageInfo: { hasPreviousPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasPreviousPage: false } },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const marker = (sha: string, at: string) => ({
    author: { login: "chatgpt-codex-connector[bot]" },
    body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"completed","has_unresolved_findings":false}} -->`,
    createdAt: at,
    url: "m",
  });
  it("reports missing approvals, a merge block and a non-successful verify", async () => {
    const { prStatus } = await import("./prstatus.js");
    expect(prStatus(repo, make({ decision: "REVIEW_REQUIRED" })).blockers).toContain(
      "a required approving review is missing",
    );
    expect(prStatus(repo, make({ mergeState: "BLOCKED" })).blockers[0]).toMatch(
      /merging is blocked/,
    );
    expect(prStatus(repo, make({ verify: "SKIPPED" })).blockers[0]).toMatch(
      /Required check verify is SKIPPED/,
    );
  });
  it("blocks a branch whose merge state is outside the registered current states", async () => {
    const { prStatus } = await import("./prstatus.js");
    const behind = prStatus(repo, make({ mergeState: "BEHIND" }));
    expect(behind.blockers).toContain("branch is behind main: update it before merging");
    expect(behind.verdict).toMatch(/^Blocked/);
    expect(prStatus(repo, make({ mergeState: "UNSTABLE" })).blockers).toEqual([]);
  });
  it("reports receipts omitted by the presentation limit in JSON and text", async () => {
    const { prStatus, prStatusText } = await import("./prstatus.js");
    const bot = (i: number) => ({
      author: { login: "codecov[bot]" },
      body: `coverage ${i}`,
      createdAt: `2026-11-12T1${i}:00:00Z`,
      url: `c${i}`,
    });
    const r = prStatus(repo, make({ comments: [1, 2, 3, 4, 5].map(bot) }));
    expect(r.receipts.map((x: { url: string }) => x.url)).toEqual(["c3", "c4", "c5"]);
    expect(r.omittedReceipts).toBe(2);
    expect(prStatusText(r)).toContain("…2 earlier receipt(s) omitted");
    expect(prStatus(repo, make()).omittedReceipts).toBe(0);
  });
  it("does not let a Codex marker answer a CodeRabbit request, and accepts a current formal Codex review", async () => {
    const { prStatus } = await import("./prstatus.js");
    const rabbit = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T11:00:00Z",
      url: "r",
    };
    const r = prStatus(repo, make({ comments: [marker(head, "2026-11-12T10:00:00Z"), rabbit] }));
    expect(r.reviewRequest!.status).toBe("no reaction yet");
    const stale = prStatus(
      repo,
      make({
        comments: [marker("b".repeat(40), "2026-11-12T10:00:00Z")],
        reviews: [
          {
            author: { login: "chatgpt-codex-connector" },
            state: "COMMENTED",
            submittedAt: "2026-11-12T12:00:00Z",
            url: "v",
            commit: { oid: head },
          },
        ],
      }),
    );
    expect(stale.blockers.some((b: string) => /older commit/.test(b))).toBe(false);
  });
});

describe("pr status: bot instructions are not review requests", () => {
  it("keeps the human request answered when the bot reply quotes the request syntax", async () => {
    const { prStatus } = await import("./prstatus.js");
    const head = "a".repeat(40);
    const pr = {
      number: 12,
      title: "Fix",
      url: `https://github.com/${repo}/pull/12`,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: head,
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: time,
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: time,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        ],
      },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: {
        nodes: [
          {
            author: { login: "kavya" },
            body: "@coderabbitai review",
            createdAt: "2026-11-12T10:00:00Z",
            url: "a",
          },
          {
            author: { login: "coderabbitai" },
            body: "Review done. To request another review, use `@coderabbitai review`.",
            createdAt: "2026-11-12T11:00:00Z",
            url: "b",
          },
        ],
        pageInfo: { hasPreviousPage: false },
      },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    const r = prStatus(repo, pr);
    expect(r.reviewRequest!.url).toBe("a");
    expect(r.reviewRequest!.status).toBe("a reviewer has posted since the request");
  });

  it("reconciles a stale Codex running summary when a clean codex-review-receipt covers the head (#647)", async () => {
    const { prStatus } = await import("./prstatus.js");
    const head = "c0d70d5e471bb6d944d1abc5dbd61e0286703cc6";
    const pr = {
      number: 646,
      url: "https://github.com/o/r/pull/646",
      title: "Fix",
      state: "OPEN",
      updatedAt: "2026-11-15T22:07:00Z",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefName: "feat/x",
      headRefOid: head,
      requiredChecks: {
        head,
        base: "main",
        expected: [{ context: "verify", appId: null }],
        gaps: [],
        checks: [{ name: "verify", databaseId: null, appId: null, required: "required" as const }],
      },
      baseRefName: "main",
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: "2026-11-15T22:05:00Z",
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        ],
      },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: {
        nodes: [
          {
            author: { login: "trebizondoculpepper" },
            body: "@codex review",
            createdAt: "2026-11-15T22:05:50Z",
            url: "req",
          },
          {
            author: { __typename: "Bot", login: "chatgpt-codex-connector" },
            body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","status":"running","has_unresolved_findings":null}} -->`,
            createdAt: "2026-11-15T22:06:01Z",
            url: "summary",
          },
          {
            author: { __typename: "Bot", login: "chatgpt-codex-connector" },
            body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${head.slice(0, 10)}\``,
            createdAt: "2026-11-15T22:06:55Z",
            url: "receipt",
          },
        ],
        pageInfo: { hasPreviousPage: false },
      },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    const r = prStatus(repo, pr);
    expect(r.reviewRequest!.status).toBe("current head reviewed (Codex)");
    expect(r.blockers).toEqual([]);
  });
});
