import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, main } from "../cli.js";
import { CONFIG_PATH, type ConfigFileSystem, type GitRunner } from "../config/config.js";
import { complexityGuidance } from "./complexity.js";
import { provenanceComment } from "./estimate.js";
import {
  classifyComplexityLabels,
  collectLabelEstimationInput,
  complexityLabelFindings,
  complexityLabelName,
  INVALID_SIZE_SUGGESTIONS,
  labelEstimationReport,
  suggestedSize,
} from "./complexitylabels.js";
import { estimationText, readComplexityProvenance } from "./estimation.js";
import { ticketDoctor } from "../workflow/ticketdoctor.js";
import type { Issue } from "../github/types.js";
import { permissionLookup } from "../github/github.js";
import type { Rest } from "../github/github.js";
import { markerTrust } from "../workflow/delivery.js";
import { issue, page, repo, snapshot, time } from "../testing/snapshots.js";

describe("estimation queue and briefing visibility from size labels (#122, #152)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const config = (text: string | null): ConfigFileSystem => ({
    readText: async (file) => (file === path ? text : null),
    writeText: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  });
  const git: GitRunner = async (args) =>
    args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
  const marker = (size: "M" | "S", recordedAt = time, guidanceVersion = 1) =>
    provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size,
      previous: [],
      rationale: "contained capability across modules",
      assumptions: ["blocker #9 supplies the API; waiting excluded"],
      references: [],
      estimator: "ana",
      revision: null,
      guidanceVersion,
      recordedAt,
    });
  const sized = (number: number, labels: string[], truncated = false): Issue => ({
    ...issue(number, labels),
    labels: page(
      labels.map((name) => ({ name })),
      truncated,
      truncated ? "c" : null,
    ),
  });
  const withComment = (item: Issue, body: string): Issue => ({
    ...item,
    // Written by a verified maintainer (#269): only trusted provenance counts as recorded.
    comments: page([
      {
        body,
        url: `${item.url}#c`,
        author: { __typename: "User", login: "maintainer" },
        createdAt: time,
        lastEditedAt: null,
        includesCreatedEdit: false,
        editor: null,
      },
    ]),
  });
  async function brief(configText: string | null, issues: Issue[], args: string[] = []) {
    let out = "";
    const code = await main(["--json", ...args], async (t) => void (out = t), {
      collect: async () => snapshot(issues, []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(configText), git, cwd: root },
      rest: maintainerOnly,
      guide: {
        fs: config('{"schemaVersion":1,"briefing":{"engine":"typescript"}}'),
        git,
        cwd: root,
      },
    });
    return { code, report: JSON.parse(out) };
  }
  /** Permissions: `maintainer` writes; anyone else is unknown (404). */
  const maintainerOnly: Rest = async (path) => {
    const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1];
    return login === "maintainer"
      ? { status: 200, body: { role_name: "write", user: { login } } }
      : { status: 404, body: null };
  };
  const blocked = (): Issue => ({
    ...issue(2),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
  });

  it("queues unestimated blocked tickets with no setup, while they stay ineligible", async () => {
    const { code, report } = await brief(null, [
      withComment(sized(1, ["status:ready", "complexity:M"]), marker("M")),
      blocked(),
    ]);
    expect(code).toBe(0);
    expect(report.schemaVersion).toBe(2);
    expect(report.estimation).toMatchObject({
      status: "available",
      requested: false,
      findings: [],
    });
    expect(report.estimation.queue.items.map((e: { number: number }) => e.number)).toEqual([2]);
    expect(report.estimation.queue.items[0]).toMatchObject({
      state: "unestimated",
      implementation: "ineligible",
    });
    const one = report.subjects.find((s: { number: number }) => s.number === 1);
    expect(one.complexity).toMatchObject({
      size: "M",
      state: "estimated",
      recorded: { rationale: "contained capability across modules", estimator: "ana" },
    });
    expect(report.actions.items[0]).toBe(issue(1).url);
    expect(report.estimation.offered).toBe(false);
  });
  it("flags stale estimates: label drift, older guidance or later description edits", async () => {
    const edited = {
      ...withComment(sized(1, ["complexity:M"]), marker("M")),
      lastEditedAt: "2026-11-13T00:00:00Z",
    };
    const { report } = await brief(null, [
      edited,
      withComment(sized(2, ["complexity:L"]), marker("M")),
      withComment(sized(3, ["complexity:S"]), marker("S", time, 0)),
    ]);
    const states = report.estimation.queue.items.map(
      (e: { number: number; state: string; reasons: string[] }) => [
        e.number,
        e.state,
        e.reasons.join(),
      ],
    );
    expect(states).toEqual([
      [1, "stale", expect.stringContaining("description edited")],
      [2, "stale", expect.stringContaining("differs from recorded estimate M")],
      [3, "stale", expect.stringContaining("guidance version 0 < 1")],
    ]);
  });
  it("never treats a missing or invalid recordedAt as fresh after a description edit (#281)", async () => {
    // `marker` defaults recordedAt, so drop the key from the JSON to model a missing one.
    const missing = marker("M", "DROP").replace(',"recordedAt":"DROP"', "");
    expect(missing).not.toContain("recordedAt");
    const edited = (number: number, recordedAt: string | undefined): Issue => ({
      ...withComment(
        sized(number, ["complexity:M"]),
        recordedAt === undefined ? missing : marker("M", recordedAt),
      ),
      lastEditedAt: "2026-11-13T00:00:00Z",
    });
    const { report } = await brief(null, [
      edited(1, undefined),
      edited(2, "last tuesday"),
      edited(3, "2026-02-30T25:61:00Z"),
    ]);
    expect(
      report.estimation.queue.items.map(
        (e: { number: number; state: string; reasons: string[] }) => [e.number, e.state, e.reasons],
      ),
    ).toEqual(
      [1, 2, 3].map((n) => [
        n,
        "stale",
        [
          "description edited 2026-11-13T00:00:00Z; recorded time unknown, so the estimate cannot be shown fresh",
        ],
      ]),
    );
  });
  it("keeps well-formed complexity provenance output byte-identical (#281 parity)", async () => {
    // Captured from origin/main before the fix: well-formed records must not change.
    const golden = `{"fieldId":null,"requested":false,"guidanceVersion":1,"findings":[],"boundaries":"Optional work after PR follow-up, own work and eligible pickup. Estimating acquires no claim, reserves nothing and does not unblock or re-rank.","status":"available","detail":"1 ticket(s) to estimate (unestimated or stale, blocked included).","unknown":0,"conflicts":{"total":0,"omitted":0,"items":[]},"offered":true,"queue":{"total":1,"omitted":0,"items":[{"number":3,"title":"Ticket 3","url":"https://github.com/example/project/issues/3","createdAt":"2026-11-12T10:00:00.000Z","size":"M","state":"stale","recorded":{"size":"M","rationale":"contained capability across modules","assumptions":["blocker #9 supplies the API; waiting excluded"],"estimator":"ana","recordedAt":"2026-11-12T10:00:00.000Z","guidanceVersion":1,"url":"https://github.com/example/project/issues/3#c"},"provenanceAuthority":"trusted","ignoredProvenance":[],"implementation":"ineligible","reasons":["description edited 2026-11-13T00:00:00Z after the estimate"]}]}}`;
    const { report } = await brief(null, [
      { ...withComment(sized(1, ["complexity:M"]), marker("M")), lastEditedAt: time },
      withComment(sized(2, ["complexity:M"]), marker("M")),
      {
        ...withComment(sized(3, ["complexity:M"]), marker("M")),
        lastEditedAt: "2026-11-13T00:00:00Z",
      },
    ]);
    expect(JSON.stringify(report.estimation)).toBe(golden);
  });
  it("keeps truncated labels unknown and conflicting labels as inspection, never queued", async () => {
    const { code, report } = await brief(null, [
      sized(1, ["status:ready"], true),
      sized(2, ["complexity:S", "complexity:XL"]),
      sized(3, []),
    ]);
    expect(code).toBe(0);
    expect(report.estimation).toMatchObject({ status: "available", unknown: 1 });
    // The deprecated property stays in the shape (always null) so schema versions are unchanged.
    expect(report.estimation).toHaveProperty("fieldId", null);
    expect(report.estimation.queue.items.map((e: { number: number }) => e.number)).toEqual([3]);
    expect(report.estimation.conflicts.items.map((e: { number: number }) => e.number)).toEqual([2]);
  });
  it("ignores field-era provenance records on the label route", async () => {
    const v1 =
      '<!-- github-triage:complexity-estimate v1 {"kind":"complexity-estimate","fieldId":"F","size":"M","rationale":"old"} -->';
    const { report } = await brief(null, [withComment(sized(1, ["complexity:M"]), v1)]);
    const one = report.subjects.find((s: { number: number }) => s.number === 1);
    expect(one.complexity).toMatchObject({ state: "estimated", recorded: null });
  });
  it("suppresses the queue only when complexity is explicitly disabled", async () => {
    const disabled = await brief('{"schemaVersion":1,"complexity":{"enabled":false}}', [
      sized(1, []),
    ]);
    expect(disabled.report.estimation).toMatchObject({ status: "disabled", queue: null });
  });
  it("keeps the label queue available when a retired field mapping is stored (#153)", async () => {
    const { report } = await brief('{"schemaVersion":1,"complexity":{"fieldId":"IF_old"}}', [
      sized(1, []),
    ]);
    expect(report.estimation).toMatchObject({
      status: "available",
      queue: { items: [{ number: 1, state: "unestimated" }] },
      findings: [
        {
          rule: "config-retired-key",
          next: ["pdb config set complexity.enabled true"],
        },
      ],
    });
    // A stored mapping never leaks into the deprecated, always-null property.
    expect(report.estimation).toHaveProperty("fieldId", null);
  });
  it("advertises no native-field setup command (#153)", async () => {
    const top: string[] = [];
    await main(["--help", "--no-update-check"], async (x) => void top.push(x));
    expect(top.join("")).not.toMatch(/setup complexity|issue field|fieldId/);
  });
  it("offers estimation only without higher-priority work, or first on --estimate", async () => {
    const idle = await brief(null, [blocked()]);
    expect(idle.report.estimation.offered).toBe(true);
    const runtime = {
      collect: async () => snapshot([issue(1), blocked()], []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(null), git, cwd: root },
      guide: {
        fs: config('{"schemaVersion":1,"briefing":{"engine":"typescript"}}'),
        git,
        cwd: root,
      },
    };
    let text = "";
    await main(["--estimate"], async (t) => void (text = t), runtime);
    expect(text.indexOf("ESTIMATION (requested)")).toBeGreaterThan(0);
    expect(text.indexOf("ESTIMATION (requested)")).toBeLessThan(text.indexOf("NEXT STEPS"));
    expect(text).toContain("unestimated [unestimated]; implementation ineligible");
    expect(text).toContain("acquires no claim");
    let full = "";
    await main(["--estimate", "--full"], async (t) => void (full = t), runtime);
    expect(full.indexOf("ESTIMATION (requested)")).toBeGreaterThan(0);
    expect(full.indexOf("ESTIMATION (requested)")).toBeLessThan(full.indexOf("NEXT ACTIONS"));
    let plain = "";
    await main([], async (t) => void (plain = t), runtime);
    expect(plain.indexOf("ESTIMATION (optional")).toBeGreaterThan(plain.indexOf("NEXT STEPS"));
    // #247: the side-by-side line replaces the old size parenthetical in text.
    expect(plain).toContain(
      "#1 Ticket 1 \n  impact unassessed · complexity unassessed · unlocks at least 0",
    );
  });
  it("reads sizes from cached labels offline, and keeps --full in sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-estimation-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot([issue(1)], []));
      let out = "";
      await main(["--offline", "--cache", cache, "--full", "--json"], async (t) => void (out = t), {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        estimation: { fs: config(null), git, cwd: root },
        guide: {
          fs: config('{"schemaVersion":1,"briefing":{"engine":"typescript"}}'),
          git,
          cwd: root,
        },
      });
      expect(JSON.parse(out).estimation).toMatchObject({
        status: "available",
        queue: { items: [{ number: 1, state: "unestimated" }] },
      });
      expect(JSON.parse(out).schemaVersion).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("label-backed complexity classification and prepared reader (#151)", () => {
  const labelled = (number: number, labels: string[], truncated = false): Issue => ({
    ...issue(number, labels),
    labels: page(
      labels.map((name) => ({ name })),
      truncated,
      truncated ? "c" : null,
    ),
  });
  const marker = (size: "M" | "S", recordedAt = time) =>
    provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size,
      previous: [],
      rationale: "contained capability",
      assumptions: [],
      references: [],
      estimator: "ana",
      revision: null,
      guidanceVersion: complexityGuidance.guidanceVersion,
      recordedAt,
    });
  const withComment = (item: Issue, body: string): Issue => ({
    ...item,
    // Written by a verified maintainer (#269): only trusted provenance counts as recorded.
    comments: page([
      {
        body,
        url: `${item.url}#c`,
        author: { __typename: "User", login: "maintainer" },
        createdAt: time,
        lastEditedAt: null,
        includesCreatedEdit: false,
        editor: null,
      },
    ]),
  });
  const available = { status: "available" as const, unavailable: null, findings: [] };
  const options = { prs: [], limit: 10 };

  it("names canonical labels with uppercase suffixes and matches case-insensitively", () => {
    expect(complexityLabelName("XL")).toBe("complexity:XL");
    expect(classifyComplexityLabels(labelled(1, ["Complexity:xl", "status:ready"]))).toMatchObject({
      state: "estimated",
      size: "XL",
      labels: ["Complexity:xl"],
    });
    expect(classifyComplexityLabels(labelled(1, ["status:ready", "complexity-ish"]))).toMatchObject(
      { state: "unestimated", size: null },
    );
  });

  it("reports several or unrecognized size labels as conflicts without choosing a size", () => {
    const many = classifyComplexityLabels(labelled(1, ["complexity:S", "complexity:XL"]));
    expect(many).toMatchObject({ state: "conflicting", size: null, sizes: ["S", "XL"] });
    const odd = classifyComplexityLabels(labelled(1, ["complexity:huge"]));
    expect(odd).toMatchObject({
      state: "conflicting",
      size: null,
      unrecognized: ["complexity:huge"],
    });
    // Two spellings of one size are still a single recognized size.
    expect(classifyComplexityLabels(labelled(1, ["complexity:M", "complexity:m"]))).toMatchObject({
      state: "estimated",
      size: "M",
    });
  });

  it("Ticket Doctor reports conflicting size labels via the shared classifier, never unestimated", () => {
    const r = ticketDoctor(
      snapshot(
        [
          labelled(1, ["bug", "status:ready", "complexity:S", "complexity:XL"]),
          labelled(2, ["bug", "status:ready"]),
          labelled(3, ["bug", "status:ready", "complexity:M"]),
        ],
        [],
      ),
      { now: new Date(time) },
    );
    const complexity = r.tickets.flatMap((t) =>
      t.findings.filter((f) => f.kind.startsWith("complexity")).map((f) => [t.number, f]),
    );
    expect(complexity).toHaveLength(1);
    expect(complexity[0]).toMatchObject([
      1,
      { kind: "complexity-label-conflict", certainty: "definite", plan: { judgment: true } },
    ]);
    const [, finding] = complexity[0] as [number, { plan: { steps: { argv: string[] }[] } }];
    expect(finding.plan.steps.map((x) => x.argv.slice(1, 3))).toEqual([
      ["--issue", "1"],
      ["estimate", "1"],
    ]);
  });
  it("treats truncated label pages as unknown, never unestimated", () => {
    expect(classifyComplexityLabels(labelled(1, ["status:ready"], true)).state).toBe("unknown");
    expect(classifyComplexityLabels(labelled(1, ["complexity:M"], true)).state).toBe("unknown");
    expect(
      classifyComplexityLabels(labelled(1, ["complexity:M", "complexity:S"], true)).state,
    ).toBe("conflicting");
  });

  it("queues unestimated and stale tickets including blocked ones; conflicts are inspection cases", async () => {
    const blocked: Issue = {
      ...labelled(2, []),
      issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
    };
    const issues = [
      withComment(labelled(1, ["complexity:M"]), marker("M")),
      blocked,
      withComment(labelled(3, ["complexity:L", "status:ready"]), marker("S")),
      labelled(4, ["complexity:S", "complexity:M"]),
      labelled(5, ["status:ready"], true),
    ];
    const provenance = await readComplexityProvenance(issues, async () => ({
      status: "trusted",
    }));
    const report = labelEstimationReport(issues, { ...available, provenance }, options);
    expect(report.status).toBe("available");
    expect(report.queue?.items.map((e) => [e.number, e.state, e.implementation])).toEqual([
      [2, "unestimated", "ineligible"],
      [3, "stale", "eligible"],
    ]);
    expect(report.queue?.items[1]?.reasons[0]).toContain("differs from recorded estimate S");
    expect(report.conflicts.map((e) => [e.number, e.size])).toEqual([[4, null]]);
    expect(report.unknown).toBe(1);
    expect(report.entries.find((e) => e.number === 1)?.state).toBe("estimated");
    expect(report.detail).toContain("1 with conflicting size evidence to inspect");
    expect(estimationText(report).join("\n")).toContain("#4 Ticket 4 — inspect: conflicting sizes");
  });

  it("suppresses the queue when disabled and reads only configuration, never GitHub", async () => {
    expect(
      labelEstimationReport([labelled(1, [])], { ...available, status: "disabled" }, options),
    ).toMatchObject({ status: "disabled", queue: null, conflicts: [] });
    const root = "/repo";
    const configPath = join(root, CONFIG_PATH);
    const fs = (text: string | null): ConfigFileSystem => ({
      readText: async (file) => (file === configPath ? text : null),
      writeText: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    });
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
    expect((await collectLabelEstimationInput(repo, { fs: fs(null), git, cwd: root })).status).toBe(
      "available",
    );
    expect(
      (
        await collectLabelEstimationInput(repo, {
          fs: fs('{"schemaVersion":1,"complexity":{"enabled":false}}\n'),
          git,
          cwd: root,
        })
      ).status,
    ).toBe("disabled");
  });

  it("suggests sizes from the registered table only, case-insensitively (#178)", () => {
    expect(INVALID_SIZE_SUGGESTIONS).toMatchObject({
      huge: "XL",
      small: "S",
      med: "M",
      tiny: "XS",
    });
    expect(suggestedSize("complexity:Huge")).toBe("XL");
    expect(suggestedSize("complexity:banana")).toBeNull();
    expect(suggestedSize("complexity:xl")).toBeNull(); // valid, not invalid
    expect(suggestedSize("complexity:constructor")).toBeNull();
    expect(complexityLabelFindings(labelled(1, ["complexity:xl"]))).toEqual([]);
  });
  it("Ticket Doctor flags invalid complexity labels as a judgment plan with suggestions (#178)", () => {
    const r = ticketDoctor(
      snapshot(
        [
          labelled(1, ["bug", "status:ready", "complexity:huge"]),
          labelled(2, ["bug", "status:ready", "complexity:banana"]),
          labelled(3, ["bug", "status:ready", "complexity:S", "complexity:large", "complexity:XL"]),
          labelled(4, ["bug", "status:ready", "complexity:tiny"], true),
        ],
        [],
      ),
      { now: new Date(time) },
    );
    const invalid = (n: number) =>
      r.tickets
        .find((t) => t.number === n)!
        .findings.find((f) => f.kind === "complexity-label-invalid")!;
    // Mapped suffix: a labelled suggestion, never an applied size.
    expect(invalid(1)).toMatchObject({ certainty: "definite", plan: { judgment: true } });
    expect(invalid(1).detail).toContain("complexity:huge (suggested size XL)");
    expect(invalid(1).plan.facts).toEqual([
      "Suggestion only (never applied): complexity:huge probably means XL; confirm against the ticket.",
    ]);
    const fix = invalid(1).plan.steps.find((x) => x.argv[1] === "estimate")!;
    expect(fix.argv).toEqual([
      "pdb",
      "estimate",
      "1",
      "--size",
      "<SIZE>",
      "--rationale",
      "<RATIONALE>",
      "--replace-invalid",
      "--repo",
      repo,
    ]);
    // Unmapped suffix: no suggestion; asks for a size.
    expect(invalid(2).detail).toContain("complexity:banana (no suggestion)");
    expect(invalid(2).plan.facts[0]).toContain("No suggestion for complexity:banana");
    // Mixed valid and invalid: both are reported, and several valid sizes are also a conflict.
    expect(invalid(3).detail).toContain(
      "valid size label(s) also present: complexity:S, complexity:XL",
    );
    expect(
      r.tickets
        .find((t) => t.number === 3)!
        .findings.map((f) => f.kind)
        .filter((k) => k.startsWith("complexity")),
    ).toEqual(["complexity-label-invalid", "complexity-label-conflict"]);
    // Truncated labels: unknown, inspection only, the suggestion kept as a fact.
    expect(invalid(4)).toMatchObject({ certainty: "unknown", plan: { judgment: false } });
    expect(invalid(4).plan.steps.every((x) => x.kind === "inspect")).toBe(true);
    expect(invalid(4).plan.facts[0]).toContain("probably means XS");
  });
  it("gives Ticket Doctor conflict and incomplete findings, never for unestimated tickets", () => {
    expect(complexityLabelFindings(labelled(1, []))).toEqual([]);
    expect(complexityLabelFindings(labelled(1, ["complexity:XS", "complexity:XXL"]))).toMatchObject(
      [{ kind: "complexity-label-conflict", certainty: "definite" }],
    );
    expect(complexityLabelFindings(labelled(1, [], true))).toMatchObject([
      { kind: "complexity-labels-incomplete", certainty: "unknown" },
    ]);
  });
});

describe("verified-author complexity provenance (#269, doc/design/complexity-provenance-trust.md)", () => {
  const record = (size: "M" | "S", rationale: string, recordedAt = time) =>
    provenanceComment({
      schemaVersion: 2,
      kind: "complexity-estimate",
      storage: "labels",
      size,
      previous: [],
      rationale,
      assumptions: [],
      references: [],
      estimator: "ana",
      revision: null,
      guidanceVersion: complexityGuidance.guidanceVersion,
      recordedAt,
    });
  type Note = { body: string; login: string; editor?: string };
  const ticket = (
    number: number,
    labels: string[],
    notes: Note[],
    { newerMissing = false } = {},
  ): Issue => ({
    ...issue(number, labels),
    labels: page(labels.map((name) => ({ name }))),
    comments: page(
      notes.map((n, i) => ({
        body: n.body,
        url: `${issue(number).url}#c${i}`,
        createdAt: time,
        author: { __typename: "User", login: n.login },
        lastEditedAt: n.editor ? time : null,
        includesCreatedEdit: false,
        editor: n.editor ? { __typename: "User", login: n.editor } : null,
      })),
      newerMissing,
      newerMissing ? "c" : null,
    ),
  });
  /** Permissions by login: maintainer writes, reader reads, everyone else unknown (404). */
  const lookups: string[] = [];
  const rest: Rest = async (path) => {
    const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1] ?? "";
    lookups.push(login);
    return login === "maintainer"
      ? { status: 200, body: { role_name: "write", user: { login } } }
      : login === "reader"
        ? { status: 200, body: { role_name: "read", user: { login } } }
        : { status: 404, body: null };
  };
  const trust = () => markerTrust(permissionLookup(repo, rest));
  const report = async (issues: Issue[], withDecisions = true) =>
    labelEstimationReport(
      issues,
      {
        status: "available",
        unavailable: null,
        findings: [],
        ...(withDecisions ? { provenance: await readComplexityProvenance(issues, trust()) } : {}),
      },
      { prs: [], limit: 10 },
    );
  const entry = (r: Awaited<ReturnType<typeof report>>, n: number) =>
    r.entries.find((e) => e.number === n)!;
  const trusted = { body: record("M", "trusted reasons"), login: "maintainer" };

  it("accepts a current trusted record and skips a newer confirmed-untrusted one", async () => {
    const r = await report([
      ticket(1, ["complexity:M"], [trusted]),
      ticket(2, ["complexity:M"], [trusted, { body: record("S", "spoof"), login: "reader" }]),
    ]);
    expect(entry(r, 1)).toMatchObject({
      state: "estimated",
      size: "M",
      provenanceAuthority: "trusted",
      ignoredProvenance: [],
      recorded: { rationale: "trusted reasons" },
    });
    expect(entry(r, 2)).toMatchObject({
      state: "estimated",
      provenanceAuthority: "trusted",
      recorded: { rationale: "trusted reasons", size: "M" },
    });
    expect(entry(r, 2).ignoredProvenance).toHaveLength(1);
    expect(entry(r, 2).ignoredProvenance[0]).toMatch(/untrusted provenance ignored/);
  });

  it("stops at a newer record of unknown authority: never falls back, keeps the label size, never queues", async () => {
    const r = await report([
      ticket(1, ["complexity:M"], [trusted, { body: record("M", "who?"), login: "stranger" }]),
      ticket(2, ["complexity:M"], [{ ...trusted, editor: "stranger" }]),
    ]);
    for (const n of [1, 2]) {
      expect(entry(r, n)).toMatchObject({
        state: "unknown",
        size: "M",
        recorded: null,
        provenanceAuthority: "unknown",
      });
      expect(entry(r, n).reasons.join()).toMatch(/provenance authority unknown/);
    }
    expect(r.queue?.items).toEqual([]);
    expect(estimationText(r).join("\n")).not.toContain("who?");
  });

  it("untrusted-only history is no trusted record: the size stands, nothing untrusted is copied", async () => {
    const r = await report([
      ticket(1, ["complexity:M"], [{ body: record("S", "bot reasons"), login: "reader" }]),
      ticket(2, [], [{ body: record("S", "bot reasons"), login: "reader" }]),
    ]);
    expect(entry(r, 1)).toMatchObject({
      state: "estimated",
      size: "M",
      recorded: null,
      provenanceAuthority: "untrusted",
    });
    expect(entry(r, 1).reasons).toContain("no trusted recorded rationale");
    expect(JSON.stringify(entry(r, 1))).not.toContain("bot reasons");
    // Label classification is unchanged: an unlabelled ticket is still unestimated.
    expect(entry(r, 2)).toMatchObject({ state: "unestimated", size: null });
  });

  it("missing newer history makes provenance unknown even when a trusted record was found", async () => {
    const r = await report([ticket(1, ["complexity:M"], [trusted], { newerMissing: true })]);
    expect(entry(r, 1)).toMatchObject({ state: "unknown", provenanceAuthority: "unknown" });
    expect(entry(r, 1).reasons.join()).toMatch(/newer comment history incomplete/);
  });

  it("another metric's provenance never supplies complexity history", async () => {
    const impact =
      '<!-- github-triage:impact-estimate v1 {"schemaVersion":1,"kind":"impact-estimate","size":"M"} -->';
    const r = await report([ticket(1, ["complexity:M"], [{ body: impact, login: "maintainer" }])]);
    expect(entry(r, 1)).toMatchObject({ provenanceAuthority: "none", recorded: null });
  });

  it("without prepared decisions nothing is trusted: a marker is unknown, no marker is none", async () => {
    const r = await report(
      [ticket(1, ["complexity:M"], [trusted]), ticket(2, ["complexity:M"], [])],
      false,
    );
    expect(entry(r, 1)).toMatchObject({ state: "unknown", provenanceAuthority: "unknown" });
    expect(entry(r, 2)).toMatchObject({ state: "estimated", provenanceAuthority: "none" });
  });

  it("asks about each distinct marker author once per run, and only for labelled tickets", async () => {
    lookups.length = 0;
    await report([
      ticket(1, ["complexity:M"], [trusted]),
      ticket(2, ["complexity:S"], [{ ...trusted, body: record("S", "s") }]),
      ticket(3, [], [{ body: record("S", "x"), login: "unlabelled" }]),
    ]);
    expect(lookups).toEqual(["maintainer"]);
  });
});
