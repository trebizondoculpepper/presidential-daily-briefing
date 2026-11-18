import { describe, expect, it } from "vite-plus/test";
import { LEDGER_SCHEMA_VERSION, type TicketLedger } from "./ledger.js";
import { inventoryView, type InventoryFacts, type MetricTicket } from "./views.js";

function ledger(
  number: number,
  currentState: TicketLedger["currentState"] = "open",
  overrides: Partial<TicketLedger> = {},
): TicketLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    repository: "o/r",
    number,
    observedAt: "2026-11-12T10:00:00.000Z",
    events: [],
    firstPickup: {
      "claim-marker": { status: "none" },
      label: { status: "none" },
    },
    requeues: { known: true, value: 0 },
    reopens: { known: true, value: 0 },
    membership: null,
    requiredPullRequests: [],
    requiredOtherMembers: 0,
    currentState,
    stateReason: null,
    coverage: {
      comments: "complete",
      timeline: "complete",
      deliveryRecords: "complete",
      prs: "complete",
    },
    omissions: [],
    ignored: [],
    assessments: {
      complexity: {
        first: { status: "none" },
        revisions: { known: true, value: 0 },
        records: [],
        ignored: [],
        unresolved: [],
      },
      impact: {
        first: { status: "none" },
        revisions: { known: true, value: 0 },
        records: [],
        ignored: [],
        unresolved: [],
      },
    },
    ...overrides,
  };
}

function ticket(
  number: number,
  currentState: TicketLedger["currentState"],
  inventory?: InventoryFacts,
  ledgerOverrides: Partial<TicketLedger> = {},
): MetricTicket {
  return {
    member: `o/r#${number}`,
    ledger: ledger(number, currentState, ledgerOverrides),
    verdict: "none",
    complexity: "M",
    inventory,
  };
}

describe("inventoryView (#883)", () => {
  const now = "2026-11-12T10:00:00.000Z";
  const coverage = { completeFrom: "2026-11-01T00:00:00.000Z" };

  it("aggregates current open tickets by native stage with median/oldest ages and separates closed/unknown", () => {
    const tickets: MetricTicket[] = [
      // Closed historical ticket must not enter current open inventory.
      ticket(1, "closed", { stage: "ready", createdAt: "2026-11-01T00:00:00.000Z" }),
      // Unknown-state ticket is reported separately in stateUnknown.
      ticket(2, "unknown", { stage: "unknown", createdAt: "2026-11-02T00:00:00.000Z" }),
      // Two ready tickets: 2h and 6h old -> median 4h, oldest 6h.
      ticket(3, "open", { stage: "ready", createdAt: "2026-11-12T08:00:00.000Z" }),
      ticket(4, "open", { stage: "ready", createdAt: "2026-11-12T04:00:00.000Z" }),
      // Unassessed ticket with unknown createdAt -> counted in unknownCount, not 0.
      ticket(5, "open", { stage: "unassessed", createdAt: null }),
      // Claimed ticket aged from first valid pickup (10h ago), even if createdAt was earlier.
      ticket(
        6,
        "open",
        { stage: "claimed", createdAt: "2026-11-10T00:00:00.000Z", waiting: false, blocked: false },
        {
          firstPickup: {
            "claim-marker": { status: "none" },
            label: {
              status: "found",
              at: "2026-11-12T00:00:00.000Z",
              agent: "alice",
              key: "label:1",
            },
          },
        },
      ),
      // In-review ticket 1h old.
      ticket(7, "open", { stage: "in-review", createdAt: "2026-11-12T09:00:00.000Z" }),
      // Blocked ticket aged from lastObservedChangeAt (3h ago), not createdAt (11 days ago).
      ticket(8, "open", {
        stage: "blocked",
        createdAt: "2026-11-01T00:00:00.000Z",
        lastObservedChangeAt: "2026-11-12T07:00:00.000Z",
        blocked: true,
      }),
    ];

    const view = inventoryView(now, tickets, coverage);
    expect(view.view).toBe("inventory");
    expect(view.cohort).toBe("current-open-inventory");
    expect(view.totalOpen).toBe(6);
    expect(view.stateUnknown).toEqual({ count: 1, members: ["o/r#2"] });
    expect(view.stages.ready).toEqual({
      count: 2,
      members: ["o/r#3", "o/r#4"],
      age: {
        medianMs: 4 * 3_600_000,
        oldestMs: 6 * 3_600_000,
        knownCount: 2,
        unknownCount: 0,
        unknownMembers: [],
      },
    });
    expect(view.stages.unassessed).toEqual({
      count: 1,
      members: ["o/r#5"],
      age: {
        medianMs: null,
        oldestMs: null,
        knownCount: 0,
        unknownCount: 1,
        unknownMembers: ["o/r#5"],
      },
    });
    expect(view.stages.claimed.age.medianMs).toBe(10 * 3_600_000);
    expect(view.stages.blocked.age.medianMs).toBe(3 * 3_600_000);
    expect(view.stages["in-review"].members).toEqual(["o/r#7"]);
  });

  it("splits stalled claimed work into knownWait, blocked, noRecordedProgress, and unknownActivity at UTC cutoff", () => {
    // Default 24h cutoff: 2026-11-11T10:00:00.000Z
    const tickets: MetricTicket[] = [
      // Recent event exactly at cutoff -> NOT stalled.
      ticket(
        10,
        "open",
        { stage: "claimed", claimedAt: "2026-11-10T00:00:00.000Z", waiting: false, blocked: false },
        {
          events: [
            {
              at: "2026-11-11T10:00:00.000Z",
              kind: "picked-up",
              agent: "a",
              source: "label",
              key: "k1",
            },
          ],
        },
      ),
      // Stalled with known wait.
      ticket(11, "open", {
        stage: "claimed",
        claimedAt: "2026-11-10T00:00:00.000Z",
        waiting: true,
        blocked: false,
      }),
      // Stalled with native blocker.
      ticket(12, "open", {
        stage: "claimed",
        claimedAt: "2026-11-10T00:00:00.000Z",
        waiting: false,
        blocked: true,
      }),
      // Stalled with no recorded progress (complete evidence, neither waiting nor blocked).
      ticket(13, "open", {
        stage: "claimed",
        claimedAt: "2026-11-10T00:00:00.000Z",
        waiting: false,
        blocked: false,
      }),
      // Partial comment coverage -> unknownActivity, never guessed as noRecordedProgress.
      ticket(
        14,
        "open",
        { stage: "claimed", claimedAt: "2026-11-10T00:00:00.000Z", waiting: false, blocked: false },
        {
          coverage: {
            comments: "partial",
            timeline: "complete",
            deliveryRecords: "complete",
            prs: "complete",
          },
        },
      ),
      // Partial PR coverage -> unknownActivity, never guessed as noRecordedProgress.
      ticket(
        15,
        "open",
        { stage: "claimed", claimedAt: "2026-11-10T00:00:00.000Z", waiting: false, blocked: false },
        {
          coverage: {
            comments: "complete",
            timeline: "complete",
            deliveryRecords: "complete",
            prs: "partial",
          },
        },
      ),
    ];

    const view = inventoryView(now, tickets, coverage, { stalledHours: 24 });
    expect(view.stalled.thresholdHours).toBe(24);
    expect(view.stalled.cutoff).toBe("2026-11-11T10:00:00.000Z");
    expect(view.stalled.total).toEqual({ count: 3, members: ["o/r#11", "o/r#12", "o/r#13"] });
    expect(view.stalled.knownWait).toEqual({ count: 1, members: ["o/r#11"] });
    expect(view.stalled.blocked).toEqual({ count: 1, members: ["o/r#12"] });
    expect(view.stalled.noRecordedProgress).toEqual({ count: 1, members: ["o/r#13"] });
    expect(view.stalled.unknownActivity).toEqual({ count: 2, members: ["o/r#14", "o/r#15"] });
  });
});
