import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, main } from "../cli.js";
import { teamText, teamView } from "./team.js";
import type { Issue } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

describe("team view (#41, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const ticket = (
    n: number,
    labels: string[],
    hoursAgo = 1,
    extra: Partial<Issue> = {},
  ): Issue => ({
    ...issue(n, labels),
    updatedAt: at(hoursAgo),
    ...extra,
  });
  const build = () => {
    const prFor1 = pr();
    prFor1.number = 40;
    prFor1.url = `https://github.com/${repo}/pull/40`;
    prFor1.updatedAt = at(0.5);
    prFor1.closingIssuesReferences = page([{ number: 1, url: issue(1).url }]);
    prFor1.reviewThreads = page([
      { isResolved: false, isOutdated: false, comments: page([]) },
    ] as never);
    return snapshot(
      [
        ticket(1, ["agent:ana"], 1),
        ticket(2, ["agent:ana", "status:ready"], 100),
        ticket(3, ["agent:bo", "agent:ana", "meta"], 2, { title: "Umbrella: everything" }),
        ticket(4, ["agent:cy", "status:needs-design"], 3),
        // Comment text is not a claim; only labels are.
        ticket(5, ["status:ready"], 1, {
          comments: page([
            {
              body: "Picked up by dee",
              url: "u",
              author: { login: "x" },
              createdAt: at(1),
              updatedAt: at(1),
            },
          ]),
        } as Partial<Issue>),
      ],
      [prFor1],
    );
  };
  it("groups claims by agent with linked PR state and latest activity, from labels only", () => {
    const view = teamView(build(), { now: new Date(time) });
    expect(view.agents.map((a) => a.agent)).toEqual(["ana", "bo", "cy"]);
    const ana = view.agents[0];
    expect(ana.claims.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(ana.claims[0].pullRequests[0]).toMatchObject({
      number: 40,
      verify: "SUCCESS",
      unresolvedThreads: 1,
    });
    expect(ana.claims[0].latestActivity!.source).toBe("PR #40 updated");
    expect(view.agents.flatMap((a) => a.claims).some((c) => c.number === 5)).toBe(false);
    expect(view.presence).toMatch(/^unknown/);
  });
  it("separates definite violations from candidates", () => {
    const view = teamView(build(), { now: new Date(time) });
    const ana = view.agents.find((a) => a.agent === "ana")!;
    // #413: without activity, several claims are not a definite violation (they may be waiting).
    expect(ana.warnings.filter((w) => w.certainty === "definite")).toEqual([]);
    expect(ana.warnings.find((w) => w.kind === "multiple-claims")).toMatchObject({
      certainty: "candidate",
    });
    expect(view.conflicts).toEqual([{ number: 3, url: issue(3).url, agents: ["bo", "ana"] }]);
    const details = ana.warnings
      .filter((w) => w.certainty === "candidate")
      .map((w) => `#${w.ticket} ${w.detail}`);
    expect(
      details.some((d) => d.startsWith("#2 stale candidate: no evidenced activity for 100h")),
    ).toBe(true);
    expect(details).toContain("#2 claimed but still labelled status:ready");
    expect(details.some((d) => d.startsWith("#3 umbrella candidate"))).toBe(true);
    const cy = view.agents.find((a) => a.agent === "cy")!;
    expect(cy.warnings.map((w) => w.detail)).toEqual(["claimed while status:needs-design"]);
    expect(
      teamView(build(), { now: new Date(time), staleHours: 200 }).agents[0].warnings.some((w) =>
        /stale/.test(w.detail),
      ),
    ).toBe(false);
    const text = teamText(view);
    expect(text).toContain("ana: 3 claims");
    expect(text).toContain("CONFLICT: also claimed by bo");
  });
  it("judges several claims by their read activity (#413)", () => {
    const urls = teamView(build(), { now: new Date(time) })
      .agents.find((a) => a.agent === "ana")!
      .claims.map((c) => c.url);
    const read = (states: string[]) =>
      teamView(build(), {
        now: new Date(time),
        activity: new Map([
          ["ana", new Map(urls.map((u, i) => [u, { state: states[i]!, reason: `r${i}` }]))],
        ]),
      }).agents.find((a) => a.agent === "ana")!;
    // All but one verified waiting: a review reminder, not a violation.
    const valid = read(["waiting", "active", "waiting"]);
    expect(valid.warnings.filter((w) => w.certainty === "definite")).toEqual([]);
    expect(valid.warnings.find((w) => w.kind === "retained-claims")?.detail).toContain(
      "all but one verified waiting",
    );
    const released = read(["active", "not-owned", "not-owned"]);
    expect(released.warnings.map((w) => w.kind)).not.toContain("retained-claims");
    expect(released.warnings.map((w) => w.kind)).not.toContain("multiple-active-claims");
    const twoRetained = read(["waiting", "not-owned", "active"]);
    const review = twoRetained.warnings.find((w) => w.kind === "retained-claims");
    expect(review?.detail).toContain("2 retained claims");
    expect(review?.detail).not.toContain(`#${twoRetained.claims[1]!.number}`);
    expect(valid.claims[0]!.activity).toEqual({ state: "waiting", reason: "r0" });
    // Two not waiting: a definite contradiction with explicit, non-automatic recovery.
    const two = read(["active", "resume-required", "waiting"]);
    const contradiction = two.warnings.find((w) => w.kind === "multiple-active-claims");
    expect(contradiction?.certainty).toBe("definite");
    expect(contradiction?.detail).toContain("Nothing is released automatically");
    // Unknown is never waiting: it counts as not waiting and is flagged itself.
    const unknown = read(["waiting", "unknown", "waiting"]);
    expect(unknown.warnings.map((w) => w.kind)).toContain("claim-activity-unknown");
    expect(unknown.warnings.map((w) => w.kind)).not.toContain("multiple-active-claims");
    expect(teamText({ ...teamView(build(), { now: new Date(time) }), agents: [valid] })).toContain(
      "activity: waiting (r0)",
    );
  });
  it("runs offline from a cache and validates its options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-team-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, build());
      let out = "";
      const runtime = {
        collect: async () => {
          throw new Error("no live collection");
        },
        currentRepository: async () => repo,
        now: () => new Date(time),
      };
      expect(
        await main(
          ["team", "--offline", "--cache", cache, "--json"],
          async (t) => void (out = t),
          runtime,
        ),
      ).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        kind: "team-view",
        schemaVersion: 1,
        freshness: { offline: true, ageSeconds: 0 },
      });
      expect(JSON.parse(out).freshness.liveVerification).toMatch(/^not performed/);
      let text = "";
      await main(["team", "--offline", "--cache", cache], async (t) => void (text = t), {
        ...runtime,
        now: () => new Date(Date.parse(time) + 3 * 3_600_000),
      });
      expect(text.split("\n")[0]).toMatch(
        /OFFLINE cache fetched .* \(3h 0m old\); ownership not verified live/,
      );
      for (const bad of [
        ["team", "--stale-hours", "0"],
        ["team", "--stale-hours", "x"],
        ["team", "--offline"],
      ])
        await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
