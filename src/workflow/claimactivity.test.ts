/**
 * Claim-activity and question-resolution records (#412): strict markers, authority-first
 * classification and the activity fold. Synthetic records only.
 */
import { describe, expect, it } from "vite-plus/test";
import type { TrustDecision } from "./delivery.js";
import {
  activityMarker,
  activityOpId,
  classifyMarkers,
  foldClaimActivity,
  foldQuestionResolutions,
  parseActivityComment,
  parseResolutionComment,
  resolutionMarker,
} from "./claimactivity.js";
import type {
  ActivityComment,
  ClaimActivityRecord,
  QuestionResolutionRecord,
} from "./claimactivity.js";

const repo = "o/r";
const started = "2026-11-15T01:00:00Z";
const human = {
  kind: "human" as const,
  repository: repo,
  issue: 7,
  questionCommentId: "1001",
  questionOpId: "q-op",
};
const record = (over: Partial<ClaimActivityRecord> = {}): ClaimActivityRecord => ({
  v: 1,
  op: "wait",
  opId: "op",
  repository: repo,
  issue: 7,
  agent: "me",
  claimStartedAt: started,
  previousActivity: null,
  reason: "waiting for the owner's answer",
  blocker: human,
  ...over,
});
let ids = 2000;
const comment = (body: string, login = "writer", at?: string): ActivityComment => ({
  databaseId: ++ids,
  createdAt: at ?? new Date(Date.parse("2026-11-15T02:00:00Z") + ids * 1000).toISOString(),
  body,
  author: { __typename: "User", login },
});
const trust: TrustDecision = async (c) =>
  c.author?.login === "writer"
    ? { status: "trusted" }
    : c.author?.login === "outsider"
      ? { status: "untrusted", why: "no write access" }
      : { status: "unknown", why: "permission could not be read" };
const classify = (comments: ActivityComment[], issue = 7) =>
  classifyMarkers(comments, { repository: repo, issue }, trust, parseActivityComment);
const fold = async (
  comments: ActivityComment[],
  over: Partial<Parameters<typeof foldClaimActivity>[1]> = {},
) =>
  foldClaimActivity(await classify(comments), {
    agent: "me",
    claimStartedAt: started,
    historyComplete: true,
    ...over,
  });

describe("claim-activity markers (#412)", () => {
  it("round-trip and refuse anything outside the v1 schema", () => {
    const marker = activityMarker(record());
    expect(parseActivityComment(`Waiting.\n\n${marker}`)).toEqual({
      kind: "record",
      record: record(),
    });
    const bad = (over: object) =>
      parseActivityComment(activityMarker({ ...record(), ...over } as ClaimActivityRecord)).kind;
    expect(bad({ extra: 1 })).toBe("malformed");
    expect(bad({ blocker: undefined })).toBe("malformed");
    expect(bad({ op: "resume" })).toBe("malformed"); // a resume carries no blocker
    expect(bad({ previousActivity: "not-an-id" })).toBe("malformed");
    expect(bad({ reason: " " })).toBe("malformed");
    expect(bad({ reason: "x".repeat(1001) })).toBe("malformed");
    expect(bad({ blocker: { ...human, questionCommentId: undefined } })).toBe("malformed");
    expect(bad({ blocker: { kind: "dependency", repository: repo, issue: 3, extra: true } })).toBe(
      "malformed",
    );
    expect(parseActivityComment(marker.replace("v1 ", "v2 "))).toEqual({
      kind: "unsupported",
      version: "2",
    });
    expect(parseActivityComment(`${marker}\n${marker}`).kind).toBe("malformed");
    expect(parseActivityComment("no marker").kind).toBe("none");
  });

  it("derives one operation id per intent, claim generation and predecessor", () => {
    const intent = {
      repository: "O/R",
      issue: 7,
      agent: "me",
      op: "wait" as const,
      claimStartedAt: started,
      previousActivity: null,
      blocker: human,
    };
    // A retry of the same transition keeps its id.
    expect(activityOpId(intent)).toBe(activityOpId({ ...intent, repository: "o/r" }));
    expect(activityOpId(intent)).not.toBe(
      activityOpId({ ...intent, claimStartedAt: "2026-11-16T00:00:00Z" }),
    );
    expect(activityOpId(intent)).not.toBe(
      activityOpId({ ...intent, blocker: { kind: "dependency", repository: repo, issue: 3 } }),
    );
    // A later cycle (wait, resume, wait again on the same blocker) gets a new id.
    expect(activityOpId(intent)).not.toBe(activityOpId({ ...intent, previousActivity: "2002" }));
    const resume = { ...intent, op: "resume" as const, blocker: undefined };
    expect(activityOpId({ ...resume, previousActivity: "2001" })).not.toBe(
      activityOpId({ ...resume, previousActivity: "2003" }),
    );
  });

  it("question resolutions round-trip and are strict", () => {
    const r: QuestionResolutionRecord = {
      v: 1,
      op: "resolve",
      opId: "r-op",
      repository: repo,
      issue: 7,
      questionCommentId: "1001",
      questionOpId: "q-op",
      agent: "me",
      reason: "the owner answered on the ticket",
    };
    expect(parseResolutionComment(resolutionMarker(r))).toEqual({ kind: "record", record: r });
    expect(parseResolutionComment(resolutionMarker({ ...r, op: "answer" } as never)).kind).toBe(
      "malformed",
    );
  });
});

describe("activity fold (#412)", () => {
  it("a legacy claim without records is active; a valid wait makes it waiting", async () => {
    expect(await fold([])).toEqual({ state: "active", lastActivity: null, rejected: [] });
    const wait = comment(activityMarker(record()));
    expect(await fold([wait])).toEqual({
      state: "waiting",
      blocker: human,
      reason: "waiting for the owner's answer",
      lastActivity: String(wait.databaseId),
      rejected: [],
    });
  });

  it("a resume bound to the wait makes it active again; a stale predecessor is rejected", async () => {
    const wait = comment(activityMarker(record()));
    const resume = comment(
      activityMarker(
        record({ op: "resume", blocker: undefined, previousActivity: String(wait.databaseId) }),
      ),
    );
    expect((await fold([wait, resume])).state).toBe("active");
    const stale = comment(
      activityMarker(record({ op: "resume", blocker: undefined, previousActivity: null })),
    );
    const result = await fold([wait, stale]);
    expect(result.state).toBe("waiting");
    expect(result.rejected[0]).toMatch(/stale predecessor none/);
  });

  it("a wait from an earlier claim generation never suspends the current one", async () => {
    const old = comment(activityMarker(record({ claimStartedAt: "2026-11-01T00:00:00Z" })));
    const result = await fold([old]);
    expect(result.state).toBe("active");
    expect(result.rejected[0]).toMatch(/earlier claim/);
  });

  it("copied, outsider and other agents' records cannot suspend this claim", async () => {
    const copied = comment(activityMarker(record({ issue: 8 })));
    const outsider = comment(activityMarker(record()), "outsider");
    const other = comment(activityMarker(record({ agent: "someone" })));
    const result = await fold([copied, outsider, other]);
    expect(result.state).toBe("active");
    expect(result.rejected).toHaveLength(2);
  });

  it("unknown is never waiting: unverified or malformed records, unknown start or history", async () => {
    const wait = comment(activityMarker(record()));
    expect((await fold([comment(activityMarker(record()), "stranger")])).state).toBe("unknown");
    expect(
      (await fold([comment(`${activityMarker(record()).replace('"op":"wait"', '"op":"nap"')}`)]))
        .state,
    ).toBe("unknown");
    expect((await fold([wait], { claimStartedAt: null })).state).toBe("unknown");
    expect((await fold([wait], { historyComplete: false })).state).toBe("unknown");
  });

  it("a second wait while waiting is rejected, keeping the first", async () => {
    const wait = comment(activityMarker(record()));
    const again = comment(
      activityMarker(
        record({
          previousActivity: String(wait.databaseId),
          blocker: { kind: "dependency", repository: repo, issue: 3 },
        }),
      ),
    );
    const result = await fold([wait, again]);
    expect(result).toMatchObject({ state: "waiting", blocker: human });
    expect(result.rejected[0]).toMatch(/wait does not apply while waiting/);
  });

  it("replays in server comment order, never payload time", async () => {
    const wait = comment(activityMarker(record()), "writer", "2026-11-15T03:00:00Z");
    const resume = comment(
      activityMarker(
        record({ op: "resume", blocker: undefined, previousActivity: String(wait.databaseId) }),
      ),
      "writer",
      "2026-11-15T03:05:00Z",
    );
    // Input order reversed: the fold still sees the wait first.
    expect((await fold([resume, wait])).state).toBe("active");
  });
});

describe("question resolutions (#412)", () => {
  const resolution = (
    questionCommentId: string,
    op: "resolve" | "withdraw" = "resolve",
    questionOpId = "q-op",
  ) =>
    resolutionMarker({
      v: 1,
      op,
      opId: `r-${questionCommentId}-${op}-${questionOpId}`,
      repository: repo,
      issue: 7,
      questionCommentId,
      questionOpId,
      agent: "me",
      reason: "answered",
    });

  it("the first trusted outcome per question wins; unknown records are reported", async () => {
    const first = comment(resolution("1001"));
    const second = comment(resolution("1001", "withdraw"));
    const unverified = comment(resolution("1002"), "stranger");
    const classified = await classifyMarkers(
      [first, second, unverified],
      { repository: repo, issue: 7 },
      trust,
      parseResolutionComment,
    );
    const questions = new Map([
      ["1001", "q-op"],
      ["1002", "q-op"],
    ]);
    const folded = foldQuestionResolutions(classified, questions);
    expect(folded.outcomes.get("1001")).toEqual({
      op: "resolve",
      agent: "me",
      reason: "answered",
      comment: String(first.databaseId),
    });
    expect(folded.outcomes.has("1002")).toBe(false);
    expect(folded.rejected[0]).toMatch(/already resolved/);
    expect(folded.unknown[0]).toMatch(/permission could not be read/);
  });

  it("rejects a resolution bound to another operation or an unknown question before selecting it", async () => {
    const mismatched = comment(resolution("1001", "resolve", "other-op"));
    const unknown = comment(resolution("9999"));
    const correct = comment(resolution("1001", "withdraw"));
    const classified = await classifyMarkers(
      [mismatched, unknown, correct],
      { repository: repo, issue: 7 },
      trust,
      parseResolutionComment,
    );
    const folded = foldQuestionResolutions(classified, new Map([["1001", "q-op"]]));
    // The mismatched record does not win; the later, exactly bound one does.
    expect(folded.outcomes.get("1001")?.op).toBe("withdraw");
    expect(folded.rejected).toEqual([
      expect.stringMatching(/bound to operation other-op, not the question's q-op/),
      expect.stringMatching(/no question 9999 on this issue/),
    ]);
  });
});
