/** Offline presentation probe for #352. Only committed synthetic parity inputs; no GitHub. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { briefing } from "../src/briefing/briefing.js";
import { compactBriefing, compactText } from "../src/briefing/compact.js";
import { evaluateDatalog } from "../src/rules/datalog/datalog.js";
import type { DatalogOptions } from "../src/rules/datalog/datalog.js";
import type { Snapshot } from "../src/github/types.js";
import type { SubjectAssessments } from "../src/briefing/assessments.js";

interface Input {
  source: string;
  snapshot: Snapshot;
  assessments: [string, SubjectAssessments][];
  options: Omit<DatalogOptions, "role" | "order" | "now" | "responsible"> & {
    responsible?: [string, string[]][];
  };
}
const fixture = readFileSync("src/rules/datalog/parity.golden.json", "utf8");
// The committed parity runner validates this same fixture; this probe never accepts live input.
const cases = (JSON.parse(fixture) as { cases: { input: Input }[] }).cases;
const probes = [
  "chooses easy implementation, boosted assessment, then unfavorable work",
  "unknown native, label and closing coverage",
  "PR follow-up beats new work",
  "designer duties precede assessment",
  "counts immediate distinct eligible dependents",
];
const labels: Record<string, string> = {
  "pr-follow-up": "Follow up PR",
  "review-others": "Review PR",
  "estimate-complexity": "Estimate complexity",
  "assess-impact": "Assess impact",
  "continue-implementation": "Continue",
  implement: "Implement",
  design: "Design",
  decide: "Decide",
  "design-review": "Review design",
  inspect: "Inspect",
  "addressed-response": "Respond",
};
const results = [];
for (const probe of probes) {
  const input = cases.find((c) => c.input.source.includes(probe))?.input;
  assert.ok(input, `missing committed fixture: ${probe}`);
  for (const role of ["implementer", "designer"] as const) {
    const { responsible, ...rest }: Input["options"] = input.options;
    const options: DatalogOptions = {
      ...rest,
      ...(responsible ? { responsible: new Map(responsible) } : {}),
      role,
      order: "impact" as const,
      limit: 100,
    };
    // These public fixtures deliberately use 999 to prove the engine ignores supplied scores.
    // Normalize that presentation-only sentinel for BOTH projections; the source graph is unchanged.
    const assessments = new Map(
      input.assessments.map(([url, assessment]) => [
        url,
        assessment.unlocks === 999 ? { ...assessment, unlocks: 0 } : assessment,
      ]),
    );
    const ranked = evaluateDatalog(input.snapshot, assessments, { ...options, now: () => 0 });
    assert.deepEqual(
      ranked,
      evaluateDatalog(input.snapshot, new Map(input.assessments), { ...options, now: () => 0 }),
      "normalizing a synthetic display sentinel must not change native decisions",
    );
    const report = compactBriefing(
      input.snapshot,
      options,
      briefing(input.snapshot, options, new Date(input.snapshot.fetchedAt)),
      assessments,
      "available",
      ranked,
    );
    const unchanged = JSON.stringify(report);
    const whole = compactText(report, 1_000_000);
    const before = /\nNEXT STEPS[^\n]*\n([\s\S]*?)(?=\n\n[A-Z]|$)/.exec(whole)?.[0].trim() ?? "";
    const byUrl = new Map(report.subjects.map((s) => [s.url, s]));
    const after = ranked.items.length
      ? [
          `NEXT STEPS (${ranked.total})`,
          ...ranked.items.map((item, i) => {
            const subject = byUrl.get(item.target);
            assert.ok(subject);
            return [
              `${i + 1}. ${labels[item.kind] ?? item.kind} #${subject.number}: ${subject.title}`,
              `   ${item.why.text}`,
              ...(item.unlocks > 0
                ? [`   Unlocks ${item.unlocksUnknown.length ? "at least " : ""}${item.unlocks}.`]
                : []),
              ...(item.unlocksUnknown.length
                ? ["   Unlock evidence incomplete; inspect detail."]
                : []),
              item.nextCommand
                ? `   Next: ${item.nextCommand}`
                : `   Inspect: ${item.inspection ?? subject.detailCommand}`,
              ...(item.thenCommand ? [`   Then: ${item.thenCommand}`] : []),
              `   ${item.target}`,
            ].join("\n");
          }),
        ].join("\n")
      : "";
    for (const item of ranked.items) {
      assert.ok(before.includes(item.why.text));
      assert.ok(after.includes(item.why.text));
      assert.ok(after.includes(item.target));
      if (item.nextCommand) assert.ok(after.includes(item.nextCommand));
      if (item.thenCommand) assert.ok(after.includes(item.thenCommand));
    }
    assert.equal(JSON.stringify(report), unchanged, "presentation must not mutate the report");
    const characters = (text: string) => [...text].length;
    results.push({
      fixture: input.source,
      role,
      rulesHash: ranked.decisionEngine.rulesHash,
      actions: ranked.items.map((i) => ({ kind: i.kind, ruleIds: i.ruleIds, why: i.why.text })),
      beforeCharacters: characters(before),
      afterCharacters: characters(after),
      before,
      after,
    });
  }
}
console.log(
  JSON.stringify(
    {
      fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
      normalization:
        "Assessment-only unlock sentinel 999 becomes 0 before BOTH renderings; asserted not to change native decisions. Graph facts remain unchanged.",
      note: "Same synthetic inputs and real native decisions. Row-only text projection; no live data, production renderer change, tokenizer or comprehension study.",
      results,
    },
    null,
    2,
  ),
);
