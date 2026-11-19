/**
 * HTTP MCP of `pdb serve` (doc/design/serve.md "Testing and acceptance" 8, #373/#390), with the
 * real @modelcontextprotocol/client 2.4.0 Streamable HTTP client on an ephemeral port.
 */
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import type { Issue, Page } from "../github/types.js";
import { boundedEnvelope, createServer } from "../mcp.js";
import type { McpRuntime } from "../mcp.js";
import type { Clock } from "../mcp/polling.js";
import { startServe } from "../serve.js";
import type { RunningServer, ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { MAX_MCP_SESSIONS, MCP_SESSION_IDLE_MS, McpSessions } from "./mcp.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";

const start = Date.parse("2026-11-12T10:00:00.000Z");
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (repository: string, n: number, labels: string[]): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: `https://github.com/${repository}/issues/${n}`,
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-12T09:00:00.000Z",
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
const queryFor =
  (repository: string): Query =>
  async (source) => ({
    repository: {
      issues: page(
        source.includes("issues(first")
          ? [
              issue(repository, 1, ["status:ready", "impact:L", "complexity:S"]),
              issue(repository, 2, ["status:ready", "agent:me", "impact:S"]),
            ]
          : [],
      ),
      pullRequests: page([]),
    },
  });

class ManualClock implements Clock {
  time = start;
  now = () => new Date(this.time);
  setTimeout = () => ({});
  clearTimeout = () => undefined;
}

interface Setup {
  running: RunningServer;
  clock: ManualClock;
  collects: string[];
  url: URL;
  signals: AbortSignal[];
  gate?: { release: () => void };
}

const collectorFor =
  (clock: ManualClock, collects: string[], signals: AbortSignal[]) =>
  (gate?: Promise<void>): ServeReadRuntime["collect"] =>
  async (repository, options) => {
    collects.push(`${repository}${options?.issue ? `#${options.issue}` : ""}`);
    if (options?.signal) signals.push(options.signal);
    if (gate)
      await Promise.race([
        gate,
        new Promise((_done, fail) =>
          options?.signal?.addEventListener("abort", () => fail(new Error("aborted"))),
        ),
      ]);
    return collect(repository, options, queryFor(repository), () => clock.now());
  };

async function setup(args: string[], gated = false): Promise<Setup> {
  const clock = new ManualClock();
  const collects: string[] = [];
  const signals: AbortSignal[] = [];
  let release = () => undefined as void;
  const gate = gated ? new Promise<void>((done) => (release = done)) : undefined;
  const serve: ServeRuntime = {
    currentRepository: async () => "example/one",
    authContext: async () => ({ host: "github.com", login: "octo" }),
    clock,
    stdout: () => undefined,
    stderr: () => undefined,
    signals: new EventEmitter(),
    exit: () => undefined,
    version: async () => "9.9.9",
    platform: "linux",
  };
  const read: ServeReadRuntime = {
    collect: collectorFor(clock, collects, signals)(gate),
    dependencyReport: async (repository, number) => ({
      schemaVersion: 1,
      repository,
      startedAt: new Date(start).toISOString(),
      fetchedAt: new Date(start).toISOString(),
      tree: false,
      nodes: [
        {
          number,
          url: `https://github.com/${repository}/issues/${number}`,
          title: `Ticket ${number}`,
          known: true,
          summary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
          upstream: [],
          downstream: [],
          drift: [],
          verdict: "No native blockers.",
        },
      ],
      cycles: [],
      guidance: "",
      // Issue 5 has a blocker in a repository the server does not serve.
      ...(number === 5 ? { unfollowed: [{ repository: "someone/else", number: 9 }] } : {}),
    }),
    now: () => clock.now(),
    env: {},
  };
  const options = serveArguments(["--port", "0", ...args]);
  const running = await startServe(options, serve, readServices(options, serve, read));
  return {
    running,
    clock,
    collects,
    signals,
    url: new URL(`${running.facts.url}mcp`),
    ...(gated ? { gate: { release } } : {}),
  };
}

async function connect(url: URL, name = "http-test"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

const envelopeOf = (raw: { structuredContent?: unknown }) =>
  boundedEnvelope.parse(raw.structuredContent);

/** Tool names served over stdio by the same factory. */
async function stdioTools(): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const runtime = {
    collect: async () => {
      throw new Error("unused");
    },
    dependencyReport: async () => {
      throw new Error("unused");
    },
    currentRepository: async () => "example/one",
  } as unknown as McpRuntime;
  await createServer({ repo: "example/one" }, runtime).connect(serverSide);
  const client = new Client({ name: "stdio", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

function raw(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

/**
 * #516: a served --repo-only repository cannot read its project configuration, so its effective
 * policy is "unavailable", while a checkout without configuration reports "disabled". Everything
 * else must be identical; this removes only that manifest and returns the states it held.
 */
const splitPolicy = (value: unknown): { rest: unknown; states: string[] } => {
  const states: string[] = [];
  const rest = JSON.parse(JSON.stringify(value), (key: string, v: unknown) => {
    if (key !== "effectivePolicy") return v;
    states.push((v as { state: string }).state);
    return undefined;
  }) as unknown;
  return { rest, states };
};

describe("pdb serve HTTP MCP (#373)", () => {
  it("initializes, lists the stdio tool set and calls every read tool with cache freshness", async () => {
    const s = await setup(["--repo", "example/one"]);
    const client = await connect(s.url);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(await stdioTools());
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
      const first = envelopeOf(
        await client.callTool({
          name: "triage_briefing",
          arguments: { agent: "me", role: "implementer" },
        }),
      );
      expect(first.status).toBe("complete");
      expect(first.selection).toMatchObject({ repository: "example/one", agent: "me" });
      expect(first.freshness).toMatchObject({
        cache: { source: "live", ageSeconds: 0, ttlSeconds: 300, stale: false },
      });
      s.clock.time += 42_000;
      const second = envelopeOf(
        await client.callTool({ name: "triage_briefing", arguments: { agent: "me" } }),
      );
      expect(second.freshness).toMatchObject({ cache: { source: "cached", ageSeconds: 42 } });
      expect(s.collects).toEqual(["example/one"]);
      const issueResult = envelopeOf(
        await client.callTool({ name: "triage_issue", arguments: { number: 1 } }),
      );
      expect(issueResult.tool).toBe("triage_issue");
      expect(issueResult.freshness).toMatchObject({ cache: { source: "live" } });
      const deps = envelopeOf(
        await client.callTool({ name: "triage_dependencies", arguments: { number: 1 } }),
      );
      expect(deps.tool).toBe("triage_dependencies");
      expect(deps.freshness).toMatchObject({ cache: { source: "live" } });
      // The human briefing (#457) shares the cached snapshot and the shared service.
      const human = envelopeOf(
        await client.callTool({
          name: "triage_briefing",
          arguments: { agent: "me", role: "human" },
        }),
      );
      expect(human.data).toMatchObject({
        human: { schemaVersion: 1, human: "me", routing: "named" },
      });
      expect(s.collects).toEqual(["example/one", "example/one#1"]);
      const events = await client.callTool({ name: "triage_events", arguments: {} });
      expect(events.structuredContent).toMatchObject({ kind: "events" });
      // The JSON API sees the same cache: the briefing snapshot is already there.
      const status = (await (await fetch(`${s.running.facts.url}api/v1/status`)).json()) as {
        cache: { entries: number; mcpSessions: number };
      };
      expect(status.cache.mcpSessions).toBe(1);
      expect(status.cache.entries).toBe(3);
    } finally {
      await client.close();
      await s.running.close();
    }
  });

  it("answers every role exactly as stdio does for the same facts (#390)", async () => {
    const servedCheckout = async (args: string[]) =>
      args[0] === "rev-parse"
        ? "/checkout\n"
        : "origin\thttps://github.com/example/one.git (fetch)\n";
    const noConfig = {
      readText: async () => null,
      writeText: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const s = await setup(["--repo", "example/one"]);
    const http = await connect(s.url);
    // stdio: the same factory over an in-memory transport, reading the same facts and clock.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const runtime = {
      collect: collectorFor(s.clock, [], [])(),
      dependencyReport: async () => {
        throw new Error("unused");
      },
      currentRepository: async () => "example/one",
      now: () => s.clock.now(),
      env: {},
      // A checkout of the served repository with no local configuration, never this test's cwd.
      estimation: { fs: noConfig, git: servedCheckout, cwd: "/checkout" },
      guide: { fs: noConfig, git: servedCheckout, cwd: "/checkout" },
    } as unknown as McpRuntime;
    await createServer({ repo: "example/one" }, runtime).connect(serverSide);
    const stdio = new Client({ name: "stdio", version: "1.0.0" });
    await stdio.connect(clientSide);
    try {
      for (const role of ["implementer", "designer", "human"]) {
        const args = { agent: "me", role };
        const rawHttp = await http.callTool({ name: "triage_briefing", arguments: args });
        const rawStdio = await stdio.callTool({ name: "triage_briefing", arguments: args });
        const [overHttp, overStdio] = [envelopeOf(rawHttp), envelopeOf(rawStdio)];
        const where = role;
        expect(overHttp.status, where).toBe(overStdio.status);
        expect(overHttp.selection, where).toEqual(overStdio.selection);
        // Served --repo only: project rules unavailable; the stdio checkout: disabled (#516).
        const [httpData, stdioData] = [splitPolicy(overHttp.data), splitPolicy(overStdio.data)];
        expect(httpData.rest, where).toEqual(stdioData.rest);
        if (role !== "human") {
          expect(httpData.states, where).toEqual(["unavailable"]);
          expect(stdioData.states, where).toEqual(["disabled"]);
        }
        // The text differs only by the server's cache freshness line, if any.
        const text = (r: { content?: unknown }) =>
          (r.content as { text?: string }[] | undefined)?.map((c) => c.text ?? "").join("\n") ?? "";
        expect(text(rawHttp).replace(/^.*cache.*\n/gim, ""), where).toBe(
          text(rawStdio).replace(/^.*cache.*\n/gim, ""),
        );
        // Only the server adds cache freshness; stdio has no cache.
        expect(overHttp.freshness, where).toMatchObject({ cache: { stale: false } });
        expect(overStdio.freshness, where).not.toHaveProperty("cache");
      }
    } finally {
      await http.close();
      await stdio.close();
      await s.running.close();
    }
  });

  it("keeps two sessions' repositories and agents apart, and refuses repositories not served", async () => {
    const s = await setup(["--repo", "example/one", "--repo", "example/two"]);
    const a = await connect(s.url, "client-a");
    const b = await connect(s.url, "client-b");
    try {
      const [ra, rb] = await Promise.all([
        a.callTool({ name: "triage_briefing", arguments: { repo: "example/one", agent: "me" } }),
        b.callTool({ name: "triage_briefing", arguments: { repo: "example/two", agent: "you" } }),
      ]);
      expect(envelopeOf(ra).selection).toMatchObject({ repository: "example/one", agent: "me" });
      expect(envelopeOf(rb).selection).toMatchObject({ repository: "example/two", agent: "you" });
      const unresolved = envelopeOf(await a.callTool({ name: "triage_briefing", arguments: {} }));
      expect(unresolved).toMatchObject({
        status: "error",
        error: { code: "repository-unresolved" },
      });
      const foreign = envelopeOf(
        await a.callTool({ name: "triage_briefing", arguments: { repo: "other/repo" } }),
      );
      expect(foreign).toMatchObject({ status: "error", error: { code: "repository-not-served" } });
    } finally {
      await a.close();
      await b.close();
      await s.running.close();
    }
  });

  it("DELETE closes a session; an unknown session is 404 and the client re-initializes", async () => {
    const s = await setup(["--repo", "example/one"]);
    const port = s.running.port;
    const transport = new StreamableHTTPClientTransport(s.url);
    const client = new Client({ name: "deleter", version: "1.0.0" });
    await client.connect(transport);
    const id = transport.sessionId!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await transport.terminateSession();
    const gone = await raw(
      port,
      "POST",
      {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": id,
        "mcp-protocol-version": "2025-06-18",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body)).toMatchObject({ error: { message: "Session not found" } });
    await client.close();
    // A fresh client initializes a new session and works.
    const again = await connect(s.url);
    expect((await again.listTools()).tools.length).toBe(5);
    await again.close();
    // Without a session, only POST (initialize) is accepted; non-JSON POST is 415.
    expect((await raw(port, "GET", { accept: "text/event-stream" })).status).toBe(400);
    expect((await raw(port, "POST", { "content-type": "text/plain" }, "{}")).status).toBe(415);
    expect((await raw(port, "PUT", {})).status).toBe(405);
    // The Host guard covers /mcp too.
    expect((await raw(port, "POST", { host: "evil.example" }, "{}")).status).toBe(421);
    await s.running.close();
  });

  it("reports skipped unserved dependency nodes as incomplete source evidence", async () => {
    const s = await setup(["--repo", "example/one"]);
    const client = await connect(s.url);
    try {
      const deps = envelopeOf(
        await client.callTool({
          name: "triage_dependencies",
          arguments: { number: 5, tree: true },
        }),
      );
      expect(deps.status).toBe("incomplete");
      expect(deps.sourceCompleteness).toMatchObject({ complete: false });
      expect(deps.sourceCompleteness!.warnings.join(" ")).toContain("someone/else#9");
      const plain = envelopeOf(
        await client.callTool({ name: "triage_dependencies", arguments: { number: 1 } }),
      );
      expect(plain.sourceCompleteness).toMatchObject({ complete: true, warnings: [] });
    } finally {
      await client.close();
      await s.running.close();
    }
  });

  it("concurrent initialisations never exceed the session bound, and reservations are released", async () => {
    const s = await setup(["--repo", "example/one"]);
    const clients: Client[] = [];
    type Status = { cache: { mcpSessions: number; mcpSessionsInitializing: number } };
    const status = async () =>
      ((await (await fetch(`${s.running.facts.url}api/v1/status`)).json()) as Status).cache;
    try {
      const settled = await Promise.allSettled(
        Array.from({ length: MAX_MCP_SESSIONS + 16 }, async (_, i) => {
          const client = await connect(s.url, `burst${i}`);
          clients.push(client);
        }),
      );
      expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
      expect(await status()).toMatchObject({ mcpSessionsInitializing: 0 });
      expect((await status()).mcpSessions).toBeLessThanOrEqual(MAX_MCP_SESSIONS);
      // A first request that does not initialise gives its reservation back.
      const bad = await raw(
        s.running.port,
        "POST",
        { "content-type": "application/json", accept: "application/json, text/event-stream" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      );
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(await status()).toMatchObject({ mcpSessionsInitializing: 0 });
      expect((await status()).mcpSessions).toBeLessThanOrEqual(MAX_MCP_SESSIONS);
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await s.running.close();
    }
  });

  it("reserves capacity before initialisation completes, even when it is slow", async () => {
    // Drive McpSessions directly with a deliberately slow connect, so every initialisation is
    // in progress at once: without reservations all of them would register.
    const runtime = {
      collect: async () => {
        throw new Error("unused");
      },
      dependencyReport: async () => {
        throw new Error("unused");
      },
      currentRepository: async () => "example/one",
    } as unknown as McpRuntime;
    const sessions = new McpSessions(
      () => {
        const server = createServer({ repo: "example/one" }, runtime);
        const connect = server.connect.bind(server);
        server.connect = async (transport) => {
          await new Promise((done) => setTimeout(done, 50));
          return connect(transport);
        };
        return server;
      },
      new ManualClock(),
      () => undefined,
    );
    let peak = 0;
    const http = createHttpServer((request, response) => {
      peak = Math.max(peak, sessions.size + sessions.initializing);
      void sessions.handle({
        request,
        response,
        url: new URL(request.url ?? "/mcp", "http://127.0.0.1"),
        signal: new AbortController().signal,
      });
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const port = (http.address() as AddressInfo).port;
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "burst", version: "1" },
      },
    });
    try {
      const replies = await Promise.all(
        Array.from({ length: MAX_MCP_SESSIONS + 16 }, () =>
          raw(
            port,
            "POST",
            { "content-type": "application/json", accept: "application/json, text/event-stream" },
            initialize,
          ),
        ),
      );
      expect(replies.filter((r) => r.status === 200).length).toBeGreaterThan(0);
      expect(sessions.size).toBeLessThanOrEqual(MAX_MCP_SESSIONS);
      expect(sessions.initializing).toBe(0);
      expect(peak).toBeLessThanOrEqual(MAX_MCP_SESSIONS + 1);
    } finally {
      await sessions.close();
      await new Promise((done) => http.close(done));
    }
  });

  it("drops idle sessions after 30 minutes without dropping cache entries", async () => {
    const s = await setup(["--repo", "example/one"]);
    const transport = new StreamableHTTPClientTransport(s.url);
    const client = new Client({ name: "idle", version: "1.0.0" });
    await client.connect(transport);
    await client.callTool({ name: "triage_briefing", arguments: {} });
    s.clock.time += MCP_SESSION_IDLE_MS;
    const status = (await (await fetch(`${s.running.facts.url}api/v1/status`)).json()) as {
      cache: { entries: number; mcpSessions: number };
    };
    expect(status.cache.mcpSessions).toBe(1);
    // The next /mcp request sweeps; the old session is gone, the cache is not.
    const gone = await raw(
      s.running.port,
      "POST",
      {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    );
    expect(gone.status).toBe(404);
    const after = (await (await fetch(`${s.running.facts.url}api/v1/status`)).json()) as {
      cache: { entries: number; mcpSessions: number };
    };
    expect(after.cache).toMatchObject({ mcpSessions: 0, entries: 1 });
    await client.close().catch(() => undefined);
    await s.running.close();
  });

  it(`admits at most ${MAX_MCP_SESSIONS} sessions, closing the least recently used`, async () => {
    const s = await setup(["--repo", "example/one"]);
    const clients: Client[] = [];
    try {
      for (let i = 0; i <= MAX_MCP_SESSIONS; i++) {
        s.clock.time += 1;
        clients.push(await connect(s.url, `c${i}`));
      }
      const status = (await (await fetch(`${s.running.facts.url}api/v1/status`)).json()) as {
        cache: { mcpSessions: number };
      };
      expect(status.cache.mcpSessions).toBe(MAX_MCP_SESSIONS);
      // The newest works; the oldest was closed.
      expect((await clients.at(-1)!.listTools()).tools.length).toBe(5);
      await expect(clients[0]!.listTools()).rejects.toThrow();
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await s.running.close();
    }
  });

  it("a cancelled call leaves a coalesced JSON reader intact; shutdown closes sessions", async () => {
    const s = await setup(["--repo", "example/one"], true);
    const client = await connect(s.url);
    const controller = new AbortController();
    const mcpCall = client
      .callTool({ name: "triage_briefing", arguments: {} }, { signal: controller.signal })
      .catch((error: unknown) => error);
    const json = fetch(`${s.running.facts.url}api/v1/briefing`).then((r) => r.json());
    await until(() => s.collects.length === 1);
    // Let the JSON request join the shared collection before the MCP caller leaves.
    await new Promise((done) => setTimeout(done, 50));
    controller.abort();
    expect(await mcpCall).toBeInstanceOf(Error);
    expect(s.signals[0]!.aborted).toBe(false);
    s.gate!.release();
    const body = (await json) as { status: string; freshness: { source: string } };
    expect(body).toMatchObject({ status: "complete", freshness: { source: "live" } });
    expect(s.collects).toHaveLength(1);
    await s.running.close();
    await expect(client.listTools()).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("pdb serve discussion view through the shared cache (#1118 review)", () => {
  it("reads once and serves a repeated identical request from the cache", async () => {
    const clock = new ManualClock();
    let discussionQueries = 0;
    const discussionQuery: Query = async (source) => {
      if (source.includes("comments{totalCount}")) discussionQueries++;
      return {
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Ticket 1",
                url: "https://github.com/example/one/issues/1",
                state: "OPEN",
                comments: { totalCount: 4 },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      } as never;
    };
    const serve: ServeRuntime = {
      currentRepository: async () => "example/one",
      authContext: async () => ({ host: "github.com", login: "octo" }),
      clock,
      stdout: () => undefined,
      stderr: () => undefined,
      signals: new EventEmitter(),
      exit: () => undefined,
      version: async () => "9.9.9",
      platform: "linux",
    };
    const read: ServeReadRuntime = {
      collect: async () => {
        throw new Error("the discussion view must not collect a snapshot");
      },
      dependencyReport: async () => {
        throw new Error("not used");
      },
      queryWith: () => discussionQuery,
      now: () => clock.now(),
      env: {},
    };
    const options = serveArguments(["--port", "0", "--repo", "example/one"]);
    const running = await startServe(options, serve, readServices(options, serve, read));
    const client = await connect(new URL(`${running.facts.url}mcp`));
    try {
      const call = async () =>
        boundedEnvelope.parse(
          (
            await client.callTool({
              name: "triage_discussion",
              arguments: { repo: "example/one" },
            })
          ).structuredContent,
        );
      const first = await call();
      expect(first).toMatchObject({ view: "discussion", status: "complete" });
      expect(discussionQueries).toBe(1);
      await call();
      expect(discussionQueries).toBe(1);
    } finally {
      await client.close();
      await running.close();
    }
  });
});
