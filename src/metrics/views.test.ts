import { describe, expect, it } from "vite-plus/test";
import { dailyView, newsView, timingView } from "./views.js";
import type { MetricTicket } from "./views.js";
import type { LedgerEvent, TicketLedger } from "./ledger.js";

// Synthetic fixtures only: no real repository, agent or comment.
const repo = "example/project";
const NOW = "2026-11-17T09:00:00.000Z";
const H = 3_600_000;

function ledger(n: number, over: Partial<TicketLedger> = {}): TicketLedger {
  return {
    schemaVersion: 1,
    repository: repo,
    number: n,
    observedAt: NOW,
    events: [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    requeues: { known: true, value: 0 },
    reopens: { known: true, value: 0 },
    membership: "complete",
    requiredPullRequests: [],
    requiredOtherMembers: 0,
    currentState: "open",
    stateReason: null,
    coverage: {
      comments: "complete",
      timeline: "complete",
      deliveryRecords: "complete",
      prs: "complete",
    },
    omissions: [],
    ignored: [],
    ...over,
  };
}
const merged = (n: number, at: string): LedgerEvent => ({
  kind: "pr-merged",
  source: "pull-request",
  pr: { repository: repo, number: n },
  at,
  key: `pr:${n}`,
});
const closed = (n: number, at: string, reason: string): LedgerEvent => ({
  kind: "closed",
  source: "issue",
  reason,
  at,
  key: `${repo}#${n}:closed:${at}`,
});
const picked = (at: string) =>
  ({
    "claim-marker": { status: "found", at, agent: "a", key: "comment:1" },
    label: { status: "none" },
  }) as const;
const ticket = (
  n: number,
  verdict: MetricTicket["verdict"],
  over: Partial<TicketLedger>,
  complexity = "S",
): MetricTicket => ({
  member: `${repo}#${n}`,
  ledger: ledger(n, over),
  verdict,
  complexity,
});
const covered = { completeFrom: "2026-10-01T00:00:00Z" };

describe("daily view (#573 slice 5a)", () => {
  // The contract's worked example on 2026-11-10 (UTC).
  const tickets = [
    ticket(1, "delivered", {
      requiredPullRequests: [
        { repository: repo, number: 10 },
        { repository: repo, number: 11 },
      ],
      events: [merged(10, "2026-11-10T08:00:00Z"), merged(11, "2026-11-10T15:00:00Z")],
    }),
    ticket(2, "delivered", {
      requiredPullRequests: [{ repository: repo, number: 12 }],
      events: [merged(12, "2026-11-10T20:00:00Z")],
    }),
    ticket(3, "none", {
      currentState: "closed",
      stateReason: "COMPLETED",
      events: [closed(3, "2026-11-10T12:00:00Z", "COMPLETED")],
    }),
  ];

  it("matches the contract example: 2 deliveries, 1 unverified, 0 not planned, 3 merges", () => {
    const v = dailyView(NOW, 7, tickets, covered);
    const day = (f: keyof typeof v.figures) =>
      v.figures[f].series.days.find((d) => d.day === "2026-11-10");
    expect(day("deliveries")).toMatchObject({
      status: "known",
      count: 2,
      members: [`${repo}#1`, `${repo}#2`],
    });
    expect(day("closedCompletedUnverified")).toMatchObject({ count: 1, members: [`${repo}#3`] });
    expect(day("closedNotPlanned")).toMatchObject({ count: 0 });
    expect(day("prMerges")).toMatchObject({ count: 3 });
    expect(v.figures.deliveries.average).toMatchObject({ knownDays: 7, unknownDays: 0 });
  });

  it("counts a PR shared by two tickets once and keeps undated deliveries out of the series", () => {
    const shared = [
      ticket(4, "delivered", {
        requiredPullRequests: [{ repository: repo, number: 20 }],
        events: [merged(20, "2026-11-12T08:00:00Z")],
      }),
      ticket(5, "delivered", {
        requiredPullRequests: [{ repository: repo, number: 20 }],
        events: [merged(20, "2026-11-12T08:00:00Z")],
      }),
      ticket(6, "delivered", { requiredOtherMembers: 1 }),
    ];
    const v = dailyView(NOW, 7, shared, covered);
    const merges = v.figures.prMerges.series.days.find((d) => d.day === "2026-11-12");
    expect(merges).toMatchObject({ count: 1 });
    expect(v.deliveredDateUnknown).toEqual({ count: 1, members: [`${repo}#6`] });
  });

  it("reports unknown days and a coverage note when history is incomplete", () => {
    const v = dailyView(NOW, 7, tickets, { completeFrom: "2026-11-12T00:00:00Z" });
    const d10 = v.figures.deliveries.series.days.find((d) => d.day === "2026-11-10");
    expect(d10).toMatchObject({ status: "unknown", count: null, observed: 2 });
    expect(v.coverage.note).toMatch(/may be missing/);
  });
});

describe("news view (#573 slice 5a)", () => {
  it("lists events in [now − 6h, now), newest first, each event once", () => {
    const t = ticket(7, "none", {
      events: [
        merged(30, "2026-11-17T02:59:59.999Z"),
        merged(31, "2026-11-17T03:00:00.000Z"),
        merged(32, "2026-11-17T08:00:00.000Z"),
        merged(33, "2026-11-17T09:00:00.000Z"),
      ],
    });
    const v = newsView(NOW, 6, [t, t], covered);
    expect(v.items.map((i) => i.key)).toEqual(["pr:32", "pr:31"]);
    expect(v.omitted).toBe(0);
    expect(newsView(NOW, 6, [t], covered, 1)).toMatchObject({ omitted: 1 });
  });
});

describe("timing view (#573 slice 5a)", () => {
  it("groups by complexity and includes only deliveries inside the window", () => {
    const inside = ticket(8, "delivered", {
      firstPickup: picked("2026-11-15T00:00:00Z"),
      requiredPullRequests: [{ repository: repo, number: 40 }],
      events: [merged(40, "2026-11-15T10:00:00Z")],
    });
    const outside = ticket(9, "delivered", {
      firstPickup: picked("2026-09-01T00:00:00Z"),
      requiredPullRequests: [{ repository: repo, number: 41 }],
      events: [merged(41, "2026-09-02T00:00:00Z")],
    });
    const open = ticket(10, "none", { firstPickup: picked("2026-11-16T09:00:00Z") }, "M");
    const abandoned = ticket(11, "none", {
      firstPickup: picked("2026-11-14T00:00:00Z"),
      currentState: "closed",
      stateReason: "NOT_PLANNED",
      events: [closed(11, "2026-11-15T00:00:00Z", "NOT_PLANNED")],
    });
    const v = timingView(NOW, 7, [inside, outside, open, abandoned], covered);
    expect(v.groupBasis).toBe("latest-valid-complexity");
    expect(v.groups["S"]).toMatchObject({ completed: 1, median: 10 * H, closedUndelivered: 1 });
    expect(v.groups["S"]!.members.completed).toEqual([`${repo}#8`]);
    expect(v.groups["M"]).toMatchObject({
      completed: 0,
      open: { count: 1, longestElapsedMs: 24 * H },
    });
  });
});
