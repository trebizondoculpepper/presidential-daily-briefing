import { describe, expect, it } from "vite-plus/test";
import {
  commentText,
  discussionLoader,
  parseDiscussionResponse,
  scopeText,
  selection,
} from "./client.js";

const envelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "serve-read",
  view: "discussion",
  status: "complete",
  selection: { repository: "example/project" },
  warnings: [],
  freshness: { observedAt: "2026-11-20T10:00:00.000Z", stale: false },
  result: {
    schemaVersion: 1,
    kind: "discussion-view",
    repository: "example/project",
    scope: "open",
    fetchedAt: "2026-11-20T10:00:00.000Z",
    items: [
      {
        number: 12,
        title: "A much discussed ticket",
        url: "https://github.com/example/project/issues/12",
        state: "OPEN",
        comments: 7,
        rank: 1,
        why: "Most commented issue in scope.",
      },
    ],
    unknown: [{ number: 13, title: "Unread", url: "https://github.com/example/project/issues/13" }],
    shown: 1,
    omitted: 3,
    coverage: { complete: true, pagesRead: 1, issuesRead: 20, unreadable: 0, note: null },
    policyVersion: 1,
    rulesHash: "abc",
    ...overrides,
  },
});

describe("discussion page client (#1103)", () => {
  it("parses the shared discussion view without re-ordering it", () => {
    const parsed = parseDiscussionResponse(envelope())!;
    expect(parsed.scope).toBe("open");
    expect(parsed.repository).toBe("example/project");
    expect(parsed.items.map((i) => i.number)).toEqual([12]);
    expect(parsed.shown).toBe(1);
    expect(parsed.omitted).toBe(3);
    expect(parsed.unknown.map((u) => u.number)).toEqual([13]);
    expect(parsed.coverage).toEqual({ complete: true, note: null });
  });

  it("refuses another view or a malformed item instead of showing a partial list", () => {
    expect(parseDiscussionResponse({})).toBeNull();
    expect(parseDiscussionResponse(envelope({ kind: "pipeline-metrics" }))).toBeNull();
    expect(
      parseDiscussionResponse(
        envelope({ items: [{ number: 1, title: "x", url: "u", state: "OPEN", comments: "7" }] }),
      ),
    ).toBeNull();
  });

  it("reads the selected scope and repository, defaulting to open", () => {
    expect(selection("?repo=example%2Fproject&state=all")).toEqual({
      repository: "example/project",
      scope: "all",
    });
    expect(selection("?state=closed")).toEqual({ repository: null, scope: "closed" });
    expect(selection("?state=invalid&repo=not-a-repo")).toEqual({
      repository: null,
      scope: "open",
    });
  });

  it("explains the scope, including closed history", () => {
    expect(scopeText("open")).toContain("Open issues only");
    expect(scopeText("closed")).toContain("Closed issues only");
    expect(scopeText("all")).toContain("Open and closed");
  });

  it("counts comments in words", () => {
    expect(commentText(0)).toBe("0 comments");
    expect(commentText(1)).toBe("1 comment");
    expect(commentText(9)).toBe("9 comments");
  });

  it("never lets a superseded read overwrite a newer one", async () => {
    const applied: string[] = [];
    const responses: Array<(value: unknown) => void> = [];
    const fetcher = ((input: RequestInfo | URL) =>
      new Promise((resolve) => {
        responses.push(() => resolve(new Response(JSON.stringify(envelope()), { status: 200 })));
        void input;
      })) as unknown as typeof fetch;
    const loader = discussionLoader("/api/v1/discussion", fetcher, (state) =>
      applied.push(state.status),
    );
    const first = loader.load("example/project", "open");
    const second = loader.load("example/project", "all");
    // The second read answers first; the first read's late answer is ignored.
    responses[1]!(null);
    responses[0]!(null);
    await Promise.all([first, second]);
    expect(applied).toEqual(["loading", "loading", "ready"]);
  });
});
