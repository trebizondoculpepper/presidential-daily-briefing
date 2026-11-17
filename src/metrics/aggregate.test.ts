import { describe, expect, it } from "vite-plus/test";
import {
  PERCENTILE_MIN_SAMPLE,
  deliveryInstant,
  durationStats,
  firstPickup,
  groupedDurations,
  median,
  nearestRank,
  pickupToDelivery,
} from "./aggregate.js";
import type { DurationSample } from "./aggregate.js";
import type { LedgerEvent, TicketLedger } from "./ledger.js";

// Synthetic fixtures only: no real repository, agent or comment.
const repo = "example/project";
const H = 3_600_000;

function ledger(over: Partial<TicketLedger> = {}): TicketLedger {
  return {
    schemaVersion: 1,
    repository: repo,
    number: 1,
    observedAt: "2026-11-17T00:00:00Z",
    events: [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    requeues: { known: true, value: 0 },
    reopens: { known: true, value: 0 },
    membership: "complete",
    requiredPullRequests: [],
    requiredOtherMembers: 0,
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

describe("median and nearest-rank percentiles (#573 slice 4)", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3, 8])).toBe(3);
    expect(median([1, 3, 8, 10])).toBe(5.5);
  });

  it("uses nearest rank ceil(p/100 × n)", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(xs, 75)).toBe(15);
    expect(nearestRank(xs, 90)).toBe(18);
    expect(nearestRank([7], 90)).toBe(7);
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe("duration statistics (#573 slice 4)", () => {
  const completed = (n: number): DurationSample[] =>
    Array.from({ length: n }, (_, i) => ({
      member: `#${i}`,
      status: "completed",
      ms: (i + 1) * H,
    }));

  it("shows percentiles only from the 20th completed member", () => {
    expect(PERCENTILE_MIN_SAMPLE).toBe(20);
    const nineteen = durationStats(completed(19));
    expect(nineteen).toMatchObject({ completed: 19, p75: null, p90: null });
    const twenty = durationStats(completed(20));
    expect(twenty).toMatchObject({ completed: 20, p75: 15 * H, p90: 18 * H });
  });

  it("matches the contract example: median 7h, mean 7h, 2 delivered, 1 open (≥ 30h)", () => {
    const s = durationStats([
      { member: "A", status: "completed", ms: 4 * H },
      { member: "B", status: "completed", ms: 10 * H },
      { member: "C", status: "open", elapsedMs: 30 * H },
    ]);
    expect(s).toMatchObject({
      median: 7 * H,
      mean: 7 * H,
      completed: 2,
      open: { count: 1, longestElapsedMs: 30 * H },
      unknown: 0,
    });
  });

  it("reports unknown members rather than dropping them, and counts each ticket once", () => {
    const s = durationStats([
      { member: "A", status: "completed", ms: H },
      { member: "A", status: "completed", ms: 99 * H },
      { member: "B", status: "unknown", reason: "never picked up" },
    ]);
    expect(s).toMatchObject({ completed: 1, mean: H, unknown: 1 });
    expect(s.members).toEqual({ completed: ["A"], open: [], unknown: ["B"] });
  });

  it("applies the sample threshold within each group, not across groups", () => {
    const samples = [
      ...completed(12).map((s) => ({ ...s, group: "S" })),
      ...completed(12).map((s) => ({ ...s, member: `L${s.member}`, group: "L" })),
    ];
    const groups = groupedDurations(samples);
    expect(groups.get("S")).toMatchObject({ completed: 12, p90: null });
    expect(groups.get("L")).toMatchObject({ completed: 12, p90: null });
    for (const g of groups.values()) expect(g.completed).toBe(g.members.completed.length);
  });
});

describe("first pickup (#573 slice 4)", () => {
  it("takes the earliest proven pickup across both sources, with its source", () => {
    const l = ledger({
      firstPickup: {
        "claim-marker": {
          status: "found",
          at: "2026-11-12T10:00:00Z",
          agent: "a",
          key: "comment:5",
        },
        label: { status: "found", at: "2026-11-11T09:00:00Z", agent: "a", key: "label:1" },
      },
    });
    expect(firstPickup(l)).toMatchObject({
      status: "found",
      source: "label",
      at: "2026-11-11T09:00:00Z",
    });
  });

  it("counts an event observed in an incomplete source as proven", () => {
    const l = ledger({
      firstPickup: {
        "claim-marker": { status: "none" },
        label: {
          status: "unknown",
          reason: "timeline cut off",
          observed: { at: "2026-11-11T09:00:00Z", agent: null, key: "label:1" },
        },
      },
    });
    expect(firstPickup(l)).toMatchObject({ status: "found", source: "label" });
  });

  it("is unknown, never none, when nothing is proven and a source is incomplete", () => {
    const l = ledger({
      firstPickup: {
        "claim-marker": { status: "none" },
        label: { status: "unknown", reason: "timeline cut off", observed: null },
      },
    });
    expect(firstPickup(l)).toEqual({ status: "unknown", reason: "timeline cut off" });
    expect(firstPickup(ledger())).toEqual({ status: "none" });
  });
});

describe("delivery instant (#573 slice 4)", () => {
  it("dates a PR-only set by the last required merge, ignoring closedAt", () => {
    const l = ledger({
      requiredPullRequests: [
        { repository: repo, number: 10 },
        { repository: repo, number: 11 },
      ],
      events: [merged(10, "2026-11-10T08:00:00Z"), merged(11, "2026-11-10T20:00:00Z")],
    });
    expect(deliveryInstant(l, "delivered")).toEqual({
      status: "dated",
      at: "2026-11-10T20:00:00Z",
      basis: "last-required-merge",
    });
  });

  it("leaves the instant undated when any required member is not a pull request", () => {
    const l = ledger({
      requiredPullRequests: [{ repository: repo, number: 10 }],
      requiredOtherMembers: 1,
      events: [merged(10, "2026-11-10T08:00:00Z")],
    });
    expect(deliveryInstant(l, "delivered")).toMatchObject({ status: "undated" });
  });

  it("is undated with open or unknown membership, or an unobserved merge", () => {
    expect(deliveryInstant(ledger({ membership: "open" }), "delivered").status).toBe("undated");
    expect(deliveryInstant(ledger({ membership: "unknown" }), "delivered").status).toBe("undated");
    const missing = ledger({ requiredPullRequests: [{ repository: repo, number: 10 }] });
    expect(deliveryInstant(missing, "delivered")).toMatchObject({ status: "undated" });
  });

  it("dates an attestation by its trusted record and labels it as attestation", () => {
    const l = ledger({
      events: [
        {
          kind: "delivery",
          source: "delivery-record",
          op: "attest",
          agent: "a",
          at: "2026-11-12T12:00:00Z",
          key: "comment:9",
        },
      ],
    });
    expect(deliveryInstant(l, "attested")).toEqual({
      status: "dated",
      at: "2026-11-12T12:00:00Z",
      basis: "attestation",
    });
  });

  it("dates a legacy attestation the same way", () => {
    const l = ledger({
      events: [
        {
          kind: "delivery",
          source: "delivery-record",
          op: "legacy-attest",
          agent: "a",
          at: "2026-11-12T12:00:00Z",
          key: "comment:9",
        },
      ],
    });
    expect(deliveryInstant(l, "attested")).toMatchObject({ status: "dated", basis: "attestation" });
  });

  it("does not date a ticket the verdict says is not delivered or unknown", () => {
    expect(deliveryInstant(ledger(), "none")).toEqual({ status: "not-delivered" });
    expect(deliveryInstant(ledger(), "unknown").status).toBe("undated");
  });
});

describe("pickup to delivery (#573 slice 4)", () => {
  const picked = (at: string) =>
    ({
      "claim-marker": { status: "found", at, agent: "a", key: "comment:1" },
      label: { status: "none" },
    }) as const;

  it("measures first pickup to the last required merge; handoffs do not restart it", () => {
    const l = ledger({
      firstPickup: picked("2026-11-10T00:00:00Z"),
      requiredPullRequests: [{ repository: repo, number: 10 }],
      events: [
        {
          kind: "delivery",
          source: "delivery-record",
          op: "handoff",
          agent: "b",
          at: "2026-11-10T04:00:00Z",
          key: "comment:2",
        },
        merged(10, "2026-11-10T10:00:00Z"),
      ],
    });
    expect(pickupToDelivery("#1", l, "delivered", "2026-11-17T00:00:00Z")).toEqual({
      member: "#1",
      status: "completed",
      ms: 10 * H,
    });
  });

  it("reports open work as a lower bound and missing endpoints as unknown", () => {
    const open = ledger({ firstPickup: picked("2026-11-16T00:00:00Z") });
    expect(pickupToDelivery("#2", open, "none", "2026-11-17T06:00:00Z")).toEqual({
      member: "#2",
      status: "open",
      elapsedMs: 30 * H,
    });
    expect(pickupToDelivery("#3", ledger(), "delivered", "2026-11-17T00:00:00Z")).toMatchObject({
      status: "unknown",
      reason: "never picked up",
    });
  });
});
