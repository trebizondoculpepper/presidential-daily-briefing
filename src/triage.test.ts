import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argumentsFor, atomicJson, cachedSnapshot, checkpointSince, main } from "./cli.js";
import { dependencyReport } from "./github/dependencies.js";
import { CONFIG_PATH, type ConfigFileSystem, type GitRunner } from "./config/config.js";
import { briefing, textReport } from "./briefing/briefing.js";
import {
  commandRegistry,
  compactGuide,
  guideRules,
  MAX_GUIDE_CODE_POINTS,
  mutatingCommands,
  policyVersion,
} from "./briefing/process.js";
import { closingPrEvidence, pickupEligibility, pickupPolicy } from "./briefing/ranking.js";
import { collect, type Query } from "./github/github.js";
import { ticketDoctor } from "./workflow/ticketdoctor.js";
import {
  changeSubject,
  parseDuration,
  resolveWindow,
  snapshotChangeEvidence,
} from "./github/changes.js";
import type { Issue, PullRequest, Snapshot } from "./github/types.js";
import { clock, issue, page, pr, repo, snapshot, time } from "./testing/snapshots.js";
import { graphQuery } from "./testing/fakegh.js";
import { brief } from "./testing/briefing.js";

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
  it("keeps stable ordering and reports omitted actions instead of silently hiding them", () => {
    const source = snapshot([issue(3), issue(2), issue(1)], []);
    const a = briefing(source, { limit: 1 }, new Date(time));
    expect(a.actions.total).toBe(3);
    expect(a.actions.omitted).toBe(2);
    expect(textReport(a)).toContain("2 more omitted");
    expect(a).toEqual(briefing(source, { limit: 1 }, new Date(time)));
  });
});

describe("CLI freshness and local state safety", () => {
  it("validates options before collecting and requires explicit offline cache", () => {
    expect(() => argumentsFor(["--offline"])).toThrow("requires");
    expect(() => argumentsFor(["--repo", "bad"])).toThrow("owner/name");
    expect(() => argumentsFor(["--since", "yesterday"])).toThrow("ISO");
    expect(() => argumentsFor(["--limit", "0"])).toThrow("positive");
    expect(() => argumentsFor(["--offline", "--cache", "x", "--since", time])).toThrow(
      "live fetch",
    );
  });
  it("labels old cached snapshots offline, preserves checkpoint and rejects repository mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const cache = join(dir, "cache.json"),
        checkpoint = join(dir, "checkpoint.json");
      await atomicJson(cache, snapshot());
      await atomicJson(checkpoint, { schemaVersion: 1, repository: repo, through: time });
      let rendered = "";
      expect(
        await main(
          ["--offline", "--cache", cache, "--checkpoint", checkpoint, "--json"],
          async (text) => {
            rendered = text;
          },
        ),
      ).toBe(0);
      expect(JSON.parse(rendered).freshness.offline).toBe(true);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      await expect(cachedSnapshot(cache, "wrong/repo")).rejects.toThrow("invalid");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("advances only after complete successful output, using start of collection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const checkpoint = join(dir, "checkpoint.json");
      const data = snapshot();
      data.fetchedAt = "2026-11-12T10:05:00.000Z";
      const runtime = { collect: async () => data, currentRepository: async () => repo };
      await expect(
        main(
          ["--checkpoint", checkpoint],
          async () => {
            throw new Error("broken stdout");
          },
          runtime,
        ),
      ).rejects.toThrow("broken stdout");
      expect(await checkpointSince(checkpoint, repo)).toBeUndefined();
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(0);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      data.warnings.push("incomplete");
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(2);
      expect(JSON.parse(await readFile(checkpoint, "utf8")).through).toBe(time);
      await expect(
        main(["--checkpoint", checkpoint], async () => {}, {
          ...runtime,
          collect: async () => {
            throw new Error("API unavailable");
          },
        }),
      ).rejects.toThrow("API unavailable");
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("compact briefing contract", () => {
  it("omits empty sections and zero counters from text while preserving structured metadata", async () => {
    const { compactBriefing, compactText } = await import("./briefing/compact.js");
    const data = snapshot([], []),
      expanded = briefing(data, { limit: 10 }, new Date(time));
    const report = compactBriefing(data, { limit: 10 }, expanded);
    const text = compactText(report);
    expect(report.actions).toMatchObject({ total: 0, omitted: 0, items: [] });
    expect(text).not.toContain("NEXT STEPS");
    expect(text).not.toContain("0 omitted");
    expect(text).not.toContain("Read-only suggestions, not authority");
    expect(text).toContain("No --agent given:");
    expect(argumentsFor([]).limit).toBe(10);
    expect(argumentsFor(["--limit", "2"]).limit).toBe(2);
  });

  it("deduplicates targets, separates parked questions and preserves full detail", async () => {
    const { compactBriefing, compactText, sourceContext } = await import("./briefing/compact.js");
    const parked = issue(7, ["status:parked", "question"]);
    const mine = issue(8, ["agent:reader"]);
    mine.lastEditedAt = "2026-11-12T12:00:00Z";
    mine.comments = page([
      { body: "old question?", url: `${mine.url}#comment`, author: null, createdAt: time },
    ]);
    const data = snapshot([parked, mine, issue()], [pr()]);
    const expanded = briefing(data, { limit: 100, issue: 8 }, new Date(time));
    const compact = compactBriefing(data, { limit: 5, agent: "reader" }, expanded);
    expect(compact.schemaVersion).toBe(2);
    expect(new Set(compact.actions.items).size).toBe(compact.actions.items.length);
    expect(compact.actions.items).not.toContain(parked.url);
    expect(compact.sections.deferred.items).toContain(parked.url);
    expect(compact.sections.current.items).toContain(mine.url);
    expect(compact.detail?.comments.nodes[0].body).toBe("old question?");
    expect(sourceContext(mine).chronology).toContain("superseded");
    expect(sourceContext(parked).chronology).toContain("Unknown");
    const noDetail = { ...compact, detail: null };
    expect(compactText(noDetail, 1500).length).toBeLessThanOrEqual(1500);
    expect(compactText(noDetail, 600)).toContain("omitted");
  });
  it("keeps real estimation warnings visible even with no estimate candidates", async () => {
    const { compactBriefing, compactText } = await import("./briefing/compact.js");
    const data = snapshot([], []);
    const base = compactBriefing(
      data,
      { limit: 10 },
      briefing(data, { limit: 10 }, new Date(time)),
    );
    const report = {
      ...base,
      estimation: {
        ...base.estimation,
        queue: { total: 0, omitted: 0, items: [] },
        conflicts: { total: 1, omitted: 0, items: [] },
        unknown: 1,
        detail: "Conflicting sizing and unknown provenance require inspection.",
      },
    };
    expect(compactText(report)).toContain(
      "Conflicting sizing and unknown provenance require inspection.",
    );
  });
  it("bounds independent requests, retains order and propagates failure", async () => {
    const { concurrentMap } = await import("./github/github.js");
    let active = 0;
    let peak = 0;
    const results = await concurrentMap([1, 2, 3, 4, 5, 6, 7], async (n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    await expect(
      concurrentMap([1], async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
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

// The installed-bin check (#11) runs against the real packed archive in
// scripts/package-test.ts (npm run package-test), which builds first and runs in every CI job.
describe("release versions (doc/npm-releases.md)", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  it("follows the contract's sequence: 0.0.x-next before 0.1.0, patch per main build, minor per release", async () => {
    const { chooseVersion } = await import("../scripts/release-version.js");
    const history: { version: string; gitHead: string }[] = [];
    const step = (channel: "next" | "latest", n: number) => {
      const { version } = chooseVersion({ channel, sha: sha(n), published: history });
      history.push({ version: version!, gitHead: sha(n) });
      return version;
    };
    expect([step("next", 1), step("next", 2)]).toEqual(["0.0.1-next.1", "0.0.2-next.1"]);
    expect(step("latest", 3)).toBe("0.1.0");
    expect([step("next", 4), step("next", 5)]).toEqual(["0.1.1-next.1", "0.1.2-next.1"]);
    expect(step("latest", 6)).toBe("0.2.0");
    expect(step("next", 7)).toBe("0.2.1-next.1");
  });
  it("recognises a commit already published on the channel instead of assigning another version", async () => {
    const { chooseVersion } = await import("../scripts/release-version.js");
    const published = [{ version: "0.0.1-next.1", gitHead: sha(1) }];
    expect(chooseVersion({ channel: "next", sha: sha(1), published })).toMatchObject({
      version: null,
      alreadyPublished: "0.0.1-next.1",
    });
    // The same commit may still be promoted to an official release.
    expect(chooseVersion({ channel: "latest", sha: sha(1), published }).version).toBe("0.1.0");
  });
  it("moves to the following prerelease after a registry-lag conflict, never bumping a release", async () => {
    const { followingPrerelease } = await import("../scripts/release-version.js");
    expect(followingPrerelease("0.1.1-next.1")).toBe("0.1.2-next.1");
    expect(followingPrerelease("0.0.9-next.1")).toBe("0.0.10-next.1");
    expect(() => followingPrerelease("0.1.0")).toThrow();
  });
  it("orders prereleases before their release and ignores unrelated versions", async () => {
    const { chooseVersion, compare, parse } = await import("../scripts/release-version.js");
    expect(compare(parse("0.1.0-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(compare(parse("0.0.9-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(parse("1.0.0-beta.1")).toBeNull();
    const published = [{ version: "1.0.0-beta.1" }, { version: "0.3.0" }];
    expect(chooseVersion({ channel: "next", sha: sha(9), published }).version).toBe("0.3.1-next.1");
  });
});

describe("help names the installed command (#53)", () => {
  it("leads with pdb and mentions the checkout form only as an alternative", async () => {
    let main_ = "";
    let deps = "";
    await main(["--help"], async (t) => void (main_ = t));
    await main(["deps", "--help"], async (t) => void (deps = t));
    for (const text of [main_, deps]) {
      expect(text).toMatch(/^Usage: pdb /);
      expect(text.split("\n").filter((l) => /^\s*npm run pdb/.test(l))).toEqual([]);
    }
  });
});

describe("explicit publication helpers (#79)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  type Fake = {
    main?: string;
    release?: string | null;
    ancestor?: (x: string, y: string) => boolean;
    dispatchFails?: boolean;
  };
  const fakeRunner = (f: Fake) => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "rev-parse")
        return args[1] === "origin/main" ? (f.main ?? A) : (f.release ?? "");
      if (cmd === "git" && args[0] === "ls-remote")
        return f.release ? `${f.release}\trefs/heads/release` : "";
      if (cmd === "git" && args[0] === "merge-base") {
        if (!(f.ancestor ?? (() => true))(args[2], args[3])) throw new Error("not ancestor");
        return "";
      }
      if (cmd === "gh" && f.dispatchFails) throw new Error("dispatch failed");
      return "";
    };
    return { run, calls };
  };
  it("make-prerelease resolves main once and dispatches channel=next on main with that SHA", async () => {
    const { makePrerelease } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A });
    makePrerelease({}, f.run);
    expect(f.calls).toEqual([
      "git fetch --no-tags origin main",
      "git rev-parse origin/main",
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
  });
  it("release fast-forwards release, then dispatches channel=latest on release; never forces", async () => {
    const { release } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B });
    const lines = release({}, f.run);
    expect(f.calls.filter((c) => c.startsWith("git push") || c.startsWith("gh"))).toEqual([
      `git push origin ${A}:refs/heads/release`,
      `gh workflow run publish.yml --ref release -f channel=latest -f sha=${A}`,
    ]);
    expect(f.calls.some((c) => c.includes("--force"))).toBe(false);
    expect(lines[0]).toMatch(/publishes nothing/);
    const already = fakeRunner({ main: A, release: A });
    release({}, already.run);
    expect(already.calls.some((c) => c.startsWith("git push"))).toBe(false);
  });
  it("refuses to rewrite release history", async () => {
    const { release } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, ancestor: (x) => x !== B });
    expect(() => release({}, f.run)).toThrow(/refusing to rewrite release history/);
    expect(f.calls.some((c) => c.startsWith("git push") || c.startsWith("gh"))).toBe(false);
  });
  it("reports a failed dispatch with a retry for the same SHA, and retries never re-resolve main", async () => {
    const { release, makePrerelease } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, dispatchFails: true });
    expect(() => release({}, f.run)).toThrow(
      new RegExp(`Promoted ${A}.*npm run release -- --sha ${A}`),
    );
    const retry = fakeRunner({ main: B, release: A });
    makePrerelease({ sha: A }, retry.run);
    expect(retry.calls).toEqual([
      "git fetch --no-tags origin main",
      `git merge-base --is-ancestor ${A} origin/main`,
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
    const offMain = fakeRunner({ ancestor: () => false });
    expect(() => makePrerelease({ sha: A }, offMain.run)).toThrow(/not on origin\/main/);
  });
  it("validates arguments", async () => {
    const { parseArgs } = await import("../scripts/dispatch.js");
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--sha", A])).toEqual({ sha: A });
    for (const bad of [["--sha", "abc"], ["--sha"], ["--sha", A, "x"], ["--force"]])
      expect(() => parseArgs(bad)).toThrow();
  });
  it("the Publish workflow runs only on explicit dispatch and validates before building", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
    const validate = workflow.indexOf("Validate the request");
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(workflow.indexOf("npm ci"));
    expect(workflow).toContain('"$GITHUB_SHA" != "$SHA"');
    expect(workflow).toContain("next:main|latest:release");
    // A queued request re-checks the live branch head right before publishing.
    const live = workflow.indexOf('git ls-remote origin "refs/heads/$GITHUB_REF_NAME"');
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(workflow.indexOf("npm publish --provenance"));
  });
});

describe("designer groups: decision needed vs agreed-needs-documentation (#40)", () => {
  it("groups explicit markers separately with source reasons; unknown without one", async () => {
    const { compactBriefing, compactText } = await import("./briefing/compact.js");
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
    const text = compactText(compact, 50000);
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
    const { compactBriefing, compactText } = await import("./briefing/compact.js");
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
    const { compactBriefing } = await import("./briefing/compact.js");
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
    const { compactBriefing } = await import("./briefing/compact.js");
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
    const { compactBriefing } = await import("./briefing/compact.js");
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

describe("TypeScript source boundary (#91, #113, doc/design/typescript.md)", () => {
  it("allows only allowlisted non-TypeScript files in src/, scripts/ and doc/reports/examples/", async () => {
    const { LANGUAGE_SCOPE, languageViolations } = await import("./language-policy.js");
    const root = new URL("../", import.meta.url);
    // Generated output and dependencies are runtime artifacts, not handwritten source.
    const skipped = new Set(["node_modules", "dist"]);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name)) await walk(`${path}/`);
        } else files.push(path);
      }
    };
    for (const dir of LANGUAGE_SCOPE) await walk(dir);
    const sources = new Map<string, string>();
    for (const file of files) {
      if (/\.tsx?$/.test(file) && (file.startsWith("src/") || file.startsWith("scripts/"))) {
        sources.set(file, await readFile(new URL(file, root), "utf8"));
      }
    }
    expect(languageViolations(files, sources)).toEqual([]);
  });

  it("fails unlisted files, stale entries and imports of allowlisted files", async () => {
    const { languageViolations } = await import("./language-policy.js");
    const entry = {
      file: "scripts/helper.sh",
      purpose: "p",
      integrationBoundary: "b",
      runtimeRequirements: "r",
      supportedPlatforms: "s",
      validation: "v",
    };
    const none = new Map<string, string>();
    expect(languageViolations(["scripts/helper.sh"], none, [])).toEqual([
      "scripts/helper.sh: non-TypeScript file is not on the allowlist",
    ]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], none, [entry])).toEqual([]);
    expect(languageViolations(["src/cli.ts"], none, [entry])).toEqual([
      "scripts/helper.sh: allowlisted file does not exist",
    ]);
    const importing = new Map([["src/cli.ts", 'import x from "../scripts/helper.sh";']]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], importing, [entry])).toEqual([
      "src/cli.ts: imports allowlisted non-TypeScript file scripts/helper.sh",
    ]);
    const requiring = new Map([["scripts/a.ts", 'require("./helper.sh")']]);
    expect(languageViolations(["scripts/helper.sh"], requiring, [entry])).toHaveLength(1);
  });
});

describe("read-only MCP adapter (#25)", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { createServer, boundedEnvelope, mcpArguments, redactLocalText, redactPaths } =
    await import("./mcp.js");
  const { flattenRelationships } = await import("./mcp/views.js");
  const { IssueUnavailable } = await import("./github/github.js");
  type Runtime = import("./mcp.js").McpRuntime;
  type Options = import("./mcp.js").McpOptions;

  const fake = (overrides: Partial<Runtime> = {}): Runtime & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      currentRepository: async () => repo,
      collect: async (repository: string, options?: { issue?: number; since?: string }) => {
        seen.push(`${repository}#${options?.issue ?? "-"}@${options?.since ?? "-"}`);
        return { ...snapshot(), repository };
      },
      dependencyReport: (r: string, n: number, o?: { tree?: boolean }) =>
        dependencyReport(r, n, o, graphQuery({ edges: [[1, 2]] }).query, clock),
      // A fixed clock keeps freshness ages identical between the MCP and CLI reads.
      now: clock,
      ...overrides,
    };
  };
  const connect = async (runtime: Runtime, options: Options = {}) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(options, runtime).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };
  const structured = (result: { structuredContent?: unknown }) =>
    boundedEnvelope.parse(result.structuredContent);
  const text = (result: { content?: unknown }): string => {
    const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
    return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
  };

  it("reads the guide opt-out from --project, not the server's working directory", async () => {
    const { defaultRuntime } = await import("./mcp.js");
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const project = await mkdtemp(join(tmpdir(), "triage-guide-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: project });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], {
        cwd: project,
      });
      await mkdir(join(project, ".github"), { recursive: true });
      await writeFile(join(project, CONFIG_PATH), '{"schemaVersion":1,"processGuide":false}');
      expect(process.cwd()).not.toBe(project);
      const runtime: Runtime = {
        ...defaultRuntime({ project }),
        collect: async (repository: string) => ({ ...snapshot(), repository }),
        now: clock,
      };
      const client = await connect(runtime, { project, repo });
      const brief = structured(await client.callTool({ name: "triage_briefing", arguments: {} }));
      await client.close();
      const mcpProcess = (brief.data as { process: unknown }).process;
      expect(mcpProcess).toMatchObject({ enabled: false, source: "config", guide: null });
      let out = "";
      await main(
        ["--repo", repo, "--json", "--no-update-check"],
        async (t) => void (out = t),
        runtime,
      );
      expect(mcpProcess).toEqual(JSON.parse(out).process);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  /**
   * Older-client compatibility (doc/design/mcp.md): a raw JSON-RPC exchange, as an older host
   * would send it, rather than the current SDK client, which always offers the latest version.
   */
  const rawSession = async (protocolVersion: string) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, fake()).connect(serverSide);
    const replies = new Map<number, { result?: Record<string, unknown>; error?: unknown }>();
    const waiting = new Map<number, () => void>();
    clientSide.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      replies.set(message.id, message as { result?: Record<string, unknown>; error?: unknown });
      waiting.get(message.id)?.();
    };
    await clientSide.start();
    let next = 0;
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++next;
      const replied = new Promise<void>((done) => waiting.set(id, done));
      await clientSide.send({ jsonrpc: "2.0", id, method, params });
      await replied;
      const reply = replies.get(id);
      if (!reply?.result) throw new Error(`${method} failed: ${JSON.stringify(reply?.error)}`);
      return reply.result;
    };
    const init = await request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "older-host", version: "0.0.1" },
    });
    await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { init, request, close: () => clientSide.close() };
  };

  for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    it(`negotiates ${version} for an older client and serves tools/list and tools/call`, async () => {
      const session = await rawSession(version);
      expect(session.init.protocolVersion).toBe(version);
      expect(session.init.serverInfo).toMatchObject({ name: "pdb" });
      const { tools } = (await session.request("tools/list")) as { tools: { name: string }[] };
      expect(tools.map((t) => t.name).sort()).toEqual([
        "triage_briefing",
        "triage_dependencies",
        "triage_events",
        "triage_issue",
      ]);
      const call = (await session.request("tools/call", {
        name: "triage_briefing",
        arguments: {},
      })) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      expect(call.isError).not.toBe(true);
      // Clients that predate structuredContent (before 2025-06-18) still get usable text.
      expect(text(call)).toContain(repo);
      expect(structured(call)).toMatchObject({ view: "briefing", status: "complete" });
      await session.close();
    });
  }

  it("answers an unsupported protocol version with its own latest, not a silent downgrade", async () => {
    const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/server");
    const session = await rawSession("2023-01-01");
    // Per the MCP lifecycle the client must then disconnect; the server never claims 2023-01-01.
    expect(session.init.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    await session.close();
  });

  it("lists exactly four read-only tools with strict inputs", async () => {
    const client = await connect(fake());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "triage_briefing",
      "triage_dependencies",
      "triage_events",
      "triage_issue",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    await client.close();
  });

  it("projects the CLI's versioned JSON for briefing, issue and dependencies (#266)", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo });
    const cli = async (args: string[]) => {
      let out = "";
      await main([...args, "--json", "--no-update-check"], async (t) => void (out = t), runtime);
      return JSON.parse(out);
    };
    const brief = structured(await client.callTool({ name: "triage_briefing", arguments: {} }));
    expect(brief).toMatchObject({
      schemaVersion: 2,
      kind: "mcp-read-result",
      tool: "triage_briefing",
      view: "briefing",
      status: "complete",
      selection: { repository: repo, agent: null, identitySource: "unresolved" },
      presentation: { omitted: {}, truncatedFields: [], next: null },
      error: null,
    });
    const { checkpoint: _, ...cliBrief } = await cli(["--repo", repo]);
    const expected = redactPaths(cliBrief, [process.cwd()]);
    // Carried fields keep their CLI values; local paths in diagnostics are redacted.
    const data = brief.data as Record<string, unknown>;
    for (const key of ["summary", "actions", "sections", "rankedActions", "estimation", "process"])
      expect(data[key], key).toEqual(expected[key]);
    expect(brief.freshness).toEqual(expected.freshness);
    expect(brief.sourceCompleteness).toEqual(expected.completeness);
    expect((data.subjects as unknown[]).length).toBe(expected.subjects.length);
    const intake = structured(
      await client.callTool({ name: "triage_issue", arguments: { number: 1, agent: "ana" } }),
    );
    const { checkpoint: __, ...cliIssue } = await cli([
      "--repo",
      repo,
      "--issue",
      "1",
      "--agent",
      "ana",
    ]);
    expect(intake).toMatchObject({
      view: "issue",
      subject: { type: "issue", number: 1 },
      selection: { agent: "ana", identitySource: "tool" },
    });
    const issueData = intake.data as {
      issue: Record<string, unknown>;
      counts: Record<string, number>;
    };
    expect(issueData.issue).toMatchObject({
      number: cliIssue.detail.number,
      title: cliIssue.detail.title,
      state: cliIssue.detail.state,
      labels: cliIssue.detail.labels.nodes.map((l: { name: string }) => l.name),
    });
    expect(issueData.counts.comments).toBe(cliIssue.detail.comments.nodes.length);
    const deps = structured(
      await client.callTool({ name: "triage_dependencies", arguments: { number: 1, tree: true } }),
    );
    const cliDeps = await cli(["deps", "1", "--tree", "--repo", repo]);
    expect((deps.data as { relationships: unknown }).relationships).toEqual(
      flattenRelationships(cliDeps, 1),
    );
    expect(deps.data).toMatchObject({ tree: true, cycles: cliDeps.cycles });
    await client.close();
  });

  it("keeps collected PR evidence in an explicit pullRequests section (#266)", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo });
    let out = "";
    await main(
      ["--repo", repo, "--issue", "1", "--json", "--no-update-check"],
      async (t) => void (out = t),
      runtime,
    );
    const cliIssue = JSON.parse(out) as {
      subjects: { url: string; pullRequest?: unknown }[];
    };
    const expected = cliIssue.subjects.find((subject) => subject.url === pr().url)?.pullRequest;
    expect(expected).toBeTruthy();
    const result = structured(
      await client.callTool({
        name: "triage_issue",
        arguments: { number: 1, section: "pullRequests" },
      }),
    );
    const rows = (result.data as { rows: { url: string; pullRequest: unknown }[] }).rows;
    expect(rows.map((row) => row.url)).toEqual([pr().url]);
    expect(rows[0]?.pullRequest).toEqual(expected);
    expect(JSON.stringify(rows[0]?.pullRequest)).toContain("verify");
    await client.close();
  });

  it("bounds triage_issue text to maxChars and pages long discussion with visible shortening", async () => {
    const long = "x".repeat(4000);
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: { login: `user${i}` },
      body: `comment ${i} ${long}`,
      createdAt: time,
      url: `${issue().url}#issuecomment-${i}`,
    }));
    const big = { ...issue(1), body: `body ${long}`, comments: page(comments) } as unknown as Issue;
    const runtime = fake({
      collect: async (repository: string) => ({ ...snapshot([big]), repository }),
    });
    const client = await connect(runtime, { repo });
    const result = await client.callTool({
      name: "triage_issue",
      arguments: { number: 1, maxChars: 2000 },
    });
    const body = text(result);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toContain("Bounded MCP result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_384);
    expect(structured(result).data).toMatchObject({ counts: { comments: 30 } });
    const seen: string[] = [];
    let args: Record<string, unknown> | null = { number: 1, section: "discussion", limit: 100 };
    while (args) {
      const pageResult = structured(
        await client.callTool({ name: "triage_issue", arguments: args }),
      );
      const rows = (pageResult.data as { rows: { url: string; body: string }[] }).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.body).toMatch(/… \[truncated\]$/);
      expect(pageResult.presentation.truncatedFields.length).toBeGreaterThanOrEqual(rows.length);
      seen.push(...rows.map((row) => row.url));
      args = pageResult.presentation.next?.arguments ?? null;
    }
    expect(seen).toEqual(comments.map((c) => c.url));
    await client.close();
  });

  it("rejects unknown properties and out-of-range values before collection", async () => {
    const runtime = fake();
    const client = await connect(runtime);
    for (const [name, args] of [
      ["triage_briefing", { path: "/etc" }],
      ["triage_briefing", { limit: 0 }],
      ["triage_briefing", { maxChars: 50 }],
      ["triage_briefing", { since: "2026-11-12" }],
      ["triage_issue", { number: -1 }],
      ["triage_issue", {}],
      ["triage_dependencies", { number: 1, repo: "not a repo" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args }).catch((error) => ({
        isError: true,
        thrown: error,
      }));
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(runtime.seen).toEqual([]);
    await client.close();
  });

  it("keeps per-call selection: tool repo/agent win and concurrent calls do not interfere", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo: "start/default", agent: "boot" });
    const [a, b, c] = await Promise.all([
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/a" } }),
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/b", agent: "zed" } }),
      client.callTool({ name: "triage_briefing", arguments: {} }),
    ]);
    expect(structured(a).selection).toMatchObject({
      repository: "o/a",
      agent: "boot",
      identitySource: "startup",
      identityDiagnostic: null,
    });
    expect(structured(b).selection).toMatchObject({
      repository: "o/b",
      agent: "zed",
      identitySource: "tool",
      identityDiagnostic: null,
    });
    expect(structured(c).selection.repository).toBe("start/default");
    expect(runtime.seen.sort()).toEqual(["o/a#-@-", "o/b#-@-", "start/default#-@-"]);
    await client.close();
  });

  it("resolves the default repository in the configured project and reports unresolved identity", async () => {
    const dirs: (string | undefined)[] = [];
    const client = await connect(
      fake({ currentRepository: async (cwd) => (dirs.push(cwd), repo) }),
      { project: "/work/project" },
    );
    const result = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(dirs).toEqual(["/work/project"]);
    expect(text(result)).toMatch(/Identity: unresolved; this is an unfocused read/);
    await client.close();
  });

  describe("default repository without --project or --repo (#271)", () => {
    // A host such as Ori launches the server in its daemon's directory, which holds another
    // project's checkout. Injected cwd, git and filesystem model that launch directory.
    const daemonRepo = "daemon/elsewhere";
    const project = "/work/project";
    const hostRuntime = () => {
      const lookups: (string | undefined)[] = [];
      const touched: string[] = [];
      const runtime = fake({
        currentRepository: async (cwd?: string) => {
          lookups.push(cwd);
          return cwd === project ? repo : daemonRepo;
        },
        git: async (args: readonly string[]) => {
          touched.push(`git ${args.join(" ")}`);
          return args[0] === "rev-parse"
            ? "/daemon/cwd\n"
            : `origin\thttps://github.com/${daemonRepo}.git (fetch)\n`;
        },
        fs: {
          readText: async (path: string) => (touched.push(`read ${path}`), null),
          writeText: async (path: string) => void touched.push(`write ${path}`),
          rename: async (_from: string, to: string) => void touched.push(`rename ${to}`),
          appendText: async (path: string) => void touched.push(`append ${path}`),
          remove: async (path: string) => void touched.push(`remove ${path}`),
          makeDirectory: async (path: string) => void touched.push(`mkdir ${path}`),
        },
      });
      return { runtime, lookups, touched };
    };
    const calls: [string, Record<string, unknown>][] = [
      ["triage_briefing", {}],
      ["triage_briefing", { mode: "briefing" }],
      ["triage_issue", { number: 1 }],
      ["triage_dependencies", { number: 1 }],
    ];

    it("refuses with selection guidance instead of resolving the launch directory, keeping overrides", async () => {
      const { runtime, lookups, touched } = hostRuntime();
      const client = await connect(runtime);
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        const envelope = structured(result);
        expect(envelope).toMatchObject({
          status: "error",
          data: null,
          selection: { repository: null },
          error: { code: "repository-unresolved" },
        });
        const message = envelope.error?.message ?? "";
        for (const fix of ["repo", "--repo owner/name", "--project /absolute/project/path"])
          expect(message, name).toContain(fix);
        const command = /pdb-mcp [^\n]*/.exec(message)?.[0] ?? "";
        expect(command).toBe("pdb-mcp --project /absolute/project/path");
        expect(message).not.toContain("#");
        expect(JSON.stringify(result)).not.toContain(daemonRepo);
      }
      expect(lookups).toEqual([]);
      expect(runtime.seen).toEqual([]);
      expect(touched).toEqual([]);
      await client.close();

      // Explicit overrides still select: tool repo, then --repo, then --project.
      const viaTool = await connect(runtime);
      const tool = await viaTool.callTool({ name: "triage_briefing", arguments: { repo: "o/a" } });
      expect(structured(tool)).toMatchObject({
        status: "complete",
        selection: { repository: "o/a" },
      });
      await viaTool.close();
      const viaStartup = await connect(runtime, { repo: "o/b" });
      const startup = await viaStartup.callTool({ name: "triage_issue", arguments: { number: 1 } });
      expect(structured(startup).selection.repository).toBe("o/b");
      await viaStartup.close();
      expect(lookups).toEqual([]);
      const viaProject = await connect(runtime, { project });
      const configured = await viaProject.callTool({
        name: "triage_dependencies",
        arguments: { number: 1 },
      });
      expect(structured(configured).selection.repository).toBe(repo);
      expect(lookups).toEqual([project]);
      await viaProject.close();
    });
  });

  describe("read-only identity from the project's agent-inbox.toml", () => {
    const root = "/work/project";
    const identityFile = join(root, "agent-inbox.toml");
    const toml = [
      "[agents.claude]",
      'name = "file_claude"',
      'triage_role = "implementer"',
      "",
      "[agents.codex]",
      'name = "file_codex"',
      'role = "agent"',
      "",
      '[agents."ori.pdb"]',
      'name = "file_ori"',
      'triage_role = "designer"',
      "",
      '[agents."ori.review"]',
      'name = "file_ori_review"',
      "",
    ].join("\n");
    const identityRuntime = (
      contents: string | null | Error = toml,
      env: Record<string, string> = {},
    ) => {
      const writes: string[] = [];
      const fs = {
        readText: async (path: string) => {
          if (contents instanceof Error) throw contents;
          return path === identityFile ? contents : null;
        },
        writeText: async (path: string) => void writes.push(path),
        rename: async (_from: string, to: string) => void writes.push(to),
        appendText: async (path: string) => void writes.push(path),
        remove: async (path: string) => void writes.push(path),
        makeDirectory: async (path: string) => void writes.push(path),
      };
      const git = async (args: readonly string[]) =>
        args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
      return { runtime: fake({ fs, git, env }), writes };
    };
    const connectAs = async (runtime: Runtime, options: Options, clientName = "test") => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer(options, runtime).connect(serverSide);
      const client = new Client({ name: clientName, version: "9.9.9" });
      await client.connect(clientSide);
      return client;
    };
    const briefingSelection = async (client: Awaited<ReturnType<typeof connectAs>>, args = {}) =>
      structured(await client.callTool({ name: "triage_briefing", arguments: args }));

    it("applies tool, startup, entry, harness, client and environment precedence", async () => {
      const { runtime, writes } = identityRuntime(toml, { CLAUDECODE: "1" });
      const base = { project: root };
      const cases: [Options, string, Record<string, string>, object][] = [
        [
          { ...base, agent: "boot", entry: "codex" },
          "ori-pdb",
          { agent: "zed" },
          { agent: "zed", identitySource: "tool" },
        ],
        [
          { ...base, agent: "boot", entry: "codex" },
          "ori-pdb",
          {},
          { agent: "boot", identitySource: "startup", entry: null },
        ],
        [
          { ...base, entry: "codex" },
          "ori-pdb",
          {},
          { agent: "file_codex", identitySource: "entry", entry: "codex", triageRole: null },
        ],
        [
          { ...base, harness: "codex" },
          "ori-pdb",
          {},
          { agent: "file_codex", identitySource: "harness", entry: "codex" },
        ],
        [
          base,
          "ori-pdb",
          {},
          {
            agent: "file_ori",
            identitySource: "client",
            entry: "ori.pdb",
            triageRole: "designer",
          },
        ],
        [
          base,
          "ori-review",
          {},
          { agent: "file_ori_review", identitySource: "client", entry: "ori.review" },
        ],
        [
          base,
          "claude-code",
          {},
          {
            agent: "file_claude",
            identitySource: "environment",
            entry: "claude",
            triageRole: "implementer",
          },
        ],
      ];
      for (const [options, clientName, args, expected] of cases) {
        const client = await connectAs(runtime, options, clientName);
        const selected = await briefingSelection(client, args);
        expect(selected.selection, JSON.stringify([options, clientName, args])).toMatchObject({
          ...expected,
          identityDiagnostic: null,
        });
        expect(selected.status).toBe("complete");
        await client.close();
      }
      expect(writes).toEqual([]);
    });

    it("focuses the read exactly as the CLI does for the same name", async () => {
      const { runtime } = identityRuntime();
      const client = await connectAs(runtime, { project: root, repo }, "ori-pdb");
      const brief = await briefingSelection(client);
      expect(brief.selection.agent).toBe("file_ori");
      let out = "";
      await main(
        ["--repo", repo, "--agent", "file_ori", "--json", "--no-update-check"],
        async (t) => void (out = t),
        runtime,
      );
      const { checkpoint: _, ...cli } = JSON.parse(out);
      const expected = redactPaths(cli, [process.cwd()]);
      for (const key of ["actions", "sections", "rankedActions", "role"])
        expect((brief.data as Record<string, unknown>)[key], key).toEqual(expected[key]);
      await client.close();
    });

    it("reads unfocused with a diagnostic when identity is missing, ambiguous or unreadable", async () => {
      const cases: [ReturnType<typeof identityRuntime>, Options, string, RegExp][] = [
        [
          identityRuntime(toml, { ORI_SESSION_ID: "s" }),
          { project: root },
          "test",
          /one entry per configured server/,
        ],
        [
          identityRuntime(toml, { CLAUDECODE: "1", CODEX_THREAD_ID: "t" }),
          { project: root },
          "test",
          /several harnesses/,
        ],
        [
          identityRuntime(toml),
          { project: root, harness: "ori" },
          "test",
          /Candidate entries: ori.pdb, ori.review/,
        ],
        [identityRuntime(toml), { project: root }, "test", /No supported harness/],
        [
          identityRuntime(toml),
          { project: root, entry: "missing" },
          "test",
          /no \[agents.missing\] entry/,
        ],
        [identityRuntime(null), { project: root, entry: "codex" }, "test", /no agent-inbox.toml/],
        [
          identityRuntime("[agents\nbroken"),
          { project: root, entry: "codex" },
          "test",
          /not valid for identity use/,
        ],
        [
          identityRuntime(new Error("EACCES /home/secret/agent-inbox.toml")),
          { project: root, entry: "codex" },
          "test",
          /could not be read/,
        ],
        [
          identityRuntime(toml, { CLAUDECODE: "1" }),
          {},
          "ori-pdb",
          /no local project is configured/,
        ],
      ];
      for (const [{ runtime, writes }, options, clientName, diagnostic] of cases) {
        const client = await connectAs(runtime, options, clientName);
        const result = await client.callTool({ name: "triage_briefing", arguments: { repo } });
        const selected = structured(result);
        expect(selected.status, String(diagnostic)).toBe("complete");
        expect(selected.selection).toMatchObject({ agent: null, identitySource: "unresolved" });
        expect(selected.selection.identityDiagnostic).toMatch(diagnostic);
        expect(text(result)).toMatch(/Identity: unresolved; this is an unfocused read/);
        expect(JSON.stringify(result)).not.toMatch(/secret|EACCES|\/work\/project/);
        expect(writes).toEqual([]);
        await client.close();
      }
    });

    it("does not use a project's identity for a different repository", async () => {
      const { runtime } = identityRuntime();
      const client = await connectAs(runtime, { project: root, entry: "codex" });
      const selected = await briefingSelection(client, { repo: "other/repo" });
      expect(selected.selection).toMatchObject({ agent: null, identitySource: "unresolved" });
      expect(selected.selection.identityDiagnostic).toMatch(/not other\/repo/);
      await client.close();
    });

    it("rejects invalid or conflicting startup entry selection", () => {
      expect(() => mcpArguments(["--entry", "__proto__"])).toThrow();
      expect(() => mcpArguments(["--harness", "cursor"])).toThrow();
      expect(() => mcpArguments(["--entry", "codex", "--harness", "codex"])).toThrow(/either/);
      expect(mcpArguments(["--entry", "ori.review"])).toMatchObject({ entry: "ori.review" });
    });
  });

  it("returns sanitized errors, never raw failure text", async () => {
    const client = await connect(
      fake({
        currentRepository: async () => {
          throw new Error("gh: secret-token-123 stderr");
        },
        collect: async () => {
          throw new Error("ghp_SECRET raw stderr\n    at stack");
        },
      }),
    );
    const unresolved = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(unresolved.isError).toBe(true);
    expect(structured(unresolved)).toMatchObject({
      status: "error",
      data: null,
      error: { code: "repository-unresolved" },
    });
    const failed = await client.callTool({ name: "triage_briefing", arguments: { repo } });
    expect(structured(failed).error?.code).toBe("collection-failed");
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|secret-token|stack|stderr/);
    await client.close();
  });

  it("reports incomplete evidence and unavailable issues as incomplete, not complete", async () => {
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { issue?: number }) => {
          if (options?.issue === 9)
            throw new IssueUnavailable({
              repository: repo,
              number: 9,
              url: `https://github.com/${repo}/issues/9`,
              state: "forbidden",
              detail: "No access.",
              next: "Check permissions.",
            });
          return { ...snapshot(), warnings: ["Pull requests were truncated."] };
        },
      }),
      { repo },
    );
    const partial = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(structured(partial).status).toBe("incomplete");
    expect(text(partial)).toMatch(/^INCOMPLETE evidence/);
    const denied = await client.callTool({ name: "triage_issue", arguments: { number: 9 } });
    expect(structured(denied)).toMatchObject({
      status: "incomplete",
      data: { kind: "issue-unavailable", state: "forbidden" },
    });
    expect(text(denied)).toMatch(/FORBIDDEN/);
    await client.close();
  });

  it("does not report a cancelled call as complete", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const begun = new Promise<void>((resolve) => (started = resolve));
    const client = await connect(
      fake({
        collect: async () => {
          started();
          await gate;
          return snapshot();
        },
      }),
      { repo },
    );
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "triage_briefing", arguments: {} }, { signal: controller.signal })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await begun;
    controller.abort();
    release();
    const outcome = await pending;
    expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
    await client.close();
  });

  it("hands the call's abort signal to collection and dependency reads", async () => {
    const seen: AbortSignal[] = [];
    const hang = (signal: AbortSignal | undefined) => {
      if (signal) seen.push(signal);
      return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    };
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { signal?: AbortSignal }) => hang(options?.signal),
        dependencyReport: async (_r: string, _n: number, options?: { signal?: AbortSignal }) =>
          hang(options?.signal),
      }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_briefing", {}],
      ["triage_dependencies", { number: 1 }],
    ] as const) {
      const before = seen.length;
      const controller = new AbortController();
      const pending = client
        .callTool({ name, arguments: args }, { signal: controller.signal })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      await expect.poll(() => seen.length).toBe(before + 1);
      controller.abort();
      const outcome = await pending;
      expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
      // The server-side signal for that call fires, so the gh child is terminated.
      await expect.poll(() => seen.at(-1)?.aborted).toBe(true);
    }
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it("never returns local filesystem paths from configuration diagnostics", async () => {
    const leaks = ["/home/alice/private/checkout", "C:\\Users\\alice\\private\\checkout"];
    for (const root of leaks) {
      // The checkout's remote does not match the requested repository, so the estimation
      // config error names the checkout directory.
      const git: GitRunner = async (args) =>
        args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/other/thing (fetch)\n";
      const client = await connect(fake({ estimation: { cwd: root, git } }), {
        project: root,
        repo,
      });
      for (const [name, args] of [
        ["triage_briefing", {}],
        ["triage_issue", { number: 1 }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        const all = JSON.stringify(result);
        expect(all, `${name} ${root}`).not.toContain("alice");
        expect(all).toContain("<local checkout>");
        expect(all).toContain("other/thing");
        expect(all).toContain(`https://github.com/${repo}/issues/1`);
      }
      await client.close();
    }
  });

  it("redacts absolute paths in local diagnostics without touching URLs or repository names", () => {
    expect(
      [
        "The checkout at /srv/work/x is not owner/name (remotes: o/r).",
        "Restore C:\\Users\\bob\\proj\\.github\\triage.json from Git.",
        "See https://github.com/owner/name/issues/2 and ~/secret/file",
      ].map(redactLocalText),
    ).toEqual([
      "The checkout at <local checkout> is not owner/name (remotes: o/r).",
      "Restore <local checkout> from Git.",
      "See https://github.com/owner/name/issues/2 and <local checkout>",
    ]);
  });

  it("redacts only verified local directories everywhere, at path boundaries", () => {
    expect(
      redactPaths(
        {
          a: "Mine: /opt/me/repo/src and /opt/me/repo.",
          b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
          c: ["Win: c:/Users/Bob/proj\\src", "D:\\Users\\Bob\\proj"],
          n: 3,
        },
        ["/opt/me/repo", "C:\\Users\\Bob\\proj"],
      ),
    ).toEqual({
      a: "Mine: <local checkout>/src and <local checkout>.",
      b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
      c: ["Win: <local checkout>\\src", "D:\\Users\\Bob\\proj"],
      n: 3,
    });
  });

  it("keeps GitHub-authored paths verbatim and still redacts the home directory", async () => {
    const { homedir } = await import("node:os");
    const authored = "Call /api/v1/users; see [contract](/doc/design/mcp.md).";
    const home = `${homedir()}/private/notes.md`;
    const evidence = {
      ...issue(1),
      title: "Fix /api/v1/users",
      body: `${authored}\\nLocal: ${home}`,
      comments: page([
        { author: { login: "ana" }, body: authored, createdAt: time, url: `${issue().url}#c1` },
      ]),
    } as unknown as Issue;
    const client = await connect(
      fake({ collect: async (repository: string) => ({ ...snapshot([evidence]), repository }) }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_issue", { number: 1 }],
      ["triage_briefing", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const all = JSON.stringify(result.structuredContent) + text(result);
      expect(all, name).not.toContain(homedir());
      if (name === "triage_issue") {
        const detail = JSON.stringify(
          structured(await client.callTool({ name, arguments: { ...args, section: "body" } })).data,
        );
        expect(detail).toContain(JSON.stringify(authored).slice(1, -1));
        expect(detail).toContain("Fix /api/v1/users");
        expect(detail).toContain("<local checkout>/private/notes.md");
      }
    }
    await client.close();
  });

  it("validates startup arguments", () => {
    expect(mcpArguments(["--repo", "o/r", "--agent", "ana"])).toMatchObject({
      repo: "o/r",
      agent: "ana",
    });
    expect(() => mcpArguments(["--repo", "bad"])).toThrow();
    expect(() => mcpArguments(["--agent", "-x"])).toThrow();
    expect(() => mcpArguments(["--harness", "cursor"])).toThrow();
  });
});

describe("role-shaped briefings (#1, doc/design/briefings.md)", () => {
  const compact = async (
    data: Snapshot,
    options: { limit: number; agent?: string; role?: string; platform?: string },
  ) => {
    const { compactBriefing } = await import("./briefing/compact.js");
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
    const { roleView, sectionSelectors } = await import("./briefing/roles.js");
    const parked = issue(102, ["agent:reader", "status:parked"]);
    const data = snapshot([parked], []);
    const r = await compact(data, { limit: 10, agent: "reader" });
    // A selector that ignores parking still cannot promote a parked ticket to a next step.
    sectionSelectors.set("own-work-unguarded", ({ byUrl }) =>
      [...byUrl.keys()].map((url) => ({ url, reason: "test" })),
    );
    const { roleRegistry } = await import("./briefing/roles.js");
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
    const { compactText } = await import("./briefing/compact.js");
    const r = await compact(snapshot([issue(60)], []), { limit: 5, role: "implementer" });
    const text = compactText(r);
    expect(text).toMatch(/Role implementer: What action advances implementation most\?/);
    expect(text).toMatch(/\nPICKUP \(1\)/);
    expect(text).not.toMatch(/\nAVAILABLE/);
    const { argumentsFor } = await import("./cli.js");
    expect(() => argumentsFor(["--role", "owner"])).toThrow(/implementer, designer/);
    expect(() => argumentsFor(["--role", "designer", "--full"])).toThrow(/--full/);
    expect(argumentsFor(["--role=designer"]).role).toBe("designer");
  });
});

describe("workflow guide in help and briefings (#71, doc/design/workflow-guide.md)", () => {
  const root = "/checkout";
  const gitFor =
    (remote = `https://github.com/${repo}.git`): GitRunner =>
    async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : `origin\t${remote} (fetch)\n`;
  const fsWith = (raw: string | null): ConfigFileSystem => ({
    readText: async (file) => (file === join(root, CONFIG_PATH) ? raw : null),
    writeText: async () => {
      throw new Error("guide must never write configuration");
    },
    rename: async () => {
      throw new Error("guide must never write configuration");
    },
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  });
  const run = async (args: string[], raw: string | null, remote?: string) => {
    // Isolate guide rendering/budget behavior from the default decision engine's evaluation cost.
    let guideConfig = raw;
    try {
      const parsed = JSON.parse(raw ?? '{"schemaVersion":1}') as Record<string, unknown>;
      guideConfig = JSON.stringify({ ...parsed, briefing: { engine: "typescript" } });
    } catch {
      /* Malformed guide inputs deliberately remain malformed. */
    }
    let out = "";
    const code = await main(["--no-update-check", ...args], async (t) => void (out = t), {
      collect: async () => snapshot(),
      currentRepository: async () => repo,
      estimation: { fs: fsWith(null), git: gitFor(remote), cwd: root },
      guide: { fs: fsWith(guideConfig), git: gitFor(remote), cwd: root },
    });
    return { code, out };
  };

  it("keeps the guide off by default and explicitly enables generated policy guidance", async () => {
    const disabled = JSON.parse((await run(["--json"], null)).out);
    expect(disabled.process).toMatchObject({ enabled: false, source: "default", guide: null });
    expect((await run([], null)).out).not.toContain("WORKFLOW\n");
    const { code, out } = await run(["--json", "--guide"], null);
    expect(code).toBe(0);
    const process_ = JSON.parse(out).process;
    expect(process_).toMatchObject({ schemaVersion: 1, enabled: true, source: "cli" });
    expect(process_.policyVersion).toBe(policyVersion());
    expect(Array.from(process_.guide as string).length).toBeLessThanOrEqual(MAX_GUIDE_CODE_POINTS);
    expect(process_.guideCodePoints).toBe(Array.from(process_.guide as string).length);
    for (const label of pickupPolicy.available) expect(process_.guide).toContain(label);
    for (const name of mutatingCommands()) expect(process_.guide).toContain(name);
    const text = (await run(["--guide"], null)).out;
    expect(text).toContain("WORKFLOW\n- Order:");
    expect(text).toContain("pdb process");
  });

  it("only advertises implemented commands", () => {
    const templates = commandRegistry.map((c) => c.template.split(" ")[1]);
    for (const line of compactGuide().split("\n"))
      for (const match of line.matchAll(/pdb (\S+)/g)) expect(templates).toContain(match[1]);
  });

  // Skipped until #422: freshness.ageSeconds comes from the wall clock, so the two runs differ
  // by a second when they straddle a boundary. Re-enable once both runs share a fixed clock.
  it.skip("honours the processGuide opt-out without changing the briefing evidence", async () => {
    const on = JSON.parse((await run(["--json"], null)).out);
    const off = JSON.parse((await run(["--json"], '{"schemaVersion":1,"processGuide":false}')).out);
    expect(off.process).toMatchObject({ enabled: false, source: "config", guide: null });
    expect(off.process.pointer).toContain(off.process.policyVersion);
    const { process: _a, ...restOn } = on;
    const { process: _b, ...restOff } = off;
    expect(restOff).toEqual(restOn);
    const text = (await run([], '{"schemaVersion":1,"processGuide":false}')).out;
    expect(text).not.toContain("WORKFLOW\n");
    expect(text).not.toContain("Workflow guide off");
  });

  it("lets CLI flags override configuration, even when it is invalid, and refuses both", async () => {
    const forced = JSON.parse(
      (await run(["--json", "--guide"], '{"schemaVersion":1,"processGuide":false}')).out,
    );
    expect(forced.process).toMatchObject({ enabled: true, source: "cli" });
    const hidden = JSON.parse((await run(["--json", "--no-guide", "--issue", "1"], "{oops")).out);
    expect(hidden.process).toMatchObject({ enabled: false, source: "cli", diagnostics: [] });
    expect(() => argumentsFor(["--guide", "--no-guide"])).toThrow(/either --guide or --no-guide/);
  });

  it("falls back to the default with a diagnostic for malformed, future, unknown or mismatched config", async () => {
    for (const raw of [
      "{oops",
      '{"schemaVersion":99}',
      '{"schemaVersion":1,"surprise":true}',
      '{"schemaVersion":1,"processGuide":"no"}',
    ]) {
      const { code, out } = await run(["--json", "--issue", "1"], raw);
      expect(code).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed.process).toMatchObject({ enabled: false, source: "default" });
      expect(parsed.process.diagnostics[0]).toMatch(/not applied/);
      expect(parsed.completeness.complete).toBe(true);
    }
    const other = JSON.parse(
      (await run(["--json"], '{"schemaVersion":1,"processGuide":false}', "git@github.com:a/b.git"))
        .out,
    );
    expect(other.process).toMatchObject({ enabled: false, source: "default" });
    expect(other.process.diagnostics[0]).toMatch(/No matching local project setting/);
    expect((await run(["--issue", "1"], "{oops")).out).toContain(
      "CONFIG: Repository configuration not applied",
    );
  });

  it("counts against the text budget and reports omission instead of truncating", async () => {
    const { out } = await run(["--guide", "--max-chars", "600"], null);
    expect(out).not.toContain("WORKFLOW\n");
    expect(out).toContain("Workflow guide omitted by text budget. Full guide: pdb process");
  });

  it("never exceeds --max-chars with the guide on or off (reserved footer)", async () => {
    const off = '{"schemaVersion":1,"processGuide":false}';
    for (const raw of ['{"schemaVersion":1,"processGuide":true}', off]) {
      // The header and required footer are irreducible; every budget above them must hold.
      const floor = (await run(["--max-chars", "1"], raw)).out.length;
      for (let max = floor; max <= floor + 3000; max += 97) {
        const { out } = await run(["--max-chars", String(max)], raw);
        expect(out.length, `max-chars ${max}, guide ${raw ? "off" : "on"}`).toBeLessThanOrEqual(
          max,
        );
        if (raw === off) expect(out).not.toContain("Workflow guide off");
        else expect(out).toContain("pdb process");
      }
    }
  });

  it("serves help and the full guide locally, without GitHub or configuration", async () => {
    let helpText = "";
    let guide = "";
    let json = "";
    const offline = {
      collect: async () => {
        throw new Error("no network");
      },
      currentRepository: async () => {
        throw new Error("no network");
      },
    };
    expect(await main(["--help"], async (t) => void (helpText = t), offline)).toBe(0);
    expect(await main(["process"], async (t) => void (guide = t), offline)).toBe(0);
    expect(await main(["process", "--json"], async (t) => void (json = t), offline)).toBe(0);
    expect(helpText).toContain("Workflow (generated from the registered policy):");
    expect(helpText).toContain(`only ${mutatingCommands().join(", ")} do`);
    expect(guide).toContain(`policy ${policyVersion()}`);
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, policyVersion: policyVersion() });
  });

  it("changes the policy version with semantics, not with rendering", () => {
    const rules = guideRules();
    expect(policyVersion(rules)).toBe(policyVersion(guideRules()));
    const changed = rules.map((rule) =>
      rule.id === "one-claim" ? { ...rule, parameters: { staleHours: 72 } } : rule,
    );
    expect(policyVersion(changed)).not.toBe(policyVersion(rules));
    const reordered = rules.map((rule) => ({
      detail: rule.detail,
      summary: rule.summary,
      parameters: rule.parameters,
      id: rule.id,
    }));
    expect(policyVersion(reordered)).toBe(policyVersion(rules));
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
