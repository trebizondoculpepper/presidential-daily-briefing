/**
 * Routine shortlist hydration (#368, collection-profiles.md "Ranking before limiting"): reads are
 * counted through an injected gh boundary. A large repository hydrates only the shortlist's
 * worth of items; an item that was not hydrated is never shown, never clean, and is disclosed.
 */
import { describe, expect, it } from "vite-plus/test";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../../scripts/benchmark-isolation.js";
import { readBriefing } from "../briefing/service.js";
import type { ReadRuntime } from "../briefing/service.js";
import { by, clock, issue, page, pr, repo, time } from "../testing/snapshots.js";
import { RateLimitError } from "./dependencies.js";
import { collect } from "./github.js";
import type { Query } from "./github.js";
import { collectShortlist } from "./shortlist.js";
import { deliveryMarker } from "../workflow/delivery.js";
import type { Rest } from "./github.js";
import type { Snapshot } from "./types.js";
import type { Issue, PullRequest } from "./types.js";

/** A fake repository served through the gh query boundary, counting every read by kind. */
function fakeGitHub(issues: Issue[], prs: PullRequest[]) {
  const calls = {
    discoveryPages: 0,
    fullPages: 0,
    issueBatches: [] as number[][],
    pullRequests: [] as number[],
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
    if (/pullRequest\(number:/.test(source)) {
      const number = Number(variables.number);
      calls.pullRequests.push(number);
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
          numbers.map((n, i) => [`i${i}`, clone(issues.find((x) => x.number === n) ?? null)]),
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
    expect(snapshot.warnings.some((w) => w.includes("failed or were stopped for 15"))).toBe(true);
    // One refused batch was sent; nothing was sent after it.
    expect(batches).toBe(2);
  });
});
