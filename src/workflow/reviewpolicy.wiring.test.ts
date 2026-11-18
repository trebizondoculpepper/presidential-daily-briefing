/**
 * Declared review policy across surfaces (#301): configuration, `pr N`, both briefing engines and
 * delivery follow-up agree. Injected config, provider and GitHub facts; no network.
 */
import { describe, expect, it } from "vite-plus/test";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { resolveReviewPolicy } from "../config/review-setting.js";
import { prStatus, prStatusText } from "./prstatus.js";
import { evaluateDatalog } from "../rules/datalog/datalog.js";
import { briefing } from "../briefing/briefing.js";
import { snapshotFollowUpFacts, classifyFollowUp } from "./deliveryread.js";
import { datalogReviewFacts } from "./reviewpolicy.js";
import type { DeclaredReviewPolicy } from "./reviewpolicy.js";
import type { Page, PullRequest, Snapshot } from "../github/types.js";

const repository = "example/project";
const head = "a".repeat(40);
const old = "b".repeat(40);
const or: DeclaredReviewPolicy = { state: "declared", policy: "codex-or-coderabbit" };
const unknown: DeclaredReviewPolicy = { state: "unknown", reason: "config unreadable" };
const bot = (login: string) => ({ __typename: "Bot", login });
const user = (login: string) => ({ __typename: "User", login });
const marker = (sha: string, status = "completed", findings = false) =>
  `summary <!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_unresolved_findings":${findings},"status":"${status}"}} -->`;

describe("review.policy configuration", () => {
  const local = (raw: string | null, repo = repository) => ({
    cwd: SYNTHETIC_ROOT,
    git: fakeGit(repo),
    fs: {
      ...emptyFileSystem,
      readText: async (path: string) => (path.endsWith("triage.toml") ? raw : null),
    },
  });
  it("reads a declared policy, explicit legacy and absence distinctly", async () => {
    expect(
      await resolveReviewPolicy(
        repository,
        local('schemaVersion = 1\n[review]\npolicy = "codex-or-coderabbit"\n'),
      ),
    ).toEqual(or);
    expect(
      await resolveReviewPolicy(
        repository,
        local('schemaVersion = 1\n[review]\npolicy = "legacy"\n'),
      ),
    ).toEqual({ state: "declared", policy: "legacy" });
    expect(await resolveReviewPolicy(repository, local(null))).toEqual({
      state: "undeclared",
      scope: "repository-config",
    });
    expect(await resolveReviewPolicy(repository)).toEqual({
      state: "undeclared",
      scope: "not-read",
    });
  });
  it("an invalid or unreadable setting is unknown, never a guess", async () => {
    const invalid = await resolveReviewPolicy(
      repository,
      local('schemaVersion = 1\n[review]\npolicy = "anything-goes"\n'),
    );
    expect(invalid.state).toBe("unknown");
    const unreadable = await resolveReviewPolicy(repository, {
      ...local(null),
      fs: {
        ...emptyFileSystem,
        readText: async () => {
          throw new Error("EACCES");
        },
      },
    });
    expect(unreadable.state).toBe("unknown");
  });
  it("another repository's checkout is never consulted", async () => {
    expect(
      await resolveReviewPolicy(
        repository,
        local('schemaVersion = 1\n[review]\npolicy = "codex-or-coderabbit"\n', "other/repo"),
      ),
    ).toEqual({ state: "undeclared", scope: "no-matching-project" });
  });
});

describe("pr N under the declared policy", () => {
  const checkRun = (name: string, extra: Record<string, unknown> = {}) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: `https://ci/${name}`,
    startedAt: "2026-11-15T00:00:00Z",
    ...extra,
  });
  const node = (
    o: { comments?: unknown[]; reviews?: unknown[]; checks?: { name: string }[] } = {},
  ) =>
    ({
      number: 12,
      title: "Fix",
      url: `https://github.com/${repository}/pull/12`,
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
        expected: [{ context: "verify", appId: null }],
        checks: (o.checks ?? [checkRun("verify")]).map((check: { name: string }) => ({
          name: check.name,
          databaseId: null,
          appId: null,
          required: check.name === "verify" ? "required" : "advisory",
        })),
        gaps: [],
      },
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: "2026-11-15T00:00:00Z",
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: o.checks ?? [checkRun("verify")],
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
    }) as unknown as Parameters<typeof prStatus>[1];
  const codex = (
    sha: string,
    status = "completed",
    findings = false,
    author = bot("chatgpt-codex-connector"),
  ) => ({
    author,
    createdAt: "2026-11-15T01:00:00Z",
    url: `https://c/codex-${status}-${findings}`,
    body: marker(sha, status, findings),
  });
  const rabbit = (state: string, commit = head) => ({
    author: bot("coderabbitai"),
    state,
    submittedAt: "2026-11-15T02:00:00Z",
    url: `https://r/${state}`,
    commit: { oid: commit },
  });

  it("CodeRabbit current approval satisfies coverage; a stale Codex review is detail, not a blocker", () => {
    const pr = node({ comments: [codex(old)], reviews: [rabbit("APPROVED")] });
    const legacy = prStatus(repository, pr);
    expect(legacy.blockers).toContain(
      "Codex's latest review is for an older commit; current head not yet covered",
    );
    const r = prStatus(repository, pr, { reviewPolicy: or });
    expect(r.blockers).toEqual([]);
    expect(r.headReviewed).toBe(true);
    expect(r.reviewPolicy).toMatchObject({
      schemaVersion: 1,
      effective: "codex-or-coderabbit",
      coverage: "satisfied",
      satisfiedBy: [{ provider: "coderabbit", head, source: "https://r/APPROVED" }],
    });
    expect(prStatusText(r)).toContain(
      "Review policy codex-or-coderabbit: coverage satisfied by CodeRabbit https://r/APPROVED (Codex stale, CodeRabbit accepted)",
    );
  });

  it("Codex alone satisfies coverage while CodeRabbit is quota-skipped or still running", () => {
    for (const rabbitCheck of [
      checkRun("CodeRabbit", {
        conclusion: "NEUTRAL",
        checkSuite: { app: { slug: "coderabbitai" } },
      }),
      checkRun("CodeRabbit", {
        status: "IN_PROGRESS",
        conclusion: null,
        checkSuite: { app: { slug: "coderabbitai" } },
      }),
    ]) {
      const r = prStatus(
        repository,
        node({ comments: [codex(head)], checks: [checkRun("verify"), rabbitCheck] }),
        { reviewPolicy: or },
      );
      expect(r.headReviewed).toBe(true);
      expect(r.reviewPolicy.providers[1].state).toMatch(/skipped|pending/);
      // The still-running provider check is an ordinary pending check, never hidden.
      expect(r.blockers).toEqual([]);
      if (rabbitCheck.status === "IN_PROGRESS") expect(r.checks.counts["advisory-pending"]).toBe(1);
    }
  });

  it("an outstanding request to the other provider does not block satisfied coverage", () => {
    const request = {
      author: user("maintainer"),
      createdAt: "2026-11-15T03:00:00Z",
      url: "https://c/req",
      body: "@coderabbitai review",
    };
    const r = prStatus(repository, node({ comments: [codex(head), request] }), {
      reviewPolicy: or,
    });
    expect(r.blockers).toEqual([]);
    expect(prStatus(repository, node({ comments: [codex(head), request] })).blockers).toContain(
      "a review was requested and has had no reaction",
    );
  });

  it("a finding from either provider blocks despite the other's acceptance", () => {
    const rabbitFinding = prStatus(
      repository,
      node({ comments: [codex(head)], reviews: [rabbit("CHANGES_REQUESTED")] }),
      { reviewPolicy: or },
    );
    expect(rabbitFinding.headReviewed).toBe(false);
    expect(rabbitFinding.headFindings).toBe(true);
    expect(rabbitFinding.blockers).toContain(
      "CodeRabbit reports unresolved findings on the current head https://r/CHANGES_REQUESTED",
    );
    const codexFinding = prStatus(
      repository,
      node({ comments: [codex(head, "completed", true)], reviews: [rabbit("APPROVED")] }),
      { reviewPolicy: or },
    );
    expect(codexFinding.blockers).toEqual([
      "Codex reports unresolved findings on the current head https://c/codex-completed-true",
    ]);
  });

  it("an unauthenticated Codex findings marker neither vetoes nor blocks declared coverage", () => {
    const spoof = codex(head, "completed", true, user("chatgpt-codex-connector"));
    const r = prStatus(repository, node({ comments: [spoof], reviews: [rabbit("APPROVED")] }), {
      reviewPolicy: or,
    });
    expect(r.headFindings).toBe(false);
    expect(r.headReviewed).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.reviewPolicy.unknowns.join()).toMatch(/ignored a Codex review-state marker/);
    // Legacy keeps the login-only rule.
    expect(prStatus(repository, node({ comments: [spoof] })).headFindings).toBe(true);
  });

  it("neither provider, spoofed receipts and a changed head leave coverage unsatisfied", () => {
    const spoof = codex(head, "completed", false, user("chatgpt-codex-connector"));
    for (const pr of [
      node(),
      node({ comments: [spoof] }),
      node({ comments: [codex(old)], reviews: [rabbit("APPROVED", old)] }),
    ]) {
      const r = prStatus(repository, pr, { reviewPolicy: or });
      expect(r.headReviewed).toBe(false);
      expect(r.blockers.join("\n")).toMatch(
        /review policy codex-or-coderabbit: no configured provider has accepted the current head yet/,
      );
    }
    expect(
      prStatus(repository, node({ comments: [spoof] }), {
        reviewPolicy: or,
      }).reviewPolicy.unknowns.join(),
    ).toMatch(/ignored a Codex review-state marker/);
  });

  it("CI and merge protections stay independent of satisfied coverage", () => {
    const r = prStatus(
      repository,
      node({ comments: [codex(head)], checks: [checkRun("verify", { conclusion: "FAILURE" })] }),
      { reviewPolicy: or },
    );
    expect(r.headReviewed).toBe(true);
    expect(r.blockers.join("\n")).toMatch(/Required check verify is FAILURE/);
  });

  it("a live pr N read requests author types and app slugs, so providers authenticate", async () => {
    const { pullRequestStatus } = await import("./prstatus.js");
    // GitHub returns only what the query selects.
    const query = async (source: string) => {
      const typed = (field: string, login: string) =>
        source.includes(`${field}{nodes{author{__typename login}`) ? bot(login) : { login };
      const pr = node({
        reviews: [{ ...rabbit("APPROVED"), author: typed("reviews(last:50)", "coderabbitai") }],
        comments: [
          { ...codex(old), author: typed("comments(last:100)", "chatgpt-codex-connector") },
        ],
        checks: [
          checkRun("verify"),
          checkRun("Codex", {
            conclusion: "NEUTRAL",
            ...(source.includes("checkSuite{app{slug databaseId}}")
              ? { checkSuite: { app: { slug: "chatgpt-codex-connector" } } }
              : {}),
          }),
        ],
      });
      return { repository: { pullRequest: pr } };
    };
    const r = await pullRequestStatus(repository, 12, query as never, undefined, undefined, or);
    expect(r.reviewPolicy.providers.map((o) => o.state)).toEqual(["skipped", "accepted"]);
    expect(r.headReviewed).toBe(true);
  });

  it("an unresolved thread opened by a provider blocks declared coverage in pr N", () => {
    const base = node({ comments: [codex(head)] }) as unknown as Record<string, unknown>;
    const r = prStatus(
      repository,
      {
        ...base,
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              first: {
                totalCount: 1,
                nodes: [
                  { author: bot("coderabbitai"), body: "bug", createdAt: null, url: "https://t/1" },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      } as never,
      { reviewPolicy: or },
    );
    expect(r.headFindings).toBe(true);
    expect(r.headReviewed).toBe(false);
    expect(r.blockers).toContain(
      "CodeRabbit reports unresolved findings on the current head https://t/1",
    );
  });

  it("an unknown policy is explicit and accepts nothing", () => {
    const r = prStatus(repository, node({ comments: [codex(head)] }), { reviewPolicy: unknown });
    expect(r.headReviewed).toBe(false);
    expect(r.reviewPolicy.coverage).toBe("unknown");
    expect(r.blockers).toContain(
      "review policy unknown (config unreadable): review coverage cannot be established",
    );
  });

  it("absent policy keeps the legacy report and says it is undeclared", () => {
    const r = prStatus(
      repository,
      node({ reviews: [{ ...rabbit("APPROVED"), author: user("human") }] }),
    );
    expect(r.headReviewed).toBe(true);
    expect(r.reviewPolicy.declared).toEqual({ state: "undeclared", scope: "not-read" });
    expect(prStatusText(r)).toContain("Review policy undeclared (legacy; not-read)");
  });
});

describe("briefing engines and delivery follow-up agree under the declared policy", () => {
  const page = <T>(nodes: T[] = []): Page<T> => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const pull = (
    reviews: PullRequest["reviews"]["nodes"],
    comments: PullRequest["comments"]["nodes"] = [],
  ): PullRequest => ({
    number: 2,
    title: "Fix",
    body: "",
    url: `https://github.com/${repository}/pull/2`,
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: page(),
    comments: page(comments),
    headRefOid: head,
    requiredChecks: {
      head,
      base: "main",
      expected: [{ context: "verify", appId: null }],
      checks: [{ name: "verify", databaseId: null, appId: null, required: "required" }],
      gaps: [],
    },
    headRefName: "fix",
    baseRefName: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
    reviewDecision: null,
    closingIssuesReferences: page(),
    reviewThreads: page(),
    reviews: page(reviews),
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: page([{ name: "verify", conclusion: "SUCCESS" }]),
            },
          },
        },
      ],
    },
  });
  const snap = (pr: PullRequest, reviewPolicy?: DeclaredReviewPolicy): Snapshot => ({
    schemaVersion: 1,
    repository,
    startedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    issues: [],
    pullRequests: [pr],
    dependencies: [],
    changed: [],
    since: null,
    warnings: [],
    rateLimit: null,
    ...(reviewPolicy ? { reviewPolicy } : {}),
  });
  const review = (
    author: { __typename: string; login: string },
    state = "APPROVED",
    oid = head,
  ) => ({
    body: "",
    url: `https://r/${author.login}-${state}`,
    author,
    state,
    submittedAt: "2026-01-02T00:00:00Z",
    commit: { oid },
  });
  const outcomes = (s: Snapshot) => {
    const datalog = evaluateDatalog(s, new Map(), {
      role: "implementer",
      limit: 50,
      ...datalogReviewFacts(s),
    }).items.some((a) => a.ruleIds.includes("D-PR-INTEGRATE"));
    const typescript = briefing(s, { limit: 50 }).actions.items.some(
      (a) => a.rule === "pr-integrate",
    );
    const [, why] = classifyFollowUp(
      snapshotFollowUpFacts(s.pullRequests[0], s.warnings, s.reviewPolicy),
    );
    return { datalog, typescript, delivery: why.startsWith("accepted") };
  };
  const all = (v: boolean) => ({ datalog: v, typescript: v, delivery: v });

  it("legacy accepts a human approval; the declared policy needs a provider", () => {
    const human = pull([review(user("maintainer"))]);
    expect(outcomes(snap(human))).toEqual(all(true));
    expect(outcomes(snap(human, or))).toEqual(all(false));
  });
  it("either provider accepts; a stale Codex receipt does not matter", () => {
    expect(
      outcomes(
        snap(
          pull(
            [review(bot("coderabbitai"))],
            [{ body: marker(old), url: "c", author: bot("chatgpt-codex-connector") }],
          ),
          or,
        ),
      ),
    ).toEqual(all(true));
    expect(
      outcomes(
        snap(
          pull([], [{ body: marker(head), url: "c", author: bot("chatgpt-codex-connector") }]),
          or,
        ),
      ),
    ).toEqual(all(true));
  });
  it("a cross-provider finding and an unknown policy accept nothing", () => {
    const vetoed = pull(
      [review(bot("coderabbitai"), "CHANGES_REQUESTED")],
      [{ body: marker(head), url: "c", author: bot("chatgpt-codex-connector") }],
    );
    expect(outcomes(snap(vetoed, or))).toEqual(all(false));
    const clean = pull([review(bot("coderabbitai"))]);
    expect(outcomes(snap(clean, unknown))).toEqual(all(false));
  });
});
