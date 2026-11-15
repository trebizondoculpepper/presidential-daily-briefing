import { describe, expect, it } from "vite-plus/test";
import { ServeCache } from "./cache.js";
import { serviceMutation } from "./mutations.js";
import type { WriteOutcome } from "./mutations.js";

const cache = () =>
  new ServeCache({
    ttlMs: 300000,
    clock: { now: () => new Date(0), setTimeout: () => ({}), clearTimeout: () => {} },
    authContext: async () => ({ host: "github.com", login: "test" }),
    initialAuth: { host: "github.com", login: "test" },
  });
const key = (repository: string, collector = "discovery") => ({
  repository,
  collector,
  coverage: {},
});

describe("service mutation cache boundary (#453)", () => {
  it("invalidates issue, queue and served cross-repository contexts only after applied or uncertain outcomes", async () => {
    for (const state of [
      "applied",
      "partial",
      "unknown",
      "refused",
      "unchanged",
    ] as WriteOutcome[]) {
      const c = cache();
      try {
        for (const [repo, collector] of [
          ["a/r", "issue"],
          ["a/r", "discovery"],
          ["b/r", "deps"],
        ])
          await c.read(key(repo, collector), async () => "before");
        let writes = 0;
        expect(
          await serviceMutation(
            c,
            async () => {
              writes++;
              return { state };
            },
            (result) => result.state,
          ),
        ).toEqual({ state });
        expect(writes).toBe(1);
        expect(c.status().entries).toBe(state === "refused" || state === "unchanged" ? 3 : 0);
      } finally {
        c.close();
      }
    }
  });

  it("labels a pre-write pending result invalidated, never inserts it, and starts no automatic retry", async () => {
    const c = cache();
    let release!: (value: string) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let reads = 0;
    try {
      const pending = c.track(false, () =>
        c.read(key("a/r"), async () => {
          reads++;
          began();
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        }),
      );
      await started;
      await expect(
        serviceMutation(
          c,
          async () => {
            throw new Error("unknown remote outcome");
          },
          () => "applied",
        ),
      ).rejects.toThrow("unknown remote outcome");
      release("before write");
      expect(await pending).toMatchObject({
        value: "before write",
        freshness: [{ stale: true, refreshError: { code: "CACHE_INVALIDATED" } }],
      });
      expect(c.status().entries).toBe(0);
      expect(reads).toBe(1);
      expect(await c.read(key("a/r"), async () => "after write")).toBe("after write");
    } finally {
      c.close();
    }
  });
});
