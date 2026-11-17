import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { main } from "../cli.js";
import {
  permissionLookup,
  type PermissionLookup,
  type Query,
  type RepositoryPermission,
  type Rest,
} from "../github/github.js";
import {
  applyPlan,
  claimText,
  parseQuestionMarker,
  planClaim,
  planQuestionResolution,
  questionMarker,
  questionRecordBody,
  planNeedsHuman,
  planRelease,
} from "./claims.js";
import type { ReworkAuthority } from "./claims.js";
import type { ClaimAccepted, ClaimPlan, ClaimRefusal } from "./claims.js";
import { by, issue, page, repo, time } from "../testing/snapshots.js";
import { parseResolutionComment } from "./claimactivity.js";
import { permissions } from "../testing/fakegh.js";

/** Split a command as a POSIX shell would: single quotes, whitespace, and `#` comments. */
const shellWords = (command: string): string[] => {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error(`Unterminated quote: ${command}`);
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (ch === "\\") {
      word = (word ?? "") + (command[i + 1] ?? "");
      i++;
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "#" && word === null) break;
    else word = (word ?? "") + ch;
  }
  if (word !== null) words.push(word);
  return words;
};

describe("claim and needs-human (doc/design/workflow.md)", () => {
  type Ticket = {
    typename?: string;
    state?: string;
    labels?: string[];
    blockedBy?: number;
    openPrs?: number[];
    comments?: (string | { body: string; createdAt: string })[];
    labelledAt?: string;
    permission?: Record<string, RepositoryPermission>;
    claims?: number[];
    repoLabels?: string[];
    afterWriteOwners?: string[];
    failRecheck?: boolean;
  };
  const fake = (t: Ticket) => {
    let reads = 0;
    const query: Query = async (_source, variables) => {
      reads++;
      if (t.failRecheck && reads > 1) throw new Error("GitHub query failed.");
      const has = (name: unknown) =>
        (t.repoLabels ?? []).includes(String(name)) ? { name } : null;
      // After the first read, simulate the claim having been written (unless overridden).
      const labels =
        reads > 1
          ? [...(t.labels ?? []), ...(t.afterWriteOwners ?? ["agent:kavya"])]
          : (t.labels ?? []);
      return {
        repository: {
          issueOrPullRequest:
            t.typename === "missing"
              ? null
              : t.typename === "PullRequest"
                ? { __typename: "PullRequest", number: 7, url: `https://github.com/${repo}/pull/7` }
                : {
                    __typename: "Issue",
                    number: 7,
                    title: "Ticket 7",
                    url: `https://github.com/${repo}/issues/7`,
                    state: t.state ?? "OPEN",
                    updatedAt: time,
                    labels: page(labels.map((name) => ({ name }))),
                    issueDependenciesSummary: { blockedBy: t.blockedBy ?? 0 },
                    blockedBy: page(
                      t.blockedBy ? [{ number: 3, url: issue(3).url, state: "OPEN" }] : [],
                    ),
                    closedByPullRequestsReferences: page(
                      (t.openPrs ?? []).map((n) => ({
                        number: n,
                        url: `https://github.com/${repo}/pull/${n}`,
                        state: "OPEN",
                      })),
                    ),
                    comments: page(
                      (t.comments ?? []).map((c) => ({
                        ...by(),
                        ...(typeof c === "string" ? { body: c } : c),
                      })),
                    ),
                    timelineItems: page(
                      t.labelledAt
                        ? [{ createdAt: t.labelledAt, label: { name: "agent:kavya" } }]
                        : [],
                    ),
                  },
          claims: page(
            (t.claims ?? []).map((n) => ({ number: n, title: `Ticket ${n}`, url: issue(n).url })),
          ),
          ownerLabel: has(variables.label),
          questionLabel: has(variables.question),
          decisionLabel: has(variables.decision),
          needsDesignLabel: has(variables.needsDesign),
          attentionLabel: has(variables.attention),
        },
      };
    };
    const writes: string[][] = [];
    const run = async (args: string[]) => void writes.push(args);
    return { query, run, writes, permission: permissions(t.permission) };
  };
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  /** A recorded release handoff comment, as `release` writes it. */
  const doneBy = (
    agent: string,
    createdAt = "2026-11-12T10:00:00Z",
    outcome = "done",
    claimedAt: string | null = "2026-11-12T09:00:00Z",
  ) => ({
    body: `Handoff.\n\n<!-- github-triage:release:0123456789abcdef ${JSON.stringify({ v: 1, agent, outcome, target: "status:awaiting-review", remove: [], retained: [], claimedAt })} -->`,
    createdAt,
  });
  const claim = (t: Ticket, extra = {}) => {
    const env = fake(t);
    return planClaim(repo, { number: 7, agent: "kavya", ...extra }, env.query, env.permission);
  };

  it("claims an eligible ticket: creates the agent label if needed, swaps readiness, comments once", async () => {
    const env = fake({ labels: ["status:ready"] });
    const plan = await planClaim(repo, { number: 7, agent: "kavya", branch: "issue-7" }, env.query);
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w.slice(0, 2).join(" "))).toEqual([
      "label create",
      "issue edit",
      "issue comment",
    ]);
    expect(env.writes[1]).toEqual([
      "issue",
      "edit",
      "7",
      "--repo",
      repo,
      "--add-label",
      "agent:kavya",
      "--remove-label",
      "status:ready",
    ]);
    expect(env.writes[2].at(-1)).toMatch(/branch `issue-7`[\s\S]*<!-- github-triage:claim:/);
  });
  it("comments on every new acquisition, and on retry repairs only a missing comment", async () => {
    const first = await claim({ labels: ["status:ready"], repoLabels: ["agent:kavya"] });
    const comment = accepted(first)
      .changes.find((c) => c.step === "comment")!
      .command.at(-1)!;
    const marker = comment.match(/<!-- github-triage:claim:[0-9a-f]+ -->/)![0];
    // Released and claimed again later: the old comment must not suppress the new one.
    const again = await claim({
      labels: ["status:ready"],
      repoLabels: ["agent:kavya"],
      comments: [marker],
    });
    expect(accepted(again).changes.map((c) => c.step)).toEqual(["labels", "comment"]);
    // Labelled now, comment posted after the label was added: complete.
    const done = await claim({
      labels: ["agent:kavya"],
      claims: [7],
      comments: [{ body: marker, createdAt: at(1) }],
      labelledAt: at(2),
    });
    expect(done).toMatchObject({ ok: true, noop: true, changes: [] });
    // Labelled now, but the only claim comment predates this labelling: post it again.
    const stale = await claim({
      labels: ["agent:kavya"],
      claims: [7],
      comments: [{ body: marker, createdAt: at(5) }],
      labelledAt: at(2),
    });
    expect(accepted(stale).changes.map((c) => c.step)).toEqual(["comment"]);
    const repair = await claim({ labels: ["agent:kavya"], claims: [7] });
    expect(accepted(repair).changes.map((c) => c.step)).toEqual(["comment"]);
  });
  it("refuses with stable error IDs, facts and recovery commands", async () => {
    const cases: [Ticket, Record<string, string>, string][] = [
      [{ typename: "missing" }, {}, "TICKET_NOT_FOUND"],
      [{ typename: "PullRequest" }, {}, "NOT_AN_ISSUE"],
      [{ state: "CLOSED", labels: ["status:ready"] }, {}, "TICKET_CLOSED"],
      [{ labels: ["status:ready", "agent:other"] }, {}, "OWNED_BY_OTHER"],
      [{ labels: ["status:ready"], claims: [9] }, {}, "OTHER_ACTIVE_CLAIM"],
      [{ labels: ["status:needs-design"] }, {}, "NOT_READY"],
      [{ labels: ["status:ready", "question"] }, {}, "NOT_READY"],
      [{ labels: [] }, {}, "NOT_READY"],
      [{ labels: ["status:ready"], blockedBy: 1 }, {}, "BLOCKED"],
      [{ labels: ["status:ready"], openPrs: [12] }, {}, "HAS_OPEN_PR"],
      [{ labels: ["status:ready", "platform:ori"] }, {}, "PLATFORM_UNKNOWN"],
      [{ labels: ["status:ready", "platform:ori"] }, { platform: "codex" }, "PLATFORM_MISMATCH"],
    ];
    for (const [t, extra, id] of cases) {
      const plan = await claim(t, extra);
      expect(plan).toMatchObject({ ok: false, error: id });
      expect(refused(plan).prerequisite).toBeTruthy();
    }
    const owned = await claim({ labels: ["status:ready", "agent:other"] });
    expect(refused(owned).recovery.join(" ")).not.toMatch(/agent:other/);
    const other = await claim({ labels: ["status:ready"], claims: [9] });
    expect(refused(other).recovery[0]).toMatch(/^pdb release 9 --agent kavya --as incomplete/);
    expect(
      (await claim({ labels: ["status:incomplete", "platform:ori"] }, { platform: "ori" })).ok,
    ).toBe(true);
  });
  it("every suggested command keeps --repo executable: no shell comment swallows it", async () => {
    const plans = [
      await claim({ labels: ["status:ready"], claims: [9] }, { branch: "issue-7" }),
      await claim({ labels: ["status:ready"], blockedBy: 1 }),
      await claim({ labels: ["status:ready", "platform:ori"] }),
      await claim({
        labels: ["status:awaiting-review"],
        openPrs: [70],
        comments: [doneBy("kavya")],
      }),
      await claim({ labels: ["status:ready"], openPrs: [70], comments: [doneBy("kavya")] }),
    ];
    const commands = plans.flatMap((p) => refused(p).recovery);
    expect(commands.filter((c) => c.startsWith("pdb ")).length).toBeGreaterThan(5);
    for (const c of commands) {
      expect(c).not.toMatch(/(^|\s)#/);
      const words = shellWords(c);
      if (words[0] !== "pdb" && words[0] !== "gh") continue;
      expect(words.indexOf("--repo"), c).toBeGreaterThan(0);
      expect(words[words.indexOf("--repo") + 1], c).toBe(repo);
    }
    // The alternatives to the active claim are separate entries, each a whole command.
    const alternatives = refused(plans[0]).recovery.filter((c) => c.includes("release 9"));
    expect(alternatives.map((c) => shellWords(c)[5])).toEqual(["--as", "--as", "--as"]);
    expect(alternatives.map((c) => shellWords(c)[6])).toEqual(["incomplete", "ready", "done"]);
  });
  describe("review rework reclaim (doc/design/workflow.md: explicit reclaim)", () => {
    const waiting = (extra: Partial<Ticket> = {}): Ticket => ({
      labels: ["status:awaiting-review"],
      openPrs: [70],
      comments: [doneBy("kavya")],
      labelledAt: "2026-11-12T09:00:00Z",
      ...extra,
    });
    it("refuses rework authorised only by a handoff with an unknown claim time", async () => {
      const plan = await claim(
        waiting({ comments: [doneBy("kavya", "2026-11-12T10:00:00Z", "done", null)] }),
        { rework: true },
      );
      expect(plan).toMatchObject({ ok: false, error: "REWORK_NOT_AUTHORISED" });
    });
    it("refuses a plain claim on awaiting review but offers the explicit --rework reclaim", async () => {
      const plan = await claim(waiting());
      expect(plan).toMatchObject({ ok: false, error: "NOT_READY" });
      expect(refused(plan).recovery[0]).toBe(`pdb claim 7 --agent kavya --rework --repo ${repo}`);
    });
    it("reclaims the caller's own awaiting-review issue: claims and leaves review state", async () => {
      const env = fake({ ...waiting(), repoLabels: ["agent:kavya"] });
      const plan = await planClaim(
        repo,
        { number: 7, agent: "kavya", rework: true },
        env.query,
        env.permission,
      );
      const result = await applyPlan(repo, plan, env);
      expect(result.exitCode).toBe(0);
      expect(env.writes[0]).toEqual([
        "issue",
        "edit",
        "7",
        "--repo",
        repo,
        "--add-label",
        "agent:kavya",
        "--remove-label",
        "status:awaiting-review",
      ]);
      expect(env.writes[1].at(-1)).toMatch(/for review rework/);
    });
    it("is ownership-safe: refuses without the caller's own latest done handoff and an open PR", async () => {
      const cases: Ticket[] = [
        waiting({ comments: [doneBy("other")] }),
        waiting({ comments: [doneBy("kavya", "2026-11-12T09:00:00Z"), doneBy("other")] }),
        waiting({ comments: [doneBy("kavya", undefined, "incomplete")] }),
        waiting({ comments: [] }),
        waiting({ openPrs: [] }),
        waiting({ labels: ["status:ready"] }),
        waiting({ labels: ["status:awaiting-review", "agent:other"] }),
      ];
      for (const t of cases) {
        const plan = await claim(t, { rework: true });
        expect(plan.ok, JSON.stringify(t)).toBe(false);
        expect(["REWORK_NOT_AUTHORISED", "OWNED_BY_OTHER"]).toContain(refused(plan).error);
      }
      // Another agent is never offered the rework reclaim.
      const other = await planClaim(repo, { number: 7, agent: "nicole" }, fake(waiting()).query);
      expect(refused(other).recovery.join(" ")).not.toMatch(/--rework/);
    });
  });
  it("reports a competing claim found after writing instead of resolving it", async () => {
    const env = fake({
      labels: ["status:ready"],
      repoLabels: ["agent:kavya"],
      afterWriteOwners: ["agent:kavya", "agent:other"],
    });
    const result = await applyPlan(
      repo,
      await planClaim(repo, { number: 7, agent: "kavya" }, env.query),
      env,
    );
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/agent:other/);
    expect(env.writes.some((w) => w.includes("--remove-label") && w.includes("agent:other"))).toBe(
      false,
    );
  });
  it("declares every GraphQL variable it uses (the fake does not parse queries)", async () => {
    let source = "";
    await planClaim(repo, { number: 7, agent: "kavya" }, async (q, v) => {
      source = q;
      return fake({ labels: ["status:ready"] }).query(q, v);
    });
    const declared = new Set([...source.matchAll(/\$(\w+):/g)].map((m) => m[1]));
    const used = new Set([...source.matchAll(/\$(\w+)\b(?!:)/g)].map((m) => m[1]));
    for (const name of used) expect(declared.has(name), `$${name} is declared`).toBe(true);
  });
  it("finds existing labels by exact name, and keeps completed writes when the re-check fails", async () => {
    // Exact-name lookup: an existing label is never scheduled for creation.
    const existing = await claim({ labels: ["status:ready"], repoLabels: ["agent:kavya"] });
    expect(accepted(existing).changes.map((c) => c.step)).toEqual(["labels", "comment"]);
    const env = fake({ labels: ["status:ready"], repoLabels: ["agent:kavya"], failRecheck: true });
    const result = await applyPlan(
      repo,
      await planClaim(repo, { number: 7, agent: "kavya" }, env.query),
      env,
    );
    expect(result.exitCode).toBe(2);
    expect(result.steps!.map((s) => s.status)).toEqual(["done", "done"]);
    expect(result.unverified).toMatch(/could not be re-checked/);
  });
  it("records questions first, then marks decision-needed and, with --release, releases only the caller's claim", async () => {
    const env = fake({
      labels: ["status:ready", "agent:kavya", "agent:other"],
      repoLabels: ["question", "status:needs-design"],
    });
    const plan = await planNeedsHuman(
      repo,
      {
        number: 7,
        agent: "kavya",
        designer: "nicole",
        why: "Contract is ambiguous.",
        questions: ["Which file?", "Which default?"],
        release: true,
      },
      env.query,
    );
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w.slice(0, 2).join(" "))).toEqual([
      "issue comment",
      "label create",
      "label create",
      "issue edit",
    ]);
    expect(env.writes[0].at(-1)).toMatch(
      /^### Questions for the designer\n\nDesigner: `nicole` · Raised by: `kavya`\n\n\*\*Why:\*\* Contract is ambiguous\.\n\n1\. Which file\?\n2\. Which default\?/,
    );
    expect(env.writes.slice(1, 3).map((w) => w[2])).toEqual([
      "design:decision-needed",
      "attention:nicole",
    ]);
    const edit = env.writes[3];
    for (const l of [
      "question",
      "design:decision-needed",
      "status:needs-design",
      "attention:nicole",
    ])
      expect(edit).toContain(l);
    expect(edit.join(" ")).toContain("--remove-label status:ready");
    expect(edit.join(" ")).toContain("--remove-label agent:kavya");
    expect(edit.join(" ")).not.toContain("agent:other");
  });
  it("keeps the caller's claim by default (#412): the claim waits on the question", async () => {
    const env = fake({
      labels: ["status:ready", "agent:kavya"],
      repoLabels: ["question", "status:needs-design", "design:decision-needed", "attention:nicole"],
    });
    const plan = await planNeedsHuman(
      repo,
      { number: 7, agent: "kavya", designer: "nicole", why: "w", questions: ["q"] },
      env.query,
    );
    await applyPlan(repo, plan, env);
    const edit = env.writes.at(-1)!.join(" ");
    expect(edit).toContain("--remove-label status:ready");
    expect(edit).not.toContain("agent:kavya");
  });
  it("changes nothing when the questions comment fails, and keeps a deliberate blocked state", async () => {
    const env = fake({
      labels: ["status:ready"],
      repoLabels: ["question", "design:decision-needed", "status:needs-design"],
    });
    const plan = await planNeedsHuman(
      repo,
      { number: 7, agent: "kavya", designer: "nicole", why: "x", questions: ["q"] },
      env.query,
    );
    const failing = async (args: string[]) => {
      if (args[1] === "comment") throw new Error("gh issue comment failed.");
      env.writes.push(args);
    };
    const result = await applyPlan(repo, plan, { run: failing, query: env.query });
    expect(result.exitCode).toBe(1);
    expect(env.writes).toEqual([]);
    const blocked = await planNeedsHuman(
      repo,
      { number: 7, agent: "kavya", designer: "nicole", why: "x", questions: ["q"] },
      fake({
        labels: ["status:blocked", "blocked:credential"],
        repoLabels: ["question", "design:decision-needed"],
      }).query,
    );
    const edit = accepted(blocked).changes.find((c) => c.step === "labels")!.command;
    expect(edit).not.toContain("status:needs-design");
    expect(edit.join(" ")).not.toContain("blocked:credential");
    expect(accepted(blocked).notes![0]).toMatch(/status:blocked kept/);
  });
  it("validates arguments, and a dry run writes nothing", async () => {
    for (const bad of [
      ["claim"],
      ["claim", "x", "--agent", "a"],
      ["claim", "7", "--agent", "a", "--why", "w"],
      ["needs-human", "7", "--agent", "a", "--designer", "d", "--why", "w"],
      ["needs-human", "7", "--agent", "a", "--why", "w", "--question", "q"],
    ])
      await expect(main(bad, async () => {})).rejects.toThrow("Usage");
    const env = fake({ labels: ["status:ready"] });
    let text = "";
    const code = await main(
      ["claim", "7", "--agent", "kavya", "--dry-run", "--repo", repo],
      async (t) => void (text = t),
      {
        collect: async () => {
          throw new Error("no briefing");
        },
        currentRepository: async () => repo,
        query: env.query,
        ghRun: env.run,
      },
    );
    expect(code).toBe(0);
    expect(env.writes).toEqual([]);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("--add-label agent:kavya");
  });
});

describe("claim and needs-human review fixes", () => {
  const base = (labels: string[]) => ({
    repository: {
      issueOrPullRequest: {
        __typename: "Issue",
        number: 7,
        title: "T7",
        url: `https://github.com/${repo}/issues/7`,
        state: "OPEN",
        updatedAt: time,
        labels: page(labels.map((name) => ({ name }))),
        issueDependenciesSummary: { blockedBy: 0 },
        blockedBy: page([] as { number: number; url: string; state: string }[]),
        closedByPullRequestsReferences: page(
          [] as { number: number; url: string; state: string }[],
        ),
        comments: page([] as { body: string }[]),
      },
      claims: page([] as { number: number; title?: string; url?: string }[]),
      ownerLabel: { name: "agent:kavya" },
      questionLabel: { name: "question" },
      decisionLabel: { name: "design:decision-needed" },
      needsDesignLabel: { name: "status:needs-design" },
      attentionLabel: { name: "attention:nicole" },
    },
  });
  const ask = { number: 7, agent: "kavya", designer: "nicole", why: "w", questions: ["q"] };
  it("refuses to claim a blocked or parked ticket even when a stale ready label remains", async () => {
    for (const held of ["status:blocked", "status:parked"]) {
      const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () =>
        base(["status:ready", held]),
      );
      expect(plan).toMatchObject({ ok: false, error: "NOT_READY" });
      expect(refused(plan).prerequisite).toContain(held);
    }
  });
  it("needs-human keeps blocked, drops the stale ready label, and addresses the designer", async () => {
    const plan = await planNeedsHuman(repo, ask, async () =>
      base(["status:ready", "status:blocked"]),
    );
    const edit = accepted(plan)
      .changes.find((c) => c.step === "labels")!
      .command.join(" ");
    expect(edit).toContain("--remove-label status:ready");
    expect(edit).toContain("--add-label attention:nicole");
    expect(edit).not.toContain("status:needs-design");
    expect(accepted(plan).notes![0]).toMatch(/status:blocked kept/);
  });
  it("needs-human refuses before posting when labels are incomplete", async () => {
    const data = base(["status:ready"]);
    data.repository.issueOrPullRequest.labels.pageInfo.hasNextPage = true;
    expect(await planNeedsHuman(repo, ask, async () => data)).toMatchObject({
      ok: false,
      error: "EVIDENCE_INCOMPLETE",
    });
  });
  describe("needs-human dedupe marker authority (#214)", () => {
    /** The exact question comment needs-human would post, so its marker matches this request. */
    const questionBody = async () => {
      const plan = await planNeedsHuman(
        repo,
        ask,
        async () => base(["status:ready"]),
        permissions(),
      );
      return accepted(plan)
        .changes.find((c) => c.step === "comment")!
        .command.at(-1)!;
    };
    const withMarker = async (author: string) => {
      const data = base(["status:ready"]);
      (data.repository.issueOrPullRequest.comments as unknown) = page([
        { ...by(author), body: await questionBody(), createdAt: "2026-11-12T10:00:00Z" },
      ]);
      return async () => data;
    };
    const commented = (plan: Awaited<ReturnType<typeof planNeedsHuman>>) =>
      accepted(plan).changes.some((c) => c.step === "comment");
    it("a forged marker does not suppress the question and is named in a warning", async () => {
      const permission = permissions({ mallory: "read" });
      const plan = await planNeedsHuman(repo, ask, await withMarker("mallory"), permission);
      expect(commented(plan)).toBe(true);
      expect(accepted(plan).notes!.join(" ")).toMatch(
        /Ignored marker\(s\) without write authority:.*mallory has read permission/,
      );
      expect(permission.calls).toEqual(["mallory"]);
    });
    it("a genuine marker from a write author still deduplicates", async () => {
      const permission = permissions({ kavya: "write" });
      const plan = await planNeedsHuman(repo, ask, await withMarker("kavya"), permission);
      expect(commented(plan)).toBe(false);
      expect(permission.calls).toEqual(["kavya"]);
    });
    it("posts a v2 marker bound to this issue, and a legacy v1 record still deduplicates (#412)", async () => {
      const body = await questionBody();
      const marker = parseQuestionMarker(body);
      expect(marker).toMatchObject({ version: 2, repository: repo, issue: expect.any(Number) });
      expect(body).toMatch(/<!-- github-triage:needs-human:[0-9a-f]{16} v2 \{"v":2,/);
      // The same request recorded before #412, with the legacy marker, is still a repeat.
      const legacy = body.replace(/ v2 \{.*\} -->/, " -->");
      expect(parseQuestionMarker(legacy)).toEqual({ version: 1, opId: marker!.opId });
      const data = base(["status:ready"]);
      (data.repository.issueOrPullRequest.comments as unknown) = page([
        { ...by("kavya"), body: legacy, createdAt: "2026-11-12T10:00:00Z" },
      ]);
      const plan = await planNeedsHuman(
        repo,
        ask,
        async () => data,
        permissions({ kavya: "write" }),
      );
      expect(commented(plan)).toBe(false);
    });
    it("a damaged or copied marker of this request never suppresses the question (#412)", async () => {
      const body = await questionBody();
      for (const damaged of [
        body.replace(/ v2 \{.*\} -->/, ' v2 {"v":2} -->'),
        body.replace(/"issue":\d+/, '"issue":999'),
      ]) {
        const data = base(["status:ready"]);
        (data.repository.issueOrPullRequest.comments as unknown) = page([
          { ...by("kavya"), body: damaged, createdAt: "2026-11-12T10:00:00Z" },
        ]);
        const plan = await planNeedsHuman(
          repo,
          ask,
          async () => data,
          permissions({ kavya: "write" }),
        );
        expect(commented(plan)).toBe(true);
      }
    });
    it("a failed permission lookup does not suppress the question", async () => {
      const plan = await planNeedsHuman(
        repo,
        ask,
        await withMarker("kavya"),
        permissions({ kavya: "unknown" }),
      );
      expect(commented(plan)).toBe(true);
      expect(accepted(plan).notes!.join(" ")).toMatch(/could not be verified do not suppress/);
    });
    /** Comment pages newest first: page 0 is readTicket's window, later ones are older. */
    const paged = async (pages: { author: string; at: string }[][], endless = false) => {
      const body = await questionBody();
      const window = (i: number) => ({
        nodes: (pages[i] ?? []).map((c) => ({ ...by(c.author), body, createdAt: c.at })),
        pageInfo: { hasPreviousPage: endless || i + 1 < pages.length, startCursor: String(i + 1) },
      });
      const data = base(["status:ready"]);
      (data.repository.issueOrPullRequest.comments as unknown) = window(0);
      return async (source: string, variables: Record<string, unknown> = {}) =>
        source.includes("comments(last:100,before:$before)")
          ? { repository: { issue: { comments: window(Number(variables.before)) } } }
          : data;
    };
    it("a newer forged marker does not hide an older genuine one on an earlier page", async () => {
      const query = await paged([
        [{ author: "mallory", at: "2026-11-12T11:00:00Z" }],
        [{ author: "kavya", at: "2026-11-12T10:00:00Z" }],
      ]);
      const permission = permissions({ mallory: "read", kavya: "write" });
      const plan = await planNeedsHuman(repo, ask, query, permission);
      expect(commented(plan)).toBe(false);
    });
    it("refuses as incomplete evidence when the bound is reached with only forged markers", async () => {
      const query = await paged([[{ author: "mallory", at: "2026-11-12T11:00:00Z" }]], true);
      const plan = await planNeedsHuman(repo, ask, query, permissions({ mallory: "read" }));
      expect(refused(plan).error).toBe("EVIDENCE_INCOMPLETE");
    });
  });
  it("re-check reports a lost claim and a concurrent second claim by the same agent", async () => {
    const lost = async () => base(["status:ready"]);
    const r1 = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, lost), {
      run: async () => {},
      query: lost,
    });
    expect(r1.exitCode).toBe(2);
    expect(r1.conflict).toMatch(/no longer recorded/);
    let n = 0;
    const second = async () => {
      const d = base(n++ ? ["agent:kavya"] : ["status:ready"]);
      if (n > 1) d.repository.claims = page([{ number: 7 }, { number: 9 }]);
      return d;
    };
    const r2 = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, second), {
      run: async () => {},
      query: second,
    });
    expect(r2.exitCode).toBe(2);
    expect(r2.conflict).toMatch(/now also claims #9/);
  });
  it("recovery commands put the subcommand first, and displayed commands are shell-quoted", async () => {
    const blocked = base(["status:ready"]);
    blocked.repository.issueOrPullRequest.issueDependenciesSummary.blockedBy = 1;
    const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () => blocked);
    expect(refused(plan).recovery[0]).toBe(`pdb deps 7 --repo ${repo}`);
    const { shellQuote } = await import("./claims.js");
    expect(shellQuote("$(rm -rf x)")).toBe("'$(rm -rf x)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("--add-label")).toBe("--add-label");
  });
});

describe("claim ownership needs complete labels", () => {
  it("refuses before trusting an existing or competing claim when labels are incomplete", async () => {
    const data = (labels: string[]) => ({
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          number: 7,
          title: "T7",
          url: `https://github.com/${repo}/issues/7`,
          state: "OPEN",
          updatedAt: time,
          labels: {
            nodes: labels.map((name) => ({ name })),
            pageInfo: { hasNextPage: true, endCursor: "x" },
          },
          issueDependenciesSummary: { blockedBy: 0 },
          blockedBy: page([]),
          closedByPullRequestsReferences: page([]),
          comments: page([]),
          timelineItems: page([]),
        },
        claims: page([{ number: 7, title: "T7", url: issue(7).url }]),
        ownerLabel: { name: "agent:kavya" },
      },
    });
    for (const labels of [["agent:kavya"], ["status:ready"]]) {
      const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () => data(labels));
      expect(plan).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
    }
  });
});

describe("claim comment repair re-checks ownership", () => {
  it("reports a competing owner that appears while the missing claim comment is repaired", async () => {
    let reads = 0;
    const q = async () => {
      reads++;
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: "OPEN",
            updatedAt: time,
            labels: page(
              (reads > 1 ? ["agent:kavya", "agent:other"] : ["agent:kavya"]).map((name) => ({
                name,
              })),
            ),
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page([]),
            comments: page([]),
            timelineItems: page([]),
          },
          claims: page([{ number: 7, title: "T7", url: issue(7).url }]),
          ownerLabel: { name: "agent:kavya" },
        },
      };
    };
    const plan = await planClaim(repo, { number: 7, agent: "kavya" }, q);
    expect(accepted(plan).changes.map((c) => c.step)).toEqual(["comment"]);
    const result = await applyPlan(repo, plan, { run: async () => {}, query: q });
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/agent:other/);
  });
});

describe("post-write ownership check with incomplete labels", () => {
  it("reports ownership as unverified instead of confirming success", async () => {
    let reads = 0;
    const q = async () => {
      reads++;
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: "OPEN",
            updatedAt: time,
            labels: {
              nodes: (reads > 1 ? ["agent:kavya"] : ["status:ready"]).map((name) => ({ name })),
              pageInfo: { hasNextPage: reads > 1, endCursor: null },
            },
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page([]),
            comments: page([]),
            timelineItems: page([]),
          },
          claims: page(reads > 1 ? [{ number: 7, title: "T7", url: issue(7).url }] : []),
          ownerLabel: { name: "agent:kavya" },
        },
      };
    };
    const result = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, q), {
      run: async () => {},
      query: q,
    });
    expect(result.exitCode).toBe(2);
    expect(result.unverified).toMatch(/more than 100 labels/);
  });
});

/** Narrow a claim plan to the variant a test expects, failing loudly otherwise. */
function accepted(plan: ClaimPlan): ClaimAccepted {
  if (!plan.ok) throw new Error(`expected an accepted plan, got ${plan.error}`);
  return plan;
}

function refused(plan: ClaimPlan): ClaimRefusal {
  if (plan.ok) throw new Error("expected a refused plan");
  return plan;
}

describe("release: coordinated handoff (#62, doc/design/workflow.md)", () => {
  type Live = {
    labels: string[];
    comments: ({ body: string; createdAt: string } & Partial<ReturnType<typeof by>>)[];
    state?: string;
    permission?: Record<string, RepositoryPermission>;
    linkedOpenPr?: boolean;
    prState?: string | null;
    labelledAt?: string;
    events: { __typename?: string; createdAt: string; label: { name: string } }[];
  };
  /** A mutable fake GitHub: writes through `run` change what later reads see. */
  const live = (initial: Partial<Live> & { labels: string[] }) => {
    const labelledAt = "labelledAt" in initial ? initial.labelledAt : "2026-11-12T09:00:00.000Z";
    const s: Live = {
      comments: [],
      events: labelledAt ? [{ createdAt: labelledAt, label: { name: "agent:kavya" } }] : [],
      ...initial,
    };
    // A monotonic clock, so label events and comments are ordered like GitHub's.
    let ticks = 0;
    const tick = () => new Date(Date.parse(time) + ++ticks * 1000).toISOString();
    const addLabel = (name: string) => {
      s.labels.push(name);
      s.events.push({ createdAt: tick(), label: { name } });
    };
    const removeLabel = (name: string) => {
      s.labels = s.labels.filter((l) => l !== name);
      s.events.push({ __typename: "UnlabeledEvent", createdAt: tick(), label: { name } });
    };
    const writes: string[][] = [];
    // Label history paged like GitHub's: the newest 50, then older pages of 100 by cursor.
    const timeline = (end: number, size: number) => {
      const start = Math.max(0, end - size);
      return {
        nodes: s.events.slice(start, end),
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
      };
    };
    // Comments paged like GitHub's: the newest 100, then older pages of 100 by cursor.
    const commentWindow = (end: number) => {
      const start = Math.max(0, end - 100);
      return {
        nodes: s.comments.slice(start, end).map((c) => ({ ...by(), ...c })),
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
      };
    };
    const query = async (source: string, variables: Record<string, unknown> = {}) => {
      if (source.includes("comments(last:100,before:$before)"))
        return {
          repository: { issue: { comments: commentWindow(Number(variables.before)) } },
        };
      if (source.includes("before:$before"))
        return {
          repository: { issue: { timelineItems: timeline(Number(variables.before), 100) } },
        };
      if (source.includes("resource(url:"))
        return {
          resource: s.prState === null ? null : { __typename: "PullRequest", state: s.prState },
        };
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: s.state ?? "OPEN",
            updatedAt: time,
            labels: page(s.labels.map((name) => ({ name }))),
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page(
              s.linkedOpenPr
                ? [{ number: 70, url: `https://github.com/${repo}/pull/70`, state: "OPEN" }]
                : [],
            ),
            comments: commentWindow(s.comments.length),
            timelineItems: timeline(s.events.length, 50),
          },
          claims: page([]),
          ownerLabel: { name: "agent:kavya" },
          questionLabel: null,
          decisionLabel: null,
          needsDesignLabel: null,
          attentionLabel: null,
          targetLabel: variables.target ? { name: variables.target } : null,
        },
      };
    };
    const run = async (args: string[]) => {
      writes.push(args);
      if (args[1] === "edit")
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--add-label") addLabel(args[i + 1]);
          if (args[i] === "--remove-label") removeLabel(args[i + 1]);
        }
      if (args[1] === "comment")
        s.comments.push({ body: args[args.indexOf("--body") + 1], createdAt: tick() });
    };
    return {
      s,
      query,
      run,
      writes,
      addLabel,
      removeLabel,
      permission: permissions(initial.permission),
    };
  };
  const pr = `https://github.com/${repo}/pull/70`;
  const release = (env: ReturnType<typeof live>, extra: Record<string, unknown> = {}) =>
    planRelease(
      repo,
      { number: 7, agent: "kavya", outcome: "incomplete", ...extra },
      env.query,
      env.permission,
    );

  it("releases incomplete work with a note: the recorded handoff comment first, then labels", async () => {
    const env = live({ labels: ["agent:kavya", "bug", "question", "attention:nicole"] });
    const result = await applyPlan(
      repo,
      await release(env, { note: "Parser done; CLI remains." }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w[1])).toEqual(["comment", "edit"]);
    expect(env.s.labels.sort()).toEqual(
      ["attention:nicole", "bug", "question", "status:incomplete"].sort(),
    );
    expect(env.s.comments[0].body).toContain("Parser done; CLI remains.");
    expect(env.s.comments[0].body).toMatch(/<!-- github-triage:release:/);
  });
  it("every suggested release command keeps --repo executable", async () => {
    const note = "Fix # parser, it's half done";
    const plans = [
      await release(live({ labels: [] })),
      await release(live({ labels: ["agent:kavya"], state: "CLOSED" }), { pr }),
      await release(live({ labels: ["agent:kavya"] }), { note }),
    ];
    const commands = plans.flatMap((p) => (p.ok ? [p.retry!] : [...p.recovery]));
    expect(commands.length).toBeGreaterThan(3);
    for (const c of commands) {
      const words = shellWords(c);
      if (words[0] !== "pdb" && words[0] !== "gh") continue;
      expect(words[words.indexOf("--repo") + 1], c).toBe(repo);
    }
    expect(shellWords(accepted(plans[2]).retry!)).toContain(note);
  });
  it("releases without a note: never a gate, but noted; parked maps to status:incomplete", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const plan = await release(env, { outcome: "parked" });
    expect(accepted(plan).notes!.join(" ")).toMatch(/No handoff note/);
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:incomplete"]);
    expect(env.s.labels).not.toContain("status:parked");
    expect(env.s.comments[0].body).toContain("No handoff note supplied");
  });
  it("ready returns untouched work to pickup and drops a stale awaiting-review label", async () => {
    const env = live({ labels: ["agent:kavya", "status:awaiting-review"] });
    await applyPlan(repo, await release(env, { outcome: "ready" }), env);
    expect(env.s.labels).toEqual(["status:ready"]);
  });
  it("done with an open PR awaits review and leaves pickup; never closes", async () => {
    const env = live({ labels: ["agent:kavya", "status:ready"], prState: "OPEN" });
    const plan = await release(env, { outcome: "done", pr, note: "Ready for review." });
    expect(plan).toMatchObject({
      ok: true,
      facts: { target: "status:awaiting-review", pullRequestState: "OPEN" },
    });
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:awaiting-review"]);
    expect(env.writes.flat().join(" ")).not.toMatch(/close/);
    // A PR linked to the issue counts even without --pr.
    const linked = live({ labels: ["agent:kavya"], linkedOpenPr: true });
    expect(accepted(await release(linked, { outcome: "done" })).facts.target).toBe(
      "status:awaiting-review",
    );
  });
  it("done without an open PR releases without returning to pickup or closing; unknown PR stays unknown", async () => {
    const env = live({ labels: ["agent:kavya", "status:incomplete"], prState: "MERGED" });
    const plan = await release(env, { outcome: "done", pr });
    expect(accepted(plan).facts.target).toBeNull();
    await applyPlan(repo, plan, env);
    expect(env.s.labels).toEqual([]);
    const unknown = live({ labels: ["agent:kavya"], prState: null });
    const u = accepted(await release(unknown, { outcome: "done", pr }));
    expect(u.facts.pullRequestState).toBe("UNKNOWN");
    expect(u.facts.target).toBeNull();
    expect(u.notes!.join(" ")).toMatch(/UNKNOWN/);
  });
  it("done --pr is deprecated: it names the equivalent submit command; other outcomes do not", async () => {
    const env = live({ labels: ["agent:kavya"], prState: "OPEN" });
    const plan = accepted(await release(env, { outcome: "done", pr }));
    expect(plan.notes).toContain(
      `Deprecated: release --as done --pr writes a release record only, never a delivery record. Use: pdb submit 7 --agent kavya --pr ${pr} --repo ${repo}`,
    );
    const noPr = accepted(await release(live({ labels: ["agent:kavya"] }), { outcome: "done" }));
    expect(noPr.notes!.join(" ")).not.toMatch(/Deprecated/);
    const ready = accepted(await release(live({ labels: ["agent:kavya"] }), { outcome: "ready" }));
    expect(ready.notes!.join(" ")).not.toMatch(/Deprecated/);
  });
  it("refuses when the caller holds no claim or another agent owns it; keeps other owners", async () => {
    const other = live({ labels: ["agent:other", "status:ready"], labelledAt: undefined });
    expect(await release(other)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    // Someone else claimed after our label was removed: re-evaluate, never post.
    const taken = live({ labels: ["agent:other", "status:incomplete"] });
    expect(await release(taken)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    const shared = live({ labels: ["agent:kavya", "agent:other"] });
    const plan = await release(shared);
    expect(accepted(plan).notes!.join(" ")).toMatch(/Other owners kept: agent:other/);
    await applyPlan(repo, plan, shared);
    expect(shared.s.labels).toContain("agent:other");
    const many = live({ labels: ["agent:kavya"] });
    const q = async (source: string) => {
      const d = (await many.query(source)) as ReturnType<typeof Object>;
      (
        d as {
          repository: { issueOrPullRequest: { labels: { pageInfo: { hasNextPage: boolean } } } };
        }
      ).repository.issueOrPullRequest.labels.pageInfo.hasNextPage = true;
      return d;
    };
    expect(
      await planRelease(repo, { number: 7, agent: "kavya", outcome: "ready" }, q),
    ).toMatchObject({
      ok: false,
      error: "EVIDENCE_INCOMPLETE",
    });
  });
  it("reports a concurrent change after writing as a conflict", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const plan = await release(env);
    const racing = async (args: string[]) => {
      await env.run(args);
      if (args[1] === "edit") env.s.labels = env.s.labels.filter((l) => l !== "status:incomplete");
    };
    const result = await applyPlan(repo, plan, { run: racing, query: env.query });
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/status:incomplete is no longer/);
  });
  it("partial API failure: the recorded intent is visible, retry applies only its labels once", async () => {
    const env = live({ labels: ["agent:kavya", "status:ready"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    const first = await applyPlan(repo, await release(env, { note: "half" }), {
      run: failing,
      query: env.query,
    });
    expect(first.exitCode).toBe(2);
    expect(first.steps!.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(env.s.labels).toEqual(["agent:kavya", "status:ready"]);
    const { claimText } = await import("./claims.js");
    expect(claimText(first)).toMatch(
      /Retry \(safe.*pdb release 7 --agent kavya --as incomplete --note half --repo/,
    );
    const retry = await release(env, { note: "half" });
    expect(accepted(retry).changes.map((c) => c.step)).toEqual(["labels"]);
    expect((await applyPlan(repo, retry, env)).exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:incomplete"]);
    expect(env.s.comments).toHaveLength(1);
    // A further retry, even with different wording, recognises the recorded handoff.
    const again = await release(env, { note: "different" });
    expect(again).toMatchObject({ ok: true, noop: true, changes: [] });
    expect((await applyPlan(repo, again, env)).exitCode).toBe(0);
    expect(env.s.comments).toHaveLength(1);
  });
  it("never treats a historical claim label as release authorisation", async () => {
    // The claim was removed some other way: no recorded handoff, so nothing is stripped or posted.
    const env = live({ labels: ["status:ready"] });
    expect(await release(env, { outcome: "ready" })).toMatchObject({
      ok: false,
      error: "NOT_CLAIMED",
    });
    expect(await release(env, { outcome: "done" })).toMatchObject({
      ok: false,
      error: "NOT_CLAIMED",
    });
    // A marker with an unparsable plan is not authorisation either.
    env.s.comments.push({
      body: "<!-- github-triage:release:0123456789abcdef {broken -->",
      createdAt: time,
    });
    expect(await release(env, { outcome: "ready" })).toMatchObject({ ok: false });
  });
  it("a retry keeps the owners the original release retained", async () => {
    const env = live({ labels: ["agent:kavya", "agent:other"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    await applyPlan(repo, await release(env), { run: failing, query: env.query });
    // The label write failed: our claim label is still there, so the step is unfinished.
    expect(env.s.labels.sort()).toEqual(["agent:kavya", "agent:other"]);
    const retry = accepted(await release(env));
    expect(retry.changes.map((c) => c.step)).toEqual(["labels"]);
    expect(retry.notes!.join(" ")).toMatch(/Other owners kept: agent:other/);
    expect((await applyPlan(repo, retry, env)).exitCode).toBe(0);
    expect(env.s.labels.sort()).toEqual(["agent:other", "status:incomplete"]);
    expect(env.s.comments).toHaveLength(1);
  });
  it("refuses a retry when ownership or readiness changed after the recorded handoff", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    await applyPlan(repo, await release(env), { run: failing, query: env.query });
    env.addLabel("agent:newcomer");
    expect(await release(env)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    const ready = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(ready), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await ready.run(args);
      },
      query: ready.query,
    });
    ready.addLabel("status:ready");
    expect(await release(ready)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    // A different outcome cannot replace a recorded, unfinished one.
    const pending = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(pending), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await pending.run(args);
      },
      query: pending.query,
    });
    expect(await release(pending, { outcome: "ready" })).toMatchObject({
      ok: false,
      error: "RELEASE_PENDING",
    });
  });
  describe("records beyond the newest page of comments (Codex P2)", () => {
    const noise = async (env: ReturnType<typeof live>, n: number) => {
      for (let i = 0; i < n; i++)
        await env.run(["issue", "comment", "7", "--repo", repo, "--body", `noise ${i}`]);
    };
    // A handoff whose comment posted but whose label write failed.
    const interrupted = async () => {
      const env = live({ labels: ["agent:kavya"] });
      await applyPlan(repo, await release(env), {
        run: async (args) => {
          if (args[1] === "edit") throw new Error("failed");
          await env.run(args);
        },
        query: env.query,
      });
      return env;
    };
    it("release finds an interrupted handoff buried under more than 100 comments", async () => {
      const env = await interrupted();
      await noise(env, 150);
      // The recorded outcome still governs: a different outcome is not a new handoff.
      expect(await release(env, { outcome: "ready" })).toMatchObject({
        ok: false,
        error: "RELEASE_PENDING",
      });
      const retry = await release(env);
      expect(retry).toMatchObject({ ok: true, reason: expect.stringMatching(/already recorded/) });
      expect(accepted(retry).changes.map((c) => c.step)).not.toContain("comment");
    });
    it("release refuses EVIDENCE_INCOMPLETE when the claim start is beyond the bounded read", async () => {
      const env = await interrupted();
      await noise(env, 700);
      expect(await release(env, { outcome: "ready" })).toMatchObject({
        ok: false,
        error: "EVIDENCE_INCOMPLETE",
      });
    });
    const handedOver = async (n: number) => {
      const env = live({ labels: ["agent:kavya"], linkedOpenPr: true });
      expect((await applyPlan(repo, await release(env, { outcome: "done" }), env)).exitCode).toBe(
        0,
      );
      await noise(env, n);
      return planClaim(
        repo,
        { number: 7, agent: "kavya", rework: true },
        env.query,
        env.permission,
      );
    };
    it("rework finds the caller's done handoff buried under more than 100 comments", async () => {
      expect(await handedOver(150)).toMatchObject({ ok: true, noop: false });
    });
    it("rework refuses EVIDENCE_INCOMPLETE when no handoff is within the bounded read", async () => {
      expect(await handedOver(700)).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
    });
  });
  describe("post-write check with missing or truncated evidence (Codex P2)", () => {
    const reread = (env: ReturnType<typeof live>, edit: (r: any) => void) => {
      let writes = 0;
      return {
        run: async (args: string[]) => {
          writes++;
          await env.run(args);
        },
        query: async (source: string, variables: Record<string, unknown> = {}) => {
          const r: any = await env.query(source, variables);
          if (writes && r?.repository?.issueOrPullRequest) edit(r);
          return r;
        },
      };
    };
    it("release reports unverified (exit 2) when the re-read issue is missing", async () => {
      const env = live({ labels: ["agent:kavya"] });
      const result = await applyPlan(
        repo,
        await release(env),
        reread(env, (r) => (r.repository.issueOrPullRequest = null)),
      );
      expect(result.exitCode).toBe(2);
      expect(result.conflict).toBeNull();
      expect(result.unverified).toMatch(/could not be re-read/);
      expect(result.unverified).toMatch(/who 7/);
      expect(claimText(result)).toMatch(/UNVERIFIED/);
    });
    it("release reports unverified when the re-read label page is truncated", async () => {
      const env = live({ labels: ["agent:kavya"] });
      const result = await applyPlan(
        repo,
        await release(env),
        reread(env, (r) => (r.repository.issueOrPullRequest.labels.pageInfo.hasNextPage = true)),
      );
      expect(result.exitCode).toBe(2);
      expect(result.unverified).toMatch(/more than 100 labels/);
    });
    it("claim reports unverified when the re-read issue is missing", async () => {
      const env = live({ labels: ["status:ready"], labelledAt: undefined });
      const result = await applyPlan(
        repo,
        await planClaim(repo, { number: 7, agent: "kavya" }, env.query),
        reread(env, (r) => (r.repository.issueOrPullRequest = null)),
      );
      expect(result.exitCode).toBe(2);
      expect(result.unverified).toMatch(/could not be re-read/);
    });
  });
  describe("claim identity beyond the first page of label history (Codex P2)", () => {
    const at = (n: number) =>
      new Date(Date.parse("2026-11-12T09:00:00.000Z") + n * 1000).toISOString();
    // A handoff from an earlier acquisition whose claim time was never established.
    const unknownHandoff = (outcome = "incomplete") => {
      const op = `<!-- github-triage:release:${createHash("sha256")
        .update(JSON.stringify([repo, 7, "kavya", null]))
        .digest("hex")
        .slice(0, 16)}`;
      const plan = {
        v: 1,
        agent: "kavya",
        outcome,
        target: "status:incomplete",
        remove: ["agent:kavya"],
        retained: [],
        claimedAt: null,
      };
      return { body: `Handoff.\n\n${op} ${JSON.stringify(plan)} -->`, createdAt: at(5) };
    };
    // The current claim's add event, followed by more noise than one page holds.
    const buried = (noise: number) => {
      const events: Live["events"] = [{ createdAt: at(10), label: { name: "agent:kavya" } }];
      for (let i = 0; i < noise; i++)
        events.push({
          ...(i % 2 ? { __typename: "UnlabeledEvent" } : {}),
          createdAt: at(11 + i),
          label: { name: "noise" },
        });
      return events;
    };
    it("finds the claim time by paging back, so an older handoff is not matched", async () => {
      const env = live({
        labels: ["agent:kavya"],
        comments: [unknownHandoff()],
        events: buried(60),
      });
      const plan = await release(env, { outcome: "ready" });
      expect(plan).toMatchObject({ ok: true, noop: false });
      expect(accepted(plan).changes.map((c) => c.step)).toContain("comment");
      expect(
        accepted(plan)
          .changes.find((c) => c.step === "comment")!
          .command.at(-1),
      ).toContain(`"claimedAt":"${at(10)}"`);
    });
    it("refuses EVIDENCE_INCOMPLETE when the claim time is beyond the bounded search", async () => {
      const env = live({
        labels: ["agent:kavya"],
        comments: [unknownHandoff()],
        events: buried(400),
      });
      const plan = await release(env, { outcome: "ready" });
      expect(plan).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
      expect(refused(plan).recovery.length).toBeGreaterThan(0);
      // Same outcome as the old handoff: still never replayed.
      expect(await release(env)).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
    });
    it("never matches a handoff recorded with no claim time, even with no visible claim", async () => {
      const env = live({ labels: [], comments: [unknownHandoff()], labelledAt: undefined });
      expect(await release(env)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    });
  });
  it("never restores labels from a completed handoff after others changed them", async () => {
    // Codex P2: done with an open PR, PR merged, a maintainer removes the review label.
    const env = live({ labels: ["agent:kavya"], linkedOpenPr: true });
    expect((await applyPlan(repo, await release(env, { outcome: "done" }), env)).exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:awaiting-review"]);
    env.s.linkedOpenPr = false;
    env.removeLabel("status:awaiting-review");
    const rerun = await release(env, { outcome: "done" });
    expect(rerun).toMatchObject({ ok: true, noop: true, changes: [] });
    const before = env.writes.length;
    expect((await applyPlan(repo, rerun, env)).exitCode).toBe(0);
    expect(env.writes).toHaveLength(before);
    expect(env.s.labels).toEqual([]);
  });
  it("refuses an unfinished retry when a plan label was removed after the handoff", async () => {
    const env = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(env), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await env.run(args);
      },
      query: env.query,
    });
    // Someone applied the recorded target, then deliberately took it off again.
    env.addLabel("status:incomplete");
    env.removeLabel("status:incomplete");
    expect(await release(env)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    expect(env.s.labels).toContain("agent:kavya");
  });
  it("done: a linked open closing PR awaits review even when the supplied --pr is merged or unknown", async () => {
    for (const prState of ["MERGED", "CLOSED", null]) {
      const env = live({ labels: ["agent:kavya"], prState, linkedOpenPr: true });
      const plan = accepted(
        await release(env, { outcome: "done", pr: `https://github.com/${repo}/pull/69` }),
      );
      expect(plan.facts.target).toBe("status:awaiting-review");
    }
  });
  it("validates arguments and dry-runs without writing", async () => {
    for (const bad of [
      ["release", "7", "--agent", "a"],
      ["release", "7", "--agent", "a", "--as", "closed"],
      ["release", "7", "--agent", "a", "--as", "done", "--pr", pr, "--change", "https://x/y"],
      ["release", "7", "--agent", "a", "--as", "done", "--pr", "not-a-url"],
      ["release", "7", "--agent", "a", "--as", "ready", "--branch", "b"],
      ["claim", "7", "--agent", "a", "--as", "ready"],
    ])
      await expect(main(bad, async () => {})).rejects.toThrow();
    let help = "";
    expect(await main(["release", "--help"], async (t) => void (help = t))).toBe(0);
    expect(help).toMatch(/parked is a synonym/);
    const env = live({ labels: ["agent:kavya"] });
    let text = "";
    const code = await main(
      [
        "release",
        "7",
        "--agent",
        "kavya",
        "--as",
        "incomplete",
        "--dry-run",
        "--json",
        "--repo",
        repo,
      ],
      async (t) => void (text = t),
      {
        collect: async () => {
          throw new Error("no briefing");
        },
        currentRepository: async () => repo,
        query: env.query,
        ghRun: env.run,
        // No marker to verify, so no permission lookup; never a live call.
        rest: async () => {
          throw new Error("no live permission calls in tests");
        },
      },
    );
    expect(code).toBe(0);
    expect(env.writes).toEqual([]);
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      facts: { outcome: "incomplete" },
    });
  });
  describe("marker authority: only current writers' markers drive writes (#212)", () => {
    const since = "2026-11-12T09:00:00.000Z";
    const later = (n: number) => new Date(Date.parse(time) + 3_600_000 + n * 1000).toISOString();
    const releaseOp = (claimedAt: string | null = since) =>
      `<!-- github-triage:release:${createHash("sha256")
        .update(JSON.stringify([repo, 7, "kavya", claimedAt]))
        .digest("hex")
        .slice(0, 16)}`;
    /** A release record in the exact public format, posted by whoever `author` says. */
    const handoff = (
      plan: Partial<{
        agent: string;
        outcome: string;
        target: string | null;
        claimedAt: string | null;
      }>,
      createdAt: string,
      author: Partial<ReturnType<typeof by>> = by(),
    ) => {
      const record = {
        v: 1,
        agent: "kavya",
        outcome: "done",
        target: "status:awaiting-review",
        remove: ["agent:kavya"],
        retained: [],
        claimedAt: since,
        ...plan,
      };
      return {
        body: `Handoff.\n\n${releaseOp(record.claimedAt)} ${JSON.stringify(record)} -->`,
        createdAt,
        ...by(),
        ...author,
      };
    };
    const mallory = by("mallory");
    /** kavya handed over with done; the issue awaits review on an open PR. */
    const awaiting = (
      comments: Live["comments"],
      permission: Record<string, RepositoryPermission> = {},
    ) =>
      live({
        labels: ["status:awaiting-review"],
        linkedOpenPr: true,
        comments,
        permission: { mallory: "read", ...permission },
      });
    const rework = (env: ReturnType<typeof live>, permission: PermissionLookup = env.permission) =>
      planClaim(repo, { number: 7, agent: "kavya", rework: true }, env.query, permission);

    const withAuthority = (env: ReturnType<typeof live>, authority: ReworkAuthority) => {
      let calls = 0;
      const plan = planClaim(
        repo,
        { number: 7, agent: "kavya", rework: true },
        env.query,
        env.permission,
        async () => {
          calls++;
          return authority;
        },
      );
      return { plan, calls: () => calls };
    };
    it("S21/S29: the ticket-responsible agent claims rework with no open PR and no v1 handoff", async () => {
      const env = live({ labels: ["status:awaiting-review"], labelledAt: undefined });
      const plan = accepted(await withAuthority(env, { path: "delivery" }).plan);
      expect(plan.notes!.join(" ")).toMatch(/membership open, reason "rework claim"/);
      await applyPlan(repo, plan, env);
      expect(env.s.labels).toEqual(["agent:kavya"]);
    });
    it("S30/S65: a delivery-record refusal is final; a valid v1 done handoff never authorises", async () => {
      const env = awaiting([handoff({}, later(1))]);
      const plan = await withAuthority(env, {
        refusal: {
          error: "NOT_RESPONSIBLE",
          prerequisite: "kavya is not ticket-responsible",
          recovery: [`pdb who 7 --repo ${repo}`],
        },
      }).plan;
      expect(plan).toMatchObject({ ok: false, error: "NOT_RESPONSIBLE" });
      expect(env.writes).toEqual([]);
    });
    it("S31: unknown record authority refuses MARKER_UNVERIFIED with no fallback", async () => {
      const env = awaiting([handoff({}, later(1))]);
      const plan = await withAuthority(env, {
        refusal: {
          error: "MARKER_UNVERIFIED",
          prerequisite: "unknown",
          recovery: [`pdb who 7 --repo ${repo}`],
        },
      }).plan;
      expect(plan).toMatchObject({ ok: false, error: "MARKER_UNVERIFIED" });
    });
    it("rework refuses a closed issue before consulting delivery records", async () => {
      const env = live({
        labels: ["status:awaiting-review"],
        state: "CLOSED",
        labelledAt: undefined,
      });
      const run = withAuthority(env, { path: "delivery" });
      expect(await run.plan).toMatchObject({ ok: false, error: "TICKET_CLOSED" });
      expect(run.calls()).toBe(0);
    });
    it("legacy authority keeps the v1 rule unchanged", async () => {
      const env = awaiting([handoff({}, later(1))]);
      expect((await withAuthority(env, { path: "legacy" }).plan).ok).toBe(true);
      const none = awaiting([]);
      expect(await withAuthority(none, { path: "legacy" }).plan).toMatchObject({
        ok: false,
        error: "REWORK_NOT_AUTHORISED",
      });
    });
    it("(a) a forged done marker from a read-only author does not authorise rework", async () => {
      const env = awaiting([handoff({}, later(1), mallory)]);
      const plan = await rework(env);
      expect(plan).toMatchObject({ ok: false, error: "REWORK_NOT_AUTHORISED" });
      expect(refused(plan).prerequisite).toMatch(/mallory has read permission/);
      expect(env.permission.calls).toEqual(["mallory"]);
    });
    it("(b) a forged release marker neither changes nor suppresses a release retry", async () => {
      // An interrupted genuine handoff, then a forged newer record with a different target.
      const env = live({ labels: ["agent:kavya"], permission: { mallory: "read" } });
      await applyPlan(repo, await release(env), {
        run: async (args) => {
          if (args[1] === "edit") throw new Error("failed");
          await env.run(args);
        },
        query: env.query,
      });
      env.s.comments.push(
        handoff({ outcome: "incomplete", target: "status:ready" }, later(1), mallory),
      );
      const retry = accepted(await release(env));
      expect(retry.facts.target).toBe("status:incomplete");
      expect(retry.changes.map((c) => c.command.join(" ")).join(" ")).not.toMatch(/status:ready/);
      expect(retry.notes?.join(" ")).toMatch(/Ignored marker.*mallory has read permission/);
      // With no genuine record, a forged one cannot turn the release into a silent no-op.
      const fresh = live({ labels: ["agent:kavya"], permission: { mallory: "read" } });
      fresh.s.comments.push(handoff({ outcome: "incomplete" }, later(1), mallory));
      const plan = accepted(await release(fresh, { note: "n" }));
      expect(plan.changes.map((c) => c.step)).toContain("comment");
      // Nor can a forged claim marker suppress the claim comment.
      const claimed = live({ labels: ["agent:kavya"], permission: { mallory: "read" } });
      const op = `<!-- github-triage:claim:${createHash("sha256")
        .update(JSON.stringify([repo, 7, "kavya"]))
        .digest("hex")
        .slice(0, 16)} -->`;
      claimed.s.comments.push({ body: op, createdAt: later(1), ...mallory });
      const repair = accepted(
        await planClaim(repo, { number: 7, agent: "kavya" }, claimed.query, claimed.permission),
      );
      expect(repair.changes.map((c) => c.step)).toEqual(["comment"]);
      expect(repair.notes?.join(" ")).toMatch(/mallory/);
    });
    it("(c) a genuine write-author marker still works, even under a newer forged one", async () => {
      expect(await rework(awaiting([handoff({}, later(1))]))).toMatchObject({ ok: true });
      const env = awaiting([
        handoff({}, later(1)),
        handoff({ agent: "other", outcome: "incomplete" }, later(2), mallory),
      ]);
      const plan = accepted(await rework(env));
      expect(plan.notes?.join(" ")).toMatch(/mallory/);
      // Maintain and admin carry the same authority as write.
      for (const level of ["maintain", "admin"] as const)
        expect(await rework(awaiting([handoff({}, later(1))], { kavya: level }))).toMatchObject({
          ok: true,
        });
      // An app or bot account has none, whatever its permission.
      const bot = { author: { __typename: "Bot", login: "github-actions" } };
      expect(await rework(awaiting([handoff({}, later(1), bot)]))).toMatchObject({
        ok: false,
        error: "REWORK_NOT_AUTHORISED",
      });
    });
    it("(d) a marker edited by a non-writer is refused; an unknown editor is unverified", async () => {
      const edited = (editor: { __typename: string; login: string } | null) =>
        awaiting([handoff({}, later(1), { lastEditedAt: later(2), editor })]);
      expect(await rework(edited(mallory.author))).toMatchObject({
        ok: false,
        error: "REWORK_NOT_AUTHORISED",
        prerequisite: expect.stringMatching(/editor mallory has read permission/),
      });
      expect(await rework(edited(null))).toMatchObject({ ok: false, error: "MARKER_UNVERIFIED" });
      // The author's own edit keeps its authority.
      expect(await rework(edited(by().author))).toMatchObject({ ok: true });
    });
    it("(e) a failed or rate-limited permission lookup is unknown and refused", async () => {
      const env = awaiting([handoff({}, later(1))], { kavya: "unknown" });
      const plan = await rework(env);
      expect(plan).toMatchObject({ ok: false, error: "MARKER_UNVERIFIED" });
      expect(refused(plan).prerequisite).toMatch(/a maintainer must re-post or confirm/);
      // The real lookup turns every failure into unknown, through the injected REST boundary.
      const failures: Rest[] = [
        async () => ({ status: 403, body: { message: "API rate limit exceeded", status: "403" } }),
        async () => ({ status: 404, body: { message: "Not Found", status: "404" } }),
        async () => ({ status: null, body: null }),
        async () => {
          throw new Error("network");
        },
        async () => ({ status: 200, body: { permission: "write", user: { login: "someone" } } }),
        async () => ({ status: 200, body: { permission: "weird" } }),
      ];
      for (const rest of failures)
        expect(await permissionLookup(repo, rest)("kavya")).toBe("unknown");
      const unknown = await rework(
        awaiting([handoff({}, later(1))]),
        permissionLookup(repo, failures[0]),
      );
      expect(unknown).toMatchObject({ ok: false, error: "MARKER_UNVERIFIED" });
      // An interrupted release retry is refused too, never repaired on unverified intent.
      const retry = live({ labels: ["agent:kavya"], permission: { kavya: "unknown" } });
      retry.s.comments.push(
        handoff({ outcome: "incomplete", target: "status:incomplete" }, later(1)),
      );
      expect(await release(retry)).toMatchObject({ ok: false, error: "MARKER_UNVERIFIED" });
    });
    it("(f) a done marker recorded for another claim time does not authorise rework", async () => {
      const env = awaiting([handoff({ claimedAt: "2026-11-12T08:00:00.000Z" }, later(1))]);
      expect(await rework(env)).toMatchObject({ ok: false, error: "REWORK_NOT_AUTHORISED" });
    });
    it("(g) permissions are cached per run: one request per distinct author, never reused", async () => {
      const paths: string[] = [];
      const rest: Rest = async (path) => {
        paths.push(path);
        return {
          status: 200,
          body: path.includes("/kavya/")
            ? { permission: "write", role_name: "maintain", user: { login: "kavya" } }
            : { permission: "read", role_name: "read", user: { login: "mallory" } },
        };
      };
      const comments = [
        handoff({}, later(1)),
        handoff({ agent: "other" }, later(2), mallory),
        handoff({ agent: "other" }, later(3), mallory),
      ];
      const first = await rework(awaiting(comments), permissionLookup(repo, rest));
      expect(first).toMatchObject({ ok: true });
      expect(paths).toEqual([
        `repos/${repo}/collaborators/mallory/permission`,
        `repos/${repo}/collaborators/kavya/permission`,
      ]);
      // A new run asks again: nothing is remembered between runs.
      await rework(awaiting(comments), permissionLookup(repo, rest));
      expect(paths).toHaveLength(4);
    });
  });
});

describe("needs-human question markers (#412)", () => {
  it("parses v1 and exact v2 markers; anything else is malformed, never legacy", () => {
    const id = "0123456789abcdef";
    expect(parseQuestionMarker("no marker")).toBeNull();
    expect(parseQuestionMarker(`<!-- github-triage:needs-human:${id} -->`)).toEqual({
      version: 1,
      opId: id,
    });
    const v2 = `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"o/r","issue":7,"resolution":"explicit"} -->`;
    expect(parseQuestionMarker(v2)).toEqual({ version: 2, opId: id, repository: "o/r", issue: 7 });
    for (const bad of [
      `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"o/r","issue":7} -->`,
      `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"o/r","issue":7,"resolution":"labels"} -->`,
      `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"o/r","issue":0,"resolution":"explicit"} -->`,
      `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"o/r","issue":7,"resolution":"explicit","x":1} -->`,
      `<!-- github-triage:needs-human:${id} v2 not json -->`,
      `<!-- github-triage:needs-human:${id} v2 {"v":2`,
      `<!-- github-triage:needs-human:XYZ -->`,
    ])
      expect(parseQuestionMarker(bad)?.version, bad).toBe("malformed");
  });
});

describe("question resolve and withdraw (#412)", () => {
  const url = (id: number, issueNumber = 7) =>
    `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${id}`;
  const questionBody = (boundTo = 7) =>
    questionRecordBody(
      { designer: "nicole", agent: "kavya", why: "w", questions: ["q"] },
      questionMarker("0123456789abcdef", repo, boundTo),
    );
  let ids = 5000;
  const note = (body: string, login = "kavya", at = "2026-11-15T01:00:00Z") => ({
    ...by(login),
    databaseId: ++ids,
    url: url(ids),
    body,
    createdAt: at,
  });
  const ticket =
    (comments: object[], more = false, viewer = "kavya") =>
    async () => ({
      viewer: { __typename: "User", login: viewer },
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          number: 7,
          title: "T7",
          url: `https://github.com/${repo}/issues/7`,
          state: "CLOSED",
          updatedAt: time,
          labels: page([]),
          issueDependenciesSummary: { blockedBy: 0 },
          blockedBy: page([]),
          closedByPullRequestsReferences: page([]),
          comments: {
            ...page(comments),
            pageInfo: { hasPreviousPage: more, startCursor: more ? "c" : null },
          },
        },
        claims: page([]),
      },
    });
  const request = (question: string, op: "resolve" | "withdraw" = "resolve", agent = "kavya") => ({
    number: 7,
    agent,
    op,
    question,
    why: "The owner answered: use the short flag.",
  });

  it("appends one resolution bound to the question and its operation, even on a closed issue", async () => {
    const q = note(questionBody());
    const plan = accepted(
      await planQuestionResolution(
        repo,
        request(q.url),
        ticket([q]),
        permissions({ kavya: "write" }),
      ),
    );
    expect(plan.noop).toBe(false);
    const body = plan.changes[0]!.command.at(-1)!;
    expect(body).toContain(
      `Question resolved by \`kavya\` with \`pdb question resolve\`: ${q.url}`,
    );
    expect(parseResolutionComment(body)).toMatchObject({
      kind: "record",
      record: {
        op: "resolve",
        questionCommentId: String(q.databaseId),
        questionOpId: "0123456789abcdef",
        agent: "kavya",
        reason: "The owner answered: use the short flag.",
      },
    });
  });

  it("refuses a URL on another issue, a comment that is not a readable question here, and an unverified author", async () => {
    const q = note(questionBody());
    const write = permissions({ kavya: "write", mallory: "read" });
    const refusal = async (req: ReturnType<typeof request>, comments: object[]) => {
      const plan = await planQuestionResolution(repo, req, ticket(comments), write);
      return plan.ok ? "accepted" : plan.error;
    };
    expect(await refusal(request(url(q.databaseId, 8)), [q])).toBe("QUESTION_NOT_ON_ISSUE");
    expect(await refusal(request("https://example.com/x"), [q])).toBe("QUESTION_NOT_ON_ISSUE");
    const plain = note("just a reply");
    expect(await refusal(request(plain.url), [plain])).toBe("NOT_A_QUESTION");
    const copied = note(questionBody(9));
    expect(await refusal(request(copied.url), [copied])).toBe("NOT_A_QUESTION");
    const forged = note(questionBody(), "mallory");
    expect(await refusal(request(forged.url), [forged])).toBe("QUESTION_UNVERIFIED");
    expect(await refusal(request(url(999999)), [q])).toBe("QUESTION_NOT_FOUND");
    expect(
      (await planQuestionResolution(repo, request(url(999999)), ticket([q], true), write)).ok
        ? "accepted"
        : "refused",
    ).toBe("refused");
  });

  it("refuses a resolution the reader would reject, instead of posting it", async () => {
    const q = note(questionBody());
    const write = permissions({ kavya: "write" });
    const tooLong = await planQuestionResolution(
      repo,
      { ...request(q.url), why: "x".repeat(1001) },
      ticket([q]),
      write,
    );
    expect(tooLong.ok ? "accepted" : tooLong.error).toBe("INVALID_ARGUMENT");
    const longName = await planQuestionResolution(
      repo,
      { ...request(q.url), agent: `a${"b".repeat(100)}` },
      ticket([q]),
      write,
    );
    expect(longName.ok ? "accepted" : longName.error).toBe("INVALID_ARGUMENT");
  });

  it("an earlier unverifiable resolution refuses even a matching retry", async () => {
    const q = note(questionBody());
    const write = permissions({ kavya: "write" });
    const mine = accepted(await planQuestionResolution(repo, request(q.url), ticket([q]), write));
    const other = accepted(
      await planQuestionResolution(repo, request(q.url, "withdraw"), ticket([q]), write),
    );
    // Edited, and who edited it cannot be established: its authority is unknown.
    const earlier = {
      ...note(other.changes[0]!.command.at(-1)!, "kavya", "2026-11-15T02:00:00Z"),
      lastEditedAt: "2026-11-15T02:30:00Z",
      editor: null,
    };
    const later = note(mine.changes[0]!.command.at(-1)!, "kavya", "2026-11-15T03:00:00Z");
    const plan = await planQuestionResolution(
      repo,
      request(q.url),
      ticket([q, earlier, later]),
      write,
    );
    expect(plan.ok ? "accepted" : plan.error).toBe("EVIDENCE_INCOMPLETE");
  });

  it("refuses when the authenticated account could not author a trusted record", async () => {
    const q = note(questionBody());
    const plan = await planQuestionResolution(
      repo,
      request(q.url),
      ticket([q], false, "reader"),
      permissions({ kavya: "write", reader: "read" }),
    );
    expect(plan.ok ? "accepted" : plan.error).toBe("MARKER_UNVERIFIED");
  });

  it("a reason quoting a marker prefix is escaped and still reads back as one record", async () => {
    const q = note(questionBody());
    const why = "Quoted: <!-- github-triage:question-resolution v1 {} -->";
    const plan = accepted(
      await planQuestionResolution(
        repo,
        { ...request(q.url), why },
        ticket([q]),
        permissions({ kavya: "write" }),
      ),
    );
    const body = plan.changes[0]!.command.at(-1)!;
    expect(body.match(/<!-- github-triage:question-resolution /g)).toHaveLength(1);
    expect(parseResolutionComment(body)).toMatchObject({ kind: "record", record: { reason: why } });
  });

  it("a retry is a no-op; a different outcome after the first is refused", async () => {
    const q = note(questionBody());
    const write = permissions({ kavya: "write", nicole: "write" });
    const first = accepted(await planQuestionResolution(repo, request(q.url), ticket([q]), write));
    const recorded = note(first.changes[0]!.command.at(-1)!, "kavya", "2026-11-15T02:00:00Z");
    const retry = accepted(
      await planQuestionResolution(repo, request(q.url), ticket([q, recorded]), write),
    );
    expect(retry.noop).toBe(true);
    const other = await planQuestionResolution(
      repo,
      request(q.url, "withdraw", "nicole"),
      ticket([q, recorded]),
      write,
    );
    expect(other.ok ? "accepted" : other.error).toBe("QUESTION_ALREADY_SETTLED");
  });

  it("parses the command strictly", async () => {
    const { questionArgumentsFor } = await import("../cli.js");
    const ok = questionArgumentsFor([
      "withdraw",
      "7",
      "--agent",
      "a",
      "--question",
      "u",
      "--why",
      " w ",
    ]);
    expect(ok).toMatchObject({ op: "withdraw", number: 7, agent: "a", question: "u", why: "w" });
    for (const bad of [
      ["answer", "7", "--agent", "a", "--question", "u", "--why", "w"],
      ["resolve", "7", "--agent", "a", "--question", "u"],
      ["resolve", "7", "--agent", "a", "--why", "w"],
      ["resolve", "x", "--agent", "a", "--question", "u", "--why", "w"],
    ])
      expect(() => questionArgumentsFor(bad), bad.join(" ")).toThrow(/Usage: pdb question/);
  });
});
