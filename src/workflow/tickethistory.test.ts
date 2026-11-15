import { describe, expect, it } from "vite-plus/test";
import { ticketHistory } from "./claims.js";
import type { GraphQuery, HistoryEvent } from "./claims.js";

// Synthetic timeline: `total` events, served newest-first in pages of 100 like GitHub's `last`.
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
const event = (i: number): HistoryEvent =>
  i % 3 === 0
    ? { __typename: "ClosedEvent", createdAt: at(i), stateReason: "COMPLETED", actor: null }
    : i % 3 === 1
      ? { __typename: "ReopenedEvent", createdAt: at(i), actor: null }
      : {
          __typename: "LabeledEvent",
          createdAt: at(i),
          label: { name: "agent:alice" },
          actor: { __typename: "User", login: "writer" },
        };

function fake(total: number, failAt?: number) {
  const calls: { query: string; before?: string }[] = [];
  const query: GraphQuery = async (q, v) => {
    calls.push({ query: q, before: v.before as string | undefined });
    if (failAt !== undefined && calls.length === failAt) return { repository: { issue: null } };
    const end = v.before === undefined ? total : Number(v.before);
    const start = Math.max(0, end - 100);
    return {
      repository: {
        issue: {
          timelineItems: {
            nodes: Array.from({ length: end - start }, (_, k) => event(start + k)),
            pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
          },
        },
      },
    };
  };
  return { query, calls };
}

describe("ticket closure and claim timeline read", () => {
  it("reads closure, reopen and label events with their actors in one bounded request", async () => {
    const { query, calls } = fake(5);
    const h = await ticketHistory("example/project", 7, query);
    expect(h).toMatchObject({ complete: true, pages: 1 });
    expect(h.events.map((e) => e.__typename)).toEqual([
      "ClosedEvent",
      "ReopenedEvent",
      "LabeledEvent",
      "ClosedEvent",
      "ReopenedEvent",
    ]);
    expect(calls[0]!.query).toContain(
      "itemTypes:[LABELED_EVENT,UNLABELED_EVENT,CLOSED_EVENT,REOPENED_EVENT]",
    );
    expect(calls[0]!.query).toContain("... on ClosedEvent{createdAt stateReason actor{");
    expect(calls[0]!.query).toContain("... on ReopenedEvent{createdAt actor{");
  });

  it("pages backwards oldest-first and is complete when history starts within the bound", async () => {
    const { query, calls } = fake(250);
    const h = await ticketHistory("example/project", 7, query);
    expect(h).toMatchObject({ complete: true, pages: 3 });
    expect(h.events).toHaveLength(250);
    expect(h.events[0]!.createdAt).toBe(at(0));
    expect(calls.map((c) => c.before)).toEqual([undefined, "150", "50"]);
  });

  it("stops at the bound and reports complete: false when older events remain", async () => {
    const { query, calls } = fake(1000);
    const h = await ticketHistory("example/project", 7, query);
    expect(calls).toHaveLength(4);
    expect(h).toMatchObject({ complete: false, pages: 4 });
    expect(h.events).toHaveLength(400);
  });

  it("reports complete: false when a page cannot be read", async () => {
    const first = await ticketHistory("example/project", 7, fake(5, 1).query);
    expect(first).toEqual({ events: [], complete: false, pages: 1 });
    const later = await ticketHistory("example/project", 7, fake(250, 2).query);
    expect(later).toMatchObject({ complete: false, pages: 2 });
    expect(later.events).toHaveLength(100);
  });
});
