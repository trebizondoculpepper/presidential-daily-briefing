/**
 * HTTP MCP for `pdb serve` (doc/design/serve.md "HTTP MCP", #390 within #373).
 *
 * `/mcp` speaks MCP Streamable HTTP through the SDK's `WebStandardStreamableHTTPServerTransport`
 * (2.4.0). `createMcpHandler` serves each request statelessly and cannot hold the per-session
 * client info that harness identity needs, so stateful sessions are wired here instead: each
 * session owns one `McpServer` from the existing `createServer` factory, backed by the server
 * cache. `node:http` messages are converted to web `Request`/`Response` directly; no framework
 * or Node adapter package is added. The stdio `pdb-mcp` is untouched.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { createServer, SelectionRefusal } from "../mcp/server.js";
import type { CallFreshness, McpOptions, McpRuntime } from "../mcp/server.js";
import type { Clock } from "../mcp/polling.js";
import type { RequestContext, ServerFacts } from "./types.js";
import { cachedBoundaries, projectReaders, selectRepository } from "./api.js";
import type { ServeReadRuntime } from "./api.js";
import type { ServeCache } from "./cache.js";
import { HttpFailure, isJsonRequest } from "./http.js";
import { MAX_BODY_BYTES } from "./options.js";
import type { ServeOptions } from "./options.js";

/** Sessions idle this long are closed. */
export const MCP_SESSION_IDLE_MS = 30 * 60_000;
/** Most concurrent sessions; the least recently used is closed to admit a new one. */
export const MAX_MCP_SESSIONS = 64;
/** How often idle sessions are swept besides on each request. */
const SWEEP_INTERVAL_MS = 60_000;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
  /** Responses still streaming (a GET event stream, say); ended when the session closes. */
  open: Set<ServerResponse>;
}

/** The read-only MCP runtime over the server cache, with the served set deciding repositories. */
export function cachedMcpRuntime(
  options: ServeOptions,
  facts: ServerFacts,
  read: ServeReadRuntime,
  cache: ServeCache,
): McpRuntime {
  // The same served-set confinement as the JSON API (#373 review).
  const isServed = (repository: string): boolean =>
    facts.served.some((s) => s.repository.toLowerCase() === repository.toLowerCase());
  const { guardedQueryWith, guardedRest: _r, ...cached } = cachedBoundaries(read, cache, isServed);
  return {
    ...cached,
    now: read.now,
    env: read.env,
    git: read.git,
    fs: read.fs,
    // pdb serve never resolves a repository from a working directory (#271).
    currentRepository: async () => {
      throw new SelectionRefusal("repository-unresolved");
    },
    served: (repo) => {
      try {
        const chosen = selectRepository(facts.served, repo);
        return {
          ...chosen,
          runtime: {
            ...projectReaders(read, chosen.project, chosen.repository),
            // #414: the same closed-ticket scan as the JSON API for this project and repository.
            closedQuestions: cache.closedQuestions.slot(chosen.project, chosen.repository),
            ...(guardedQueryWith ? { closedQueryWith: guardedQueryWith } : {}),
          },
        };
      } catch (error) {
        if (error instanceof HttpFailure)
          throw new SelectionRefusal(
            error.code === "REPOSITORY_NOT_SERVED"
              ? "repository-not-served"
              : "repository-unresolved",
          );
        throw error;
      }
    },
    track: async (work) => {
      const { value, freshness } = await cache.track(false, work);
      // The stale record wins: a call that used any stale fact is reported stale.
      const chosen = freshness.find((f) => f.stale) ?? freshness[0];
      return { value, freshness: chosen ? ({ ...chosen } as CallFreshness) : null };
    },
    localProjects: options.projects,
  };
}

/** Convert a node:http request into a web Request (body streamed, never buffered here). */
function webRequest(request: IncomingMessage, url: URL, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    signal,
    ...(hasBody
      ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  } as RequestInit);
}

/** Stream a web Response back through node:http; stops when the client goes away. */
async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  target.writeHead(response.status, { "cache-control": "no-store", ...headers });
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  target.once("close", stop);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (target.destroyed) break;
      target.write(value);
    }
  } catch {
    // The stream ended because the client left or the session closed; nothing more to send.
  } finally {
    target.off("close", stop);
    if (!target.destroyed) target.end();
  }
}

const jsonRpcError = (target: ServerResponse, status: number, code: number, message: string) => {
  target.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  target.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

/** Stateful MCP sessions for `/mcp`. */
export class McpSessions {
  private readonly sessions = new Map<string, Session>();
  /** Initialisations admitted but not yet registered (or failed); they count toward the bound. */
  private pending = 0;
  private sweepTimer: unknown = null;
  private closed = false;

  constructor(
    private readonly factory: () => McpServer,
    private readonly clock: Clock,
    private readonly stderr: (text: string) => void,
  ) {
    this.scheduleSweep();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Reservations held by initialisations in progress (tests). */
  get initializing(): number {
    return this.pending;
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    this.sweepTimer = this.clock.setTimeout(() => {
      void this.sweep();
      this.scheduleSweep();
    }, SWEEP_INTERVAL_MS);
  }

  private async closeSession(id: string, session: Session): Promise<void> {
    if (this.sessions.get(id) === session) this.sessions.delete(id);
    try {
      await session.server.close();
    } catch {
      this.stderr("pdb serve: an MCP session did not close cleanly.\n");
    }
    // A closed session leaves no stream open, so shutdown never waits on one.
    for (const response of session.open) if (!response.writableEnded) response.end();
    session.open.clear();
  }

  /** Close sessions idle for 30 minutes. Dropping a session never drops cache entries. */
  async sweep(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const [id, session] of this.sessions)
      if (now - session.lastUsed >= MCP_SESSION_IDLE_MS) await this.closeSession(id, session);
  }

  /** Close every session (shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer !== null) this.clock.clearTimeout(this.sweepTimer);
    await Promise.all([...this.sessions].map(([id, s]) => this.closeSession(id, s)));
  }

  /** Answer one `/mcp` request. */
  async handle(context: RequestContext): Promise<void> {
    const { request, response, url, signal } = context;
    const method = request.method ?? "GET";
    if (!["GET", "POST", "DELETE"].includes(method))
      throw new HttpFailure(405, "METHOD_NOT_ALLOWED", "Use POST, GET or DELETE.", [], {
        allow: "GET, POST, DELETE",
      });
    if (url.search) throw new HttpFailure(400, "INVALID_ARGUMENT", "/mcp takes no query.");
    if (method === "POST" && !isJsonRequest(request.headers))
      throw new HttpFailure(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "POST requests must send Content-Type: application/json.",
      );
    await this.sweep();
    const now = this.clock.now().getTime();
    const header = request.headers["mcp-session-id"];
    let session: Session | undefined;
    let created = false;
    let reserved = false;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      this.pending--;
    };
    if (header !== undefined) {
      session = typeof header === "string" ? this.sessions.get(header) : undefined;
      // The specified reconnect path: an unknown session makes the client re-initialize.
      if (!session) return jsonRpcError(response, 404, -32001, "Session not found");
    } else {
      if (method !== "POST")
        return jsonRpcError(response, 400, -32000, "Mcp-Session-Id header is required");
      // Reserve capacity before any await, so concurrent initialisations cannot exceed the
      // bound; the reservation is released once the session is registered or has failed.
      this.pending++;
      reserved = true;
      // Admit the new session by closing the least recently used one at the bound.
      while (this.sessions.size + this.pending > MAX_MCP_SESSIONS) {
        if (this.sessions.size === 0) {
          // Every slot is held by initialisations still in progress.
          release();
          return jsonRpcError(response, 503, -32000, "Too many MCP sessions are initializing");
        }
        const [id, oldest] = [...this.sessions].reduce((a, b) =>
          b[1].lastUsed < a[1].lastUsed ? b : a,
        );
        await this.closeSession(id, oldest);
      }
      const server = this.factory();
      const fresh: Session = {
        server,
        lastUsed: now,
        open: new Set(),
        transport: new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Tools send no server-initiated notifications: single JSON responses suffice.
          enableJsonResponse: true,
          maxRequestBodySize: MAX_BODY_BYTES,
          onsessioninitialized: (id) => {
            this.sessions.set(id, fresh);
            release();
          },
          onsessionclosed: (id) => {
            if (this.sessions.get(id) === fresh) this.sessions.delete(id);
          },
        }),
      };
      try {
        await server.connect(fresh.transport);
      } catch (error) {
        release();
        throw error;
      }
      session = fresh;
      created = true;
    }
    session.lastUsed = now;
    session.open.add(response);
    try {
      const reply = await session.transport.handleRequest(webRequest(request, url, signal));
      context.source = "mcp";
      await writeResponse(reply, response);
    } finally {
      session.open.delete(response);
      // An initialisation that failed or never registered gives its reservation back.
      release();
      // A first request that did not initialize a session leaves nothing behind.
      if (created && session.transport.sessionId === undefined) await session.server.close();
    }
  }
}

/** Build the `/mcp` handler: per-session servers over the cached runtime. */
export function httpMcp(
  options: ServeOptions,
  facts: ServerFacts,
  read: ServeReadRuntime,
  cache: ServeCache,
  clock: Clock,
  stderr: (text: string) => void,
): McpSessions {
  const runtime = cachedMcpRuntime(options, facts, read, cache);
  // Repository and identity are re-resolved per call; startup identity defaults as pdb-mcp.
  const mcpOptions: McpOptions = {
    agent: options.agent,
    entry: options.entry,
    harness: options.harness,
  };
  return new McpSessions(
    () => createServer(mcpOptions, runtime, facts.version ?? "0.0.0"),
    clock,
    stderr,
  );
}
