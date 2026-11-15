import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, main } from "../cli.js";
import { briefing, textReport } from "./briefing.js";
import { collect, type Query } from "../github/github.js";
import {
  changeSubject,
  parseDuration,
  resolveWindow,
  snapshotChangeEvidence,
} from "../github/changes.js";
import type { Issue, PullRequest, Snapshot } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";
import { brief } from "../testing/briefing.js";
import { snapshotFollowUpFacts } from "../workflow/deliveryread.js";

describe("registered action analysis", () => {
  it("shows ownership conflicts, stale ready labels and absent readiness", () => {
    const data = brief(snapshot([issue(1, ["agent:a", "agent:b", "status:ready"]), issue(2, [])]));
    expect(data.actions.items.map((item) => item.rule)).toEqual(
      expect.arrayContaining(["ownership-conflict", "claimed-ready", "readiness-inconsistent"]),
    );
    expect(data.ready.total).toBe(0);
  });
  it("gives parked work no pickup action, and closed full-detail issues no active actions", () => {
    const closed = { ...issue(2), state: "CLOSED" };
    const data = brief(snapshot([issue(1, ["status:parked"]), closed], []));
    expect(data.actions.total).toBe(0);
    expect(data.parked.total).toBe(1);
  });
  it("flags questions as candidates while retaining later answers in full detail", () => {
    const one = issue();
    one.comments.nodes = [
      { body: "Should this be blue?", url: "question", author: null },
      { body: "Use blue. Resolved.", url: "answer", author: null },
    ];
    const data = briefing(snapshot([one], []), { limit: 100, issue: 1 }, new Date(time));
    const candidate = data.actions.items.find((item) => item.rule === "question-candidate")!;
    expect(candidate.uncertainty).toBe("candidate");
    expect(candidate.next).toContain("already be answered");
    expect(data.detail!.comments.nodes.at(-1)!.body).toContain("Resolved");
  });
  it("requires the actual verify check and does not infer success from another green job", () => {
    const pull = pr();
    pull.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes[0]!.name = "unrelated";
    const findings = brief(snapshot([], [pull])).actions.items;
    expect(findings.some((item) => item.rule === "pr-inspect-merge")).toBe(false);
    expect(findings.some((item) => item.rule === "pr-verification-needed")).toBe(true);
  });
  it("failed CI, unresolved/outdated reviews and pending checks prevent merge candidates", () => {
    const pull = pr();
    pull.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push(
      { name: "lint", conclusion: "FAILURE" },
      { name: "slow", status: "IN_PROGRESS" },
    );
    pull.reviewThreads.nodes.push({
      isResolved: false,
      isOutdated: true,
      comments: page([{ body: "Fix this", url: "finding", author: null }]),
    });
    const findings = brief(snapshot([], [pull])).actions.items.map((item) => item.rule);
    expect(findings).toEqual(
      expect.arrayContaining(["pr-failed-checks", "pr-review-findings", "pr-pending"]),
    );
    expect(findings).not.toContain("pr-inspect-merge");
  });
  it("clean checks are only a source-linked inspection candidate with head identity", () => {
    const data = brief(snapshot([], [pr()]));
    expect(data.actions.items.find((item) => item.rule === "pr-inspect-merge")?.uncertainty).toBe(
      "candidate",
    );
    expect(data.pullRequests[0]?.headRefOid).toBe("abc123");
    expect(data.actions.items[0]?.next).toContain("not approval");
  });
  it("marks a PR incomplete only for warnings about that PR, not a longer number (#448)", () => {
    const pull = pr();
    const withWarning = (warning: string) => ({
      ...snapshot([], [pull]),
      warnings: [warning],
    });
    const inspects = (s: Snapshot) =>
      brief(s).actions.items.some((item) => item.rule === "pr-inspect-merge");
    expect(
      inspects(withWarning(`${pull.url}2: reviews exceed 100; review/merge evidence incomplete.`)),
    ).toBe(true);
    expect(
      inspects(withWarning(`${pull.url}: reviews exceed 100; review/merge evidence incomplete.`)),
    ).toBe(false);
    const facts = (warning: string) => snapshotFollowUpFacts(pull, [warning]).complete;
    expect(facts(`${pull.url}2: reviews exceed 100.`)).toBe(true);
    expect(facts(`${pull.url}: reviews exceed 100.`)).toBe(false);
  });
  it("keeps stable ordering and reports omitted actions instead of silently hiding them", () => {
    const source = snapshot([issue(3), issue(2), issue(1)], []);
    const a = briefing(source, { limit: 1 }, new Date(time));
    expect(a.actions.total).toBe(3);
    expect(a.actions.omitted).toBe(2);
    expect(textReport(a)).toContain("2 more omitted");
    expect(a).toEqual(briefing(source, { limit: 1 }, new Date(time)));
  });
});

describe("native dependencies in the briefing", () => {
  const blocking = (from: Issue, dependants: number[]) => {
    from.issueDependenciesSummary!.blocking = dependants.length;
    from.issueDependenciesSummary!.totalBlocking = dependants.length;
    from.blocking = page(
      dependants.map((n) => ({
        ...issue(n),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        },
      })),
    );
  };
  it("ranks pickup by the number of dependants left without an open blocker", () => {
    const low = issue(1);
    const high = issue(2);
    const blocked = issue(3);
    blocking(high, [3, 4]);
    blocked.issueDependenciesSummary!.blockedBy = 1;
    blocked.issueDependenciesSummary!.totalBlockedBy = 1;
    const report = brief(snapshot([low, high, blocked], []));
    expect(report.ready.items.map((i) => i.number)).toEqual([2, 1]);
    const pickup = report.actions.items.filter((a) => a.rule === "ready-unclaimed");
    expect(pickup.map((a) => a.target)).toEqual([high.url, low.url]);
  });
  it(
    "marks a cache without native fields incomplete instead of treating tickets as unblocked",
    async () => {
      const old = issue() as Partial<Issue>;
      delete old.blockedBy;
      delete old.blocking;
      delete old.issueDependenciesSummary;
      const report = brief(snapshot([old as Issue], []));
      expect(report.completeness.complete).toBe(false);
      expect(report.completeness.warnings[0]).toContain("native dependency evidence missing");
      expect(report.ready.items).toEqual([]);
      expect(report.actions.items.map((a) => a.rule)).toContain("native-evidence-unknown");
      const dir = await mkdtemp(join(tmpdir(), "triage-old-cache-"));
      try {
        const cache = join(dir, "cache.json");
        await atomicJson(cache, snapshot([old as Issue], []));
        expect(await main(["--offline", "--cache", cache, "--json"], async () => {})).toBe(2);
        // Many old tickets: compact text bounds the warnings; JSON keeps every one.
        const many = Array.from({ length: 40 }, (_, i) => ({
          ...old,
          number: i + 1,
          url: issue(i + 1).url,
        }));
        await atomicJson(cache, snapshot(many as Issue[], []));
        let text = "";
        let json = "";
        await main(
          ["--offline", "--cache", cache, "--max-chars", "2000"],
          async (t) => void (text = t),
        );
        await main(["--offline", "--cache", cache, "--json"], async (t) => void (json = t));
        expect(text.match(/^INCOMPLETE: /gm)).toHaveLength(6);
        expect(text).toContain("35 more warning(s) omitted");
        expect(JSON.parse(json).completeness.warnings).toHaveLength(40);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
    // Three full offline CLI runs, one over 40 tickets, each evaluated by the default Datalog
    // engine: ~1.1s on a fast laptop but over the 5s default on Windows CI runners (#342).
    20_000,
  );
});

describe("designer groups: decision needed vs agreed-needs-documentation (#40)", () => {
  it("groups explicit markers separately with source reasons; unknown without one", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const decide = issue(40, ["design:decision-needed"]);
    decide.comments = page([
      {
        body: "design:decision-needed: which flag name?",
        url: `${decide.url}#c1`,
        author: null,
        createdAt: time,
      },
    ]);
    const record = issue(41, ["design:documentation-needed"]);
    const both = issue(42, ["design:decision-needed", "design:documentation-needed"]);
    const data = snapshot([decide, record, both], []);
    const expanded = briefing(data, { limit: 100 }, new Date(time));
    const rules = (n: number) =>
      expanded.actions.items
        .filter((a) => a.target.endsWith(`/${n}`) && a.rule.startsWith("design-"))
        .map((a) => `${a.uncertainty}:${a.rule}`);
    expect(rules(40)).toEqual(["factual:design-decision-needed"]);
    expect(
      expanded.actions.items.find(
        (a) => a.rule === "design-decision-needed" && a.target === decide.url,
      )!.evidence,
    ).toContain(`${decide.url}#c1`);
    expect(rules(41)).toEqual(["unknown:design-documentation-needed"]);
    expect(rules(42).sort()).toEqual([
      "unknown:design-decision-needed",
      "unknown:design-documentation-needed",
    ]);
    const compact = compactBriefing(data, { limit: 10 }, expanded);
    expect(compact.sections["decision-needed"].items).toEqual([decide.url, both.url]);
    expect(compact.sections["documentation-needed"].items).toEqual([record.url, both.url]);
    const text = compactText(compact, 50000, { context: true });
    expect(text).toContain("DECISION NEEDED (2)");
    expect(text).toContain("AGREED, NEEDS DOCUMENTATION (2)");
    expect(text).toContain(`which flag name?" Source: ${decide.url}#c1 Next:`);
    expect(text.match(/Source: /g)).toHaveLength(1);
  });
});

describe("briefing attention covers open pull requests (#169)", () => {
  it("reports attention labels and design markers on a PR, without question scanning", () => {
    const base = pr();
    const change: PullRequest = {
      ...base,
      labels: page([{ name: "blocked:credential" }, { name: "design:decision-needed" }]),
      comments: page([
        { body: "Any questions?", url: `${base.url}#c1`, author: null, createdAt: time },
      ]),
    };
    const report = briefing(snapshot([], [change]), { limit: 100 }, new Date(time));
    expect(
      report.actions.items
        .filter((a) => a.target === change.url && a.rule !== "pr-inspect-merge")
        .map((a) => a.rule)
        .sort(),
    ).toEqual(["attention-label", "design-decision-needed"]);
    expect(report.attention.items.map((i) => i.url)).toEqual([change.url]);
  });
});

describe("addressed attention for --agent (#3, doc/design/briefings.md)", () => {
  it("orders attention to the viewer first, then owned work, then pickup; never a claim", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const addressed = issue(20, ["status:parked", "attention:reader", "origin:farhad", "agent:bo"]);
    const other = issue(21, ["attention:someone"]);
    const mine = issue(22, ["agent:reader"]);
    const ready = issue(23, ["status:ready"]);
    const data = snapshot([ready, mine, other, addressed], []);
    const expanded = briefing(data, { limit: 100, agent: "reader" }, new Date(time));
    const compact = compactBriefing(data, { limit: 10, agent: "reader" }, expanded);
    expect(compact.actions.items.slice(0, 2)).toEqual([addressed.url, mine.url]);
    expect(compact.actions.items.indexOf(ready.url)).toBeGreaterThan(1);
    expect(compact.sections.addressed.items).toEqual([addressed.url]);
    const subject = compact.subjects.find((s) => s.url === addressed.url)!;
    expect(subject.owners).toEqual(["agent:bo"]);
    expect(subject.findings[0].reason).toMatch(/raised by farhad.*does not claim/);
    expect(compactText(compact).indexOf("#20")).toBeLessThan(compactText(compact).indexOf("#22"));
    // Another agent's attention never addresses this viewer.
    expect(compact.sections.addressed.items).not.toContain(other.url);
  });
  it("says addressed filtering is unavailable without --agent", async () => {
    const { compactBriefing } = await import("./compact.js");
    const data = snapshot([issue(20, ["attention:reader"])], []);
    const compact = compactBriefing(
      data,
      { limit: 10 },
      briefing(data, { limit: 100 }, new Date(time)),
    );
    expect(compact.sections.addressed.items).toEqual([]);
    expect(compact.guidance).toMatch(/No --agent given/);
  });
});

describe("addressed attention in the expanded briefing (#3)", () => {
  it("is a registered rule, so --full keeps it for parked and other-owned work", () => {
    const addressed = issue(30, ["status:parked", "attention:reader", "agent:bo"]);
    const full = briefing(
      snapshot([addressed, issue(31)], []),
      { limit: 100, agent: "reader" },
      new Date(time),
    );
    expect(full.actions.items[0]).toMatchObject({
      rule: "addressed-attention",
      target: addressed.url,
    });
    const anonymous = briefing(snapshot([addressed], []), { limit: 100 }, new Date(time));
    expect(anonymous.actions.items.some((a) => a.rule === "addressed-attention")).toBe(false);
  });
});

describe("manual urgency overrides in general pickup (#43)", () => {
  it("orders high before unspecified before low, reports conflicts, and never changes eligibility", () => {
    const high = issue(50, ["status:ready", "urgency:high"]);
    const plain = issue(51, ["status:ready"]);
    const low = issue(52, ["status:ready", "urgency:low"]);
    const both = issue(53, ["status:ready", "urgency:high", "urgency:low"]);
    const claimedHigh = issue(54, ["status:ready", "urgency:high", "agent:bo"]);
    const r = briefing(
      snapshot([low, both, plain, high, claimedHigh], []),
      { limit: 100 },
      new Date(time),
    );
    // Conflicting labels order as unspecified; ties then use creation time and number.
    expect(r.ready.items.map((i) => i.number)).toEqual([50, 51, 53, 52]);
    const pickup = r.actions.items
      .filter((a) => a.rule === "ready-unclaimed")
      .map((a) => a.target.split("/").pop());
    expect(pickup).toEqual(["50", "51", "53", "52"]);
    expect(
      r.actions.items.find((a) => a.rule === "ready-unclaimed" && a.target === high.url)!.reason,
    ).toMatch(/urgency high/);
    expect(
      r.actions.items.filter((a) => a.rule === "urgency-conflict").map((a) => a.target),
    ).toEqual([both.url]);
    // Urgency never makes claimed work pickable.
    expect(pickup).not.toContain("54");
  });
});

describe("briefing change evidence and comparison windows (#168)", () => {
  it("marks dependency links incomplete when nodes fall short of the native summary totals", () => {
    const window = { from: "2026-11-12T00:00:00.000Z", through: "2026-11-13T00:00:00.000Z" };
    const page = { hasNextPage: false, endCursor: null };
    const base = {
      number: 7,
      title: "t",
      url: "https://github.com/o/r/issues/7",
      state: "OPEN",
      createdAt: "2026-11-12T01:00:00Z",
      updatedAt: "2026-11-12T02:00:00Z",
      closedByPullRequestsReferences: { nodes: [], pageInfo: page },
    };
    const short = changeSubject(
      "issue",
      {
        ...base,
        issueDependenciesSummary: {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        },
        blockedBy: { nodes: [], pageInfo: page },
        blocking: { nodes: [], pageInfo: page },
      } as never,
      window,
    );
    expect(short).toMatchObject({ linksComplete: false });
    expect(short.unknown).toContain("links");
    const missingSummary = changeSubject(
      "issue",
      {
        ...base,
        blockedBy: { nodes: [], pageInfo: page },
        blocking: { nodes: [], pageInfo: page },
      } as never,
      window,
    );
    expect(missingSummary.linksComplete).toBe(false);
    const exact = changeSubject(
      "issue",
      {
        ...base,
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
        blockedBy: { nodes: [], pageInfo: page },
        blocking: { nodes: [], pageInfo: page },
      } as never,
      window,
    );
    expect(exact.linksComplete).toBe(true);
  });
  const t0 = "2026-11-13T09:00:00.000Z";
  const clock = () => new Date(t0);
  it("resolves exactly one window source with half-open UTC boundaries", () => {
    expect(resolveWindow({}, clock)).toMatchObject({
      source: "default-last",
      from: "2026-11-12T09:00:00.000Z",
      through: t0,
      last: "24h",
    });
    expect(resolveWindow({ last: "90m" }, clock).from).toBe("2026-11-13T07:30:00.000Z");
    expect(resolveWindow({ last: "2d" }, clock).from).toBe("2026-11-11T09:00:00.000Z");
    expect(resolveWindow({ since: "2026-11-13T10:00:00+02:00" }, clock)).toMatchObject({
      source: "since",
      from: "2026-11-13T08:00:00.000Z",
    });
    expect(resolveWindow({ checkpoint: { through: "2026-11-13T08:00:00Z" } }, clock)).toMatchObject(
      { source: "checkpoint", from: "2026-11-13T08:00:00.000Z" },
    );
    expect(resolveWindow({ checkpoint: { through: null } }, clock)).toMatchObject({
      source: "baseline",
      from: null,
      notice: expect.stringContaining("No previous comparison window"),
    });
    expect(() => resolveWindow({ since: t0, last: "1h" }, clock)).toThrow("one window source");
    expect(() => resolveWindow({ last: "1h", checkpoint: { through: null } }, clock)).toThrow(
      "one window source",
    );
    for (const bad of ["0h", "1w", "-1h", "1.5h", "h", "99999999999d"])
      expect(() => parseDuration(bad)).toThrow("--last");
    expect(() => resolveWindow({ last: "9999999999d" }, clock)).toThrow();
    expect(() => resolveWindow({ since: "2026-11-13" }, clock)).toThrow("ISO");
    expect(() => resolveWindow({ since: "2026-11-13T09:00:01Z" }, clock)).toThrow("after");
    expect(() => resolveWindow({ checkpoint: { through: "2027-01-01T00:00:00Z" } }, clock)).toThrow(
      "after",
    );
    expect(() => resolveWindow({ checkpoint: { through: "garbage" } }, clock)).toThrow("invalid");
  });

  const evidenceQuery =
    (issues: unknown, prs: unknown, calls: string[] = []): Query =>
    async (source) => {
      calls.push(source);
      if (source.includes("states:OPEN)"))
        return { repository: { issues: page([]), pullRequests: page([]) } };
      if (source.includes("pullRequests(")) return { repository: { pullRequests: prs } };
      return { repository: { issues } };
    };

  it("retains in-window merges despite later updates and keeps old closures distinct", async () => {
    const window = resolveWindow({ last: "24h" }, clock);
    const merged = {
      ...pr(),
      number: 5,
      url: `https://github.com/${repo}/pull/5`,
      state: "MERGED",
      createdAt: "2026-11-10T00:00:00Z",
      mergedAt: "2026-11-13T08:00:00Z",
      closedAt: "2026-11-13T08:00:00Z",
      // Commented on during collection, after T0.
      updatedAt: "2026-11-13T09:05:00Z",
    };
    const unmerged = {
      ...pr(),
      number: 6,
      url: `https://github.com/${repo}/pull/6`,
      state: "CLOSED",
      mergedAt: null,
      createdAt: "2026-11-12T12:00:00Z",
      closedAt: "2026-11-13T07:00:00Z",
      updatedAt: "2026-11-13T07:00:00Z",
    };
    const oldClosure = {
      ...issue(7),
      state: "CLOSED",
      stateReason: "COMPLETED",
      createdAt: "2026-10-01T00:00:00Z",
      closedAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-11-13T06:00:00Z",
      closedByPullRequestsReferences: page([
        {
          number: 3,
          url: `https://github.com/${repo}/pull/3`,
          repository: { nameWithOwner: repo },
        },
      ]),
    };
    const notPlanned = {
      ...issue(8),
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      closedAt: "2026-11-13T08:59:59.999Z",
      updatedAt: "2026-11-13T08:59:59.999Z",
      closedByPullRequestsReferences: page([]),
    };
    const atT0 = {
      ...issue(9),
      createdAt: t0,
      updatedAt: t0,
      closedByPullRequestsReferences: page([]),
    };
    const older = { ...issue(10), updatedAt: "2026-11-01T00:00:00Z" };
    const calls: string[] = [];
    const data = await collect(
      repo,
      { changeWindow: window },
      evidenceQuery(
        page([atT0, notPlanned, oldClosure, older], true, "more"),
        page([merged, unmerged]),
        calls,
      ),
      clock,
    );
    // Existing summary preserved for its callers.
    expect(data.since).toBe(window.from);
    expect(data.changed.map((c) => c.number)).toEqual([9, 8, 7, 5, 6]);
    const evidence = data.changeEvidence!;
    expect(evidence.complete).toBe(true);
    expect(evidence.coverage.map((c) => [c.source, c.complete, c.pages])).toEqual([
      ["issues", true, 1],
      ["pull-requests", true, 1],
    ]);
    // Stops at the cutoff: one page per source, no further history requests.
    expect(evidence.cost).toEqual({ requests: 2, maxPagesPerSource: 20 });
    const subject = (n: number) => evidence.subjects.find((s) => s.number === n)!;
    expect(subject(5)).toMatchObject({
      kind: "pull-request",
      mergedAt: "2026-11-13T08:00:00Z",
      updatedOnly: false,
      links: [{ relation: "closes", number: 1 }],
    });
    expect(subject(5).events).toContainEqual({
      type: "merged",
      at: "2026-11-13T08:00:00Z",
      inWindow: true,
    });
    expect(subject(6).events).toContainEqual({
      type: "closed-unmerged",
      at: "2026-11-13T07:00:00Z",
      inWindow: true,
    });
    expect(subject(7)).toMatchObject({ updatedOnly: true, stateReason: "COMPLETED" });
    expect(subject(7).events.find((e) => e.type === "closed")?.inWindow).toBe(false);
    expect(subject(7).links).toEqual([
      {
        relation: "closed-by",
        number: 3,
        url: `https://github.com/${repo}/pull/3`,
        repository: repo,
      },
    ]);
    expect(subject(8)).toMatchObject({ stateReason: "NOT_PLANNED", unknown: [] });
    expect(subject(8).events.find((e) => e.type === "closed")?.inWindow).toBe(true);
    // An event at T0 belongs to the next window.
    expect(subject(9).events).toEqual([{ type: "created", at: t0, inWindow: false }]);
    expect(subject(9).updatedOnly).toBe(false);
    expect(calls.some((s) => s.includes("closedByPullRequestsReferences"))).toBe(true);
  });

  it("reports a page cap before the window start as incomplete, never as no change", async () => {
    const window = resolveWindow({ last: "24h" }, clock);
    const recent = { ...issue(11), updatedAt: "2026-11-13T08:00:00Z" };
    const data = await collect(
      repo,
      { changeWindow: window, maxChangePages: 1 },
      evidenceQuery(page([recent], true, "next"), page([], false)),
      clock,
    );
    const evidence = data.changeEvidence!;
    expect(evidence.complete).toBe(false);
    expect(evidence.coverage[0]).toMatchObject({ source: "issues", complete: false, pages: 1 });
    expect(evidence.coverage[0]!.omission).toContain("page cap");
    expect(evidence.coverage[1]!.complete).toBe(true);
    expect(data.warnings.some((w) => w.includes("Change evidence incomplete"))).toBe(true);
    // Missing closure facts and truncated links are explicit unknowns.
    expect(evidence.subjects[0]!.unknown).toContain("links");
  });

  it("makes no history queries for a baseline or ordinary collection", async () => {
    const calls: string[] = [];
    const baseline = await collect(
      repo,
      { changeWindow: resolveWindow({ checkpoint: { through: null } }, clock) },
      evidenceQuery(page([]), page([]), calls),
      clock,
    );
    expect(baseline.changeEvidence).toMatchObject({ complete: true, subjects: [], coverage: [] });
    expect(baseline.since).toBeNull();
    const plain = await collect(repo, {}, evidenceQuery(page([]), page([]), calls), clock);
    expect(plain.changeEvidence).toBeUndefined();
    expect(calls.every((s) => s.includes("states:OPEN)"))).toBe(true);
    await expect(
      collect(
        repo,
        { since: t0, changeWindow: resolveWindow({}, clock) },
        evidenceQuery(page([]), page([])),
        clock,
      ),
    ).rejects.toThrow("either since");
  });

  it("treats legacy snapshots as unavailable history", () => {
    expect(snapshotChangeEvidence(snapshot())).toMatchObject({ available: false });
    const legacy = { ...snapshot(), changeEvidence: { schemaVersion: 2 } } as unknown as Snapshot;
    expect(snapshotChangeEvidence(legacy)).toMatchObject({
      available: false,
      reason: expect.stringContaining("unsupported"),
    });
  });
});
