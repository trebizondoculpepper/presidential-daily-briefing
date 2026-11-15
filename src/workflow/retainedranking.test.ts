/**
 * Retained claims in ranking (#413): the shared facts, Datalog/TypeScript rollback agreement on
 * the same facts, and the owned-work review inside the default shortlist.
 */
import { describe, expect, it } from "vite-plus/test";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { presentBriefing } from "../briefing/service.js";
import type { Issue, Snapshot } from "../github/types.js";
import { issue, page, snapshot } from "../testing/snapshots.js";
import type { RetainedRead } from "./retained.js";
import { activityFact, ownedClaims, readRetainedFacts } from "./retainedfacts.js";

const me = "me_agent";
const ticket = (n: number, labels: string[], created = n): Issue => ({
  ...issue(n, ["status:ready", ...labels]),
  createdAt: new Date(Date.UTC(2026, 0, created)).toISOString(),
});
const local = () => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit("example/project"),
  fs: { ...emptyFileSystem, readText: async () => null },
});
const read = (activity: RetainedRead["activity"]): RetainedRead => ({
  activity,
  item: null,
  claimStartedAt: null,
  comments: [],
  others: [],
  othersComplete: true,
});

describe("retained-claim facts (#413)", () => {
  it("lists the viewer's open claims, unparked first then oldest, and knows when it is whole", () => {
    const s = snapshot([
      ticket(3, [`agent:${me}`], 1),
      ticket(1, [`agent:${me}`, "status:parked"], 0),
      ticket(2, [`agent:${me}`], 2),
      ticket(4, ["agent:someone_else"]),
    ]);
    const owned = ownedClaims(s, me);
    expect(owned.urls.map((u) => u.split("/").pop())).toEqual(["3", "2", "1"]);
    expect(owned.complete).toBe(true);
    const truncated = {
      ...s,
      issues: s.issues.map((i, n) => (n === 3 ? { ...i, labels: page(i.labels.nodes, true) } : i)),
    };
    expect(ownedClaims(truncated, me).complete).toBe(false);
  });

  it("states each activity, and never reads an unowned claim as waiting", () => {
    expect(activityFact(1, read({ state: "active", lastActivity: null }))).toEqual({
      state: "active",
      reason: "",
      number: 1,
    });
    const waiting = activityFact(
      1,
      read({
        state: "waiting",
        blocker: { kind: "dependency", repository: "o/r", issue: 9 },
        reason: "needs the parser",
        lastActivity: "1",
      }),
    );
    expect(waiting).toEqual({ state: "waiting", reason: "o/r#9 (needs the parser)", number: 1 });
    expect(activityFact(1, read({ state: "unknown", why: ["a", "b"] }))?.reason).toBe("a; b");
    expect(activityFact(1, read({ state: "not-owned", why: "gone" }))).toBeNull();
  });

  it("reads activity only on a live read; a failed read is unknown", async () => {
    const s = snapshot([ticket(1, [`agent:${me}`]), ticket(2, [`agent:${me}`])]);
    expect(await readRetainedFacts(s, undefined)).toBeUndefined();
    const offline = await readRetainedFacts(s, me);
    expect(offline?.claimActivity).toBeUndefined();
    expect(offline?.ownedClaims.urls).toHaveLength(2);
    const live = { query: async () => ({}), permission: async () => "write" as never };
    const facts = await readRetainedFacts(s, me, live, async (_r, n) => {
      if (n === 1) throw new Error("timeline unavailable");
      return read({ state: "active", lastActivity: null });
    });
    expect(facts?.claimActivity?.get(s.issues[0]!.url)).toMatchObject({ state: "unknown" });
    expect(facts?.claimActivity?.get(s.issues[1]!.url)).toMatchObject({ state: "active" });
  });
});

/** Ranked (kind, number) through one engine with the given retained facts. */
async function ranked(
  s: Snapshot,
  engine: "datalog" | "typescript",
  retained: NonNullable<Parameters<typeof presentBriefing>[1]["retained"]>,
  limit = 50,
) {
  const presented = await presentBriefing(
    s,
    {
      limit,
      maxChars: 100_000,
      role: "implementer",
      agent: me,
      retained,
      engineSetting: { requested: engine, source: "config" },
    },
    local(),
    new Date(Date.UTC(2026, 5, 1)),
  );
  const report = presented.report as {
    rankedActions?: { items: { kind: string; target: string }[] } | null;
  };
  const items = report.rankedActions?.items ?? [];
  return items.map((i) => `${i.kind} #${i.target.split("/").pop()}`);
}

describe("both engines rank retained claims alike (#413)", () => {
  const s = snapshot(
    [
      ticket(1, [`agent:${me}`, "impact:M", "complexity:M"]),
      ticket(2, [`agent:${me}`, "impact:M", "complexity:M"]),
      ticket(3, [`agent:${me}`, "impact:M", "complexity:M"]),
      ticket(4, ["impact:M", "complexity:M"]),
    ],
    [],
  );
  const url = (n: number) => s.issues.find((i) => i.number === n)!.url;
  const cases = {
    "one active": {
      ownedClaims: { urls: [url(1)], complete: true },
      claimActivity: new Map([[url(1), { state: "active" as const, reason: "" }]]),
    },
    "waiting, resume-required and unknown": {
      ownedClaims: { urls: [url(1), url(2), url(3)], complete: true },
      claimActivity: new Map([
        [url(1), { state: "waiting" as const, reason: "o/r#9" }],
        [url(2), { state: "resume-required" as const, reason: "cleared" }],
        [url(3), { state: "unknown" as const, reason: "history unknown" }],
      ]),
    },
    "offline: inventory only": { ownedClaims: { urls: [url(1), url(2)], complete: true } },
  };
  const only = (snap: Snapshot, keep: number[]) => ({
    ...snap,
    issues: snap.issues.filter((i) => keep.includes(i.number)),
  });
  for (const [name, retained] of Object.entries(cases))
    it(name, async () => {
      const keep = [...retained.ownedClaims.urls.map((u) => Number(u.split("/").pop())), 4];
      const view = only(s, keep);
      const datalog = await ranked(view, "datalog", retained);
      expect(await ranked(view, "typescript", retained)).toEqual(datalog);
      expect(datalog.length).toBeGreaterThan(0);
    });

  it("orders resume and review ahead of new work, and waits after it", async () => {
    const order = await ranked(s, "datalog", cases["waiting, resume-required and unknown"]);
    const at = (row: string) => order.indexOf(row);
    expect(at("resume-claim #2")).toBeLessThan(at("implement #4"));
    expect(at("review-owned-work #1")).toBeLessThan(at("implement #4"));
    expect(at("inspect #3")).toBeLessThan(at("implement #4"));
    expect(at("wait-claim #1")).toBeGreaterThan(at("implement #4"));
    expect(order.filter((r) => r.startsWith("continue-implementation"))).toEqual([]);
  });

  it("keeps the owned-work review inside the default shortlist ahead of eleven assessments", async () => {
    const backlog = Array.from({ length: 11 }, (_, i) => ticket(20 + i, ["impact:L"]));
    const busy = snapshot([...s.issues.slice(0, 2), ...backlog], []);
    const retained = {
      ownedClaims: { urls: [url(1), url(2)], complete: true },
      claimActivity: new Map([
        [url(1), { state: "waiting" as const, reason: "o/r#9" }],
        [url(2), { state: "active" as const, reason: "" }],
      ]),
    };
    const shown = await ranked(busy, "datalog", retained, 10);
    expect(shown).toHaveLength(10);
    expect(shown[0]).toBe("review-owned-work #1");
    expect(shown.filter((r) => r.startsWith("estimate-complexity"))).toHaveLength(9);
  });
});
