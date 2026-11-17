import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { ledgerTrust, ticketLedger } from "./ledger.js";
import type { LedgerFacts, LedgerPullRequest } from "./ledger.js";
import { claimMarkerFor } from "../workflow/claims.js";
import type { Comment, HistoryEvent } from "../workflow/claims.js";
import { deliveryMarker } from "../workflow/delivery.js";
import type { Deliverable, DeliveryRecord } from "../workflow/delivery.js";
import type { RepositoryPermission } from "../github/github.js";
import { provenanceComment } from "../estimation/estimate.js";
import type { MetricProvenance } from "../estimation/estimate.js";

// Synthetic fixtures only: no real repository, agent or comment.
const repo = "example/project";
const n = 7;
const t = (h: number) => `2026-11-10T${String(h).padStart(2, "0")}:00:00Z`;
const now = new Date("2026-11-11T00:00:00Z");

const permissions: Record<string, RepositoryPermission> = {
  writer: "write",
  reader: "read",
  flaky: "unknown",
};
const trust = ledgerTrust(async (login) => permissions[login] ?? "none");

let nextId = 1000;
const comment = (body: string, at: string, login = "writer", id = nextId++): Comment => ({
  databaseId: id,
  url: `https://example.test/c/${id}`,
  body,
  createdAt: at,
  author: { __typename: "User", login },
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const claim = (agent: string, at: string, login = "writer", id?: number) =>
  comment(
    `Claimed by \`${agent}\` with \`pdb claim\`.\n\n${claimMarkerFor(repo, n, agent)}`,
    at,
    login,
    id,
  );
const release = (agent: string, at: string, login = "writer") =>
  comment(
    `Released.\n\n<!-- github-triage:release:abcdef0123456789 ${JSON.stringify({
      v: 1,
      agent,
      outcome: "ready",
      target: null,
      remove: [`agent:${agent}`],
      retained: [],
      claimedAt: null,
    })} -->`,
    at,
    login,
  );
const pr = (number: number): Deliverable => ({
  kind: "pr",
  repository: repo,
  number,
  nodeId: `PR_${number}`,
  target: { repository: repo, branch: null },
});
const delivery = (
  op: DeliveryRecord["op"],
  at: string,
  fields: Partial<DeliveryRecord> = {},
  login = "writer",
) =>
  comment(
    deliveryMarker({
      v: 1,
      op,
      opId: `op-${nextId}`,
      repository: repo,
      issue: n,
      agent: "alice",
      deliverables: [],
      issuedAt: at,
      ...(["submit", "attach", "complete"].includes(op) ? {} : { reason: "because" }),
      ...fields,
    }),
    at,
    login,
  );
const labeled = (agent: string, at: string, login = "writer"): HistoryEvent => ({
  __typename: "LabeledEvent",
  createdAt: at,
  label: { name: `agent:${agent}` },
  actor: { __typename: "User", login },
});

const facts = (over: Partial<LedgerFacts> = {}): LedgerFacts => ({
  issue: {
    repository: repo,
    number: n,
    createdAt: t(0),
    state: "OPEN",
    closedAt: null,
    stateReason: null,
  },
  comments: { nodes: [], complete: true },
  history: { events: [], complete: true, pages: 1 },
  pullRequests: { nodes: [], complete: true },
  ...over,
});
const withComments = (nodes: Comment[], complete = true, over: Partial<LedgerFacts> = {}) =>
  facts({ comments: { nodes, complete }, ...over });
const kinds = (l: Awaited<ReturnType<typeof ticketLedger>>) =>
  l.events.map((e) => `${e.kind}:${e.source}`);

describe("ticket ledger", () => {
  it("records a claim as a claim-marker pickup with its verified agent", async () => {
    const l = await ticketLedger(withComments([claim("alice", t(2))]), trust, now);
    expect(kinds(l)).toEqual(["created:issue", "picked-up:claim-marker"]);
    expect(l.firstPickup["claim-marker"]).toMatchObject({
      status: "found",
      at: t(2),
      agent: "alice",
    });
    expect(l.firstPickup.label).toEqual({ status: "none" });
    expect(l.observedAt).toBe(now.toISOString());
  });

  it("does not attribute a claim whose reported agent does not reproduce the marker", async () => {
    const forged = comment(
      `Claimed by \`mallory\` with \`pdb claim\`.\n\n${claimMarkerFor(repo, n, "alice")}`,
      t(2),
    );
    const l = await ticketLedger(withComments([forged]), trust, now);
    expect(l.firstPickup["claim-marker"]).toMatchObject({ status: "found", agent: null });
  });

  it("records both pickup sources side by side and chooses neither", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(3))], true, {
        history: { events: [labeled("alice", t(1))], complete: true, pages: 1 },
      }),
      trust,
      now,
    );
    expect(l.firstPickup.label).toMatchObject({ status: "found", at: t(1) });
    expect(l.firstPickup["claim-marker"]).toMatchObject({ status: "found", at: t(3) });
    expect(l.events.filter((e) => e.kind === "picked-up").map((e) => e.source)).toEqual([
      "label",
      "claim-marker",
    ]);
  });

  it("records a release without a later pickup as no requeue", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(1)), release("alice", t(2))]),
      trust,
      now,
    );
    expect(l.events.find((e) => e.kind === "released")).toMatchObject({
      agent: "alice",
      outcome: "ready",
      at: t(2),
    });
    expect(l.requeues).toEqual({ known: true, value: 0 });
  });

  it("counts a requeue and keeps the original first pickup", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(1)), release("alice", t(2)), claim("bob", t(4))]),
      trust,
      now,
    );
    expect(l.requeues).toEqual({ known: true, value: 1 });
    expect(l.firstPickup["claim-marker"]).toMatchObject({ at: t(1), agent: "alice" });
  });

  it("keeps the requeue count unknown when the label timeline was not read", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(1)), release("alice", t(2))], true, { history: null }),
      trust,
      now,
    );
    expect(l.requeues).toMatchObject({ known: false, observed: 0 });
  });

  it("a handoff never moves the first pickup", async () => {
    const submit = delivery("submit", t(3), { deliverables: [pr(10)] });
    const l = await ticketLedger(
      withComments([
        claim("alice", t(1)),
        submit,
        delivery("handoff", t(5), {
          to: "bob",
          scope: "ticket",
          expectedResponsibilityRecord: String(submit.databaseId),
        }),
      ]),
      trust,
      now,
    );
    expect(
      l.events.filter((e) => e.kind === "delivery").map((e) => e.kind === "delivery" && e.op),
    ).toEqual(["submit", "handoff"]);
    expect(l.firstPickup["claim-marker"]).toMatchObject({ at: t(1), agent: "alice" });
    expect(l.requeues).toEqual({ known: true, value: 0 });
  });

  it("records one merge per required PR, and none for an unrequired PR", async () => {
    const prs: LedgerPullRequest[] = [
      { repository: repo, number: 10, state: "MERGED", mergedAt: t(6) },
      { repository: repo, number: 11, state: "MERGED", mergedAt: t(8) },
      { repository: repo, number: 12, state: "MERGED", mergedAt: t(7) },
    ];
    const l = await ticketLedger(
      withComments(
        [delivery("submit", t(3), { deliverables: [pr(10), pr(11)], membership: "complete" })],
        true,
        { pullRequests: { nodes: [...prs, prs[0]!], complete: true } },
      ),
      trust,
      now,
    );
    expect(l.membership).toBe("complete");
    expect(l.requiredPullRequests).toEqual([
      { repository: repo, number: 10 },
      { repository: repo, number: 11 },
    ]);
    expect(
      l.events
        .filter((e) => e.kind === "pr-merged")
        .map((e) => e.kind === "pr-merged" && e.pr.number),
    ).toEqual([10, 11]);
    expect(l.coverage.prs).toBe("complete");
  });

  it("reports open membership and a required PR that was not read", async () => {
    const l = await ticketLedger(
      withComments(
        [delivery("submit", t(3), { deliverables: [pr(10), pr(11)], membership: "open" })],
        true,
        {
          pullRequests: {
            nodes: [{ repository: repo, number: 10, state: "MERGED", mergedAt: t(5) }],
            complete: true,
          },
        },
      ),
      trust,
      now,
    );
    expect(l.membership).toBe("open");
    expect(l.coverage.prs).toBe("partial");
    expect(l.omissions).toContain(`required pull request ${repo}#11 not read`);
  });

  it("keeps reopen counts unknown until the closure timeline is read, then counts them", async () => {
    const closedIssue = {
      repository: repo,
      number: n,
      createdAt: t(0),
      state: "CLOSED",
      closedAt: t(9),
      stateReason: "COMPLETED",
    };
    const before = await ticketLedger(facts({ issue: closedIssue, history: null }), trust, now);
    expect(before.reopens).toMatchObject({ known: false, reason: "closure timeline not read" });
    expect(before.coverage.timeline).toBe("unavailable");
    expect(kinds(before)).toEqual(["created:issue", "closed:issue"]);

    const history: HistoryEvent[] = [
      { __typename: "ClosedEvent", createdAt: t(2), stateReason: "NOT_PLANNED" },
      { __typename: "ReopenedEvent", createdAt: t(4) },
      { __typename: "ClosedEvent", createdAt: t(9), stateReason: "COMPLETED" },
    ];
    const after = await ticketLedger(
      facts({ issue: closedIssue, history: { events: history, complete: true, pages: 1 } }),
      trust,
      now,
    );
    expect(after.reopens).toEqual({ known: true, value: 1 });
    expect(kinds(after)).toEqual([
      "created:issue",
      "closed:timeline",
      "reopened:timeline",
      "closed:timeline",
    ]);

    const cut = await ticketLedger(
      facts({
        issue: closedIssue,
        history: { events: history.slice(1), complete: false, pages: 4 },
      }),
      trust,
      now,
    );
    expect(cut.reopens).toMatchObject({ known: false, observed: 1 });
    expect(cut.coverage.timeline).toBe("partial");
  });

  it("excludes untrusted markers and label adds and lists them as ignored", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(1), "reader"), release("alice", t(2), "reader")], true, {
        history: { events: [labeled("alice", t(1), "reader")], complete: true, pages: 1 },
      }),
      trust,
      now,
    );
    expect(l.events.filter((e) => e.kind !== "created")).toEqual([]);
    expect(l.firstPickup).toEqual({
      "claim-marker": { status: "none" },
      label: { status: "none" },
    });
    expect(l.ignored).toHaveLength(3);
  });

  it("an unverifiable earlier marker makes the first pickup unknown, never later", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(1), "flaky"), claim("bob", t(3))]),
      trust,
      now,
    );
    expect(l.firstPickup["claim-marker"]).toMatchObject({
      status: "unknown",
      observed: { at: t(3), agent: "bob" },
    });
  });

  it("an edit by the author keeps a record at its creation time; an edit by a non-writer drops it", async () => {
    const ownEdit = {
      ...claim("alice", t(1)),
      lastEditedAt: t(6),
      editor: { __typename: "User", login: "writer" },
    };
    const own = await ticketLedger(withComments([ownEdit]), trust, now);
    expect(own.firstPickup["claim-marker"]).toMatchObject({ status: "found", at: t(1) });

    const tampered = {
      ...claim("alice", t(1)),
      lastEditedAt: t(6),
      editor: { __typename: "User", login: "reader" },
    };
    const bad = await ticketLedger(withComments([tampered]), trust, now);
    expect(bad.firstPickup["claim-marker"]).toEqual({ status: "none" });
    expect(bad.ignored).toHaveLength(1);

    const unread = { ...claim("alice", t(1)), lastEditedAt: undefined };
    const unknown = await ticketLedger(withComments([unread]), trust, now);
    expect(unknown.firstPickup["claim-marker"]).toMatchObject({ status: "unknown" });
  });

  it("breaks same-instant ties by numeric comment id, not text", async () => {
    const later = claim("bob", t(1), "writer", 100);
    const earlier = claim("alice", t(1), "writer", 99);
    const l = await ticketLedger(withComments([later, earlier]), trust, now);
    expect(l.firstPickup["claim-marker"]).toMatchObject({ status: "found", agent: "alice" });
    expect(
      l.events.filter((e) => e.kind === "picked-up").map((e) => e.kind === "picked-up" && e.agent),
    ).toEqual(["alice", "bob"]);
  });

  it("counts a requeue when release and reclaim share an instant, by comment id", async () => {
    const l = await ticketLedger(
      withComments([
        claim("alice", t(1)),
        { ...release("alice", t(2)), databaseId: 99 },
        claim("bob", t(2), "writer", 100),
      ]),
      trust,
      now,
    );
    expect(l.requeues).toEqual({ known: true, value: 1 });
  });

  it("counts a comment seen twice once", async () => {
    const c = claim("alice", t(1));
    const r = release("alice", t(2));
    const l = await ticketLedger(withComments([c, r, { ...c }, { ...r }]), trust, now);
    expect(kinds(l)).toEqual([
      "created:issue",
      "picked-up:claim-marker",
      "released:release-marker",
    ]);
  });

  it("marks coverage partial and pickups unknown when a source is cut off", async () => {
    const l = await ticketLedger(
      withComments([claim("alice", t(5))], false, {
        history: { events: [labeled("alice", t(5))], complete: false, pages: 4 },
      }),
      trust,
      now,
    );
    expect(l.coverage).toMatchObject({
      comments: "partial",
      timeline: "partial",
      deliveryRecords: "partial",
    });
    expect(l.firstPickup["claim-marker"]).toMatchObject({
      status: "unknown",
      observed: { at: t(5) },
    });
    expect(l.firstPickup.label).toMatchObject({ status: "unknown", observed: { at: t(5) } });
    expect(l.requeues.known).toBe(false);
    expect(l.membership).toBe("unknown");
    expect(l.requiredPullRequests).toBeNull();
  });

  it("reports unread sources as unavailable and unknown, never empty", async () => {
    const l = await ticketLedger(
      facts({
        issue: { ...facts().issue, createdAt: null },
        comments: null,
        history: null,
        pullRequests: null,
      }),
      trust,
      now,
    );
    expect(l.coverage).toEqual({
      comments: "unavailable",
      timeline: "unavailable",
      deliveryRecords: "unavailable",
      prs: "unavailable",
    });
    expect(l.firstPickup["claim-marker"].status).toBe("unknown");
    expect(l.firstPickup.label.status).toBe("unknown");
    expect(l.membership).toBe("unknown");
    expect(l.omissions).toContain("creation time not read");
  });

  it("has no GitHub access in the module", () => {
    const source = readFileSync(new URL("./ledger.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import (type )?\{?[^;]*?from "([^"]+)";/gms)];
    for (const [, typeOnly, from] of imports)
      if (from!.includes("github/github")) expect(typeOnly).toBe("type ");
    expect(source).not.toMatch(/\bghQuery\b|\bghRun\b|\bfetch\(/);
  });
});

describe("first assessment endpoints (#833)", () => {
  const estimate = (
    kind: "complexity" | "impact",
    size: "S" | "M" | "L",
    at: string,
    login = "writer",
    previous: ("S" | "M" | "L")[] = [],
  ) =>
    comment(
      provenanceComment({
        ...(kind === "complexity"
          ? { schemaVersion: 2, kind: "complexity-estimate" }
          : { schemaVersion: 1, kind: "impact-estimate" }),
        storage: "labels",
        size,
        previous,
        rationale: "synthetic",
        assumptions: [],
        references: [],
        estimator: "alice",
        revision: null,
        guidanceVersion: 1,
        // A client-stated time that differs from the server time on purpose.
        recordedAt: "2020-01-01T00:00:00Z",
      } as MetricProvenance),
      at,
      login,
    );

  it("finds the first trusted record per metric by server time and counts revisions", async () => {
    const l = await ticketLedger(
      withComments([
        estimate("complexity", "S", t(2)),
        estimate("impact", "M", t(3)),
        estimate("complexity", "M", t(5), "writer", ["S"]),
      ]),
      trust,
      now,
    );
    expect(l.assessments.complexity.first).toMatchObject({ status: "found", at: t(2), size: "S" });
    expect(l.assessments.complexity.first).toMatchObject({ recordedAt: "2020-01-01T00:00:00Z" });
    expect(l.assessments.complexity.revisions).toEqual({ known: true, value: 1 });
    expect(l.assessments.complexity.records.map((r) => r.size)).toEqual(["S", "M"]);
    expect(l.assessments.impact.first).toMatchObject({ status: "found", at: t(3), size: "M" });
  });

  it("skips untrusted records and is unknown behind a record of unknown authority", async () => {
    const untrusted = await ticketLedger(
      withComments([
        estimate("complexity", "L", t(1), "reader"),
        estimate("complexity", "S", t(2)),
      ]),
      trust,
      now,
    );
    expect(untrusted.assessments.complexity.first).toMatchObject({ status: "found", at: t(2) });
    expect(untrusted.assessments.complexity.ignored).toHaveLength(1);
    const unknown = await ticketLedger(
      withComments([estimate("complexity", "L", t(1), "flaky"), estimate("complexity", "S", t(2))]),
      trust,
      now,
    );
    expect(unknown.assessments.complexity.first).toMatchObject({
      status: "unknown",
      observed: { at: t(2) },
    });
  });

  it("is none only with complete history and unknown when comments were cut off", async () => {
    const none = await ticketLedger(withComments([]), trust, now);
    expect(none.assessments.impact.first).toEqual({ status: "none" });
    const cut = await ticketLedger(
      withComments([estimate("impact", "S", t(2))], false),
      trust,
      now,
    );
    expect(cut.assessments.impact.first).toMatchObject({
      status: "unknown",
      observed: { at: t(2) },
    });
    expect(cut.assessments.impact.revisions).toMatchObject({ known: false });
  });

  it("never treats a current size label as an assessment event", async () => {
    const l = await ticketLedger(
      withComments([], true, {
        history: {
          events: [
            {
              __typename: "LabeledEvent",
              createdAt: t(2),
              label: { name: "complexity:S" },
            } as never,
          ],
          complete: true,
          pages: 1,
        },
      }),
      trust,
      now,
    );
    expect(l.assessments.complexity.first).toEqual({ status: "none" });
  });
});
