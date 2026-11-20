/**
 * Pipeline Health work with no recorded progress (#688): the real `inventoryView` stalled
 * breakdown through the client and component. Known waits apart from unexplained gaps, owner and
 * agent shown with unknown kept unknown, last activity and wait reason, links, and no presence
 * claims or write actions. No server or GitHub.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { inventoryView } from "../../metrics/inventory.js";
import type { InventoryFacts, InventoryTicket } from "../../metrics/inventory.js";
import { parseInventoryResponse, stalledRows } from "./client.js";
import Stalled from "./Stalled.svelte";

const now = "2026-11-20T12:00:00.000Z";
const ticket = (
  n: number,
  facts: Partial<InventoryFacts>,
  lastAt: string | null,
  complete = true,
): InventoryTicket => ({
  member: `o/r#${n}`,
  ledger: {
    currentState: "open",
    events: lastAt
      ? [{ at: lastAt, kind: "picked-up", agent: "a", source: "label", key: `k${n}` }]
      : [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    coverage: complete
      ? { timeline: "complete", comments: "complete", deliveryRecords: "complete", prs: "complete" }
      : {
          timeline: "incomplete",
          comments: "complete",
          deliveryRecords: "complete",
          prs: "complete",
        },
  } as never,
  inventory: {
    stage: "claimed",
    claimed: true,
    blocked: false,
    waiting: false,
    labelsComplete: true,
    ...facts,
  },
});
const envelope = (tickets: InventoryTicket[]) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "metrics",
  status: "complete",
  selection: { repository: "o/r" },
  warnings: [],
  freshness: null,
  error: null,
  result: inventoryView(now, tickets, { completeFrom: "2026-01-01T00:00:00Z" }),
});
const html = (body: unknown) =>
  render(Stalled, { props: { response: parseInventoryResponse(body)! } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><");

describe("work with no recorded progress (#688)", () => {
  const tickets = [
    ticket(
      1,
      {
        waiting: true,
        agent: "kavya",
        humanOwners: ["salim"],
        waitReason: "Owner must choose (waiting on human question on o/r#1)",
      },
      "2026-11-18T09:00:00.000Z",
    ),
    ticket(2, { agent: "jonas", humanOwners: [] }, "2026-11-17T09:00:00.000Z"),
    ticket(3, { blocked: true, agent: "anouk", humanOwners: null }, null),
    ticket(4, { agent: "kavya" }, "2026-11-16T09:00:00.000Z", false),
    // Recent activity: not stalled.
    ticket(5, { agent: "kavya" }, "2026-11-20T09:00:00.000Z"),
  ];

  it("separates known waits from unexplained gaps and shows who holds each ticket", () => {
    const out = html(envelope(tickets));
    expect(out).toContain("<h3>Known wait: 1</h3>");
    expect(out).toContain("<h3>Blocked: 1</h3>");
    expect(out).toContain("<h3>No recorded progress: 1</h3>");
    expect(out).toContain("<h3>Activity unknown: 1</h3>");
    expect(out).toContain(
      '<th scope="row"><a href="/ticket?repo=o%2Fr&amp;n=1">o/r#1</a></th><td>kavya</td><td>salim</td><td><time datetime="2026-11-18T09:00:00.000Z">2026-11-18T09:00:00.000Z</time></td><td>Owner must choose (waiting on human question on o/r#1)</td>',
    );
    // Assignees read as empty are "none"; unread are "unknown"; no event is "none recorded".
    expect(out).toMatch(/o\/r#2<\/a><\/th><td>jonas<\/td><td>none<\/td>/);
    expect(out).toMatch(/o\/r#3<\/a><\/th><td>anouk<\/td><td>unknown<\/td><td>none recorded<\/td>/);
    expect(out).not.toContain("o/r#5");
    expect(out).toContain("in the last 24 hours");
    expect(out).toContain("not whether anyone is online");
    expect(out).not.toMatch(/\binactive\b|\babandoned\b|<button|<form/i);
  });

  it("lists rows in the server's order and refuses malformed stalled details", () => {
    const body = envelope(tickets);
    expect(stalledRows(body.result.stalled, "knownWait").map((r) => r.member)).toEqual(["o/r#1"]);
    (body.result.stalled.details as Record<string, unknown>)["o/r#1"] = { bucket: "asleep" };
    expect(parseInventoryResponse(body)).toBeNull();
  });
});
