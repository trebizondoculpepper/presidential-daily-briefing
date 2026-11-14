import { describe, expect, it } from "vite-plus/test";
import { depsArgumentsFor } from "../cli.js";
import { type Query } from "./github.js";
import { clauseFor, hedged, listWideHedge, planMigration } from "./migration.js";
import type { Issue } from "./types.js";
import { clock, issue, page, repo, snapshot } from "../testing/snapshots.js";

describe("dependency migration", () => {
  /** A small live repository: issues with labels, bodies and native edges; PRs by number. */
  type Fake = {
    issues: Record<
      number,
      { body?: string; labels?: string[]; state?: string; blockedBy?: number[] }
    >;
    prs?: Record<number, { merged: boolean; closes: number[] }>;
  };
  const live = (fake: Fake) => {
    let clock = 0;
    const meta = Object.fromEntries(
      Object.keys(fake.issues).map((n) => [n, { updatedAt: `2026-11-12T10:00:0${clock}.000Z` }]),
    );
    const touch = (n: number) => {
      clock++;
      meta[n].updatedAt = `2026-11-12T11:${String(clock).padStart(2, "0")}:00.000Z`;
    };
    const state = (n: number) => fake.issues[n]?.state ?? "OPEN";
    const issueNode = (n: number) => {
      const i = fake.issues[n];
      const blockers = i.blockedBy ?? [];
      return {
        ...issue(n, i.labels ?? []),
        body: i.body ?? "",
        state: state(n),
        updatedAt: meta[n].updatedAt,
        issueDependenciesSummary: {
          blockedBy: blockers.filter((b) => state(b) === "OPEN").length,
          totalBlockedBy: blockers.length,
          blocking: 0,
          totalBlocking: 0,
        },
        blockedBy: page(
          blockers.map((b) => ({
            ...issue(b),
            state: state(b),
            repository: { nameWithOwner: repo },
            issueDependenciesSummary: {
              blockedBy: 0,
              totalBlockedBy: 0,
              blocking: 0,
              totalBlocking: 0,
            },
          })),
        ),
      };
    };
    const query: Query = async (source, variables) => {
      const n = Number(variables.number);
      if (source.includes("issueOrPullRequest")) {
        const pr = fake.prs?.[n];
        if (pr)
          return {
            repository: {
              issueOrPullRequest: {
                __typename: "PullRequest",
                number: n,
                url: `https://github.com/${repo}/pull/${n}`,
                state: pr.merged ? "MERGED" : "OPEN",
                merged: pr.merged,
                closingIssuesReferences: page(
                  pr.closes.map((c) => ({
                    number: c,
                    url: issue(c).url,
                    state: state(c),
                    repository: { nameWithOwner: repo },
                  })),
                ),
              },
            },
          };
        return {
          repository: {
            issueOrPullRequest: fake.issues[n]
              ? {
                  __typename: "Issue",
                  number: n,
                  url: issue(n).url,
                  state: state(n),
                  stateReason: null,
                }
              : null,
          },
        };
      }
      return { repository: { issue: fake.issues[n] ? issueNode(n) : null } };
    };
    const snapshotNow = async () =>
      snapshot(
        Object.keys(fake.issues)
          .map(Number)
          .filter((n) => state(n) === "OPEN")
          .map(issueNode) as Issue[],
        [],
      );
    const writes: string[][] = [];
    const run = async (args: string[]) => {
      writes.push(args);
      const n = Number(args[2]);
      const i = fake.issues[n];
      if (args[1] === "edit") {
        for (let k = 3; k < args.length; k++) {
          if (args[k] === "--add-blocked-by") (i.blockedBy ??= []).push(Number(args[k + 1]));
          if (args[k] === "--add-label") (i.labels ??= []).push(args[k + 1]);
          if (args[k] === "--remove-label")
            i.labels = (i.labels ?? []).filter((l) => l !== args[k + 1]);
        }
      }
      touch(n);
    };
    return { query, run, writes, snapshotNow, touch, meta };
  };
  const plan = (env: ReturnType<typeof live>) =>
    planMigration(repo, { query: env.query, collect: env.snapshotNow as never, now: clock });

  it("plans edges from explicit text and routes doubtful references to review", async () => {
    const env = live({
      issues: {
        1: {
          body: "Depends on #2 and #3; coordinate #4.",
          labels: ["status:blocked", "blocked:work"],
        },
        2: {},
        3: { state: "CLOSED" },
        4: {},
        5: {
          body: "Depends on #5, #99 and https://github.com/other/repo/issues/1.",
          blockedBy: [2],
        },
        6: { body: "Requires #2.", blockedBy: [2] },
        7: { body: "Depends on #20 and #21." },
        8: { body: "Depends on #22." },
        20: {},
      },
      prs: { 21: { merged: true, closes: [] }, 22: { merged: false, closes: [] } },
    });
    const p = await plan(env);
    const t = (n: number) => p.tickets.find((x) => x.number === n);
    expect(t(1)!.edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "apply"],
      [3, "apply"],
      [4, "review"],
    ]);
    // Full URLs are parsed before #N references.
    expect(t(5)!.edges.map((e) => [e.blocker, e.status, e.reason])).toEqual([
      [1, "review", "Cross-repository reference."],
      [5, "review", "Self-reference."],
      [99, "review", "#99 does not exist."],
    ]);
    expect(t(6)).toBeUndefined();
    expect(t(7)!.edges.map((e) => [e.blocker, e.status])).toEqual([
      [20, "apply"],
      [21, "satisfied"],
    ]);
    expect(t(8)!.edges[0]).toMatchObject({ status: "review", reason: "PR #22 closes no issue." });
    expect(t(1)!.labels).toMatchObject({
      status: "apply",
      remove: ["blocked:work", "status:blocked"],
      add: ["status:ready"],
    });
    expect(p.summary).toMatchObject({ apply: 4, review: 5, satisfied: 1 });
  });
  it("maps a pull request reference to the issues it closes", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30." }, 9: {} },
      prs: { 30: { merged: false, closes: [9] } },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges).toMatchObject([{ blocker: 9, source: "pr #30", status: "apply" }]);
  });
  it("applies the label rules for blocked:work", async () => {
    const env = live({
      issues: {
        1: { labels: ["status:blocked", "blocked:work", "blocked:testing"] },
        2: { labels: ["status:blocked", "blocked:work"], body: "Depends on #9." },
        3: { labels: ["status:blocked", "blocked:work"], body: "Depends on #9." },
        9: { state: "CLOSED" },
      },
    });
    // #2 and #3 depend only on a closed blocker.
    const p = await plan(env);
    const labels = Object.fromEntries(p.tickets.map((t) => [t.number, t.labels]));
    expect(labels[1]).toMatchObject({ status: "apply", remove: ["blocked:work"], add: [] });
    expect(labels[2]).toMatchObject({ status: "review", remove: [], add: [] });
  });
  it("scopes hedged wording to the clause naming the reference", () => {
    const text = "Depends on #541's revised mission merging first, after research #543.";
    expect(clauseFor(text, 541)).not.toMatch(/after/);
    expect(clauseFor(text, 543)).toMatch(/after/);
  });
  it("keeps a local edge when another repository's issue has the same number", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #2 and https://github.com/other/repo/issues/2." }, 2: {} },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "review"],
      [2, "apply"],
    ]);
  });
  it("sends a PR reference to review when its closing issues are incomplete, and judges hedging by the PR's clause", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30; coordinate #31." }, 9: {}, 10: {} },
      prs: { 30: { merged: false, closes: [9] }, 31: { merged: false, closes: [10] } },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [9, "apply"],
      [10, "review"],
    ]);
    const base = env.query;
    const truncated: Query = async (source, variables) => {
      const data = (await base(source, variables)) as any;
      const node = data.repository?.issueOrPullRequest;
      if (node?.__typename === "PullRequest")
        node.closingIssuesReferences.pageInfo.hasNextPage = true;
      return data;
    };
    const q = await planMigration(repo, {
      query: truncated,
      collect: env.snapshotNow as never,
      now: clock,
    });
    expect(q.tickets[0].edges[0]).toMatchObject({ status: "review" });
    expect(q.tickets[0].edges[0].reason).toContain("incomplete");
  });
  it("reviews issues a referenced PR closes in other repositories", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30." }, 9: {} },
      prs: { 30: { merged: true, closes: [9] } },
    });
    const base = env.query;
    const external: Query = async (source, variables) => {
      const data = (await base(source, variables)) as any;
      const node = data.repository?.issueOrPullRequest;
      if (node?.__typename === "PullRequest")
        node.closingIssuesReferences.nodes.push({
          number: 4,
          url: "https://github.com/other/repo/issues/4",
          state: "OPEN",
          repository: { nameWithOwner: "other/repo" },
        });
      return data;
    };
    const p = await planMigration(repo, {
      query: external,
      collect: env.snapshotNow as never,
      now: clock,
    });
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [9, "apply"],
      [4, "review"],
    ]);
  });
  it("sends the blocked:work label row to review when labels are incomplete", async () => {
    const env = live({
      issues: { 1: { labels: ["status:blocked", "blocked:work"], body: "Depends on #2." }, 2: {} },
    });
    const partial = async () => {
      const snap = await env.snapshotNow();
      snap.issues[0].labels.pageInfo.hasNextPage = true;
      return snap;
    };
    const p = await planMigration(repo, {
      query: env.query,
      collect: partial as never,
      now: clock,
    });
    expect(p.tickets[0].labels).toMatchObject({ status: "review" });
    expect(p.tickets[0].labels!.reason).toContain("incomplete");
  });
  it("treats a qualifier covering the whole list as hedging every reference", () => {
    for (const text of [
      "Depends on #1, #2 and #3 (all optional).",
      "Depends on #1, #2, #3, ideally.",
      "Depends on #1 and #2; both are optional.",
    ])
      for (const n of [1, 2])
        expect(listWideHedge(text) || hedged.test(clauseFor(text, n))).toBe(true);
    for (const text of [
      "Depends on #518 and #519; coordinate #493 and #510.",
      "Depends on #541's revised mission merging first, after research #543.",
      "Depends on #1 and #2.",
    ])
      expect(listWideHedge(text)).toBe(false);
  });
  it("keeps a leading qualifier across a comma-separated list", async () => {
    const env = live({
      issues: { 1: { body: "## Dependencies\n- Optional: #2, #3\n- #4" }, 2: {}, 3: {}, 4: {} },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "review"],
      [3, "review"],
      [4, "apply"],
    ]);
    expect(clauseFor("Depends on #1, optionally #2, #3.", 3)).toMatch(/optionally/);
    expect(clauseFor("Depends on #1, optionally #2, #3.", 1)).not.toMatch(/optionally/);
    const markdown =
      "Depends on #2; optionally #3, `#4`, **#5**, [#6](https://github.com/example/project/issues/6).";
    for (const n of [4, 5, 6]) expect(clauseFor(markdown, n)).toMatch(/optionally/);
    expect(clauseFor(markdown, 2)).not.toMatch(/optionally/);
  });
  it("judges each reference by its own clause when numbers repeat across repositories", async () => {
    const env = live({
      issues: {
        1: { body: "Depends on https://github.com/other/repo/issues/2; optionally #2." },
        2: {},
      },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status, !!e.crossRepository])).toEqual([
      [2, "review", true],
      [2, "review", false],
    ]);
  });
  it("reports a ticket with an incomplete label list even without visible blocked:work, with warnings", async () => {
    const env = live({ issues: { 1: { labels: ["status:blocked"] } } });
    const partial = async () => {
      const snap = await env.snapshotNow();
      snap.issues[0].labels.pageInfo.hasNextPage = true;
      snap.warnings = [`${snap.issues[0].url}: labels exceed 100; label analysis incomplete.`];
      return snap;
    };
    const p = await planMigration(repo, {
      query: env.query,
      collect: partial as never,
      now: clock,
    });
    expect(p.tickets[0].labels).toMatchObject({ status: "review" });
    expect(p.warnings).toHaveLength(1);
  });
  it("validates migrate arguments; apply is not offered", async () => {
    expect(depsArgumentsFor(["migrate", "--plan", "p.json"])).toMatchObject({
      migrate: "plan",
      file: "p.json",
    });
    for (const bad of [
      ["migrate"],
      ["migrate", "--apply", "p.json"],
      ["migrate", "--plan", "a", "--dry-run"],
      ["7", "--plan", "a"],
    ])
      expect(() => depsArgumentsFor(bad)).toThrow();
  });
});
