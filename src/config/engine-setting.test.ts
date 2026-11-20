import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { boundedEnvelope, createServer } from "../mcp.js";
import { describe, it, expect } from "vite-plus/test";
import { parseConfig, settingFor } from "./config.js";
import {
  BriefingEngineError,
  engineFailure,
  resolveEngineSetting,
  safeEngineCause,
  safeEngineCauseText,
} from "./engine-setting.js";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { presentBriefing, readBriefing } from "../briefing/service.js";
import { main } from "../cli.js";
import { dependencyReport } from "../github/dependencies.js";
import type { Issue, Snapshot } from "../github/types.js";
const item: Issue = {
  number: 1,
  title: "An available job",
  url: "https://github.com/example/project/issues/1",
  body: "",
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: { nodes: [{ name: "status:ready" }], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  blocking: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
const snapshot: Snapshot = {
  schemaVersion: 1,
  repository: "example/project",
  startedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  issues: [item],
  pullRequests: [],
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
};
const local = (raw = 'schemaVersion = 1\n[briefing]\nengine = "datalog"\n') => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit(snapshot.repository),
  fs: {
    ...emptyFileSystem,
    readText: async (path: string) => (path.endsWith("triage.toml") ? raw : null),
  },
});
describe("repository-scoped experimental engine selection", () => {
  it("has no engine selector: a stored briefing.engine is a retired key (#1050)", () => {
    expect(() =>
      settingFor(parseConfig('{"schemaVersion":1}', undefined), "briefing.engine"),
    ).toThrow();
    // Any stored value, including the old datalog default, is reported and ignored, never applied.
    for (const value of ["typescript", "datalog", "invented"])
      expect(
        parseConfig(`{"schemaVersion":1,"briefing":{"engine":"${value}"}}`, undefined).retired,
      ).toEqual(["briefing.engine"]);
  });
  it("uses only a matching selected checkout and never reads another repo settings", async () => {
    const stale = await resolveEngineSetting(snapshot.repository, local());
    expect(stale).toMatchObject({ requested: "datalog", source: "default" });
    // The obsolete key and its file are named, with a removal that keeps unrelated settings.
    expect(stale.obsolete?.join(" ")).toContain("contains the retired key briefing.engine");
    expect(stale.obsolete?.join(" ")).toContain(
      "Remove it: pdb config set complexity.enabled true",
    );
    expect(stale.obsolete?.join(" ")).not.toContain("config set briefing.engine");
    expect(
      (await resolveEngineSetting(snapshot.repository, local("schemaVersion = 1\n"))).obsolete,
    ).toBeUndefined();
    expect(await resolveEngineSetting("another/repo", local())).toMatchObject({
      requested: "datalog",
      source: "no-matching-project",
    });
    expect(await resolveEngineSetting(snapshot.repository)).toMatchObject({
      requested: "datalog",
      source: "no-matching-project",
    });
    await expect(resolveEngineSetting(snapshot.repository, local("garbage"))).rejects.toThrow(
      "no decision engine was run",
    );
  });
  it("reports a stored retired engine key on the native briefing and never loads it for intake", async () => {
    const never = async () => {
      throw new Error("evaluator initialized");
    };
    const stale = await resolveEngineSetting(
      snapshot.repository,
      local('schemaVersion = 1\n[briefing]\nengine = "typescript"\n'),
    );
    const normal = await presentBriefing(
      snapshot,
      { limit: 10, maxChars: 10000, engineSetting: stale },
      local(),
      new Date(),
    );
    expect(normal.report.decisionEngine).toMatchObject({ requested: "datalog", used: "datalog" });
    expect(normal.report.decisionEngine.diagnostics.join(" ")).toContain(
      "contains the retired key briefing.engine",
    );
    const intake = await presentBriefing(
      snapshot,
      {
        limit: 10,
        maxChars: 10000,
        issue: 1,
        engineSetting: { requested: "datalog", source: "config" },
      },
      local(),
      new Date(),
      undefined,
      undefined,
      undefined,
      never,
    );
    expect(intake.report.decisionEngine.used).toBe("typescript");
  });
  it("requires a supported role and never falls back after evaluator failure", async () => {
    const selected = {
      limit: 10,
      maxChars: 10000,
      engineSetting: { requested: "datalog" as const, source: "config" as const },
    };
    await expect(
      presentBriefing(snapshot, { ...selected, role: "unsupported" }, local()),
    ).rejects.toThrow("--role implementer");
    await expect(
      presentBriefing(
        snapshot,
        { ...selected, role: "implementer" },
        local(),
        new Date(),
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("fixture engine failure");
        },
      ),
    ).rejects.toThrow("fixture engine failure");
  });
  it("uses the same actual Datalog actions and explanation text through CLI and shared MCP read service", async () => {
    const runtime = {
      collect: async () => snapshot,
      currentRepository: async () => snapshot.repository,
      guide: local(),
      estimation: local(),
    };
    let json = "";
    await main(
      ["--repo", snapshot.repository, "--role", "implementer", "--json", "--no-update-check"],
      async (t) => {
        json = t;
      },
      runtime,
    );
    const cli = JSON.parse(json) as {
      decisionEngine: { used: string };
      rankedActions: { items: { why: { text: string } }[] };
    };
    expect(cli.decisionEngine.used).toBe("datalog");
    const result = await readBriefing(
      { ...runtime, dependencyReport },
      {
        repository: snapshot.repository,
        role: "implementer",
        limit: 10,
        maxChars: 10000,
        context: true,
      },
    );
    expect(result.kind).toBe("report");
    if (result.kind !== "report") throw new Error("expected report");
    // Compared as wire JSON: the in-process rank partition (#652) is a symbol, never output.
    expect(
      JSON.parse(JSON.stringify("rankedActions" in result.report && result.report.rankedActions)),
    ).toEqual(cli.rankedActions);
    expect(result.text).toContain(cli.rankedActions.items[0].why.text);
    expect(result.text).toContain("Decision engine: Datalog");
  });
});

it("keeps background parked context without restoring TypeScript next actions", async () => {
  const parked = {
    ...item,
    number: 2,
    url: item.url.replace("/1", "/2"),
    title: "Parked work",
    labels: { ...item.labels, nodes: [{ name: "status:parked" }] },
  };
  const built = await presentBriefing(
    { ...snapshot, issues: [parked] },
    {
      role: "implementer",
      limit: 10,
      maxChars: 10000,
      context: true,
      engineSetting: { requested: "datalog", source: "config" },
    },
    local(),
  );
  expect(built.text).toContain("Parked work");
  expect(built.text).toContain("Parked; not a next step.");
  expect("rankedActions" in built.report && built.report.rankedActions?.items).toEqual([]);
});
it("preserves config repair guidance instead of an unusable rollback", async () => {
  try {
    await resolveEngineSetting(snapshot.repository, local("not valid TOML"));
    throw new Error("expected config refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("Roll back:");
    expect((error as Error).message).toContain("configuration");
  }
});

it("returns sanitized MCP configuration repair guidance without an unusable rollback", async () => {
  const broken = local('schemaVersion = 1\n[complexity]\nenabled = "invalid"\n');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    { repo: snapshot.repository, project: SYNTHETIC_ROOT },
    {
      collect: async () => snapshot,
      currentRepository: async () => snapshot.repository,
      dependencyReport,
      guide: broken,
      estimation: broken,
      fs: broken.fs,
      git: broken.git,
      env: {},
    },
  );
  await server.connect(serverSide);
  const client = new Client({ name: "config-recovery-regression", version: "1" });
  await client.connect(clientSide);
  try {
    const raw = await client.callTool({
      name: "triage_briefing",
      arguments: { agent: "tester", role: "implementer" },
    });
    const result = boundedEnvelope.parse(raw.structuredContent);
    expect(raw.isError).toBe(true);
    expect(result.status).toBe("error");
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("decision-engine-config");
    const rendered = JSON.stringify(raw);
    expect(rendered).toContain("repair guidance");
    expect(rendered.toLowerCase()).not.toContain("rollback");
    expect(rendered).not.toContain("config set briefing.engine typescript");
    expect(rendered).not.toContain(SYNTHETIC_ROOT);
  } finally {
    await client.close();
    await server.close();
  }
});

it("defaults to an explicitly reported implementer view without inferring identity", async () => {
  const result = await presentBriefing(snapshot, { limit: 10, maxChars: 10000 }, local());
  expect(result.report.decisionEngine).toMatchObject({
    used: "datalog",
    role: { used: "implementer", source: "default" },
  });
  expect("role" in result.report && result.report.role?.name).toBe("implementer");
  expect(result.text).toContain("No --agent given");
});

const missingDatascript = () =>
  engineFailure(
    Object.assign(
      new Error("Cannot find package 'datascript' imported from /private/home/x/dist/datalog.mjs"),
      { code: "ERR_MODULE_NOT_FOUND" },
    ),
    "unused",
  );

it("carries a missing engine module's safe cause into the MCP error envelope (#346)", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    { repo: snapshot.repository, project: SYNTHETIC_ROOT },
    {
      collect: async () => snapshot,
      // Injected local configuration readers: nothing reads the real checkout's config.
      guide: local(),
      estimation: local(),
      fs: local().fs,
      git: local().git,
      loadEngine: async () => {
        throw Object.assign(
          new Error("Cannot find package 'datascript' imported from /private/home/x/dist/d.mjs"),
          { code: "ERR_MODULE_NOT_FOUND" },
        );
      },
      currentRepository: async () => snapshot.repository,
      dependencyReport,
      env: {},
    },
  );
  await server.connect(serverSide);
  const client = new Client({ name: "engine-cause", version: "1" });
  await client.connect(clientSide);
  try {
    const raw = await client.callTool({
      name: "triage_briefing",
      arguments: { agent: "tester", role: "implementer" },
    });
    expect(missingDatascript()).toBeInstanceOf(BriefingEngineError);
    const result = boundedEnvelope.parse(raw.structuredContent);
    expect(raw.isError).toBe(true);
    expect(result.error).toMatchObject({
      code: "decision-engine-failed",
      cause: {
        category: "missing-module",
        module: "datascript",
        recovery: ["npm ci", "pdb doctor"],
      },
    });
    expect(result.error?.message).toMatch(/Missing module datascript.*npm ci.*pdb doctor/);
    const rendered = JSON.stringify(raw);
    expect(rendered).not.toContain("/private/home");
    expect(rendered).not.toContain("Cannot find package");
  } finally {
    await client.close();
    await server.close();
  }
});

const scopeBound = () =>
  Object.assign(
    new Error(
      "experimental-scope-exceeded: at most 500 subjects are supported. No other scheduler was run.",
    ),
    { code: "experimental-scope-exceeded" },
  );

it("names the engine's subject bound instead of suggesting dependency repair (#1132)", () => {
  const failure = engineFailure(scopeBound(), "unused");
  expect(failure.code).toBe("decision-engine-failed");
  expect(failure.message).toContain("500 subjects");
  expect(failure.message).toContain("capacity limit");
  expect(failure.message).toContain("not a missing dependency");
  expect(failure.message).not.toContain("pdb doctor checks");
  expect(safeEngineCause(failure)).toEqual({
    category: "scope-limit",
    limit: 500,
    unit: "subjects",
    recovery: ["pdb --issue N"],
  });
});

it("keeps an unstated scope bound typed but without inventing a number (#1132)", () => {
  const failure = engineFailure(
    Object.assign(new Error("experimental-scope-exceeded: unknown bound"), {
      code: "experimental-scope-exceeded",
    }),
    "unused",
  );
  expect(safeEngineCause(failure)).toMatchObject({
    category: "scope-limit",
    limit: null,
    unit: null,
  });
  expect(safeEngineCauseText(safeEngineCause(failure)!)).toContain("documented number of subjects");
});

it("carries the subject-limit diagnosis into the MCP error envelope (#1132)", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    { repo: snapshot.repository, project: SYNTHETIC_ROOT },
    {
      collect: async () => snapshot,
      currentRepository: async () => snapshot.repository,
      dependencyReport,
      guide: local(),
      estimation: local(),
      fs: local().fs,
      git: local().git,
      env: {},
      loadEngine: async () => {
        throw scopeBound();
      },
    },
  );
  await server.connect(serverSide);
  const client = new Client({ name: "scope-limit", version: "1" });
  await client.connect(clientSide);
  try {
    const raw = await client.callTool({
      name: "triage_briefing",
      arguments: { agent: "tester", role: "implementer" },
    });
    const result = boundedEnvelope.parse(raw.structuredContent);
    expect(raw.isError).toBe(true);
    expect(result.error).toMatchObject({
      code: "decision-engine-failed",
      cause: { category: "scope-limit", limit: 500, unit: "subjects" },
    });
    expect(result.error?.message).toContain("at most 500 subjects");
    expect(result.error?.message).toContain("capacity limit");
    // The dependency-repair advice belongs to a missing module, never to a capacity bound.
    expect(result.error?.message).not.toContain("pdb doctor checks the engine's dependencies");
    expect(result.error?.message).not.toContain("No other scheduler was run");
  } finally {
    await client.close();
    await server.close();
  }
});
