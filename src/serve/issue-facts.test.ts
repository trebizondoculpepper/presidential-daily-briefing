import { describe, expect, it } from "vite-plus/test";
import { cachedIssueFacts } from "./issue-facts.js";
import { CollectionError, ServeCache } from "./cache.js";
import { readProfiles } from "../github/readplan.js";
import { issue } from "../testing/snapshots.js";

const makeCache = () =>
  new ServeCache({
    ttlMs: 60_000,
    clock: { now: () => new Date(1_000), setTimeout: () => ({}), clearTimeout: () => {} },
    authContext: async () => ({ host: "github.com", login: "test" }),
    initialAuth: { host: "github.com", login: "test" },
  });

describe("cachedIssueFacts (#936)", () => {
  it("throws GITHUB_UNAVAILABLE when no reader is configured", async () => {
    const cache = makeCache();
    await expect(
      cachedIssueFacts(
        cache,
        { repository: "o/r", numbers: [1], issuesPerRequest: 5, concurrency: 1 },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("batches missing issues, caches complete entries, and slices per issue", async () => {
    const cache = makeCache();
    const batches: (readonly number[])[] = [];
    const readBatch = async (numbers: readonly number[]) => {
      batches.push(numbers);
      return {
        issues: numbers.map((n) => issue(n)),
        gone: [],
        unavailable: [],
        coverage: numbers.map((n) => ({
          source: "issue" as const,
          subject: `o/r#${n}`,
          state: "complete" as const,
          observedAt: "2026-11-18T00:00:00Z",
          omission: null,
          failure: null,
          profileVersion: readProfiles["briefing-shortlist-v1"].version,
        })),
        quota: null,
        notAttempted: [],
        warnings: [],
        complete: true,
      };
    };

    const first = await cachedIssueFacts(
      cache,
      { repository: "o/r", numbers: [1, 2], issuesPerRequest: 10, concurrency: 1 },
      readBatch,
    );
    expect(first.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(batches).toEqual([[1, 2]]);

    const second = await cachedIssueFacts(
      cache,
      { repository: "o/r", numbers: [1, 2], issuesPerRequest: 10, concurrency: 1 },
      readBatch,
    );
    expect(second.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(batches).toHaveLength(1);
  });

  it("reports quota refusal without failing unattempted items", async () => {
    const cache = makeCache();
    const result = await cachedIssueFacts(
      cache,
      { repository: "o/r", numbers: [5], issuesPerRequest: 5, concurrency: 1 },
      async () => {
        throw new CollectionError("GITHUB_RATE_LIMITED", "Rate limited");
      },
    );
    expect(result.complete).toBe(false);
    expect(result.quota).toEqual({ retryAfterSeconds: null, resetAt: null });
    expect(result.notAttempted).toEqual(["https://github.com/o/r/issues/5"]);
  });
});
