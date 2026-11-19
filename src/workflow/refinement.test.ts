/**
 * Refinement records and service (#1094): request, partial writes, resolution and races, over an
 * injected GH boundary that applies planned writes to an in-memory repository.
 */
import { describe, expect, it } from "vite-plus/test";
import { applyPlan, planQuestionResolution } from "./claims.js";
import type { ClaimPlan, GraphQuery } from "./claims.js";
import {
  foldRefinement,
  planRefinementRequest,
  planRefinementResolve,
  refinementFacts,
  refinementLabel,
  refinementMarker,
} from "./refinement.js";
import { permissions } from "../testing/fakegh.js";
import { by, page, repo } from "../testing/snapshots.js";

type Note = {
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { __typename: string; login: string };
  lastEditedAt: string | null;
  includesCreatedEdit: boolean;
  editor: null;
};

function world(viewer = "kavya") {
  let clock = Date.parse("2026-11-19T01:00:00Z");
  let ids = 9000;
  const tick = () => new Date((clock += 60_000)).toISOString();
  const issues = new Map<number, { labels: string[]; comments: Note[] }>();
  const repoLabels = new Set<string>();
  /** Steps whose write fails, by kind ("comment" | "labels" | "label-create"). */
  const failing = new Set<string>();
  const add = (n: number, labels: string[] = ["status:ready"]) =>
    issues.set(n, { labels: [...labels], comments: [] });
  const comment = (n: number, body: string, login = viewer) => {
    const id = ++ids;
    const note: Note = {
      ...by(login),
      databaseId: id,
      url: `https://github.com/${repo}/issues/${n}#issuecomment-${id}`,
      body,
      createdAt: tick(),
      editor: null,
    };
    issues.get(n)!.comments.push(note);
    return note;
  };
  const query: GraphQuery = async (source, variables) => {
    if (source.startsWith("query{viewer")) return { viewer: { __typename: "User", login: viewer } };
    const n = Number(variables.number);
    const i = issues.get(n);
    const named = (key: string) => {
      const name = String(variables[key] ?? "");
      return name && repoLabels.has(name) ? { name } : null;
    };
    return {
      repository: {
        issueOrPullRequest: i
          ? {
              __typename: "Issue",
              number: n,
              title: `T${n}`,
              url: `https://github.com/${repo}/issues/${n}`,
              state: "OPEN",
              updatedAt: "2026-11-19T00:00:00Z",
              labels: page(i.labels.map((name) => ({ name }))),
              issueDependenciesSummary: { blockedBy: 0 },
              blockedBy: page([]),
              closedByPullRequestsReferences: page([]),
              comments: page(i.comments),
              timelineItems: page([]),
            }
          : null,
        claims: page([]),
        ownerLabel: named("label"),
        questionLabel: named("question"),
        decisionLabel: named("decision"),
        needsDesignLabel: named("needsDesign"),
        attentionLabel: named("attention"),
        targetLabel: named("target"),
      },
    };
  };
  const run = async (args: string[]) => {
    if (args[0] === "label" && args[1] === "create") {
      if (failing.has("label-create")) throw new Error("label create failed");
      repoLabels.add(args[2]!);
      return;
    }
    const n = Number(args[2]);
    if (args[0] === "issue" && args[1] === "comment") {
      if (failing.has("comment")) throw new Error("comment failed");
      comment(n, args[args.indexOf("--body") + 1]!);
    } else if (args[0] === "issue" && args[1] === "edit") {
      if (failing.has("labels")) throw new Error("label edit failed");
      const i = issues.get(n)!;
      args.forEach((a, k) => {
        if (a === "--add-label" && !i.labels.includes(args[k + 1]!)) i.labels.push(args[k + 1]!);
        if (a === "--remove-label") i.labels = i.labels.filter((l) => l !== args[k + 1]);
      });
    }
  };
  const permission = permissions({ outsider: "read" });
  const apply = (plan: ClaimPlan) => applyPlan(repo, plan, { run, query });
  const request = (n: number, questions: string[] = ["Which storage engine?"], extra = {}) =>
    planRefinementRequest(
      repo,
      {
        number: n,
        agent: "kavya",
        designer: "nicole",
        why: "Unclear contract.",
        questions,
        ...extra,
      },
      query,
      permission,
    );
  const resolve = (n: number, opId: string) =>
    planRefinementResolve(
      repo,
      { number: n, agent: "kavya", request: opId, why: "Answered." },
      query,
      permission,
    );
  const answer = async (n: number, commentId: string) =>
    apply(
      await planQuestionResolution(
        repo,
        {
          number: n,
          agent: "nicole",
          op: "resolve",
          question: `https://github.com/${repo}/issues/${n}#issuecomment-${commentId}`,
          why: "Decided: SQLite.",
        },
        query,
        permission,
      ),
    );
  const fold = (n: number) => foldRefinement(repo, n, issues.get(n)!.comments, permission);
  const facts = async (n: number, estimates: string[] = []) =>
    refinementFacts(await fold(n), {
      historyComplete: true,
      labelPresent: issues.get(n)!.labels.includes(refinementLabel),
      estimates,
    });
  return {
    issues,
    failing,
    add,
    comment,
    query,
    permission,
    apply,
    request,
    resolve,
    answer,
    fold,
    facts,
    tick,
  };
}

const outcome = (r: ClaimPlan) => (r.ok ? (r.noop ? "noop" : "ok") : r.error);
const opOf = (r: ClaimPlan) => (r.ok ? r.questionOpId! : "");

describe("refinement requests (#1094)", () => {
  it("records the question and the index label, preserving every other label, and retries safely", async () => {
    const w = world();
    w.add(1, ["status:ready", "agent:jonas", "complexity:M", "urgency:high"]);
    const plan = await w.request(1, ["Which storage engine?", "Must it be offline?"]);
    expect(outcome(plan)).toBe("ok");
    expect((await w.apply(plan)).exitCode).toBe(0);
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
    // The same intent again is a no-op: nothing is posted twice.
    expect(outcome(await w.request(1, ["Which storage engine?", "Must it be offline?"]))).toBe(
      "noop",
    );
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
    expect(outcome(await w.request(1, []))).toBe("QUESTION_REQUIRED");
    expect(outcome(await w.request(1, ["  "]))).toBe("QUESTION_REQUIRED");
    expect(outcome(await w.request(1, ["Q?"], { dependencies: ["not-a-ref"] }))).toBe(
      "INVALID_DEPENDENCY",
    );
    // A valid suggestion is recorded, never applied as a native edge.
    const ok = await w.request(1, ["Q?"], { dependencies: [`${repo}#7`] });
    await w.apply(ok);
    expect(w.issues.get(1)!.comments[0]!.body).toContain(
      `Suggested dependencies (not applied): ${repo}#7`,
    );
    expect((await w.fold(1)).requests[0]!.dependencies).toEqual([`${repo}#7`]);
  });

  it("reports a partial write truthfully and repairs the missing label on retry", async () => {
    const w = world();
    w.add(1);
    w.failing.add("labels");
    const result = await w.apply(await w.request(1));
    expect(result.exitCode).toBe(2);
    expect(w.issues.get(1)!.comments).toHaveLength(1);
    // The record is authoritative; the missing label is a disagreement, so evidence is incomplete.
    expect((await w.facts(1)).complete).toBe(false);
    w.failing.delete("labels");
    const retry = await w.request(1);
    expect(outcome(retry)).toBe("ok");
    expect((await w.apply(retry)).exitCode).toBe(0);
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
});

describe("resolving refinement (#1094)", () => {
  it("refuses while the question is unsettled, then clears it and returns the item for estimation", async () => {
    const w = world();
    w.add(1, ["status:ready", "complexity:S"]);
    const plan = await w.request(1);
    await w.apply(plan);
    const op = opOf(plan);
    expect(outcome(await w.resolve(1, op))).toBe("QUESTIONS_UNSETTLED");
    const question = String(w.issues.get(1)!.comments[0]!.databaseId);
    expect((await w.answer(1, question)).exitCode).toBe(0);
    const clear = await w.resolve(1, op);
    expect(outcome(clear)).toBe("ok");
    expect((await w.apply(clear)).exitCode).toBe(0);
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
    // A retry of the same resolve is a no-op.
    expect(outcome(await w.resolve(1, op))).toBe("noop");
  });

  it("refuses stale clearing while a newer request is open, and keeps the label for an older one", async () => {
    const w = world();
    w.add(1);
    const a = await w.request(1, ["First question?"]);
    await w.apply(a);
    const b = await w.request(1, ["Second question?"]);
    await w.apply(b);
    const [qa, qb] = w.issues.get(1)!.comments.map((c) => String(c.databaseId));
    await w.answer(1, qa!);
    // A is settled, but B is newer and unresolved: clearing A would be stale.
    expect(outcome(await w.resolve(1, opOf(a)))).toBe("NEWER_REQUEST_OPEN");
    await w.answer(1, qb!);
    const clearB = await w.resolve(1, opOf(b));
    expect(outcome(clearB)).toBe("ok");
    await w.apply(clearB);
    // A is still outstanding, so the index label stays.
    expect(w.issues.get(1)!.labels).toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
    const clearA = await w.resolve(1, opOf(a));
    await w.apply(clearA);
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).requests.map((r) => r.state)).toEqual(["resolved", "resolved"]);
  });

  it("refuses an unknown request and a resolve by an untrusted account", async () => {
    const w = world();
    w.add(1);
    expect(outcome(await w.resolve(1, "bbbbbbbbbbbbbbbb"))).toBe("REQUEST_NOT_FOUND");
    const outsider = world("outsider");
    outsider.add(1);
    expect(outcome(await outsider.resolve(1, "bbbbbbbbbbbbbbbb"))).toBe("MARKER_UNVERIFIED");
  });

  it("repairs the label when retrying a resolve whose label removal failed (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const plan = await w.request(1);
    await w.apply(plan);
    await w.answer(1, String(w.issues.get(1)!.comments[0]!.databaseId));
    w.failing.add("labels");
    expect((await w.apply(await w.resolve(1, opOf(plan)))).exitCode).toBe(2);
    expect((await w.facts(1)).complete).toBe(false);
    w.failing.delete("labels");
    const retry = await w.resolve(1, opOf(plan));
    expect(outcome(retry)).toBe("ok");
    expect(retry.ok && retry.changes.map((c) => c.step)).toEqual(["labels"]);
    await w.apply(retry);
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
    expect(outcome(await w.resolve(1, opOf(plan)))).toBe("noop");
  });

  it("refuses a resolve reason its own reader would reject (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const plan = await w.request(1);
    await w.apply(plan);
    await w.answer(1, String(w.issues.get(1)!.comments[0]!.databaseId));
    const long = await planRefinementResolve(
      repo,
      { number: 1, agent: "kavya", request: opOf(plan), why: "x".repeat(1001) },
      w.query,
      w.permission,
    );
    expect(outcome(long)).toBe("INVALID_RECORD");
    expect(w.issues.get(1)!.comments).toHaveLength(2);
  });

  it("does not restore the label when an already resolved request is replayed (#1135 review)", async () => {
    const w = world();
    w.add(1);
    const plan = await w.request(1);
    await w.apply(plan);
    await w.answer(1, String(w.issues.get(1)!.comments[0]!.databaseId));
    await w.apply(await w.resolve(1, opOf(plan)));
    expect(outcome(await w.request(1))).toBe("noop");
    expect(w.issues.get(1)!.labels).not.toContain(refinementLabel);
    expect((await w.facts(1)).complete).toBe(true);
  });
});
