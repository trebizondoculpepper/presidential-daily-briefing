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
const trust = markerTrust(async () => "write");

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

const adopt = async (withRelease: boolean) => {
  const snap = released(withRelease);
  const facts = await readSnapshotResponsibility(snap, trust);
  const result = evaluateDatalog(snap, new Map(), {
    role: "implementer",
    agent: "bob",
    responsible: facts.responsible,
    responsibilityUnknown: facts.unknown.map((u) => u.issue),
    releaseDirections: facts.releaseDirections,
    limit: 50,
  });
  return { facts, adopted: result.items.some((a) => a.ruleIds.includes("D-ADOPT")) };
};

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
});
