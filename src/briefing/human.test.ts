/**
 * Human briefing role (#457, doc/design/human-briefing.md): explicit and inferred items,
 * resolved and superseded records, named routing, missing history and permission trust.
 */
import { describe, expect, it } from "vite-plus/test";
import { presentBriefing } from "./service.js";
import type { HumanBriefing } from "./human.js";
import { parseQuestionRecord } from "./human.js";
import { parseQuestionRecordBody, questionRecordBody } from "../workflow/claims.js";
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
  options: { author?: string; marker?: string; why?: string; createdAt?: string } = {},
): Comment {
  commentId++;
  return {
    ...by(options.author ?? "agent-account"),
    url: `https://github.com/${repo}/issues/1#issuecomment-${commentId}`,
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
      `<!-- github-triage:needs-human:${options.marker ?? String(commentId).padStart(16, "0")} -->`,
    ].join("\n"),
  };
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
  options: { agent?: string; trust?: TrustDecision | null; limit?: number } = {},
) {
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
    options.trust === null ? undefined : (options.trust ?? trustAll()),
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
    expect(view.coverage.warnings.join(" ")).toMatch(/questions could not be read/);
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
});
