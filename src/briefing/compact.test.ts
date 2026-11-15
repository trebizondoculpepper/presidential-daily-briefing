import { describe, expect, it } from "vite-plus/test";
import { argumentsFor } from "../cli.js";
import { briefing } from "./briefing.js";
import { issue, page, pr, snapshot, time } from "../testing/snapshots.js";

describe("compact briefing contract", () => {
  it("omits empty sections and zero counters from text while preserving structured metadata", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const data = snapshot([], []),
      expanded = briefing(data, { limit: 10 }, new Date(time));
    const report = compactBriefing(data, { limit: 10 }, expanded);
    const text = compactText(report);
    expect(report.actions).toMatchObject({ total: 0, omitted: 0, items: [] });
    expect(text).not.toContain("NEXT STEPS");
    expect(text).not.toContain("0 omitted");
    expect(text).not.toContain("Read-only suggestions, not authority");
    expect(text).toContain("No --agent given:");
    expect(argumentsFor([]).limit).toBe(10);
    expect(argumentsFor(["--limit", "2"]).limit).toBe(2);
  });

  it("deduplicates targets, separates parked questions and preserves full detail", async () => {
    const { compactBriefing, compactText, sourceContext } = await import("./compact.js");
    const parked = issue(7, ["status:parked", "question"]);
    const mine = issue(8, ["agent:reader"]);
    mine.lastEditedAt = "2026-11-12T12:00:00Z";
    mine.comments = page([
      { body: "old question?", url: `${mine.url}#comment`, author: null, createdAt: time },
    ]);
    const data = snapshot([parked, mine, issue()], [pr()]);
    const expanded = briefing(data, { limit: 100, issue: 8 }, new Date(time));
    const compact = compactBriefing(data, { limit: 5, agent: "reader" }, expanded);
    expect(compact.schemaVersion).toBe(2);
    expect(new Set(compact.actions.items).size).toBe(compact.actions.items.length);
    expect(compact.actions.items).not.toContain(parked.url);
    expect(compact.sections.deferred.items).toContain(parked.url);
    expect(compact.sections.current.items).toContain(mine.url);
    expect(compact.detail?.comments.nodes[0].body).toBe("old question?");
    expect(sourceContext(mine).chronology).toContain("superseded");
    expect(sourceContext(parked).chronology).toContain("Unknown");
    const noDetail = { ...compact, detail: null };
    expect(compactText(noDetail, 1500).length).toBeLessThanOrEqual(1500);
    expect(compactText(noDetail, 600)).toContain("Truncated due to maximum size");
  });
  it("keeps real estimation warnings visible even with no estimate candidates", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const data = snapshot([], []);
    const base = compactBriefing(
      data,
      { limit: 10 },
      briefing(data, { limit: 10 }, new Date(time)),
    );
    const report = {
      ...base,
      estimation: {
        ...base.estimation,
        queue: { total: 0, omitted: 0, items: [] },
        conflicts: { total: 1, omitted: 0, items: [] },
        unknown: 1,
        detail: "Conflicting sizing and unknown provenance require inspection.",
      },
    };
    expect(compactText(report)).toContain(
      "Conflicting sizing and unknown provenance require inspection.",
    );
  });
  it("bounds independent requests, retains order and propagates failure", async () => {
    const { concurrentMap } = await import("../github/github.js");
    let active = 0;
    let peak = 0;
    const results = await concurrentMap([1, 2, 3, 4, 5, 6, 7], async (n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    await expect(
      concurrentMap([1], async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
  });
});
