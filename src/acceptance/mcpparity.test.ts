/**
 * CLI/MCP parity for blended role queues (#260, doc/design/mcp.md "Role views").
 *
 * Both front ends read the same fake GitHub boundary through the real collector, with the same
 * configuration, clock and identity, and must report identical role-shaped results.
 */
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { TOML_CONFIG_PATH } from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import { boundedEnvelope, createServer } from "../mcp.js";
import { parityDifference } from "../mcp/parity.js";
import { budgetBytes, resultBytes } from "../mcp/bounded.js";
import type { McpRuntime } from "../mcp.js";
import type { Issue, Page } from "../github/types.js";

const repo = "example/parity";
const time = "2026-11-12T10:00:00.000Z";
const clock = () => new Date(time);
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (n: number, labels: string[], createdAt: string): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
/** Easy win, cross-role boosts, conflicting labels, another agent's claim, design and parked work. */
const issues = (): Issue[] => [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XS", "complexity:XL"], "2026-10-01T00:00:00Z"),
  issue(3, ["status:ready", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
  issue(4, ["status:ready", "impact:XL"], "2026-11-03T00:00:00Z"),
  issue(5, ["status:needs-design", "complexity:XS"], "2026-11-04T00:00:00Z"),
  issue(6, ["status:ready", "complexity:S", "complexity:L"], "2026-11-05T00:00:00Z"),
  issue(7, ["status:ready"], "2026-09-01T00:00:00Z"),
  issue(8, ["status:ready", "agent:other", "impact:S"], "2026-11-07T00:00:00Z"),
  issue(9, ["status:parked", "impact:XL"], "2026-11-08T00:00:00Z"),
];
/** The fake gh GraphQL boundary: every query sees the same repository state. */
const query: Query = async (source) => ({
  repository: {
    issues: page(source.includes("issues(first") ? issues() : []),
    pullRequests: page([]),
  },
});
const root = "/repo";
const files = (config: string | null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;

const runtimeFor = (config: string | null, engineClock = () => 0): McpRuntime => {
  const fs = files(config);
  return {
    collect: (repository, options) => collect(repository, options, query, clock),
    currentRepository: async () => repo,
    dependencyReport: async () => {
      throw new Error("not used");
    },
    estimation: { fs, git, cwd: root },
    guide: { fs, git, cwd: root },
    now: clock,
    engineClock,
    git,
    fs,
    env: {},
  };
};

interface Case {
  role: "implementer" | "designer";
  order: "impact" | "oldest";
  limit: number;
  config: string | null;
}

async function cliResult(c: Case, engineClock = () => 0): Promise<Record<string, unknown>> {
  let out = "";
  const code = await main(
    [
      "--repo",
      repo,
      "--agent",
      "me",
      "--role",
      c.role,
      "--order",
      c.order,
      "--limit",
      String(c.limit),
      "--json",
      "--no-update-check",
    ],
    async (text) => void (out += text),
    {
      ...runtimeFor(c.config, engineClock),
      updateCheck: async () => ({ status: "disabled" }) as never,
    },
  );
  expect(code).toBe(0);
  return JSON.parse(out) as Record<string, unknown>;
}

async function mcpResult(
  c: Case,
  omitLimit = false,
): Promise<{ result: Record<string, unknown>; text: string; omitted: Record<string, number> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ repo }, runtimeFor(c.config)).connect(serverSide);
  const client = new Client({ name: "parity", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const raw = await client.callTool({
      name: "triage_briefing",
      arguments: {
        agent: "me",
        role: c.role,
        order: c.order,
        ...(omitLimit ? {} : { limit: c.limit }),
      },
    });
    const parsed = boundedEnvelope.parse(raw.structuredContent);
    expect(parsed.status).toBe("complete");
    // Shared report fields keep their CLI values; only the byte budget (#266) may shorten lists.
    expect(parsed.presentation.truncatedFields).toEqual([]);
    const first: unknown = Array.isArray(raw.content) ? raw.content[0] : undefined;
    const text =
      typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
    return { result: parsed.data ?? {}, text, omitted: parsed.presentation.omitted };
  } finally {
    await client.close();
  }
}

const shared = ["actions", "role", "rankedActions", "estimation", "impactEstimation"] as const;

/** CLI parity under the MCP byte budget (#266): see src/mcp/parity.ts. */
function expectParity(
  mcp: { result: Record<string, unknown>; omitted: Record<string, number> },
  cli: Record<string, unknown>,
): void {
  for (const key of shared)
    expect(parityDifference(key, mcp.result[key], cli[key], mcp.omitted), key).toBeNull();
}

const kinds = (result: Record<string, unknown>): string[] =>
  ((result.rankedActions as { items: { kind: string; target: string }[] } | null)?.items ?? []).map(
    (i) => `${i.kind}#${i.target.split("/").pop()}`,
  );

describe("CLI and MCP report identical blended queues (#260)", () => {
  it("reproduces the load-dependent diagnostic mismatch with an injected timer, while fixed timers preserve parity (#724)", async () => {
    const c: Case = { role: "implementer", order: "impact", limit: 20, config: null };
    let tick = 0;
    const slow = await cliResult(c, () => tick++ * 2001);
    const mcp = await mcpResult(c);
    const slowRanking = slow.rankedActions as {
      items: unknown[];
      decisionEngine: { diagnostics: string[] };
    };
    const mcpRanking = mcp.result.rankedActions as {
      items: unknown[];
      decisionEngine: { diagnostics: string[] };
    };
    expect(slowRanking.decisionEngine.diagnostics).toEqual([
      "evaluation exceeded soft 2000ms budget (2001ms)",
    ]);
    expect(mcpRanking.decisionEngine.diagnostics).toEqual([]);
    expect(slowRanking.items.slice(0, mcpRanking.items.length)).toEqual(mcpRanking.items);
    expect(mcp.omitted["rankedActions.items"]).toBe(
      slowRanking.items.length - mcpRanking.items.length,
    );
    expect(
      parityDifference("rankedActions", mcp.result.rankedActions, slow.rankedActions, mcp.omitted),
    ).toBe("rankedActions: differs from the CLI");
    expectParity(mcp, await cliResult(c));
  });

  for (const role of ["implementer", "designer"] as const)
    for (const order of ["impact", "oldest"] as const)
      for (const limit of [20, 3])
        it(`${role}, order ${order}, limit ${limit}`, async () => {
          const c: Case = { role, order, limit, config: null };
          const cli = await cliResult(c);
          const mcp = await mcpResult(c);
          expectParity(mcp, cli);
          // The compared objects exist, not two equally absent fields.
          // impactEstimation is designer-only (#246); the implementer gets estimation (#259).
          const present = shared.filter((k) => role === "designer" || k !== "impactEstimation");
          for (const key of present) expect(cli[key], key).toBeTruthy();
          if (role === "implementer") expect(cli.impactEstimation).toBeUndefined();
          // The role queue is real, not two equally empty results.
          const ranked = cli.rankedActions as { total: number; omitted: number; items: unknown[] };
          expect(ranked.items.length).toBe(Math.min(limit, ranked.total));
          expect(ranked.omitted).toBe(ranked.total - ranked.items.length);
          // Assessments appear in ordinary role views without --estimate.
          const assessment = role === "implementer" ? "estimate-complexity" : "assess-impact";
          if (limit === 20) expect(kinds(cli).some((k) => k.startsWith(assessment))).toBe(true);
          // Rendered next steps agree: every returned action target appears in the text.
          for (const target of (mcp.result.actions as { items: string[] }).items)
            expect(mcp.text).toContain(target);
        });

  it("keeps claim recovery commands and another agent's claim identical", async () => {
    const c: Case = { role: "implementer", order: "impact", limit: 20, config: null };
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    const items = (mcp.result.rankedActions as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      kind: "implement",
      nextCommand: `pdb claim 1 --repo ${repo} --agent me`,
    });
    expect(kinds(mcp.result)).not.toContain("implement#8");
    expectParity(mcp, cli);
  });

  it("agrees when a metric is disabled", async () => {
    const config = "schemaVersion = 1\n[complexity]\nenabled = false\n";
    const c: Case = { role: "implementer", order: "impact", limit: 20, config };
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    expectParity(mcp, cli);
    expect(kinds(cli).some((k) => k.startsWith("estimate-complexity"))).toBe(false);
  });

  it("orders pickup by age under oldest in both front ends", async () => {
    const c: Case = { role: "implementer", order: "oldest", limit: 20, config: null };
    const pickup = (result: Record<string, unknown>) =>
      kinds(result).filter((k) => k.startsWith("implement#"));
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    expect(pickup(mcp.result)).toEqual(pickup(cli).slice(0, pickup(mcp.result).length));
    expect(pickup(cli)[0]).toBe("implement#7");
  });

  it("rejects role and order in briefing mode and unknown roles", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtimeFor(null)).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      for (const args of [{ mode: "briefing", role: "implementer" }, { role: "owner" }]) {
        const result = await client.callTool({ name: "triage_briefing", arguments: args });
        expect(result.isError).toBe(true);
      }
      const { tools } = await client.listTools();
      const props = tools.find((t) => t.name === "triage_briefing")?.inputSchema.properties ?? {};
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["role", "order"]));
    } finally {
      await client.close();
    }
  });

  it("uses the same implementer queue by default when no role is supplied", async () => {
    const mcp = await mcpResult({ role: "implementer", order: "impact", limit: 5, config: null });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtimeFor(null)).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    const plain = boundedEnvelope.parse(
      (await client.callTool({ name: "triage_briefing", arguments: { agent: "me", limit: 5 } }))
        .structuredContent,
    );
    await client.close();
    expect(plain.data?.rankedActions).toEqual(mcp.result.rankedActions);
    expect(plain.data?.decisionEngine).toMatchObject({
      used: "datalog",
      role: { used: "implementer", source: "default" },
    });
    expect(mcp.result.rankedActions).not.toBeNull();
  });
});

it("uses ten MCP next actions when limit is omitted, matching the CLI default", async () => {
  const c: Case = { role: "implementer", order: "impact", limit: 10, config: null };
  const mcp = await mcpResult(c, true),
    cli = await cliResult(c);
  const ranked = cli.rankedActions as { items: unknown[] };
  expect(ranked.items.length).toBe(10);
  expectParity(mcp, cli);
});

describe("--section and the MCP section input report the same section (#311)", () => {
  let count = 8;
  const pickupIssues = () =>
    Array.from({ length: count }, (_, i) =>
      issue(
        20 + i,
        ["status:ready"],
        new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000).toISOString(),
      ),
    );
  const runtime = (): McpRuntime => ({
    ...runtimeFor(null),
    collect: (repository, options) =>
      collect(
        repository,
        options,
        async (source) => ({
          repository: {
            issues: page(source.includes("issues(first") ? pickupIssues() : []),
            pullRequests: page([]),
          },
        }),
        clock,
      ),
  });
  it("lifts the pickup row cap identically in both front ends", async () => {
    let out = "";
    const code = await main(
      [
        "--repo",
        repo,
        "--agent",
        "me",
        "--role",
        "implementer",
        "--section",
        "pickup",
        "--json",
        "--no-update-check",
      ],
      async (text) => void (out += text),
      { ...runtime(), updateCheck: async () => ({ status: "disabled" }) as never },
    );
    expect(code).toBe(0);
    const cli = JSON.parse(out) as {
      focus: { section: string; total: number; items: { url: string }[] };
    };
    expect(cli.focus).toMatchObject({ section: "pickup", total: 8, shown: 8, omitted: 0 });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtime()).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const raw = await client.callTool({
        name: "triage_briefing",
        arguments: { agent: "me", role: "implementer", section: "pickup" },
      });
      const parsed = boundedEnvelope.parse(raw.structuredContent);
      expect((parsed.data as { focus: unknown }).focus).toEqual(cli.focus);
      // Section-only text, like CLI --section: no next actions or other context.
      const first: unknown = Array.isArray(raw.content) ? raw.content[0] : undefined;
      const text =
        typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
      expect(text).toContain("Section pickup of role implementer (8 shown of 8):");
      expect(text).not.toContain("Next actions");
      const bad = await client.callTool({
        name: "triage_briefing",
        arguments: { role: "implementer", section: "nope" },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toMatch(/must be one of: addressed, pr-follow-up/);
      // Role omitted: validated after the default role resolves, with the same choices.
      const deferred = await client.callTool({
        name: "triage_briefing",
        arguments: { section: "nope" },
      });
      const envelope = boundedEnvelope.parse(deferred.structuredContent);
      expect(envelope.error).toMatchObject({
        code: "invalid-argument",
        message: expect.stringMatching(/--section for role implementer must be one of: addressed/),
      });
    } finally {
      await client.close();
    }
  });

  it("reports the rows actually returned when the transport budget prunes the section", async () => {
    // The default text budget forces whole-result row pruning with this bounded fixture.
    count = 64;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtime()).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const raw = await client.callTool({
        name: "triage_briefing",
        arguments: { agent: "me", role: "implementer", section: "pickup", maxChars: 10000 },
      });
      const parsed = boundedEnvelope.parse(raw.structuredContent);
      const focus = (
        parsed.data as {
          focus: { total: number; shown: number; omitted: number; items: unknown[] };
        }
      ).focus;
      expect(parsed.status).toBe("complete");
      expect(resultBytes(raw)).toBeLessThanOrEqual(budgetBytes);
      expect(focus.total).toBe(count);
      expect(focus.items.length).toBeGreaterThan(0);
      expect(focus.items.length).toBeLessThan(count);
      expect(focus.shown).toBe(focus.items.length);
      expect(focus.omitted).toBe(count - focus.items.length);
      expect(parsed.presentation.omitted["focus.items"]).toBe(focus.omitted);
      expect(JSON.stringify(raw.content)).toContain(`(${focus.shown} shown of ${focus.total})`);
    } finally {
      count = 8;
      await client.close();
    }
  });
});

describe("--label and the MCP label input filter identically (#312)", () => {
  const labelled = (): Issue[] => [
    issue(30, ["status:ready", "sfx"], "2026-10-01T00:00:00Z"),
    issue(31, ["status:ready"], "2026-10-02T00:00:00Z"),
    issue(32, ["status:ready", "sfx"], "2026-10-03T00:00:00Z"),
  ];
  const repoLabels = ["status:ready", "sfx"];
  /** Collection and label resolution through the same fake gh boundary. */
  const labelQuery =
    (fail = false): Query =>
    async (source, vars) => {
      if (source.includes("label(name:")) {
        if (fail) throw Object.assign(new Error("boom"), { evidence: { category: "timeout" } });
        const repository: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(vars))
          if (/^l\d$/.test(key)) {
            repository[key] = repoLabels.includes(String(value)) ? { name: value } : null;
            repository[`s${key.slice(1)}`] = { nodes: [], pageInfo: { hasNextPage: false } };
          }
        return { repository };
      }
      return {
        repository: {
          issues: page(source.includes("issues(first") ? labelled() : []),
          pullRequests: page([]),
        },
      };
    };
  const runtime = (fail = false): McpRuntime => ({
    ...runtimeFor(null),
    query: labelQuery(fail),
    collect: (repository, options) => collect(repository, options, labelQuery(), clock),
  });
  const mcp = async (args: Record<string, unknown>, fail = false) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtime(fail)).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      return boundedEnvelope.parse(
        (await client.callTool({ name: "triage_briefing", arguments: args })).structuredContent,
      );
    } finally {
      await client.close();
    }
  };

  it("reports the same scoped actions and filter object", async () => {
    let out = "";
    const code = await main(
      [
        "--repo",
        repo,
        "--agent",
        "me",
        "--role",
        "implementer",
        "--label",
        "sfx",
        "--json",
        "--no-update-check",
      ],
      async (text) => void (out += text),
      { ...runtime(), updateCheck: async () => ({ status: "disabled" }) as never },
    );
    expect(code).toBe(0);
    const cli = JSON.parse(out) as { filter: unknown; actions: { items: string[] } };
    expect(cli.actions.items.map((u) => u.split("/").pop())).toEqual(["30", "32"]);
    const envelope = await mcp({ agent: "me", role: "implementer", label: ["sfx"] });
    const data = envelope.data as { filter: unknown; actions: { items: string[] } };
    expect(data.filter).toEqual(cli.filter);
    expect(data.actions.items).toEqual(cli.actions.items);
  });

  it("an unknown label is an argument error; a failed lookup is an unresolved filter", async () => {
    expect((await mcp({ role: "implementer", label: ["nope"] })).error).toMatchObject({
      code: "invalid-argument",
      message: expect.stringMatching(/Unknown label\(s\) in example\/parity: nope/),
    });
    expect((await mcp({ role: "implementer", label: ["sfx"] }, true)).error).toMatchObject({
      code: "label-filter-unresolved",
      message: expect.stringMatching(/not proof the label is absent/),
    });
  });
});
