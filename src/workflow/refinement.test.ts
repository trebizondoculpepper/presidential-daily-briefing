/**
 * Refinement records and service (#1094): request, partial writes, resolution and races, over an
 * injected GH boundary that applies planned writes to an in-memory repository.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ClaimPlan, ClaimResult, GraphQuery } from "./claims.js";
import { refinementLabel, refinementMarker, requestRefinement } from "./refinement.js";
import { world } from "../testing/refinementworld.js";
import { repo } from "../testing/snapshots.js";

const outcome = (r: ClaimPlan | ClaimResult) =>
  r.ok ? (r.noop ? "noop" : "exitCode" in r ? `exit ${r.exitCode}` : "ok") : r.error;
const opOf = (r: ClaimPlan | ClaimResult) => (r.ok ? r.questionOpId! : "");
const stepsOf = (r: ClaimResult) => (r.steps ?? []).map((s) => `${s.step}:${s.status}`);

describe("refinement requests (#1094)", () => {
  it("records the question and the index label, preserving every other label, and retries safely", async () => {
    const w = world();
    w.add(1, ["status:ready", "agent:jonas", "complexity:M", "urgency:high"]);
    const done = await w.request(1, ["Which storage engine?", "Must it be offline?"]);
    expect(outcome(done)).toBe("exit 0");
    expect(stepsOf(done)).toEqual(["comment:done", "create-label:done", "labels:done"]);
    const i = w.issues.get(1)!;
    expect(i.labels).toEqual([
      "status:ready",
      "agent:jonas",
      "complexity:M",
      "urgency:high",
      refinementLabel,
    ]);
    expect(i.comments).toHaveLength(1);
    expect(i.comments[0]!.body).toContain("Which storage engine?");
    expect(i.comments[0]!.body).toContain("<!-- github-triage:needs-human:");
    expect(i.comments[0]!.body).toContain("<!-- github-triage:refinement v1 ");
    // The same intent again changes nothing.
    expect(outcome(await w.request(1, ["Which storage engine?", "Must it be offline?"]))).toBe(
      "noop",
    );
    expect(i.comments).toHaveLength(1);
    expect(await w.facts(1)).toEqual({
      requests: [
        {
          state: "open",
          estimated: false,
          question: { trust: "trusted", version: 2, outcome: "none" },
        },
      ],
      complete: true,
    });
  });

  it("refuses empty or blank questions and malformed dependency suggestions at the boundary", async () => {
    const w = world();
    w.add(1);
    expect(outcome(await w.planRequest(1, []))).toBe("QUESTION_REQUIRED");
    expect(outcome(await w.planRequest(1, ["  "]))).toBe("QUESTION_REQUIRED");
    expect(outcome(await w.planRequest(1, ["Q?"], { dependencies: ["not-a-ref"] }))).toBe(
      "INVALID_DEPENDENCY",
    );
    // A valid suggestion is recorded, never applied as a native edge.
    await w.request(1, ["Q?"], { dependencies: [`${repo}#7`] });
    expect(w.issues.get(1)!.comments[0]!.body).toContain(
      `Suggested dependencies (not applied): ${repo}#7`,
    );
    expect((await w.fold(1)).requests[0]!.dependencies).toEqual([`${repo}#7`]);
  });

  it("reports a partial write truthfully and repairs the missing label on retry", async () => {
    const w = world();
    w.add(1);
    w.failing.add("labels");
    const partial = await w.request(1);
    expect(outcome(partial)).toBe("exit 2");
    expect(stepsOf(partial)).toEqual(["comment:done", "create-label:done", "labels:failed"]);
    expect((await w.facts(1)).complete).toBe(false);
    w.failing.delete("labels");
    const retry = await w.request(1);
    expect(outcome(retry)).toBe("exit 0");
    expect(stepsOf(retry)).toEqual(["labels:done"]);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
    expect((await w.facts(1)).complete).toBe(true);
  });

  it("ignores a request by an account without write permission", async () => {
    const w = world();
    w.add(1);
    w.comment(
      1,
      refinementMarker({
        v: 1,
        op: "request",
        opId: "aaaaaaaaaaaaaaaa",
        repository: repo,
        issue: 1,
        agent: "x",
        questionOpId: "aaaaaaaaaaaaaaaa",
        dependencies: [],
      }),
      "outsider",
    );
    const fold = await w.fold(1);
    expect(fold.requests).toEqual([]);
    expect(fold.rejected.join(" ")).toMatch(/read permission/);
  });

  it("refuses rather than reposts when a matching request's author cannot be verified (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const plan = await w.planRequest(1);
    const body = plan.ok
      ? plan.changes[0]!.command[plan.changes[0]!.command.indexOf("--body") + 1]!
      : "";
    w.comment(1, body, "ghost");
    expect(outcome(await w.planRequest(1))).toBe("EVIDENCE_INCOMPLETE");
    expect(w.issues.get(1)!.comments).toHaveLength(1);
  });

  it("keeps quoted marker delimiters out of display text so the record still parses (#1135 review)", async () => {
    const w = world();
    w.add(1);
    await w.request(1, ["Does <!-- github-triage:refinement v1 {} --> break it?"]);
    const body = w.issues.get(1)!.comments[0]!.body;
    expect(body.split("<!-- github-triage:refinement ").length).toBe(2);
    expect((await w.fold(1)).requests).toHaveLength(1);
    expect((await w.facts(1)).complete).toBe(true);
  });

  it("reports a marker comment whose order is unknown as incomplete evidence (#1135 review)", async () => {
    const w = world();
    w.add(1);
    await w.request(1);
    const copy = { ...w.issues.get(1)!.comments[0]!, databaseId: undefined as unknown as number };
    w.issues.get(1)!.comments.push(copy);
    expect((await w.fold(1)).unknown.join(" ")).toMatch(/order is unknown/);
  });
});

describe("resolving refinement (#1094)", () => {
  it("refuses while the question is unsettled, then clears it and returns the item for estimation", async () => {
    const w = world();
    w.add(1, ["status:ready", "complexity:S"]);
    const req = await w.request(1);
    const op = opOf(req);
    expect(outcome(await w.planResolve(1, op))).toBe("QUESTIONS_UNSETTLED");
    expect((await w.answer(1, w.questionOf(1))).exitCode).toBe(0);
    const clear = await w.resolve(1, op);
    expect(outcome(clear)).toBe("exit 0");
    expect(stepsOf(clear)).toEqual(["comment:done", "labels:done"]);
    // Clearing removes only the index label: readiness and the estimate stay as they were.
    expect(w.issues.get(1)!.labels).toEqual(["status:ready", "complexity:S"]);
    expect(await w.facts(1)).toEqual({
      requests: [
        {
          state: "resolved",
          estimated: false,
          question: { trust: "trusted", version: 2, outcome: "resolved" },
        },
      ],
      complete: true,
    });
    // An estimate newer than the resolve completes the return to estimation.
    expect((await w.facts(1, [w.tick()])).requests[0]!.estimated).toBe(true);
    expect(outcome(await w.resolve(1, op))).toBe("noop");
  });

  it("refuses stale clearing while a newer request is open, and keeps the label for an older one", async () => {
    const w = world();
    w.add(1);
    const a = await w.request(1, ["First question?"]);
    const b = await w.request(1, ["Second question?"]);
    await w.answer(1, w.questionOf(1, 0));
    expect(outcome(await w.planResolve(1, opOf(a)))).toBe("NEWER_REQUEST_OPEN");
    await w.answer(1, w.questionOf(1, 1));
    await w.resolve(1, opOf(b));
    // A is still outstanding, so the index label stays.
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
    await w.resolve(1, opOf(a));
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).requests.map((r) => r.state)).toEqual(["resolved", "resolved"]);
  });

  it("orders requests by comment id when timestamps tie (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const a = await w.request(1, ["First question?"]);
    await w.request(1, ["Second question?"]);
    const [first, second] = w.issues.get(1)!.comments;
    second!.createdAt = first!.createdAt;
    await w.answer(1, w.questionOf(1, 0));
    expect(outcome(await w.planResolve(1, opOf(a)))).toBe("NEWER_REQUEST_OPEN");
  });

  it("reconciles the label from a fresh read after the resolve, so a request landing meanwhile stays indexed (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const a = await w.request(1, ["First question?"]);
    await w.answer(1, w.questionOf(1, 0));
    // Plan A's resolve, then let a newer request land before it is applied.
    const stale = await w.planResolve(1, opOf(a));
    await w.request(1, ["Late question?"]);
    await w.apply(stale);
    // The label is reconciled from the current records, not the stale plan: B is outstanding.
    const reconciled = await w.request(1, ["Late question?"]);
    expect(outcome(reconciled)).toBe("noop");
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
  });

  it("repairs the label when retrying a resolve whose label removal failed (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const req = await w.request(1);
    await w.answer(1, w.questionOf(1));
    w.failing.add("labels");
    expect(outcome(await w.resolve(1, opOf(req)))).toBe("exit 2");
    expect((await w.facts(1)).complete).toBe(false);
    w.failing.delete("labels");
    const retry = await w.resolve(1, opOf(req));
    expect(stepsOf(retry)).toEqual(["labels:done"]);
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
    expect(outcome(await w.resolve(1, opOf(req)))).toBe("noop");
  });

  it("refuses a resolve reason its own reader would reject (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const req = await w.request(1);
    await w.answer(1, w.questionOf(1));
    expect(outcome(await w.resolve(1, opOf(req), "x".repeat(1001)))).toBe("INVALID_RECORD");
    expect(w.issues.get(1)!.comments).toHaveLength(2);
  });

  it("does not restore the label when an already resolved request is replayed (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const req = await w.request(1);
    await w.answer(1, w.questionOf(1));
    await w.resolve(1, opOf(req));
    expect(outcome(await w.request(1))).toBe("noop");
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
  });

  it("refuses an unknown request and a resolve by an untrusted account", async () => {
    const w = world();
    w.add(1);
    expect(outcome(await w.planResolve(1, "bbbbbbbbbbbbbbbb"))).toBe("REQUEST_NOT_FOUND");
    const outsider = world("outsider");
    outsider.add(1);
    expect(outcome(await outsider.planResolve(1, "bbbbbbbbbbbbbbbb"))).toBe("MARKER_UNVERIFIED");
  });

  it("keeps the record's receipt when the label re-read fails (#1135 review)", async () => {
    const w = world();
    w.add(1);
    let reads = 0;
    const flaky: GraphQuery = async (source, variables) => {
      // Fail every ticket read after the record is written (viewer reads still succeed).
      if (!source.startsWith("query{viewer") && w.issues.get(1)!.comments.length && ++reads > 0)
        throw new Error("GitHub unavailable");
      return w.query(source, variables);
    };
    const result = await requestRefinement(
      repo,
      { number: 1, agent: "kavya", designer: "nicole", why: "Unclear.", questions: ["Q?"] },
      { run: w.run, query: flaky, permission: w.permission },
    );
    expect(outcome(result)).toBe("exit 2");
    expect(stepsOf(result)).toEqual(["comment:done"]);
    expect(result.ok && result.unverified).toMatch(/could not be re-read \(GitHub unavailable\)/);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
  });
});
