import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GitHub answers only.
const now = () => new Date("2026-11-18T01:00:00.000Z");
describe("typed rate-limit capability (#923)", () => {
  it("reads rate_limit and returns the normalised reading with the response status", async () => {
    const paths: string[] = [];
    const svc = createGhService({
      env: {},
      now,
      rest: async (path) => {
        paths.push(path);
        return {
          status: 200,
          body: {
            resources: { core: { limit: 5000, used: 10, remaining: 4990, reset: 1763431200 } },
          },
        };
      },
    });
    const answer = await svc.account.rateLimits();
    expect(paths).toEqual(["rate_limit"]);
    expect(answer.status).toBe(200);
    expect(answer.reading).toMatchObject({
      observedAt: "2026-11-18T01:00:00.000Z",
      rows: [
        {
          resource: "core",
          family: "rest-core",
          limit: 5000,
          remaining: 4990,
          inconsistencies: [],
        },
      ],
    });
  });

  it("keeps a refusal's status and evidence and gives no reading", async () => {
    const evidence = { category: "rate-limited" } as never;
    const svc = createGhService({
      env: {},
      now,
      rest: async () => ({ status: 429, body: {}, evidence }),
    });
    const answer = await svc.account.rateLimits();
    expect(answer).toEqual({ status: 429, evidence, reading: null });
  });

  it("gives no reading for a malformed success and propagates a thrown read", async () => {
    const malformed = createGhService({
      env: {},
      now,
      rest: async () => ({ status: 200, body: { nope: 1 } }),
    });
    expect((await malformed.account.rateLimits()).reading).toBeNull();
    const failing = createGhService({
      env: {},
      now,
      rest: async () => {
        throw new Error("aborted");
      },
    });
    await expect(failing.account.rateLimits()).rejects.toThrow("aborted");
  });
});
