import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argumentsFor,
  atomicJson,
  depsArgumentsFor,
  help as cliHelp,
  main,
  workflowArgumentsFor,
} from "../cli.js";
import { ticketDoctor, ticketDoctorText } from "./ticketdoctor.js";
import { shellQuote } from "./doctorplans.js";
import type { CorrectionStep } from "./doctorplans.js";
import type { Issue, PullRequest } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

describe("Ticket Doctor v1 (#66, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const t = (n: number, labels: string[], extra: Partial<Issue> = {}): Issue => ({
    ...issue(n, labels),
    updatedAt: at(1),
    ...extra,
  });
  const blockedBy = (urls: string[]) => ({
    issueDependenciesSummary: {
      blockedBy: urls.length,
      totalBlockedBy: urls.length,
      blocking: 0,
      totalBlocking: 0,
    },
    blockedBy: page(
      urls.map((url) => ({
        ...issue(Number(url.split("/").pop())),
        url,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      })),
    ),
  });
  const build = () => {
    const prOpen = pr();
    prOpen.number = 90;
    prOpen.state = "OPEN";
    prOpen.closingIssuesReferences = page([{ number: 7, url: issue(7).url }]);
    return snapshot(
      [
        t(1, ["bug", "status:ready"]), // clean
        t(2, ["enhancement"]), // unclaimed, no readiness
        t(3, ["bug", "status:ready", "status:parked"]), // two readiness labels
        t(4, ["status:ready", "urgency:high", "urgency:low"]), // urgency conflict, no classification
        t(5, ["bug", "status:ready", "question"]), // design conflict
        t(6, ["bug", "agent:ana", "agent:bo"]), // two owners
        t(7, ["bug", "status:ready"]), // open PR
        t(8, ["bug", "status:blocked"]), // blocked without reason
        t(9, ["bug", "agent:ana", "status:ready"], { updatedAt: at(30) }), // leftover + stale (24h)
        t(10, ["bug", "status:ready"], { body: "Depends on #1." }), // drift
        t(11, ["bug", "status:ready"], blockedBy([issue(12).url]) as Partial<Issue>),
        t(12, ["bug", "status:ready"], blockedBy([issue(11).url]) as Partial<Issue>), // cycle 11<->12
      ],
      [prOpen],
    );
  };
  const report = (options = {}) => ticketDoctor(build(), { now: new Date(time), ...options });
  const kinds = (r: ReturnType<typeof report>, n: number) =>
    r.tickets.find((x) => x.number === n)?.findings.map((f) => `${f.certainty}:${f.kind}`) ?? [];
  it("finds each structured inconsistency with its certainty, and leaves clean tickets out", () => {
    const r = report();
    expect(kinds(r, 1)).toEqual([]);
    expect(kinds(r, 2)).toEqual(["definite:readiness-missing"]);
    expect(kinds(r, 3)).toEqual(["definite:readiness-conflict"]);
    expect(kinds(r, 4)).toEqual(["definite:urgency-conflict", "candidate:classification-missing"]);
    expect(kinds(r, 5)).toEqual(["definite:design-conflict"]);
    // #413: unread activity makes several claims a candidate (they may be verified waiting).
    expect(kinds(r, 6)).toEqual(["definite:multiple-owners", "candidate:agent-multiple-claims"]);
    expect(kinds(r, 7)).toEqual(["definite:ready-with-open-pr"]);
    expect(kinds(r, 8)).toEqual(["definite:blocked-without-reason"]);
    expect(kinds(r, 9)).toEqual([
      "candidate:leftover-readiness",
      "candidate:agent-multiple-claims",
      "candidate:stale-agent-activity",
    ]);
    expect(kinds(r, 10)).toEqual(["candidate:dependency-drift"]);
    expect(kinds(r, 11)).toEqual(["definite:dependency-cycle"]);
    expect(kinds(r, 12)).toEqual(["definite:dependency-cycle"]);
  });
  it("judges an agent's several claims by their read activity, recovering only explicitly (#413)", () => {
    const activity = (six: string, nine: string) =>
      new Map([
        [
          "ana",
          new Map([
            [issue(6).url, { state: six, reason: "r6" }],
            [issue(9).url, { state: nine, reason: "r9" }],
          ]),
        ],
      ]);
    const both = report({ claimActivity: activity("active", "resume-required") });
    expect(kinds(both, 6)).toContain("definite:agent-multiple-active-claims");
    expect(kinds(both, 9)).toContain("definite:agent-multiple-active-claims");
    const finding = both.tickets
      .find((x) => x.number === 9)!
      .findings.find((f) => f.kind === "agent-multiple-active-claims")!;
    expect(JSON.stringify(finding)).toContain("pdb claim wait 9");
    // All but one verified waiting: valid, no multiple-claims finding at all.
    const valid = report({ claimActivity: activity("waiting", "active") });
    expect(kinds(valid, 6).filter((k) => k.includes("multiple-"))).toEqual([
      "definite:multiple-owners",
    ]);
    expect(kinds(valid, 9).some((k) => k.includes("multiple"))).toBe(false);
    // Unknown is never waiting: flagged with an inspection route.
    const unknown = report({ claimActivity: activity("waiting", "unknown") });
    expect(kinds(unknown, 9)).toContain("definite:claim-activity-unknown");
  });
  it("uses its own 24h staleness default, configurable, and bounds output with omitted counts", () => {
    expect(kinds(report({ staleHours: 48 }), 9)).not.toContain("candidate:stale-agent-activity");
    const small = report({ limit: 2 });
    expect(small.tickets).toHaveLength(2);
    expect(small.omittedTickets).toBe(small.summary.tickets - 2);
    expect(small.tickets.every((x) => x.findings[0].certainty === "definite")).toBe(true);
    expect(ticketDoctorText(small)).toContain("more tickets; raise --limit to see them");
  });
  const steps = (r: ReturnType<typeof report>, n: number, kind: string): CorrectionStep[] =>
    r.tickets.find((x) => x.number === n)?.findings.find((f) => f.kind === kind)?.plan.steps ?? [];
  /** Fill placeholders with sample values, then parse with the CLI's own argument parsers. */
  const parses = (s: CorrectionStep): void => {
    const sample: Record<string, string> = { "<YOUR_AGENT>": "me", "<DESIGNER>": "des" };
    const argv = s.argv.map((a) => sample[a] ?? a.replace(/<[A-Z_]+>/g, "text"));
    expect(argv[argv.indexOf("--repo") + 1]).toBe(repo);
    expect(s.command).toBe(shellQuote(s.argv));
    expect(s.command).not.toContain("#");
    if (argv[0] === "gh") {
      expect(s.kind).toBe("manual");
      expect(argv.slice(1, 4)).toEqual(["issue", "edit", argv[3]]);
      return;
    }
    expect(argv[0]).toBe("pdb");
    const [sub, ...rest] = argv.slice(1);
    if (sub === "release" || sub === "needs-human" || sub === "claim")
      expect(() => workflowArgumentsFor(sub, rest)).not.toThrow();
    else if (sub === "deps") expect(() => depsArgumentsFor(rest)).not.toThrow();
    else if (sub === "--issue") expect(() => argumentsFor(argv.slice(1))).not.toThrow();
    else expect(cliHelp).toContain(`  ${sub} `);
    expect(s.kind).toBe(
      sub === "release" || sub === "needs-human" || rest[0] === "add" || rest[0] === "remove"
        ? "command"
        : "inspect",
    );
  };
  it("v2 (#67): every finding has a plan of valid, deterministic, repo-scoped commands", () => {
    const r = report();
    expect(JSON.stringify(report())).toBe(JSON.stringify(r));
    for (const t of r.tickets)
      for (const f of t.findings) {
        expect(f.plan.steps.length).toBeGreaterThan(0);
        for (const s of f.plan.steps) {
          parses(s);
          expect(s.placeholders).toEqual([...new Set(s.argv.join(" ").match(/<[A-Z_]+>/g) ?? [])]);
          // Claim mutations are addressed only to an agent that holds the claim.
          if (s.argv[1] === "release") {
            const agent = s.argv[s.argv.indexOf("--agent") + 1];
            expect(t.findings.length && s.runBy).toBe(`agent ${agent} only (the claimant)`);
            expect(
              build()
                .issues.find((i) => i.number === t.number)!
                .labels.nodes.map((l) => l.name),
            ).toContain(`agent:${agent}`);
          }
        }
      }
    expect(ticketDoctorText(r)).toContain("judgment required; alternatives:");
    // Text output carries every step's description and preconditions, not just its command.
    const text = ticketDoctorText(r);
    for (const t of r.tickets)
      for (const f of t.findings)
        for (const s of f.plan.steps) {
          expect(text).toContain(s.description);
          for (const pre of s.preconditions) expect(text).toContain(`only if: ${pre}`);
        }
    expect(
      r.tickets.some((t) =>
        t.findings.some((f) => f.plan.steps.some((s) => s.preconditions.length)),
      ),
    ).toBe(true);
  });
  it("v2 (#67): alternatives for semantic choices, one suggestion for definite mechanics", () => {
    const r = report();
    const urgency = r.tickets.find((x) => x.number === 4)!.findings[0].plan;
    expect(urgency.judgment).toBe(true);
    expect(urgency.steps.map((s) => [s.choice, s.command])).toEqual([
      ["keep-high", `gh issue edit 4 --repo ${repo} --remove-label urgency:low`],
      ["keep-low", `gh issue edit 4 --repo ${repo} --remove-label urgency:high`],
      [
        "remove-both",
        `gh issue edit 4 --repo ${repo} --remove-label urgency:high --remove-label urgency:low`,
      ],
    ]);
    const openPr = r.tickets.find((x) => x.number === 7)!.findings[0].plan;
    expect(openPr.judgment).toBe(false);
    expect(openPr.steps.map((s) => s.command)).toEqual([
      `pdb who 7 --repo ${repo}`,
      `pdb --issue 7 --json --repo ${repo}`,
      `pdb pr 90 --repo ${repo}`,
      `gh issue edit 7 --repo ${repo} --add-label status:awaiting-review --remove-label status:ready`,
    ]);
    const cycle = r.tickets.find((x) => x.number === 11)!.findings[0].plan;
    expect(cycle.facts).toEqual(["Path (blocked by): #11 -> #12 -> #11"]);
    expect(cycle.steps.map((s) => s.command)).toEqual([
      `pdb deps 11 --tree --repo ${repo}`,
      `pdb deps remove 11 --on 12 --note '<WHY>' --repo ${repo}`,
    ]);
    expect(cycle.judgment).toBe(true);
    const owners = steps(r, 6, "multiple-owners").map((s) => s.choice);
    expect(owners).toEqual([undefined, "ana-releases", "bo-releases"]);
    const stale = r.tickets
      .find((x) => x.number === 9)!
      .findings.find((f) => f.kind === "stale-agent-activity")!.plan;
    expect(stale.facts[0]).toMatch(/^Last activity .* \(/);
    expect(stale.steps[0].command).toBe(`pdb who 9 --repo ${repo}`);
    expect(
      stale.steps
        .slice(1)
        .every((s) => s.preconditions[0].includes("Inactivity is not permission")),
    ).toBe(true);
    expect(steps(r, 8, "blocked-without-reason").map((s) => s.placeholders)).toEqual([
      [],
      ["<YOUR_AGENT>", "<DESIGNER>", "<WHY>", "<QUESTION>"],
      ["<REASON_LABEL>"],
    ]);
  });
  it("v2 (#67): unknown or incomplete evidence only ever gets inspection steps", () => {
    const old = t(20, ["bug", "status:ready"]) as Partial<Issue>;
    delete old.blockedBy;
    const partial = t(21, ["status:ready"]);
    partial.labels = { ...partial.labels, pageInfo: { hasNextPage: true } } as Issue["labels"];
    const r = ticketDoctor(snapshot([old as Issue, partial], []), { now: new Date(time) });
    for (const tk of r.tickets)
      for (const f of tk.findings.filter((x) => x.certainty === "unknown"))
        expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
    expect(steps(r, 21, "classification-missing").map((s) => s.kind)).toEqual(["inspect"]);
  });
  it("reports missing native evidence as unknown and runs offline from the CLI", async () => {
    const old = t(20, ["bug", "status:ready"]) as Partial<Issue>;
    delete old.blockedBy;
    const r = ticketDoctor(snapshot([old as Issue], []), { now: new Date(time) });
    expect(kinds(r, 20)).toEqual(["unknown:dependency-evidence-unknown"]);
    expect(r.completeness.complete).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), "triage-doctor-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, build());
      let out = "";
      const runtime = {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        now: () => new Date(time),
        doctor: {
          git: async () => {
            throw new Error("no checkout");
          },
        },
      };
      expect(
        await main(
          ["ticket-doctor", "--offline", "--cache", cache, "--json"],
          async (x) => void (out = x),
          runtime,
        ),
      ).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        kind: "ticket-doctor",
        schemaVersion: 1,
        scanned: 12,
        freshness: { offline: true },
      });
      let text = "";
      await main(
        ["ticket-doctor", "--offline", "--cache", cache],
        async (x) => void (text = x),
        runtime,
      );
      expect(text.split("\n")[0]).toMatch(/OFFLINE cache fetched .*not verified live/);
      for (const bad of [
        ["ticket-doctor", "--limit", "0"],
        ["ticket-doctor", "--stale-hours", "-1"],
        ["ticket-doctor", "--offline"],
      ])
        await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("Ticket Doctor review fixes", () => {
  it("reports every ticket on overlapping blocker cycles", async () => {
    const { blockerCycles } = await import("./ticketdoctor.js");
    // Blocked-by edges 1 -> 2, 1 -> 3, 2 -> 1, 3 -> 2: tickets 1, 2 and 3 are all on a cycle.
    const edges = new Map([
      ["1", ["2", "3"]],
      ["2", ["1"]],
      ["3", ["2"]],
      ["4", ["1"]],
    ]);
    expect(blockerCycles(edges)).toEqual([["1", "2", "3"]]);
    expect(blockerCycles(new Map([["5", ["5"]]]))).toEqual([["5"]]);
  });
  it("flags conflicting classification and awaiting-review without a PR; keeps absence unknown with partial labels", () => {
    const partialLabels = (names: string[]) => ({
      nodes: names.map((name) => ({ name })),
      pageInfo: { hasNextPage: true, endCursor: "x" },
    });
    const r = ticketDoctor(
      snapshot(
        [
          issue(30, ["bug", "enhancement", "status:ready"]),
          issue(32, ["bug", "status:awaiting-review", "agent:y"]),
          { ...issue(33, ["status:blocked"]), labels: partialLabels(["status:blocked"]) } as Issue,
          issue(34, ["bug", "status:ready"]),
        ],
        [],
      ),
      { now: new Date(time) },
    );
    const k = (n: number) =>
      r.tickets.find((t) => t.number === n)?.findings.map((f) => `${f.certainty}:${f.kind}`) ?? [];
    expect(k(30)).toEqual(["candidate:classification-conflict"]);
    expect(k(32)).toEqual(["candidate:awaiting-review-without-pr"]);
    expect(k(33)).toEqual([
      "unknown:labels-incomplete",
      // #245: impact label evidence is incomplete too (inspection only).
      "unknown:impact-labels-incomplete",
      "unknown:classification-missing",
      "unknown:blocked-without-reason",
    ]);
    expect(k(34)).toEqual([]);
    expect(r.completeness.complete).toBe(false);
  });
  const linkedPr = (n: number, issueNumber: number, extra: Partial<PullRequest> = {}) => {
    const p = { ...pr(), ...extra };
    p.number = n;
    p.url = `https://github.com/${repo}/pull/${n}`;
    p.state = "OPEN";
    p.closingIssuesReferences = page([{ number: issueNumber, url: issue(issueNumber).url }]);
    return p;
  };
  const planOf = (r: ReturnType<typeof ticketDoctor>, n: number, kind: string) =>
    r.tickets.find((t) => t.number === n)!.findings.find((f) => f.kind === kind)!.plan;
  it("claimed + pickup label + unfinished PR: keep-claim or release-when-finished, as a judgment", () => {
    const unfinished: [string, Partial<PullRequest>][] = [
      ["draft", { isDraft: true }],
      [
        "open thread",
        { reviewThreads: page([{ isResolved: false }]) as PullRequest["reviewThreads"] },
      ],
      ["pending checks", { commits: { nodes: [] } as unknown as PullRequest["commits"] }],
    ];
    for (const [why, extra] of unfinished) {
      const r = ticketDoctor(
        snapshot([issue(40, ["bug", "agent:ana", "status:ready"])], [linkedPr(91, 40, extra)]),
        { now: new Date(time) },
      );
      const plan = planOf(r, 40, "ready-with-open-pr");
      expect(plan.judgment, why).toBe(true);
      expect(plan.steps.map((s) => s.choice).filter(Boolean), why).toEqual(["keep-claim", "done"]);
      expect(plan.steps.find((s) => s.choice === "done")!.preconditions.join(" "), why).toContain(
        "Only once PR #91 is finished",
      );
    }
    // Even with a finished PR the outcome is the claimant's choice: both options, as a judgment,
    // and the done handoff carries no unfinished-PR precondition.
    const done = ticketDoctor(
      snapshot([issue(40, ["bug", "agent:ana", "status:ready"])], [linkedPr(91, 40)]),
      { now: new Date(time) },
    );
    const plan = planOf(done, 40, "ready-with-open-pr");
    expect(plan.judgment).toBe(true);
    expect(plan.steps.map((s) => s.choice).filter(Boolean)).toEqual(["keep-claim", "done"]);
    expect(plan.steps.find((s) => s.choice === "done")!.preconditions.join(" ")).not.toContain(
      "Only once",
    );
    // Without a claimant the awaiting-review fix stays a single mechanical step.
    const unclaimed = ticketDoctor(
      snapshot([issue(43, ["bug", "status:ready"])], [linkedPr(92, 43)]),
      { now: new Date(time) },
    );
    expect(planOf(unclaimed, 43, "ready-with-open-pr").judgment).toBe(false);
  });
  it("truncated labels or PR links: ownership/PR absence unknown, inspection-only plans", () => {
    const truncated = (n: number, names: string[]) =>
      ({
        ...issue(n, names),
        labels: { nodes: names.map((name) => ({ name })), pageInfo: { hasNextPage: true } },
      }) as Issue;
    const r = ticketDoctor(
      snapshot(
        [
          truncated(41, ["bug", "status:ready"]),
          truncated(42, ["bug", "agent:ana", "status:ready"]),
        ],
        [linkedPr(92, 41)],
      ),
      { now: new Date(time) },
    );
    const pickup = planOf(r, 41, "ready-with-open-pr");
    expect(pickup.steps.map((s) => s.kind)).toEqual(["inspect", "inspect", "inspect"]);
    expect(pickup.steps.map((s) => s.argv[1])).toEqual(["who", "--issue", "pr"]);
    expect(planOf(r, 42, "leftover-readiness").steps.every((s) => s.kind === "inspect")).toBe(true);
    const wide = linkedPr(93, 99);
    wide.closingIssuesReferences = {
      ...wide.closingIssuesReferences,
      pageInfo: { hasNextPage: true },
    } as PullRequest["closingIssuesReferences"];
    const r2 = ticketDoctor(
      snapshot([issue(43, ["bug", "status:awaiting-review", "agent:y"])], [wide]),
      { now: new Date(time) },
    );
    const f = r2.tickets[0].findings.find((x) => x.kind === "awaiting-review-without-pr")!;
    expect(f.certainty).toBe("unknown");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });
  it("does not flag ready tickets with open native blockers (ready when blockers close)", () => {
    const blocked = issue(35, ["bug", "status:ready"]);
    blocked.issueDependenciesSummary!.blockedBy = 1;
    blocked.issueDependenciesSummary!.totalBlockedBy = 1;
    blocked.blockedBy = page([
      {
        ...issue(36),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    expect(ticketDoctor(snapshot([blocked], []), { now: new Date(time) }).tickets).toEqual([]);
  });
});
