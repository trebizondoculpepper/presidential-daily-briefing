/**
 * Pipeline Health waiting backlog by impact (#685): the real `waitingImpactView` result through
 * the client and component. Group order, ready versus blocked/not-ready, explicit unassessed and
 * unknown impact, ages, bounded drill-down and excluded tickets. No server or GitHub.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { waitingImpactView } from "../../metrics/waitingimpact.js";
import type { WaitingImpactTicket } from "../../metrics/waitingimpact.js";
import { parseWaitingResponse, waitingGroupOrder, waitingLoader } from "./client.js";
import type { WaitingState as State } from "./client.js";
import WaitingState from "./WaitingState.svelte";

const now = "2026-11-20T12:00:00.000Z";
const day = 86_400_000;
const at = (days: number) => new Date(Date.parse(now) - days * day).toISOString();
const ledger = (currentState = "open") =>
  ({
    currentState,
    events: [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    coverage: {
      timeline: "complete",
      comments: "complete",
      deliveryRecords: "complete",
      prs: "complete",
    },
  }) as never;
const impact = (state: string, size: string | null = null) =>
  ({
    impact: {
      group: state === "estimated" ? size : state === "unestimated" ? "unassessed" : state,
    },
  }) as never;
const ticket = (
  n: number,
  group: [string, string?],
  stage: "ready" | "blocked" | "unassessed" | "unknown",
  ageDays: number | null,
  currentState = "open",
): WaitingImpactTicket => ({
  member: `o/r#${n}`,
  ledger: ledger(currentState),
  assessment: impact(group[0], group[1] ?? null),
  inventory: {
    stage,
    createdAt: ageDays === null ? null : at(ageDays),
    labelsComplete: true,
    claimed: false,
  },
});
const envelope = (tickets: WaitingImpactTicket[]) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "metrics",
  status: "complete",
  selection: { repository: "o/r" },
  warnings: [],
  freshness: null,
  error: null,
  result: waitingImpactView(now, tickets, { completeFrom: "2026-01-01T00:00:00Z" }),
});
const html = (state: State) =>
  render(WaitingState, { props: { state } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
const row = (out: string, label: string) =>
  [
    ...new RegExp(`<th scope="row">${label}</th>((?:<td>[^<]*</td>)+)`)
      .exec(out.replace(/> </g, "><"))![1]!
      .matchAll(/<td>([^<]*)<\/td>/g),
  ].map((m) => m[1]);

describe("waiting backlog by impact (#685)", () => {
  it("orders groups by impact, then explicit unassessed/stale/conflict/unknown", () => {
    expect(
      waitingGroupOrder({ unknown: 0, S: 0, unassessed: 0, XL: 0, conflict: 0, stale: 0 }),
    ).toEqual(["XL", "S", "unassessed", "stale", "conflict", "unknown"]);
  });

  it("shows counts, readiness split and age per impact group, with explicit unknowns", () => {
    const body = envelope([
      ticket(1, ["estimated", "L"], "ready", 2),
      ticket(2, ["estimated", "L"], "blocked", 8),
      ticket(3, ["estimated", "L"], "ready", null),
      ticket(4, ["unestimated"], "unassessed", 1),
      ticket(5, ["estimated", "S"], "unknown", 3),
      ticket(6, ["estimated", "M"], "ready", 1, "unknown"),
    ]);
    const response = parseWaitingResponse(body);
    expect(response).not.toBeNull();
    const out = html({ status: "ready", response: response! });
    // Waiting, Ready, Blocked, Not ready, Readiness unknown, Typical, Oldest, Unknown age.
    expect(row(out, "Impact L")).toEqual(["3", "2", "1", "1", "0", "5d", "8d", "1"]);
    expect(row(out, "Impact S")).toEqual(["1", "0", "0", "0", "1", "3d", "3d", "0"]);
    expect(row(out, "Unassessed")).toEqual(["1", "0", "0", "1", "0", "1d", "1d", "0"]);
    expect(row(out, "All")[0]).toBe("5");
    expect(out.indexOf("Impact L")).toBeLessThan(out.indexOf("Impact S"));
    expect(out).toContain("Blocked tickets are also counted under Not ready");
    expect(out).toContain("No impact is guessed");
    // Every group links to its tickets, marking readiness.
    expect(out).toContain('<a href="/ticket?repo=o%2Fr&amp;n=2">o/r#2</a> <span>(blocked)</span>');
    expect(out).toContain('<span class="warn">(readiness unknown)</span>');
    expect(out).toContain("Whether 1 ticket is open or closed could not be established");
  });

  it("bounds each drill-down and refuses a malformed result", () => {
    const many = Array.from({ length: 27 }, (_, i) =>
      ticket(i + 1, ["estimated", "M"], "ready", 1),
    );
    const out = html({ status: "ready", response: parseWaitingResponse(envelope(many))! });
    expect((out.match(/<li>/g) ?? []).length).toBe(25);
    expect(out).toContain("2 more not listed.");
    const bad = envelope(many);
    (bad.result.groups as Record<string, unknown>).M = { total: { count: 1 } };
    expect(parseWaitingResponse(bad)).toBeNull();
  });

  it("reads the waiting-impact view and bypasses the cache only on Refresh", async () => {
    const calls: string[] = [];
    const loader = waitingLoader(
      "/api/v1/metrics",
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(envelope([])), { status: 200 });
      }) as typeof fetch,
      () => {},
    );
    await loader.load("o/r");
    await loader.refresh();
    expect(calls).toEqual([
      "/api/v1/metrics?view=waiting-impact&repo=o%2Fr",
      "/api/v1/metrics?view=waiting-impact&repo=o%2Fr&refresh=true",
    ]);
  });

  it("refreshes both sections with one fresh collection (#1142 review)", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(envelope([])), { status: 200 });
    }) as typeof fetch;
    const { inventoryLoader, refreshSections } = await import("./client.js");
    const sections = [
      inventoryLoader("/api/v1/metrics", fetcher, () => {}),
      waitingLoader("/api/v1/metrics", fetcher, () => {}),
    ];
    for (const s of sections) await s.load("o/r");
    calls.length = 0;
    await refreshSections(sections);
    // Only the first bypasses the cache; the second reads the collection it just refreshed.
    expect(calls).toEqual([
      "/api/v1/metrics?view=inventory&repo=o%2Fr&refresh=true",
      "/api/v1/metrics?view=waiting-impact&repo=o%2Fr",
    ]);
  });

  it("shows when the backlog's facts were collected (#1142 review)", () => {
    const body = {
      ...envelope([ticket(1, ["estimated", "L"], "ready", 1)]),
      freshness: {
        source: "cached",
        observedAt: "2026-11-20T11:40:00Z",
        ageSeconds: 1200,
        ttlSeconds: 900,
        expiresAt: "x",
        stale: true,
        refreshError: null,
      },
    };
    const out = html({ status: "ready", response: parseWaitingResponse(body)! });
    expect(out).toContain('Facts collected at <time datetime="2026-11-20T11:40:00Z">');
    expect(out).toContain("(cached, 20m old, stale)");
    expect(out).toContain("figures computed at");
  });
});
