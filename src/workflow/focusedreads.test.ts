/**
 * Focused reads (#367, doc/design/collection-profiles.md "Command read plans"): each read
 * reports its profile, per-source coverage and cost; `--issue N` keeps the full compatibility
 * profile. Fixtures inject many closed PRs with few open, long comment histories, linked PRs
 * and incomplete evidence. No test touches GitHub.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { collect } from "../github/github.js";
import type { JsonObject, Query } from "../github/github.js";
import { dependencyReport, RateLimitError } from "../github/dependencies.js";
import type { Comment, Issue, Page, PullRequest } from "../github/types.js";
import { issue as baseIssue, pr as basePr, repo, time } from "../testing/snapshots.js";
import { readPullRequest } from "./readservices.js";

const clock = () => new Date(time);
const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`;
const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
const note = (owner: string, n: number, body: string, i: number): Comment => ({
  databaseId: n * 1000 + i,
  body,
  url: `${owner}#issuecomment-${n * 1000 + i}`,
  author: { __typename: "User", login: "shared" },
  createdAt: new Date(Date.parse(time) - (500 - i) * 60_000).toISOString(),
  updatedAt: new Date(Date.parse(time) - (500 - i) * 60_000).toISOString(),
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});

/** A small repository: long histories, many closed PRs, few open ones, one foreign link. */
interface World {
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  /** PR numbers linked to an issue from the issue side, including closed and foreign ones. */
  links: Map<number, { number: number; url: string; state: string }[]>;
  /** Page size the fake uses for comment and link connections (GitHub's is larger). */
  pageSize: number;
  failPr?: Set<number>;
  rateLimitPr?: Set<number>;
}
function world(): World {
  const issues = new Map<number, Issue>();
  const prs = new Map<number, PullRequest>();
  const one: Issue = {
    ...baseIssue(1, ["status:in-progress", "agent:ana"]),
    comments: page(
      Array.from({ length: 7 }, (_, i) =>
        note(issueUrl(1), 1, i === 6 ? "I'm working on this" : `discussion ${i}`, i),
      ),
    ),
  };
  issues.set(1, one);
  issues.set(2, baseIssue(2, ["status:ready"]));
  // Two open PRs closing #1, one of them with a long comment history.
  for (const n of [10, 11]) {
    const p = basePr();
    prs.set(n, {
      ...p,
      number: n,
      title: `PR ${n}`,
      url: prUrl(n),
      closingIssuesReferences: page([{ number: 1, url: issueUrl(1) }]),
      comments: page(
        Array.from({ length: n === 10 ? 5 : 1 }, (_, i) =>
          note(prUrl(n), n, i === 0 ? "ready for review" : `review chatter ${i}`, i),
        ),
      ),
    });
  }
  const links = new Map([
    [
      1,
      [
        { number: 10, url: prUrl(10), state: "OPEN" },
        { number: 11, url: prUrl(11), state: "OPEN" },
        // A PR in another repository closing this issue: not in this repository's inventory.
        { number: 5, url: "https://github.com/other/fork/pull/5", state: "OPEN" },
      ],
    ],
  ]);
  return { issues, prs, links, pageSize: 2 };
}
function page<T>(nodes: T[], more = false, cursor: string | null = null): Page<T> {
  return { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } };
}
/** The first page of a connection, and the page after `cursor` ("p<offset>"). */
function slice<T>(all: T[], size: number, cursor?: unknown): Page<T> {
  const from = typeof cursor === "string" ? Number(cursor.slice(1)) : 0;
  const to = from + size;
  return page(all.slice(from, to), to < all.length, to < all.length ? `p${to}` : null);
}

/** One fake GraphQL boundary answering both the full snapshot and the focused profile. */
function fake(w: World) {
  const log: string[] = [];
  const closedPrs = 400; // Many closed PRs: never read by a focused or open-only read.
  const asIssue = (i: Issue): Issue => ({
    ...i,
    comments: slice(i.comments.nodes, w.pageSize),
    closedByPullRequestsReferences: slice(w.links.get(i.number) ?? [], w.pageSize),
  });
  const asPr = (p: PullRequest): PullRequest => ({
    ...p,
    comments: slice(p.comments.nodes, w.pageSize),
  });
  const query: Query = async (source, variables) => {
    log.push(source);
    const n = Number(variables.number);
    const rate = source.includes("pdbReadRate")
      ? { pdbReadRate: { cost: 1, remaining: 4000, resetAt: "2026-11-12T11:00:00Z" } }
      : {};
    const answer = (repository: JsonObject): JsonObject => ({ repository, ...rate });
    if (source.includes("issues(first:50"))
      return answer({ issues: page([...w.issues.values()].map(asIssue)) });
    if (source.includes("pullRequests(first:50"))
      return answer({ pullRequests: page([...w.prs.values()].map(asPr)) });
    if (source.includes("issueOrPullRequest")) {
      const item = w.issues.get(n) ?? w.prs.get(n);
      return answer({
        issueOrPullRequest: { comments: slice(item!.comments.nodes, w.pageSize, variables.cursor) },
      });
    }
    if (source.includes("closedByPullRequestsReferences(first") && variables.cursor)
      return answer({
        issue: {
          closedByPullRequestsReferences: slice(w.links.get(n) ?? [], w.pageSize, variables.cursor),
        },
      });
    if (source.includes("pullRequest(number")) {
      if (w.rateLimitPr?.has(n)) throw new RateLimitError("API rate limit exceeded");
      if (w.failPr?.has(n)) throw new Error("GitHub query failed.");
      const p = w.prs.get(n);
      return answer({ pullRequest: p ? asPr(p) : null });
    }
    if (source.includes("issue(number")) {
      const i = w.issues.get(n);
      return answer({ issue: i ? asIssue(i) : null });
    }
    throw new Error(`unexpected query ${source.slice(0, 80)} (closed PRs: ${closedPrs})`);
  };
  return { query, log };
}

describe("deps N and pr N report their profile, coverage and cost (#367)", () => {
  it("deps N reads one issue and says discussion was not requested", async () => {
    const log: string[] = [];
    const query: Query = async (source) => {
      log.push(source);
      return {
        repository: { issue: { ...baseIssue(7), body: "Depends on #3" } },
        pdbReadRate: { cost: 1, remaining: 10, resetAt: "2026-11-12T11:00:00Z" },
      };
    };
    const report = await dependencyReport(repo, 7, {}, query, clock);
    expect(log).toHaveLength(1);
    expect(report.collection).toMatchObject({
      profile: "issue-detail-v1",
      operation: "deps",
      telemetry: { requests: 1, cost: 1 },
    });
    const by = Object.fromEntries(report.collection!.coverage.map((c) => [c.source, c.state]));
    expect(by).toEqual({
      issue: "complete",
      labels: "complete",
      "native-blocked-by": "complete",
      "native-blocking": "complete",
      comments: "not-requested",
      "linked-pull-requests": "not-requested",
    });
    // Unchanged report fields.
    expect(report.nodes[0].drift.map((d) => d.number)).toEqual([3]);
  });

  it("pr N marks truncated connections partial and unknown cost as null", async () => {
    const node = {
      number: 9,
      title: "PR",
      url: prUrl(9),
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: "abc",
      headRefName: "f",
      baseRefName: "main",
      updatedAt: time,
      commits: {
        nodes: [{ commit: { oid: "abc", committedDate: time, statusCheckRollup: null } }],
      },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: true } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: [], pageInfo: { hasPreviousPage: true } },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    const query: Query = async () => ({ repository: { pullRequest: node } });
    const read = await readPullRequest(repo, 9, query, {}, clock);
    const by = Object.fromEntries(read.report.collection.coverage.map((c) => [c.source, c.state]));
    expect(by).toMatchObject({
      "pull-request": "complete",
      reviews: "partial",
      comments: "partial",
      "review-threads": "complete",
      "delivery-records": "not-requested",
    });
    expect(read.report.collection.telemetry).toMatchObject({ requests: 1, cost: null });
    // The existing completeness verdict is unchanged: truncation already made it incomplete.
    expect(read.complete).toBe(false);
  });
});

describe("--issue N keeps the full compatibility profile (#367)", () => {
  it("reads the open inventory and reports it as compatibility-full-v1", async () => {
    const { query, log } = fake(world());
    let out = "";
    await main(
      ["--issue", "1", "--json", "--repo", repo, "--no-update-check"],
      async (t) => void (out = t),
      {
        collect: (r, o) => collect(r, o, query, clock),
        currentRepository: async () => repo,
        now: clock,
        updateCheck: async () => ({ status: "disabled" }) as never,
      },
    );
    expect(log.some((s) => s.includes("pullRequests(first:50"))).toBe(true);
    const report = JSON.parse(out);
    expect(report.collection).toMatchObject({
      profile: "compatibility-full-v1",
      operation: "issue-intake",
    });
    expect(report.collection.coverage.map((c: { source: string }) => c.source)).toEqual([
      "open-issues",
      "open-pull-requests",
      "issue",
    ]);
    expect(report.collection.telemetry.cost).toBe(log.length);
  });
});
