import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { type Query } from "../github/github.js";
import { repo, time } from "../testing/snapshots.js";

describe("pr review history: why does this keep failing review (#60)", () => {
  const sha = (c: string) => c.repeat(40);
  const [c1, c2, c3, c4] = [sha("1"), sha("2"), sha("3"), sha("4")];
  const bot = { login: "chatgpt-codex-connector" };
  const me = { login: "dev" };
  const status = { blockers: [], verdict: "ok", completeness: { complete: true, warnings: [] } };
  let n = 0;
  const thread = (
    commit: string,
    title: string,
    o: { path?: string; resolved?: boolean; outdated?: boolean; reply?: string; by?: any } = {},
  ) => ({
    isResolved: !!o.resolved,
    isOutdated: !!o.outdated,
    path: o.path ?? "src/a.ts",
    line: 3,
    comments: {
      totalCount: o.reply ? 2 : 1,
      nodes: [
        {
          author: o.by ?? bot,
          body: `**<sub><sub>![P2 Badge](https://x)</sub></sub>  ${title}**\n\ndetail`,
          createdAt: `2026-11-1${commit[0]}T10:00:0${n % 10}Z`,
          url: `https://t/${++n}`,
          originalCommit: { oid: commit },
        },
        ...(o.reply
          ? [{ author: me, body: o.reply, createdAt: "2026-11-19T00:00:00Z", url: "https://r" }]
          : []),
      ],
    },
  });
  const review = (commit: string, state = "COMMENTED", by: any = bot) => ({
    author: by,
    state,
    submittedAt: `2026-11-1${commit[0]}T10:00:00Z`,
    url: `https://rv/${commit[0]}`,
    commit: { oid: commit },
  });
  const history = (o: Record<string, any> = {}) => ({
    number: 47,
    url: `https://github.com/${repo}/pull/47`,
    headRefOid: o.head ?? c4,
    author: me,
    commits: {
      nodes: (o.commits ?? [c1, c2, c3, c4]).map((oid: string) => ({
        commit: { oid, messageHeadline: `commit ${oid[0]}` },
      })),
      pageInfo: { hasNextPage: false },
    },
    reviews: { nodes: o.reviews ?? [], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: o.threads ?? [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasNextPage: false } },
  });

  it("matches rounds to commits and classifies a fix/review loop with evidence", async () => {
    const { reviewHistory, reviewHistoryText } = await import("./reviewhistory.js");
    const r = reviewHistory(
      repo,
      history({
        reviews: [review(c1), review(c2), review(c3), review(c4), review(c2, "COMMENTED", me)],
        threads: [
          thread(c1, "Bound the output", { resolved: true, reply: "Fixed in 2222222" }),
          thread(c2, "Bound the output", { resolved: false }),
          thread(c2, "Handle empty input", { path: "src/a.ts", resolved: true }),
          thread(c3, "Escape names", { path: "src/b.ts" }),
          thread(c3, "Escape names", { path: "src/b.ts" }),
        ],
      }),
      status,
    );
    expect(r).toMatchObject({ schemaVersion: 1, kind: "pr-review-history", headReviewed: true });
    expect(r.rounds.map((x) => [x.commit[0], x.findingsRaised])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 2],
      ["4", 0],
    ]);
    // The PR author's own reply review is not a review round.
    expect(r.rounds[1].reviewers.map((v) => v.by)).toEqual(["chatgpt-codex-connector"]);
    const cls = Object.fromEntries(r.findings.map((f) => [`${f.round}:${f.title}`, f.class]));
    expect(cls).toMatchObject({
      "1:Bound the output": "initial",
      "2:Bound the output": "repeated",
      "2:Handle empty input": "same-area-after-fix",
      "3:Escape names": "duplicate",
    });
    expect(r.findings.find((f) => f.round === 1)?.citedFixes).toEqual([c2]);
    expect(r.findings.find((f) => f.class === "repeated")?.related).toEqual(["https://t/1"]);
    expect(r.signal.repeatedCycleCandidate).toBe(true);
    expect(r.signal.roundsWithFindings).toBe(3);
    expect(r.themes[0]).toMatchObject({ path: "src/a.ts", rounds: [1, 2] });
    expect(r.nextActions.map((a) => a.action)).toEqual([
      "continue targeted fixes",
      "broader invariant/design review of the recurring area",
    ]);
    expect(r.completeness.complete).toBe(true);
    const text = reviewHistoryText(r);
    expect(text).toContain("REPEATED-CYCLE CANDIDATE (inspect, not a verdict)");
    expect(text).toContain("[repeated] r2 open");
  });

  it("reports a clean re-review, a stale head, disagreement and missing history honestly", async () => {
    const { reviewHistory } = await import("./reviewhistory.js");
    const marker = (commit: string, unresolved: boolean) => ({
      author: bot,
      createdAt: "2026-11-15T00:00:00Z",
      url: "https://m",
      body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${commit}","has_unresolved_findings":${unresolved},"status":"completed"}} -->`,
    });
    const clean = reviewHistory(
      repo,
      history({
        threads: [thread(c1, "Bug", { resolved: true })],
        reviews: [review(c1)],
        comments: [marker(c4, false)],
      }),
      status,
    );
    expect(clean.rounds.at(-1)).toMatchObject({ current: true, findingsRaised: 0 });
    expect(clean.rounds.at(-1)?.reviewers[0].state).toBe("NO FINDINGS (marker)");
    expect(clean.signal.repeatedCycleCandidate).toBe(false);
    expect(clean.nextActions[0].action).toBe("none suggested by review history");

    const stale = reviewHistory(repo, history({ reviews: [review(c1)] }), status);
    expect(stale.headReviewed).toBe(false);
    expect(stale.nextActions.map((a) => a.action)).toContain(
      "wait for or request review of the current head",
    );

    const split = reviewHistory(
      repo,
      history({
        reviews: [
          review(c4, "APPROVED", { login: "alice" }),
          review(c4, "CHANGES_REQUESTED", { login: "bob" }),
        ],
      }),
      status,
    );
    expect(split.disagreements).toEqual([
      { commit: c4, states: { alice: "APPROVED", bob: "CHANGES_REQUESTED" } },
    ]);

    const empty = reviewHistory(repo, history(), status);
    expect(empty.rounds).toEqual([]);
    expect(empty.uncertainty.join(" ")).toContain("history is missing, not clean");

    const rewritten = reviewHistory(
      repo,
      history({ reviews: [review(sha("9"))], threads: [thread(sha("9"), "Old")] }),
      status,
    );
    expect(rewritten.completeness.complete).toBe(false);
    expect(rewritten.completeness.warnings[0]).toContain("not among the PR's current commits");
  });

  it("bounds output and reports truncation", async () => {
    const { reviewHistory, historyLimits } = await import("./reviewhistory.js");
    const many = Array.from({ length: 15 }, (_, i) => thread(c1, `Finding ${i}`));
    const r = reviewHistory(
      repo,
      {
        ...history({ threads: many, reviews: [review(c1)] }),
        comments: { nodes: [], pageInfo: { hasNextPage: true } },
      },
      status,
    );
    expect(r.findings).toHaveLength(historyLimits.findings);
    expect(r.omittedFindings).toBe(5);
    expect(r.completeness.warnings).toContain(
      "more than 100 comments; later review markers not read",
    );
  });

  it("never counts an unsubmitted (PENDING) review as coverage of the head", async () => {
    const { reviewHistory } = await import("./reviewhistory.js");
    const draft = { ...review(c4, "PENDING", { login: "alice" }), submittedAt: null };
    const r = reviewHistory(repo, history({ reviews: [review(c1), draft] }), status);
    expect(r.headReviewed).toBe(false);
    expect(r.rounds.map((x) => x.commit)).toEqual([c1]);
    const unsubmitted = reviewHistory(
      repo,
      history({ reviews: [{ ...review(c4), submittedAt: null }] }),
      status,
    );
    expect(unsubmitted.headReviewed).toBe(false);
  });

  it("does not claim a recurrence order that only current resolution suggests", async () => {
    const { reviewHistory, reviewHistoryText } = await import("./reviewhistory.js");
    const r = reviewHistory(
      repo,
      history({
        reviews: [review(c1), review(c2), review(c3), review(c4)],
        threads: [
          thread(c1, "Bound the output", { resolved: true }),
          thread(c2, "Bound the output"),
          thread(c2, "Handle empty input", { path: "src/a.ts" }),
          thread(c3, "Check paths", { path: "src/a.ts" }),
        ],
      }),
      status,
    );
    expect(r.findings.filter((f) => f.round! > 1).map((f) => f.class)).toEqual([
      "recurrence-unordered",
      "recurrence-unordered",
      "recurrence-unordered",
    ]);
    expect(r.counts.repeated).toBe(0);
    expect(r.counts["same-area-after-fix"]).toBe(0);
    expect(r.signal.reasons.join(" ")).not.toMatch(/after resolution|already fixed/);
    expect(r.uncertainty.join(" ")).toContain("resolution order is unestablished");
    expect(reviewHistoryText(r)).toContain("recurrence-unordered 3");
    // A fix cited after the later finding's commit does not establish order either.
    const late = reviewHistory(
      repo,
      history({
        threads: [
          thread(c1, "Bound the output", { resolved: true, reply: "Fixed in 3333333" }),
          thread(c2, "Bound the output"),
        ],
      }),
      status,
    );
    expect(late.findings.find((f) => f.round === 2)?.class).toBe("recurrence-unordered");
  });

  it("retries once, then refuses to combine status and history for different heads", async () => {
    const { pullRequestReviewHistory } = await import("./reviewhistory.js");
    const live = (heads: string[]) => {
      const calls: string[] = [];
      let i = 0;
      const query = (async (q: string) => {
        calls.push(q);
        const head = heads[Math.min(i++, heads.length - 1)];
        return q.includes("statusCheckRollup")
          ? {
              repository: {
                pullRequest: {
                  ...history({ head }),
                  title: "x",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  headRefName: "b",
                  baseRefName: "main",
                  updatedAt: time,
                  commits: { nodes: [] },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                  closingIssuesReferences: { nodes: [] },
                },
              },
            }
          : { repository: { pullRequest: history({ head, reviews: [review(head)] }) } };
      }) as Query;
      return { calls, query };
    };
    const raced = live([c3, c4, c4, c4]);
    const ok = await pullRequestReviewHistory(repo, 47, raced.query);
    expect(raced.calls).toHaveLength(4);
    expect(ok.cost.requests).toBe(4);
    expect(ok.completeness.warnings.join(" ")).not.toContain("head changed");

    const moving = live([c2, c3, c3, c4]);
    const bad = await pullRequestReviewHistory(repo, 47, moving.query);
    expect(moving.calls).toHaveLength(4);
    expect(bad.completeness.complete).toBe(false);
    expect(bad.completeness.warnings.join(" ")).toContain(
      "head changed between the status and history queries",
    );
    expect(bad.current.verdict).toContain("inconsistent snapshot");
    expect(bad.current.blockers.join(" ")).toContain("head moved during collection");
  });

  it("runs pr N --history through the injected query", async () => {
    let text = "";
    const calls: string[] = [];
    const runtime = {
      collect: async () => {
        throw new Error("no briefing");
      },
      currentRepository: async () => repo,
      query: (async (q: string) => {
        calls.push(q);
        return q.includes("statusCheckRollup")
          ? {
              repository: {
                pullRequest: {
                  ...history(),
                  title: "x",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  headRefName: "b",
                  baseRefName: "main",
                  updatedAt: time,
                  commits: { nodes: [] },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                  closingIssuesReferences: { nodes: [] },
                },
              },
            }
          : { repository: { pullRequest: history({ reviews: [review(c4)] }) } };
      }) as Query,
    };
    expect(
      await main(["pr", "47", "--history", "--json"], async (t) => void (text = t), runtime),
    ).toBe(2);
    expect(calls).toHaveLength(2);
    const r = JSON.parse(text);
    expect(r).toMatchObject({ kind: "pr-review-history", cost: { requests: 2 } });
    expect(r.current.blockers.join(" ")).toContain("Required-check evidence unknown");
    expect(r.nextCommands[1]).toBe(`pdb pr 47 --repo ${repo} --history --json`);
  });
});
