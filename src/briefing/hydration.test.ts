import { describe, expect, it } from "vite-plus/test";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { hydrationSubjects, presentBriefing, shownSubjects } from "./service.js";
import { issue, snapshot } from "../testing/snapshots.js";

// Synthetic snapshot only; no GitHub read.
const local = () => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit("example/project"),
  fs: { ...emptyFileSystem, readText: async () => null },
});

describe("role-neutral shortlist hydration (#652)", () => {
  it("hydrates the same subjects for either role and covers what each shows", async () => {
    // A mix of implementation, design and assessment duties, more than the display limit.
    const s = snapshot(
      [
        ...Array.from({ length: 6 }, (_, i) => issue(1 + i, ["status:ready"])),
        ...Array.from({ length: 6 }, (_, i) =>
          issue(20 + i, ["status:ready", "status:needs-design"]),
        ),
      ],
      [],
    );
    const limit = 3;
    const report = async (role: "implementer" | "designer") =>
      (
        await presentBriefing(
          s,
          {
            limit,
            maxChars: 100_000,
            role,
            agent: "me",
            engineSetting: { requested: "datalog", source: "config" },
          },
          local(),
          new Date(Date.UTC(2026, 5, 1)),
        )
      ).report;
    const implementer = await report("implementer");
    const designer = await report("designer");
    const a = hydrationSubjects(implementer, limit);
    const b = hydrationSubjects(designer, limit);
    expect([...a].sort()).toEqual([...b].sort());
    // The engine's per-role ranks reproduce each role's own displayed order exactly.
    const { HYDRATION_POOL } = await import("./compact.js");
    const { RANK_PARTITION } = await import("../rules/datalog/engine.js");
    type Item = { id: string; [RANK_PARTITION]?: string };
    const byRank = (report: unknown, field: number) =>
      [...((report as Record<symbol, Item[]>)[HYDRATION_POOL] ?? [])]
        .sort(
          (x, y) =>
            Number(String(x[RANK_PARTITION]).split("/")[field]) -
            Number(String(y[RANK_PARTITION]).split("/")[field]),
        )
        .map((i) => i.id);
    const ids = (report: unknown) =>
      (report as { rankedActions: { items: { id: string }[] } }).rankedActions.items.map(
        (i) => i.id,
      );
    expect(byRank(implementer, 4).slice(0, limit)).toEqual(ids(implementer));
    expect(byRank(designer, 5).slice(0, limit)).toEqual(ids(designer));
    expect(byRank(implementer, 5)).toEqual(byRank(designer, 5));
    for (const url of [...shownSubjects(implementer), ...shownSubjects(designer)])
      expect(a).toContain(url);
    // Bounded: at most each role's limit, never the whole pool.
    expect(a.length).toBeLessThanOrEqual(2 * limit);
  });
});

describe("bounded project-preference hydration (#652 review)", () => {
  it("hydrates at most `limit` preferred activities, highest priority first", async () => {
    const { hydrationSubjects } = await import("./service.js");
    const { HYDRATION_POOL } = await import("./compact.js");
    const { RANK_PARTITION } = await import("../rules/datalog/engine.js");
    const pool = Array.from({ length: 80 }, (_, i) => ({
      [RANK_PARTITION]: `1/1/0/implementer/${i}/${i}`,
      id: String(i),
      target: `https://github.com/o/r/issues/${i}`,
      band: 6,
      why: { project: [{ priority: i === 70 ? 50 : 10 }] },
    }));
    const report = { [HYDRATION_POOL]: pool, subjects: [] } as never;
    const subjects = hydrationSubjects(report, 3);
    // Both role prefixes (0-2) plus three preferred activities: #70 (priority 50), then 0 and 1.
    expect(subjects).toEqual([0, 1, 2, 70].map((n) => `https://github.com/o/r/issues/${n}`));
  });
});

describe("interleaved role prefixes (#652 review)", () => {
  it("alternates the two roles' prefixes so a shared cap cannot crowd one out", async () => {
    const { hydrationSubjects } = await import("./service.js");
    const { HYDRATION_POOL } = await import("../briefing/compact.js");
    const { RANK_PARTITION } = await import("../rules/datalog/engine.js");
    // Implementer ranks favour 0-3, designer ranks favour 4-7: disjoint prefixes.
    const pool = Array.from({ length: 8 }, (_, i) => ({
      [RANK_PARTITION]: `1/1/0/shared/${i}/${(i + 4) % 8}`,
      id: String(i),
      target: `u${i}`,
      band: 6,
    }));
    const subjects = hydrationSubjects({ [HYDRATION_POOL]: pool, subjects: [] } as never, 2);
    expect(subjects).toEqual(["u0", "u4", "u1", "u5"]);
  });
});
