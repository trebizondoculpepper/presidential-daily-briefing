/**
 * Pipeline Health stage inventory (#684): response parsing, age display, bounded drill-down to
 * tickets, safe text, and project changes that never show another project's figures. Synthetic
 * results through the real `inventoryView`; injected fetch; no server or GitHub.
 */
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { inventoryView } from "../../metrics/inventory.js";
import type { InventoryTicket } from "../../metrics/inventory.js";
import {
  fetchInventory,
  formatAge,
  inventoryLoader,
  parseInventoryResponse,
  selectedRepository,
  ticketLink,
} from "./client.js";
import type { InventoryState } from "./client.js";
import PipelineState from "./PipelineState.svelte";

const now = new Date("2026-11-20T12:00:00Z");
const day = 86_400_000;
const ticket = (
  n: number,
  stage: "ready" | "blocked" | "claimed" | "unassessed",
  ageDays: number | null,
): InventoryTicket => ({
  member: `o/r#${n}`,
  ledger: {
    currentState: "open",
    events: [],
    firstPickup: { "claim-marker": { status: "none" }, label: { status: "none" } },
    coverage: {
      timeline: "complete",
      comments: "complete",
      deliveryRecords: "complete",
      prs: "complete",
    },
  } as never,
  inventory: {
    stage,
    createdAt: ageDays === null ? null : new Date(now.getTime() - ageDays * day).toISOString(),
    lastObservedChangeAt:
      ageDays === null ? null : new Date(now.getTime() - ageDays * day).toISOString(),
    claimedAt:
      stage === "claimed" && ageDays !== null
        ? new Date(now.getTime() - ageDays * day).toISOString()
        : null,
    claimed: stage === "claimed",
    labelsComplete: true,
  },
});
const envelope = (tickets: InventoryTicket[], status = "complete") => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "metrics",
  status,
  selection: { repository: "o/r" },
  warnings: [],
  error: null,
  result: inventoryView(now.toISOString(), tickets, { completeFrom: "2026-01-01T00:00:00Z" }),
});
const reply = (status: number, json: unknown) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
const html = (state: InventoryState) =>
  render(PipelineState, { props: { state } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");

describe("pipeline client (#684)", () => {
  it("formats ages and links members to their tickets", () => {
    expect(formatAge(null)).toBe("unknown");
    expect(formatAge(30_000)).toBe("<1m");
    expect(formatAge(42 * 60_000)).toBe("42m");
    expect(formatAge(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatAge(3 * day + 4 * 3_600_000)).toBe("3d 4h");
    expect(ticketLink("o/r#12")).toBe("/ticket?repo=o%2Fr&n=12");
    expect(ticketLink("not a member")).toBeNull();
    expect(selectedRepository("?repo=o%2Fr")).toBe("o/r");
    expect(selectedRepository("?repo=%3Cscript%3E")).toBeNull();
  });

  it("reads the inventory envelope and refuses other shapes", async () => {
    const body = envelope([ticket(1, "ready", 2)]);
    expect(parseInventoryResponse(body)).not.toBeNull();
    expect(
      parseInventoryResponse({ ...body, result: { kind: "pipeline-metrics", view: "daily" } }),
    ).toBeNull();
    const ok = await fetchInventory("/api/v1/metrics", "o/r", async (input) => {
      expect(input).toBe("/api/v1/metrics?view=inventory&repo=o%2Fr");
      return reply(200, body);
    });
    expect(ok.status).toBe("ready");
    const refused = await fetchInventory("/api/v1/metrics", "o/r", async () =>
      reply(503, { error: { code: "GITHUB_UNAVAILABLE", message: "GitHub is unavailable." } }),
    );
    expect(refused).toEqual({
      status: "error",
      message: "GitHub is unavailable.",
      code: "GITHUB_UNAVAILABLE",
    });
  });

  it("drops a late response for the previous project and re-reads on Refresh", async () => {
    const pending = new Map<string, (r: Response) => void>();
    const calls: string[] = [];
    const fetcher = (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Promise<Response>((done) => pending.set(String(input), done));
    };
    const states: InventoryState[] = [];
    const loader = inventoryLoader("/api/v1/metrics", fetcher as typeof fetch, (s) =>
      states.push(s),
    );
    const first = loader.load("old/repo");
    const second = loader.load("new/repo");
    const newer = { ...envelope([ticket(1, "ready", 1)]), selection: { repository: "new/repo" } };
    pending.get("/api/v1/metrics?view=inventory&repo=new%2Frepo")!(reply(200, newer));
    await second;
    pending.get("/api/v1/metrics?view=inventory&repo=old%2Frepo")!(reply(200, envelope([])));
    await first;
    const ready = states.filter((s) => s.status === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.status === "ready" && ready[0]!.response.repository).toBe("new/repo");
    // The same project again is skipped (fragment-only navigation); Refresh always re-reads.
    await loader.load("new/repo");
    expect(calls).toHaveLength(2);
    const refreshed = loader.refresh();
    pending.get("/api/v1/metrics?view=inventory&repo=new%2Frepo&refresh=true")!(reply(200, newer));
    await refreshed;
    // #1141 review: Refresh bypasses the server cache; ordinary loads do not.
    expect(calls).toEqual([
      "/api/v1/metrics?view=inventory&repo=old%2Frepo",
      "/api/v1/metrics?view=inventory&repo=new%2Frepo",
      "/api/v1/metrics?view=inventory&repo=new%2Frepo&refresh=true",
    ]);
    await loader.load(null);
    expect(states.at(-1)).toEqual({ status: "no-project" });
  });
});

describe("stage inventory table (#684)", () => {
  it("shows ready, blocked and claimed counts with typical and oldest age and unknown ages", () => {
    const body = envelope([
      ticket(1, "ready", 1),
      ticket(2, "ready", 3),
      ticket(3, "ready", null),
      ticket(4, "blocked", 10),
      ticket(5, "claimed", 2),
      ticket(6, "unassessed", 4),
    ]);
    const out = html({ status: "ready", response: parseInventoryResponse(body)! });
    const row = (label: string) =>
      new RegExp(
        `<th scope="row">${label}</th><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td>`,
      )
        .exec(out.replace(/\s*\n\s*/g, ""))!
        .slice(1);
    expect(row("Ready")).toEqual(["3", "2d", "3d", "1"]);
    expect(row("Blocked")[0]).toBe("1");
    expect(row("Agent-claimed")[0]).toBe("1");
    // Exclusive stages explained; other stages counted, not hidden.
    expect(out).toContain("each ticket is counted in one row");
    expect(out).toMatch(/6 open tickets in total;\s*1 in other stages/);
    // Drill-down links to the tickets, and unknown ages are marked.
    expect(out).toContain('href="/ticket?repo=o%2Fr&amp;n=3"');
    expect(out).toMatch(/o\/r#3<\/a>\s*<span class="warn">\s*\(age unknown\)/);
  });

  it("bounds the drill-down, counting the rest, and shows warnings and errors as text", () => {
    const many = Array.from({ length: 30 }, (_, i) => ticket(i + 1, "ready", 1));
    const body = { ...envelope(many, "incomplete"), warnings: ["<img src=x onerror=alert(1)>"] };
    const out = html({ status: "ready", response: parseInventoryResponse(body)! });
    expect((out.match(/<li>/g) ?? []).length).toBe(25);
    expect(out).toContain("5 more not listed.");
    expect(out).toContain("Incomplete read");
    expect(out).toContain("&lt;img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(html({ status: "error", message: "<b>down</b>", code: null })).toContain(
      "&lt;b>down&lt;/b>",
    );
    expect(html({ status: "loading" })).toContain("Loading the inventory");
    expect(html({ status: "no-project" })).toContain("Choose a project");
  });
});
