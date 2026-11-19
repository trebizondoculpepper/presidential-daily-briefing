import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { main } from "../cli.js";
import { dependencyReport } from "../github/dependencies.js";
import { CONFIG_PATH, type GitRunner } from "../config/config.js";
import type { Issue } from "../github/types.js";
import { clock, issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";
import { graphQuery } from "../testing/fakegh.js";

describe("read-only MCP adapter (#25)", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { createServer, boundedEnvelope, mcpArguments, redactLocalText, redactPaths } =
    await import("../mcp.js");
  const { flattenRelationships } = await import("../mcp/views.js");
  const { IssueUnavailable } = await import("../github/github.js");
  type Runtime = import("../mcp.js").McpRuntime;
  type Options = import("../mcp.js").McpOptions;

  const fake = (overrides: Partial<Runtime> = {}): Runtime & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      currentRepository: async () => repo,
      collect: async (repository: string, options?: { issue?: number; since?: string }) => {
        seen.push(`${repository}#${options?.issue ?? "-"}@${options?.since ?? "-"}`);
        return { ...snapshot(), repository };
      },
      dependencyReport: (r: string, n: number, o?: { tree?: boolean }) =>
        dependencyReport(r, n, o, graphQuery({ edges: [[1, 2]] }).query, clock),
      // A fixed clock keeps freshness ages identical between the MCP and CLI reads.
      now: clock,
      ...overrides,
    };
  };
  const connect = async (runtime: Runtime, options: Options = {}) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(options, runtime).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };
  const structured = (result: { structuredContent?: unknown }) =>
    boundedEnvelope.parse(result.structuredContent);
  const text = (result: { content?: unknown }): string => {
    const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
    return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
  };

  it("reads the guide opt-out from --project, not the server's working directory", async () => {
    const { defaultRuntime } = await import("../mcp.js");
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const project = await mkdtemp(join(tmpdir(), "triage-guide-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], {
        cwd: project,
      });
      await mkdir(join(project, ".github"), { recursive: true });
      await writeFile(join(project, CONFIG_PATH), '{"schemaVersion":1,"processGuide":false}');
      expect(process.cwd()).not.toBe(project);
      const runtime: Runtime = {
        ...defaultRuntime({ project }),
        collect: async (repository: string) => ({ ...snapshot(), repository }),
        // The injected snapshot is the read: no live shortlist collection (#368).
        collectShortlist: undefined,
        now: clock,
      };
      const client = await connect(runtime, { project, repo });
      const brief = structured(await client.callTool({ name: "triage_briefing", arguments: {} }));
      await client.close();
      const mcpProcess = (brief.data as { process: unknown }).process;
      expect(mcpProcess).toMatchObject({ enabled: false, source: "config", guide: null });
      let out = "";
      await main(
        ["--repo", repo, "--json", "--no-update-check"],
        async (t) => void (out = t),
        runtime,
      );
      expect(mcpProcess).toEqual(JSON.parse(out).process);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  /**
   * Older-client compatibility (doc/design/mcp.md): a raw JSON-RPC exchange, as an older host
   * would send it, rather than the current SDK client, which always offers the latest version.
   */
  const rawSession = async (protocolVersion: string) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, fake()).connect(serverSide);
    const replies = new Map<number, { result?: Record<string, unknown>; error?: unknown }>();
    const waiting = new Map<number, () => void>();
    clientSide.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      replies.set(message.id, message as { result?: Record<string, unknown>; error?: unknown });
      waiting.get(message.id)?.();
    };
    await clientSide.start();
    let next = 0;
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++next;
      const replied = new Promise<void>((done) => waiting.set(id, done));
      await clientSide.send({ jsonrpc: "2.0", id, method, params });
      await replied;
      const reply = replies.get(id);
      if (!reply?.result) throw new Error(`${method} failed: ${JSON.stringify(reply?.error)}`);
      return reply.result;
    };
    const init = await request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "older-host", version: "0.0.1" },
    });
    await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { init, request, close: () => clientSide.close() };
  };

  for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    it(`negotiates ${version} for an older client and serves tools/list and tools/call`, async () => {
      const session = await rawSession(version);
      expect(session.init.protocolVersion).toBe(version);
      expect(session.init.serverInfo).toMatchObject({ name: "pdb" });
      const { tools } = (await session.request("tools/list")) as { tools: { name: string }[] };
      expect(tools.map((t) => t.name).sort()).toEqual([
        "triage_briefing",
        "triage_dependencies",
        "triage_discussion",
        "triage_events",
        "triage_issue",
      ]);
      const call = (await session.request("tools/call", {
        name: "triage_briefing",
        arguments: {},
      })) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      expect(call.isError).not.toBe(true);
      // Clients that predate structuredContent (before 2025-06-18) still get usable text.
      expect(text(call)).toContain(repo);
      expect(structured(call)).toMatchObject({ view: "briefing", status: "complete" });
      await session.close();
    });
  }

  it("answers an unsupported protocol version with its own latest, not a silent downgrade", async () => {
    const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/server");
    const session = await rawSession("2023-01-01");
    // Per the MCP lifecycle the client must then disconnect; the server never claims 2023-01-01.
    expect(session.init.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    await session.close();
  });

  it("lists exactly four read-only tools with strict inputs", async () => {
    const client = await connect(fake());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "triage_briefing",
      "triage_dependencies",
      "triage_discussion",
      "triage_events",
      "triage_issue",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    await client.close();
  });

  it("projects the CLI's versioned JSON for briefing, issue and dependencies (#266)", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo });
    const cli = async (args: string[]) => {
      let out = "";
      await main([...args, "--json", "--no-update-check"], async (t) => void (out = t), runtime);
      return JSON.parse(out);
    };
    const brief = structured(await client.callTool({ name: "triage_briefing", arguments: {} }));
    expect(brief).toMatchObject({
      schemaVersion: 2,
      kind: "mcp-read-result",
      tool: "triage_briefing",
      view: "briefing",
      status: "complete",
      selection: { repository: repo, agent: null, identitySource: "unresolved" },
      presentation: { omitted: {}, truncatedFields: [], next: null },
      error: null,
    });
    const { checkpoint: _, ...cliBrief } = await cli(["--repo", repo]);
    const expected = redactPaths(cliBrief, [process.cwd()]);
    // Carried fields keep their CLI values; local paths in diagnostics are redacted.
    const data = brief.data as Record<string, unknown>;
    for (const key of ["summary", "actions", "sections", "rankedActions", "estimation", "process"])
      expect(data[key], key).toEqual(expected[key]);
    expect(brief.freshness).toEqual(expected.freshness);
    expect(brief.sourceCompleteness).toEqual(expected.completeness);
    expect((data.subjects as unknown[]).length).toBe(expected.subjects.length);
    const intake = structured(
      await client.callTool({ name: "triage_issue", arguments: { number: 1, agent: "ana" } }),
    );
    const { checkpoint: __, ...cliIssue } = await cli([
      "--repo",
      repo,
      "--issue",
      "1",
      "--agent",
      "ana",
    ]);
    expect(intake).toMatchObject({
      view: "issue",
      subject: { type: "issue", number: 1 },
      selection: { agent: "ana", identitySource: "tool" },
    });
    const issueData = intake.data as {
      issue: Record<string, unknown>;
      counts: Record<string, number>;
    };
    expect(issueData.issue).toMatchObject({
      number: cliIssue.detail.number,
      title: cliIssue.detail.title,
      state: cliIssue.detail.state,
      labels: cliIssue.detail.labels.nodes.map((l: { name: string }) => l.name),
    });
    expect(issueData.counts.comments).toBe(cliIssue.detail.comments.nodes.length);
    const deps = structured(
      await client.callTool({ name: "triage_dependencies", arguments: { number: 1, tree: true } }),
    );
    const cliDeps = await cli(["deps", "1", "--tree", "--repo", repo]);
    expect((deps.data as { relationships: unknown }).relationships).toEqual(
      flattenRelationships(cliDeps, 1),
    );
    expect(deps.data).toMatchObject({ tree: true, cycles: cliDeps.cycles });
    // A walk that read everything reachable is complete (#196).
    expect(cliDeps.treeBounds).toMatchObject({ complete: true });
    expect(deps.status).toBe("complete");
    await client.close();
  });

  it("keeps collected PR evidence in an explicit pullRequests section (#266)", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo });
    let out = "";
    await main(
      ["--repo", repo, "--issue", "1", "--json", "--no-update-check"],
      async (t) => void (out = t),
      runtime,
    );
    const cliIssue = JSON.parse(out) as {
      subjects: { url: string; pullRequest?: unknown }[];
    };
    const expected = cliIssue.subjects.find((subject) => subject.url === pr().url)?.pullRequest;
    expect(expected).toBeTruthy();
    const result = structured(
      await client.callTool({
        name: "triage_issue",
        arguments: { number: 1, section: "pullRequests" },
      }),
    );
    const rows = (result.data as { rows: { url: string; pullRequest: unknown }[] }).rows;
    expect(rows.map((row) => row.url)).toEqual([pr().url]);
    expect(rows[0]?.pullRequest).toEqual(expected);
    expect(JSON.stringify(rows[0]?.pullRequest)).toContain("verify");
    await client.close();
  });

  it("bounds triage_issue text to maxChars and pages long discussion with visible shortening", async () => {
    const long = "x".repeat(4000);
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: { login: `user${i}` },
      body: `comment ${i} ${long}`,
      createdAt: time,
      url: `${issue().url}#issuecomment-${i}`,
    }));
    const big = { ...issue(1), body: `body ${long}`, comments: page(comments) } as unknown as Issue;
    const runtime = fake({
      collect: async (repository: string) => ({ ...snapshot([big]), repository }),
    });
    const client = await connect(runtime, { repo });
    const result = await client.callTool({
      name: "triage_issue",
      arguments: { number: 1, maxChars: 2000 },
    });
    const body = text(result);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toContain("Bounded MCP result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_384);
    expect(structured(result).data).toMatchObject({ counts: { comments: 30 } });
    const seen: string[] = [];
    let args: Record<string, unknown> | null = { number: 1, section: "discussion", limit: 100 };
    while (args) {
      const pageResult = structured(
        await client.callTool({ name: "triage_issue", arguments: args }),
      );
      const rows = (pageResult.data as { rows: { url: string; body: string }[] }).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.body).toMatch(/… \[truncated\]$/);
      expect(pageResult.presentation.truncatedFields.length).toBeGreaterThanOrEqual(rows.length);
      seen.push(...rows.map((row) => row.url));
      args = pageResult.presentation.next?.arguments ?? null;
    }
    expect(seen).toEqual(comments.map((c) => c.url));
    await client.close();
  });

  it("rejects unknown properties and out-of-range values before collection", async () => {
    const runtime = fake();
    const client = await connect(runtime);
    for (const [name, args] of [
      ["triage_briefing", { path: "/etc" }],
      ["triage_briefing", { limit: 0 }],
      ["triage_briefing", { maxChars: 50 }],
      ["triage_briefing", { since: "2026-11-12" }],
      ["triage_issue", { number: -1 }],
      ["triage_issue", {}],
      ["triage_dependencies", { number: 1, repo: "not a repo" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args }).catch((error) => ({
        isError: true,
        thrown: error,
      }));
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(runtime.seen).toEqual([]);
    await client.close();
  });

  it("keeps per-call selection: tool repo/agent win and concurrent calls do not interfere", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo: "start/default", agent: "boot" });
    const [a, b, c] = await Promise.all([
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/a" } }),
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/b", agent: "zed" } }),
      client.callTool({ name: "triage_briefing", arguments: {} }),
    ]);
    expect(structured(a).selection).toMatchObject({
      repository: "o/a",
      agent: "boot",
      identitySource: "startup",
      identityDiagnostic: null,
    });
    expect(structured(b).selection).toMatchObject({
      repository: "o/b",
      agent: "zed",
      identitySource: "tool",
      identityDiagnostic: null,
    });
    expect(structured(c).selection.repository).toBe("start/default");
    expect(runtime.seen.sort()).toEqual(["o/a#-@-", "o/b#-@-", "start/default#-@-"]);
    await client.close();
  });

  it("resolves the default repository in the configured project and reports unresolved identity", async () => {
    const dirs: (string | undefined)[] = [];
    const client = await connect(
      fake({ currentRepository: async (cwd) => (dirs.push(cwd), repo) }),
      { project: "/work/project" },
    );
    const result = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(dirs).toEqual(["/work/project"]);
    expect(text(result)).toMatch(/Identity: unresolved; this is an unfocused read/);
    await client.close();
  });

  describe("default repository without --project or --repo (#271)", () => {
    // A host such as Ori launches the server in its daemon's directory, which holds another
    // project's checkout. Injected cwd, git and filesystem model that launch directory.
    const daemonRepo = "daemon/elsewhere";
    const project = "/work/project";
    const hostRuntime = () => {
      const lookups: (string | undefined)[] = [];
      const touched: string[] = [];
      const runtime = fake({
        currentRepository: async (cwd?: string) => {
          lookups.push(cwd);
          return cwd === project ? repo : daemonRepo;
        },
        git: async (args: readonly string[]) => {
          touched.push(`git ${args.join(" ")}`);
          return args[0] === "rev-parse"
            ? "/daemon/cwd\n"
            : `origin\thttps://github.com/${daemonRepo}.git (fetch)\n`;
        },
        fs: {
          readText: async (path: string) => (touched.push(`read ${path}`), null),
          writeText: async (path: string) => void touched.push(`write ${path}`),
          rename: async (_from: string, to: string) => void touched.push(`rename ${to}`),
          appendText: async (path: string) => void touched.push(`append ${path}`),
          remove: async (path: string) => void touched.push(`remove ${path}`),
          makeDirectory: async (path: string) => void touched.push(`mkdir ${path}`),
        },
      });
      return { runtime, lookups, touched };
    };
    const calls: [string, Record<string, unknown>][] = [
      ["triage_briefing", {}],
      ["triage_briefing", { mode: "briefing" }],
      ["triage_issue", { number: 1 }],
      ["triage_dependencies", { number: 1 }],
    ];

    it("refuses with selection guidance instead of resolving the launch directory, keeping overrides", async () => {
      const { runtime, lookups, touched } = hostRuntime();
      const client = await connect(runtime);
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        const envelope = structured(result);
        expect(envelope).toMatchObject({
          status: "error",
          data: null,
          selection: { repository: null },
          error: { code: "repository-unresolved" },
        });
        const message = envelope.error?.message ?? "";
        for (const fix of ["repo", "--repo owner/name", "--project /absolute/project/path"])
          expect(message, name).toContain(fix);
        const command = /pdb-mcp [^\n]*/.exec(message)?.[0] ?? "";
        expect(command).toBe("pdb-mcp --project /absolute/project/path");
        expect(message).not.toContain("#");
        expect(JSON.stringify(result)).not.toContain(daemonRepo);
      }
      expect(lookups).toEqual([]);
      expect(runtime.seen).toEqual([]);
      expect(touched).toEqual([]);
      await client.close();

      // Explicit overrides still select: tool repo, then --repo, then --project.
      const viaTool = await connect(runtime);
      const tool = await viaTool.callTool({ name: "triage_briefing", arguments: { repo: "o/a" } });
      expect(structured(tool)).toMatchObject({
        status: "complete",
        selection: { repository: "o/a" },
      });
      await viaTool.close();
      const viaStartup = await connect(runtime, { repo: "o/b" });
      const startup = await viaStartup.callTool({ name: "triage_issue", arguments: { number: 1 } });
      expect(structured(startup).selection.repository).toBe("o/b");
      await viaStartup.close();
      expect(lookups).toEqual([]);
      const viaProject = await connect(runtime, { project });
      const configured = await viaProject.callTool({
        name: "triage_dependencies",
        arguments: { number: 1 },
      });
      expect(structured(configured).selection.repository).toBe(repo);
      expect(lookups).toEqual([project]);
      await viaProject.close();
    });
  });

  describe("read-only identity from the project's pdb.toml", () => {
    const root = "/work/project";
    const identityFile = join(root, "pdb.toml");
    const toml = [
      "[agents.claude]",
      'name = "file_claude"',
      'triage_role = "implementer"',
      "",
      "[agents.codex]",
      'name = "file_codex"',
      'role = "agent"',
      "",
      '[agents."ori.pdb"]',
      'name = "file_ori"',
      'triage_role = "designer"',
      "",
      '[agents."ori.review"]',
      'name = "file_ori_review"',
      "",
    ].join("\n");
    const identityRuntime = (
      contents: string | null | Error = toml,
      env: Record<string, string> = {},
    ) => {
      const writes: string[] = [];
      const fs = {
        readText: async (path: string) => {
          if (contents instanceof Error) throw contents;
          return path === identityFile ? contents : null;
        },
        writeText: async (path: string) => void writes.push(path),
        rename: async (_from: string, to: string) => void writes.push(to),
        appendText: async (path: string) => void writes.push(path),
        remove: async (path: string) => void writes.push(path),
        makeDirectory: async (path: string) => void writes.push(path),
      };
      const git = async (args: readonly string[]) =>
        args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
      return { runtime: fake({ fs, git, env }), writes };
    };
    const connectAs = async (runtime: Runtime, options: Options, clientName = "test") => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer(options, runtime).connect(serverSide);
      const client = new Client({ name: clientName, version: "9.9.9" });
      await client.connect(clientSide);
      return client;
    };
    const briefingSelection = async (client: Awaited<ReturnType<typeof connectAs>>, args = {}) =>
      structured(await client.callTool({ name: "triage_briefing", arguments: args }));

    it("applies tool, startup, entry, harness, client and environment precedence", async () => {
      const { runtime, writes } = identityRuntime(toml, { CLAUDECODE: "1" });
      const base = { project: root };
      const cases: [Options, string, Record<string, string>, object][] = [
        [
          { ...base, agent: "boot", entry: "codex" },
          "ori-pdb",
          { agent: "zed" },
          { agent: "zed", identitySource: "tool" },
        ],
        [
          { ...base, agent: "boot", entry: "codex" },
          "ori-pdb",
          {},
          { agent: "boot", identitySource: "startup", entry: null },
        ],
        [
          { ...base, entry: "codex" },
          "ori-pdb",
          {},
          { agent: "file_codex", identitySource: "entry", entry: "codex", triageRole: null },
        ],
        [
          { ...base, harness: "codex" },
          "ori-pdb",
          {},
          { agent: "file_codex", identitySource: "harness", entry: "codex" },
        ],
        [
          base,
          "ori-pdb",
          {},
          {
            agent: "file_ori",
            identitySource: "client",
            entry: "ori.pdb",
            triageRole: "designer",
          },
        ],
        [
          base,
          "ori-review",
          {},
          { agent: "file_ori_review", identitySource: "client", entry: "ori.review" },
        ],
        [
          base,
          "claude-code",
          {},
          {
            agent: "file_claude",
            identitySource: "environment",
            entry: "claude",
            triageRole: "implementer",
          },
        ],
      ];
      for (const [options, clientName, args, expected] of cases) {
        const client = await connectAs(runtime, options, clientName);
        const selected = await briefingSelection(client, args);
        expect(selected.selection, JSON.stringify([options, clientName, args])).toMatchObject({
          ...expected,
          identityDiagnostic: null,
        });
        expect(selected.status).toBe("complete");
        await client.close();
      }
      expect(writes).toEqual([]);
    });

    it("reads a legacy agent-inbox.toml entry as legacy-not-imported, never importing it (#319)", async () => {
      const legacyFile = join(root, "agent-inbox.toml");
      const writes: string[] = [];
      const fs = {
        readText: async (path: string) =>
          path === legacyFile ? '[agents.codex]\nname = "legacy_codex"\n' : null,
        writeText: async (path: string) => void writes.push(path),
        rename: async (_from: string, to: string) => void writes.push(to),
        appendText: async (path: string) => void writes.push(path),
        remove: async (path: string) => void writes.push(path),
        makeDirectory: async (path: string) => void writes.push(path),
      };
      const git = async (args: readonly string[]) =>
        args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
      const client = await connectAs(fake({ fs, git, env: {} }), { project: root, entry: "codex" });
      const result = await client.callTool({ name: "triage_briefing", arguments: {} });
      expect(structured(result).selection).toMatchObject({
        agent: "legacy_codex",
        entry: "codex",
        identityStore: "legacy-not-imported",
      });
      expect(text(result)).toMatch(/legacy agent-inbox\.toml \(not imported/);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(writes).toEqual([]);
      await client.close();
    });

    it("focuses the read exactly as the CLI does for the same name", async () => {
      const { runtime } = identityRuntime();
      const client = await connectAs(runtime, { project: root, repo }, "ori-pdb");
      const brief = await briefingSelection(client);
      expect(brief.selection.agent).toBe("file_ori");
      let out = "";
      await main(
        ["--repo", repo, "--agent", "file_ori", "--json", "--no-update-check"],
        async (t) => void (out = t),
        runtime,
      );
      const { checkpoint: _, ...cli } = JSON.parse(out);
      const expected = redactPaths(cli, [process.cwd()]);
      for (const key of ["actions", "sections", "rankedActions", "role"])
        expect((brief.data as Record<string, unknown>)[key], key).toEqual(expected[key]);
      await client.close();
    });

    it("reads unfocused with a diagnostic when identity is missing, ambiguous or unreadable", async () => {
      const cases: [ReturnType<typeof identityRuntime>, Options, string, RegExp][] = [
        [
          identityRuntime(toml, { ORI_SESSION_ID: "s" }),
          { project: root },
          "test",
          /one entry per configured server/,
        ],
        [
          identityRuntime(toml, { CLAUDECODE: "1", CODEX_THREAD_ID: "t" }),
          { project: root },
          "test",
          /several harnesses/,
        ],
        [
          identityRuntime(toml),
          { project: root, harness: "ori" },
          "test",
          /Candidate entries: ori.pdb, ori.review/,
        ],
        [identityRuntime(toml), { project: root }, "test", /No supported harness/],
        [
          identityRuntime(toml),
          { project: root, entry: "missing" },
          "test",
          /no \[agents.missing\] entry/,
        ],
        [identityRuntime(null), { project: root, entry: "codex" }, "test", /no pdb.toml/],
        [
          identityRuntime("[agents\nbroken"),
          { project: root, entry: "codex" },
          "test",
          /not valid for identity use/,
        ],
        [
          identityRuntime(new Error("EACCES /home/secret/pdb.toml")),
          { project: root, entry: "codex" },
          "test",
          /could not be read/,
        ],
        [
          identityRuntime(toml, { CLAUDECODE: "1" }),
          {},
          "ori-pdb",
          /no local project is configured/,
        ],
      ];
      for (const [{ runtime, writes }, options, clientName, diagnostic] of cases) {
        const client = await connectAs(runtime, options, clientName);
        const result = await client.callTool({ name: "triage_briefing", arguments: { repo } });
        const selected = structured(result);
        expect(selected.status, String(diagnostic)).toBe("complete");
        expect(selected.selection).toMatchObject({ agent: null, identitySource: "unresolved" });
        expect(selected.selection.identityDiagnostic).toMatch(diagnostic);
        expect(text(result)).toMatch(/Identity: unresolved; this is an unfocused read/);
        expect(JSON.stringify(result)).not.toMatch(/secret|EACCES|\/work\/project/);
        expect(writes).toEqual([]);
        await client.close();
      }
    });

    it("does not use a project's identity for a different repository", async () => {
      const { runtime } = identityRuntime();
      const client = await connectAs(runtime, { project: root, entry: "codex" });
      const selected = await briefingSelection(client, { repo: "other/repo" });
      expect(selected.selection).toMatchObject({ agent: null, identitySource: "unresolved" });
      expect(selected.selection.identityDiagnostic).toMatch(/not other\/repo/);
      await client.close();
    });

    it("rejects invalid or conflicting startup entry selection", () => {
      expect(() => mcpArguments(["--entry", "__proto__"])).toThrow();
      expect(() => mcpArguments(["--harness", "cursor"])).toThrow();
      expect(() => mcpArguments(["--entry", "codex", "--harness", "codex"])).toThrow(/either/);
      expect(mcpArguments(["--entry", "ori.review"])).toMatchObject({ entry: "ori.review" });
    });
  });

  it("returns sanitized errors, never raw failure text", async () => {
    const client = await connect(
      fake({
        currentRepository: async () => {
          throw new Error("gh: secret-token-123 stderr");
        },
        collect: async () => {
          throw new Error("ghp_SECRET raw stderr\n    at stack");
        },
      }),
    );
    const unresolved = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(unresolved.isError).toBe(true);
    expect(structured(unresolved)).toMatchObject({
      status: "error",
      data: null,
      error: { code: "repository-unresolved" },
    });
    const failed = await client.callTool({ name: "triage_briefing", arguments: { repo } });
    expect(structured(failed).error?.code).toBe("collection-failed");
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|secret-token|stack|stderr/);
    await client.close();
  });

  it("reports incomplete evidence and unavailable issues as incomplete, not complete", async () => {
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { issue?: number }) => {
          if (options?.issue === 9)
            throw new IssueUnavailable({
              repository: repo,
              number: 9,
              url: `https://github.com/${repo}/issues/9`,
              state: "forbidden",
              detail: "No access.",
              next: "Check permissions.",
            });
          return { ...snapshot(), warnings: ["Pull requests were truncated."] };
        },
      }),
      { repo },
    );
    const partial = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(structured(partial).status).toBe("incomplete");
    expect(text(partial)).toMatch(/^INCOMPLETE evidence/);
    const denied = await client.callTool({ name: "triage_issue", arguments: { number: 9 } });
    expect(structured(denied)).toMatchObject({
      status: "incomplete",
      data: { kind: "issue-unavailable", state: "forbidden" },
    });
    expect(text(denied)).toMatch(/FORBIDDEN/);
    await client.close();
  });

  it("does not report a cancelled call as complete", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const begun = new Promise<void>((resolve) => (started = resolve));
    const client = await connect(
      fake({
        collect: async () => {
          started();
          await gate;
          return snapshot();
        },
      }),
      { repo },
    );
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "triage_briefing", arguments: {} }, { signal: controller.signal })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await begun;
    controller.abort();
    release();
    const outcome = await pending;
    expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
    await client.close();
  });

  it("hands the call's abort signal to collection and dependency reads", async () => {
    const seen: AbortSignal[] = [];
    const hang = (signal: AbortSignal | undefined) => {
      if (signal) seen.push(signal);
      return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    };
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { signal?: AbortSignal }) => hang(options?.signal),
        dependencyReport: async (_r: string, _n: number, options?: { signal?: AbortSignal }) =>
          hang(options?.signal),
      }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_briefing", {}],
      ["triage_dependencies", { number: 1 }],
    ] as const) {
      const before = seen.length;
      const controller = new AbortController();
      const pending = client
        .callTool({ name, arguments: args }, { signal: controller.signal })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      await expect.poll(() => seen.length).toBe(before + 1);
      controller.abort();
      const outcome = await pending;
      expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
      // The server-side signal for that call fires, so the gh child is terminated.
      await expect.poll(() => seen.at(-1)?.aborted).toBe(true);
    }
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it("never returns local filesystem paths from configuration diagnostics", async () => {
    const leaks = ["/home/alice/private/checkout", "C:\\Users\\alice\\private\\checkout"];
    for (const root of leaks) {
      // The checkout's remote does not match the requested repository, so the estimation
      // config error names the checkout directory.
      const git: GitRunner = async (args) =>
        args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/other/thing (fetch)\n";
      const client = await connect(fake({ estimation: { cwd: root, git } }), {
        project: root,
        repo,
      });
      for (const [name, args] of [
        ["triage_briefing", {}],
        ["triage_issue", { number: 1 }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        const all = JSON.stringify(result);
        expect(all, `${name} ${root}`).not.toContain("alice");
        expect(all).toContain("<local checkout>");
        expect(all).toContain("other/thing");
        expect(all).toContain(`https://github.com/${repo}/issues/1`);
      }
      await client.close();
    }
  });

  it("redacts absolute paths in local diagnostics without touching URLs or repository names", () => {
    expect(
      [
        "The checkout at /srv/work/x is not owner/name (remotes: o/r).",
        "Restore C:\\Users\\bob\\proj\\.github\\triage.json from Git.",
        "See https://github.com/owner/name/issues/2 and ~/secret/file",
      ].map(redactLocalText),
    ).toEqual([
      "The checkout at <local checkout> is not owner/name (remotes: o/r).",
      "Restore <local checkout> from Git.",
      "See https://github.com/owner/name/issues/2 and <local checkout>",
    ]);
  });

  it("redacts only verified local directories everywhere, at path boundaries", () => {
    expect(
      redactPaths(
        {
          a: "Mine: /opt/me/repo/src and /opt/me/repo.",
          b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
          c: ["Win: c:/Users/Bob/proj\\src", "D:\\Users\\Bob\\proj"],
          n: 3,
        },
        ["/opt/me/repo", "C:\\Users\\Bob\\proj"],
      ),
    ).toEqual({
      a: "Mine: <local checkout>/src and <local checkout>.",
      b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
      c: ["Win: <local checkout>\\src", "D:\\Users\\Bob\\proj"],
      n: 3,
    });
  });

  it("keeps GitHub-authored paths verbatim and still redacts the home directory", async () => {
    const { homedir } = await import("node:os");
    const authored = "Call /api/v1/users; see [contract](/doc/design/mcp.md).";
    const home = `${homedir()}/private/notes.md`;
    const evidence = {
      ...issue(1),
      title: "Fix /api/v1/users",
      body: `${authored}\\nLocal: ${home}`,
      comments: page([
        { author: { login: "ana" }, body: authored, createdAt: time, url: `${issue().url}#c1` },
      ]),
    } as unknown as Issue;
    const client = await connect(
      fake({ collect: async (repository: string) => ({ ...snapshot([evidence]), repository }) }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_issue", { number: 1 }],
      ["triage_briefing", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const all = JSON.stringify(result.structuredContent) + text(result);
      expect(all, name).not.toContain(homedir());
      if (name === "triage_issue") {
        const detail = JSON.stringify(
          structured(await client.callTool({ name, arguments: { ...args, section: "body" } })).data,
        );
        expect(detail).toContain(JSON.stringify(authored).slice(1, -1));
        expect(detail).toContain("Fix /api/v1/users");
        expect(detail).toContain("<local checkout>/private/notes.md");
      }
    }
    await client.close();
  });

  it("validates startup arguments", () => {
    expect(mcpArguments(["--repo", "o/r", "--agent", "ana"])).toMatchObject({
      repo: "o/r",
      agent: "ana",
    });
    expect(() => mcpArguments(["--repo", "bad"])).toThrow();
    expect(() => mcpArguments(["--agent", "-x"])).toThrow();
    expect(() => mcpArguments(["--harness", "cursor"])).toThrow();
  });
});
