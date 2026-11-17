import { EventEmitter } from "node:events";
import { request, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withIdentityFixture as fixture, type IdentityFixture } from "../testing/identity.js";
import { snapshot, time } from "../testing/snapshots.js";
import { AuthenticationError } from "../github/github.js";
import type { GitRunner } from "../config/config.js";
import type { ServerEffectiveIdentity } from "../config/serveridentity.js";
import { boundedEnvelope } from "../mcp/bounded.js";
import { startServe, type ServeRuntime } from "../serve.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";
import type { ServeReadRuntime, ReadEnvelope } from "./api.js";

const environment = { CODEX_VERSION: "0.169.0", CODEX_THREAD_ID: "http-private-thread" };
const build = (f: IdentityFixture, args: string[] = [], git: GitRunner = f.git) => {
  let now = Date.parse(time);
  let auth: { login: string } | { failure: "refused" | "outage" } = { login: "owner" };
  let allocations = 0;
  const stderr: string[] = [];
  const serve: ServeRuntime = {
    git,
    currentRepository: async (cwd) => (cwd === f.root ? f.repository : "another/project"),
    authContext: async () => {
      if ("failure" in auth) {
        if (auth.failure === "refused")
          throw new AuthenticationError("private authentication detail");
        throw new Error("private outage detail");
      }
      return { host: "github.com", login: auth.login };
    },
    identityRuntime: {
      env: environment,
      fs: f.fs,
      git,
      random: () => {
        allocations++;
        return f.random();
      },
    },
    clock: { now: () => new Date(now), setTimeout: () => ({}), clearTimeout: () => {} },
    stdout: () => {},
    stderr: (text) => {
      stderr.push(text);
    },
    signals: new EventEmitter(),
    exit: () => {},
    version: async () => "9.9.9",
    platform: process.platform,
  };
  const read: ServeReadRuntime = {
    collect: async (repository) => ({
      ...snapshot([], []),
      repository,
      startedAt: new Date(now).toISOString(),
      fetchedAt: new Date(now).toISOString(),
    }),
    dependencyReport: async () => {
      throw new Error("unused dependency reader");
    },
    now: () => new Date(now),
    engineClock: () => 0,
    env: environment,
    fs: f.fs,
    git,
    projectRuntime: (project) => ({
      estimation: { cwd: project, fs: f.fs, git },
      guide: { cwd: project, fs: f.fs, git },
    }),
  };
  const options = serveArguments(["--port", "0", ...args]);
  return {
    serve,
    read,
    options,
    stderr,
    allocations: () => allocations,
    advance: () => {
      now += options.ttlMs + 1;
    },
    setAuth: (next: typeof auth) => {
      auth = next;
    },
  };
};
const start = async (state: ReturnType<typeof build>) => ({
  ...state,
  running: await startServe(
    state.options,
    state.serve,
    readServices(state.options, state.serve, state.read),
  ),
});
const get = (port: number, path: string): Promise<{ status: number; document: ReadEnvelope }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, document: JSON.parse(body) as ReadEnvelope });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });

beforeEach(() => vi.stubEnv("PDB_NO_HUMAN_CONTEXT", ""));
afterEach(() => vi.unstubAllEnvs());

describe("effective identity in actual HTTP results (#677)", () => {
  it("initializes only at selected startup, preserves display focus and carries startup history", async () =>
    fixture(async (f) => {
      const s = await start(build(f, ["--project", f.root, "--role", "designer"]));
      try {
        const raw = await f.fs.readText(f.file);
        expect(s.running.facts.identitySession?.startup.setup.state).toBe("created");
        for (const path of [
          "/api/v1/briefing",
          "/api/v1/briefing?agent=display_agent",
          "/api/v1/briefing?role=human&agent=another_human",
        ]) {
          const response = await get(s.running.port, path);
          expect(response.status).toBe(200);
          expect(response.document.effectiveIdentity).toMatchObject({
            agent: s.running.facts.identitySession!.startup.agent,
            human: { state: "current", login: "owner", source: "gh-login" },
            setup: { state: "reused", notices: [] },
            startup: { phase: "local-server-startup", result: { setup: { state: "created" } } },
          });
          expect(JSON.stringify(response.document)).not.toContain(environment.CODEX_THREAD_ID);
          expect(JSON.stringify(response.document)).not.toContain(f.root);
        }
        const defaultView = await get(s.running.port, "/api/v1/briefing");
        expect(defaultView.document.result).toMatchObject({
          decisionEngine: { role: { used: "designer" } },
        });
        const humanView = await get(
          s.running.port,
          "/api/v1/briefing?role=human&agent=another_human",
        );
        expect(humanView.document.result).toMatchObject({
          human: { human: "another_human", routing: "named" },
          employingHuman: { login: "owner" },
        });
        expect(s.stderr.join("").match(/created agent identity/g)).toHaveLength(1);
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await s.running.close();
      }
    }));

  it("updates observed human accounts without renaming the agent and never revives a refused login", async () =>
    fixture(async (f) => {
      const s = await start(build(f, ["--project", f.root, "--role", "implementer"]));
      try {
        const first = await get(s.running.port, "/api/v1/briefing");
        const agent = first.document.effectiveIdentity?.agent;
        const raw = await f.fs.readText(f.file);
        s.advance();
        s.setAuth({ failure: "outage" });
        const stale = await get(s.running.port, "/api/v1/briefing");
        expect(stale.document.effectiveIdentity?.human).toMatchObject({
          state: "last-known",
          login: "owner",
        });
        s.setAuth({ login: "another-owner" });
        const switched = await get(s.running.port, "/api/v1/briefing");
        expect(switched.document.effectiveIdentity).toMatchObject({
          agent,
          human: { state: "current", login: "another-owner" },
          startup: { result: { human: { login: "owner" } } },
        });
        expect(switched.document.result).toMatchObject({
          employingHuman: { login: "another-owner" },
        });
        s.advance();
        s.setAuth({ failure: "refused" });
        const refused = await get(s.running.port, "/api/v1/briefing");
        expect(refused.document.status).not.toBe("complete");
        expect(refused.document.effectiveIdentity?.human).toMatchObject({
          state: "unresolved",
          login: null,
        });
        s.setAuth({ failure: "outage" });
        const stillUnknown = await get(s.running.port, "/api/v1/briefing");
        expect(stillUnknown.document.effectiveIdentity?.human).toMatchObject({
          state: "unresolved",
          login: null,
        });
        s.setAuth({ login: "recovered-owner" });
        const recovered = await get(s.running.port, "/api/v1/briefing");
        expect(recovered.document.effectiveIdentity).toMatchObject({
          agent,
          human: { state: "current", login: "recovered-owner" },
        });
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await s.running.close();
      }
    }));

  it("keeps HTTP MCP read focus separate and refreshes human context after cache verification", async () =>
    fixture(async (f) => {
      const s = await start(build(f, ["--project", f.root, "--role", "implementer"]));
      let client: Client | undefined;
      try {
        client = new Client({ name: "http-fixture", version: "1.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL("mcp", s.running.facts.url)),
        );
        const first = boundedEnvelope.parse(
          (
            await client.callTool({
              name: "triage_briefing",
              arguments: { agent: "display_agent" },
            })
          ).structuredContent,
        );
        const identity = first.data?.effectiveIdentity as ServerEffectiveIdentity;
        expect(first.selection.agent).toBe("display_agent");
        expect(identity.agent).toBe(s.running.facts.identitySession?.startup.agent);
        s.advance();
        s.setAuth({ login: "another-owner" });
        const next = boundedEnvelope.parse(
          (await client.callTool({ name: "triage_briefing", arguments: {} })).structuredContent,
        );
        expect(next.data?.effectiveIdentity).toMatchObject({
          agent: identity.agent,
          human: { login: "another-owner" },
          startup: { result: { human: { login: "owner" } } },
        });
        expect(next.data?.employingHuman).toMatchObject({ login: "another-owner" });
      } finally {
        await client?.close();
        await s.running.close();
      }
    }));

  it("never bulk initializes multiple projects or initializes from GET role/entry arguments", async () =>
    fixture(async (f) =>
      fixture(async (other) => {
        const git: GitRunner = async (args, cwd) => {
          if (cwd !== other.root) return f.git(args, cwd);
          const value = await other.git(args, cwd);
          return args[0] === "remote"
            ? value.replaceAll(other.repository, "another/project")
            : value;
        };
        const s = await start(
          build(f, ["--project", f.root, "--project", other.root, "--role", "implementer"], git),
        );
        try {
          expect(s.allocations()).toBe(0);
          const response = await get(
            s.running.port,
            `/api/v1/briefing?repo=another%2Fproject&entry=codex&role=implementer`,
          );
          expect(response.status).toBe(200);
          expect(response.document.effectiveIdentity?.agent).toBeNull();
          expect(s.allocations()).toBe(0);
          expect(await readdir(f.root)).toEqual([]);
          expect(await readdir(other.root)).toEqual([]);
        } finally {
          await s.running.close();
        }
      }),
    ));

  it("prepares the one local startup project while remote project display cannot borrow it", async () =>
    fixture(async (f) => {
      const s = await start(
        build(f, ["--project", f.root, "--repo", "another/project", "--role", "implementer"]),
      );
      try {
        const startup = s.running.facts.identitySession!.startup;
        expect(startup.setup.state).toBe("created");
        const raw = await f.fs.readText(f.file);
        const response = await get(
          s.running.port,
          "/api/v1/briefing?repo=another%2Fproject&role=implementer",
        );
        expect(response.document.effectiveIdentity).toMatchObject({
          agent: null,
          startup: { result: { agent: startup.agent, setup: { state: "created" } } },
        });
        expect(await f.fs.readText(f.file)).toBe(raw);
      } finally {
        await s.running.close();
      }
    }));

  it("keeps an explicit human lookup opt-out unresolved across authenticated cache reads", async () =>
    fixture(async (f) => {
      vi.stubEnv("PDB_NO_HUMAN_CONTEXT", "1");
      const s = await start(build(f, ["--project", f.root, "--role", "implementer"]));
      try {
        for (const login of ["owner", "switched_owner"]) {
          s.setAuth({ login });
          s.advance();
          const response = await get(s.running.port, "/api/v1/briefing");
          expect(response.status).toBe(200);
          expect(response.document.effectiveIdentity?.human).toMatchObject({
            state: "unresolved",
            login: null,
            source: "none",
          });
          expect(response.document.effectiveIdentity?.startup.result.human.login).toBeNull();
        }
      } finally {
        await s.running.close();
      }
    }));

  it("refuses missing authentication before any local identity initialization", async () =>
    fixture(async (f) => {
      const state = build(f, ["--project", f.root, "--role", "implementer"]);
      state.setAuth({ failure: "refused" });
      await expect(start(state)).rejects.toThrow("gh auth");
      expect(state.allocations()).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    }));

  it("retains a verified identity after a port failure and reuses it on retry", async () =>
    fixture(async (f) => {
      const occupied = createHttpServer();
      await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      const port = (occupied.address() as AddressInfo).port;
      const state = build(f, ["--project", f.root, "--role", "implementer"]);
      try {
        await expect(
          start({ ...state, options: { ...state.options, port } }),
        ).rejects.toMatchObject({ exitCode: 3 });
        expect(state.stderr.join("")).toContain("created agent identity");
        const raw = await f.fs.readText(f.file);
        const allocations = state.allocations();
        state.stderr.length = 0;
        const s = await start(state);
        try {
          expect(s.running.facts.identitySession?.startup.setup.state).toBe("reused");
          expect(s.allocations()).toBe(allocations);
          expect(s.stderr.join("")).not.toContain("created agent identity");
          expect(await f.fs.readText(f.file)).toBe(raw);
        } finally {
          await s.running.close();
        }
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
    }));
});
