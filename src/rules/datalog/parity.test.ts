/**
 * Golden parity for the #348 extraction (doc/design/rules-component.md, "Migration plan").
 *
 * `parity.golden.json` records, for every input the existing rule tests pass to
 * `evaluateDatalog` plus the package-test fixture, the complete result for both roles and all
 * three pickup orders. This test replays every recorded input through the current engine and
 * requires an identical result: actions, order, denials, explanations and bindings.
 *
 * Regenerate only for an intentional policy change, and say so in the PR:
 *   PDB_PARITY_REGENERATE=1 npx vp test run src/rules/datalog/parity.test.ts
 * Regeneration also runs the source test files, so their own assertions still apply.
 */
import { describe, it, expect, vi, afterAll } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDatalog, rulesHash, type DatalogOptions, type DatalogResult } from "./datalog.js";
import type { Snapshot, Issue, Page } from "../../github/types.js";
import type { SubjectAssessments, MetricView } from "../../briefing/assessments.js";

type Evaluate = typeof evaluateDatalog;
interface RecordedInput {
  source: string;
  snapshot: Snapshot;
  assessments: [string, SubjectAssessments][];
  options: Omit<DatalogOptions, "role" | "order" | "signal" | "now" | "responsible"> & {
    responsible?: [string, string[]][];
  };
}
interface GoldenCase {
  input: RecordedInput;
  results: Record<string, DatalogResult | { error: string }>;
}
interface Golden {
  note: string;
  rulesHash: string;
  cases: GoldenCase[];
}

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "parity.golden.json");
const regenerate = process.env.PDB_PARITY_REGENERATE === "1";
const roles = ["implementer", "designer"] as const;
const orders = ["impact", "oldest", "newest"] as const;
/** The engine's own scope limit; inputs above it are covered by the scope test, not the golden. */
const maxSubjects = 500;

const recorded: RecordedInput[] = [];
vi.mock("./datalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./datalog.js")>();
  const wrapped: Evaluate = (snapshot, assessments, options) => {
    if (regenerate)
      record(expect.getState().currentTestName ?? "unknown test", snapshot, assessments, options);
    return original.evaluateDatalog(snapshot, assessments, options);
  };
  return { ...original, evaluateDatalog: wrapped };
});

function record(
  source: string,
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, SubjectAssessments>,
  options: DatalogOptions,
): void {
  // Aborted calls never reach a decision, so there is nothing to compare.
  if (options.signal?.aborted) return;
  if (snapshot.issues.length + snapshot.pullRequests.length > maxSubjects) return;
  const { role: _role, order: _order, signal: _signal, now: _now, responsible, ...rest } = options;
  recorded.push(
    structuredClone({
      source,
      snapshot,
      assessments: [...assessments],
      options: {
        ...rest,
        ...(responsible
          ? { responsible: [...responsible].map(([k, v]) => [k, [...v]] as [string, string[]]) }
          : {}),
      },
    }),
  );
}

/** Replays one recorded input with a fixed clock, so the soft-budget diagnostic cannot vary. */
function replay(
  evaluate: Evaluate,
  input: RecordedInput,
  role: (typeof roles)[number],
  order: (typeof orders)[number],
): DatalogResult | { error: string } {
  const { responsible, ...rest } = input.options;
  try {
    // A JSON round trip drops undefined fields exactly as the golden file does.
    return JSON.parse(
      JSON.stringify(
        evaluate(input.snapshot, new Map(input.assessments), {
          ...rest,
          ...(responsible ? { responsible: new Map(responsible) } : {}),
          role,
          order,
          now: () => 0,
        }),
      ),
    ) as DatalogResult;
  } catch (error) {
    // Errors are part of the recorded behaviour, never swallowed: the message is compared.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The installed-archive fixture from scripts/package-test.ts, transcribed as engine input. */
function packageTestInput(): RecordedInput {
  const page = <T>(nodes: T[] = []): Page<T> => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const time = "2026-11-12T10:00:00.000Z";
  const issue = (number: number, labels: string[], createdAt: string): Issue => ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: `https://github.com/example/parity/issues/${number}`,
    state: "OPEN",
    createdAt,
    updatedAt: time,
    labels: page(labels.map((name) => ({ name }))),
    comments: page(),
    blockedBy: page(),
    blocking: page(),
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    closedByPullRequestsReferences: page(),
  });
  const metric = (size: MetricView["size"]): MetricView => ({
    size,
    state: size ? "current" : "unassessed",
    provenance: null,
  });
  const issues = [
    issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
    issue(2, ["status:ready", "impact:XL"], "2026-11-02T00:00:00Z"),
    issue(3, ["status:needs-design", "complexity:XS"], "2026-11-03T00:00:00Z"),
    issue(4, ["status:ready", "impact:S", "complexity:M"], "2026-10-01T00:00:00Z"),
  ];
  const sizes: [MetricView["size"], MetricView["size"]][] = [
    ["L", "S"],
    ["XL", null],
    [null, "XS"],
    ["S", "M"],
  ];
  return {
    source: "scripts/package-test.ts fake gh fixture (transcribed)",
    snapshot: {
      schemaVersion: 1,
      repository: "example/parity",
      startedAt: time,
      fetchedAt: time,
      issues,
      pullRequests: [],
      dependencies: [],
      changed: [],
      since: null,
      warnings: [],
      rateLimit: null,
    },
    assessments: issues.map((i, n) => [
      i.url,
      {
        impact: metric(sizes[n][0]),
        complexity: metric(sizes[n][1]),
        unlocks: 0,
        unlocksUnknown: [],
      },
    ]),
    options: { limit: 10 },
  };
}

if (regenerate) {
  // Importing the test files registers their suites here, so every call they make is recorded.
  await import("./datalog.test.js");
  await import("./assessment-priority.test.js");
}

if (regenerate)
  afterAll(async () => {
    const { evaluateDatalog: evaluate, rulesHash } =
      await vi.importActual<typeof import("./datalog.js")>("./datalog.js");
    const seen = new Set<string>();
    const inputs = [...recorded, packageTestInput()].filter((input) => {
      const key = JSON.stringify([input.snapshot, input.assessments, input.options]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const golden: Golden = {
      note: "Generated by src/rules/datalog/parity.test.ts with PDB_PARITY_REGENERATE=1. Do not edit by hand.",
      rulesHash,
      cases: inputs.map((input) => ({
        input,
        results: Object.fromEntries(
          roles.flatMap((role) =>
            orders.map((order) => [`${role}/${order}`, replay(evaluate, input, role, order)]),
          ),
        ),
      })),
    };
    writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);
  });

describe.skipIf(regenerate)("golden parity (#348)", () => {
  const golden = regenerate
    ? { note: "", rulesHash: "", cases: [] }
    : (JSON.parse(readFileSync(goldenPath, "utf8")) as Golden);

  it("rulesHash is unchanged; a change must update the golden and be stated in the PR", () => {
    expect(rulesHash).toBe(golden.rulesHash);
  });

  it("covers the existing rule-test inputs and every role/order combination", () => {
    expect(golden.cases.length).toBeGreaterThan(20);
    for (const c of golden.cases)
      expect(Object.keys(c.results).sort()).toEqual(
        roles.flatMap((r) => orders.map((o) => `${r}/${o}`)).sort(),
      );
  });

  it.each(golden.cases.map((c, i) => [i, c] as const))(
    "case %i reproduces the recorded decisions and explanations",
    (_, c) => {
      for (const role of roles)
        for (const order of orders) {
          const actual = replay(evaluateDatalog, c.input, role, order);
          // rulesHash is compared once below; everything else must match exactly.
          if ("decisionEngine" in actual) actual.decisionEngine.rulesHash = golden.rulesHash;
          expect(actual, `${c.input.source} ${role}/${order}`).toEqual(
            c.results[`${role}/${order}`],
          );
        }
    },
  );
});
