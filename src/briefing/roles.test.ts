import { describe, expect, it } from "vite-plus/test";
import { briefing } from "./briefing.js";
import { closingPrEvidence, pickupEligibility } from "./ranking.js";
import { ticketDoctor } from "../workflow/ticketdoctor.js";
import type { Issue, PullRequest, Snapshot } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

describe("role-shaped briefings (#1, doc/design/briefings.md)", () => {
  const compact = async (
    data: Snapshot,
    options: { limit: number; agent?: string; role?: string; platform?: string },
  ) => {
    const { compactBriefing } = await import("./compact.js");
    const expanded = briefing(data, { ...options, limit: 1000 }, new Date(time));
    return compactBriefing(data, options, expanded);
  };
  const numbers = (rows: { url: string }[]) => rows.map(({ url }) => Number(url.split("/").pop()));
  const section = (r: Awaited<ReturnType<typeof compact>>, name: string) =>
    r.role!.sections.find((s) => s.name === name)!;
  const blocking = (from: Issue, dependant: Issue): void => {
    from.issueDependenciesSummary!.blocking = 1;
    from.blocking = page([
      {
        number: dependant.number,
        title: dependant.title,
        url: dependant.url,
        state: dependant.state,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: dependant.issueDependenciesSummary!,
      },
    ]);
    dependant.issueDependenciesSummary!.blockedBy = 1;
    dependant.issueDependenciesSummary!.totalBlockedBy = 1;
  };

  it("leaves the briefing unchanged without --role", async () => {
    const data = snapshot([issue(1), issue(2)], []);
    const r = await compact(data, { limit: 5 });
    expect(r.role).toBeNull();
    expect(r.sections.available.total).toBe(2);
  });
  it("implementer orders addressed, PR follow-up, own work, then ranked pickup", async () => {
    const addressed = issue(10, ["status:needs-design", "attention:reader"]);
    const own = issue(11, ["agent:reader"]);
    const pickup = issue(12);
    const design = issue(13, ["status:needs-design"]);
    const failing = { ...pr(), closingIssuesReferences: page([]) };
    failing.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page([
      { name: "verify", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    const r = await compact(snapshot([addressed, own, pickup, design], [failing]), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(r.role!.question).toMatch(/implementation/);
    expect(numbers(r.role!.next)).toEqual([10, 4, 11, 12]);
    expect(r.actions.items.map((u) => Number(u.split("/").pop()))).toEqual([10, 4, 11, 12]);
    // Pending design is short background awareness, never a next step.
    expect(numbers(section(r, "pending-design").items)).toEqual([13]);
    expect(section(r, "pending-design").background).toBe(true);
    expect(section(r, "pickup").items[0]!.reason).toMatch(/Pickup rank 1/);
  });
  it("designer keeps addressed implementation questions visible and unblocks active work first", async () => {
    const addressed = issue(20, ["status:ready", "attention:reader"]);
    const idle = issue(21, ["design:decision-needed"]);
    const holding = issue(22, ["design:decision-needed"]);
    const claimed = issue(23, ["agent:other"]);
    blocking(holding, claimed);
    const documentation = issue(24, ["design:documentation-needed"]);
    const newDesign = issue(25, ["status:needs-design"]);
    const unlocked = issue(26);
    blocking(newDesign, unlocked);
    const quiet = issue(27, ["status:needs-design"]);
    const docsPr = {
      ...pr(),
      number: 40,
      url: `https://github.com/${repo}/pull/40`,
      labels: page([{ name: "documentation" }]),
      closingIssuesReferences: page([]),
    };
    const implPr = {
      ...pr(),
      number: 41,
      url: `https://github.com/${repo}/pull/41`,
      closingIssuesReferences: page([]),
      reviews: page([
        { body: "", url: "r1", author: null, state: "CHANGES_REQUESTED" },
        { body: "", url: "r2", author: null, state: "CHANGES_REQUESTED" },
      ]),
    };
    const r = await compact(
      snapshot(
        [addressed, idle, holding, claimed, documentation, quiet, newDesign, unlocked],
        [docsPr, implPr],
      ),
      { limit: 10, agent: "reader", role: "designer" },
    );
    expect(numbers(section(r, "addressed").items)).toEqual([20]);
    expect(numbers(section(r, "decision-needed").items)).toEqual([22, 21]);
    expect(section(r, "decision-needed").items[0]!.reason).toMatch(/Holds up active work #23/);
    expect(numbers(section(r, "documentation-needed").items)).toEqual([24]);
    expect(numbers(section(r, "design-review").items)).toEqual([40]);
    expect(numbers(section(r, "design-pickup").items)).toEqual([25, 27]);
    expect(section(r, "design-pickup").items[0]!.reason).toMatch(/unlocks 1 \(#26\)/);
    const impl = section(r, "implementation-prs");
    expect(impl.background).toBe(true);
    expect(impl.items[0]!.reason).toMatch(/possible design input/);
    // General implementation pickup is outside the designer view.
    expect(r.role!.sections.some((s) => s.name === "pickup")).toBe(false);
    expect(numbers(r.role!.next)).not.toContain(41);
  });
  it("bounds each section with omission counts and lists each subject once", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      issue(50 + i, ["design:decision-needed", "attention:reader"]),
    );
    const r = await compact(snapshot(many, []), { limit: 5, agent: "reader", role: "designer" });
    expect(section(r, "addressed")).toMatchObject({ total: 8, omitted: 0 });
    expect(section(r, "decision-needed").total).toBe(0);
    expect(r.actions).toMatchObject({ total: 8, omitted: 3 });
  });
  it("keeps PRs with only verification or merge-state findings visible but not actionable", async () => {
    const unverified = { ...pr(), closingIssuesReferences: page([]) };
    unverified.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes[0]!.name = "unrelated";
    const behind = {
      ...pr(),
      number: 5,
      url: `https://github.com/${repo}/pull/5`,
      closingIssuesReferences: page([]),
      mergeStateStatus: "BEHIND",
      // Approved on the current head, so BEHIND is an integration action (#182 S9).
      reviews: page([
        {
          body: "",
          url: "https://example.test/review",
          author: { login: "reviewer" },
          state: "APPROVED",
          submittedAt: time,
          commit: { oid: "abc123" },
        },
      ]),
    };
    const data = snapshot([issue(1)], [unverified, behind]);
    const r = await compact(data, { limit: 10, agent: "reader", role: "implementer" });
    const waiting = section(r, "pr-waiting");
    expect(numbers(waiting.items)).toEqual([4]);
    expect(waiting.background).toBe(true);
    expect(waiting.items[0]!.reason).toMatch(/verify not proven/);
    // An accepted PR that is only BEHIND is an integration action, not waiting (#182 S9).
    expect(numbers(section(r, "pr-follow-up").items)).toEqual([5]);
    expect(section(r, "pr-follow-up").items[0]!.reason).toMatch(/merge state is BEHIND/);
    expect(numbers(r.role!.next)).not.toContain(4);
    // No PR in the non-role compact output silently vanishes from a role view.
    const plain = await compact(data, { limit: 10, agent: "reader" });
    const plainPrs = new Set(
      [...plain.actions.items, ...Object.values(plain.sections).flatMap((s) => s.items)].filter(
        (url) => url.includes("/pull/"),
      ),
    );
    expect(plainPrs.size).toBe(2);
    for (const role of ["implementer", "designer"]) {
      const view = await compact(data, { limit: 10, agent: "reader", role });
      const shown = new Set(view.role!.sections.flatMap((s) => s.items.map((row) => row.url)));
      for (const url of plainPrs) expect(shown.has(url), `${role} ${url}`).toBe(true);
    }
  });
  it("designer new design work excludes tickets with an open closing PR", async () => {
    const covered = issue(70, ["status:needs-design"]);
    const fresh = issue(71, ["status:needs-design"]);
    const docsPr = {
      ...pr(),
      number: 72,
      url: `https://github.com/${repo}/pull/72`,
      closingIssuesReferences: page([{ number: 70, url: covered.url }]),
    };
    const r = await compact(snapshot([covered, fresh], [docsPr as PullRequest]), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(section(r, "design-pickup").items)).toEqual([71]);
    expect(numbers(section(r, "design-review").items)).toEqual([72]);
  });
  it("implementer active work excludes parked items unless addressed", async () => {
    const parked = issue(80, ["agent:reader", "status:parked"]);
    const active = issue(81, ["agent:reader"]);
    const r = await compact(snapshot([parked, active], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(section(r, "own-work").items)).toEqual([81]);
    expect(numbers(r.role!.next)).not.toContain(80);
    const addressed = issue(80, ["agent:reader", "status:parked", "attention:reader"]);
    const a = await compact(snapshot([addressed, active], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(r.role!.next)).not.toContain(80);
    expect(numbers(a.role!.next)).toContain(80);
  });
  it("excludes parked design work from new design pickup unless addressed", async () => {
    const parked = issue(100, ["status:needs-design", "status:parked"]);
    const fresh = issue(101, ["status:needs-design"]);
    const r = await compact(snapshot([parked, fresh], []), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(section(r, "design-pickup").items)).toEqual([101]);
    expect(numbers(r.role!.next)).not.toContain(100);
    // Still visible as background context, never silently dropped.
    expect(numbers(section(r, "other-context").items)).toContain(100);
    const addressed = issue(100, ["status:needs-design", "status:parked", "attention:reader"]);
    const a = await compact(snapshot([addressed, fresh], []), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(a.role!.next)).toContain(100);
  });
  it("applies the parked guard centrally to every foreground role section", async () => {
    const { roleView, sectionSelectors } = await import("./roles.js");
    const parked = issue(102, ["agent:reader", "status:parked"]);
    const data = snapshot([parked], []);
    const r = await compact(data, { limit: 10, agent: "reader" });
    // A selector that ignores parking still cannot promote a parked ticket to a next step.
    sectionSelectors.set("own-work-unguarded", ({ byUrl }) =>
      [...byUrl.keys()].map((url) => ({ url, reason: "test" })),
    );
    const { roleRegistry } = await import("./roles.js");
    roleRegistry.set("probe", {
      question: "probe",
      sections: [{ section: "own-work-unguarded", title: "PROBE", budget: 5 }],
    });
    try {
      const view = roleView("probe", {
        snapshot: data,
        facts: briefing(data, { limit: 1000, agent: "reader" }, new Date(time)),
        findings: new Map(),
        byUrl: new Map([[parked.url, parked]]),
        isAddressed: () => false,
        isMine: () => true,
        linkedMine: () => true,
        baseline: new Map([[parked.url, "Parked; not a next step."]]),
      });
      expect(view.next).toEqual([]);
      expect(numbers(view.sections.at(-1)!.items)).toEqual([102]);
    } finally {
      roleRegistry.delete("probe");
      sectionSelectors.delete("own-work-unguarded");
    }
    expect(r.role).toBeNull();
  });
  it("populates unblock candidates from the real dependency rule", async () => {
    const blocker = issue(110, ["agent:other"]);
    const waiting = issue(111);
    blocking(blocker, waiting);
    const r = await compact(snapshot([blocker, waiting], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(section(r, "unblock-candidates").items)).toEqual([111]);
    expect(section(r, "unblock-candidates").items[0]!.reason).toMatch(/native blockers close/);
  });
  it("never cuts addressed attention by a fixed cap", async () => {
    const many = Array.from({ length: 14 }, (_, i) => issue(120 + i, ["attention:reader"]));
    const r = await compact(snapshot(many, []), { limit: 5, agent: "reader", role: "designer" });
    expect(section(r, "addressed")).toMatchObject({ total: 14, omitted: 0 });
    expect(section(r, "addressed").items).toHaveLength(14);
  });
  it("respects platform restrictions on new design work", async () => {
    const codex = issue(140, ["status:needs-design", "platform:codex"]);
    const open = issue(141, ["status:needs-design"]);
    const data = snapshot([codex, open], []);
    const other = await compact(data, {
      limit: 10,
      agent: "reader",
      role: "designer",
      platform: "ori",
    });
    expect(numbers(section(other, "design-pickup").items)).toEqual([141]);
    expect(numbers(other.role!.next)).not.toContain(140);
    const match = await compact(data, {
      limit: 10,
      agent: "reader",
      role: "designer",
      platform: "codex",
    });
    expect(numbers(section(match, "design-pickup").items)).toEqual([140, 141]);
    const unknown = await compact(data, { limit: 10, agent: "reader", role: "designer" });
    expect(numbers(section(unknown, "design-pickup").items)).toEqual([141]);
    expect(numbers(section(unknown, "design-pickup-inspect").items)).toEqual([140]);
    expect(section(unknown, "design-pickup-inspect").background).toBe(true);
    expect(numbers(unknown.role!.next)).not.toContain(140);
  });
  it("keeps pickup-unverified tickets visible for inspection", async () => {
    const restricted = issue(150, ["status:ready", "platform:codex"]);
    const r = await compact(snapshot([restricted], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    const inspect = section(r, "pickup-inspect");
    expect(numbers(inspect.items)).toEqual([150]);
    expect(inspect.background).toBe(true);
    expect(inspect.items[0]!.reason).toMatch(/eligibility unknown/);
    expect(numbers(r.role!.next)).not.toContain(150);
  });
  it("never offers pickup whose only open closing PR has truncated closing references (#162)", async () => {
    const ticket = issue(170);
    // PR #4 closes #170, but the reference falls on an unseen page of its closing references.
    const truncated = { ...pr(), closingIssuesReferences: page([], true, "next") };
    const evidence = closingPrEvidence(ticket, [truncated]);
    expect(evidence).toMatchObject({ open: [], complete: false });
    expect(pickupEligibility(ticket, { prs: [truncated] })).toMatchObject({ status: "unknown" });
    const r = await compact(snapshot([ticket], [truncated]), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(r.role!.sections.find((s) => s.name === "pickup")?.items ?? []).toEqual([]);
    const inspect = section(r, "pickup-inspect");
    expect(numbers(inspect.items)).toEqual([170]);
    expect(inspect.items[0]!.reason).toMatch(/closing references truncated on open PR #4/);
    expect(numbers(r.role!.next)).not.toContain(170);
    // Design pickup shares the rule: unproven absence is not design pickup either.
    const design = issue(171, ["status:needs-design"]);
    const d = await compact(snapshot([design], [truncated]), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(d.role!.sections.find((s) => s.name === "design-pickup")?.items ?? []).toEqual([]);
    // ...but it stays visible as inspection, with the evidence reason, not generic context.
    const designInspect = section(d, "design-pickup-inspect");
    expect(numbers(designInspect.items)).toEqual([171]);
    expect(designInspect.items[0]!.reason).toMatch(/open closing PR cannot be ruled out/);
    expect(designInspect.items[0]!.reason).toMatch(/closing references truncated on open PR #4/);
    expect(numbers(d.role!.next)).not.toContain(171);
  });
  it("proves no open closing PR from the issue's complete reverse link despite truncation (#162)", async () => {
    const truncated = { ...pr(), closingIssuesReferences: page([], true, "next") };
    const proven = { ...issue(172), closedByPullRequestsReferences: page([]) };
    expect(closingPrEvidence(proven, [truncated])).toEqual({
      open: [],
      complete: true,
      reasons: [],
    });
    expect(pickupEligibility(proven, { prs: [truncated] }).status).toBe("eligible");
    // A complete reverse link naming an open PR stays known-ineligible.
    const linked = {
      ...issue(173),
      closedByPullRequestsReferences: page([{ number: 4, url: truncated.url, state: "OPEN" }]),
    };
    expect(pickupEligibility(linked, { prs: [truncated] })).toMatchObject({
      status: "ineligible",
      reasons: ["open closing PR #4 (PR follow-up)"],
    });
    // A truncated reverse link cannot prove absence either.
    const partial = { ...issue(174), closedByPullRequestsReferences: page([], true) };
    expect(pickupEligibility(partial, { prs: [truncated] }).status).toBe("unknown");
    // Ticket Doctor rests "no open PR" on the same rule.
    const waiting = { ...issue(175, ["status:awaiting-review"]) };
    const findings = (prs: PullRequest[]) =>
      ticketDoctor(snapshot([waiting], prs), { now: new Date(time) })
        .tickets.flatMap((t) => t.findings)
        .filter((f) => f.kind === "awaiting-review-without-pr")
        .map((f) => f.certainty);
    expect(findings([truncated])).toEqual(["unknown"]);
    const reverseProof = { ...waiting, closedByPullRequestsReferences: page([]) };
    expect(
      ticketDoctor(snapshot([reverseProof], [truncated]), { now: new Date(time) })
        .tickets.flatMap((t) => t.findings)
        .filter((f) => f.kind === "awaiting-review-without-pr")
        .map((f) => f.certainty),
    ).toEqual(["candidate"]);
  });
  it("shows every issue and PR from the non-role briefing somewhere in each role", async () => {
    const holder = issue(160, ["agent:other"]);
    const waiting = issue(161);
    blocking(holder, waiting);
    const items = [
      issue(162),
      issue(163, ["status:parked"]),
      issue(164, ["agent:reader"]),
      issue(165, ["agent:other", "status:parked"]),
      issue(166, ["status:needs-design", "platform:codex"]),
      issue(167, ["status:ready", "platform:codex"]),
      issue(168, ["design:decision-needed", "agent:other"]),
      issue(169, ["status:blocked"]),
      holder,
      waiting,
    ];
    const data = snapshot(items, [{ ...pr(), closingIssuesReferences: page([]) }]);
    const plain = await compact(data, { limit: 50, agent: "reader" });
    const all = new Set([
      ...plain.actions.items,
      ...Object.values(plain.sections).flatMap((s) => s.items),
    ]);
    expect([...all].some((url) => url.includes("/issues/"))).toBe(true);
    for (const role of ["implementer", "designer"]) {
      const view = await compact(data, { limit: 50, agent: "reader", role });
      const shown = new Set(view.role!.sections.flatMap((s) => s.items.map((row) => row.url)));
      // Anything not placed is in OTHER CONTEXT, bounded with an explicit omission count.
      const missing = [...all].filter((url) => !shown.has(url));
      expect(missing.length, role).toBe(section(view, "other-context").omitted);
    }
  });
  it("renders the role in text and rejects unknown roles", async () => {
    const { compactText } = await import("./compact.js");
    const r = await compact(snapshot([issue(60)], []), { limit: 5, role: "implementer" });
    const text = compactText(r);
    expect(text).toMatch(/Role implementer: What action advances implementation most\?/);
    expect(text).toMatch(/\nPICKUP \(1\)/);
    expect(text).not.toMatch(/\nAVAILABLE/);
    const { argumentsFor } = await import("../cli.js");
    expect(() => argumentsFor(["--role", "owner"])).toThrow(/implementer, designer/);
    expect(() => argumentsFor(["--role", "designer", "--full"])).toThrow(/--full/);
    expect(argumentsFor(["--role=designer"]).role).toBe("designer");
  });
});
