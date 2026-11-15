import { describe, expect, it } from "vite-plus/test";
import { main } from "../cli.js";
import { ticketOwnership, ticketOwnershipText } from "./who.js";
import type { Snapshot } from "../github/types.js";
import { issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

describe("who is working on a ticket (#61, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const note = (body: string, hoursAgo: number, n = 0) => ({
    body,
    url: `https://github.com/${repo}/issues/1#c${n}`,
    author: { login: "shared" },
    createdAt: at(hoursAgo),
    updatedAt: at(hoursAgo),
  });
  const ticket = (labels: string[], comments: ReturnType<typeof note>[] = [], hoursAgo = 1) => ({
    ...issue(1, labels),
    updatedAt: at(hoursAgo),
    comments: page(comments),
  });
  const lookup = (data: Snapshot, staleHours?: number) =>
    ticketOwnership(data, 1, { now: new Date(time), staleHours });
  const kinds = (r: ReturnType<typeof lookup>) => r.findings.map((f) => `${f.certainty}:${f.kind}`);

  it("label-only ownership: answers from the agent: label, presence unknown", () => {
    const r = lookup(snapshot([ticket(["agent:ana"])], []));
    expect(r).toMatchObject({
      kind: "ticket-ownership",
      schemaVersion: 1,
      recordedOwners: ["ana"],
    });
    expect(r.answer).toBe("recorded claim: ana");
    expect(r.presence).toMatch(/^unknown/);
    expect(kinds(r)).toEqual([]);
    expect(r.next).toContain(`pdb --repo ${repo} --issue 1`);
    expect(ticketOwnershipText(r)).toContain("Presence: unknown");
  });
  it("comment-only reported work is a candidate, not a claim", () => {
    const r = lookup(snapshot([ticket(["status:ready"], [note("Picked up by dee", 1)])], []));
    expect(r.recordedOwners).toEqual([]);
    expect(r.answer).toMatch(/^no recorded claim/);
    expect(kinds(r)).toEqual(["candidate:comment-only-work"]);
    expect(r.commentEvidence[0]).toMatchObject({ kind: "reported-work" });
  });
  it("released contribution with an open PR: awaiting review is not ownership", () => {
    const linked = pr();
    linked.updatedAt = at(0.5);
    const r = lookup(
      snapshot(
        [ticket([], [note("Picked up", 3, 1), note("Released my claim; PR awaits review", 2, 2)])],
        [linked],
      ),
    );
    expect(r.pullRequests.map((p) => p.number)).toEqual([4]);
    expect(kinds(r)).toEqual(["candidate:unowned-open-pr"]);
    expect(r.latestActivity!.source).toBe("PR #4 updated");
    expect(r.next).toContain(`pdb pr 4 --repo ${repo}`);
  });
  it("multiple owners are definite; a claim after a handoff comment is a candidate contradiction", () => {
    const r = lookup(
      snapshot([ticket(["agent:ana", "agent:bo"], [note("Handing off to review", 1)])], []),
    );
    expect(r.answer).toBe("conflicting recorded claims: ana, bo");
    expect(kinds(r)).toEqual(["definite:multiple-owners", "candidate:claim-after-handoff"]);
  });
  it("stale activity is a candidate and releases nothing", () => {
    const r = lookup(snapshot([ticket(["agent:ana"], [], 100)], []));
    expect(kinds(r)).toEqual(["candidate:stale-activity"]);
    expect(kinds(lookup(snapshot([ticket(["agent:ana"], [], 100)], []), 200))).toEqual([]);
  });
  it("incomplete labels make ownership unknown, never nobody", () => {
    const t = ticket([]);
    t.labels = page([], true, "x");
    const r = lookup(snapshot([t], []));
    expect(r.recordedOwners).toBeNull();
    expect(r.answer).toMatch(/^unknown/);
    expect(r.completeness.complete).toBe(false);
  });
  it("runs through the CLI with a focused read, not repository collection (#367)", async () => {
    let out = "";
    let focused: unknown;
    const runtime = {
      collect: async () => {
        throw new Error("who N must not collect the repository");
      },
      collectIssueFocus: async (r: string, n: number) => {
        focused = [r, n];
        return snapshot([ticket(["agent:ana"])], []);
      },
      currentRepository: async () => repo,
      now: () => new Date(time),
    };
    expect(await main(["who", "1", "--json"], async (t) => void (out = t), runtime)).toBe(0);
    expect(focused).toEqual([repo, 1]);
    expect(JSON.parse(out).answer).toBe("recorded claim: ana");
    expect(JSON.parse(out).collection).toMatchObject({
      profile: "issue-detail-v1",
      operation: "who",
    });
    for (const bad of [["who"], ["who", "x"], ["who", "1", "--stale-hours", "0"]])
      await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
  });
});
