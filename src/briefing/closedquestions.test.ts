/**
 * Closed-ticket question scans kept between `pdb serve` requests (#414,
 * doc/reports/closed-question-discovery.md): bounded per request, continued from memory, refreshed
 * incrementally with an overlapping `since`, and separate per served project and repository.
 * Injected gh and clock throughout.
 */
import { describe, expect, it } from "vite-plus/test";
import type { Comment, Issue } from "../github/types.js";
import type { Query } from "../github/github.js";
import { ClosedQuestionStore, discoverClosedQuestions } from "./closedquestions.js";
import type { ClosedQuestionRuntime, ClosedScanSlot } from "./closedquestions.js";
import { questionMarker } from "../workflow/claims.js";
import { resolutionMarker } from "../workflow/claimactivity.js";
import { markerTrust } from "../workflow/delivery.js";
import { permissions } from "../testing/fakegh.js";
import { by, issue, page, repo, snapshot } from "../testing/snapshots.js";
import { readBriefing } from "./service.js";

let id = 1000;
function question(n: number, text: string): Comment {
  id++;
  return {
    ...by("agent-account"),
    databaseId: id,
    url: `https://github.com/${repo}/issues/${n}#issuecomment-${id}`,
    createdAt: "2026-11-12T10:00:00Z",
    body: [
      "### Questions for the designer",
      "",
      "Designer: `owner` · Raised by: `kavya`",
      "",
      "**Why:** Undecided.",
      "",
      `1. ${text}`,
      "",
      questionMarker(String(id).padStart(16, "0"), repo, n),
    ].join("\n"),
  };
}
function resolve(n: number, q: Comment): Comment {
  id++;
  return {
    ...by("agent-account"),
    databaseId: id,
    url: `https://github.com/${repo}/issues/${n}#issuecomment-${id}`,
    createdAt: "2026-11-12T11:00:00Z",
    body: resolutionMarker({
      v: 1,
      op: "resolve",
      opId: String(id).padStart(32, "0"),
      repository: repo,
      issue: n,
      questionCommentId: String(q.databaseId),
      questionOpId: /needs-human:([0-9a-f]{16})/.exec(q.body)![1]!,
      agent: "kavya",
      reason: "Answered.",
    }),
  };
}
const closed = (n: number, comments: Comment[], updatedAt = "2026-11-10T00:00:00Z"): Issue => ({
  ...issue(n, []),
  state: "CLOSED",
  updatedAt,
  comments: page(comments),
});

/** A mutable GitHub: closed issues listed newest update first, with `since` filtering. */
function gh(initial: Issue[], later: Record<number, Comment[]> = {}) {
  const state = {
    issues: [...initial],
    later,
    gone: new Set<number>(),
    failing: new Set<number>(),
  };
  const calls: string[] = [];
  const query: Query = async (source, variables) => {
    const size = Number(/first:(\d+)/.exec(source)![1]);
    if (source.includes("issueOrPullRequest")) {
      calls.push(`comments #${variables.number}`);
      if (state.gone.has(Number(variables.number)))
        return { repository: { issueOrPullRequest: null } } as never;
      if (state.failing.has(Number(variables.number))) throw new Error("HTTP 502");
      return {
        repository: {
          issueOrPullRequest: { comments: page(state.later[Number(variables.number)] ?? []) },
        },
      } as never;
    }
    const since = variables.since === undefined ? null : String(variables.since);
    calls.push(
      since
        ? `since ${since} ${variables.cursor ?? "start"}`
        : `inventory ${variables.cursor ?? "start"}`,
    );
    const list = [...state.issues]
      .filter((i) => !since || Date.parse(i.updatedAt) >= Date.parse(since))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const start = variables.cursor === undefined ? 0 : Number(variables.cursor);
    const more = start + size < list.length;
    return {
      repository: {
        issues: page(list.slice(start, start + size), more, more ? String(start + size) : null),
      },
    } as never;
  };
  return { state, calls, query };
}

const clockAt = (iso: string) => {
  const c = { t: Date.parse(iso) };
  return { c, now: () => new Date(c.t) };
};

function runtime(
  g: ReturnType<typeof gh>,
  now: () => Date,
  slot: ClosedScanSlot | undefined,
  bounds: ClosedQuestionRuntime["bounds"] = { inventoryPages: 1, pageSize: 1 },
): ClosedQuestionRuntime {
  return {
    query: g.query,
    trust: markerTrust(permissions()),
    now,
    bounds,
    ...(slot ? { slot } : {}),
  };
}

describe("closed-ticket scans kept between serve requests (#414)", () => {
  it("continues the baseline across requests within the per-request bound", async () => {
    const q = question(1, "First?");
    const g = gh([
      closed(1, [q], "2026-11-10T03:00:00Z"),
      closed(2, [], "2026-11-10T02:00:00Z"),
      closed(3, [question(3, "Third?")], "2026-11-10T01:00:00Z"),
    ]);
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);

    const first = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(first.coverage).toMatchObject({
      complete: false,
      phase: "baseline",
      requests: 1,
      discovered: 1,
      scan: { origin: "fresh", watermark: null },
    });
    expect(first.sources.map((s) => s.issue.number)).toEqual([1]);
    expect(first.warnings.join(" ")).toMatch(/The next read continues the scan/);

    c.t += 60_000;
    const second = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(second.coverage).toMatchObject({ complete: false, discovered: 2, requests: 1 });
    // Questions found earlier stay visible while the scan continues.
    expect(second.sources.map((s) => s.issue.number)).toEqual([1]);
    expect(second.coverage.scan).toMatchObject({
      origin: "continued",
      continuation: first.coverage.scan.continuation,
    });

    c.t += 60_000;
    const third = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(third.coverage).toMatchObject({
      complete: true,
      discovered: 3,
      inventory: { complete: true },
      scan: { watermark: "2026-11-15T12:00:00.000Z", generation: 1 },
    });
    expect(third.sources.map((s) => s.issue.number).sort((x, y) => x - y)).toEqual([1, 3]);
    expect(third.coverage.scan.continuation).not.toBe(first.coverage.scan.continuation);
    expect(g.calls).toEqual(["inventory start", "inventory 1", "inventory 2"]);

    // After the baseline: an overlapping since pass refolds what changed, here a resolution.
    g.state.issues[0] = closed(1, [q, resolve(1, q)], "2026-11-15T12:05:00Z");
    c.t = Date.parse("2026-11-15T12:10:00Z");
    const refreshed = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(g.calls.at(-1)).toBe("since 2026-11-15T11:55:00.000Z start");
    expect(refreshed.coverage).toMatchObject({
      phase: "refresh",
      complete: true,
      scan: { watermark: "2026-11-15T12:10:00.000Z", generation: 2 },
      records: { resolved: 1, noOutcome: 1 },
    });
  });

  it("never advances the watermark past a refresh it could not finish", async () => {
    const g = gh([closed(1, [question(1, "Q?")], "2026-11-10T00:00:00Z")]);
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    await discoverClosedQuestions(repo, runtime(g, now, slot));
    // Two changed issues, one page per read: the refresh needs two reads.
    g.state.issues.push(
      closed(2, [question(2, "New?")], "2026-11-15T12:01:00Z"),
      closed(3, [], "2026-11-15T12:02:00Z"),
    );
    c.t = Date.parse("2026-11-15T12:03:00Z");
    const partial = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(partial.coverage).toMatchObject({
      complete: false,
      phase: "refresh",
      scan: { watermark: "2026-11-15T12:00:00.000Z", refreshSince: "2026-11-15T11:55:00.000Z" },
    });
    expect(partial.warnings.join(" ")).toMatch(/changed since .* were not all read/);
    c.t = Date.parse("2026-11-15T12:04:00Z");
    const done = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(done.coverage).toMatchObject({
      complete: true,
      scan: { watermark: "2026-11-15T12:03:00.000Z", refreshSince: null },
    });
    expect(done.sources.map((s) => s.issue.number).sort((x, y) => x - y)).toEqual([1, 2]);
  });

  it("keeps each served project and repository separate", async () => {
    const store = new ClosedQuestionStore(30 * 60_000);
    const g = gh([closed(1, []), closed(2, [])]);
    const { now } = clockAt("2026-11-15T12:00:00Z");
    const a = store.slot("/work/a", repo);
    const b = store.slot("/work/b", repo);
    expect(store.slot("/work/a", repo.toUpperCase())).toBe(a);
    await discoverClosedQuestions(repo, runtime(g, now, a));
    const other = await discoverClosedQuestions(repo, runtime(g, now, b));
    expect(other.coverage).toMatchObject({ discovered: 1, scan: { origin: "fresh" } });
    expect(other.coverage.scan.continuation).not.toBe(
      (await discoverClosedQuestions(repo, runtime(g, now, a))).coverage.scan.continuation,
    );
  });

  it("restarts explicitly after idle expiry or a manual refresh, never claiming old coverage", async () => {
    const store = new ClosedQuestionStore(60_000);
    const g = gh([closed(1, []), closed(2, [])]);
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = store.slot(undefined, repo);
    await discoverClosedQuestions(repo, runtime(g, now, slot));
    c.t += 120_000;
    const expired = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(expired.coverage).toMatchObject({
      complete: false,
      discovered: 1,
      scan: { origin: "restarted", restartReason: expect.stringMatching(/idle longer than 60s/) },
    });
    expect(expired.warnings.join(" ")).toMatch(/closed-ticket scan restarted/);
    store.reset(repo, "a manual refresh discarded the previous scan");
    const refreshed = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(refreshed.coverage.scan).toMatchObject({
      origin: "restarted",
      restartReason: "a manual refresh discarded the previous scan",
    });
    // Reported once: the following read continues.
    const next = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(next.coverage.scan.origin).toBe("continued");
  });

  it("serialises concurrent reads of one scan so no page is read twice", async () => {
    const g = gh([closed(1, []), closed(2, []), closed(3, [])]);
    const { now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    await Promise.all([1, 2, 3].map(() => discoverClosedQuestions(repo, runtime(g, now, slot))));
    expect(g.calls).toEqual(["inventory start", "inventory 1", "inventory 2"]);
  });

  it("keeps a failed page unread and retries it next time", async () => {
    const g = gh([closed(1, []), closed(2, [])]);
    const { now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    await discoverClosedQuestions(repo, runtime(g, now, slot));
    const failing: Query = async () => {
      throw new Error("HTTP 502");
    };
    const failed = await discoverClosedQuestions(repo, {
      ...runtime(g, now, slot),
      query: failing,
    });
    expect(failed.coverage).toMatchObject({ complete: false, failure: "inventory: HTTP 502" });
    const retried = await discoverClosedQuestions(repo, runtime(g, now, slot));
    expect(retried.coverage).toMatchObject({ complete: true, discovered: 2 });
    expect(g.calls).toEqual(["inventory start", "inventory 1"]);
  });

  it("without a slot each read starts afresh, as the CLI does", async () => {
    const g = gh([closed(1, []), closed(2, [])]);
    const { now } = clockAt("2026-11-15T12:00:00Z");
    for (let i = 0; i < 2; i++) {
      const read = await discoverClosedQuestions(repo, runtime(g, now, undefined));
      expect(read.coverage).toMatchObject({ discovered: 1, scan: { origin: "fresh" } });
    }
  });

  it("keeps questions visible while a changed long history is reread (Codex, #609)", async () => {
    const late = question(9, "On the second page?");
    const long = (updatedAt: string): Issue => ({
      ...closed(9, [], updatedAt),
      comments: page([], true, "p1"),
    });
    const g = gh([long("2026-11-10T00:00:00Z")], { 9: [late] });
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    const baseline = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    expect(baseline.coverage.complete).toBe(true);
    expect(baseline.sources[0]!.facts[0]!.outcome).toBe("none");
    // The issue changes; this refresh may list it but not reread its later page.
    g.state.issues[0] = long("2026-11-15T12:01:00Z");
    c.t = Date.parse("2026-11-15T12:02:00Z");
    const refresh = await discoverClosedQuestions(repo, runtime(g, now, slot, { commentPages: 0 }));
    expect(refresh.coverage.complete).toBe(false);
    expect(refresh.sources.map((x) => x.issue.number)).toEqual([9]);
    expect(refresh.sources[0]!.facts[0]!.outcome).toBe("unknown");
    // Once the reread completes the earlier copy is dropped and the question is current again.
    const done = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    expect(done.coverage.complete).toBe(true);
    expect(done.sources[0]!.facts).toEqual([
      { trust: "trusted", to: "owner", version: 2, outcome: "none" },
    ]);
  });

  it("never settles a question with a resolution not yet reread (Codex, #609)", async () => {
    const asked = question(10, "Resolved on a later page?");
    const answer = resolve(10, asked);
    const long = (updatedAt: string): Issue => ({
      ...closed(10, [asked], updatedAt),
      comments: page([asked], true, "p1"),
    });
    const g = gh([long("2026-11-10T00:00:00Z")], { 10: [answer] });
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    const baseline = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    expect(baseline.coverage.records).toMatchObject({ resolved: 1 });
    // The resolution may have been edited or deleted: until reread it settles nothing.
    g.state.issues[0] = long("2026-11-15T12:01:00Z");
    g.state.later[10] = [];
    c.t = Date.parse("2026-11-15T12:02:00Z");
    const refresh = await discoverClosedQuestions(repo, runtime(g, now, slot, { commentPages: 0 }));
    expect(refresh.sources[0]!.facts[0]!.outcome).toBe("unknown");
    const done = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    expect(done.sources[0]!.facts[0]!.outcome).toBe("none");
  });

  it("reads the scan through the uncached boundary, never memoised pages (Codex, #609)", async () => {
    const g = gh([closed(1, [question(1, "Q?")])]);
    const memoised: string[] = [];
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    const read = await readBriefing(
      {
        collect: async () => snapshot([issue(3)], []),
        dependencyReport: (async () => {
          throw new Error("not used");
        }) as never,
        rest: async () => ({
          status: 200,
          body: { role_name: "write", user: { login: "agent-account" } },
        }),
        queryWith: () => async (source) => {
          memoised.push(source);
          return { repository: { pullRequest: null } } as never;
        },
        closedQueryWith: () => g.query,
        closedQuestions: slot,
        now: () => new Date("2026-11-15T12:00:00Z"),
        guide: { cwd: "/nonexistent-414" },
      },
      { repository: repo, role: "human", agent: "owner", limit: 10, maxChars: 10000 },
    );
    expect(read.kind).toBe("report");
    expect(g.calls).toEqual(["inventory start"]);
    expect(memoised.some((q) => q.includes("states:CLOSED"))).toBe(false);
    expect(slot.state?.watermark).not.toBeNull();
  });

  it("lets other sources progress past a failing or vanished one (Codex, #609)", async () => {
    const long = (n: number, comments: Comment[]): Issue => ({
      ...closed(n, comments),
      comments: page(comments, true, "p1"),
    });
    const asked = question(11, "On a deleted issue?");
    const g = gh([long(11, [asked]), long(12, []), long(13, [])], {
      12: [question(12, "Reachable?")],
    });
    g.state.gone.add(11);
    g.state.failing.add(13);
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    const first = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    // #12 was hydrated despite #11 vanishing and #13 failing.
    expect(first.sources.map((x) => x.issue.number).sort((a, b) => a - b)).toEqual([11, 12]);
    expect(first.sources.find((x) => x.issue.number === 11)!.facts[0]!.outcome).toBe("unknown");
    expect(first.warnings.join(" ")).toMatch(/no longer returns this issue/);
    expect(first.coverage).toMatchObject({ complete: false, pending: [long(13, []).url] });
    expect(first.coverage.scan.watermark).toBeNull();
    // Once the transient failure clears, the baseline finishes despite the vanished issue.
    g.state.failing.clear();
    c.t += 60_000;
    const second = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    expect(second.coverage.scan.watermark).not.toBeNull();
    expect(second.coverage.complete).toBe(false);
    expect(g.calls.filter((x) => x === "comments #11")).toHaveLength(1);
  });

  it("keeps known questions and the diagnostic when a refreshed issue vanishes (Codex, #609)", async () => {
    const late = question(14, "Beyond the first page?");
    const long = (n: number, updatedAt: string): Issue => ({
      ...closed(n, [], updatedAt),
      comments: page([], true, "p1"),
    });
    const g = gh([long(14, "2026-11-10T00:00:00Z"), long(15, "2026-11-10T00:00:00Z")], {
      14: [late],
      15: [],
    });
    const { c, now } = clockAt("2026-11-15T12:00:00Z");
    const slot = new ClosedQuestionStore(30 * 60_000).slot(undefined, repo);
    await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
    g.state.issues = [long(14, "2026-11-15T12:01:00Z"), long(15, "2026-11-15T12:01:00Z")];
    g.state.gone.add(14).add(15);
    for (const minute of [2, 3]) {
      c.t = Date.parse(`2026-11-15T12:0${minute}:00Z`);
      const read = await discoverClosedQuestions(repo, runtime(g, now, slot, {}));
      expect(read.sources.map((x) => x.issue.number)).toEqual([14]);
      expect(read.sources[0]!.facts[0]!.outcome).toBe("unknown");
      expect(read.coverage.complete).toBe(false);
      expect(read.warnings.filter((w) => /no longer returns this issue/.test(w))).toHaveLength(2);
    }
  });
});
