import { describe, expect, it } from "vite-plus/test";
import { argumentsFor } from "../cli.js";
import { briefing } from "./briefing.js";
import type { Issue, PullRequest, Snapshot } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";
import { brief } from "../testing/briefing.js";

describe("next-action ranking (#45, doc/design/briefings.md acceptance examples)", () => {
  const at = (item: Issue, createdAt: string): Issue => ({ ...item, createdAt });
  const blocks = (from: Issue, dependants: Issue[]): void => {
    from.issueDependenciesSummary!.blocking = dependants.length;
    from.issueDependenciesSummary!.totalBlocking = dependants.length;
    from.blocking = page(
      dependants.map((d) => ({
        number: d.number,
        title: d.title,
        url: d.url,
        state: d.state,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: d.issueDependenciesSummary!,
      })),
    );
  };
  const blockedBy = (item: Issue, count: number): Issue => {
    item.issueDependenciesSummary!.blockedBy = count;
    item.issueDependenciesSummary!.totalBlockedBy = count;
    return item;
  };
  const compact = async (data: Snapshot, options: Parameters<typeof briefing>[1]) => {
    const { compactBriefing } = await import("./compact.js");
    const expanded = briefing(data, { ...options, limit: 1000 }, new Date(time));
    return compactBriefing(data, options, expanded);
  };
  const numbers = (urls: string[]) => urls.map((url) => Number(url.split("/").pop()));

  it("addressed low-urgency work precedes high-urgency pickup", async () => {
    const addressed = issue(10, ["status:ready", "urgency:low", "attention:reader"]);
    const urgent = issue(11, ["status:ready", "urgency:high"]);
    const r = await compact(snapshot([urgent, addressed], []), { limit: 5, agent: "reader" });
    expect(numbers(r.actions.items).slice(0, 2)).toEqual([10, 11]);
  });
  it("a ready ticket with an open closing PR appears once, as PR follow-up", async () => {
    const r = await compact(snapshot([issue(1)], [pr()]), { limit: 5 });
    expect(r.sections.available.items).toEqual([]);
    expect(r.actions.items).toEqual([pr().url]);
  });
  it("awaiting review is a consistent readiness state but never implementation pickup (#62)", () => {
    const waiting = issue(22, ["status:awaiting-review"]);
    const r = brief(snapshot([waiting], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([]);
    expect(r.actions.items.some((a) => a.rule === "readiness-inconsistent")).toBe(false);
  });
  it("prefers released incomplete work over unstarted work on an impact tie", () => {
    const ready = issue(20, ["status:ready"]);
    const incomplete = issue(21, ["status:incomplete"]);
    const r = brief(snapshot([ready, incomplete], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([21, 20]);
    expect(r.actions.items.some((a) => a.rule === "readiness-inconsistent")).toBe(false);
  });
  it("counts only dependants that become otherwise eligible, not ones with another blocker", () => {
    const shared = issue(30);
    const lastBlocker = issue(31);
    const twoBlockers = [blockedBy(issue(32), 2), blockedBy(issue(33), 2)];
    const unlocked = blockedBy(issue(34), 1);
    const needsDesign = blockedBy(issue(35, ["status:ready", "status:needs-design"]), 1);
    blocks(shared, [...twoBlockers, needsDesign]);
    blocks(lastBlocker, [unlocked]);
    const r = brief(snapshot([shared, lastBlocker, ...twoBlockers, unlocked, needsDesign], []));
    const ranked = r.ready.items.map((i) => [i.number, i.unlocks]);
    expect(ranked).toEqual([
      [31, [34]],
      [30, []],
    ]);
  });
  it("does not count a dependant whose own native dependency evidence is missing", () => {
    const blocker = issue(36);
    const unknown = blockedBy(issue(37), 1);
    delete (unknown as Partial<Issue>).blockedBy;
    blocks(blocker, [unknown]);
    const r = brief(snapshot([blocker, unknown], []));
    expect(r.ready.items.map((i) => [i.number, i.unlocks])).toEqual([[36, []]]);
  });
  it("non-role briefing does not rank a ticket unlocking only unready work above a real unlock (#208)", async () => {
    // Same rule and priority; the URL tie-break alone would put #60 first.
    const designOnly = issue(60, ["status:needs-design"]);
    const realUnlock = issue(61, ["status:needs-design"]);
    const unready = blockedBy(issue(62, ["status:ready", "status:needs-design"]), 1);
    const ready = blockedBy(issue(63), 1);
    blocks(designOnly, [unready]);
    blocks(realUnlock, [ready]);
    const data = snapshot([designOnly, realUnlock, unready, ready], []);
    const expanded = brief(data);
    const order = numbers(
      expanded.actions.items
        .filter((a) => [designOnly.url, realUnlock.url].includes(a.target))
        .map((a) => a.target),
    ).filter((n, i, all) => all.indexOf(n) === i);
    expect(order).toEqual([61, 60]);
    const r = await compact(data, { limit: 20 });
    expect(numbers(r.actions.items).filter((n) => n === 60 || n === 61)).toEqual([61, 60]);
  });
  it("a truncated blocking list gives unknown impact, never a definite count (#208)", () => {
    const blocker = issue(64);
    const ready = blockedBy(issue(65), 1);
    blocks(blocker, [ready]);
    blocker.issueDependenciesSummary!.totalBlocking = 150;
    blocker.blocking!.pageInfo = { hasNextPage: true, endCursor: "c" };
    const r = brief(snapshot([blocker, ready], []));
    const item = r.ready.items.find((i) => i.number === 64)!;
    expect(item.unlocks).toEqual([65]);
    expect(item.unlocksUnknown).toEqual(["dependant list truncated (1 of 150 seen)"]);
    expect(item.rankReason).toMatch(
      /unlocks at least 1 \(#65\); impact unknown: dependant list truncated/,
    );
  });
  it("a dependant with unknown eligibility gives unknown impact, not zero (#208)", () => {
    const blocker = issue(71);
    const restricted = blockedBy(issue(72, ["status:ready", "platform:codex"]), 1);
    blocks(blocker, [restricted]);
    const data = snapshot([blocker, restricted], []);
    const unknown = briefing(data, { limit: 100 }, new Date(time)).ready.items.find(
      (i) => i.number === 71,
    )!;
    expect(unknown.unlocks).toEqual([]);
    expect(unknown.unlocksUnknown).toEqual([
      "dependant example/project#72: restricted to platform codex; viewer platform unknown (state --platform)",
    ]);
    const match = briefing(
      data,
      { limit: 100, platform: "codex" },
      new Date(time),
    ).ready.items.find((i) => i.number === 71)!;
    expect(match.unlocks).toEqual([72]);
    expect(match.unlocksUnknown).toEqual([]);
  });
  it("a cross-repository dependant gives unknown impact (#208)", () => {
    const blocker = issue(66);
    const elsewhere = blockedBy(issue(67), 1);
    blocks(blocker, [elsewhere]);
    blocker.blocking!.nodes[0] = {
      ...blocker.blocking!.nodes[0]!,
      url: "https://github.com/other/place/issues/67",
      repository: { nameWithOwner: "other/place" },
    };
    const r = brief(snapshot([blocker], []));
    const item = r.ready.items.find((i) => i.number === 66)!;
    expect(item.unlocks).toEqual([]);
    expect(item.unlocksUnknown).toEqual(["dependant other/place#67 not in this snapshot"]);
    expect(item.rankReason).toMatch(
      /unlocks at least 0; impact unknown: dependant other\/place#67/,
    );
    // Unknown never ranks below zero: it ties with a known-zero ticket and falls to age/number.
    const zero = issue(68);
    const tied = brief(snapshot([zero, blocker], []));
    expect(tied.ready.items.map((i) => i.number)).toEqual([66, 68]);
    // ...and never outranks a known positive count.
    const positive = issue(69);
    const unlocked = blockedBy(issue(70), 1);
    blocks(positive, [unlocked]);
    const ranked = brief(snapshot([blocker, positive, unlocked], []));
    expect(ranked.ready.items.map((i) => i.number).slice(0, 2)).toEqual([69, 66]);
  });
  it("role and non-role views order the same tickets identically by impact (#208)", async () => {
    const none = issue(71, ["status:needs-design"]);
    const two = issue(72, ["status:needs-design"]);
    const one = issue(73, ["status:needs-design"]);
    const unready = blockedBy(issue(74, ["status:ready", "status:needs-design"]), 1);
    const a = blockedBy(issue(75), 1);
    const b = blockedBy(issue(76), 1);
    const c = blockedBy(issue(77), 1);
    blocks(none, [unready]);
    blocks(two, [a, b]);
    blocks(one, [c]);
    const data = snapshot([none, two, one, unready, a, b, c], []);
    const targets = [none.url, two.url, one.url];
    const { compactBriefing } = await import("./compact.js");
    const role = compactBriefing(
      data,
      { limit: 20, agent: "reader", role: "designer" },
      briefing(data, { limit: 1000, agent: "reader" }, new Date(time)),
    );
    const roleOrder = numbers(
      role.role!.sections.find((s) => s.name === "design-pickup")!.items.map((i) => i.url),
    ).filter((n) => [71, 72, 73].includes(n));
    const plain = await compact(data, { limit: 20 });
    const plainOrder = numbers(plain.actions.items.filter((u) => targets.includes(u)));
    expect(roleOrder).toEqual([72, 73, 71]);
    expect(plainOrder).toEqual(roleOrder);
  });
  it("oldest mode orders by creation time alone, keeping urgency and impact visible", () => {
    const oldLow = at(issue(40, ["status:ready", "urgency:low"]), "2026-01-01T00:00:00Z");
    const newHigh = at(issue(41, ["status:ready", "urgency:high"]), "2026-06-01T00:00:00Z");
    const data = snapshot([newHigh, oldLow], []);
    const oldest = briefing(data, { limit: 100, order: "oldest" }, new Date(time));
    expect(oldest.ready.items.map((i) => i.number)).toEqual([40, 41]);
    expect(oldest.ready.items[1].urgency).toBe("high");
    expect(oldest.ready.items[0].rankReason).toMatch(/oldest-first .*urgency low/);
    const newest = briefing(data, { limit: 100, order: "newest" }, new Date(time));
    expect(newest.ready.items.map((i) => i.number)).toEqual([41, 40]);
    expect(brief(data).ready.items.map((i) => i.number)).toEqual([41, 40]);
  });
  it("unknown platform or native evidence never becomes pickup", () => {
    const restricted = issue(50, ["status:ready", "platform:codex", "platform:ori"]);
    const missing = issue(51) as Partial<Issue>;
    delete missing.blockedBy;
    const data = snapshot([restricted, missing as Issue], []);
    const unknown = brief(data);
    expect(unknown.ready.total).toBe(0);
    expect(unknown.actions.items.find((a) => a.target === restricted.url)?.rule).toBe(
      "pickup-unverified",
    );
    const match = briefing(data, { limit: 100, platform: "ori" }, new Date(time));
    expect(match.ready.items.map((i) => i.number)).toEqual([50]);
    const mismatch = briefing(data, { limit: 100, platform: "claude-code" }, new Date(time));
    expect(mismatch.ready.total).toBe(0);
    expect(mismatch.actions.items.some((a) => a.rule === "pickup-unverified")).toBe(false);
  });
  it("breaks exact ties by numeric identity, not text (#14 before #100)", () => {
    const r = brief(snapshot([issue(100), issue(14)], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([14, 100]);
  });
  it("treats pending CI as waiting, behind own work and pickup", async () => {
    const waiting = pr();
    waiting.closingIssuesReferences = page([]);
    waiting.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [
      { name: "verify", status: "IN_PROGRESS" },
    ];
    const r = await compact(snapshot([issue(2, ["agent:reader"]), issue(3)], [waiting]), {
      limit: 5,
      agent: "reader",
    });
    expect(numbers(r.actions.items)).toEqual([2, 3, 4]);
    const rules = r.subjects.find((s) => s.url === waiting.url)!.findings.map((f) => f.rule);
    expect(rules).not.toContain("pr-failed-checks");
    expect(rules).not.toContain("pr-inspect-merge");
  });
  it("puts actionable PR follow-up before own active work, own PRs first", async () => {
    const failing = (number: number, closes: Issue[]): PullRequest => {
      const pull = { ...pr(), number, url: `https://github.com/${repo}/pull/${number}` };
      pull.closingIssuesReferences = page(closes.map((i) => ({ number: i.number, url: i.url })));
      pull.commits = {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: page([{ name: "verify", conclusion: "FAILURE" }]),
              },
            },
          },
        ],
      };
      return pull;
    };
    const mine = issue(5, ["agent:reader"]);
    const owned = issue(6, ["agent:reader"]);
    const r = await compact(snapshot([mine, owned], [failing(90, []), failing(91, [mine])]), {
      limit: 5,
      agent: "reader",
    });
    expect(numbers(r.actions.items)).toEqual([91, 90, 5, 6]);
  });
  it("flags claims stale after two days of ticket/linked-PR inactivity, never releasing them", () => {
    const old = at(issue(60, ["agent:bo"]), "2026-11-01T00:00:00Z");
    old.updatedAt = "2026-11-09T00:00:00Z";
    const fresh = issue(61, ["agent:bo"]);
    const r = brief(snapshot([old, fresh], []));
    const stale = r.actions.items.filter((a) => a.rule === "stale-claim");
    expect(stale.map((a) => a.target)).toEqual([old.url]);
    expect(stale[0].next).toContain("Never auto-release");
    const relaxed = briefing(snapshot([old], []), { limit: 100, staleHours: 200 }, new Date(time));
    expect(relaxed.actions.items.some((a) => a.rule === "stale-claim")).toBe(false);
  });
  it("validates --order, --platform and --stale-hours", () => {
    expect(argumentsFor(["--order", "oldest", "--platform", "codex"])).toMatchObject({
      order: "oldest",
      platform: "codex",
    });
    expect(argumentsFor([]).order).toBe("impact");
    expect(() => argumentsFor(["--order", "urgent"])).toThrow("--order must be one of");
    expect(() => argumentsFor(["--stale-hours", "0"])).toThrow("--stale-hours");
  });
});
