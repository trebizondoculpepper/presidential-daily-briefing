/**
 * Routine shortlist hydration (#368, collection-profiles.md "Ranking before limiting"): reads are
 * counted through an injected gh boundary. A large repository hydrates only the shortlist's
 * worth of items; an item that was not hydrated is never shown, never clean, and is disclosed.
 */
import { describe, expect, it } from "vite-plus/test";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { readBriefing } from "../briefing/service.js";
import { main } from "../cli.js";
import type { ReadRuntime } from "../briefing/service.js";
import { by, clock, issue, page, pr, repo, time } from "../testing/snapshots.js";
import { RateLimitError } from "./dependencies.js";
import { collect, prop } from "./github.js";
import type { Query } from "./github.js";
import { collectShortlist } from "./shortlist.js";
import { deliveryMarker } from "../workflow/delivery.js";
import type { Rest } from "./github.js";
import type { Snapshot } from "./types.js";
import type { Issue, PullRequest } from "./types.js";

/** A fake repository served through the gh query boundary, counting every read by kind. */
function fakeGitHub(
  issues: Issue[],
  prs: PullRequest[],
  /** Replace the hydration answer for an issue or PR number (null, malformed, closed). */
  answers: { issue?: Record<number, unknown>; pr?: Record<number, unknown> } = {},
) {
  const calls = {
    discoveryPages: 0,
    fullPages: 0,
    issueBatches: [] as number[][],
    pullRequests: [] as number[],
    labels: 0,
    other: [] as string[],
  };
  const clone = <T>(value: T): T => structuredClone(value);
  const discovered = <T extends Issue>(item: T) => {
    const copy = clone(item) as Partial<PullRequest>;
    for (const key of ["body", "comments", "reviews", "reviewThreads", "commits", "lastEditedAt"])
      delete copy[key as keyof PullRequest];
    for (const key of ["mergeable", "mergeStateStatus", "reviewDecision"])
      delete copy[key as keyof PullRequest];
    // As GitHub does: an issue whose comments mention a PR leaves a cross-reference on it.
    if ("headRefOid" in item)
      Object.assign(copy, {
        timelineItems: page(
          issues
            .filter((other) => other.comments.nodes.some((c) => c.body.includes(item.url)))
            .map((other) => ({
              source: { __typename: "Issue", number: other.number, url: other.url, state: "OPEN" },
            })),
        ),
      });
    return copy;
  };
  const connection = <T extends Issue>(items: T[], source: string, cursor?: string) => {
    const size = Number(/(?:issues|pullRequests)\(first:(\d+)/.exec(source)?.[1]);
    const start = cursor ? Number(cursor) : 0;
    const full = source.includes("comments(first:100");
    if (full) calls.fullPages++;
    else calls.discoveryPages++;
    const more = start + size < items.length;
    return page(
      items.slice(start, start + size).map((item) => (full ? clone(item) : discovered(item))),
      more,
      more ? String(start + size) : null,
    );
  };
  const query: Query = async (source, variables) => {
    const cursor = variables.cursor as string | undefined;
    if (/l0:label\(/.test(source)) {
      calls.labels++;
      const name = String(variables.l0);
      return {
        repository: { l0: { name }, s0: { nodes: [{ name }], pageInfo: { hasNextPage: false } } },
      };
    }
    if (/pullRequest\(number:/.test(source)) {
      const number = Number(variables.number);
      calls.pullRequests.push(number);
      if (answers.pr && number in answers.pr)
        return { repository: { pullRequest: clone(answers.pr[number]) } };
      return { repository: { pullRequest: clone(prs.find((p) => p.number === number) ?? null) } };
    }
    if (/i0:issue\(/.test(source)) {
      const numbers = Object.keys(variables)
        .filter((key) => /^n\d+$/.test(key))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map((key) => Number(variables[key]));
      calls.issueBatches.push(numbers);
      return {
        repository: Object.fromEntries(
          numbers.map((n, i) => [
            `i${i}`,
            answers.issue && n in answers.issue
              ? clone(answers.issue[n])
              : clone(issues.find((x) => x.number === n) ?? null),
          ]),
        ),
      };
    }
    if (/\bissues\(first:/.test(source))
      return { repository: { issues: connection(issues, source, cursor) } };
    if (/\bpullRequests\(first:/.test(source))
      return { repository: { pullRequests: connection(prs, source, cursor) } };
    calls.other.push(source);
    throw new Error(`unexpected query: ${source.slice(0, 80)}`);
  };
  return { query, calls };
}

const at = (n: number) => new Date(Date.parse(time) - n * 3_600_000).toISOString();
/** An eligible ticket, older as `n` grows (so oldest-first pickup prefers high numbers). */
const ready = (n: number, labels = ["status:ready"]): Issue => ({
  ...issue(n, labels),
  createdAt: at(n),
  updatedAt: at(n),
  closedByPullRequestsReferences: page([]),
});
const config = (engine: "datalog" | "typescript") => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit(repo),
  fs: {
    ...emptyFileSystem,
    readText: async (path: string) =>
      path.endsWith("triage.toml") ? `schemaVersion = 1\n[briefing]\nengine = "${engine}"\n` : null,
  },
});
const runtimeFor = (
  fake: ReturnType<typeof fakeGitHub>,
  engine: "datalog" | "typescript",
  shortlist: boolean,
): ReadRuntime => ({
  collect: (repository, options) => collect(repository, options, fake.query, clock),
  ...(shortlist ? { collectShortlist } : {}),
  dependencyReport: async () => {
    throw new Error("not used");
  },
  query: fake.query,
  now: clock,
  engineClock: () => 0,
  guide: config(engine),
  estimation: config(engine),
});
const request = {
  repository: repo,
  agent: "kavya",
  role: "implementer",
  limit: 10,
  maxChars: 20000,
};
type Report = {
  subjects: { url: string }[];
  rankedActions: unknown;
  sections: unknown;
  role: unknown;
  completeness: { complete: boolean; warnings: string[] };
  shortlist?: {
    hydrated: string[];
    notHydrated: { number: number; url: string; reason: string }[];
    provisional: boolean;
  };
  collection?: { profile: string; telemetry: { requests: number } };
  delivery?: { complete: boolean; omissions: string[] };
};
const reportOf = async (runtime: ReadRuntime, maxChars = request.maxChars) => {
  const read = await readBriefing(runtime, { ...request, maxChars });
  if (read.kind !== "report") throw new Error("expected a report");
  return { report: read.report as unknown as Report, text: read.text };
};

/** A small repository where every relevant fact depends on hydration (comments, reviews). */
const smallRepository = () => {
  const claimed = ready(3, ["status:in-progress", "agent:kavya"]);
  claimed.comments = page([
    {
      body: "Claiming this.",
      url: `${claimed.url}#issuecomment-1`,
      databaseId: 1,
      createdAt: time,
      ...by("kavya"),
    },
  ]);
  const linked: PullRequest = {
    ...pr(),
    number: 9,
    url: `https://github.com/${repo}/pull/9`,
    labels: page([{ name: "agent:kavya" }]),
    closingIssuesReferences: page([{ number: 3, url: claimed.url }]),
  };
  claimed.closedByPullRequestsReferences = page([{ number: 9, url: linked.url, state: "OPEN" }]);
  const issues = [
    ready(1),
    ready(2),
    claimed,
    ready(4, ["status:needs-design"]),
    ready(5),
    ready(6),
  ];
  return fakeGitHub(issues, [linked]);
};

describe("routine briefing: discover all, rank, hydrate only the shortlist (#368)", () => {
  for (const engine of ["datalog", "typescript"] as const)
    it(`matches the full snapshot exactly when every relevant fact is hydrated (${engine})`, async () => {
      const full = await reportOf(runtimeFor(smallRepository(), engine, false));
      const short = await reportOf(runtimeFor(smallRepository(), engine, true));
      expect(short.report.subjects.map((s) => s.url)).toEqual(
        full.report.subjects.map((s) => s.url),
      );
      expect(short.report.rankedActions).toEqual(full.report.rankedActions);
      expect(short.report.sections).toEqual(full.report.sections);
      expect(short.report.role).toEqual(full.report.role);
      expect(short.report.subjects).toEqual(full.report.subjects);
      expect(short.report.collection?.profile).toBe("briefing-shortlist-v1");
      expect(full.report.shortlist).toBeUndefined();
    });

  it("hydrates only the shortlist of a large repository and discloses the rest", async () => {
    const issues = Array.from({ length: 120 }, (_, i) => ready(i + 1));
    const owned = ready(121, ["status:in-progress", "agent:kavya"]);
    const linked: PullRequest = {
      ...pr(),
      number: 300,
      url: `https://github.com/${repo}/pull/300`,
      closingIssuesReferences: page([{ number: 151, url: owned.url }]),
    };
    owned.closedByPullRequestsReferences = page([{ number: 300, url: linked.url, state: "OPEN" }]);
    const before = fakeGitHub([...issues, owned], [linked]);
    await reportOf(runtimeFor(before, "typescript", false));
    // The full snapshot reads every open item with its comments, reviews and checks.
    expect(before.calls.fullPages).toBe(4);

    const fake = fakeGitHub([...issues, owned], [linked]);
    const { report, text } = await reportOf(runtimeFor(fake, "typescript", true));
    const shortlist = report.shortlist!;
    const hydratedIssues = fake.calls.issueBatches.flat();
    // No full-inventory page; discovery is 3 issue pages (121 / 50) and 1 PR page.
    expect(fake.calls.fullPages).toBe(0);
    expect(fake.calls.discoveryPages).toBe(4);
    expect(fake.calls.other).toEqual([]);
    // Only the shown subjects and their closing links were hydrated, each exactly once.
    expect(new Set(hydratedIssues).size).toBe(hydratedIssues.length);
    expect(hydratedIssues.length + fake.calls.pullRequests.length).toBe(shortlist.hydrated.length);
    expect(shortlist.hydrated.length).toBeLessThanOrEqual(40);
    expect(shortlist.hydrated.length).toBeLessThan(report.subjects.length + 5);
    expect(fake.calls.issueBatches.every((batch) => batch.length <= 10)).toBe(true);
    // The owned ticket and its PR are hydrated, so their records were actually read.
    expect(shortlist.hydrated).toEqual(expect.arrayContaining([owned.url, linked.url]));
    // Every shown subject was hydrated; every other open item is disclosed as not hydrated.
    const hydrated = new Set(shortlist.hydrated);
    for (const subject of report.subjects) expect(hydrated.has(subject.url)).toBe(true);
    expect(shortlist.notHydrated.length).toBe(122 - shortlist.hydrated.length);
    expect(shortlist.provisional).toBe(true);
    // Request count: discovery pages, issue batches and PR reads, nothing else.
    expect(report.collection?.telemetry.requests).toBe(
      4 + fake.calls.issueBatches.length + fake.calls.pullRequests.length,
    );
    // Interim default (#368 question): unread shortlist items alone are provisional, not
    // incomplete; the notice is still shown.
    expect(report.completeness.complete).toBe(true);
    expect(text).toContain("PROVISIONAL: Shortlist:");
    expect(text).toContain(
      `${shortlist.notHydrated.length} of 122 open item(s) were discovered but not hydrated`,
    );
    expect(text).toContain("pdb --issue N");
    // The notice leads and stays inside a small text budget.
    for (const maxChars of [1200, 2500]) {
      const small = await reportOf(
        runtimeFor(fakeGitHub([...issues, owned], [linked]), "typescript", true),
        maxChars,
      );
      expect(small.text.length).toBeLessThanOrEqual(maxChars);
      expect(small.text.startsWith("PROVISIONAL: Shortlist:")).toBe(true);
    }
    // Delivery records on unhydrated issues are unknown, never "no delivery".
    expect(report.delivery?.complete).toBe(false);
    expect(report.delivery?.omissions.at(-1)).toContain("not hydrated are unknown");
  });

  it("never shows an item it could not hydrate, and never as clean evidence", async () => {
    // Ten eligible tickets; the selector wants all of them, but only three may be hydrated.
    const issues = Array.from({ length: 10 }, (_, i) => ready(i + 1));
    // The important record sits on a ticket the bounded read cannot reach.
    issues[9].comments = page([
      { body: "Blocked: do not start.", url: `${issues[9].url}#c`, createdAt: time, ...by() },
    ]);
    const fake = fakeGitHub(issues, []);
    const shown: string[][] = [];
    const snapshot = await collectShortlist(
      repo,
      {
        select: async (candidates) => {
          const urls = candidates.issues.map((i) => i.url);
          shown.push(urls);
          return urls;
        },
        bounds: { maxHydrated: 3 },
      },
      fake.query,
      clock,
    );
    expect(fake.calls.issueBatches.flat()).toHaveLength(3);
    const shortlist = snapshot.shortlist!;
    expect(shortlist.hydrated).toHaveLength(3);
    // The unreachable subjects are withdrawn, not shown with empty comments.
    expect(snapshot.issues.map((i) => i.url)).toEqual(shortlist.hydrated);
    expect(snapshot.issues.every((i) => i.body !== "")).toBe(true);
    expect(shortlist.notHydrated.map((i) => i.number)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(shortlist.notHydrated.every((i) => i.reason === "hydration-cap")).toBe(true);
    expect(shortlist.provisional).toBe(true);
    const coverage = snapshot.collection!.coverage.filter((c) => c.subject === `${repo}#10`);
    expect(coverage).toEqual([
      expect.objectContaining({ source: "issue", state: "not-requested", observedAt: null }),
    ]);
    expect(shortlist.notice).toContain("unknown, not empty");
    expect(shortlist.notice).toContain("hydration bound reached");
    // The bound alone is not a failed read: no completeness warning.
    expect(snapshot.warnings).toEqual([]);
  });

  it("carries discovery completeness into selection passes, not only the final record", async () => {
    // Capped discovery: more open issues exist than the page bound reads. The retained-claim
    // inventory must not be silently complete during selection (#413): a capped inventory can
    // hide the viewer's claim, so ranking during selection must see the same incompleteness the
    // final presentation reports. Regression for the Codex finding on PR #606.
    const issues = Array.from({ length: 20 }, (_, i) => ready(i + 1));
    const claimed = ready(21, ["status:in-progress", "agent:kavya"]);
    const fake = fakeGitHub([...issues, claimed], []);
    const seen: Array<Snapshot["shortlist"]> = [];
    await collectShortlist(
      repo,
      {
        select: async (candidates) => {
          seen.push(candidates.shortlist);
          return [claimed.url];
        },
        // One page of 5: discovery is capped, so the shortlist record says complete:false.
        bounds: { pages: 1, pageSize: 5, maxHydrated: 40 },
      },
      fake.query,
      clock,
    );
    expect(seen.length).toBeGreaterThan(0);
    // Every selection pass sees the same discovery-completeness facts the final record reports.
    for (const record of seen) {
      expect(record?.discovered.complete).toBe(false);
      expect(record?.provisional).toBe(true);
    }
  });

  it("hydrates the issue that holds a shown PR's records, found by cross-reference", async () => {
    const issues = Array.from({ length: 30 }, (_, i) => ready(i + 1));
    const member: PullRequest = {
      ...pr(),
      number: 40,
      url: `https://github.com/${repo}/pull/40`,
      closingIssuesReferences: page([]),
    };
    // The record about PR #40 sits on #25, which no closing link names.
    issues[24].comments = page([
      {
        body: `Submitted ${member.url} (membership complete).`,
        url: `${issues[24].url}#c`,
        ...by(),
      },
    ]);
    const fake = fakeGitHub(issues, [member]);
    const snapshot = await collectShortlist(
      repo,
      { select: async () => [member.url] },
      fake.query,
      clock,
    );
    expect(fake.calls.pullRequests).toEqual([40]);
    expect(fake.calls.issueBatches.flat()).toEqual([25]);
    expect(snapshot.issues.find((i) => i.number === 25)?.comments.nodes).toHaveLength(1);
    expect(snapshot.warnings.some((w) => w.includes("mention it"))).toBe(false);
  });

  it("inspects open PRs that are not yet visible, within the bound", async () => {
    const issues = Array.from({ length: 20 }, (_, i) => ready(i + 1));
    const prs = [50, 51, 52].map((n): PullRequest => ({
      ...pr(),
      number: n,
      url: `https://github.com/${repo}/pull/${n}`,
      closingIssuesReferences: page([]),
    }));
    const fake = fakeGitHub(issues, prs);
    // Discovery evidence makes no PR visible; their checks and reviews are unread.
    const snapshot = await collectShortlist(
      repo,
      { select: async (c) => c.issues.slice(0, 2).map((i) => i.url) },
      fake.query,
      clock,
    );
    expect(fake.calls.pullRequests.sort()).toEqual([50, 51, 52]);
    expect(snapshot.shortlist!.notHydrated.some((i) => i.kind === "pull-request")).toBe(false);
  });

  it("never splits a PR from its linked issue at the hydration bound", async () => {
    const issues = [ready(1), ready(2, ["status:in-progress", "agent:kavya"])];
    const linked: PullRequest = {
      ...pr(),
      number: 7,
      url: `https://github.com/${repo}/pull/7`,
      closingIssuesReferences: page([{ number: 2, url: issues[1].url }]),
    };
    issues[1].closedByPullRequestsReferences = page([
      { number: 7, url: linked.url, state: "OPEN" },
    ]);
    const fake = fakeGitHub(issues, [linked]);
    const snapshot = await collectShortlist(
      repo,
      { select: async () => [issues[0].url, linked.url], bounds: { maxHydrated: 2 } },
      fake.query,
      clock,
    );
    // #1 fits; PR #7 and its issue #2 need two more places, so neither is read alone.
    expect(fake.calls.issueBatches.flat()).toEqual([1]);
    expect(fake.calls.pullRequests).toEqual([]);
    expect(
      snapshot
        .shortlist!.notHydrated.filter((i) => i.reason === "hydration-cap")
        .map((i) => i.number),
    ).toEqual([2, 7]);
  });

  describe("a hydration unit is read whole or not at all (#368)", () => {
    const setup = (discoveredCloses: number[]) => {
      const a = ready(1);
      const b = ready(2);
      const p: PullRequest = {
        ...pr(),
        number: 9,
        url: `https://github.com/${repo}/pull/9`,
        closingIssuesReferences: page(
          discoveredCloses.map((n) => ({
            number: n,
            url: `https://github.com/${repo}/issues/${n}`,
          })),
        ),
      };
      a.closedByPullRequestsReferences = page([{ number: 9, url: p.url, state: "OPEN" }]);
      return { a, b, p };
    };

    it("overlapping units resolve to their union before allocation", async () => {
      // A links to P, and P closes A and B: A's unit is {A, P, B}, which does not fit in two.
      const { a, b, p } = setup([1, 2]);
      b.closedByPullRequestsReferences = page([{ number: 9, url: p.url, state: "OPEN" }]);
      const fake = fakeGitHub([a, b], [p]);
      const snapshot = await collectShortlist(
        repo,
        { select: async () => [a.url], bounds: { maxHydrated: 2 } },
        fake.query,
        clock,
      );
      expect(fake.calls.pullRequests).toEqual([]);
      expect(fake.calls.issueBatches.flat()).toEqual([]);
      expect(snapshot.shortlist!.hydrated).toEqual([]);
      expect(snapshot.shortlist!.notHydrated.map((i) => [i.number, i.reason]).sort()).toEqual([
        [1, "hydration-cap"],
        [2, "hydration-cap"],
        [9, "hydration-cap"],
      ]);
    });

    it("a PR whose hydrated links grow beyond the bound is withdrawn, not shown", async () => {
      // Discovery says P closes A; the hydrated P also closes B, and no place is left for B.
      const { a, b, p } = setup([1]);
      const hydrated = {
        ...p,
        closingIssuesReferences: page([
          { number: 1, url: a.url },
          { number: 2, url: b.url },
        ]),
      };
      const fake = fakeGitHub([a, b], [p], { pr: { 9: hydrated } });
      const snapshot = await collectShortlist(
        repo,
        { select: async () => [p.url], bounds: { maxHydrated: 2 } },
        fake.query,
        clock,
      );
      expect(fake.calls.pullRequests).toEqual([9]);
      expect(snapshot.pullRequests).toEqual([]);
      expect(snapshot.shortlist!.hydrated).not.toContain(p.url);
      expect(snapshot.shortlist!.notHydrated).toEqual(
        expect.arrayContaining([expect.objectContaining({ number: 9, reason: "hydration-cap" })]),
      );
      expect(snapshot.shortlist!.notice).toContain("hydration bound reached");
    });
  });

  it("final presentation sends nothing after the read's quota refusal, and counts it", async () => {
    const holder: Issue = {
      ...ready(1),
      comments: page([
        {
          ...by("writer"),
          databaseId: 7,
          createdAt: time,
          url: `https://github.com/${repo}/issues/1#issuecomment-7`,
          body: deliveryMarker({
            v: 1,
            op: "submit",
            opId: "op-1",
            repository: repo,
            issue: 1,
            agent: "alice",
            deliverables: [
              {
                kind: "pr",
                repository: repo,
                number: 9,
                nodeId: "PR_9",
                target: { repository: repo, branch: null },
              },
            ],
            issuedAt: time,
          } as Parameters<typeof deliveryMarker>[0]),
        },
      ]),
    };
    const sent: string[] = [];
    const rest: Rest = async (path) => {
      sent.push(`rest ${path}`);
      return { status: 200, body: { permission: "write" } };
    };
    const query: Query = async (source) => {
      sent.push(`query ${source.slice(0, 30)}`);
      return { repository: {} };
    };
    const runtime: ReadRuntime = {
      collect: async () => {
        throw new Error("not used");
      },
      collectShortlist: async (repository, options) => {
        // The collector's own read is refused for quota through the shared meter.
        const refused = options.meter!.query(
          async () => {
            throw new RateLimitError("API rate limit exceeded");
          },
          "issue",
          repository,
        );
        await refused("query{x}", {}).catch(() => undefined);
        const snapshot: Snapshot = {
          schemaVersion: 1,
          repository,
          startedAt: time,
          fetchedAt: time,
          issues: [holder],
          pullRequests: [],
          dependencies: [],
          changed: [],
          since: null,
          warnings: ["Shortlist reads failed or were stopped for 1 item(s) (#2)"],
          rateLimit: null,
          collection: options.meter!.collection(),
          shortlist: {
            schemaVersion: 1,
            profile: "briefing-shortlist-v1",
            discovered: { issues: 2, pullRequests: 0, complete: true },
            hydrated: [holder.url],
            notHydrated: [
              {
                number: 2,
                url: `https://github.com/${repo}/issues/2`,
                kind: "issue",
                reason: "not-attempted",
              },
            ],
            rounds: 1,
            provisional: true,
            notice: null,
          },
        };
        return snapshot;
      },
      dependencyReport: async () => {
        throw new Error("not used");
      },
      rest,
      query,
      now: clock,
      engineClock: () => 0,
      guide: config("typescript"),
      estimation: config("typescript"),
    };
    const { report } = await reportOf(runtime);
    // Permission lookups and delivery reads were refused by the shared meter, not sent.
    expect(sent).toEqual([]);
    expect(report.completeness.complete).toBe(false);
    const collection = report.collection as unknown as { notAttempted: string[]; quota: unknown };
    expect(collection.quota).not.toBeNull();
    expect(collection.notAttempted.length).toBeGreaterThan(0);
  });

  describe("CLI --label resolves the filter once (#368)", () => {
    const labelled = () =>
      Array.from({ length: 25 }, (_, i) => ready(i + 1, ["status:ready", "bug"]));
    const cli = async (query: Query) => {
      let out = "";
      const code = await main(
        ["--repo", repo, "--agent", "kavya", "--label", "bug", "--json", "--no-update-check"],
        async (text) => {
          out = text;
        },
        {
          collect: async () => {
            throw new Error("full read not expected");
          },
          collectShortlist,
          currentRepository: async () => repo,
          query,
          now: clock,
          guide: config("typescript"),
          estimation: config("typescript"),
        },
      );
      return { code, report: out ? (JSON.parse(out) as Report) : null };
    };

    it("after a successful shortlist read", async () => {
      const fake = fakeGitHub(labelled(), []);
      const { code, report } = await cli(fake.query);
      expect(code).toBe(0);
      expect(fake.calls.labels).toBe(1);
      expect(report?.collection?.telemetry.requests).toBe(
        1 + fake.calls.discoveryPages + fake.calls.issueBatches.length,
      );
    });

    it("after a quota refusal during hydration, sending nothing more", async () => {
      const fake = fakeGitHub(labelled(), []);
      const sent: string[] = [];
      let refused = false;
      const query: Query = async (source, variables) => {
        if (refused) sent.push(source.slice(0, 40));
        if (/i0:issue\(/.test(source)) {
          refused = true;
          throw new RateLimitError("API rate limit exceeded");
        }
        return fake.query(source, variables);
      };
      const { code, report } = await cli(query);
      // The partial briefing is presented (incomplete), not lost to a second lookup.
      expect(code).toBe(2);
      expect(report?.shortlist?.hydrated).toEqual([]);
      expect(fake.calls.labels).toBe(1);
      expect(sent).toEqual([]);
    });

    it("when discovery itself is refused, without a second lookup", async () => {
      const fake = fakeGitHub(labelled(), []);
      const query: Query = async (source, variables) => {
        if (/\bissues\(first:/.test(source)) throw new RateLimitError("API rate limit exceeded");
        return fake.query(source, variables);
      };
      // No --cache with a routine briefing: the stale fallback refuses, as for a full read.
      await expect(cli(query)).rejects.toThrow("No stale fallback");
      expect(fake.calls.labels).toBe(1);
    });
  });

  describe("every output path carries the shortlist's provisional coverage (#368)", () => {
    const large = () => {
      const issues = Array.from({ length: 60 }, (_, i) => ready(i + 1));
      return fakeGitHub(issues, []);
    };
    it("the MCP briefing: bounded unread list with its total, notice and text, in budget", async () => {
      const { Client } = await import("@modelcontextprotocol/client");
      const { InMemoryTransport } = await import("@modelcontextprotocol/server");
      const { createServer } = await import("../mcp.js");
      const { budgetBytes } = await import("../mcp/bounded.js");
      const { shortlistListed } = await import("../mcp/views.js");
      for (const maxChars of [undefined, 1500]) {
        const fake = large();
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createServer(
          {},
          {
            currentRepository: async () => repo,
            collect: async () => {
              throw new Error("full read not expected");
            },
            collectShortlist,
            dependencyReport: async () => {
              throw new Error("not used");
            },
            query: fake.query,
            now: clock,
            guide: config("typescript"),
            estimation: config("typescript"),
          },
        ).connect(serverSide);
        const client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(clientSide);
        const result = await client.callTool({
          name: "triage_briefing",
          arguments: { repo, agent: "kavya", ...(maxChars ? { maxChars } : {}) },
        });
        await client.close();
        const data = (result.structuredContent as { data: { shortlist: Record<string, unknown> } })
          .data;
        const coverage = data.shortlist;
        expect(coverage.provisional).toBe(true);
        const total = Number(coverage.notHydratedTotal);
        expect(total).toBeGreaterThan(shortlistListed);
        expect(coverage.notHydrated).toHaveLength(shortlistListed);
        expect(coverage.notHydratedOmitted).toBe(total - shortlistListed);
        expect(String(coverage.notice)).toContain("discovered but not hydrated");
        const text = (result.content as { text: string }[])[0].text;
        expect(text).toContain(`PROVISIONAL: ${total} open item(s)`);
        if (maxChars) expect(text.length).toBeLessThanOrEqual(maxChars);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budgetBytes);
      }
    });

    it("the rebrief hook's briefing text", async () => {
      const { serviceTransport } = await import("../rebrief/transports.js");
      const fake = large();
      const read = await serviceTransport({
        ...runtimeFor(fake, "typescript", true),
      }).read(
        { repository: repo, agent: "kavya", role: "implementer", platform: "codex" } as Parameters<
          ReturnType<typeof serviceTransport>["read"]
        >[0],
        new AbortController().signal,
      );
      expect(read.text.startsWith("PROVISIONAL: Shortlist:")).toBe(true);
      expect((read.report as unknown as Report).shortlist?.provisional).toBe(true);
    });
  });

  describe("an unknown answer is never closed or absent (#368)", () => {
    const collectAll = (fake: ReturnType<typeof fakeGitHub>) =>
      collectShortlist(
        repo,
        { select: async (c) => [...c.issues, ...c.pullRequests].map((i) => i.url) },
        fake.query,
        clock,
      );
    const issues = () => [ready(1), ready(2), ready(3)];

    it("a null, malformed or explicitly closed issue", async () => {
      const malformed = { ...ready(2), comments: null };
      const closed = { ...ready(3), state: "CLOSED" };
      const snapshot = await collectAll(
        fakeGitHub(issues(), [], { issue: { 1: null, 2: malformed, 3: closed } }),
      );
      expect(snapshot.issues).toEqual([]);
      const unread = snapshot.shortlist!.notHydrated;
      // Null and malformed are unavailable and disclosed; only the explicit CLOSED is gone.
      expect(unread.map((i) => [i.number, i.reason])).toEqual([
        [1, "unavailable"],
        [2, "unavailable"],
      ]);
      expect(snapshot.warnings.at(-1)).toContain("unavailable for 2 item(s) (#1, #2)");
      const failed = snapshot.collection!.coverage.filter((c) => c.state === "failed");
      expect(failed.map((c) => [c.subject, c.failure])).toEqual([
        [`${repo}#1`, "unavailable"],
        [`${repo}#2`, "unavailable"],
      ]);
    });

    it("a null or stateless PR is a failed read, not a closed one", async () => {
      const prs = [7, 8].map((n): PullRequest => ({
        ...pr(),
        number: n,
        url: `https://github.com/${repo}/pull/${n}`,
        closingIssuesReferences: page([]),
      }));
      const stateless = { ...prs[1], state: undefined };
      const snapshot = await collectAll(fakeGitHub([], prs, { pr: { 7: null, 8: stateless } }));
      expect(snapshot.pullRequests).toEqual([]);
      expect(snapshot.shortlist!.notHydrated.map((i) => [i.number, i.reason])).toEqual([
        [7, "failed"],
        [8, "failed"],
      ]);
      expect(snapshot.warnings.some((w) => w.includes("#7, #8"))).toBe(true);
    });

    it("a comment page cut short fails the item rather than shortening its history", async () => {
      const long = { ...ready(1), comments: page([], true, "c1") };
      const fake = fakeGitHub(issues(), [], { issue: { 1: long } });
      // The continuation page comes back without its connection.
      const query: Query = async (source, variables) =>
        /comments\(first:100,after/.test(source)
          ? { repository: { issue: { comments: null } } }
          : fake.query(source, variables);
      const snapshot = await collectShortlist(
        repo,
        { select: async (c) => c.issues.map((i) => i.url) },
        query,
        clock,
      );
      expect(snapshot.issues.map((i) => i.number)).toEqual([2, 3]);
      expect(snapshot.shortlist!.notHydrated).toEqual([
        expect.objectContaining({ number: 1, reason: "failed" }),
      ]);
      expect(snapshot.warnings.at(-1)).toContain("(#1)");
    });

    it("a discovery node without identity or labels, and an unreadable mention", async () => {
      const member: PullRequest = {
        ...pr(),
        number: 9,
        url: `https://github.com/${repo}/pull/9`,
        closingIssuesReferences: page([]),
      };
      const fake = fakeGitHub(issues(), [member]);
      const query: Query = async (source, variables) => {
        const answer = await fake.query(source, variables);
        const issuesPage = prop(answer, "repository", "issues", "nodes");
        if (Array.isArray(issuesPage) && !source.includes("comments(first:100"))
          (issuesPage[1] as { labels?: unknown }).labels = null;
        const prPage = prop(answer, "repository", "pullRequests", "nodes");
        if (Array.isArray(prPage))
          (prPage[0] as { timelineItems: unknown }).timelineItems = page([{ source: null }]);
        return answer;
      };
      const snapshot = await collectShortlist(
        repo,
        { select: async (c) => [...c.issues, ...c.pullRequests].map((i) => i.url) },
        query,
        clock,
      );
      expect(snapshot.shortlist!.discovered).toMatchObject({ issues: 2, complete: false });
      expect(snapshot.shortlist!.provisional).toBe(true);
      expect(snapshot.warnings.some((w) => w.includes("without their identity, labels"))).toBe(
        true,
      );
      expect(snapshot.warnings.some((w) => w.includes("could not be read"))).toBe(true);
    });

    it("an unavailable shown item makes the briefing incomplete", async () => {
      const fake = fakeGitHub(
        Array.from({ length: 6 }, (_, i) => ready(i + 1)),
        [],
        { issue: { 1: null } },
      );
      const { report } = await reportOf(runtimeFor(fake, "typescript", true));
      expect(report.completeness.complete).toBe(false);
      expect(report.completeness.warnings.join(" ")).toContain("(#1)");
      expect(report.subjects.map((s) => s.url)).not.toContain(
        `https://github.com/${repo}/issues/1`,
      );
      expect(report.shortlist!.notHydrated).toEqual(
        expect.arrayContaining([expect.objectContaining({ number: 1, reason: "unavailable" })]),
      );
    });
  });

  it("stops hydrating after a quota refusal and reports the rest not attempted", async () => {
    const issues = Array.from({ length: 25 }, (_, i) => ready(i + 1));
    const fake = fakeGitHub(issues, []);
    let batches = 0;
    const query: Query = async (source, variables) => {
      if (/i0:issue\(/.test(source) && ++batches > 1)
        throw new RateLimitError("API rate limit exceeded");
      return fake.query(source, variables);
    };
    const snapshot = await collectShortlist(
      repo,
      {
        select: async (candidates) => candidates.issues.map((i) => i.url),
        bounds: { hydrationConcurrency: 1 },
      },
      query,
      clock,
    );
    const shortlist = snapshot.shortlist!;
    expect(shortlist.hydrated).toHaveLength(10);
    expect(snapshot.issues).toHaveLength(10);
    expect(shortlist.notHydrated).toHaveLength(15);
    expect(new Set(shortlist.notHydrated.map((i) => i.reason))).toEqual(
      new Set(["failed", "not-attempted"]),
    );
    expect(snapshot.collection!.quota).not.toBeNull();
    // A quota stop is real incompleteness.
    expect(snapshot.warnings.some((w) => w.includes("unavailable for 15 item(s)"))).toBe(true);
    // One refused batch was sent; nothing was sent after it.
    expect(batches).toBe(2);
  });
});
