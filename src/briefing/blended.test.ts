/**
 * Shared blended-action policy (#248): the pure comparator over injected facts, and the additive
 * `rankedActions` output through the real collector with a fake GraphQL boundary.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { CompactBriefing } from "./compact.js";
import { TOML_CONFIG_PATH } from "../config/config.js";
import type { ConfigFileSystem, GitRunner } from "../config/config.js";
import { collect } from "../github/github.js";
import type { Query } from "../github/github.js";
import { presentBriefing } from "./service.js";
import type { Issue, Page } from "../github/types.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;

// ---- Integration through the real collector with a fake GraphQL boundary ----

const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const issue = (n: number, labels: string[], createdAt = time): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
/** Hand-set labels (no provenance) read as `current` with "no recorded rationale". */
const fixture = (): Issue[] => [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XS", "complexity:XL"], "2026-10-01T00:00:00Z"),
  issue(3, ["status:ready", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
  issue(4, ["status:ready", "impact:XL"], "2026-11-03T00:00:00Z"),
  issue(5, ["status:needs-design", "complexity:XS"], "2026-11-04T00:00:00Z"),
  issue(6, ["status:ready", "complexity:S", "complexity:L"], "2026-11-05T00:00:00Z"),
  {
    ...issue(7, ["status:ready", "impact:XL"], "2026-11-06T00:00:00Z"),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
    blockedBy: page([
      {
        number: 3,
        title: "Ticket 3",
        url: url(3),
        state: "OPEN",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 1,
          totalBlocking: 1,
        },
      },
    ]),
  },
  issue(8, ["status:ready", "agent:other", "impact:S"], "2026-11-07T00:00:00Z"),
  issue(9, ["status:parked", "impact:XL"], "2026-11-08T00:00:00Z"),
];
const queryFor =
  (issues: () => Issue[]): Query =>
  async (source) => ({
    repository: {
      issues: page(source.includes("issues(first") ? issues() : []),
      pullRequests: page([]),
    },
  });
const root = "/repo";
const files = (config: string | null = null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const estimation = (config: string | null = null) => ({ fs: files(config), git, cwd: root });

async function present(
  role: "implementer" | "designer" | undefined,
  extra: {
    order?: "impact" | "oldest";
    limit?: number;
    config?: string;
    estimate?: boolean;
    issues?: () => Issue[];
    context?: boolean;
  } = {},
) {
  const snapshot = await collect(repo, {}, queryFor(extra.issues ?? fixture), () => new Date(time));
  const options = {
    limit: extra.limit ?? 20,
    maxChars: 20000,
    agent: "me",
    ...(role ? { role } : {}),
    ...(extra.order ? { order: extra.order } : {}),
    ...(extra.estimate ? { estimate: true } : {}),
    ...(extra.context ? { context: true } : {}),
  };
  const presented = await presentBriefing(
    snapshot,
    options,
    estimation(extra.config ?? null),
    new Date(time),
  );
  return { snapshot, options, report: presented.report as CompactBriefing, text: presented.text };
}
const items = (report: CompactBriefing) =>
  (report.rankedActions?.items ?? []).map((i) => `${i.kind}#${Number(i.target.split("/").pop())}`);

describe("rankedActions through collect() (#248)", () => {
  it("blends the implementer queue: easy win, boosted estimate, assessments, ordinary, unfavorable", async () => {
    const { report } = await present("implementer");
    expect(items(report)).toEqual([
      "implement#1",
      "estimate-complexity#4",
      "estimate-complexity#7",
      "inspect-assessment#6",
      "estimate-complexity#8",
      "implement#3",
      "implement#4",
      "implement#6",
      "implement#2",
      // #1050 (#651): one pool; the designer-affinity rows follow the implementer's own.
      "assess-impact#5",
      "assess-impact#6",
      "design#5",
    ]);
    const ranked = report.rankedActions!;
    expect(ranked.policyVersion).toBe(1);
    expect(ranked.items[0]).toMatchObject({
      band: 4,
      reasonCodes: ["easy-win"],
      impact: { state: "current", size: "L" },
      complexity: { state: "current", size: "S" },
      nextCommand: `pdb claim 1 --repo ${repo} --agent me`,
    });
    // A blocked ticket (#7) may be assessed but is never implementation pickup; another agent's
    // claim (#8) can be estimated (no claim) but never picked up; parked work (#9) is absent; a
    // current small complexity (#5) needs no estimate.
    expect(items(report)).not.toContain("implement#7");
    expect(items(report)).not.toContain("implement#8");
    expect(items(report).some((i) => i.endsWith("#9") || i === "estimate-complexity#5")).toBe(
      false,
    );
    const inspect = ranked.items.find((i) => i.kind === "inspect-assessment");
    // Conflicting (not invalid) complexity is inspected; only invalid labels get --replace-invalid (#1067).
    expect(inspect).toMatchObject({ band: 5, nextCommand: `pdb --repo ${repo} --issue 6 --json` });
    expect(ranked.items.find((i) => i.target === url(2))).toMatchObject({
      band: 7,
      reasonCodes: expect.arrayContaining(["unfavorable"]),
    });
  });

  it("blends the designer queue with boosted impact assessment above new design work", async () => {
    const { report } = await present("designer");
    const kinds = items(report);
    expect(kinds[0]).toBe("assess-impact#5");
    expect(report.rankedActions?.items[0]?.reasonCodes).toContain("cross-role-boost");
    expect(kinds.indexOf("design#5")).toBeGreaterThan(kinds.indexOf("assess-impact#6"));
    // #1050 (#651): implementer-affinity work follows the designer's own, never precedes it.
    expect(kinds.findIndex((k) => k.startsWith("estimate-complexity"))).toBeGreaterThan(
      kinds.indexOf("design#5"),
    );
  });

  it("applies limits after ranking and keeps omitted assessments counted", async () => {
    const { report } = await present("implementer", { limit: 2 });
    expect(report.rankedActions).toMatchObject({ total: 12, omitted: 10 });
    expect(items(report)).toEqual(["implement#1", "estimate-complexity#4"]);
  });

  it("coalesces pickup by age under explicit oldest", async () => {
    const { report } = await present("implementer", { order: "oldest" });
    const implement = items(report).filter((k) => k.startsWith("implement"));
    expect(implement).toEqual([
      "implement#2",
      "implement#1",
      "implement#3",
      "implement#4",
      "implement#6",
    ]);
  });

  it("suppresses only the disabled metric's assessments and value bands", async () => {
    const { report } = await present("implementer", {
      config: "schemaVersion = 1\n[complexity]\nenabled = false\n",
    });
    expect(items(report).some((k) => k.startsWith("estimate-complexity"))).toBe(false);
    // Without complexity there are no easy-win or unfavorable value bands for implementation.
    expect(
      report.rankedActions?.items.filter((i) => i.kind === "implement").every((i) => i.band === 6),
    ).toBe(true);
    expect(items(report)).toContain("implement#1");
  });

  it("defaults to the implementer order without a role (#651)", async () => {
    const { report } = await present(undefined);
    expect(items(report)).toEqual(items((await present("implementer")).report));
  });
});

/** First-occurrence targets of the ranked queue: the legacy projection (#259). */
const projection = (report: CompactBriefing): string[] => [
  ...new Set((report.rankedActions?.items ?? []).map((i) => i.target)),
];

describe("legacy projections follow the blended ranking (#259)", () => {
  for (const role of ["implementer", "designer"] as const)
    for (const order of ["impact", "oldest"] as const)
      it(`projects actions and role.next from rankedActions for ${role} (${order})`, async () => {
        const { report } = await present(role, { order });
        // Target-only, each target once, in native ranked order (#1050: the native engine).
        const targets = projection(report);
        expect(report.actions).toEqual({ total: targets.length, omitted: 0, items: targets });
        expect(report.role?.next.map((r) => r.url)).toEqual(targets);
        expect(report.role?.next.every((r) => typeof r.reason === "string" && r.reason)).toBe(true);
      });

  it("bounds the projection by --limit after ranking, with repeated targets once", async () => {
    const { report } = await present("implementer", { limit: 3 });
    const all = projection((await present("implementer", { limit: 50 })).report);
    // Ranked: implement#1, estimate#4, estimate#7, ...; later rows repeat targets.
    expect(report.actions.items).toEqual([url(1), url(4), url(7)]);
    expect(report.actions).toMatchObject({ total: all.length, omitted: all.length - 3 });
    expect(report.role?.next.map((r) => r.url)).toEqual(report.actions.items);
    // A target no role section placed (another agent's claim) explains itself by its ranked action.
    expect(
      (await present("implementer")).report.role?.next.find((r) => r.url === url(8))?.reason,
    ).toContain("Effort is unassessed");
  });
});

describe("implementer estimation counts and NEXT STEPS (#259)", () => {
  it("counts eligible, ranked and shown estimates; offered survives truncation", async () => {
    const { report } = await present("implementer", { limit: 2 });
    // #2, #3, #5 and #6 have complexity; #1 too; #4, #7, #8, #9 are unassessed.
    expect(report.estimation).toMatchObject({
      requested: false,
      offered: true,
      eligible: 4,
      ranked: 3,
      shown: 1,
    });
    const none = await present("implementer", { limit: 0 });
    expect(none.report.estimation).toMatchObject({ offered: true, ranked: 3, shown: 0 });
  });

  it("renders the ranked queue as NEXT STEPS with kinds, reasons and commands", async () => {
    const { text, report } = await present("implementer", { limit: 3, context: true });
    const steps = text.slice(text.indexOf("NEXT STEPS"));
    // #1050: the native pool (#651) also ranks impact assessments for the implementer.
    expect(steps).toMatch(/^NEXT STEPS \(12; 9 omitted\)/);
    expect(steps).toContain("— implement (easy-win)");
    expect(steps).toContain("— estimate-complexity (assessment, cross-role-boost");
    expect(steps).toContain(
      `Next: pdb estimate 4 --metric complexity --size SIZE --rationale TEXT --repo ${repo}`,
    );
    expect(steps).toContain(
      "- Complexity assessment: 4 eligible, 3 ranked, 2 shown; 1 conflicting.",
    );
    expect(text).not.toContain("estimation is offered below");
    expect(text).toContain("ESTIMATION (detail; estimates are ranked in NEXT STEPS)");
    expect(report.rankedActions?.items).toHaveLength(3);
  });

  it("keeps --estimate as the focused view first", async () => {
    const { text, report } = await present("implementer", { estimate: true });
    expect(report.estimation).toMatchObject({ requested: true, offered: true });
    expect(text.indexOf("ESTIMATION (requested)")).toBeLessThan(text.indexOf("NEXT STEPS"));
  });

  it("hides the complexity counts and offers nothing when complexity is disabled", async () => {
    const { text, report } = await present("implementer", {
      config: "schemaVersion = 1\n[complexity]\nenabled = false\n",
    });
    expect(report.estimation).toMatchObject({ status: "disabled", offered: false, ranked: 0 });
    expect(text).not.toContain("Complexity assessment:");
    expect(report.actions.items).toContain(url(1));
  });

  it("treats truncated labels as unknown: never an estimate, an easy win or a count", async () => {
    const issues = () => [
      ...fixture().filter((i) => i.number !== 1),
      {
        ...issue(1, ["status:ready", "impact:L"], "2026-11-01T00:00:00Z"),
        labels: page([{ name: "status:ready" }, { name: "impact:L" }], true),
      },
    ];
    const { report } = await present("implementer", { issues });
    const one = report.rankedActions?.items.filter((i) => i.target === url(1)) ?? [];
    expect(one.map((i) => i.kind)).not.toContain("estimate-complexity");
    expect(one.every((i) => i.band !== 4)).toBe(true);
    // Unchanged from the fixture: #4, #7, #8 and parked #9 eligible; #1 is neither.
    expect(report.estimation).toMatchObject({ eligible: 4, ranked: 3 });
  });

  it("keeps an own claim visible and hands off before another pickup", async () => {
    const issues = () => [
      ...fixture().filter((i) => i.number !== 3),
      issue(3, ["status:ready", "agent:me", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
    ];
    const { report } = await present("implementer", { issues });
    // #1050 (#651): owned work ranks first, then the easy win with the release handoff.
    const [own, easy] = report.rankedActions?.items ?? [];
    expect(own).toMatchObject({ kind: "continue-implementation", target: url(3), band: 6 });
    expect(own?.reasonCodes).toContain("own-claim");
    expect(easy).toMatchObject({
      kind: "implement",
      target: url(1),
      nextCommand: `pdb release 3 --repo ${repo} --agent me --as incomplete --note TEXT`,
      thenCommand: `pdb claim 1 --repo ${repo} --agent me`,
    });
    expect(report.actions.items).toContain(url(3));
  });
});
