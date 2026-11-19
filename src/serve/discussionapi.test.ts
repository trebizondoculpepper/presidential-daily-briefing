/** GET /api/v1/discussion (#1102): shared-service parity, validation, partial states. No GitHub. */
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { readDiscussion } from "../briefing/discussion.js";
import { discussionPage } from "../github/service/snapshot.js";
import type { Query } from "../github/github.js";
import { startServe } from "../serve.js";
import type { ServeRuntime } from "../serve.js";
import type { ServeReadRuntime } from "./api.js";
import { serveArguments } from "./options.js";
import { readServices } from "./services.js";

const repo = "example/one";
const now = new Date("2026-11-19T12:00:00Z");
const node = (number: number, comments: number | null, state = "OPEN") => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state,
  ...(comments === null ? {} : { comments: { totalCount: comments } }),
});
const queryOf =
  (nodes: unknown[], counter?: { n: number }): Query =>
  async (source) => {
    if (counter && source.includes("comments{totalCount}")) counter.n++;
    return {
      repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
    } as never;
  };

async function serve(nodes: unknown[], counter?: { n: number }) {
  const runtime: ServeRuntime = {
    currentRepository: async () => repo,
    authContext: async () => ({ host: "github.com", login: "octo" }),
    clock: {
      now: () => now,
      setTimeout: () => ({}),
      clearTimeout: () => undefined,
    } as never,
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
    queryWith: () => queryOf(nodes, counter),
    now: () => now,
    env: {},
  };
  const options = serveArguments(["--port", "0", "--repo", repo]);
  return startServe(options, runtime, readServices(options, runtime, read));
}
function get(port: number, path: string): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("GET /api/v1/discussion (#1102)", () => {
  it("returns the shared result in native order with a bounded display and the cache", async () => {
    const nodes = [node(1, 3), node(2, 9), node(3, 0)];
    const counter = { n: 0 };
    const running = await serve(nodes, counter);
    try {
      const reply = await get(running.port, `/api/v1/discussion?repo=${repo}&limit=1`);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        kind: "serve-read",
        view: "discussion",
        status: "complete",
      });
      const shared = await readDiscussion({
        repository: repo,
        scope: "open",
        gh: {
          snapshot: {
            discussionPage: (r, s, p, c, sig) => discussionPage(queryOf(nodes), r, s, p, c, sig),
          },
        },
        now: () => now,
      });
      expect(reply.body.result).toMatchObject({
        kind: "discussion-view",
        scope: "open",
        shown: 1,
        omitted: shared.items.length - 1,
        items: [{ number: shared.items[0]!.number, comments: shared.items[0]!.comments, rank: 1 }],
        coverage: { complete: true },
      });
      expect(reply.body.result.items[0].url).toBe(`https://github.com/${repo}/issues/2`);
      // A repeated identical request is served from the shared cache.
      await get(running.port, `/api/v1/discussion?repo=${repo}&limit=1`);
      expect(counter.n).toBe(1);
    } finally {
      await running.close();
    }
  });

  it("rejects invalid state, limit and unknown parameters", async () => {
    const running = await serve([]);
    try {
      for (const query of ["state=maybe", "limit=0", "limit=201", "limit=x", "view=daily"]) {
        const reply = await get(running.port, `/api/v1/discussion?repo=${repo}&${query}`);
        expect(reply.status, query).toBe(400);
        expect(reply.body.error.code).toBe("INVALID_ARGUMENT");
      }
    } finally {
      await running.close();
    }
  });

  it("marks unknown counts incomplete and reports the coverage note", async () => {
    const running = await serve([node(1, 2), node(2, null), node(8, 5, "CLOSED")]);
    try {
      const reply = await get(running.port, `/api/v1/discussion?repo=${repo}&state=all`);
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe("incomplete");
      expect(reply.body.result.unknown.map((u: { number: number }) => u.number)).toEqual([2]);
      expect(reply.body.result.items.map((i: { number: number }) => i.number)).toEqual([8, 1]);
      expect(reply.body.warnings.join(" ")).toContain("unknown comment count");
    } finally {
      await running.close();
    }
  });
});
