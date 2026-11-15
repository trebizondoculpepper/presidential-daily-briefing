/**
 * `pdb ticket N` (#197, doc/design/consolidated-ticket-view.md). Injected GraphQL, REST, trust
 * and clock boundaries; no test touches GitHub or creates anything.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { permissionLookup } from "../github/github.js";
import type { Query, RestAnswer } from "../github/github.js";
import { RateLimitError } from "../github/dependencies.js";
import type { Issue } from "../github/types.js";
import { deliveryMarker, markerTrust } from "./delivery.js";
import type { Deliverable, DeliveryComment, DeliveryRecord } from "./delivery.js";
import { readTicketStatus, targetMismatch, ticketStatusText } from "./ticketstatus.js";
import type { TicketStatus } from "./ticketstatus.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const clock = () => new Date(time);
const prLink = (n: number, r = repo) => `https://github.com/${r}/pull/${n}`;
const issueLink = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[], more = false) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "c1" : null },
});

let nextId = 5000;
const comment = (body: string, login = "writer"): DeliveryComment => {
  const id = nextId++;
  return {
    databaseId: id,
    body,
    url: `${issueLink(1)}#issuecomment-${id}`,
    createdAt: new Date(Date.parse("2026-11-13T09:00:00Z") + id * 1000).toISOString(),
    author: { __typename: "User", login },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const member = (n: number, branch: string | null = null): Deliverable => ({
  kind: "pr",
  repository: repo,
  number: n,
  nodeId: `PR_${n}`,
  target: { repository: repo, branch },
});
const submitted = (issue: number, deliverables: Deliverable[]) =>
  comment(
    deliveryMarker({
      v: 1,
      op: "submit",
      opId: `op-${nextId}`,
      repository: repo,
      issue,
      agent: "alice",
      deliverables,
      membership: "complete",
      issuedAt: time,
    } as DeliveryRecord),
  );

const ticket = (
  number: number,
  comments: DeliveryComment[] = [],
  extra: Partial<Issue> = {},
): Issue =>
  ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: issueLink(number),
    state: "OPEN",
    stateReason: null,
    createdAt: time,
    updatedAt: time,
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    blockedBy: page([]),
    blocking: page([]),
    labels: page([{ name: "complexity:M" }]),
    comments: page(comments),
    closedByPullRequestsReferences: page([]),
    ...extra,
  }) as Issue;

/** A live PR: state, head checks and reviews for the shared pr-status read. */
interface LivePr {
  state: "OPEN" | "CLOSED" | "MERGED";
  draft?: boolean;
  base?: string;
  verify?: string | null;
  approvedOn?: string;
  repository?: string;
}
const statusNode = (n: number, p: LivePr) => ({
  number: n,
  title: `PR ${n}`,
  url: prLink(n, p.repository),
  state: p.state === "MERGED" ? "MERGED" : p.state,
  isDraft: !!p.draft,
  merged: p.state === "MERGED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  headRefOid: `head${n}`,
  headRefName: `b${n}`,
  baseRefName: p.base ?? "main",
  updatedAt: time,
  body: "",
  createdAt: time,
  labels: page([]),
  commits: {
    nodes: [
      {
        commit: {
          oid: `head${n}`,
          statusCheckRollup:
            p.verify === null
              ? null
              : {
                  contexts: page([
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: p.verify ?? "SUCCESS",
                      startedAt: time,
                    },
                  ]),
                },
        },
      },
    ],
  },
  reviews: page(
    p.approvedOn
      ? [
          {
            author: { login: "rev" },
            state: "APPROVED",
            submittedAt: time,
            url: "u",
            commit: { oid: p.approvedOn },
          },
        ]
      : [],
  ),
  reviewThreads: page([]),
  comments: page([]),
  closingIssuesReferences: page([]),
});

interface World {
  issue: Issue;
  prs: Record<number, LivePr>;
  /** The issue's closing references (closed included), in GitHub's order. */
  links: { number: number; url: string; state: string }[];
  linksMore?: boolean;
  failPr?: Set<number>;
  rateLimitPr?: Set<number>;
  /** Refuse a native-dependency continuation page for quota. */
  refuseNative?: boolean;
}

/** One GraphQL boundary for the focused issue read, closing references, PR status and delivery. */
function fake(w: World) {
  const log: string[] = [];
  /** PR numbers any pull-request read asked for (hydration and status alike). */
  const prReads: number[] = [];
  const rate = (q: string) =>
    q.includes("pdbReadRate")
      ? { pdbReadRate: { cost: 1, remaining: 4000, resetAt: "2026-11-14T11:00:00Z" } }
      : {};
  const query: Query = async (q, v) => {
    log.push(q);
    const n = Number(v.number);
    if (q.includes("issues(first:") || q.includes("pullRequests(first:"))
      throw new Error("repository inventory must not be read");
    if (w.refuseNative && q.includes("blockedBy(first:100,after"))
      throw new RateLimitError("API rate limit exceeded");
    if (q.includes("includeClosedPrs:true"))
      return {
        repository: {
          issue: { closedByPullRequestsReferences: page(w.links, !!w.linksMore) },
        },
        ...rate(q),
      };
    if (q.includes("pullRequest(number")) {
      prReads.push(n);
      if (w.rateLimitPr?.has(n)) throw new RateLimitError("API rate limit exceeded");
      if (w.failPr?.has(n)) throw new Error("GitHub query failed.");
      const p = w.prs[n];
      return { repository: { pullRequest: p ? statusNode(n, p) : null }, ...rate(q) };
    }
    if (q.includes("resource(")) {
      const m = Number(String(v.url).split("/").pop());
      const p = w.prs[m];
      if (!p) throw new Error("not found");
      return {
        resource: {
          __typename: "PullRequest",
          id: `PR_${m}`,
          number: m,
          url: prLink(m),
          state: p.state,
          isDraft: !!p.draft,
          merged: p.state === "MERGED",
          mergeCommit: p.state === "MERGED" ? { oid: `m${m}` } : null,
          headRefOid: `head${m}`,
          baseRefName: p.base ?? "main",
          baseRepository: { nameWithOwner: repo, defaultBranchRef: { name: "main" } },
        },
      };
    }
    if (q.includes("issue(number")) return { repository: { issue: w.issue }, ...rate(q) };
    return { repository: { defaultBranchRef: { name: "main" } } };
  };
  const rest = async (path: string): Promise<RestAnswer> =>
    path.includes("/collaborators/")
      ? { status: 200, body: { user: { login: "writer" }, role_name: "write" } }
      : path.includes("compare")
        ? { status: 200, body: { status: "identical" } }
        : { status: 404, body: null };
  const boundaries = {
    trust: markerTrust(permissionLookup(repo, rest)),
    trustWith: (r: typeof rest) => markerTrust(permissionLookup(repo, r)),
    live: { query, rest },
  };
  return { query, rest, boundaries, log, prReads };
}

const read = (w: World, limitPrs?: number, withDelivery = true) => {
  const f = fake(w);
  return readTicketStatus(
    repo,
    w.issue.number,
    { staleHours: 48, now: clock(), ...(limitPrs ? { limitPrs } : {}) },
    withDelivery ? f.boundaries : {},
    f.query,
    clock,
  ).then((r) => ({ ...r, log: f.log, prReads: f.prReads }));
};
const row = (r: TicketStatus, n: number) => r.pullRequests.find((p) => p.number === n)!;

describe("pdb ticket N (#197)", () => {
  it("no associated PR: says none found within the inspected sources, never that none exists", async () => {
    const r = await read({ issue: ticket(1), prs: {}, links: [] });
    expect(r.complete).toBe(true);
    expect(r.report).toMatchObject({
      kind: "ticket-status",
      schemaVersion: 1,
      pullRequests: [],
      delivery: { verdict: "no-record" },
      assessments: { complexity: { state: "current", size: "M" } },
    });
    expect(r.text).toMatch(/none found within the inspected sources/);
    expect(r.text).toMatch(/not proof that none exists/);
    expect(r.report.collection.profile).toBe("ticket-status-v1");
    // Only the ticket's own reads: issue and closing references, plus no inventory.
    expect(r.log.every((q) => !q.includes("issues(first:"))).toBe(true);
  });

  it("lists required members first, deduplicates with closing references and keeps provenance", async () => {
    const issue = ticket(1, [submitted(1, [member(30), member(20)])]);
    const r = await read({
      issue,
      prs: { 10: { state: "OPEN", draft: true }, 20: { state: "MERGED" }, 30: { state: "OPEN" } },
      links: [
        { number: 30, url: prLink(30), state: "OPEN" },
        { number: 10, url: prLink(10), state: "OPEN" },
      ],
    });
    expect(r.report.pullRequests.map((p) => [p.number, p.relations])).toEqual([
      [20, ["required"]],
      [30, ["required", "closing-reference"]],
      [10, ["closing-reference"]],
    ]);
    expect(row(r.report, 10)).toMatchObject({ draft: true, followUp: "actionable" });
    // One merged member is partial evidence: the ticket is not delivered while #30 is open.
    expect(r.report.delivery.verdict).not.toBe("delivered");
    expect(r.report.delivery.required).toEqual([`${repo}#30`, `${repo}#20`]);
  });

  it("bounds detailed reads; an omitted required PR is unknown and the view incomplete", async () => {
    const issue = ticket(1, [submitted(1, [member(21), member(22)])]);
    const r = await read(
      {
        issue,
        prs: { 21: { state: "OPEN" }, 22: { state: "OPEN" } },
        links: [],
      },
      1,
    );
    expect(
      r.log.filter((q) => q.includes("headRefOid headRefName baseRefName updatedAt")).length,
    ).toBe(1);
    expect(row(r.report, 22)).toMatchObject({
      detail: "omitted",
      detailWhy: "beyond --limit-prs 1",
    });
    expect(r.complete).toBe(false);
    expect(r.report.coverage.omitted.pullRequests).toEqual([
      { identity: `${repo}#22`, relations: ["required"], why: "beyond --limit-prs 1" },
    ]);
    expect(r.text).toMatch(/EVIDENCE INCOMPLETE/);
    expect(r.text).toMatch(/#22 .*status omitted/);
  });

  it("--limit-prs bounds the first hydration pass: PRs beyond it are never read", async () => {
    const issue = ticket(1, [submitted(1, [member(25)])]);
    const r = await read(
      {
        issue,
        prs: { 25: { state: "OPEN" }, 26: { state: "OPEN" }, 27: { state: "OPEN" } },
        links: [26, 27].map((n) => ({ number: n, url: prLink(n), state: "OPEN" })),
      },
      1,
    );
    // Only one PR is ever read, by any pass; the others stay listed as unknown.
    expect(new Set(r.prReads).size).toBe(1);
    expect(r.report.pullRequests.filter((p) => p.detail === "read")).toHaveLength(1);
    expect(r.report.pullRequests.filter((p) => p.detail === "omitted")).toHaveLength(2);
    expect(r.complete).toBe(false);
  });

  it("keeps the shared closure-cleanup follow-up for an open member of a not-planned ticket", async () => {
    for (const reason of ["NOT_PLANNED", "DUPLICATE"]) {
      const issue = ticket(1, [submitted(1, [member(35)])], {
        state: "CLOSED",
        stateReason: reason,
      });
      const r = await read({ issue, prs: { 35: { state: "OPEN" } }, links: [] });
      const member35 = r.report.delivery.deliverables.find((d) => d.deliverable === `${repo}#35`)!;
      expect(member35.followUpWhy).toMatch(/closure cleanup/);
      expect(row(r.report, 35)).toMatchObject({
        detail: "read",
        followUp: member35.followUp,
        followUpWhy: member35.followUpWhy,
      });
    }
  });

  it("current-head acceptance, stale approval, failed and pending checks come from pr-status", async () => {
    const r = await read({
      issue: ticket(1),
      prs: {
        40: { state: "OPEN", approvedOn: "head40" },
        41: { state: "OPEN", approvedOn: "old" },
        42: { state: "OPEN", verify: "FAILURE" },
        43: { state: "OPEN", verify: null },
      },
      links: [40, 41, 42, 43].map((n) => ({ number: n, url: prLink(n), state: "OPEN" })),
    });
    expect(row(r.report, 40).review?.headReviewed).toBe(true);
    expect(row(r.report, 41).review?.headReviewed).toBe(false);
    expect(row(r.report, 42)).toMatchObject({
      checks: { verify: "failed" },
      followUp: "actionable",
    });
    expect(row(r.report, 43).checks?.verify).toBe("missing");
    expect(row(r.report, 43).followUp).not.toBe("none");
  });

  it("a feature-branch target mismatch and a closed-unmerged PR stay visible", async () => {
    const issue = ticket(1, [submitted(1, [member(50, "release")])]);
    const r = await read({
      issue,
      prs: { 50: { state: "OPEN", base: "main" }, 51: { state: "CLOSED" } },
      links: [{ number: 51, url: prLink(51), state: "CLOSED" }],
    });
    expect(row(r.report, 50)).toMatchObject({
      targetMismatch: true,
      intendedTarget: `${repo}:release`,
    });
    expect(row(r.report, 51)).toMatchObject({ state: "CLOSED", relations: ["closing-reference"] });
    expect(r.text).toMatch(/MISMATCH/);
  });

  it("a default-branch target is never a mismatch unless the default branch is known", async () => {
    const issue = ticket(1, [submitted(1, [member(52)])]);
    const r = await read({ issue, prs: { 52: { state: "OPEN", base: "main" } }, links: [] });
    expect(row(r.report, 52)).toMatchObject({
      intendedTarget: `${repo}:(default branch)`,
      targetMismatch: null,
    });
    expect(r.text).not.toMatch(/MISMATCH/);
    const pr = { repository: repo, base: "main" };
    expect(targetMismatch(`${repo}:(default branch)`, pr, "main")).toBe(false);
    expect(targetMismatch(`${repo}:(default branch)`, pr, "trunk")).toBe(true);
    expect(targetMismatch(`${repo}:main`, pr)).toBe(false);
    expect(targetMismatch(`${repo}:release`, pr)).toBe(true);
    expect(targetMismatch(null, pr)).toBeNull();
  });

  it("a cross-repository or inaccessible PR is unknown, never optional success", async () => {
    const r = await read({
      issue: ticket(1),
      prs: {},
      links: [{ number: 5, url: prLink(5, "other/fork"), state: "OPEN" }],
    });
    expect(row(r.report, 5)).toMatchObject({
      repository: "other/fork",
      detail: "failed",
      detailWhy: "unavailable",
    });
    expect(r.complete).toBe(false);
  });

  it("a truncated closing-reference list is a coverage gap", async () => {
    const r = await read({
      issue: ticket(1),
      prs: { 60: { state: "OPEN" } },
      links: [{ number: 60, url: prLink(60), state: "OPEN" }],
      linksMore: true,
    });
    expect(r.report.coverage.linkage.complete).toBe(false);
    expect(r.complete).toBe(false);
  });

  it("unread delivery records leave delivery and responsibility unknown", async () => {
    const r = await read({ issue: ticket(1), prs: {}, links: [] }, undefined, false);
    expect(r.complete).toBe(false);
    expect(r.report.ownership.responsibilityKnown).toBe(true);
    expect(r.report.completeness.warnings.join(" ")).toMatch(/delivery-records/);
    expect(r.report.nextSteps[0].kind).toBe("inspect");
  });

  it("unknown native edges are unknown, not 'no blockers'", async () => {
    const issue = ticket(1, [], { issueDependenciesSummary: undefined });
    const r = await read({ issue, prs: {}, links: [] });
    expect(r.report.dependencies.known).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.text).toMatch(/Dependencies: unknown/);
  });

  it("an open native blocker is a visible wait, not an action", async () => {
    const blocker = {
      number: 9,
      title: "Blocker",
      url: issueLink(9),
      state: "OPEN",
      repository: { nameWithOwner: repo },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 1, totalBlocking: 1 },
    };
    const issue = ticket(1, [], {
      issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
      blockedBy: page([blocker]),
    });
    const r = await read({ issue, prs: {}, links: [] });
    expect(r.report.nextSteps).toContainEqual(expect.objectContaining({ kind: "wait" }));
    expect(r.text).toMatch(/Blocked by: owner\/name#9 Blocker/);
  });

  it("a human-closed issue reports closure separately from delivery", async () => {
    const issue = ticket(1, [], { state: "CLOSED", stateReason: "NOT_PLANNED" });
    const r = await read({ issue, prs: {}, links: [] });
    expect(r.report).toMatchObject({
      closure: "closed-not-planned",
      delivery: { verdict: "no-record" },
    });
    expect(r.text).toMatch(/closure is reported, not evidence of delivery/);
  });

  it("stops PR reads after a quota refusal; the rest are not attempted", async () => {
    const r = await read({
      issue: ticket(1),
      prs: {
        70: { state: "OPEN" },
        71: { state: "OPEN" },
        72: { state: "OPEN" },
        73: { state: "OPEN" },
      },
      links: [70, 71, 72, 73].map((n) => ({ number: n, url: prLink(n), state: "OPEN" })),
      rateLimitPr: new Set([70]),
    });
    const details = r.report.pullRequests.map((p) => p.detail);
    expect(details[0]).toBe("failed");
    expect(details).toContain("not-attempted");
    expect(r.complete).toBe(false);
    expect(r.report.collection.quota).not.toBeNull();
    expect(r.report.collection.notAttempted.length).toBeGreaterThan(0);
  });

  it("after a quota refusal on a native-edge page, no further page of any list is requested", async () => {
    const blocker = (n: number) => ({
      number: n,
      title: `B${n}`,
      url: issueLink(n),
      state: "OPEN",
      repository: { nameWithOwner: repo },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 1, totalBlocking: 1 },
    });
    const issue = ticket(1, [], {
      issueDependenciesSummary: { blockedBy: 2, totalBlockedBy: 2, blocking: 0, totalBlocking: 0 },
      blockedBy: page([blocker(8)], true),
      // An open-PR closing-reference list with a continuation the read must not request.
      closedByPullRequestsReferences: page([{ number: 60, url: prLink(60), state: "OPEN" }], true),
    });
    const r = await read({
      issue,
      prs: { 60: { state: "OPEN" } },
      links: [{ number: 60, url: prLink(60), state: "OPEN" }],
      refuseNative: true,
    });
    const after = r.log.slice(r.log.findIndex((q) => q.includes("blockedBy(first:100,after")) + 1);
    expect(after).toEqual([]);
    const linked = r.report.collection.coverage.filter((c) => c.source === "linked-pull-requests");
    expect(linked.find((c) => c.subject === `${repo}#1`)).toMatchObject({
      state: "partial",
      omission: expect.stringContaining("quota"),
    });
    expect(r.report.dependencies.known).toBe(false);
    expect(row(r.report, 60).detail).toBe("not-attempted");
    expect(r.complete).toBe(false);
    expect(r.report.collection.quota).not.toBeNull();
  });

  it("never exceeds --max-chars, counting header and notice, at any limit (#379)", async () => {
    const r = await read({
      issue: ticket(1),
      prs: Object.fromEntries([80, 81, 82, 83].map((n) => [n, { state: "OPEN" } as LivePr])),
      links: [80, 81, 82, 83].map((n) => ({ number: n, url: prLink(n), state: "OPEN" })),
    });
    const full = ticketStatusText(r.report);
    const lines = full.split("\n");
    const headerLength = lines.slice(0, 3).join("\n").length + 1;
    for (const max of [
      1,
      2,
      5,
      12,
      20,
      31,
      headerLength,
      headerLength + 40,
      600,
      full.length - 1,
    ]) {
      const text = ticketStatusText(r.report, max);
      expect(text.length, `limit ${max}`).toBeLessThanOrEqual(max);
      expect(text.length, `limit ${max}`).toBeGreaterThan(0);
      expect(text, `limit ${max}`).toMatch(/…|\[truncated\]|Truncated due to maximum size\./);
    }
    expect(ticketStatusText(r.report, 1)).toBe("…");
    expect(ticketStatusText(r.report, 20)).toBe("[truncated]\n");
    expect(ticketStatusText(r.report, 31)).toBe("Truncated due to maximum size.\n");
    // Room for the header: it is kept whole, and actionable PR rows come before optional detail.
    const roomy = ticketStatusText(r.report, 600);
    expect(roomy.split("\n").slice(0, 3)).toEqual(lines.slice(0, 3));
    expect(roomy).toMatch(/Truncated due to maximum size\. Full detail: pdb ticket 1 --json/);
    expect(roomy).toMatch(/Pull requests \(4 of 4 read/);
    expect(roomy).not.toMatch(/Observed live/);
    expect(ticketStatusText(r.report, full.length)).toBe(full);
  });
});

describe("pdb ticket CLI (#197)", () => {
  const run = async (args: string[], w?: World) => {
    let out = "";
    const f = w ? fake(w) : null;
    const code = await main(["--no-update-check", ...args], async (t) => void (out += t), {
      collect: async () => {
        throw new Error("full snapshot must not be read");
      },
      currentRepository: async () => {
        throw new Error("no checkout");
      },
      dependencyReport: async () => {
        throw new Error("unused");
      },
      ...(f ? { query: f.query, rest: f.rest } : {}),
      now: clock,
    } as never);
    return { code, out };
  };

  it("ticket --help works without a checkout or credentials", async () => {
    const r = await run(["ticket", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage: pdb ticket N/);
  });

  it("rejects invalid arguments", async () => {
    await expect(run(["ticket", "x"])).rejects.toThrow(/Usage: pdb ticket N/);
    await expect(run(["ticket", "1", "--limit-prs", "0", "--repo", repo])).rejects.toThrow(
      /--limit-prs/,
    );
    await expect(run(["ticket", "1", "--limit-prs", "101", "--repo", repo])).rejects.toThrow(
      /--limit-prs/,
    );
  });

  it("text and JSON carry the same facts; JSON is never sliced by --max-chars", async () => {
    const w: World = {
      issue: ticket(1),
      prs: { 90: { state: "OPEN" } },
      links: [{ number: 90, url: prLink(90), state: "OPEN" }],
    };
    const json = await run(["ticket", "1", "--repo", repo, "--json", "--max-chars", "50"], w);
    const report = JSON.parse(json.out) as TicketStatus;
    expect(report.pullRequests.map((p) => p.number)).toEqual([90]);
    const text = await run(["ticket", "1", "--repo", repo], w);
    expect(text.out).toMatch(/#90 owner\/name \[closing-reference\] OPEN/);
    expect(json.code).toBe(text.code);
    expect(json.code).toBe(report.completeness.complete ? 0 : 2);
  });
});
