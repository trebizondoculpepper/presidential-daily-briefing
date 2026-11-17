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
  labels?: string[];
}
const node = (i: Issue) => ({
  number: i.number,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: i.updatedAt,
  state: i.state ?? "OPEN",
  closedAt: null,
  stateReason: null,
  lastEditedAt: null,
  labels: { nodes: (i.labels ?? []).map((name) => ({ name })), pageInfo: { hasNextPage: false } },
  comments: { totalCount: i.totalCount ?? (i.comments ?? []).length, nodes: i.comments ?? [] },
});

/** A fake GraphQL boundary: issue pages of the given size, empty timelines, and known PRs. */
interface MergedPr {
  number: number;
  updatedAt: string;
  mergedAt: string;
  closes: number[];
  moreRefs?: boolean;
}
function fake(
  issues: Issue[],
  pageSize: number,
  prs: Record<number, string | null> = {},
  merged: MergedPr[] = [],
  extra: Issue[] = [],
) {
  const calls: string[] = [];
  const query = async (q: string, v: Record<string, string | number>) => {
    if (q.includes("pullRequests(first:50")) {
      calls.push("pr-walk");
      const start = Number(v.cursor ?? 0);
      const slice = merged.slice(start, start + pageSize).map((p) => ({
        number: p.number,
        updatedAt: p.updatedAt,
        mergedAt: p.mergedAt,
        closingIssuesReferences: {
          nodes: p.closes.map((n) => ({ number: n, repository: { nameWithOwner: repo } })),
          pageInfo: { hasNextPage: p.moreRefs ?? false },
        },
      }));
      const more = start + pageSize < merged.length;
      return {
        repository: {
          pullRequests: {
            nodes: slice,
            pageInfo: { hasNextPage: more, endCursor: more ? String(start + pageSize) : null },
          },
        },
      };
    }
    if (q.includes("issue(number:$number){number createdAt")) {
      calls.push(`issue:${v.number}`);
      const found = extra.find((i) => i.number === Number(v.number));
      return { repository: { issue: found ? node(found) : null } };
    }
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
  it("keeps the PR source unread when delivery membership is unknown", async () => {
    // Over 100 comments: records may be unseen, so membership (and the PR set) is unknown.
    const { rt } = fake(
      [
        {
          number: 1,
          updatedAt: "2026-11-16T00:00:00Z",
          comments: [submit(1, [10], "2026-11-12T00:00:00Z")],
          totalCount: 150,
        },
      ],
      50,
      { 10: "2026-11-13T00:00:00Z" },
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.tickets[0]!.ledger.requiredPullRequests).toBeNull();
    expect(r.tickets[0]!.ledger.coverage.prs).not.toBe("complete");
  });

  it("counts REST evidence requests and stops them after cancellation", async () => {
    const { rt } = fake([{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }], 50);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readMetrics(repo, FROM, NOW, { ...(rt as object), signal: controller.signal } as never),
    ).rejects.toThrow();
  });
  it("adds tickets closed by an in-window merge that the issue walk did not reach", async () => {
    const { calls, rt } = fake(
      [{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }],
      50,
      {},
      [
        {
          number: 90,
          updatedAt: "2026-11-15T00:00:00Z",
          mergedAt: "2026-11-15T00:00:00Z",
          closes: [9],
        },
      ],
      [{ number: 9, updatedAt: "2026-11-01T00:00:00Z" }],
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(calls).toContain("issue:9");
    expect(r.tickets.map((t) => t.member)).toEqual([`${repo}#1`, `${repo}#9`]);
    expect(r.limitations.join(" ")).toMatch(/another repository/);
  });

  it("limits complete history to where the pull request walk stopped", async () => {
    const merged = Array.from({ length: 4 }, (_, i) => ({
      number: 100 + i,
      updatedAt: `2026-11-${String(16 - i).padStart(2, "0")}T00:00:00Z`,
      mergedAt: `2026-11-${String(16 - i).padStart(2, "0")}T00:00:00Z`,
      closes: [],
    }));
    const { rt } = fake([{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }], 2, {}, merged);
    const r = await readMetrics(repo, FROM, NOW, rt, { maxPages: 1, maxTickets: 100 });
    expect(r.coverage.completeFrom).toBe("2026-11-15T00:00:00Z");
    expect(r.warnings.join(" ")).toMatch(/pull request walk stopped/);
  });

  it("catches a failed PR read as missing evidence for that ticket only", async () => {
    const { rt } = fake(
      [
        {
          number: 1,
          updatedAt: "2026-11-16T00:00:00Z",
          comments: [submit(1, [10], "2026-11-12T00:00:00Z")],
        },
      ],
      50,
    );
    const failing = {
      ...(rt as { query: (q: string, v: Record<string, string | number>) => Promise<unknown> }),
      query: async (q: string, v: Record<string, string | number>) => {
        if (q.includes("pullRequest(number:$number){number state mergedAt}"))
          throw new Error("FORBIDDEN");
        return (
          rt as { query: (q: string, v: Record<string, string | number>) => Promise<unknown> }
        ).query(q, v);
      },
    };
    const r = await readMetrics(repo, FROM, NOW, failing as never);
    expect(r.tickets[0]!.ledger.coverage.prs).not.toBe("complete");
  });

  it("classifies a stale assessment as stale, through the shared classifier", async () => {
    const record = (size: string) =>
      comment(
        `<!-- github-triage:complexity-estimate v2 ${JSON.stringify({
          schemaVersion: 2,
          kind: "complexity-estimate",
          storage: "labels",
          size,
          previous: [],
          rationale: "r",
          assumptions: [],
          references: [],
          estimator: "alice",
          revision: "x",
          guidanceVersion: 1,
          recordedAt: "2026-11-11T00:00:00Z",
        })} -->`,
        "2026-11-11T00:00:00Z",
      );
    const issue = (n: number, label: string) => ({
      number: n,
      updatedAt: "2026-11-16T00:00:00Z",
      comments: [record("S")],
      labels: [label],
    });
    const { rt } = fake([issue(1, "complexity:S"), issue(2, "complexity:L")], 50);
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.tickets.map((t) => t.complexity)).toEqual(["S", "stale"]);
  });
  it("records truncated closing references and unreadable linked tickets as unread", async () => {
    const { rt } = fake(
      [{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }],
      50,
      {},
      [
        {
          number: 91,
          updatedAt: "2026-11-15T00:00:00Z",
          mergedAt: "2026-11-15T00:00:00Z",
          closes: [8],
          moreRefs: true,
        },
      ],
      [],
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.historyNotRead.members).toEqual([
      `${repo} PR #91: closing references beyond 50`,
      `${repo}#8`,
    ]);
    expect(r.historyNotRead.count).toBe(2);
  });
  it("returns every in-window merge from the PR walk, standalone PRs included", async () => {
    const { rt } = fake([], 50, {}, [
      {
        number: 95,
        updatedAt: "2026-11-15T00:00:00Z",
        mergedAt: "2026-11-15T00:00:00Z",
        closes: [],
      },
      {
        number: 96,
        updatedAt: "2026-11-09T00:00:00Z",
        mergedAt: "2026-11-09T00:00:00Z",
        closes: [],
      },
    ]);
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(r.merges).toEqual([{ at: "2026-11-15T00:00:00Z", key: `${repo}#95` }]);
  });

  it("rejects when cancelled during collection instead of returning a partial result", async () => {
    const controller = new AbortController();
    const { rt } = fake([{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }], 50);
    const inner = rt as {
      query: (q: string, v: Record<string, string | number>) => Promise<unknown>;
    };
    const aborting = {
      ...inner,
      signal: controller.signal,
      // Abort while the timeline is read; later readers would swallow request failures.
      query: async (q: string, v: Record<string, string | number>) => {
        const result = await inner.query(q, v);
        if (q.includes("timelineItems")) controller.abort();
        return result;
      },
    };
    await expect(readMetrics(repo, FROM, NOW, aborting as never)).rejects.toThrow();
  });
  it("reads no more required PRs than the delivery member cap", async () => {
    const many = Array.from({ length: 25 }, (_, i) => 200 + i);
    const { calls, rt } = fake(
      [
        {
          number: 1,
          updatedAt: "2026-11-16T00:00:00Z",
          comments: [submit(1, many, "2026-11-12T00:00:00Z")],
        },
      ],
      50,
    );
    const r = await readMetrics(repo, FROM, NOW, rt);
    expect(calls.filter((c) => c.startsWith("pr:")).length).toBe(20);
    expect(r.tickets[0]!.ledger.coverage.prs).not.toBe("complete");
    expect(r.warnings.join(" ")).toMatch(/exceed the cap of 20/);
  });
  it("bounds linked-ticket lookups by the ticket bound", async () => {
    const { calls, rt } = fake(
      [{ number: 1, updatedAt: "2026-11-16T00:00:00Z" }],
      50,
      {},
      [
        {
          number: 92,
          updatedAt: "2026-11-15T00:00:00Z",
          mergedAt: "2026-11-15T00:00:00Z",
          closes: [5, 6],
        },
      ],
      [
        { number: 5, updatedAt: "2026-11-01T00:00:00Z" },
        { number: 6, updatedAt: "2026-11-01T00:00:00Z" },
      ],
    );
    const r = await readMetrics(repo, FROM, NOW, rt, { maxPages: 10, maxTickets: 2 });
    expect(calls.filter((c) => c.startsWith("issue:"))).toEqual(["issue:5"]);
    expect(r.historyNotRead.members).toContain(`${repo}#6`);
  });
});
