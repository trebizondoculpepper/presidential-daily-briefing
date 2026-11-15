/**
 * Focused reads (#367, doc/design/collection-profiles.md "Command read plans"): `who N`, `deps N`
 * and `pr N` read only the target and its direct links; `--issue N` keeps the full
 * compatibility profile. Fixtures inject many closed PRs with few open, long comment histories,
 * linked PRs, permission lookups and incomplete evidence. No test touches GitHub.
 */
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { collect, collectIssueFocus } from "../github/github.js";
import type { JsonObject, Query, Rest } from "../github/github.js";
import { dependencyReport } from "../github/dependencies.js";
import { RateLimitError } from "../github/dependencies.js";
import type { Comment, Issue, Page, PullRequest } from "../github/types.js";
import { issue as baseIssue, pr as basePr, repo, time } from "../testing/snapshots.js";
import { readPullRequest, readWho, readWhoLive } from "./readservices.js";
import { presentBriefing } from "../briefing/service.js";
import { deliveryMarker, markerTrust } from "./delivery.js";
import type { ReadCollection } from "../github/readplan.js";
import type { DeliveryRecord } from "./delivery.js";
import { permissionLookup } from "../github/github.js";
import { ReadMeter } from "../github/readplan.js";

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
const options = { staleHours: 48, now: clock() };
const strip = <T extends { collection?: unknown }>(r: T) => {
  const { collection: _collection, ...rest } = r;
  return rest;
};

describe("who N reads only the ticket and its linked open PRs (#367)", () => {
  it("never reads the repository inventory", async () => {
    const w = world();
    const { query, log } = fake(w);
    const read = await readWhoLive(repo, 1, options, {}, query, clock);
    expect(log.some((s) => s.includes("issues(first:50") || s.includes("pullRequests("))).toBe(
      false,
    );
    // 1 issue + 3 more issue comment pages + 1 link continuation + 2 PRs + 2 more PR #10 pages.
    expect(read.report.collection.telemetry.graphqlRequests).toBe(log.length);
    expect(log.length).toBe(9);
    expect(read.report.collection).toMatchObject({ profile: "issue-detail-v1", operation: "who" });
  });

  it("matches the full-snapshot answer when all relevant facts are known", async () => {
    const w = world();
    const { query } = fake(w);
    const focused = await readWhoLive(repo, 1, options, {}, query, clock);
    const full = await readWho(
      await collect(repo, { issue: 1 }, query, clock),
      1,
      {
        ...options,
        offline: false,
      },
      {},
    );
    expect(strip(focused.report)).toEqual(full.report);
    expect(focused.text).toBe(full.text);
    // The long histories were read completely on both paths.
    expect(focused.report.commentEvidence.map((e) => e.kind)).toEqual([
      "handoff",
      "handoff",
      "reported-work",
    ]);
    expect(focused.report.pullRequests.map((p) => p.number)).toEqual([10, 11]);
  });

  it("records per-source coverage, cost and bytes", async () => {
    const { query } = fake(world());
    const { collection } = (await readWhoLive(repo, 1, options, {}, query, clock)).report;
    const state = (source: string, subject = `${repo}#1`) =>
      collection.coverage.find((c) => c.source === source && c.subject === subject)?.state;
    expect(state("issue")).toBe("complete");
    expect(state("comments")).toBe("complete");
    expect(state("linked-pull-requests")).toBe("complete");
    expect(state("pull-request", `${repo}#10`)).toBe("complete");
    expect(state("native-blocked-by")).toBe("not-requested");
    // No delivery boundary: delivery and permissions were not read, so they are not known.
    expect(state("delivery-records")).toBe("not-requested");
    expect(state("permissions")).toBe("not-requested");
    expect(collection.telemetry.cost).toBe(collection.telemetry.graphqlRequests);
    expect(collection.telemetry.bytes).toBeGreaterThan(0);
    // The foreign PR is outside this repository's inventory and is never hydrated.
    expect(collection.coverage.some((c) => c.subject.includes("other/fork"))).toBe(false);
  });

  it("an unread linked-PR continuation is partial and incomplete, never no PR", async () => {
    const w = world();
    w.links.set(
      1,
      Array.from({ length: 30 }, (_, i) => ({
        number: 100 + i,
        url: prUrl(100 + i),
        state: "CLOSED",
      })),
    );
    const { query } = fake(w);
    const read = await readWhoLive(repo, 1, options, {}, query, clock);
    expect(
      read.report.collection.coverage.find((c) => c.source === "linked-pull-requests"),
    ).toMatchObject({ state: "partial", omission: expect.stringContaining("not read") });
    expect(read.complete).toBe(false);
    expect(read.report.completeness.warnings.join(" ")).toMatch(/linked pull requests beyond/);
    expect(read.report.pullRequests).toEqual([]);
  });

  it("a failed or rate-limited linked PR is unknown evidence, not an absent PR", async () => {
    const w = world();
    w.links.set(
      1,
      [10, 11, 12, 13].map((n) => ({ number: n, url: prUrl(n), state: "OPEN" })),
    );
    for (const n of [12, 13]) w.prs.set(n, { ...w.prs.get(11)!, number: n, url: prUrl(n) });
    w.failPr = new Set([10]);
    w.rateLimitPr = new Set([11]);
    w.pageSize = 10;
    const { query } = fake(w);
    const read = await readWhoLive(repo, 1, options, {}, query, clock);
    const states = read.report.collection.coverage
      .filter((c) => c.source === "pull-request")
      .map((c) => [c.subject, c.state]);
    expect(states).toContainEqual([`${repo}#10`, "failed"]);
    expect(states).toContainEqual([`${repo}#11`, "failed"]);
    expect(read.complete).toBe(false);
    expect(read.report.completeness.warnings.join(" ")).toMatch(/rate limited/);
    // Nothing was scheduled after the quota refusal; started ones were kept.
    const notAttempted = read.report.collection.notAttempted;
    expect(notAttempted.length + read.report.pullRequests.length).toBe(2);
  });

  it("incomplete labels make ownership unknown on the focused path too", async () => {
    const w = world();
    const one = w.issues.get(1)!;
    w.issues.set(1, {
      ...one,
      labels: { ...one.labels, pageInfo: { hasNextPage: true, endCursor: "x" } },
    });
    const { query } = fake(w);
    const read = await readWhoLive(repo, 1, options, {}, query, clock);
    expect(read.report.recordedOwners).toBeNull();
    expect(read.report.collection.coverage.find((c) => c.source === "labels")?.state).toBe(
      "partial",
    );
  });

  it("meters permission lookups; an unanswered lookup leaves permissions partial", async () => {
    const w = world();
    const one = w.issues.get(1)!;
    // Delivery records make the trust decision look up each author's current permission.
    const marker = (agent: string, i: number) =>
      deliveryMarker({
        v: 1,
        op: "submit",
        opId: `op-${i}`,
        repository: repo,
        issue: 1,
        agent,
        deliverables: [],
        issuedAt: time,
      } as unknown as DeliveryRecord);
    w.issues.set(1, {
      ...one,
      comments: page([
        {
          ...note(issueUrl(1), 1, marker("ana", 1), 1),
          author: { __typename: "User", login: "ana" },
        },
        {
          ...note(issueUrl(1), 1, marker("mallory", 2), 2),
          author: { __typename: "User", login: "mallory" },
        },
      ]),
    });
    const { query } = fake(w);
    const rest: Rest = async (path) =>
      path.includes("/collaborators/ana/")
        ? { status: 200, body: { user: { login: "ana" }, role_name: "write" } }
        : { status: 404, body: { message: "Not Found" } };
    const read = await readWhoLive(
      repo,
      1,
      options,
      {
        trust: markerTrust(permissionLookup(repo, rest)),
        trustWith: (r) => markerTrust(permissionLookup(repo, r)),
        live: { query, rest },
      },
      query,
      clock,
    );
    const { coverage, telemetry } = read.report.collection;
    const lookups = telemetry.calls.filter((c) => c.source === "permissions");
    expect(lookups.map((c) => c.status).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([200, 404]);
    expect(coverage.find((c) => c.source === "permissions")).toMatchObject({
      state: "partial",
      omission: "1 of 2 lookups unanswered; authority unknown",
    });
    expect(telemetry.restRequests).toBe(2);
    expect(coverage.find((c) => c.source === "delivery-records")?.state).not.toBe("not-requested");
  });

  it("the CLI writes a cache only from the full compatibility snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-367-"));
    const cache = join(dir, "snapshot.json");
    const w = world();
    const { query, log } = fake(w);
    let out = "";
    const runtime = {
      collect: (r: string, o: Parameters<typeof collect>[1]) => collect(r, o, query, clock),
      collectIssueFocus: (r: string, n: number, o: Parameters<typeof collectIssueFocus>[2]) =>
        collectIssueFocus(r, n, o, query, clock),
      currentRepository: async () => repo,
      now: clock,
    };
    await main(
      ["who", "1", "--json", "--cache", cache, "--repo", repo],
      async (t) => void (out = t),
      runtime,
    );
    expect(log.some((s) => s.includes("issues(first:50"))).toBe(true);
    expect(JSON.parse(out).answer).toBe("recorded claim: ana");
    // A focused read saved by hand is refused as a repository snapshot.
    const focused = await collectIssueFocus(
      repo,
      1,
      {
        meter: new ReadMeter("issue-detail-v1", "who", clock),
      },
      query,
      clock,
    );
    await writeFile(cache, JSON.stringify(focused));
    await expect(
      main(["--offline", "--cache", cache, "--repo", repo], async () => {}, runtime),
    ).rejects.toThrow(/focused issue-detail-v1 read/);
  });
});

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
      // No delivery boundary in this run: delivery was not read, so it is not known.
      "delivery-records",
    ]);
    expect(report.collection.telemetry.cost).toBe(log.length);
  });

  it("counts the delivery and permission reads made while presenting the intake", async () => {
    const w = world();
    const one = w.issues.get(1)!;
    // A delivery record makes presenting the intake look up its author's permission.
    w.issues.set(1, {
      ...one,
      comments: page([
        note(
          issueUrl(1),
          1,
          deliveryMarker({
            v: 1,
            op: "submit",
            opId: "op-1",
            repository: repo,
            issue: 1,
            agent: "ana",
            deliverables: [],
            issuedAt: time,
          } as unknown as DeliveryRecord),
          1,
        ),
      ]),
    });
    const { query, log } = fake(w);
    const restPaths: string[] = [];
    let out = "";
    await main(
      ["--issue", "1", "--json", "--repo", repo, "--no-update-check"],
      async (t) => void (out = t),
      {
        collect: (r, o) => collect(r, o, query, clock),
        currentRepository: async () => repo,
        query,
        rest: async (path) => {
          restPaths.push(path);
          return { status: 404, body: { message: "Not Found" } };
        },
        now: clock,
        updateCheck: async () => ({ status: "disabled" }) as never,
      },
    );
    const { telemetry, coverage } = JSON.parse(out).collection;
    // Every GraphQL and REST request of the command, not only the snapshot read.
    expect(telemetry.graphqlRequests).toBe(log.length);
    expect(telemetry.restRequests).toBe(restPaths.length);
    expect(telemetry.requests).toBe(log.length + restPaths.length);
    expect(restPaths.some((p) => p.includes("/collaborators/"))).toBe(true);
    expect(telemetry.failures).toMatchObject({ failed: restPaths.length });
    // Presentation reads are timed with an advancing timer although the clock is fixed.
    const presented = telemetry.calls.filter((c: { source: string }) =>
      ["permissions", "delivery-records"].includes(c.source),
    );
    expect(presented.length).toBeGreaterThan(0);
    expect(coverage.map((c: { source: string }) => c.source)).toContain("delivery-records");
  });

  it("times presentation reads with the injected monotonic timer, not the fixed clock", async () => {
    const w = world();
    const one = w.issues.get(1)!;
    w.issues.set(1, {
      ...one,
      comments: page([
        note(
          issueUrl(1),
          1,
          deliveryMarker({
            v: 1,
            op: "submit",
            opId: "op-1",
            repository: repo,
            issue: 1,
            agent: "ana",
            deliverables: [],
            issuedAt: time,
          } as unknown as DeliveryRecord),
          1,
        ),
      ]),
    });
    const { query } = fake(w);
    const snapshot = await collect(repo, { issue: 1 }, query, clock);
    const rest = async () => ({ status: 404, body: {} });
    let tick = 0;
    const { report } = await presentBriefing(
      snapshot,
      { issue: 1, limit: 10, maxChars: 4000, monotonic: () => (tick += 5) },
      undefined,
      clock(),
      undefined,
      markerTrust(permissionLookup(repo, rest)),
      undefined,
      undefined,
      { query, rest, trustWith: (r) => markerTrust(permissionLookup(repo, r)) },
    );
    const calls = (report as unknown as { collection: ReadCollection }).collection.telemetry.calls;
    const presented = calls.filter((c) => c.source === "permissions");
    expect(presented.length).toBeGreaterThan(0);
    for (const c of presented) expect(c.durationMs).toBe(5);
  });
});
