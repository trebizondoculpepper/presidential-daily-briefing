/**
 * Program-mediated project policy in the briefing (#516 part 1): enablement, the effective
 * manifest and hashes, explicit failure, age-order and default parity. Synthetic facts only; the
 * real adapter, compiler and worker run, and no test reads a real checkout or GitHub.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { evaluateDatalog, policyVersion, rulesHash } from "../adapter.js";
import type { SubjectAssessments, MetricView } from "../../../briefing/assessments.js";
import type { Issue, Page, Snapshot } from "../../../github/types.js";
import { compileProjectPolicy } from "./compile.js";
import { effectivePolicy } from "./effective.js";
import { projectionSubjects, ProjectEvaluationError } from "./projection.js";
import { presentBriefing } from "../../../briefing/service.js";
import { resolveProjectRulesSetting } from "../../../config/project-rules-setting.js";
import {
  emptyFileSystem,
  fakeGit,
  SYNTHETIC_ROOT,
} from "../../../../scripts/benchmark-isolation.js";

const fixture = readFileSync(
  new URL("../../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
  "utf8",
);
const base = { policyVersion, rulesHash };
const current = fixture.replace(
  /:base-rules-hash "[0-9a-f]{64}"/,
  `:base-rules-hash "${rulesHash}"`,
);

const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (number: number, labels: string[]) =>
  ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: `https://github.com/example/project/issues/${number}`,
    state: "OPEN",
    createdAt: `2026-01-0${number}T00:00:00Z`,
    updatedAt: "2026-01-01T00:00:00Z",
    labels: page(labels.map((name) => ({ name }))),
    comments: page(),
    blockedBy: page(),
    blocking: page(),
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    closedByPullRequestsReferences: page(),
  }) as Issue;
const snapshot: Snapshot = {
  schemaVersion: 1,
  repository: "example/project",
  startedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  issues: [
    issue(1, ["status:ready"]),
    issue(2, ["status:ready"]),
    issue(3, ["status:ready", "project:priority"]),
  ],
  pullRequests: [],
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
} as Snapshot;
const metric: MetricView = { size: "M", state: "current", provenance: null };
const assessed: SubjectAssessments = {
  impact: metric,
  complexity: metric,
  unlocks: 0,
  unlocksUnknown: [],
};
const defaults = (order?: "oldest") =>
  evaluateDatalog(snapshot, new Map(snapshot.issues.map((i) => [i.url, assessed])), {
    role: "implementer",
    agent: "fixture-agent",
    limit: 100,
    ...(order ? { order } : {}),
  }).items;
const targets = (items: readonly { kind: string; target: string }[]) =>
  items.filter((a) => a.kind === "implement").map((a) => Number(a.target.split("/").pop()));
const subjects = projectionSubjects(snapshot);
const enabled = { enabled: true as const, source: "config" as const, root: "/verified/root" };
const loadFixture = async () => compileProjectPolicy(current, base);
const run = (
  setting: Parameters<typeof effectivePolicy>[0],
  order = "impact",
  runtime: Parameters<typeof effectivePolicy>[3]["runtime"] = { loadPolicy: loadFixture },
  items = defaults(order === "oldest" ? "oldest" : undefined),
) => effectivePolicy(setting, items, subjects, { base, role: "implementer", order, runtime });

describe("effective project policy (#516)", () => {
  it("leaves the default queue and hash untouched when disabled", async () => {
    const items = defaults();
    for (const source of ["default", "config"] as const) {
      const result = await run({ enabled: false, source }, "impact", {
        loadPolicy: async () => {
          throw new Error("a disabled policy must not be read");
        },
      });
      expect(result.items).toEqual(items);
      expect(result.warnings).toEqual([]);
      expect(result.manifest).toMatchObject({
        state: "disabled",
        appliedOrderMode: "disabled",
        defaultRulesHash: rulesHash,
        effectiveRulesHash: rulesHash,
        projectRulesHash: null,
        source: "pdb.rules.edn",
      });
    }
  });

  it("reports a selection without a local checkout as unavailable, not disabled, and complete", async () => {
    const items = defaults();
    const result = await run({
      enabled: "unavailable",
      reason: "no local checkout; use --project",
    });
    expect(result.items).toEqual(items);
    expect(result.warnings).toEqual([]);
    expect(result.manifest).toMatchObject({
      state: "unavailable",
      appliedOrderMode: "disabled",
      defaultRulesHash: rulesHash,
      effectiveRulesHash: null,
      reason: "no local checkout; use --project",
    });
    expect(result.manifest.next.join(" ")).toContain("--project");
  });

  it("applies an enabled, valid policy with the composite hash and per-row provenance", async () => {
    expect(targets(defaults())).toEqual([1, 2, 3]);
    const result = await run(enabled);
    const policy = compileProjectPolicy(current, base);
    expect(targets(result.items)).toEqual([3, 1, 2]);
    expect(result.warnings).toEqual([]);
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      state: "active",
      appliedOrderMode: "impact",
      formatVersion: 1,
      projectionVersion: 1,
      basePolicyVersion: policyVersion,
      defaultRulesHash: rulesHash,
      projectRulesHash: policy.projectRulesHash,
      effectiveRulesHash: policy.effectiveRulesHash,
      matchedIds: ["project-hotfix"],
    });
    const hot = result.items.find((a) => a.target.endsWith("/3"))! as unknown as {
      why: Record<string, unknown>;
    };
    expect(hot.why.ruleIds).toContain("project-hotfix");
    expect(hot.why.project).toEqual([
      expect.objectContaining({ id: "project-hotfix", priority: 10 }),
    ]);
  });

  it("keeps the default order under an explicit age order and says so", async () => {
    const items = defaults("oldest");
    const result = await run(enabled, "oldest");
    expect(result.items).toEqual(items);
    expect(result.manifest).toMatchObject({
      state: "active",
      appliedOrderMode: "disabled-by-age-order",
      matchedIds: [],
    });
    expect(result.manifest.reason).toContain("order impact");
  });

  it("reports an enabled policy that cannot be honoured, never a silent default", async () => {
    const stale = fixture; // the historical base hash, not the shipped one
    const cases: [string, Parameters<typeof run>[2], string][] = [
      [
        "mismatched base hash",
        { loadPolicy: async () => compileProjectPolicy(stale, base) },
        "pdb.rules.edn",
      ],
      [
        "evaluation timeout",
        {
          loadPolicy: loadFixture,
          evaluate: async () => {
            throw new ProjectEvaluationError("evaluation-timeout", "too slow");
          },
        },
        "evaluation-timeout",
      ],
      [
        "unreadable source",
        {
          loadPolicy: async () => {
            throw Object.assign(new Error("EACCES /home/private/secret/pdb.rules.edn"), {
              code: "EACCES",
            });
          },
        },
        "could not be loaded",
      ],
    ];
    for (const [name, runtime, text] of cases) {
      const items = defaults();
      const result = await run(enabled, "impact", runtime);
      expect(result.items, name).toEqual(items);
      expect(result.manifest, name).toMatchObject({
        state: "error",
        appliedOrderMode: "error",
        effectiveRulesHash: null,
      });
      expect(result.manifest.reason, name).toContain(text);
      expect(JSON.stringify(result), name).not.toContain("/home/private");
      expect(result.warnings[0], name).toContain("pdb config set rules.project.enabled false");
      expect(result.manifest.next.join(" ")).toContain("rules.project.enabled false");
    }
    const unknown = await run({ enabled: "unknown", reason: "unreadable config" });
    expect(unknown.manifest).toMatchObject({
      state: "error",
      reason: expect.stringContaining("unknown"),
    });
  });

  it("does not apply anything once the request is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      effectivePolicy(enabled, defaults(), subjects, {
        base,
        role: "implementer",
        order: "impact",
        signal: controller.signal,
        runtime: { loadPolicy: loadFixture },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("reads only the verified checkout: a missing file and a symlink escape are errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-516-"));
    try {
      const root = join(dir, "checkout");
      await mkdir(root);
      const missing = await run({ ...enabled, root }, "impact", {});
      expect(missing.manifest).toMatchObject({ state: "error" });
      await writeFile(join(dir, "outside.edn"), current);
      await symlink(join(dir, "outside.edn"), join(root, "pdb.rules.edn"));
      const escaped = await run({ ...enabled, root }, "impact", {});
      expect(escaped.manifest.state).toBe("error");
      expect(escaped.manifest.reason).toContain("source-escape");
      expect(JSON.stringify(escaped)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const local = (toml: string) => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit(snapshot.repository),
  fs: {
    ...emptyFileSystem,
    readText: async (path: string) => (path.endsWith("triage.toml") ? toml : null),
  },
});

describe("project policy enablement and briefing integration (#516)", () => {
  it("is enabled only by configuration, from the matching verified checkout", async () => {
    expect(
      await resolveProjectRulesSetting(snapshot.repository, local("schemaVersion = 1\n")),
    ).toEqual({
      enabled: false,
      source: "default",
    });
    expect(
      await resolveProjectRulesSetting(
        snapshot.repository,
        local("schemaVersion = 1\n[rules.project]\nenabled = true\n"),
      ),
    ).toEqual({ enabled: true, source: "config", root: SYNTHETIC_ROOT });
    expect(
      await resolveProjectRulesSetting("another/repo", local("[rules.project]\nenabled = true\n")),
    ).toMatchObject({ enabled: "unavailable", reason: expect.stringContaining("--project") });
    expect(await resolveProjectRulesSetting(snapshot.repository)).toMatchObject({
      enabled: "unavailable",
    });
    expect(await resolveProjectRulesSetting(snapshot.repository, local("garbage ="))).toMatchObject(
      {
        enabled: "unknown",
      },
    );
  });

  const present = (options: Record<string, unknown>) =>
    presentBriefing(snapshot, {
      limit: 10,
      maxChars: 10000,
      role: "implementer",
      agent: "fixture-agent",
      engineSetting: { requested: "datalog", source: "config" },
      ...options,
    });

  it("reports the default hash and a disabled manifest when not enabled", async () => {
    const presented = await present({ projectRules: { enabled: false, source: "default" } });
    expect(presented.report.decisionEngine.rulesHash).toBe(rulesHash);
    expect(presented.report.decisionEngine.effectivePolicy).toMatchObject({
      state: "disabled",
      effectiveRulesHash: rulesHash,
    });
    // Not read at all (no checkout selected): unavailable, and the briefing stays complete.
    const unread = await present({});
    expect(unread.report.decisionEngine.rulesHash).toBe(rulesHash);
    expect(unread.report.decisionEngine.effectivePolicy).toMatchObject({ state: "unavailable" });
    expect(unread.complete).toBe(presented.complete);
  });

  it("ranks by the active policy and reports its composite hash", async () => {
    const presented = await present({
      projectRules: enabled,
      projectRuntime: { loadPolicy: loadFixture },
    });
    const policy = compileProjectPolicy(current, base);
    expect(presented.report.decisionEngine.rulesHash).toBe(policy.effectiveRulesHash);
    expect(presented.report.decisionEngine.effectivePolicy?.state).toBe("active");
    const ranked = (
      presented.report as { rankedActions?: { items: { kind: string; target: string }[] } }
    ).rankedActions!.items;
    expect(targets(ranked)[0]).toBe(3);
    // The text banner names the same effective revision as the JSON.
    const text = (
      await present({
        projectRules: enabled,
        projectRuntime: { loadPolicy: loadFixture },
        context: true,
      })
    ).text;
    expect(text).toContain(`${policy.effectiveRulesHash.slice(0, 12)}; project preferences`);
    expect(text).not.toContain(rulesHash.slice(0, 12));
  });

  it("marks the briefing incomplete when an enabled policy fails, or the TS rollback is in use", async () => {
    const failed = await present({
      projectRules: enabled,
      projectRuntime: { loadPolicy: async () => compileProjectPolicy(fixture, base) },
    });
    expect(failed.complete).toBe(false);
    expect(failed.report.decisionEngine.rulesHash).toBe(rulesHash);
    expect(failed.report.decisionEngine.effectivePolicy).toMatchObject({
      state: "error",
      effectiveRulesHash: null,
    });
    expect(failed.report.completeness.warnings.join("\n")).toContain("Project policy error");
    expect(failed.text).toContain("Project policy error");

    const rollback = await present({
      projectRules: enabled,
      engineSetting: { requested: "typescript", source: "config" },
    });
    expect(rollback.complete).toBe(false);
    expect(rollback.report.decisionEngine.effectivePolicy).toMatchObject({
      state: "error",
      reason: expect.stringContaining("briefing.engine datalog"),
    });
  });
});
