/**
 * `pdb serve` skeleton (doc/design/serve.md "Testing and acceptance" 1, 6, 7 and lifecycle).
 * Every test listens on an ephemeral port with injected gh, clock, output and signals.
 */
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import { AuthenticationError } from "./github/github.js";
import type { Runtime } from "./cli.js";
import { systemClock } from "./mcp/polling.js";
import { runServe, startServe } from "./serve.js";
import type { ServeRuntime } from "./serve.js";
import { DEFAULT_PORT, DEFAULT_TTL_MS, serveArguments, ServeUsageError } from "./serve/options.js";

const absolute = resolve("/work/checkout");

interface Harness {
  runtime: ServeRuntime;
  out: string[];
  err: string[];
  signals: EventEmitter;
  exits: number[];
}

function harness(overrides: Partial<ServeRuntime> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const exits: number[] = [];
  return {
    out,
    err,
    signals,
    exits,
    runtime: {
      currentRepository: async () => "example/project",
      authContext: async () => ({ host: "github.com", login: "octo" }),
      clock: systemClock,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      signals,
      exit: (code) => exits.push(code),
      version: async () => "9.9.9",
      platform: "linux",
      ...overrides,
    },
  };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP request, so Host and Origin can be set to anything. */
function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

const json = (reply: Reply): Record<string, unknown> =>
  JSON.parse(reply.body) as Record<string, unknown>;

async function started(args: string[] = ["--repo", "example/one"], h = harness()) {
  const running = await startServe(serveArguments(["--port", "0", ...args]), h.runtime);
  return { running, h };
}

describe("pdb serve arguments (#373)", () => {
  it("applies the contract defaults", () => {
    const options = serveArguments(["--repo", "o/n"]);
    expect(options).toMatchObject({
      port: DEFAULT_PORT,
      host: "127.0.0.1",
      allowRemote: false,
      ttlMs: DEFAULT_TTL_MS,
      repos: ["o/n"],
      projects: [],
    });
    expect(DEFAULT_PORT).toBe(4372);
    expect(DEFAULT_TTL_MS).toBe(300_000);
  });

  it("accepts the TTL range 1m to 10m inclusive and rejects outside it", () => {
    expect(serveArguments(["--repo", "o/n", "--ttl", "1m"]).ttlMs).toBe(60_000);
    expect(serveArguments(["--repo", "o/n", "--ttl", "10m"]).ttlMs).toBe(600_000);
    for (const ttl of ["0s", "0m", "11m", "1h", "30s", "5"])
      expect(() => serveArguments(["--repo", "o/n", "--ttl", ttl])).toThrow(/--ttl must be/);
  });

  it("requires a repository or project and never falls back to the working directory", () => {
    expect(() => serveArguments([])).toThrow(
      "pdb serve needs --repo owner/name or --project /absolute/project/path",
    );
  });

  it("rejects a non-loopback host without --allow-remote", () => {
    expect(() => serveArguments(["--repo", "o/n", "--host", "0.0.0.0"])).toThrow(/--allow-remote/);
    expect(serveArguments(["--repo", "o/n", "--host", "0.0.0.0", "--allow-remote"])).toMatchObject({
      host: "0.0.0.0",
      allowRemote: true,
    });
    for (const host of ["127.0.0.1", "127.8.9.10", "::1", "localhost"])
      expect(serveArguments(["--repo", "o/n", "--host", host]).host).toBe(host);
    expect(() => serveArguments(["--repo", "o/n", "--host", "example.com"])).toThrow(/literal IP/);
  });

  it("accepts repeated --repo and --project, validates each", () => {
    const options = serveArguments(["--repo", "o/one", "--repo", "o/two", "--project", absolute]);
    expect(options.repos).toEqual(["o/one", "o/two"]);
    expect(options.projects).toEqual([absolute]);
    expect(() => serveArguments(["--repo", "bad"])).toThrow(/owner\/name/);
    expect(() => serveArguments(["--project", "relative/path"])).toThrow(/absolute/);
    expect(() => serveArguments(["--repo", "o/n", "--port", "65536"])).toThrow(/--port/);
    expect(() => serveArguments(["--repo", "o/n", "--port", "-1"])).toThrow();
    expect(() => serveArguments(["--repo", "o/n", "--entry", "a", "--harness", "claude"])).toThrow(
      /either/,
    );
    expect(() => serveArguments(["--repo", "o/n", "--nope"])).toThrow(ServeUsageError);
  });

  it("exits 2 with guidance for usage errors, through the CLI", async () => {
    const h = harness();
    expect(await main(["serve"], async () => {}, { ...stubRuntime, serve: h.runtime })).toBe(2);
    expect(h.err.join("")).toContain("pdb serve needs --repo owner/name");
    const helped = harness();
    expect(
      await main(["serve", "--help"], async () => {}, { ...stubRuntime, serve: helped.runtime }),
    ).toBe(0);
    expect(helped.out.join("")).toMatch(/^Usage: pdb serve/);
    const top: string[] = [];
    await main(["--help"], async (text) => void top.push(text), stubRuntime);
    expect(top.join("")).toContain("serve --repo owner/name");
  });
});

const stubRuntime = {
  collect: async () => {
    throw new Error("no GitHub in tests");
  },
  currentRepository: async () => {
    throw new Error("no cwd resolution in tests");
  },
  updateCheck: async () => ({
    status: "skipped" as const,
    reason: "test",
    installed: null,
    channel: "",
  }),
} as unknown as Runtime;

describe("pdb serve lifecycle (#373)", () => {
  it("binds 127.0.0.1, prints the banner and answers health, status and the placeholder", async () => {
    const h = harness();
    const run = runServe(["--repo", "example/one", "--port", "0"], h.runtime);
    await until(() => h.out.length > 0);
    const first = h.out.join("").split("\n")[0]!;
    const match = /^pdb serve 9\.9\.9 listening on (http:\/\/127\.0\.0\.1:(\d+)\/)$/.exec(first);
    expect(match).not.toBeNull();
    const port = Number(match![2]);
    expect(h.out.join("")).toContain("repositories: example/one (default)");
    expect(h.out.join("")).toContain(`mcp: ${match![1]}mcp`);
    const health = await call(port, "/healthz");
    expect(health.status).toBe(200);
    expect(json(health)).toEqual({ ok: true });
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.headers["content-type"]).toBe("application/json; charset=utf-8");
    const status = json(await call(port, "/api/v1/status"));
    expect(status).toMatchObject({
      schemaVersion: 1,
      kind: "serve-status",
      version: "9.9.9",
      url: match![1],
      exposed: false,
      ttlSeconds: 300,
      auth: { host: "github.com", login: "octo" },
      repositories: [{ repository: "example/one", default: true, observedAt: null }],
      cache: { entries: 0, hits: 0, misses: 0, inflight: 0 },
    });
    const page = await call(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toContain("/api/v1/status");
    expect(page.body).toContain("#374");
    expect(page.body).not.toMatch(/<script|https?:\/\/(?!127)/);
    expect((await call(port, "/nope")).status).toBe(404);
    expect((await call(port, "/healthz?x=1")).status).toBe(400);
    const post = await call(port, "/healthz", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    // Request log on stderr: method, path, status; no query values.
    expect(h.err.join("")).toMatch(/GET \/healthz 200 - \d+ms/);
    expect(h.err.join("")).not.toContain("x=1");
    h.signals.emit("SIGINT");
    expect(await run).toBe(0);
    expect(h.exits).toEqual([]);
    expect(h.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("SIGTERM shuts down gracefully with 503 health during shutdown; a second signal exits 130", async () => {
    const { running, h } = await started();
    expect(running.shuttingDown()).toBe(false);
    const closing = running.close();
    expect(running.shuttingDown()).toBe(true);
    await closing;
    await expect(call(running.port, "/healthz")).rejects.toThrow();
    // Through runServe: the second signal forces exit 130.
    const h2 = harness();
    const run = runServe(["--repo", "example/one", "--port", "0"], h2.runtime);
    await until(() => h2.out.length > 0);
    h2.signals.emit("SIGTERM");
    h2.signals.emit("SIGTERM");
    expect(h2.exits).toEqual([130]);
    expect(await run).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("listens for SIGBREAK on Windows only", async () => {
    const h = harness({ platform: "win32" });
    const run = runServe(["--repo", "example/one", "--port", "0"], h.runtime);
    await until(() => h.out.length > 0);
    expect(h.signals.listenerCount("SIGBREAK")).toBe(1);
    h.signals.emit("SIGBREAK");
    expect(await run).toBe(0);
    const p = harness();
    const run2 = runServe(["--repo", "example/one", "--port", "0"], p.runtime);
    await until(() => p.out.length > 0);
    expect(p.signals.listenerCount("SIGBREAK")).toBe(0);
    p.signals.emit("SIGINT");
    expect(await run2).toBe(0);
  });

  it("a server with a kept-alive connection stops within the grace period", async () => {
    const { running } = await started();
    // Keep-alive connection opened before shutdown.
    const before = await call(running.port, "/healthz", { headers: { connection: "keep-alive" } });
    expect(before.status).toBe(200);
    const t0 = Date.now();
    await running.close();
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("exits 3 with the contract message when the port is in use", async () => {
    const occupier = createServer();
    await new Promise<void>((done) => occupier.listen(0, "127.0.0.1", done));
    const port = (occupier.address() as AddressInfo).port;
    try {
      const h = harness();
      expect(await runServe(["--repo", "example/one", "--port", String(port)], h.runtime)).toBe(3);
      expect(h.err.join("")).toContain(
        `pdb serve: port ${port} on 127.0.0.1 is already in use; is another pdb serve running? Stop it or pass --port N (0 picks a free port).`,
      );
      expect(h.out).toEqual([]);
    } finally {
      await new Promise((done) => occupier.close(done));
    }
  });

  it("exits 1 asking for gh auth login when the login cannot be read", async () => {
    const h = harness({
      authContext: async () => {
        throw new AuthenticationError("gh: secret-token-value-123 not logged in");
      },
    });
    expect(await runServe(["--repo", "example/one", "--port", "0"], h.runtime)).toBe(1);
    expect(h.err.join("")).toContain("run gh auth login");
    expect(h.err.join("")).not.toContain("secret-token-value-123");
    // An outage is not reported as a login problem.
    const outage = harness({
      authContext: async () => {
        throw new Error(
          "GitHub query failed. Check gh auth status, repository access and API rate limits.",
        );
      },
    });
    expect(await runServe(["--repo", "example/one", "--port", "0"], outage.runtime)).toBe(1);
    expect(outage.err.join("")).toContain("did not answer");
    expect(outage.err.join("")).not.toContain("run gh auth login");
  });

  it("resolves --project at startup and exits 2 naming a path that does not resolve", async () => {
    const ok = harness({ currentRepository: async () => "Example/Proj" });
    const { running } = await started(["--project", absolute], ok);
    expect(running.facts.served).toEqual([{ repository: "Example/Proj", project: absolute }]);
    await running.close();
    const bad = harness({
      currentRepository: async () => {
        throw new Error("not a checkout");
      },
    });
    expect(await runServe(["--project", absolute, "--port", "0"], bad.runtime)).toBe(2);
    expect(bad.err.join("")).toContain(`--project ${absolute} does not resolve`);
  });

  it("warns on stderr and reports exposure for a remote binding", async () => {
    const h = harness();
    const run = runServe(
      ["--repo", "example/one", "--port", "0", "--host", "0.0.0.0", "--allow-remote"],
      h.runtime,
    );
    await until(() => h.out.length > 0);
    expect(h.err.join("")).toContain(
      "WARNING: pdb serve is reachable from other machines at http://0.0.0.0:",
    );
    h.signals.emit("SIGINT");
    expect(await run).toBe(0);
  });
});

describe("pdb serve security (#373)", () => {
  it("rejects a wrong Host with 421 and a foreign Origin with 403", async () => {
    const { running } = await started();
    const port = running.port;
    try {
      for (const host of [
        "evil.example",
        `evil.example:${port}`,
        "127.0.0.1",
        `127.0.0.1:${port + 1}`,
        `localhost:${port}x`,
      ]) {
        const reply = await call(port, "/api/v1/status", { headers: { host } });
        expect(reply.status, host).toBe(421);
        expect(json(reply)).toMatchObject({ error: { code: "MISDIRECTED_HOST" } });
      }
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
        expect((await call(port, "/healthz", { headers: { host } })).status, host).toBe(200);
      for (const origin of [
        "http://evil.example",
        `http://evil.example:${port}`,
        `https://127.0.0.1:${port}`,
        `http://localhost:${port + 1}`,
        "http://localhost",
        "null",
        "chrome-extension://abc",
      ]) {
        const reply = await call(port, "/api/v1/status", { headers: { origin } });
        expect(reply.status, origin).toBe(403);
        expect(json(reply)).toMatchObject({ error: { code: "FORBIDDEN_ORIGIN" } });
      }
      for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`])
        expect((await call(port, "/healthz", { headers: { origin } })).status, origin).toBe(200);
      // An absolute-form target cannot route around the Host check.
      const absoluteForm = await call(port, `http://evil.example:${port}/healthz`);
      expect(absoluteForm.status).toBe(400);
      // No CORS headers are ever sent.
      const reply = await call(port, "/healthz", {
        headers: { origin: `http://localhost:${port}` },
      });
      expect(Object.keys(reply.headers).some((k) => k.startsWith("access-control"))).toBe(false);
    } finally {
      await running.close();
    }
  });

  it("never puts tokens, environment or local paths in status", async () => {
    const sentinelToken = "ghp_SENTINELTOKEN0123456789";
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = sentinelToken;
    try {
      const h = harness({ currentRepository: async () => "example/proj" });
      const { running } = await started(["--project", absolute], h);
      const body = (await call(running.port, "/api/v1/status")).body;
      expect(body).not.toContain(sentinelToken);
      expect(body).not.toContain(absolute);
      expect(body).not.toContain("checkout");
      await running.close();
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 10));
  }
}
