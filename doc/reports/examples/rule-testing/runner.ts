/**
 * Minimal native-EDN scenario runner for the #336 example (doc/reports/rule-testing-recommendation.md).
 *
 * It executes the real evaluator (`evaluateDatalog`) with no GitHub, credentials, clock or CLI,
 * and reports two distinct outcomes:
 *
 * - `RuleDecisionFailure`: the scenario was validly evaluated and the decision differs.
 * - `RuleInfrastructureError`: the file, schema or evaluator failed, so no assertion was
 *   validly evaluated.
 *
 * Both carry the scenario id and `file:line`. Vitest's JUnit reporter writes every failing test
 * as `<failure>` and keeps the error's class in the `type` attribute, so the class name is what
 * lets a reporter (#394) tell the categories apart.
 */
import { evaluateDatalog } from "../../../../src/rules/datalog/datalog.js";
import type { DatalogResult } from "../../../../src/rules/datalog/datalog.js";
import type { SubjectAssessments, MetricView } from "../../../../src/briefing/assessments.js";
import type { Issue, NativeNode, Page, Snapshot } from "../../../../src/github/types.js";
import { EdnSyntaxError, get, isKeyword, mapLines, readEdn } from "./edn.js";
import type { Edn } from "./edn.js";

export interface Location {
  file: string;
  line: number;
  scenario: string;
}

export class RuleInfrastructureError extends Error {
  override name = "RuleInfrastructureError";
  constructor(
    readonly where: Location,
    detail: string,
  ) {
    super(`${where.file}:${where.line} ${where.scenario}: ${detail}`);
  }
}

export class RuleDecisionFailure extends Error {
  override name = "RuleDecisionFailure";
  constructor(
    readonly where: Location,
    readonly mismatches: string[],
  ) {
    super(`${where.file}:${where.line} ${where.scenario}:\n  ${mismatches.join("\n  ")}`);
  }
}

interface IssueFacts {
  n: number;
  labels: string[];
  labelsComplete: boolean;
  impact: string | null;
  complexity: string | null;
  blocks: number[];
}
interface ExpectedAction {
  n: number;
  kind: string;
  rule: string;
  band: number;
  facts?: Record<string, string | number | boolean>;
  overridden?: string[];
  unlocks?: number;
}
export interface Scenario {
  id: string;
  doc: string;
  where: Location;
  role: "implementer" | "designer";
  agent?: string;
  platform?: string;
  issues: IssueFacts[];
  actions: ExpectedAction[];
  denials: string[];
}

const text = (v: Edn | undefined): string | undefined =>
  typeof v === "string" ? v : isKeyword(v) ? v.keyword : undefined;
const list = (v: Edn | undefined): Edn[] =>
  Array.isArray(v)
    ? v
    : typeof v === "object" && v !== null && !(v instanceof Map) && "set" in v
      ? v.set
      : [];
const isMap = (v: Edn | undefined): v is Map<Edn, Edn> => v instanceof Map;

/** Parse and validate a scenario file. Any problem is infrastructure, never a rule failure. */
export function loadScenarios(source: string, file: string): Scenario[] {
  let root: Edn;
  try {
    root = readEdn(source, file);
  } catch (e) {
    const line = e instanceof EdnSyntaxError ? e.line : 1;
    throw new RuleInfrastructureError(
      { file, line, scenario: "(file)" },
      `EDN could not be read: ${(e as Error).message}`,
    );
  }
  if (!isMap(root) || !Array.isArray(get(root, "scenarios")))
    throw new RuleInfrastructureError(
      { file, line: 1, scenario: "(file)" },
      "expected {:scenarios [...]}",
    );
  const seen = new Set<string>();
  return list(get(root, "scenarios")).map((s) => {
    const line = isMap(s) ? (mapLines.get(s) ?? 1) : 1;
    const where = { file, line, scenario: isMap(s) ? (text(get(s, "id")) ?? "(no id)") : "(?)" };
    const bad = (detail: string): never => {
      throw new RuleInfrastructureError(where, detail);
    };
    if (!isMap(s)) return bad("scenario is not a map");
    if (where.scenario === "(no id)") bad("scenario has no :id");
    if (seen.has(where.scenario)) bad("duplicate scenario :id");
    seen.add(where.scenario);
    const given = get(s, "given"),
      expected = get(s, "expect");
    if (!isMap(given) || !isMap(expected)) return bad("scenario needs :given and :expect maps");
    const role = text(get(given, "role"));
    if (role !== "implementer" && role !== "designer") bad(`unsupported :role ${role}`);
    const issues = list(get(given, "issues")).map((i): IssueFacts => {
      if (!isMap(i) || typeof get(i, "n") !== "number") return bad("each issue needs a numeric :n");
      return {
        n: get(i, "n") as number,
        labels:
          get(i, "labels") === undefined ? ["status:ready"] : list(get(i, "labels")).map(String),
        labelsComplete: get(i, "labels-complete") !== false,
        impact: text(get(i, "impact")) ?? null,
        complexity: text(get(i, "complexity")) ?? null,
        blocks: list(get(i, "blocks")).map(Number),
      };
    });
    if (!Array.isArray(get(expected, "actions")))
      bad(":expect needs an exhaustive :actions vector");
    const actions = list(get(expected, "actions")).map((a): ExpectedAction => {
      if (!isMap(a)) return bad("each expected action must be a map");
      const facts = get(a, "facts");
      const kind = text(get(a, "kind")),
        rule = text(get(a, "rule"));
      if (typeof get(a, "n") !== "number" || !kind || !rule || typeof get(a, "band") !== "number")
        bad("each expected action needs :n, :kind, :rule and :band");
      return {
        n: get(a, "n") as number,
        kind: kind!,
        rule: rule!,
        band: get(a, "band") as number,
        facts: isMap(facts)
          ? Object.fromEntries(
              [...facts].map(([k, v]) => [text(k)!, v as string | number | boolean]),
            )
          : undefined,
        overridden:
          get(a, "overridden") === undefined ? undefined : list(get(a, "overridden")).map(String),
        unlocks: get(a, "unlocks") as number | undefined,
      };
    });
    const denials = list(get(expected, "denials")).map((d) => {
      const [n, rule] = list(d);
      if (typeof n !== "number" || typeof rule !== "string")
        bad('each denial must be [issue-number "RULE-ID"]');
      return `#${n as number} ${rule as string}`;
    });
    return {
      id: where.scenario,
      doc: text(get(s, "doc")) ?? "",
      where,
      role: role as Scenario["role"],
      agent: text(get(given, "agent")),
      platform: text(get(given, "platform")),
      issues,
      actions,
      denials,
    };
  });
}

const url = (n: number) => `https://github.com/o/r/issues/${n}`;
const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: null },
});
const metric = (size: string | null): MetricView => ({
  size: size as MetricView["size"],
  state: size ? "current" : "unassessed",
  provenance: null,
});

/** The fact adapter: compact scenario facts to the host snapshot the evaluator reads today. */
export function snapshotOf(issues: IssueFacts[]): {
  snapshot: Snapshot;
  assessments: Map<string, SubjectAssessments>;
} {
  const base = new Map<number, Issue>();
  for (const f of issues)
    base.set(f.n, {
      number: f.n,
      title: `Ticket ${f.n}`,
      body: "",
      url: url(f.n),
      state: "OPEN",
      createdAt: `2026-01-01T00:00:${String(f.n % 60).padStart(2, "0")}Z`,
      updatedAt: "2026-01-01T00:00:00Z",
      labels: page(
        f.labels.map((name) => ({ name })),
        !f.labelsComplete,
      ),
      comments: page([]),
      blockedBy: page([]),
      blocking: page([]),
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      closedByPullRequestsReferences: page([]),
    });
  const ref = (n: number): NativeNode => {
    const { number, title, url, state } = base.get(n)!;
    const summary = { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 };
    return {
      number,
      title,
      url,
      state,
      repository: { nameWithOwner: "o/r" },
      issueDependenciesSummary: summary,
    };
  };
  for (const f of issues)
    for (const d of f.blocks) {
      const blocker = base.get(f.n)!,
        dependent = base.get(d)!;
      blocker.blocking = page([...(blocker.blocking?.nodes ?? []), ref(d)]);
      dependent.blockedBy = page([...(dependent.blockedBy?.nodes ?? []), ref(f.n)]);
    }
  for (const i of base.values()) {
    const blocking = i.blocking?.nodes.length ?? 0,
      blockedBy = i.blockedBy?.nodes.length ?? 0;
    i.issueDependenciesSummary = {
      blockedBy,
      totalBlockedBy: blockedBy,
      blocking,
      totalBlocking: blocking,
    };
  }
  return {
    snapshot: {
      schemaVersion: 1,
      repository: "o/r",
      startedAt: "2026-01-01T00:00:00Z",
      fetchedAt: "2026-01-01T00:00:00Z",
      issues: [...base.values()],
      pullRequests: [],
      dependencies: [],
      changed: [],
      since: null,
      warnings: [],
      rateLimit: null,
    } as Snapshot,
    assessments: new Map(
      issues.map((f) => [
        url(f.n),
        {
          impact: metric(f.impact),
          complexity: metric(f.complexity),
          unlocks: 0,
          unlocksUnknown: [],
        },
      ]),
    ),
  };
}

/** Run the real evaluator; an evaluator exception is infrastructure, not a wrong decision. */
export function evaluate(s: Scenario, issues = s.issues): DatalogResult {
  const { snapshot, assessments } = snapshotOf(issues);
  try {
    return evaluateDatalog(snapshot, assessments, {
      role: s.role,
      agent: s.agent,
      platform: s.platform,
      limit: 1000,
      now: () => 0,
    });
  } catch (e) {
    throw new RuleInfrastructureError(s.where, `evaluator failed: ${(e as Error).message}`);
  }
}

const numberOf = (target: string) => Number(target.split("/").pop());

/** Compare every expectation and report all mismatches together. */
export function check(s: Scenario, result: DatalogResult = evaluate(s)): void {
  const problems: string[] = [];
  const actual = result.items.map((x) => ({
    n: numberOf(x.target),
    kind: x.kind as string,
    rule: x.ruleIds[0],
    band: x.band as number,
    item: x,
  }));
  const line = (a: { n: number; kind: string; rule: string; band: number }) =>
    `#${a.n} ${a.kind} ${a.rule} band ${a.band}`;
  const want = s.actions.map(line),
    got = actual.map(line);
  if (want.join("|") !== got.join("|"))
    problems.push(`actions\n    expected: [${want.join(", ")}]\n    actual:   [${got.join(", ")}]`);
  for (const [i, e] of s.actions.entries()) {
    const a = actual[i];
    if (!a || line(a) !== line(e)) continue;
    for (const [k, v] of Object.entries(e.facts ?? {}))
      if (a.item.why.facts[k] !== v)
        problems.push(
          `${line(e)}: binding ${k} expected ${JSON.stringify(v)}, actual ${JSON.stringify(a.item.why.facts[k])}`,
        );
    if (e.overridden) {
      const o = [...a.item.why.overriddenRuleIds].sort();
      if (o.join() !== [...e.overridden].sort().join())
        problems.push(
          `${line(e)}: overridden expected [${e.overridden.join(", ")}], actual [${o.join(", ")}]`,
        );
    }
    if (e.unlocks !== undefined && a.item.unlocks !== e.unlocks)
      problems.push(`${line(e)}: unlocks expected ${e.unlocks}, actual ${a.item.unlocks}`);
  }
  const denials = result.decisionEngine.denials
    .map((d) => `#${numberOf(d.target)} ${d.ruleId}`)
    .sort();
  const wantDenials = [...s.denials].sort();
  if (denials.join() !== wantDenials.join())
    problems.push(`denials expected {${wantDenials.join(", ")}}, actual {${denials.join(", ")}}`);
  // Invariant for every scenario: one action per subject and kind (duplicate-action prevention).
  const keys = actual.map((a) => `#${a.n} ${a.kind}`);
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i)))
    problems.push(`duplicate action ${k}`);
  if (problems.length) throw new RuleDecisionFailure(s.where, problems);
}
