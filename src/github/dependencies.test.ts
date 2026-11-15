import { describe, expect, it } from "vite-plus/test";
import { depsArgumentsFor, main } from "../cli.js";
import {
  applyDependencyChange,
  completeNative,
  isRateLimit,
  RateLimitError,
  dependencyReport,
  dependencyText,
  planDependencyChange,
} from "./dependencies.js";
import { type Query } from "./github.js";
import { dependenciesView, type ViewBase } from "../mcp/views.js";
import type { Issue } from "./types.js";
import { clock, issue, page, repo, time } from "../testing/snapshots.js";
import { graphQuery } from "../testing/fakegh.js";

describe("native dependency read command", () => {
  it("follows nested blockedBy and blocking pages until the summary totals match", async () => {
    const edges: [number, number][] = [2, 3, 4].map((b) => [1, b]);
    edges.push([5, 1], [6, 1]);
    const { query, calls } = graphQuery({ edges, pageSize: 2 });
    const report = await dependencyReport(repo, 1, {}, query, clock);
    expect(report.nodes[0].upstream.map((n) => n.number)).toEqual([2, 3, 4]);
    expect(report.nodes[0].downstream.map((n) => n.number)).toEqual([5, 6]);
    expect(calls.filter((call) => call.cursor)).toHaveLength(1);
  });
  it("rejects missing native evidence and a page total that disagrees with the summary", async () => {
    const item = issue();
    await expect(
      completeNative({ ...item, blockedBy: undefined } as unknown as Issue, repo),
    ).rejects.toThrow("Native dependency evidence missing");
    item.issueDependenciesSummary!.totalBlockedBy = 2;
    await expect(completeNative(item, repo, async () => ({}))).rejects.toThrow(
      "count changed or is incomplete",
    );
  });
  it("reports a missing issue or pull request as unavailable rather than empty", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    await expect(dependencyReport(repo, 99, {}, query, clock)).rejects.toThrow(
      "pull requests cannot be native blockers",
    );
  });
  it("walks both directions once each and reports only blocked-by cycles", async () => {
    // 1 <- 2 <- 3 <- 1 is a cycle; 4 is merely downstream of 1.
    const { query, calls } = graphQuery({
      edges: [
        [1, 2],
        [2, 3],
        [3, 1],
        [4, 1],
      ],
    });
    const single = await dependencyReport(repo, 1, {}, query, clock);
    expect(single.nodes.map((n) => n.number)).toEqual([1]);
    expect(single.cycles).toEqual([]);
    calls.length = 0;
    const tree = await dependencyReport(repo, 4, { tree: true }, query, clock);
    expect(tree.nodes.map((n) => n.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(tree.cycles).toHaveLength(1);
    expect(new Set(tree.cycles[0]).size).toBe(3);
    expect(dependencyText(tree)).toContain("CYCLE:");
  });
  it("does not call an ordinary reverse relationship a cycle", async () => {
    const { query } = graphQuery({ edges: [[2, 1]] });
    const tree = await dependencyReport(repo, 1, { tree: true }, query, clock);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.cycles).toEqual([]);
  });
  it("gives verdicts for waiting, not-planned blockers, last-open-blocker dependants and drift", async () => {
    const { query, url } = graphQuery({
      states: {
        1: { body: "Depends on #2 and #9." },
        3: { state: "CLOSED", stateReason: "NOT_PLANNED" },
      },
      edges: [
        [1, 2],
        [5, 1],
        [6, 1],
        [6, 7],
        [8, 3],
      ],
    });
    const waiting = (await dependencyReport(repo, 1, {}, query, clock)).nodes[0];
    expect(waiting.verdict).toBe(`Waiting on ${url(2)}`);
    expect(waiting.downstream.map((n) => [n.number, n.lastOpenBlocker])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(waiting.drift.map((ref) => ref.number)).toEqual([9]);
    const notPlanned = (await dependencyReport(repo, 8, {}, query, clock)).nodes[0];
    expect(notPlanned.verdict).toContain("closed as not planned");
    const free = (await dependencyReport(repo, 7, {}, query, clock)).nodes[0];
    expect(free.verdict).toContain("No open native blockers");
  });
});

/** A 170-issue injected graph: 1 blocks a fan of 40, each of which blocks a chain of 3. */
const largeGraph = (): [number, number][] => {
  const edges: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const head = 10 + i * 4;
    edges.push([head, 1], [head + 1, head], [head + 2, head + 1], [head + 3, head + 2]);
  }
  return edges;
};

describe("bounded --tree diagnosis (#196)", () => {
  it("reads one issue for a direct read of a 165+ node graph", async () => {
    const { query, calls } = graphQuery({ edges: largeGraph() });
    const report = await dependencyReport(repo, 1, {}, query, clock);
    expect(calls).toHaveLength(1);
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0].downstream).toHaveLength(40);
    expect(report.treeBounds).toBeUndefined();
    expect(JSON.stringify(report).length).toBeLessThan(40_000);
  });
  it("stops at its node limit, lists what it did not read and never claims completeness", async () => {
    const { query, calls } = graphQuery({ edges: largeGraph() });
    const report = await dependencyReport(repo, 1, { tree: true }, query, clock);
    // Request volume is bounded by the node limit, not by the 161-issue graph.
    expect(calls).toHaveLength(50);
    expect(report.nodes).toHaveLength(50);
    expect(report.treeBounds).toMatchObject({
      complete: false,
      nodeLimit: 50,
      nodesRead: 50,
      stoppedBy: "node-limit",
      cyclesComplete: false,
    });
    expect(report.treeBounds!.notRead).toBeGreaterThan(0);
    expect(report.treeBounds!.notReadSample.length).toBeLessThanOrEqual(50);
    expect(report.collection?.profile).toBe("dependency-tree-v1");
    const text = dependencyText(report);
    expect(text).toContain("TREE INCOMPLETE (node limit 50)");
    expect(text).toContain("not a complete graph");
    expect(text).not.toContain("Tree complete");
    expect(text).toMatch(/Read cost: 50 request\(s\)/);
    // Output stays bounded too.
    expect(JSON.stringify(report).length).toBeLessThan(400_000);
  });
  it("reports a tree complete only when everything reachable was read", async () => {
    const { query, calls } = graphQuery({ edges: largeGraph() });
    const report = await dependencyReport(repo, 1, { tree: true, maxNodes: 500 }, query, clock);
    expect(calls).toHaveLength(161);
    expect(report.treeBounds).toMatchObject({ complete: true, notRead: 0, stoppedBy: null });
    expect(dependencyText(report)).toContain("Tree complete: 161 issue(s) read");
    // A limit equal to the graph size is still complete; one fewer is not.
    const exact = await dependencyReport(repo, 1, { tree: true, maxNodes: 161 }, query, clock);
    expect(exact.treeBounds?.complete).toBe(true);
    const short = await dependencyReport(repo, 1, { tree: true, maxNodes: 160 }, query, clock);
    expect(short.treeBounds).toMatchObject({ complete: false, notRead: 1 });
  });
  it("stops the walk on a quota refusal and keeps what it read as partial", async () => {
    const { query: base } = graphQuery({ edges: largeGraph() });
    let sent = 0;
    const query: Query = async (source, variables) => {
      if (++sent === 4)
        throw Object.assign(new Error("rate limited"), { rateLimited: true, retry: {} });
      return base(source, variables);
    };
    const report = await dependencyReport(repo, 1, { tree: true }, query, clock);
    expect(sent).toBe(4);
    expect(report.nodes).toHaveLength(3);
    expect(report.treeBounds).toMatchObject({ complete: false, stoppedBy: "quota" });
    expect(report.collection?.quota).not.toBeNull();
    expect(dependencyText(report)).toContain("quota refusal");
  });
  it("makes the MCP dependencies view incomplete when the tree was truncated", async () => {
    const { query } = graphQuery({ edges: largeGraph() });
    const report = await dependencyReport(repo, 1, { tree: true, maxNodes: 5 }, query, clock);
    const base = { repository: repo, status: "complete", notices: [], maxChars: 16_384 };
    const view = dependenciesView(
      base as unknown as ViewBase,
      JSON.parse(JSON.stringify(report)),
      1,
      { offset: 0, limit: 20 },
      {},
    );
    expect(view.status).toBe("incomplete");
    expect(view.sourceCompleteness.complete).toBe(false);
    expect(JSON.stringify(view.sourceCompleteness)).toContain("Tree incomplete");
  });
  it("rejects a node limit outside its bounds", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    await expect(
      dependencyReport(repo, 1, { tree: true, maxNodes: 0 }, query, clock),
    ).rejects.toThrow("node limit");
    expect(depsArgumentsFor(["7", "--tree", "--max-nodes", "9"])).toMatchObject({ maxNodes: 9 });
    expect(() => depsArgumentsFor(["7", "--max-nodes", "9"])).toThrow("--tree");
    expect(() => depsArgumentsFor(["7", "--tree", "--max-nodes", "501"])).toThrow("1–500");
  });
});

describe("deps command line", () => {
  it("validates arguments and prints its own help", async () => {
    expect(depsArgumentsFor(["7", "--tree"])).toMatchObject({ number: 7, tree: true });
    for (const bad of [[], ["0"], ["1", "2"], ["x"], ["1", "--repo", "nope"], ["1", "--bogus"]])
      expect(() => depsArgumentsFor(bad)).toThrow();
    let text = "";
    expect(await main(["deps", "--help"], async (t) => void (text = t))).toBe(0);
    expect(text).toMatch(/^Usage: .*deps N/);
  });
  it("reads through the injected runtime and never collects the full briefing", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      dependencyReport: (r: string, n: number, o?: { tree?: boolean }) =>
        dependencyReport(r, n, o, query, clock),
    };
    expect(await main(["deps", "1", "--json"], async (t) => void (text = t), runtime)).toBe(0);
    const report = JSON.parse(text);
    expect(report).toMatchObject({ schemaVersion: 1, repository: repo, startedAt: time });
    expect(report.nodes[0].upstream[0].number).toBe(2);
    await expect(
      main(["deps", "1"], async () => {}, {
        ...runtime,
        dependencyReport: async () => {
          throw new Error("GitHub query failed.");
        },
      }),
    ).rejects.toThrow("GitHub query failed.");
  });
});

describe("deps add and deps remove", () => {
  const writes = () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => void calls.push(args);
    return { calls, run };
  };
  const add = (on: number[], number = 1) => ({ action: "add" as const, number, on, note: "why" });
  it("refuses self-edges, pull requests, missing issues and cycles, and no-ops existing edges", async () => {
    // 2 is already a blocker of 1; 3 is blocked by 1, so 1 <- 3 would close a cycle.
    const { query } = graphQuery({
      states: { 4: {} },
      edges: [
        [1, 2],
        [3, 1],
      ],
      pullRequests: { 9: [4] },
    });
    const plan = await planDependencyChange(repo, add([1, 2, 3, 9, 77, 4]), query);
    const byBlocker = Object.fromEntries(plan.changes.map((c) => [c.blocker, c]));
    expect(byBlocker[1].status).toBe("refused");
    expect(byBlocker[2]).toMatchObject({ status: "noop", reason: "Already a native blocker." });
    expect(byBlocker[3].status).toBe("refused");
    expect(byBlocker[3].reason).toContain("cycle");
    expect(byBlocker[9].reason).toContain("pull request");
    expect(byBlocker[9].reason).toContain("#4");
    expect(byBlocker[77].reason).toContain("does not exist");
    expect(byBlocker[4]).toMatchObject({
      status: "apply",
      command: ["issue", "edit", "1", "--repo", repo, "--add-blocked-by", "4"],
    });
  });
  it("detects a cycle through a longer upstream chain", async () => {
    // 4 <- 3 <- 2 <- 1: making 1 blocked by 4 closes 1 -> 4 -> 3 -> 2 -> 1.
    const { query } = graphQuery({
      edges: [
        [2, 1],
        [3, 2],
        [4, 3],
      ],
    });
    const plan = await planDependencyChange(repo, add([4]), query);
    expect(plan.changes[0].status).toBe("refused");
    expect(plan.changes[0].reason.split(" -> ")).toHaveLength(5);
  });
  it("applies each edge, posts one comment naming the note, and changes no labels", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {} }, edges: [] });
    const { calls, run } = writes();
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5]), query),
      run,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "issue edit",
      "issue edit",
      "issue comment",
    ]);
    expect(calls[2].at(-1)).toContain("#4, #5");
    expect(calls[2].at(-1)).toContain("Why: why");
    expect(calls.flat().some((arg) => /^--(?:add|remove)-label$/.test(arg))).toBe(false);
  });
  it("reports partial failure with exit 2 and comments only on what changed", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {} }, edges: [] });
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args.includes("5")) throw new Error("gh issue edit failed.");
    };
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5]), query),
      run,
    );
    expect(result.exitCode).toBe(2);
    expect(result.changes.map((c) => c.status)).toEqual(["done", "failed"]);
    expect(calls.at(-1)?.at(-1)).toContain("dependency: #4.");
    // The reported comment is the one posted, not the planned one naming #5 too.
    expect(result.comment).toBe(calls.at(-1)?.at(-1));
    expect(result.commentCommand).toEqual(calls.at(-1));
    expect(result.commentStatus).toBe("posted");
  });
  it("stops all further writes, including the comment, after a rate limit", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {}, 6: {} }, edges: [] });
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args.includes("5")) throw new RateLimitError("gh issue edit was rate limited by GitHub.");
    };
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5, 6]), query),
      run,
    );
    expect(result.changes.map((c) => c.status)).toEqual(["done", "failed", "skipped"]);
    expect(calls).toHaveLength(2);
    expect(result.commentStatus).toContain("rate limit");
    expect(result.rateLimited).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(isRateLimit("gh: You have exceeded a secondary rate limit. (HTTP 403)")).toBe(true);
    expect(isRateLimit("gh: Could not resolve to an issue")).toBe(false);
  });
  it("exits 1 when nothing could be done and 0 for a pure no-op, with no comment either way", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    const { calls, run } = writes();
    const refused = await applyDependencyChange(
      await planDependencyChange(repo, add([1]), query),
      run,
    );
    const noop = await applyDependencyChange(
      await planDependencyChange(repo, add([2]), query),
      run,
    );
    expect([refused.exitCode, noop.exitCode]).toEqual([1, 0]);
    expect(calls).toEqual([]);
  });
  it("does not confuse a same-numbered blocker in another repository with a local one", async () => {
    const { query } = graphQuery({ states: { 1: {}, 5: {} }, edges: [] });
    const crossRepo: Query = async (source, variables) => {
      const data = (await query(source, variables)) as {
        repository: { issue?: Record<string, unknown> };
      };
      const issue = data.repository.issue as
        | { number: number; blockedBy?: unknown; issueDependenciesSummary?: Record<string, number> }
        | undefined;
      if (issue?.number === 1 && issue.blockedBy && !variables.cursor) {
        issue.blockedBy = page([
          {
            ...issue,
            number: 5,
            url: "https://github.com/other/repo/issues/5",
            repository: { nameWithOwner: "other/repo" },
          },
        ]);
        issue.issueDependenciesSummary = {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        };
      }
      return data;
    };
    const remove = await planDependencyChange(
      repo,
      { action: "remove", number: 1, on: [5], note: "x" },
      crossRepo,
    );
    expect(remove.changes[0].status).toBe("noop");
    const addLocal = await planDependencyChange(repo, add([5]), crossRepo);
    expect(addLocal.changes[0].status).toBe("apply");
  });
  it("matches local blockers when --repo casing differs from GitHub's canonical name", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    const plan = await planDependencyChange(
      repo.toUpperCase(),
      { action: "remove", number: 1, on: [2], note: "x" },
      query,
    );
    expect(plan.changes[0].status).toBe("apply");
  });
  it("removes only existing edges", async () => {
    const { query } = graphQuery({ states: { 3: {} }, edges: [[1, 2]] });
    const plan = await planDependencyChange(
      repo,
      { action: "remove", number: 1, on: [2, 3], note: "done differently" },
      query,
    );
    expect(plan.changes.map((c) => c.status)).toEqual(["apply", "noop"]);
    expect(plan.changes[0].command).toContain("--remove-blocked-by");
  });
  it("dry run prints the exact commands and comment and calls no write", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {} }, edges: [] });
    const { calls, run } = writes();
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      planDependencyChange: (r: string, request: Parameters<typeof planDependencyChange>[1]) =>
        planDependencyChange(r, request, query),
      ghRun: run,
    };
    const code = await main(
      ["deps", "add", "1", "--on", "4", "--note", "needs the parser", "--dry-run"],
      async (t) => void (text = t),
      runtime,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(text).toContain("DRY RUN");
    expect(text).toContain(`gh issue edit 1 --repo ${repo} --add-blocked-by 4`);
    expect(text).toContain("Why: needs the parser");
  });
  it("validates add/remove arguments", () => {
    expect(depsArgumentsFor(["add", "1", "--on", "2", "--on", "3", "--note", " x "])).toMatchObject(
      {
        action: "add",
        number: 1,
        on: [2, 3],
        note: "x",
        dryRun: false,
      },
    );
    for (const bad of [
      ["add", "1", "--note", "x"],
      ["add", "1", "--on", "2"],
      ["add", "1", "--on", "2", "--note", "  "],
      ["add", "1", "--on", "abc", "--note", "x"],
      ["remove", "--on", "2", "--note", "x"],
      ["add", "1", "--on", "2", "--note", "x", "--tree"],
      ["7", "--on", "2"],
    ])
      expect(() => depsArgumentsFor(bad)).toThrow();
  });
});
