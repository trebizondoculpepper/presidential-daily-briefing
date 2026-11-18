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
    for (const url of [...shownSubjects(implementer), ...shownSubjects(designer)])
      expect(a).toContain(url);
    // Bounded: at most each role's limit, never the whole pool.
    expect(a.length).toBeLessThanOrEqual(2 * limit);
  });
});
