/** Shared discussion-view service (#1099). Injected GraphQL answers only; no live GitHub. */
import { describe, expect, it } from "vite-plus/test";
import { readDiscussion } from "./discussion.js";
import type { Query } from "../github/github.js";
import { discussionPage } from "../github/service/snapshot.js";

/** The GH facade slice the service uses, over an injected GraphQL boundary. */
const gh = (query: Query) => ({
  snapshot: {
    discussionPage: (
      ...args: [string, "open" | "closed" | "all", number, string | null, AbortSignal?]
    ) => discussionPage(query, ...args),
  },
});

const repo = "o/r";
const node = (number: number, comments: number | null, state = "OPEN") => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state,
  ...(comments === null ? {} : { comments: { totalCount: comments } }),
});
/** Pages of nodes; records the requested state scope and cursors. */
function fake(pages: unknown[][]) {
  const calls: { states: string; cursor: string | null }[] = [];
  const query: Query = async (source, variables) => {
    const states = /states:(\[[^\]]*\])/.exec(source)?.[1] ?? "";
    const cursor = (variables.cursor as string | undefined) ?? null;
    calls.push({ states, cursor });
    const i = cursor === null ? 0 : Number(cursor);
    return {
      repository: {
        issues: {
          nodes: pages[i] ?? [],
          pageInfo: {
            hasNextPage: i + 1 < pages.length,
            endCursor: i + 1 < pages.length ? String(i + 1) : null,
          },
        },
      },
    } as never;
  };
  return { query, calls };
}
const now = () => new Date("2026-11-19T12:00:00Z");

describe("shared discussion view (#1099)", () => {
  it("pages the scope, ranks natively and reports complete coverage", async () => {
    const f = fake([
      [node(1, 4), node(2, 9)],
      [node(3, 4), node(4, 0)],
    ]);
    const view = await readDiscussion({ repository: repo, scope: "open", gh: gh(f.query), now });
    expect(f.calls.map((c) => c.cursor)).toEqual([null, "1"]);
    expect(f.calls.every((c) => c.states === "[OPEN]")).toBe(true);
    expect(view.items.map((i) => [i.rank, i.number, i.comments])).toEqual([
      [1, 2, 9],
      [2, 1, 4],
      [3, 3, 4],
    ]);
    expect(view.items[0]).toMatchObject({
      title: "Ticket 2",
      url: `https://github.com/${repo}/issues/2`,
      why: expect.stringContaining("does not imply disagreement"),
    });
    expect(view.coverage).toMatchObject({
      complete: true,
      pagesRead: 2,
      issuesRead: 4,
      note: null,
    });
    expect(view).toMatchObject({
      kind: "discussion-view",
      scope: "open",
      fetchedAt: now().toISOString(),
    });
  });

  it("keeps unknown counts and unreadable nodes visible, never as zero", async () => {
    const f = fake([[node(1, null), node(2, 2), { number: "bad" }]]);
    const view = await readDiscussion({ repository: repo, scope: "open", gh: gh(f.query), now });
    expect(view.items.map((i) => i.number)).toEqual([2]);
    expect(view.unknown).toEqual([
      { number: 1, title: "Ticket 1", url: `https://github.com/${repo}/issues/1` },
    ]);
    expect(view.coverage).toMatchObject({ complete: false, unreadable: 1 });
    expect(view.coverage.note).toContain("could not be read");
    expect(view.coverage.note).toContain("unknown comment count");
  });

  it("stops at the page bound and says the ranking is not repository-wide", async () => {
    const f = fake([[node(1, 1)], [node(2, 5)], [node(3, 9)]]);
    const view = await readDiscussion({
      repository: repo,
      scope: "all",
      gh: gh(f.query),
      bounds: { maxPages: 2, pageSize: 1 },
      now,
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.states).toBe("[OPEN, CLOSED]");
    expect(view.items.map((i) => i.number)).toEqual([2, 1]);
    expect(view.coverage).toMatchObject({ complete: false, pagesRead: 2 });
    expect(view.coverage.note).toContain("not repository-wide");
  });

  it("includes closed discussion in the closed scope and honours cancellation", async () => {
    const f = fake([[node(8, 20, "CLOSED")]]);
    const closed = await readDiscussion({
      repository: repo,
      scope: "closed",
      gh: gh(f.query),
      now,
    });
    expect(f.calls[0]!.states).toBe("[CLOSED]");
    expect(closed.items.map((i) => i.number)).toEqual([8]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readDiscussion({
        repository: repo,
        scope: "open",
        gh: gh(f.query),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("marks coverage incomplete for an unknown count even when every page was read", async () => {
    const f = fake([[node(1, 3), node(2, null)]]);
    const view = await readDiscussion({ repository: repo, scope: "open", gh: gh(f.query), now });
    expect(view.unknown.map((u) => u.number)).toEqual([2]);
    expect(view.coverage.complete).toBe(false);
  });

  it("rejects pagination that cannot establish completeness", async () => {
    for (const pageInfo of [{}, { hasNextPage: true }, { hasNextPage: true, endCursor: "" }]) {
      const query: Query = async () =>
        ({ repository: { issues: { nodes: [node(1, 2)], pageInfo } } }) as never;
      await expect(
        readDiscussion({ repository: repo, scope: "open", gh: gh(query), now }),
      ).rejects.toThrow("pagination cannot establish completeness");
    }
  });
});

describe("discussion read through the composed GH facade (#1111 review)", () => {
  it("passes the caller's abort signal to the gh transport", async () => {
    const { createGhService } = await import("../github/service/service.js");
    const seen: (AbortSignal | undefined)[] = [];
    const service = createGhService({
      transport: async (call) => {
        seen.push(call.signal);
        return {
          ok: true,
          stdout: JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: [node(1, 2)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      },
    });
    const controller = new AbortController();
    const view = await readDiscussion({
      repository: repo,
      scope: "open",
      gh: service,
      now,
      signal: controller.signal,
    });
    expect(view.items.map((i) => i.number)).toEqual([1]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s !== undefined)).toBe(true);
  });
});
