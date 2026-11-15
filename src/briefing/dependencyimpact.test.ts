/**
 * Direct dependency impact for routine `deps N` (#196): injected graphs only, never live GitHub.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  dependencyReport,
  dependencyReportIncomplete,
  dependencyText,
  readDependencyInventory,
} from "../github/dependencies.js";
import type { Query } from "../github/github.js";
import { graphQuery } from "../testing/fakegh.js";
import { clock, repo } from "../testing/snapshots.js";
import { depsArgumentsFor, main, ticketArgumentsFor, workflowArgumentsFor } from "../cli.js";
import {
  claimTemplate,
  directImpact,
  directImpactText,
  repositoryImpact,
  repositoryImpactText,
} from "./dependencyimpact.js";
import { commandTemplates } from "../rules/datalog/commands.js";

const read = async (graph: Parameters<typeof graphQuery>[0], number = 1) => {
  const fake = graphQuery(graph);
  const report = await dependencyReport(repo, number, { impact: true }, fake.query, clock);
  return { ...fake, report, impact: directImpact(report)! };
};

describe("direct dependency impact (#196)", () => {
  it("separates newly pickable, still-blocked, not-pickable and closed dependants", async () => {
    const { impact, calls, report } = await read({
      states: {
        1: { labels: ["status:ready"] },
        2: { labels: ["status:ready"], createdAt: "2026-01-02T00:00:00Z" },
        8: { labels: ["status:ready", "urgency:high"], createdAt: "2026-03-01T00:00:00Z" },
        3: { labels: ["status:ready"] },
        4: { labels: ["status:in-progress", "agent:ana"] },
        5: { state: "CLOSED", stateReason: "COMPLETED" },
        6: { labels: ["status:needs-design"] },
        7: { labels: ["status:ready", "platform:windows"] },
        9: { labels: ["status:ready"] },
      },
      edges: [
        [2, 1],
        [8, 1],
        [3, 1],
        [3, 9],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
      ],
    });
    // One issue read plus one batched dependant read; dependant 3 needs no hydration.
    expect(calls.filter((c) => c.cursor !== "batch")).toHaveLength(1);
    expect(calls.filter((c) => c.cursor === "batch").map((c) => c.number)).toEqual([2, 8, 4, 6, 7]);
    expect(report.collection?.profile).toBe("dependency-direct-v1");
    expect(report.collection?.telemetry.requests).toBe(2);
    expect(impact.subject.startNow.status).toBe("eligible");
    // Urgency first, then oldest.
    expect(impact.newlyPickable.map((d) => d.number)).toEqual([8, 2]);
    expect(impact.otherBlockersRemain).toMatchObject([{ number: 3, otherOpenBlockers: 1 }]);
    expect(impact.lastBlockerNotPickable.map((d) => d.number)).toEqual([4, 6]);
    expect(impact.lastBlockerNotPickable[0].reasons.join()).toContain("claimed by agent:ana");
    expect(impact.closedDependants).toBe(1);
    // A platform restriction without a viewer platform is unknown, never zero.
    expect(impact.unknown.join()).toContain("#7");
    expect(impact.nextAction).toBe(
      "Start #1: claim it (pdb claim 1 --repo example/project --agent NAME) and implement it; completing it makes at least 2 dependant(s) pickable immediately: #8, #2.",
    );
    expect(impact.transitive.computed).toBe(false);
    const text = directImpactText(impact).join("\n");
    expect(text).toContain("Becomes pickable when #1 completes (at least 2;");
    expect(text).toContain("Still blocked after it completes");
    expect(text).toContain("Finish-first (#182)");
  });

  it("explains blocked, claimed, PR follow-up and closed-as-not-planned subjects", async () => {
    const blocked = await read({
      states: { 1: { labels: ["status:ready"] } },
      edges: [
        [1, 9],
        [2, 1],
      ],
    });
    expect(blocked.impact.subject.startNow.status).toBe("ineligible");
    expect(blocked.impact.nextAction).toMatch(
      /^#1 is blocked by #9; start there \(pdb deps 9 --repo example\/project\)/,
    );
    const claimed = await read({
      states: { 1: { labels: ["status:in-progress", "agent:ana"] } },
      edges: [[2, 1]],
    });
    expect(claimed.impact.nextAction).toMatch(/^#1 is claimed \(agent:ana\); do not pick it up/);
    const pr = await read({
      states: { 1: { labels: ["status:ready"], closedBy: [40, 41] } },
      edges: [[2, 1]],
    });
    expect(pr.impact.subject.openClosingPrs).toEqual([40, 41]);
    expect(pr.impact.nextAction).toContain("Advance open PR #40, #41");
    expect(pr.impact.nextAction).toContain("not at a first PR merge");
    const dropped = await read({
      states: { 1: { state: "CLOSED", stateReason: "NOT_PLANNED" } },
      edges: [[2, 1]],
    });
    expect(dropped.impact.newlyPickable).toEqual([]);
    expect(dropped.impact.nextAction).toContain("closed (not planned)");
    expect(dropped.impact.nextAction).toContain("a person should check");
  });

  it("never decides pickup from truncated labels, for the subject or a dependant", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `l${i}`);
    const { query: base } = graphQuery({
      states: { 1: { labels: ["status:ready"] }, 2: { labels: ["status:ready"] } },
      edges: [[2, 1]],
    });
    // GitHub answers 100 labels and says there are more.
    const truncate = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(truncate);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value))
          out[k] =
            k === "labels"
              ? {
                  nodes: [{ name: "status:ready" }, ...many.slice(0, 99).map((name) => ({ name }))],
                  pageInfo: { hasNextPage: true, endCursor: "c" },
                }
              : truncate(v);
        return out;
      }
      return value;
    };
    const query: Query = async (source, variables) =>
      truncate(await base(source, variables)) as Awaited<ReturnType<Query>>;
    const report = await dependencyReport(repo, 1, { impact: true }, query, clock);
    const impact = directImpact(report)!;
    expect(impact.subject.startNow.status).toBe("unknown");
    expect(impact.subject.startNow.reasons.join()).toContain("labels beyond the first 100");
    expect(impact.nextAction).toMatch(
      /^Inspect #1 before acting \(pdb ticket 1 --repo example\/project\)/,
    );
    expect(impact.newlyPickable).toEqual([]);
    expect(impact.lastBlockerNotPickable).toEqual([]);
    expect(impact.unknown.join()).toContain("pickup unknown (labels beyond the first 100");
  });

  it("never recommends pickup when a blocker was closed as not planned", async () => {
    const { impact } = await read({
      states: {
        1: { labels: ["status:ready"] },
        9: { state: "CLOSED", stateReason: "NOT_PLANNED" },
        3: { labels: ["status:ready"] },
        8: { state: "CLOSED", stateReason: "NOT_PLANNED" },
      },
      edges: [
        [1, 9],
        [3, 1],
        [3, 8],
      ],
    });
    expect(impact.subject.startNow.status).toBe("unknown");
    expect(impact.nextAction).toMatch(/^A blocker of #1 was closed as not planned/);
    expect(impact.nextAction).toContain("pdb ticket 1 --repo example/project");
    expect(impact.nextAction).not.toContain("pdb claim");
    // A dependant whose other blocker was dropped is unknown, not newly pickable.
    expect(impact.newlyPickable).toEqual([]);
    expect(impact.unknown.join()).toContain("closed as not planned");
  });

  it("keeps the repository in every suggested command", async () => {
    const { query } = graphQuery({ states: { 1: { labels: ["status:ready"] } }, edges: [[2, 1]] });
    const other = await dependencyReport("Other/Repo", 1, { impact: true }, query, clock);
    // The fake answers for example/project; the command names the issue's own repository.
    expect(directImpact(other)!.nextAction).toContain(
      "pdb claim 1 --repo example/project --agent NAME",
    );
  });

  it("uses the briefing's own claim template", () => {
    expect(claimTemplate).toBe(commandTemplates.claim);
  });
  it("suggests only commands the real argument parsers accept, with --agent filled", async () => {
    const graphs: Parameters<typeof graphQuery>[0][] = [
      { states: { 1: { labels: ["status:ready"] } }, edges: [[2, 1]] },
      { states: { 1: { labels: ["status:ready"] } }, edges: [[1, 9]] },
      { states: { 1: { labels: ["status:in-progress", "agent:ana"] } }, edges: [[2, 1]] },
      { states: { 1: { labels: ["status:ready"], closedBy: [40] } }, edges: [[2, 1]] },
      {
        states: {
          1: { labels: ["status:ready"] },
          9: { state: "CLOSED", stateReason: "NOT_PLANNED" },
        },
        edges: [[1, 9]],
      },
      { states: { 1: { labels: ["platform:x", "status:ready"] } }, edges: [[2, 1]] },
    ];
    const parse = (command: string) => {
      const [pdb, name, ...rest] = command.split(" ");
      expect(pdb).toBe("pdb");
      if (name === "claim") return workflowArgumentsFor("claim", rest);
      if (name === "deps") return depsArgumentsFor(rest);
      if (name === "ticket") {
        const parsed = ticketArgumentsFor(rest);
        expect(parsed.help).toBe(false);
        return parsed;
      }
      throw new Error(`unexpected suggested command ${command}`);
    };
    let checked = 0;
    for (const agent of [undefined, "kavya_sabbagh"])
      for (const graph of graphs) {
        const { query } = graphQuery(graph);
        const report = await dependencyReport(repo, 1, { impact: true }, query, clock);
        const impact = directImpact(report, { prs: [] }, agent)!;
        for (const [command] of impact.nextAction.matchAll(/pdb [a-z]+ [^)]*/g)) {
          expect(() => parse(command), command).not.toThrow();
          if (command.startsWith("pdb claim"))
            expect(command).toContain(`--agent ${agent ?? "NAME"}`);
          checked++;
        }
      }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("marks a read with a truncated dependant blocker list partial and exits 2", async () => {
    // Dependant 2 has 25 blockers (only one open): more than the 20 listed.
    const edges: [number, number][] = [[2, 1]];
    const states: Record<number, { state?: string; labels?: string[] }> = {
      1: { labels: ["status:ready"] },
    };
    for (let i = 0; i < 24; i++) {
      edges.push([2, 100 + i]);
      states[100 + i] = { state: "CLOSED" };
    }
    const { query } = graphQuery({ states, edges });
    const report = await dependencyReport(repo, 1, { impact: true }, query, clock);
    expect(report.direct?.partial).toMatchObject([
      { reason: "blockers beyond the first 20 not read" },
    ]);
    const coverage = report.collection!.coverage.find((c) => c.source === "dependant-eligibility");
    expect(coverage).toMatchObject({ state: "partial" });
    expect(coverage?.omission).toContain("truncated blocker lists");
    expect(dependencyReportIncomplete(report)).toBe(true);
    expect(directImpact(report)!.unknown.join()).toContain("blocker list truncated");
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      dependencyReport: (r: string, n: number, o?: Parameters<typeof dependencyReport>[2]) =>
        dependencyReport(r, n, o, query, clock),
    };
    expect(await main(["deps", "1"], async () => {}, runtime)).toBe(2);
  });

  it("bounds dependant hydration and reports the rest as unknown, never zero", async () => {
    const edges: [number, number][] = Array.from({ length: 60 }, (_, i) => [100 + i, 1]);
    const { impact, calls, report } = await read({ edges });
    // 1 issue read + 50 dependants in 2 batches of 25; 10 left unread.
    expect(report.collection?.telemetry.requests).toBe(3);
    expect(calls.filter((c) => c.cursor === "batch")).toHaveLength(50);
    expect(impact.newlyPickable).toHaveLength(50);
    expect(impact.unknown).toHaveLength(10);
    expect(impact.unknown[0]).toContain("not read (beyond the 50-dependant bound)");
    expect(directImpactText(impact).join("\n")).toContain("(at least 50;");
    expect(impact.nextAction).toContain("at least 50 dependant(s)");
  });

  it("deps N exits 2 when dependants were not read, 0 when the direct answer is complete", async () => {
    const quiet = async () => {};
    const runtimeFor = (edges: [number, number][]) => {
      const { query } = graphQuery({ edges });
      return {
        collect: async () => {
          throw new Error("briefing collection must not run");
        },
        currentRepository: async () => repo,
        dependencyReport: (r: string, n: number, o?: Parameters<typeof dependencyReport>[2]) =>
          dependencyReport(r, n, o, query, clock),
      };
    };
    const many = Array.from({ length: 60 }, (_, i): [number, number] => [100 + i, 1]);
    expect(await main(["deps", "1"], quiet, runtimeFor(many))).toBe(2);
    expect(await main(["deps", "1", "--json"], quiet, runtimeFor(many.slice(0, 50)))).toBe(0);
  });

  it("keeps request volume and output small on a 165+ issue graph", async () => {
    // 1 blocks 40 heads; each head blocks a chain of 3 more: 161 issues.
    const edges: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const head = 10 + i * 4;
      edges.push([head, 1], [head + 1, head], [head + 2, head + 1], [head + 3, head + 2]);
    }
    for (let i = 0; i < 10; i++) edges.push([500 + i, 1], [500 + i, 2]);
    const { impact, report } = await read({ edges });
    expect(report.collection?.telemetry.requests).toBe(3);
    expect(impact.newlyPickable).toHaveLength(40);
    expect(impact.otherBlockersRemain).toHaveLength(10);
    expect(impact.unknown).toEqual([]);
    const json = JSON.stringify({ ...report, impact });
    expect(json.length).toBeLessThan(80_000);
  });

  it("stops dependant reads on a quota refusal and keeps the issue's own answer", async () => {
    const { query: base } = graphQuery({ edges: [[2, 1]] });
    const query: Query = async (source, variables) => {
      if ("n0" in variables)
        throw Object.assign(new Error("rate limited"), { rateLimited: true, retry: {} });
      return base(source, variables);
    };
    const report = await dependencyReport(repo, 1, { impact: true }, query, clock);
    const impact = directImpact(report)!;
    expect(impact.newlyPickable).toEqual([]);
    expect(impact.unknown.join()).toContain("not attempted: GitHub quota refusal");
    expect(impact.nextAction).toContain("unknown, not zero");
    expect(report.collection?.quota).not.toBeNull();
  });

  it("is attached to deps N output but never to --tree", async () => {
    const { query } = graphQuery({ states: { 1: { labels: ["status:ready"] } }, edges: [[2, 1]] });
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      dependencyReport: (r: string, n: number, o?: Parameters<typeof dependencyReport>[2]) =>
        dependencyReport(r, n, o, query, clock),
    };
    let out = "";
    expect(await main(["deps", "1", "--json"], async (t) => void (out = t), runtime)).toBe(0);
    expect(JSON.parse(out).impact.newlyPickable).toMatchObject([{ number: 2 }]);
    expect(await main(["deps", "1"], async (t) => void (out = t), runtime)).toBe(0);
    expect(out).toContain("Next action: Start #1");
    expect(
      await main(["deps", "1", "--tree", "--json"], async (t) => void (out = t), runtime),
    ).toBe(0);
    const tree = JSON.parse(out);
    expect(tree.impact).toBeUndefined();
    expect(tree.direct).toBeUndefined();
    expect(dependencyText(tree)).toContain("explicit, expensive diagnosis");
  });
});

/** 1 blocks 40 heads, each a chain of 3; 2 (claimed) blocks 5; 3 (blocked by 4) blocks 20. */
const repositoryGraph = () => {
  const edges: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const head = 10 + i * 4;
    edges.push([head, 1], [head + 1, head], [head + 2, head + 1], [head + 3, head + 2]);
  }
  for (let i = 0; i < 5; i++) edges.push([300 + i, 2]);
  for (let i = 0; i < 20; i++) edges.push([400 + i, 3]);
  edges.push([3, 4]);
  return {
    states: { 2: { labels: ["status:in-progress", "agent:ana"] } },
    edges,
  };
};

describe("deps --top: repository direct impact (#196)", () => {
  it("ranks what can start now and which completion unlocks most, with bounded reads", async () => {
    const { query, calls } = graphQuery(repositoryGraph());
    const inventory = await readDependencyInventory(repo, {}, query, clock);
    // 189 open issues in 4 pages of 50: request volume follows the inventory, not the graph depth.
    expect(inventory.issues).toHaveLength(189);
    expect(calls).toHaveLength(4);
    expect(inventory.complete).toBe(true);
    const ranked = repositoryImpact(inventory, 5);
    expect(ranked.provisional).toBe(false);
    // Only 1 and 4 have no open blocker; everything else is blocked or claimed.
    expect(ranked.startNow.map((r) => [r.number, r.unlocks.length])).toEqual([
      [1, 40],
      [4, 1],
    ]);
    // 4 is pickable and would unlock 3, which still has 20 dependants of its own.
    expect(ranked.completionUnlocks.map((r) => r.number)).toEqual([3, 2, 10, 11, 12]);
    expect(ranked.completionUnlocks[0].unlocks).toHaveLength(20);
    expect(ranked.completionUnlocks[1].notPickable.join()).toContain("claimed by agent:ana");
    // Never claim or suggest a claimed ticket as new pickup.
    expect(ranked.startNow.map((r) => r.number)).not.toContain(2);
    expect(ranked.nextAction).toMatch(/^Start #1: claim it \(pdb claim 1\)/);
    const text = repositoryImpactText(ranked);
    expect(text).toContain("Can start now (2 of 2;");
    expect(text).toContain("Finish-first (#182)");
    expect(text.length).toBeLessThan(5_000);
    expect(JSON.stringify(ranked).length).toBeLessThan(20_000);
  });

  it("labels a capped inventory provisional and unread dependants unknown, never zero", async () => {
    const { query, calls } = graphQuery(repositoryGraph());
    const inventory = await readDependencyInventory(repo, { maxPages: 1 }, query, clock);
    expect(calls).toHaveLength(1);
    expect(inventory).toMatchObject({ complete: false, stoppedBy: "page-limit", totalOpen: 189 });
    const ranked = repositoryImpact(inventory, 3);
    expect(ranked.provisional).toBe(true);
    expect(ranked.provisionalReasons[0]).toContain("read 50 of 189");
    expect(ranked.nextAction).toMatch(/^Provisional: /);
    const one = ranked.startNow.find((r) => r.number === 1)!;
    // 1's dependants 10..49 were read on page 1; 50..166 were not, so impact is a lower bound.
    expect(one.unknown.length).toBeGreaterThan(0);
    expect(one.unknown[0]).toContain("not in the partial inventory read");
    expect(repositoryImpactText(ranked)).toContain("PROVISIONAL:");
    expect(inventory.collection.coverage[0]).toMatchObject({ state: "partial" });
  });

  it("is a deps --top command that exits 2 when provisional", async () => {
    const { query } = graphQuery(repositoryGraph());
    let out = "";
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      dependencyInventory: (r: string) => readDependencyInventory(r, { maxPages: 1 }, query, clock),
    };
    expect(
      await main(["deps", "--top", "--limit", "2", "--json"], async (t) => void (out = t), runtime),
    ).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ provisional: true, limit: 2 });
    await expect(main(["deps", "--top", "7"], async () => {}, runtime)).rejects.toThrow("--top");
  });
});
