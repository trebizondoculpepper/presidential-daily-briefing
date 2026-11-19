/** MCP triage_discussion (#1101): parity with the shared service, argument boundaries, no identity. */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { boundedEnvelope, createServer } from "../mcp.js";
import { readDiscussion } from "../briefing/discussion.js";
import { discussionPage } from "../github/service/snapshot.js";
import type { Query } from "../github/github.js";

const repo = "o/r";
const node = (number: number, comments: number | null, state = "OPEN") => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state,
  ...(comments === null ? {} : { comments: { totalCount: comments } }),
});
const queryOf =
  (nodes: unknown[]): Query =>
  async () =>
    ({
      repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
    }) as never;

async function connect(query: Query) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ repo }, {
    collect: async () => {
      throw new Error("the discussion view must not collect a snapshot");
    },
    currentRepository: async () => repo,
    query,
    env: {},
  } as never);
  await server.connect(serverSide);
  const client = new Client({ name: "discussion-test", version: "1" });
  await client.connect(clientSide);
  return { client, close: async () => (await client.close(), await server.close()) };
}

describe("MCP triage_discussion (#1101)", () => {
  it("returns the shared result in native order, with counts, links and coverage", async () => {
    const nodes = [node(1, 3), node(2, 9), node(3, 0), node(4, null)];
    const { client, close } = await connect(queryOf(nodes));
    try {
      const raw = await client.callTool({ name: "triage_discussion", arguments: { limit: 2 } });
      const result = boundedEnvelope.parse(raw.structuredContent);
      expect(result).toMatchObject({ view: "discussion", status: "incomplete" });
      const data = result.data as {
        items: { number: number; comments: number; url: string; why: string }[];
        unknown: { number: number }[];
        total: number;
        scope: string;
      };
      const shared = await readDiscussion({
        repository: repo,
        scope: "open",
        gh: {
          snapshot: {
            discussionPage: (r, s, p, c, sig) => discussionPage(queryOf(nodes), r, s, p, c, sig),
          },
        },
      });
      // Parity: the same native order and counts as the shared service, paged.
      expect(data.items.map((i) => [i.number, i.comments])).toEqual(
        shared.items.slice(0, 2).map((i) => [i.number, i.comments]),
      );
      expect(data.total).toBe(shared.items.length);
      expect(data.items[0]!.url).toBe(`https://github.com/${repo}/issues/2`);
      expect(data.items[0]!.why).toContain("does not imply disagreement");
      expect(data.unknown.map((u) => u.number)).toEqual([4]);
      expect(data.scope).toBe("open");
    } finally {
      await close();
    }
  });

  it("validates state, limit and repo at the adapter", async () => {
    const { client, close } = await connect(queryOf([]));
    try {
      for (const args of [{ state: "maybe" }, { limit: 0 }, { limit: 101 }, { repo: "bad" }]) {
        const raw = await client.callTool({ name: "triage_discussion", arguments: args });
        expect(raw.isError).toBe(true);
      }
    } finally {
      await close();
    }
  });
});
