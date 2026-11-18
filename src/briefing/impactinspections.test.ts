import { describe, expect, it } from "vite-plus/test";
import { impactEstimationReport } from "./compact.js";

// Synthetic ranked items only.
const item = (n: number, kind: string, impact: string, complexity: string) =>
  ({
    kind,
    target: `https://github.com/o/r/issues/${n}`,
    impact: { state: impact, size: null },
    complexity: { state: complexity, size: null },
  }) as never;

describe("impact inspection counts (#652 review)", () => {
  it("counts impact-only and combined inspections, never a complexity-only one", () => {
    const ranked = [
      item(1, "inspect-assessment", "current", "conflict"), // complexity only: not counted
      item(2, "inspect-assessment", "invalid", "current"), // impact only
      item(3, "inspect-assessment", "conflict", "invalid"), // combined
    ];
    const report = impactEstimationReport(
      "available" as never,
      new Map(),
      ranked,
      ranked.slice(0, 2),
    );
    expect(report.inspections).toEqual({ ranked: 2, shown: 1 });
  });
});
