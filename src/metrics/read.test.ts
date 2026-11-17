import { describe, expect, it } from "vite-plus/test";
import { readMetrics } from "./read.js";
import { ledgerTrust } from "./ledger.js";
import { deliveryMarker } from "../workflow/delivery.js";
import type { Comment } from "../workflow/claims.js";
import type { DeliveryRecord } from "../workflow/delivery.js";

// Synthetic fixtures only: no real repository, agent or comment.
const repo = "example/project";
const FROM = "2026-11-10T00:00:00Z";
const NOW = "2026-11-17T09:00:00Z";
const trust = ledgerTrust(async (login) => (login === "writer" ? "write" : "none"));

let nextId = 5000;
const comment = (body: string, at: string): Comment => {
  const id = nextId++;
  return {
    databaseId: id,
    url: `https://example.test/c/${id}`,
    body,
    createdAt: at,
    author: { __typename: "User", login: "writer" },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const submit = (n: number, prs: number[], at: string): Comment =>
  comment(
    deliveryMarker({
      v: 1,
      op: "submit",
      opId: `op-${n}`,
      repository: repo,
      issue: n,
      agent: "alice",
      deliverables: prs.map((p) => ({
        kind: "pr",
        repository: repo,
        number: p,
        nodeId: `PR_${p}`,
        target: { repository: repo, branch: null },
      })),
      membership: "complete",
      issuedAt: at,
    } as DeliveryRecord),
    at,
  );

interface Issue {
  number: number;
  updatedAt: string;
  state?: string;
  comments?: Comment[];
  totalCount?: number;
}
const node = (i: Issue) => ({
  number: i.number,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: i.updatedAt,
  state: i.state ?? "OPEN",
  closedAt: null,
  stateReason: null,
  comments: { totalCount: i.totalCount ?? (i.comments ?? []).length, nodes: i.comments ?? [] },
});

/** A fake GraphQL boundary: issue pages of the given size, empty timelines, and known PRs. */
function fake(issues: Issue[], pageSize: number, prs: Record<number, string | null> = {}) {
  const calls: string[] = [];
  const query = async (q: string, v: Record<string, string | number>) => {
    if (q.includes("issues(first:50")) {
      calls.push("walk");
      const start = Number(v.cursor ?? 0);
      const slice = issues.slice(start, start + pageSize).map(node);
      const more = start + pageSize < issues.length;
      return {
        repository: {
          issues: {
            nodes: slice,
            pageInfo: { hasNextPage: more, endCursor: more ? String(start + pageSize) : null },
          },
        },
      };
    }
    if (q.includes("timelineItems")) {
      calls.push("timeline");
      return {
        repository: {
          issue: {
            timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
          },
        },
      };
    }
    if (q.includes("pullRequest(number:$number){number state mergedAt}")) {
      calls.push(`pr:${v.number}`);
      const merged = prs[Number(v.number)];
      return merged === undefined
        ? { repository: { pullRequest: null } }
        : {
            repository: {
              pullRequest: {
                number: v.number,
                state: merged ? "MERGED" : "OPEN",
                mergedAt: merged,
              },
            },
          };
    }
    calls.push("other");
    return { repository: null };
  };
  return { calls, rt: { query, rest: async () => null, trust } as never };
}

describe("bounded metrics read (#573 slice 5b)", () => {
  it("walks back to the window start and reports complete history from it", async () => {
    const { calls, rt } = fake(
      [
        { number: 1, updatedAt: "2026-11-16T00:00:00Z" },
        { number: 2, updatedAt: "2026-11-11T00:00:00Z" },
        { number: 3, updatedAt: "2026-11-09T00:00:00Z" },
      ],
      50,
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.tickets.map((t) => t.member)).toEqual([`${repo}#1`, `${repo}#2`]);
    expect(r.coverage).toEqual({ completeFrom: FROM });
    expect(r.historyNotRead.count).toBe(0);
    expect(r.requests).toBe(calls.length);
    expect(r.tickets[0]).toMatchObject({ verdict: "none", complexity: "unassessed" });
  });

  it("reports history complete only back to the oldest update when the page cap is hit", async () => {
    const issues = Array.from({ length: 6 }, (_, i) => ({
      number: i + 1,
      updatedAt: `2026-11-${String(16 - i).padStart(2, "0")}T00:00:00Z`,
    }));
    const { rt } = fake(issues, 2);
    const r = await readMetrics(repo, FROM, NOW, rt, { maxPages: 2, maxTickets: 100 });
    expect(r.tickets).toHaveLength(4);
    expect(r.coverage.completeFrom).toBe("2026-11-13T00:00:00Z");
    expect(r.warnings.join(" ")).toMatch(/stopped at 2 pages/);
  });

  it("counts tickets beyond the ticket bound and keeps coverage from the newest skipped update", async () => {
    const { rt } = fake(
      [
        { number: 1, updatedAt: "2026-11-16T00:00:00Z" },
        { number: 2, updatedAt: "2026-11-14T00:00:00Z" },
        { number: 3, updatedAt: "2026-11-12T00:00:00Z" },
      ],
      50,
    );
    const r = await readMetrics(repo, FROM, NOW, rt, { maxPages: 10, maxTickets: 1 });
    expect(r.historyNotRead).toEqual({ count: 2, members: [`${repo}#2`, `${repo}#3`] });
    expect(r.coverage.completeFrom).toBe("2026-11-14T00:00:00Z");
  });

  it("marks comments partial and complexity unknown beyond the first 100 comments", async () => {
    const { rt } = fake([{ number: 1, updatedAt: "2026-11-16T00:00:00Z", totalCount: 150 }], 50);
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.tickets[0]!.ledger.coverage.comments).toBe("partial");
    expect(r.tickets[0]!.complexity).toBe("unknown");
  });

  it("reads required PR merges, and marks an unread PR as missing evidence", async () => {
    const { calls, rt } = fake(
      [
        {
          number: 1,
          updatedAt: "2026-11-16T00:00:00Z",
          comments: [submit(1, [10], "2026-11-12T00:00:00Z")],
        },
        {
          number: 2,
          updatedAt: "2026-11-15T00:00:00Z",
          comments: [submit(2, [11], "2026-11-12T00:00:00Z")],
        },
      ],
      50,
      { 10: "2026-11-13T00:00:00Z" },
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(calls).toContain("pr:10");
    const merged = r.tickets[0]!.ledger.events.find((e) => e.kind === "pr-merged");
    expect(merged).toMatchObject({ at: "2026-11-13T00:00:00Z" });
    expect(r.tickets[1]!.ledger.coverage.prs).not.toBe("complete");
    // Live delivery evidence the fake cannot supply is never presented as delivered.
    for (const t of r.tickets) expect(t.verdict).not.toBe("delivered");
  });
});
