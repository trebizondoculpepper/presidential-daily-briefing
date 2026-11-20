import { describe, expect, it } from "vite-plus/test";
import type { EstimateState } from "../estimation/estimation.js";
import type { AssessmentGroup, AssessmentGroups } from "./assessment.js";
import type { InventoryFacts } from "./inventory.js";
import type { TicketLedger } from "./ledger.js";
import { waitingImpactView, type WaitingImpactTicket } from "./waitingimpact.js";

function impactGroup(state: EstimateState, size: string | null = null): AssessmentGroup {
  return {
    basis: "current-valid-impact",
    state,
    group:
      state === "estimated"
        ? (size ?? "unknown")
        : state === "unestimated"
          ? "unassessed"
          : state === "conflicting"
            ? "conflict"
            : state,
    size,
    provenance: null,
    authority: "none",
    reasons: [],
  };
}

function ledger(currentState: TicketLedger["currentState"] = "open"): TicketLedger {
  return {
    schemaVersion: 1,
    repository: "o/r",
    number: 1,
    observedAt: "2026-06-10T12:00:00.000Z",
    events: [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    requeues: { known: true, value: 0 },
    reopens: { known: true, value: 0 },
    membership: null,
    requiredPullRequests: null,
    requiredOtherMembers: null,
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
  };
}

function ticket(
  member: string,
  impact: { state: EstimateState; size?: string | null },
  inventory?: InventoryFacts,
  currentState: TicketLedger["currentState"] = "open",
): WaitingImpactTicket {
  const assessment: AssessmentGroups = {
    complexity: {
      basis: "current-valid-complexity",
      state: "unestimated",
      group: "unassessed",
      size: null,
      provenance: null,
      authority: "none",
      reasons: [],
    },
    impact: impactGroup(impact.state, impact.size ?? null),
  };
  return { member, ledger: ledger(currentState), assessment, inventory };
}

describe("waitingImpactView", () => {
  const now = "2026-06-10T12:00:00.000Z";
  const coverage = { completeFrom: "2026-06-01T00:00:00.000Z" };

  it("groups unclaimed open backlog by current impact and splits ready vs blocked/not-ready", () => {
    const tickets: WaitingImpactTicket[] = [
      ticket("o/r#1", { state: "estimated", size: "XL" }, { stage: "ready", claimed: false }),
      ticket("o/r#2", { state: "estimated", size: "XL" }, { stage: "blocked", blocked: true }),
      ticket("o/r#3", { state: "unestimated" }, { stage: "unassessed" }),
      ticket("o/r#4", { state: "stale" }, { stage: "ready" }),
      ticket("o/r#5", { state: "conflicting" }, { stage: "ready" }),
      // Complete labels, unclaimed, but readiness unknown (e.g. needs-design): counted in backlog unknown readiness
      ticket(
        "o/r#12",
        { state: "estimated", size: "M" },
        { stage: "unknown", claimed: false, labelsComplete: true },
      ),
      // Truncated labels or missing inventory must go to claimUnknown, never totalUnclaimed
      ticket(
        "o/r#6",
        { state: "unknown" },
        { stage: "unknown", claimed: false, labelsComplete: false },
      ),
      ticket("o/r#11", { state: "estimated", size: "S" }, undefined),
      // Claimed, in-review, closed, and state-unknown must never enter the unclaimed waiting backlog
      ticket("o/r#7", { state: "estimated", size: "L" }, { stage: "claimed", claimed: true }),
      ticket("o/r#8", { state: "estimated", size: "L" }, { stage: "in-review", claimed: true }),
      ticket("o/r#9", { state: "estimated", size: "M" }, { stage: "ready" }, "closed"),
      ticket("o/r#10", { state: "estimated", size: "M" }, undefined, "unknown"),
    ];

    const res = waitingImpactView(now, tickets, coverage);
    expect(res.view).toBe("waiting-impact");
    expect(res.cohort).toBe("current-open-inventory");
    expect(res.totalUnclaimed).toBe(6);
    expect(res.coverage.note).toBeNull();

    expect(res.totals.ready.members).toEqual(["o/r#1", "o/r#4", "o/r#5"]);
    expect(res.totals.blocked.members).toEqual(["o/r#2"]);
    expect(res.totals.notReady.members).toEqual(["o/r#2", "o/r#3"]);
    expect(res.totals.unknown.members).toEqual(["o/r#12"]);

    expect(res.groups.XL!.total.members).toEqual(["o/r#1", "o/r#2"]);
    expect(res.groups.XL!.ready.members).toEqual(["o/r#1"]);
    expect(res.groups.XL!.blocked.members).toEqual(["o/r#2"]);
    expect(res.groups.XL!.notReady.members).toEqual(["o/r#2"]);
    expect(res.groups.M!.unknown.members).toEqual(["o/r#12"]);

    expect(res.groups.unassessed!.notReady.members).toEqual(["o/r#3"]);
    expect(res.groups.stale!.ready.members).toEqual(["o/r#4"]);
    expect(res.groups.conflict!.ready.members).toEqual(["o/r#5"]);
    expect(res.claimUnknown.members).toEqual(["o/r#6", "o/r#11"]);
    expect(res.stateUnknown.members).toEqual(["o/r#10"]);
  });

  it("reports each group's waiting age since creation, counting unknown ages (#685)", () => {
    const at = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const tickets: WaitingImpactTicket[] = [
      ticket(
        "o/r#1",
        { state: "estimated", size: "L" },
        { stage: "ready", createdAt: at(2), labelsComplete: true },
      ),
      ticket(
        "o/r#2",
        { state: "estimated", size: "L" },
        { stage: "blocked", createdAt: at(8), labelsComplete: true },
      ),
      ticket(
        "o/r#3",
        { state: "estimated", size: "L" },
        { stage: "ready", createdAt: null, labelsComplete: true },
      ),
      ticket(
        "o/r#4",
        { state: "unestimated" },
        { stage: "unassessed", createdAt: at(1), labelsComplete: true },
      ),
    ];
    const res = waitingImpactView(now, tickets, coverage);
    const day = 86_400_000;
    expect(res.groups.L!.age).toEqual({
      medianMs: 5 * day,
      oldestMs: 8 * day,
      knownCount: 2,
      unknownCount: 1,
      unknownMembers: ["o/r#3"],
    });
    expect(res.groups.unassessed!.age).toMatchObject({
      medianMs: day,
      oldestMs: day,
      knownCount: 1,
    });
    expect(res.totals.age).toMatchObject({ oldestMs: 8 * day, knownCount: 3, unknownCount: 1 });
    // A group with no tickets has no age, not a zero age.
    expect(res.groups.conflict!.age).toMatchObject({
      medianMs: null,
      oldestMs: null,
      knownCount: 0,
    });
  });

  it("counts a future creation time as an unknown age, as the inventory does (#1142 review)", () => {
    const future = new Date(Date.parse(now) + 60_000).toISOString();
    const res = waitingImpactView(
      now,
      [
        ticket(
          "o/r#1",
          { state: "estimated", size: "L" },
          { stage: "ready", createdAt: future, labelsComplete: true },
        ),
      ],
      coverage,
    );
    expect(res.groups.L!.age).toMatchObject({
      knownCount: 0,
      unknownCount: 1,
      unknownMembers: ["o/r#1"],
      medianMs: null,
    });
  });
});
