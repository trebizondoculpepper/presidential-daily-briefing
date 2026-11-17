/**
 * Human briefing role (#457, doc/design/human-briefing.md): explicit and inferred items,
 * resolved and superseded records, named routing, missing history and permission trust.
 */
import { describe, expect, it } from "vite-plus/test";
import { presentBriefing } from "./service.js";
import type { HumanBriefing } from "./human.js";
import { parseQuestionRecord } from "./human.js";
import { parseQuestionRecordBody, questionMarker, questionRecordBody } from "../workflow/claims.js";
import { resolutionMarker } from "../workflow/claimactivity.js";
import { discoverClosedQuestions } from "./closedquestions.js";
import type { Query, Rest } from "../github/github.js";
import { markerTrust } from "../workflow/delivery.js";
import type { TrustDecision } from "../workflow/delivery.js";
import type { Comment, Issue, PullRequest } from "../github/types.js";
import type { RepositoryPermission } from "../github/github.js";
import { permissions } from "../testing/fakegh.js";
import { by, issue, page, pr, repo, snapshot, time } from "../testing/snapshots.js";

let commentId = 0;
/** A needs-human record comment in the format `pdb needs-human` posts. */
function record(
  designer: string,
  questions: string[],
  options: {
    author?: string;
    marker?: string;
    why?: string;
    createdAt?: string;
    /** Write the v2 marker bound to this issue (#412), as `pdb needs-human` now does. */
    v2?: number;
  } = {},
): Comment {
  commentId++;
  const opId = options.marker ?? String(commentId).padStart(16, "0");
  return {
    ...by(options.author ?? "agent-account"),
    databaseId: commentId,
    url: `https://github.com/${repo}/issues/${options.v2 ?? 1}#issuecomment-${commentId}`,
    createdAt: options.createdAt ?? time,
    body: [
      "### Questions for the designer",
      "",
      `Designer: \`${designer}\` · Raised by: \`kavya\``,
      "",
      `**Why:** ${options.why ?? "The account model is undecided."}`,
      "",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      options.v2 === undefined
        ? `<!-- github-triage:needs-human:${opId} -->`
        : questionMarker(opId, repo, options.v2),
    ].join("\n"),
  };
}
/** An explicit `pdb question resolve|withdraw` record answering `question` on issue `n`. */
function outcome(
  n: number,
  question: Comment,
  op: "resolve" | "withdraw",
  options: { author?: string; createdAt?: string } = {},
): Comment {
  commentId++;
  const opId = /needs-human:([0-9a-f]{16})/.exec(question.body)![1]!;
  return {
    ...by(options.author ?? "agent-account"),
    databaseId: commentId,
    url: `https://github.com/${repo}/issues/${n}#issuecomment-${commentId}`,
    createdAt: options.createdAt ?? "2026-11-12T11:00:00Z",
    body: `Question ${op}d.\n\n${resolutionMarker({
      v: 1,
      op,
      opId: String(commentId).padStart(32, "0"),
      repository: repo,
      issue: n,
      questionCommentId: String(question.databaseId),
      questionOpId: opId,
      agent: "kavya",
      reason: "Answered on the ticket.",
    })}`,
  };
}
const closedIssue = (n: number, labels: string[], comments: Comment[], more = false): Issue => ({
  ...issue(n, labels),
  state: "CLOSED",
  stateReason: "COMPLETED",
  comments: page(comments, more, more ? "c0" : null),
});
/**
 * An injected gh for the closed-source read (#414): the closed-issue inventory, paged by `first`,
 * and further comment pages per issue (`later[n]`, one array per page). Records every request.
 */
function closedGh(closed: Issue[], later: Record<number, Comment[][]> = {}) {
  const calls: string[] = [];
  const query: Query = async (source, variables) => {
    const size = Number(/first:(\d+)/.exec(source)![1]);
    if (source.includes("states:CLOSED")) {
      calls.push(`inventory ${variables.cursor ?? "start"}`);
      const start = variables.cursor === undefined ? 0 : Number(variables.cursor);
      const more = start + size < closed.length;
      return {
        repository: {
          issues: page(closed.slice(start, start + size), more, more ? String(start + size) : null),
        },
      } as never;
    }
    const n = Number(variables.number);
    const at = Number(String(variables.cursor).slice(1));
    calls.push(`comments #${n} ${String(variables.cursor)}`);
    const pages = later[n] ?? [];
    const more = at + 1 < pages.length;
    return {
      repository: {
        issueOrPullRequest: { comments: page(pages[at] ?? [], more, more ? `c${at + 1}` : null) },
      },
    } as never;
  };
  return { query, calls };
}
const withComments = (item: Issue, comments: Comment[], more = false): Issue => ({
  ...item,
  comments: page(comments, more),
});
const trustAll = (table: Record<string, RepositoryPermission> = {}): TrustDecision =>
  markerTrust(permissions(table));

async function human(
  issues: Issue[],
  prs: PullRequest[] = [],
  options: {
    agent?: string;
    trust?: TrustDecision | null;
    limit?: number;
    /** Closed issues behind the injected gh (#414); null: no live read, as offline. */
    closed?: Issue[] | null;
  } = {},
) {
  const trust = options.trust === null ? undefined : (options.trust ?? trustAll());
  const gh = options.closed === null ? null : closedGh(options.closed ?? []);
  const rest: Rest = async () => ({ status: 200, body: {} });
  const presented = await presentBriefing(
    snapshot(issues, prs),
    {
      limit: options.limit ?? 10,
      maxChars: 10000,
      role: "human",
      ...(options.agent === undefined
        ? { agent: "owner" }
        : options.agent
          ? { agent: options.agent }
          : {}),
    },
    undefined,
    new Date(time),
    undefined,
    trust,
    undefined,
    undefined,
    gh && trust ? { query: gh.query, rest, trustWith: () => trust } : undefined,
  );
  const report = presented.report as unknown as {
    human: HumanBriefing;
    decisionEngine: { used: string };
  };
  return { ...presented, view: report.human, report };
}
const rows = (view: HumanBriefing) =>
  view.items.map(
    (i) =>
      `${i.kind}#${i.target.split("/").pop()}:${i.explicit ? (i.addressed ? "to-you" : "explicit") : "inferred"}`,
  );

describe("human briefing role (#457)", () => {
  it("parses the needs-human record format", () => {
    const parsed = parseQuestionRecord(record("owner", ["First?", "Second?"]));
    expect(parsed).toMatchObject({
      to: "owner",
      raisedBy: "kavya",
      why: "The account model is undecided.",
      questions: ["First?", "Second?"],
    });
    expect(parseQuestionRecord({ ...by(), url: "u", body: "no marker" })).toBeNull();
  });

  it("round-trips multiline questions and reasons in the format needs-human writes", () => {
    const parts = {
      designer: "owner",
      agent: "kavya",
      why: "Two lines\nof reason.",
      questions: ["First line\n2 continued, not a new item", "Second?\n\n- with a list"],
    };
    const body = questionRecordBody(parts, "<!-- github-triage:needs-human:0123456789abcdef -->");
    expect(parseQuestionRecordBody(body.slice(0, body.indexOf("<!--")))).toEqual(parts);
    expect(parseQuestionRecord({ ...by(), url: "u", body })).toMatchObject({
      to: "owner",
      why: parts.why,
      questions: parts.questions,
    });
  });

  it("treats a record on a ticket with truncated labels as unknown, never resolved", async () => {
    const truncated = withComments(
      { ...issue(1, ["status:ready"]), labels: page([{ name: "status:ready" }], true) },
      [record("owner", ["Q?"])],
    );
    const { view, complete } = await human([truncated]);
    expect(view.total).toBe(0);
    expect(view.coverage.records).toMatchObject({ resolved: 0, unknown: 1, current: 0 });
    expect(complete).toBe(false);
    expect(view.coverage.warnings.join(" ")).toMatch(
      /whether its question record is resolved is unknown/,
    );
  });

  it("ranks addressed explicit requests first, then explicit, then inferred items", async () => {
    const dependent = { ...issue(9), state: "OPEN" };
    const asked = {
      ...withComments(issue(1, ["question", "status:needs-design"]), [
        record("owner", ["Which account model?"]),
      ]),
      blocking: page([
        {
          number: 9,
          title: "Ticket 9",
          url: dependent.url,
          state: "OPEN",
          repository: { nameWithOwner: repo },
          issueDependenciesSummary: {
            blockedBy: 1,
            totalBlockedBy: 1,
            blocking: 0,
            totalBlocking: 0,
          },
        },
      ]),
    };
    const other = withComments(issue(2, ["design:decision-needed"]), [
      record("designer-a", ["Split the API?"]),
    ]);
    const unrecorded = issue(3, ["design:decision-needed"]);
    const attention = issue(5, ["attention:owner"]);
    const accepted: PullRequest = {
      ...pr(),
      closingIssuesReferences: page([{ number: 7, url: issue(7).url }]),
      reviews: page([
        { ...by("reviewer"), url: "r", body: "", state: "APPROVED", commit: { oid: "abc123" } },
      ]),
    };
    const { view, report, text } = await human(
      [asked, other, unrecorded, attention, issue(7, [])],
      [accepted],
    );
    expect(rows(view)).toEqual([
      "answer-questions#1:to-you",
      "addressed-response#5:to-you",
      "answer-questions#2:explicit",
      "decide#3:inferred",
      "sign-off#4:inferred",
    ]);
    const first = view.items[0];
    expect(first.requested).toEqual(["Which account model?"]);
    expect(first.reason).toBe("The account model is undecided.");
    expect(first.routedTo).toEqual(["owner"]);
    expect(first.source).toMatch(/#issuecomment-/);
    expect(first.blocks.subjects).toEqual([asked.url, dependent.url]);
    expect(first.ruleIds).toEqual(["D-HUMAN-ASK-YOU"]);
    expect(view.items[4].requested).toEqual(["Merge sign-off for head abc123."]);
    expect(view.items[4].blocks.subjects).toEqual([issue(7).url]);
    // Read-only: no claim, estimate or release command is ever offered.
    for (const item of view.items) expect(item.nextCommand).not.toMatch(/claim|estimate|release/);
    expect(report.decisionEngine.used).toBe("datalog");
    expect(view.coverage.complete).toBe(true);
    expect(text).toContain("[explicit, to you] answer-questions");
  });

  it("treats labels removed as resolved and the newest trusted record as current", async () => {
    const resolved = withComments(issue(1, ["status:ready"]), [record("owner", ["Old?"])]);
    const superseded = withComments(issue(2, ["question"]), [
      record("owner", ["First?"], { createdAt: "2026-11-10T00:00:00Z" }),
      record("owner", ["Still open?"], { marker: "aaaaaaaaaaaaaaaa" }),
      // A repeat of the same record (a retried post) is one record.
      record("owner", ["Still open?"], { marker: "aaaaaaaaaaaaaaaa" }),
    ]);
    const { view } = await human([resolved, superseded]);
    expect(rows(view)).toEqual(["answer-questions#2:to-you"]);
    expect(view.items[0].requested).toEqual(["Still open?"]);
    expect(view.coverage.records).toEqual({
      current: 1,
      superseded: 1,
      resolved: 1,
      unknown: 0,
      untrusted: 0,
      unverified: 0,
    });
  });

  it("routes only to an explicitly named human", async () => {
    const asked = withComments(issue(1, ["question", "attention:owner"]), [
      record("owner", ["Q?"]),
    ]);
    const named = await human([asked], [], { agent: "someone-else" });
    expect(rows(named.view)).toEqual(["answer-questions#1:explicit"]);
    const unnamed = await human([asked], [], { agent: "" });
    expect(unnamed.view.routing).toBe("unrouted");
    expect(unnamed.view.human).toBeNull();
    expect(rows(unnamed.view)).toEqual(["answer-questions#1:explicit"]);
    expect(unnamed.view.notices[0]).toMatch(/No human named/);
  });

  it("never lets an untrusted or unverifiable record make an explicit request", async () => {
    const forged = withComments(issue(1, ["question"]), [
      record("owner", ["Forged?"], { author: "reader" }),
    ]);
    const unknown = withComments(issue(2, ["question"]), [
      record("owner", ["Unknown?"], { author: "ghost" }),
    ]);
    const { view } = await human([forged, unknown], [], {
      trust: trustAll({ reader: "read", ghost: "unknown" }),
    });
    // An unverifiable record ranks before a bare label; neither becomes explicit.
    expect(rows(view)).toEqual(["decide#2:inferred", "decide#1:inferred"]);
    expect(view.items.map((i) => i.ruleIds)).toEqual([["D-HUMAN-UNVERIFIED"], ["D-HUMAN-DECIDE"]]);
    expect(view.coverage.records).toMatchObject({ untrusted: 1, unverified: 1, current: 0 });
  });

  it("reports missing permissions and truncated history as incomplete, never as clean", async () => {
    const asked = withComments(issue(1, ["question"]), [record("owner", ["Q?"])]);
    const noTrust = await human([asked], [], { trust: null });
    expect(rows(noTrust.view)).toEqual(["decide#1:inferred"]);
    expect(noTrust.complete).toBe(false);
    expect(noTrust.view.coverage.warnings.join(" ")).toMatch(/permissions were not read/);

    const truncated = withComments(issue(2, []), [], true);
    const history = await human([truncated]);
    expect(history.view.total).toBe(0);
    expect(history.complete).toBe(false);
    expect(history.text).toContain("coverage is incomplete");
    expect(history.text).not.toContain("No human input is waiting.");

    const clean = await human([issue(3)]);
    expect(clean.complete).toBe(true);
    expect(clean.text).toContain("No human input is waiting.");
  });

  it("puts unknown authority and truncated dependents into coverage, not only the item", async () => {
    const unknown = withComments(issue(1, ["question"]), [
      record("owner", ["Unknown?"], { author: "ghost" }),
    ]);
    const unknownView = await human([unknown], [], { trust: trustAll({ ghost: "unknown" }) });
    expect(unknownView.complete).toBe(false);
    expect(unknownView.view.coverage.complete).toBe(false);
    expect(unknownView.view.coverage.warnings.join(" ")).toMatch(/could not be verified/);

    const truncated = { ...issue(2, ["design:decision-needed"]), blocking: page([], true) };
    const blocked = await human([truncated]);
    expect(blocked.view.items[0].blocks.unknown).toEqual(["direct dependents not fully collected"]);
    expect(blocked.complete).toBe(false);
    expect(blocked.view.coverage.warnings).toEqual([
      `${truncated.url}: direct dependents not fully collected; what it blocks is a lower bound.`,
    ]);
  });

  it("puts unreadable questions and truncated closing references into coverage", async () => {
    const empty = withComments(issue(1, ["question"]), [record("owner", [])]);
    const accepted: PullRequest = {
      ...pr(),
      closingIssuesReferences: page([{ number: 7, url: issue(7).url }], true),
      reviews: page([
        { ...by("reviewer"), url: "r", body: "", state: "APPROVED", commit: { oid: "abc123" } },
      ]),
    };
    const { view, complete } = await human([empty, issue(7, [])], [accepted]);
    expect(complete).toBe(false);
    expect(view.coverage.warnings.join(" ")).toMatch(/its questions could not be read/);
    expect(view.coverage.warnings.join(" ")).toMatch(/closing issue references truncated/);
  });

  it("shows parked questions and notes closed issues trimmed from the display", async () => {
    const parked = withComments(issue(1, ["question", "status:parked"]), [
      record("designer-a", ["Parked?"]),
    ]);
    const closes = [11, 12, 13, 14, 15, 16, 17].map((n) => ({ number: n, url: issue(n).url }));
    const accepted: PullRequest = {
      ...pr(),
      closingIssuesReferences: page(closes),
      reviews: page([
        { ...by("reviewer"), url: "r", body: "", state: "APPROVED", commit: { oid: "abc123" } },
      ]),
    };
    const { view, complete } = await human([parked], [accepted]);
    expect(rows(view)).toEqual(["answer-questions#1:explicit", "sign-off#4:inferred"]);
    expect(view.items[1].blocks.subjects).toHaveLength(5);
    expect(view.items[1].blocks.unknown).toEqual(["2 more closed issue(s) omitted"]);
    // Display trimming is not missing evidence.
    expect(complete).toBe(true);
  });

  it("bounds the items after ranking and reports omissions", async () => {
    const issues = [1, 2, 3].map((n) => issue(n, ["design:decision-needed"]));
    const { view, text } = await human(issues, [], { limit: 2 });
    expect(view.total).toBe(3);
    expect(view.omitted).toBe(1);
    expect(rows(view)).toEqual(["decide#1:inferred", "decide#2:inferred"]);
    expect(text).toContain("1 more item(s) omitted");
  });

  describe("v2 question markers (#412)", () => {
    const id = "0123456789abcdef";
    const v2 = (repository: string, issueNumber: number) =>
      `<!-- github-triage:needs-human:${id} v2 {"v":2,"repository":"${repository}","issue":${issueNumber},"resolution":"explicit"} -->`;
    const withMarker = (marker: string): Comment => {
      const c = record("owner", ["Which flag name?"]);
      return { ...c, body: c.body.replace(/<!-- github-triage:needs-human:[^>]*-->/, marker) };
    };

    it("parses version and operation id from either marker", () => {
      expect(parseQuestionRecord(withMarker(v2(repo, 1)))).toMatchObject({ version: 2, opId: id });
      expect(parseQuestionRecord(record("owner", ["Q?"], { marker: id }))).toMatchObject({
        version: 1,
        opId: id,
      });
    });

    it("ignores a v2 record copied from another issue, and a malformed marker, with warnings", async () => {
      const ticket = (c: Comment) =>
        withComments(issue(1, ["question", "status:needs-design"]), [c]);
      const copied = await human([ticket(withMarker(v2(repo, 9)))]);
      expect(copied.view.coverage.records.current).toBe(0);
      expect(copied.view.coverage.warnings.join(" ")).toMatch(
        new RegExp(`bound to ${repo}#9; ignored`),
      );
      const malformed = await human([
        ticket(withMarker(`<!-- github-triage:needs-human:${id} v2 {"v":2} -->`)),
      ]);
      expect(malformed.view.coverage.records).toMatchObject({ current: 0, unverified: 1 });
      expect(malformed.view.coverage.warnings.join(" ")).toMatch(/has a malformed marker/);
      const bound = await human([ticket(withMarker(v2(repo, 1)))]);
      expect(bound.view.coverage.records.current).toBe(1);
    });
  });

  describe("questions on closed sources (#414)", () => {
    it("keeps an unanswered question visible when its ticket closes, labelled closed", async () => {
      const asked = record("owner", ["Which account model?"], { v2: 21 });
      const closed = closedIssue(21, [], [asked]);
      const { view, text, complete } = await human([issue(3)], [], { closed: [closed] });
      expect(rows(view)).toEqual(["orphaned-question#21:to-you"]);
      const item = view.items[0];
      expect(item).toMatchObject({
        sourceState: "closed",
        resolution: "unresolved",
        requested: ["Which account model?"],
        routedTo: ["owner"],
        source: asked.url,
        ruleIds: ["D-HUMAN-ORPHANED-YOU"],
        blocks: { subjects: [closed.url], unknown: [] },
      });
      expect(text).toContain("[explicit, to you, ticket closed, unanswered] orphaned-question");
      expect(view.coverage.closedSources).toMatchObject({
        read: true,
        complete: true,
        requests: 1,
        records: { noOutcome: 1, resolved: 0, withdrawn: 0 },
      });
      expect(complete).toBe(true);
    });

    it("drops a question resolved or withdrawn before closing, and only that question", async () => {
      const resolvedQ = record("owner", ["Resolved?"], { v2: 22 });
      const withdrawnQ = record("owner", ["Withdrawn?"], { v2: 23 });
      const keptQ = record("designer-a", ["Still open?"], { v2: 23 });
      const resolved = closedIssue(22, [], [resolvedQ, outcome(22, resolvedQ, "resolve")]);
      // A withdrawal answers exactly the question it names, never its neighbour.
      const withdrawn = closedIssue(
        23,
        [],
        [withdrawnQ, keptQ, outcome(23, withdrawnQ, "withdraw")],
      );
      const { view } = await human([], [], { closed: [resolved, withdrawn] });
      expect(rows(view)).toEqual(["orphaned-question#23:explicit"]);
      expect(view.items[0].requested).toEqual(["Still open?"]);
      expect(view.coverage.closedSources).toMatchObject({
        records: { noOutcome: 1, resolved: 1, withdrawn: 1 },
      });
    });

    it("never takes an untrusted resolution, a copied record or closure as an answer", async () => {
      const asked = record("owner", ["Answered by a stranger?"], { v2: 24 });
      const forged = outcome(24, asked, "resolve", { author: "stranger" });
      const copied = record("owner", ["Copied?"], { v2: 99 });
      const source = closedIssue(24, [], [asked, forged, copied]);
      const { view } = await human([], [], {
        closed: [source],
        trust: trustAll({ stranger: "read" }),
      });
      expect(rows(view)).toEqual(["orphaned-question#24:to-you"]);
      expect(view.coverage.warnings.join(" ")).toMatch(/bound to example\/project#99; ignored/);
    });

    it("never lets an untrusted copy of a genuine marker hide the original (Codex, #607)", async () => {
      const asked = record("owner", ["Original?"], { v2: 27, marker: "bbbbbbbbbbbbbbbb" });
      const copy = record("owner", ["Original?"], {
        v2: 27,
        marker: "bbbbbbbbbbbbbbbb",
        author: "stranger",
      });
      const { view } = await human([], [], {
        closed: [closedIssue(27, [], [asked, copy])],
        trust: trustAll({ stranger: "read" }),
      });
      expect(rows(view)).toEqual(["orphaned-question#27:to-you"]);
      expect(view.items[0].source).toBe(asked.url);
    });

    it("lists only questions still open: a label-resolved v1 beside a v2 is not shown (Codex, #607)", async () => {
      const legacy = record("designer-a", ["Legacy, answered by labels?"]);
      const current = record("owner", ["Current?"], { v2: 28 });
      const { view } = await human([], [], { closed: [closedIssue(28, [], [legacy, current])] });
      expect(rows(view)).toEqual(["orphaned-question#28:to-you"]);
      expect(view.items[0]).toMatchObject({
        requested: ["Current?"],
        routedTo: ["owner"],
        source: current.url,
      });
    });

    it("reports truncated labels on a closed legacy source as incomplete (Codex, #607)", async () => {
      const truncated = {
        ...closedIssue(29, [], [record("owner", ["Truncated?"])]),
        labels: page([{ name: "status:ready" }], true),
      };
      const { view, complete } = await human([], [], { closed: [truncated] });
      expect(rows(view)).toEqual(["orphaned-question#29:explicit"]);
      expect(view.items[0].resolution).toBe("unknown");
      expect(complete).toBe(false);
      expect(view.coverage.closedSources).toMatchObject({ complete: false });
      expect(view.coverage.warnings.join(" ")).toMatch(
        /are truncated; whether its legacy question/,
      );
    });

    it("binds an outcome to the question, whichever trusted copy it names (Codex, #607)", async () => {
      const original = record("owner", ["Copied?"], { v2: 33, marker: "cccccccccccccccc" });
      const copy = record("owner", ["Copied?"], { v2: 33, marker: "cccccccccccccccc" });
      const answered = closedIssue(33, [], [original, copy, outcome(33, original, "resolve")]);
      const { view } = await human([], [], { closed: [answered] });
      expect(view.total).toBe(0);
      const open = closedIssue(
        34,
        [],
        [
          record("owner", ["Open?"], { v2: 34, marker: "dddddddddddddddd" }),
          record("owner", ["Open?"], { v2: 34, marker: "dddddddddddddddd" }),
        ],
      );
      const shown = await human([], [], { closed: [open] });
      expect(shown.view.items[0].source).toBe(open.comments.nodes[0].url);
      expect(shown.view.items[0].requested).toEqual(["Open?"]);
    });

    it("reports each unreadable record on a closed source, even beside a readable one (Codex, #607)", async () => {
      const blank = record("owner", [], { v2: 35 });
      const readable = record("owner", ["Readable?"], { v2: 35 });
      const { view, complete } = await human([], [], {
        closed: [closedIssue(35, [], [blank, readable])],
      });
      expect(view.items[0].requested).toEqual(["Readable?"]);
      expect(complete).toBe(false);
      expect(view.coverage.warnings.join(" ")).toContain(
        `record ${blank.url}: its questions could not be read`,
      );
    });

    it("treats an arbitrary reply as no answer, and an edited or unknown-author outcome as unverified", async () => {
      const asked = record("owner", ["Answered by chat?"], { v2: 36 });
      const reply: Comment = {
        ...by("owner"),
        databaseId: 99036,
        url: `https://github.com/${repo}/issues/36#issuecomment-99036`,
        createdAt: "2026-11-12T12:00:00Z",
        body: "Yes, go with the first option.",
      };
      const chat = await human([], [], { closed: [closedIssue(36, [], [asked, reply])] });
      expect(chat.view.items[0]).toMatchObject({ resolution: "unresolved" });

      const q = record("owner", ["Edited answer?"], { v2: 37 });
      const edited: Comment = {
        ...outcome(37, q, "resolve"),
        lastEditedAt: "2026-11-12T13:00:00Z",
        editor: { __typename: "User", login: "outsider" },
      };
      const ghostQ = record("owner", ["Ghost answer?"], { v2: 38 });
      const ghost = outcome(38, ghostQ, "resolve", { author: "ghost" });
      const { view } = await human([], [], {
        closed: [closedIssue(37, [], [q, edited]), closedIssue(38, [], [ghostQ, ghost])],
        trust: trustAll({ outsider: "read", ghost: "unknown" }),
      });
      // Neither outcome is trusted: both questions stay visible, and coverage says why.
      expect(rows(view).sort()).toEqual([
        "orphaned-question#37:to-you",
        "orphaned-question#38:explicit",
      ]);
      expect(view.coverage.complete).toBe(false);
    });

    it("keeps legacy v1 label resolution: labelled stays, labels removed is answered", async () => {
      const labelled = closedIssue(25, ["question"], [record("designer-a", ["Legacy?"])]);
      const cleared = closedIssue(26, [], [record("designer-a", ["Cleared?"])]);
      const { view } = await human([], [], { closed: [labelled, cleared] });
      expect(rows(view)).toEqual(["orphaned-question#25:explicit"]);
      expect(view.items[0].ruleIds).toEqual(["D-HUMAN-ORPHANED"]);
    });

    it("says closed sources were not read rather than show none", async () => {
      const { view, complete, text } = await human([issue(3)], [], { closed: null, trust: null });
      expect(complete).toBe(false);
      expect(view.coverage.closedSources).toMatchObject({ read: false, complete: false });
      expect(view.coverage.warnings.join(" ")).toMatch(/questions on closed tickets were not read/);
      expect(text).not.toContain("No human input is waiting.");
    });

    it("bounds the read and reports what the limit left unread, never as answered", async () => {
      const asked = record("owner", ["Answer beyond the bound?"], { v2: 31 });
      const long = closedIssue(31, [], [asked], true);
      const resolvedLater = [
        [record("owner", ["Another?"], { v2: 31 })],
        [outcome(31, asked, "resolve")],
      ];
      const other = closedIssue(32, [], []);
      const gh = closedGh([long, other], { 31: resolvedLater });
      const rest: Rest = async () => {
        return { status: 200, body: { role_name: "write", user: { login: "agent-account" } } };
      };
      // Each permission lookup goes through the budgeted REST boundary it is handed.
      const runtime = {
        query: gh.query,
        rest,
        trustWith: (r: Rest) =>
          markerTrust(async (login) => {
            const answer = await r(`repos/${repo}/collaborators/${login}/permission`);
            return answer.status === 200 ? "write" : "unknown";
          }),
        now: () => new Date(time),
      };
      const bounded = await discoverClosedQuestions(repo, {
        ...runtime,
        bounds: { requests: 3, inventoryPages: 1, commentPages: 1, pageSize: 1 },
      });
      // One inventory page of one row, one comment page, one permission lookup: the bound.
      expect(bounded.coverage).toMatchObject({
        complete: false,
        requests: 3,
        inventory: { pages: 1, rows: 1, complete: false },
        discovered: 1,
        hydrated: 0,
        pending: [long.url],
      });
      // The resolution sits on the unread page: the question read is unknown, never answered;
      // the one whose permission lookup the bound refused is unverified, and said so.
      expect(bounded.sources[0].facts).toEqual([
        { trust: "trusted", to: "owner", version: 2, outcome: "unknown" },
      ]);
      expect(bounded.coverage.records).toMatchObject({ unknown: 1, unverified: 1, resolved: 0 });
      const warnings = bounded.warnings.join(" ");
      expect(warnings).toMatch(/closed tickets beyond the 1 read so far were not read/);
      expect(warnings).toMatch(/comment history was not fully read within the bound/);
      expect(warnings).toMatch(/exceeded the request bound/);
      expect(bounded.coverage.permissionGaps).toBeGreaterThan(0);

      // Within the default bound the same history is read whole and the resolution counts.
      const found = await discoverClosedQuestions(repo, runtime);
      expect(found.coverage).toMatchObject({ complete: true, hydrated: 2, pending: [] });
      expect(found.coverage.records).toMatchObject({ resolved: 1, noOutcome: 1, unknown: 0 });
    });

    it("rotates comment pages across sources so one long history cannot take the budget", async () => {
      const a = closedIssue(41, [], [record("owner", ["A?"], { v2: 41 })], true);
      const b = closedIssue(42, [], [record("owner", ["B?"], { v2: 42 })], true);
      const filler = (n: number) => [record("owner", [`${n}?`], { v2: n })];
      const gh = closedGh([a, b], { 41: [filler(41), filler(41), filler(41)], 42: [filler(42)] });
      await discoverClosedQuestions(repo, {
        query: gh.query,
        trust: trustAll(),
        bounds: { commentPages: 2 },
      });
      expect(gh.calls).toEqual(["inventory start", "comments #41 c0", "comments #42 c0"]);
    });
  });

  describe("v2 questions on open tickets (#414)", () => {
    it("keeps asking after the labels are removed: only an explicit outcome answers", async () => {
      const asked = record("owner", ["Still unanswered?"], { v2: 51 });
      const unlabelled = withComments(issue(51, ["status:ready"]), [asked]);
      const { view } = await human([unlabelled]);
      expect(rows(view)).toEqual(["answer-questions#51:to-you"]);
      expect(view.items[0]).toMatchObject({
        sourceState: "open",
        requested: ["Still unanswered?"],
        source: asked.url,
      });
    });

    it("answers a v2 question by resolve or withdraw, even while a label remains", async () => {
      const resolvedQ = record("owner", ["Resolved?"], { v2: 52 });
      const withdrawnQ = record("owner", ["Withdrawn?"], { v2: 53 });
      const resolved = withComments(issue(52, ["status:ready"]), [
        resolvedQ,
        outcome(52, resolvedQ, "resolve"),
      ]);
      // A lingering label is at most an inferred decision, never the answered question.
      const labelled = withComments(issue(53, ["question"]), [
        withdrawnQ,
        outcome(53, withdrawnQ, "withdraw"),
      ]);
      const { view } = await human([resolved, labelled]);
      expect(rows(view)).toEqual(["decide#53:inferred"]);
      expect(view.coverage.records).toMatchObject({ resolved: 2, current: 0 });
    });

    it("never takes an untrusted resolution, and keeps each v2 question separate", async () => {
      const first = record("owner", ["First?"], { v2: 54 });
      const second = record("designer-a", ["Second?"], { v2: 54 });
      const ticket = withComments(issue(54, []), [
        first,
        second,
        outcome(54, second, "resolve", { author: "stranger" }),
        outcome(54, first, "resolve"),
      ]);
      const { view } = await human([ticket], [], { trust: trustAll({ stranger: "read" }) });
      expect(rows(view)).toEqual(["answer-questions#54:explicit"]);
      expect(view.items[0].requested).toEqual(["Second?"]);
    });

    it("shows a v2 question whose history was truncated, and says so", async () => {
      const asked = record("owner", ["Answered on a later page?"], { v2: 55 });
      const truncated = withComments(issue(55, []), [asked], true);
      const { view, complete } = await human([truncated]);
      expect(rows(view)).toEqual(["answer-questions#55:to-you"]);
      expect(complete).toBe(false);
      expect(view.coverage.records).toMatchObject({ unknown: 1 });
    });

    it("projects native attentionSection and reason consistently across CLI, MCP and web (#643)", async () => {
      const { briefingView } = await import("../mcp/views.js");
      const openUnanswered = withComments(issue(61, ["question"]), [
        record("owner", ["Open unanswered?"], { v2: 61 }),
      ]);
      const resolvedQ = record("owner", ["Resolved?"], { v2: 62 });
      const openResolved = withComments(issue(62, []), [
        resolvedQ,
        outcome(62, resolvedQ, "resolve"),
      ]);
      const closedUnanswered = closedIssue(
        63,
        [],
        [record("owner", ["Closed unanswered?"], { v2: 63 })],
      );
      const editedQ = record("owner", ["Edited by outsider?"], { v2: 64 });
      const editedOutcome: Comment = {
        ...outcome(64, editedQ, "resolve"),
        lastEditedAt: "2026-11-12T13:00:00Z",
        editor: { __typename: "User", login: "outsider" },
      };
      const closedUntrustedEdit = closedIssue(64, [], [editedQ, editedOutcome]);
      const unknownOutcomeQ = record("owner", ["Unknown author outcome?"], { v2: 65 });
      const closedUnknownOutcome = closedIssue(
        65,
        [],
        [unknownOutcomeQ, outcome(65, unknownOutcomeQ, "resolve", { author: "ghost" })],
      );
      const closedIncompleteHistory: Issue = {
        ...closedIssue(66, [], [record("owner", ["Labels truncated?"])]),
        labels: page([{ name: "status:ready" }], true),
      };
      const openIncompleteHistory = withComments(
        issue(67, ["status:needs-human"]),
        [record("owner", ["Comments truncated?"], { v2: 67 })],
        true,
      );
      const { view, report, text } = await human(
        [openUnanswered, openResolved, openIncompleteHistory],
        [],
        {
          closed: [
            closedUnanswered,
            closedUntrustedEdit,
            closedUnknownOutcome,
            closedIncompleteHistory,
          ],
          trust: trustAll({ outsider: "read", ghost: "unknown" }),
        },
      );
      expect(
        view.items.map((i) => [
          i.target.split("/").pop(),
          i.attentionSection,
          i.attentionSectionReason.ruleId,
        ]),
      ).toEqual([
        ["61", "input", "HS-INPUT-ACTIONABLE"],
        ["63", "input", "HS-INPUT-ACTIONABLE"],
        ["64", "input", "HS-INPUT-ACTIONABLE"],
        ["67", "input", "HS-INPUT-ACTIONABLE"],
        ["65", "waiting", "HS-WAITING-UNKNOWN"],
        ["66", "waiting", "HS-WAITING-UNKNOWN"],
      ]);
      expect(text).toContain("Section: waiting (HS-WAITING-UNKNOWN)");
      const mcp = briefingView(
        {
          repository: repo,
          status: "incomplete",
          selection: {
            repository: repo,
            agent: "owner",
            identitySource: "client",
            entry: null,
            triageRole: "human",
            identityDiagnostic: null,
          },
          notices: [],
          maxChars: 10_000,
        },
        report as unknown as Record<string, unknown>,
      );
      const mcpText = mcp
        .text(mcp.data, {
          budgetBytes: 16384,
          bytes: 0,
          returned: {},
          omitted: {},
          truncatedFields: [],
          next: null,
        })
        .join("\n");
      expect(mcpText).toContain("[explicit, waiting] orphaned-question");
    });
  });
});
