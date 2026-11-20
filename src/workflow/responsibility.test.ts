/**
 * Human-directed release reaches the native admission (#1019 over #1018): the snapshot
 * responsibility read reports each applied trusted `unassign` with its preserved open PRs, and the
 * briefing's native evaluation then offers that existing work for adoption (D-ADOPT) instead of
 * denying it as duplicate open-PR work. No GitHub; the real fold, trust rule and policy.
 */
import { describe, expect, it } from "vite-plus/test";
import { evaluateDatalog } from "../rules/datalog/datalog.js";
import { issue, pr, snapshot, time } from "../testing/snapshots.js";
import { deliverableKey, deliveryMarker, markerTrust } from "./delivery.js";
import type { Deliverable, DeliveryComment, DeliveryRecord } from "./delivery.js";
import { readSnapshotResponsibility } from "./responsibility.js";

const repository = "example/project";
const member: Deliverable = {
  kind: "pr",
  repository,
  number: 4,
  nodeId: "PR_4",
  target: { repository, branch: null },
};
let id = 500;
const post = (r: Partial<DeliveryRecord> & Pick<DeliveryRecord, "op">): DeliveryComment => {
  const n = id++;
  return {
    databaseId: n,
    body: deliveryMarker({
      v: 1,
      opId: `op-${n}`,
      repository,
      issue: 1,
      agent: "alice",
      deliverables: [],
      issuedAt: time,
      ...r,
    } as DeliveryRecord),
    createdAt: new Date(Date.parse(time) + n * 1000).toISOString(),
    author: { __typename: "User", login: "writer" },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const trust = markerTrust(async (login) => (login === "reader" ? "read" : "write"));

function released(withRelease: boolean) {
  const t = issue(1, ["status:awaiting-review", "complexity:S", "impact:M"]);
  const submit = post({ op: "submit", deliverables: [member], membership: "complete" });
  const comments = [submit];
  if (withRelease)
    comments.push(
      post({
        op: "unassign",
        agent: "maint",
        from: "alice",
        reason: "owner directed",
        expected: {
          ticket: String(submit.databaseId),
          members: [{ deliverable: deliverableKey(member), record: String(submit.databaseId) }],
        },
      }),
    );
  t.comments = { nodes: comments as never, pageInfo: { hasNextPage: false, endCursor: null } };
  return snapshot([t], [pr()]);
}

/** The briefing's native evaluation over the read facts, merged as src/briefing/service.ts does. */
const native = async (snap: ReturnType<typeof snapshot>, agent = "carol") => {
  const facts = await readSnapshotResponsibility(snap, trust);
  const result = evaluateDatalog(snap, new Map(), {
    role: "implementer",
    agent,
    responsible: new Map([
      ...facts.responsible,
      ...[...facts.ticketOwners].map(([u, a]) => [u, [a]] as [string, string[]]),
    ]),
    responsibilityUnknown: [...facts.unknown.map((u) => u.issue), ...facts.unknownPrs],
    releaseDirections: facts.releaseDirections,
    limit: 50,
  });
  return { facts, adopted: result.items.some((a) => a.ruleIds.includes("D-ADOPT")) };
};
const adopt = (withRelease: boolean) => native(released(withRelease), "bob");
const withComments = (t: ReturnType<typeof issue>, nodes: DeliveryComment[], more = false) => {
  t.comments = {
    nodes: nodes as never,
    pageInfo: { hasNextPage: more, endCursor: more ? "c" : null },
  };
  return t;
};
const pr5 = () => ({ ...pr(), number: 5, url: pr().url.replace(/4$/, "5"), headRefName: "f5" });
const member5: Deliverable = { ...member, number: 5, nodeId: "PR_5" } as Deliverable;

describe("human-directed release reaches native adoption (#1019)", () => {
  it("reports the release with its preserved open PR, and the policy offers adoption", async () => {
    const { facts, adopted } = await adopt(true);
    expect(facts.releaseDirections.get(issue(1).url)).toEqual([
      { trust: "trusted", from: "alice", preservedPrs: [pr().url] },
    ]);
    expect(facts.responsible.get(pr().url)).toBeUndefined();
    expect(adopted).toBe(true);
  });

  it("offers nothing to adopt without a release: the PR is still alice's", async () => {
    const { facts, adopted } = await adopt(false);
    expect(facts.releaseDirections.size).toBe(0);
    expect(facts.responsible.get(pr().url)).toEqual(["alice"]);
    expect(adopted).toBe(false);
  });

  it("withholds adoption natively while another agent still owns the ticket (#1149 review)", async () => {
    const submit = post({
      op: "submit",
      agent: "bob",
      deliverables: [member],
      membership: "complete",
    });
    const handoff = post({
      op: "handoff",
      agent: "bob",
      to: "alice",
      scope: "deliverable",
      deliverables: [member],
      expectedResponsibilityRecord: String(submit.databaseId),
      reason: "split",
    });
    const release = post({
      op: "unassign",
      agent: "maint",
      from: "alice",
      reason: "owner directed",
      expected: {
        ticket: null,
        members: [{ deliverable: deliverableKey(member), record: String(handoff.databaseId) }],
      },
    });
    const t = withComments(issue(1, ["status:awaiting-review", "complexity:S", "impact:M"]), [
      submit,
      handoff,
      release,
    ]);
    const { facts, adopted } = await native(snapshot([t], [pr()]));
    expect(facts.ticketOwners.get(t.url)).toBe("bob");
    expect(facts.releaseDirections.get(t.url)?.[0]?.from).toBe("alice");
    expect(adopted).toBe(false);
  });

  it("still offers the released PR when another member keeps its own owner (#1149 review)", async () => {
    const submit = post({ op: "submit", deliverables: [member, member5], membership: "complete" });
    const handoff = post({
      op: "handoff",
      to: "bob",
      scope: "deliverable",
      deliverables: [member5],
      expectedResponsibilityRecord: String(submit.databaseId),
      reason: "split",
    });
    const release = post({
      op: "unassign",
      agent: "maint",
      from: "alice",
      reason: "owner directed",
      expected: {
        ticket: String(submit.databaseId),
        members: [{ deliverable: deliverableKey(member), record: String(submit.databaseId) }],
      },
    });
    const t = withComments(issue(1, ["status:awaiting-review", "complexity:S", "impact:M"]), [
      submit,
      handoff,
      release,
    ]);
    const { facts, adopted } = await native(snapshot([t], [pr(), pr5() as never]));
    expect(facts.releaseDirections.get(t.url)).toEqual([
      { trust: "trusted", from: "alice", preservedPrs: [pr().url] },
    ]);
    expect(adopted).toBe(true);
  });

  it("treats a released PR shared with an unread issue as unknown, by closing link or record (#1149 review)", async () => {
    // By closing reference.
    const snap = released(true);
    const other = withComments(
      issue(2, ["status:awaiting-review"]),
      [post({ op: "submit", deliverables: [member] })],
      true,
    );
    snap.issues.push(other);
    snap.pullRequests[0]!.closingIssuesReferences.nodes.push({
      number: 2,
      url: other.url,
    } as never);
    const linked = await native(snap, "bob");
    expect(linked.facts.unknownPrs).toEqual([pr().url]);
    expect(linked.adopted).toBe(false);
    // By recorded membership only: no closing link to the unread issue.
    const snap2 = released(true);
    snap2.issues.push(
      withComments(
        issue(3, ["status:awaiting-review"]),
        [post({ op: "submit", issue: 3, deliverables: [member] })],
        true,
      ),
    );
    const recorded = await native(snap2, "bob");
    expect(recorded.facts.unknownPrs).toEqual([pr().url]);
    expect(recorded.adopted).toBe(false);
  });

  it("treats a PR closing a truncated, marker-free issue as unknown (#1149 review)", async () => {
    const snap = released(true);
    const other = withComments(issue(2, ["status:awaiting-review"]), [], true);
    snap.issues.push(other);
    snap.pullRequests[0]!.closingIssuesReferences.nodes.push({
      number: 2,
      url: other.url,
    } as never);
    const r = await native(snap, "bob");
    expect(r.facts.unknownPrs).toEqual([pr().url]);
    expect(r.adopted).toBe(false);
  });

  it("ignores excluded records on an unread issue: copied or by a non-writer (#1149 review)", async () => {
    for (const excluded of [
      post({ op: "submit", issue: 1, deliverables: [member] }), // copied: bound to issue 1
      {
        ...post({ op: "submit", issue: 3, deliverables: [member] }),
        author: { __typename: "User", login: "reader" },
      },
    ]) {
      const snap = released(true);
      // Issue 3 is unread (truncated, plus a malformed trusted record) but has no closing link.
      const malformed = {
        ...post({ op: "submit", issue: 3 }),
        body: "<!-- github-triage:delivery v1 {bad -->",
      };
      snap.issues.push(
        withComments(
          issue(3, ["status:awaiting-review"]),
          [malformed, excluded as DeliveryComment],
          true,
        ),
      );
      const r = await native(snap, "bob");
      expect(r.facts.unknown.map((u) => u.issue)).toEqual([issue(3).url]);
      expect(r.facts.unknownPrs).toEqual([]);
      expect(r.adopted).toBe(true);
    }
  });
});
