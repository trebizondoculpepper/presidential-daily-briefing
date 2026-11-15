/**
 * Retained claims (#412): waits, explicit resolution, resume and the admission guard, run end to
 * end against a small simulated repository whose comments and labels the planned writes change.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  applyPlan,
  planClaim,
  planNeedsHuman,
  planQuestionResolution,
  questionMarker,
  questionRecordBody,
} from "./claims.js";
import type { ClaimPlan, GraphQuery } from "./claims.js";
import { activityMarker } from "./claimactivity.js";
import {
  admissionFor,
  planClaimResume,
  planClaimWait,
  planWaitOnQuestion,
  readRetained,
  stillWaitingFor,
} from "./retained.js";
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
type Issue = {
  labels: string[];
  comments: Note[];
  events: { createdAt: string; label: { name: string }; __typename: string }[];
  blockers: { number: number; state: string }[];
};

/** A repository of issues; `run` applies planned `gh` writes to it. */
function world(viewer = "kavya") {
  let clock = Date.parse("2026-11-15T01:00:00Z");
  let ids = 9000;
  const tick = () => new Date((clock += 60_000)).toISOString();
  const issues = new Map<number, Issue>();
  const add = (n: number, labels: string[] = ["status:ready"]) => {
    issues.set(n, { labels: [...labels], comments: [], events: [], blockers: [] });
    return issues.get(n)!;
  };
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
  const label = (n: number, name: string, on: boolean) => {
    const i = issues.get(n)!;
    i.labels = i.labels.filter((l) => l !== name);
    if (on) i.labels.push(name);
    i.events.push({
      __typename: on ? "LabeledEvent" : "UnlabeledEvent",
      createdAt: tick(),
      label: { name },
    });
  };
  const query: GraphQuery = async (source, variables) => {
    if (source.startsWith("query{viewer")) return { viewer: { __typename: "User", login: viewer } };
    const n = Number(variables.number);
    const i = issues.get(n);
    const owner = String(variables.label ?? "");
    return {
      repository: {
        issueOrPullRequest: i
          ? {
              __typename: "Issue",
              number: n,
              title: `T${n}`,
              url: `https://github.com/${repo}/issues/${n}`,
              state: "OPEN",
              updatedAt: "2026-11-15T00:00:00Z",
              labels: page(i.labels.map((name) => ({ name }))),
              issueDependenciesSummary: {
                blockedBy: i.blockers.filter((b) => b.state === "OPEN").length,
              },
              blockedBy: page(
                i.blockers.map((b) => ({
                  number: b.number,
                  url: `https://github.com/${repo}/issues/${b.number}`,
                  state: b.state,
                })),
              ),
              closedByPullRequestsReferences: page([]),
              comments: page(i.comments),
              timelineItems: page(i.events),
            }
          : null,
        claims: page(
          [...issues.entries()]
            .filter(([, x]) => x.labels.includes(owner))
            .map(([k]) => ({
              number: k,
              title: `T${k}`,
              url: `https://github.com/${repo}/issues/${k}`,
            })),
        ),
        ownerLabel: { name: owner },
        questionLabel: { name: "question" },
        decisionLabel: { name: "design:decision-needed" },
        needsDesignLabel: { name: "status:needs-design" },
        attentionLabel: { name: String(variables.attention ?? "") },
      },
    };
  };
  const run = async (args: string[]) => {
    const n = Number(args[2]);
    if (args[0] === "issue" && args[1] === "comment") comment(n, args[args.indexOf("--body") + 1]!);
    else if (args[0] === "issue" && args[1] === "edit")
      args.forEach((a, k) => {
        if (a === "--add-label") label(n, args[k + 1]!, true);
        if (a === "--remove-label") label(n, args[k + 1]!, false);
      });
  };
  const permission = permissions({ outsider: "read" });
  const admission = admissionFor(repo, "kavya", query, permission);
  const stillWaiting = stillWaitingFor(repo, "kavya", query, permission);
  const apply = (plan: ClaimPlan) => applyPlan(repo, plan, { run, query, stillWaiting });
  const claim = async (n: number) =>
    apply(
      await planClaim(repo, { number: n, agent: "kavya" }, query, permission, undefined, admission),
    );
  const ask = async (n: number) => {
    const body = questionRecordBody(
      { designer: "nicole", agent: "kavya", why: "w", questions: ["Which flag?"] },
      questionMarker(`${n}`.padStart(16, "0"), repo, n),
    );
    return comment(n, body);
  };
  const wait = async (n: number, blocker: { question?: string; blockedBy?: string }) =>
    planClaimWait(
      repo,
      { number: n, agent: "kavya", why: "Owner must choose.", ...blocker },
      query,
      permission,
    );
  const resume = async (n: number) =>
    planClaimResume(repo, { number: n, agent: "kavya" }, query, permission, admission);
  const state = async (n: number) =>
    (await readRetained(repo, n, "kavya", query, permission)).activity.state;
  return {
    issues,
    add,
    comment,
    label,
    query,
    run,
    permission,
    apply,
    claim,
    ask,
    wait,
    resume,
    state,
  };
}

const outcome = (r: ClaimPlan) => (r.ok ? (r.noop ? "noop" : "ok") : r.error);

describe("retained claims (#412)", () => {
  it("human wait -> second claim -> answer -> resume-required, then resume once the other waits", async () => {
    const w = world();
    w.add(1);
    w.add(2);
    w.add(3);
    expect((await w.claim(1)).exitCode).toBe(0);
    // A legacy claim without records is active: a second claim is refused.
    expect(
      outcome(
        await planClaim(
          repo,
          { number: 2, agent: "kavya" },
          w.query,
          w.permission,
          undefined,
          admissionFor(repo, "kavya", w.query, w.permission),
        ),
      ),
    ).toBe("OTHER_ACTIVE_CLAIM");
    const q = await w.ask(1);
    const waitPlan = await w.wait(1, { question: q.url });
    expect(outcome(waitPlan)).toBe("ok");
    expect((await w.apply(waitPlan)).exitCode).toBe(0);
    expect(await w.state(1)).toBe("waiting");
    // A retry of the same wait is a no-op.
    expect(outcome(await w.wait(1, { question: q.url }))).toBe("noop");
    // The verified wait admits one more claim, and says so.
    const second = await w.claim(2);
    expect(second.exitCode).toBe(0);
    expect((second.ok ? (second.notes ?? []) : []).join(" ")).toMatch(
      /Admitted while retaining a claim verified waiting: #1 waits on question/,
    );
    // Two claims are now held, one active: a third is refused.
    expect((await w.claim(3)).exitCode).toBe(1);
    // Answering the question clears the wait but never reactivates the claim by itself.
    const answered = await planQuestionResolution(
      repo,
      { number: 1, agent: "kavya", op: "resolve", question: q.url, why: "Owner chose --short." },
      w.query,
      w.permission,
    );
    await w.apply(answered);
    expect(await w.state(1)).toBe("resume-required");
    // #2 is active, so resuming #1 would make two active claims.
    expect(outcome(await w.resume(1))).toBe("OTHER_ACTIVE_CLAIM");
    // Once #2 waits on its own blocker, #1 can resume.
    w.add(5);
    w.issues.get(2)!.blockers.push({ number: 5, state: "OPEN" });
    await w.apply(await w.wait(2, { blockedBy: `${repo}#5` }));
    const resumed = await w.resume(1);
    expect(outcome(resumed)).toBe("ok");
    await w.apply(resumed);
    expect(await w.state(1)).toBe("active");
    expect(outcome(await w.resume(1))).toBe("noop");
  });

  it("dependency wait: a closed or removed blocker makes the claim resume-required, never active", async () => {
    const w = world();
    w.add(4);
    w.add(1);
    await w.claim(1);
    w.issues.get(1)!.blockers.push({ number: 4, state: "OPEN" });
    // Not an open native blocker: refused, the relationship must be recorded first.
    expect(outcome(await w.wait(1, { blockedBy: `${repo}#9` }))).toBe("BLOCKER_NOT_OPEN");
    await w.apply(await w.wait(1, { blockedBy: `${repo}#4` }));
    expect(await w.state(1)).toBe("waiting");
    expect(outcome(await w.resume(1))).toBe("BLOCKER_OPEN");
    w.issues.get(1)!.blockers[0]!.state = "CLOSED";
    expect(await w.state(1)).toBe("resume-required");
    expect(outcome(await w.resume(1))).toBe("ok");
  });

  it("a wait requires the caller's own claim and never acquires one", async () => {
    const w = world();
    w.add(1).blockers.push({ number: 4, state: "OPEN" });
    w.add(4);
    expect(outcome(await w.wait(1, { blockedBy: `${repo}#4` }))).toBe("NOT_OWNER");
    w.label(1, "agent:someone", true);
    expect(outcome(await w.wait(1, { blockedBy: `${repo}#4` }))).toBe("NOT_OWNER");
    expect(w.issues.get(1)!.comments).toHaveLength(0);
  });

  it("copied, outsider and earlier-generation waits never admit another claim", async () => {
    const w = world();
    w.add(1);
    w.add(2);
    w.add(8);
    await w.claim(1);
    const start = w.issues.get(1)!.events.at(-1)!.createdAt;
    const record = (over: object) =>
      activityMarker({
        v: 1,
        op: "wait",
        opId: "x",
        repository: repo,
        issue: 1,
        agent: "kavya",
        claimStartedAt: start,
        previousActivity: null,
        reason: "r",
        blocker: { kind: "dependency", repository: repo, issue: 8 },
        ...over,
      } as never);
    w.issues.get(1)!.blockers.push({ number: 8, state: "OPEN" });
    // Copied from another issue, by an outsider, and from an earlier claim.
    w.comment(1, record({ issue: 2 }));
    w.comment(1, record({ claimStartedAt: "2026-11-01T00:00:00Z" }));
    expect(await w.state(1)).toBe("active");
    expect((await w.claim(2)).exitCode).toBe(1);
    w.comment(1, record({}), "outsider");
    // An untrusted record is ignored (still active), never waiting.
    expect(await w.state(1)).toBe("active");
    expect((await w.claim(2)).exitCode).toBe(1);
  });

  it("unknown activity never admits another claim", async () => {
    const w = world();
    w.add(1);
    w.add(2);
    await w.claim(1);
    w.comment(1, '<!-- github-triage:claim-activity v1 {"v":1} -->');
    expect(await w.state(1)).toBe("unknown");
    const refused = await planClaim(
      repo,
      { number: 2, agent: "kavya" },
      w.query,
      w.permission,
      undefined,
      admissionFor(repo, "kavya", w.query, w.permission),
    );
    expect(refused.ok ? "ok" : refused.prerequisite).toMatch(/activity is unknown/);
  });

  it("a wait that stops holding after the claim was admitted is reported as a conflict", async () => {
    const w = world();
    w.add(1);
    w.add(2);
    w.add(4);
    await w.claim(1);
    w.issues.get(1)!.blockers.push({ number: 4, state: "OPEN" });
    await w.apply(await w.wait(1, { blockedBy: `${repo}#4` }));
    const plan = await planClaim(
      repo,
      { number: 2, agent: "kavya" },
      w.query,
      w.permission,
      undefined,
      admissionFor(repo, "kavya", w.query, w.permission),
    );
    expect(plan.ok).toBe(true);
    // The blocker closes between the admission check and the post-write recheck.
    w.issues.get(1)!.blockers[0]!.state = "CLOSED";
    const result = await w.apply(plan);
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/#1 must be resumed .*no longer admits another claim/);
  });

  it("resume checks every condition: open native blockers and open questions on the claim", async () => {
    const w = world();
    w.add(1);
    w.add(4);
    w.add(6);
    await w.claim(1);
    w.issues.get(1)!.blockers.push({ number: 4, state: "OPEN" }, { number: 6, state: "OPEN" });
    await w.apply(await w.wait(1, { blockedBy: `${repo}#4` }));
    w.issues.get(1)!.blockers[0]!.state = "CLOSED";
    expect(outcome(await w.resume(1))).toBe("BLOCKED");
    w.issues.get(1)!.blockers[1]!.state = "CLOSED";
    const q = await w.ask(1);
    const open = await w.resume(1);
    expect(open.ok ? "ok" : open.error).toBe("QUESTION_OPEN");
    expect(open.ok ? [] : open.recovery.join(" ")).toContain(q.url);
  });

  it("needs-human keeps the claim and binds a wait to its question; --release relinquishes it", async () => {
    const w = world();
    w.add(1);
    w.add(2);
    await w.claim(1);
    const ask = {
      number: 1,
      agent: "kavya",
      designer: "nicole",
      why: "Contract unclear.",
      questions: ["Which?"],
    };
    const plan = await planNeedsHuman(repo, ask, w.query, w.permission);
    expect(plan.ok && plan.retainsClaim).toBe(true);
    // The CLI posts the question, then the wait bound to it, then labels.
    await w.apply({
      ...(plan as Extract<ClaimPlan, { ok: true }>),
      changes: plan.ok ? plan.changes.filter((c) => c.step === "comment") : [],
    });
    const waitPlan = await planWaitOnQuestion(
      repo,
      { number: 1, agent: "kavya", questionOpId: plan.ok ? plan.questionOpId! : "", why: ask.why },
      w.query,
      w.permission,
    );
    await w.apply(waitPlan);
    expect(await w.state(1)).toBe("waiting");
    expect(w.issues.get(1)!.labels).toContain("agent:kavya");
    expect((await w.claim(2)).exitCode).toBe(0);
    const released = await planNeedsHuman(
      repo,
      { ...ask, number: 2, release: true },
      w.query,
      w.permission,
    );
    expect(released.ok && released.retainsClaim).toBe(false);
    expect(released.ok ? released.changes.at(-1)!.command.join(" ") : "").toContain(
      "--remove-label agent:kavya",
    );
  });
});

describe("claim wait/resume and needs-human --release arguments (#412)", () => {
  it("parse strictly: exactly one blocker and a reason for a wait, nothing extra for a resume", async () => {
    const { claimActivityArgumentsFor, workflowArgumentsFor } = await import("../cli.js");
    expect(
      claimActivityArgumentsFor("wait", [
        "7",
        "--agent",
        "a",
        "--blocked-by",
        "o/r#3",
        "--why",
        " w ",
      ]),
    ).toMatchObject({ op: "wait", number: 7, blockedBy: "o/r#3", why: "w" });
    expect(claimActivityArgumentsFor("resume", ["7", "--agent", "a"])).toMatchObject({
      op: "resume",
    });
    for (const bad of [
      ["7", "--agent", "a", "--why", "w"],
      ["7", "--agent", "a", "--question", "u", "--blocked-by", "o/r#3", "--why", "w"],
      ["7", "--agent", "a", "--question", "u"],
    ])
      expect(() => claimActivityArgumentsFor("wait", bad), bad.join(" ")).toThrow(
        /Usage: pdb claim wait/,
      );
    expect(() =>
      claimActivityArgumentsFor("resume", ["7", "--agent", "a", "--why", "w"]),
    ).toThrow();
    const ask = ["7", "--agent", "a", "--designer", "d", "--why", "w", "--question", "q"];
    expect(workflowArgumentsFor("needs-human", ask)).toMatchObject({ release: false });
    expect(workflowArgumentsFor("needs-human", [...ask, "--release"])).toMatchObject({
      release: true,
    });
    expect(() => workflowArgumentsFor("claim", ["7", "--agent", "a", "--release"])).toThrow();
  });
});
