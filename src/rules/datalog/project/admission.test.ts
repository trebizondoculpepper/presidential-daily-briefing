/**
 * Immutable exact-action admission for native project preferences (#515). The project queries
 * run in-process here through the same compiled DataScript queries the worker runs; the worker
 * boundary itself is tested in worker.test.ts.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import ds from "datascript";
import type { Value } from "datascript";
import { evaluateDatalog, rulesHash, policyVersion } from "../adapter.js";
import type { DatalogAction } from "../adapter.js";
import type { SubjectAssessments, MetricView } from "../../../briefing/assessments.js";
import type { Issue, NativeNode, Page, Snapshot } from "../../../github/types.js";
import { compileProjectPolicy } from "./compile.js";
import type { CompiledProjectPolicy } from "./compile.js";
import { projectActions, projectionSubjects, ProjectEvaluationError } from "./projection.js";
import type { Projection, ProjectionSubject } from "./projection.js";
import {
  admitProjectResult,
  applyProjectPreferences,
  assertAdmissionPreserved,
  resultLimits,
} from "./admission.js";
import type { ProjectQueryResult, ProjectRow } from "./admission.js";

const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = { policyVersion, rulesHash };
/** The schema fixture rebound to the current shipped base, optionally with edits. */
const policyText = (edit: (t: string) => string = (t) => t) =>
  edit(fixture.replace(/:base-rules-hash "[0-9a-f]{64}"/, `:base-rules-hash "${rulesHash}"`));
const compile = (edit?: (t: string) => string) => compileProjectPolicy(policyText(edit), base);

const page = <T>(nodes: T[] = [], hasNextPage = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage, endCursor: null },
});
const issue = (number: number, labels: string[], over: Partial<Issue> = {}) =>
  ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: `https://github.com/o/r/issues/${number}`,
    state: "OPEN",
    createdAt: `2026-01-0${number}T00:00:00Z`,
    updatedAt: "2026-01-01T00:00:00Z",
    labels: page(labels.map((name) => ({ name }))),
    comments: page(),
    blockedBy: page(),
    blocking: page(),
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    closedByPullRequestsReferences: page(),
    ...over,
  }) as Issue;
const snapshot = (issues: Issue[]) =>
  ({
    schemaVersion: 1,
    repository: "o/r",
    startedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    issues,
    pullRequests: [],
    dependencies: [],
    changed: [],
    since: null,
    warnings: [],
    rateLimit: null,
  }) as Snapshot;
const metric = (size: MetricView["size"]): MetricView => ({
  size,
  state: "current",
  provenance: null,
});
const assessed: SubjectAssessments = {
  impact: metric("L"),
  complexity: metric("S"),
  unlocks: 0,
  unlocksUnknown: [],
};

/**
 * The #499 eligible-shadowing counterexample, through the real adapter: a ready ticket, another
 * agent's claim, incomplete label evidence, an open native blocker, a project-labelled ticket and
 * a project-labelled ticket with incomplete native blocker evidence.
 */
const counterexample = snapshot([
  issue(1, ["status:ready"]),
  issue(2, ["status:ready", "agent:someone-else"]),
  issue(3, ["status:ready"], { labels: page([{ name: "status:ready" }], true) }),
  issue(4, ["status:ready"], {
    blockedBy: page([
      { number: 9, url: "https://github.com/o/r/issues/9", state: "OPEN", title: "" },
    ] as unknown as NativeNode[]),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
  }),
  issue(5, ["status:ready", "project:priority"]),
  // Incomplete native blocker evidence: one blocker counted, none listed.
  issue(6, ["status:ready", "project:priority"], {
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
  }),
]);
const runDefault = (s: Snapshot, order?: "oldest") =>
  evaluateDatalog(s, new Map([...s.issues].map((i) => [i.url, assessed])), {
    role: "implementer",
    agent: "fixture-agent",
    limit: 100,
    ...(order ? { order } : {}),
  }).items;
const implementTargets = (items: readonly DatalogAction[]) =>
  items.filter((a) => a.kind === "implement").map((a) => Number(a.target.split("/").pop()));

/** What the worker computes, run in-process over the projection: native matched rows only. */
function evaluateInline(
  policy: CompiledProjectPolicy,
  projection: Projection,
  generation = "g1",
): ProjectQueryResult {
  const db = ds.init_db([...projection.datoms], projection.schema);
  return {
    version: 1,
    generation,
    effectiveRulesHash: policy.effectiveRulesHash,
    projectRulesHash: policy.projectRulesHash,
    preferences: policy.preferences.map((p) => ({
      id: p.id,
      matched: ds.q(p.matchQuery, db, policy.rules).map(([a]) => Number(a)),
      rows: ds.q(p.query, db, policy.rules).map(([a, value]): ProjectRow => {
        // Object.fromEntries, like the worker: a witness named __proto__ stays an own key.
        const witnesses: Record<string, Value[]> = Object.fromEntries(
          Object.entries(p.witnesses).map(([name, q]) => [
            name,
            ds.q(q, db, policy.rules, a).flat(),
          ]),
        );
        return [Number(a), projection.identities.get(Number(a))!, Number(value), witnesses];
      }),
    })),
  };
}
const project = (items: readonly DatalogAction[], s: Snapshot, order = "impact") =>
  projectActions(items, projectionSubjects(s), { role: "implementer", order });

describe("immutable exact-action admission (#515)", () => {
  it("cannot reproduce the #499 eligible-shadowing counterexample", () => {
    const defaults = runDefault(counterexample);
    expect(implementTargets(defaults)).toEqual([1, 5]);
    // The research attack appended an alternative `eligible`; a project file cannot name it.
    expect(() =>
      compile((t) => t.replace(":rules [", ':rules [[(eligible ?a) [?a "pdb.action-id" _]] ')),
    ).toThrow(expect.objectContaining({ code: "reserved-predicate" }));
    // A catch-all maximal preference still only sees, and so only reorders, admitted actions.
    const policy = compile((t) =>
      t
        .replace(
          "(project-hotfix ?a)]\n                :priority",
          '[?a "pdb.action-id" _]]\n                :priority',
        )
        .replace("[(+ 0 10) ?value] [(not= ?value 0)]", "[(+ 0 1000) ?value]")
        .replace(/:why[\s\S]*$/, ':why "Catch-all." :witnesses {}}]}'),
    );
    const projection = project(defaults, counterexample);
    const result = applyProjectPreferences(
      defaults,
      admitProjectResult(evaluateInline(policy, projection), policy, projection, "g1"),
    );
    expect(implementTargets(result)).toEqual([1, 5]);
    expect(result.map((a) => a.id).sort()).toEqual(defaults.map((a) => a.id).sort());
  });
  it("moves the native-matched admitted action ahead within its band with a bound reason", () => {
    const defaults = runDefault(counterexample);
    const policy = compile();
    const projection = project(defaults, counterexample);
    const admitted = admitProjectResult(
      evaluateInline(policy, projection),
      policy,
      projection,
      "g1",
    );
    const result = applyProjectPreferences(defaults, admitted);
    expect(implementTargets(result)).toEqual([5, 1]);
    const top = result.find((a) => a.target.endsWith("/5"))!;
    expect(top.why?.ruleIds).toEqual([
      ...defaults.find((a) => a.target.endsWith("/5"))!.why.ruleIds,
      "project-hotfix",
    ]);
    expect(top.why?.project).toEqual([
      {
        id: "project-hotfix",
        priority: 10,
        text: "Project priority label matched: project:priority.",
        facts: { label: "project:priority" },
        omitted: {},
      },
    ]);
    // Everything except the explanation is the default action, including its command.
    const original = defaults.find((a) => a.target.endsWith("/5"))!;
    expect({ ...top, why: original.why, ruleIds: original.ruleIds }).toEqual(original);
    expect(top.why).toMatchObject({ text: original.why.text, facts: original.why.facts });
  });
  it("keeps the default obligations unchanged when no preference matches", () => {
    const s = snapshot([issue(1, ["status:ready"]), issue(2, ["status:ready"])]);
    const defaults = runDefault(s);
    const policy = compile();
    const projection = project(defaults, s);
    const result = applyProjectPreferences(
      defaults,
      admitProjectResult(evaluateInline(policy, projection), policy, projection, "g1"),
    );
    expect(result).toEqual(defaults);
    expect(result.every((a, i) => a === defaults[i])).toBe(true);
  });

  describe("rejects the whole result, applying nothing", () => {
    const defaults = runDefault(counterexample);
    const policy = compile();
    const projection = project(defaults, counterexample);
    const good = () => evaluateInline(policy, projection);
    const entity5 = [...projection.identities].find(([, id]) => id.includes("/issues/5 "))![0];
    const withRows = (rows: unknown[]) => ({
      ...good(),
      preferences: [{ id: "project-hotfix", matched: [entity5], rows }],
    });
    const row = (over: Partial<Record<0 | 1 | 2 | 3, unknown>> = {}) => {
      const r: unknown[] = [
        entity5,
        projection.identities.get(entity5),
        10,
        { label: ["project:priority"] },
      ];
      for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
      return r;
    };
    const rejects = (raw: unknown, code: string, generation = "g1") =>
      expect(() => admitProjectResult(raw, policy, projection, generation)).toThrow(
        expect.objectContaining({ code }),
      );
    it("forged subjects, kinds, roles and denied or incomplete-evidence tickets", () => {
      const id5 = projection.identities.get(entity5)!;
      // Another owner (2), incomplete labels (3) and an open blocker (4) were never admitted.
      for (const n of [2, 3, 4, 6])
        rejects(
          withRows([row({ 1: id5.replace("/issues/5 ", `/issues/${n} `) })]),
          "forged-action",
        );
      rejects(withRows([row({ 1: id5.replace(" implement ", " merge ") })]), "forged-action");
      rejects(withRows([row({ 1: id5.replace(/ implementer$/, " designer") })]), "forged-action");
      rejects(withRows([row({ 0: 99 })]), "forged-action");
      rejects(withRows([row({ 0: 1 })]), "forged-action");
      rejects(withRows([row({ 0: String(entity5) })]), "forged-action");
    });
    it("a :when match whose :priority binds nothing, or a priced action :when did not match", () => {
      rejects(withRows([]), "missing-priority");
      rejects(
        { ...good(), preferences: [{ id: "project-hotfix", matched: [], rows: [row()] }] },
        "invalid-result",
      );
      rejects(
        { ...good(), preferences: [{ id: "project-hotfix", matched: [99], rows: [] }] },
        "forged-action",
      );
      // Through real DataScript: the priority is bound only for a label no action carries.
      const unpriced = compile((t) =>
        t.replace(
          "[(+ 0 10) ?value] [(not= ?value 0)]",
          '[?a "pdb.action-label" "never"] [(+ 0 10) ?value]',
        ),
      );
      expect(() =>
        admitProjectResult(evaluateInline(unpriced, projection), unpriced, projection, "g1"),
      ).toThrow(expect.objectContaining({ code: "missing-priority" }));
    });
    it("duplicate, conflicting and out-of-range priorities", () => {
      rejects(withRows([row(), row()]), "duplicate-result");
      rejects(withRows([row(), row({ 2: 11 })]), "conflicting-priority");
      for (const p of [-1, 1001, 1.5, Number.NaN, Infinity, "10", null])
        rejects(withRows([row({ 2: p })]), "priority-range");
    });
    it("missing, extra or non-scalar witness bindings", () => {
      rejects(withRows([row({ 3: {} })]), "missing-witness");
      rejects(withRows([row({ 3: { label: [] } })]), "missing-witness");
      rejects(withRows([row({ 3: { label: ["x"], extra: ["y"] } })]), "missing-witness");
      rejects(withRows([row({ 3: { label: [{ nested: 1 }] } })]), "invalid-result");
      rejects(withRows([row({ 3: { label: [Infinity] } })]), "invalid-result");
    });
    it("shape, generation, policy identity and result bounds", () => {
      rejects(null, "invalid-result");
      rejects({ ...good(), extra: 1 }, "invalid-result");
      rejects({ ...good(), preferences: [] }, "invalid-result");
      rejects({ ...good(), preferences: [{ id: "project-other", rows: [] }] }, "invalid-result");
      rejects(withRows([[entity5]]), "invalid-result");
      rejects(good(), "stale-generation", "g2");
      rejects({ ...good(), effectiveRulesHash: "0".repeat(64) }, "policy-mismatch");
      rejects({ ...good(), projectRulesHash: "0".repeat(64) }, "policy-mismatch");
      const many = Array.from({ length: resultLimits.tuples + 1 }, () => "v");
      rejects(withRows([row({ 3: { label: many } })]), "result-limit");
    });
  });

  it("never projects, reorders or annotates the protected bands", () => {
    const defaults = runDefault(counterexample);
    // Synthetic protected obligations around the default actions.
    const protectedOnes = [1, 2].map((band, i): DatalogAction => ({
      ...defaults[0],
      id: `o/r https://github.com/o/r/pull/${7 + i} review`,
      kind: "review" as DatalogAction["kind"],
      target: `https://github.com/o/r/pull/${7 + i}`,
      band: band as DatalogAction["band"],
    }));
    const actions = [...protectedOnes, ...defaults];
    const projection = projectActions(
      actions,
      new Map([
        ...projectionSubjects(counterexample),
        ...protectedOnes.map((a): [string, ProjectionSubject] => [
          a.target,
          { labels: ["project:priority"], labelsComplete: true },
        ]),
      ]),
      { role: "implementer", order: "impact" },
    );
    expect([...projection.identities.values()].some((id) => id.includes("/pull/"))).toBe(false);
    const policy = compile();
    const result = applyProjectPreferences(
      actions,
      admitProjectResult(evaluateInline(policy, projection), policy, projection, "g1"),
    );
    expect(result.slice(0, 2)).toEqual(protectedOnes);
    expect(result[0]).toBe(protectedOnes[0]);
  });
  it("keeps witness omissions apart from a witness named like omission metadata", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const s = snapshot([issue(1, ["status:ready", ...labels])]);
    const defaults = runDefault(s);
    const policy = compile((t) =>
      t.replace(
        /:preferences \[[\s\S]*\]\}\s*$/,
        `:preferences [{:id "project-many" :when [[?a "pdb.action-label" "l0"]] :priority [[(+ 0 1) ?value]] :why "{label} / {labelOmitted}" :witnesses {"label" [[?a "pdb.action-label" ?value]] "labelOmitted" [[(str "mine") ?value]]}}]}`,
      ),
    );
    const projection = project(defaults, s);
    const admitted = admitProjectResult(
      evaluateInline(policy, projection),
      policy,
      projection,
      "g1",
    );
    const [reason] = [...admitted.matches.values()][0].reasons;
    expect(reason.facts.labelOmitted).toBe("mine");
    expect(reason.text.endsWith(" / mine")).toBe(true);
    expect(reason.omitted).toEqual({ label: 3 });
  });
  it("keeps witnesses named __proto__ or constructor as ordinary prototype-free bindings", () => {
    const s = snapshot([issue(1, ["status:ready", "project:priority"])]);
    const defaults = runDefault(s);
    const policy = compile((t) =>
      t.replace(
        /:preferences \[[\s\S]*\]\}\s*$/,
        `:preferences [{:id "project-proto" :when [[?a "pdb.action-label" "project:priority"]] :priority [[(+ 0 1) ?value]] :why "{__proto__} {constructor}" :witnesses {"__proto__" [[(str "p") ?value]] "constructor" [[(str "c") ?value]]}}]}`,
      ),
    );
    const projection = project(defaults, s);
    const admitted = admitProjectResult(
      evaluateInline(policy, projection),
      policy,
      projection,
      "g1",
    );
    const [reason] = [...admitted.matches.values()][0].reasons;
    expect(Object.getPrototypeOf(reason.facts)).toBeNull();
    expect(Object.getPrototypeOf(reason.omitted)).toBeNull();
    expect(Object.keys(reason.facts)).toEqual(["__proto__", "constructor"]);
    expect(reason.facts.constructor).toBe("c");
    expect(Object.getOwnPropertyDescriptor(reason.facts, "__proto__")?.value).toBe("p");
    expect(reason.text).toBe("p c");
  });
  it("keeps the highest key, source-order reasons and every matched ID", () => {
    const s = snapshot([issue(1, ["status:ready", "a", "b"]), issue(2, ["status:ready", "b"])]);
    const defaults = runDefault(s);
    const pref = (id: string, label: string, value: number) =>
      `{:id "${id}" :when [[?a "pdb.action-label" "${label}"]] :priority [[(+ 0 ${value}) ?value]] :why "${id}" :witnesses {}}`;
    const policy = compile((t) =>
      t.replace(
        /:preferences \[[\s\S]*\]\}\s*$/,
        `:preferences [${pref("project-a", "a", 5)} ${pref("project-b", "b", 7)} ${pref("project-c", "b", 7)}]}`,
      ),
    );
    const projection = project(defaults, s);
    const admitted = admitProjectResult(
      evaluateInline(policy, projection),
      policy,
      projection,
      "g1",
    );
    const one = [...admitted.matches.values()].find((m) => m.identity.includes("/issues/1 "))!;
    expect(one.priority).toBe(7);
    expect(one.matchedIds).toEqual(["project-a", "project-b", "project-c"]);
    expect(one.reasons.map((r) => r.id)).toEqual(["project-b", "project-c"]);
  });
  it("leaves the default queue alone outside the projected bands and under scope limits", () => {
    const defaults = runDefault(counterexample);
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...defaults[0],
      id: `${defaults[0].id}-${i}`,
    }));
    expect(() => projectActions(many, new Map(), { role: "implementer", order: "impact" })).toThrow(
      expect.objectContaining({ code: "project-scope-exceeded" }),
    );
    expect(() =>
      projectActions([defaults[0], defaults[0]], new Map(), {
        role: "implementer",
        order: "impact",
      }),
    ).toThrow(ProjectEvaluationError);
  });
  it("detects any change to an admitted action beyond its explanation", () => {
    const defaults = runDefault(counterexample);
    const changed = (edit: (a: DatalogAction) => DatalogAction) => () =>
      assertAdmissionPreserved(defaults, [edit(defaults[0]), ...defaults.slice(1)]);
    expect(changed((a) => ({ ...a, nextCommand: "pdb merge" }))).toThrow(/admission-violated/);
    expect(changed((a) => ({ ...a, kind: "merge" as DatalogAction["kind"] }))).toThrow(
      /admission-violated/,
    );
    expect(changed((a) => ({ ...a, why: { ...a.why, text: "forged" } }))).toThrow(
      /admission-violated/,
    );
    // Each rule-ID list is checked on its own: emptying either one is caught.
    expect(changed((a) => ({ ...a, ruleIds: [] }))).toThrow(/admission-violated/);
    expect(changed((a) => ({ ...a, why: { ...a.why, ruleIds: [] } }))).toThrow(
      /admission-violated/,
    );
    expect(changed((a) => ({ ...a, why: { ...a.why, ruleIds: ["project-x"] } }))).toThrow(
      /admission-violated/,
    );
    expect(() => assertAdmissionPreserved(defaults, defaults.slice(1))).toThrow(
      /admission-violated/,
    );
  });
});
