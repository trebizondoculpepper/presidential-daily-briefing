import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";

// Synthetic GraphQL answers only.
describe("typed label resolution (#921)", () => {
  it("resolves canonical spellings through the service's query executor", async () => {
    const svc = createGhService({
      env: {},
      query: async () => ({
        repository: {
          l0: { name: "status:ready" },
          l1: null,
          s1: { nodes: [{ name: "Bug" }], pageInfo: { hasNextPage: false } },
        },
      }),
    });
    expect(await svc.labels.resolve("o/r", ["status:ready", "bug"])).toEqual({
      status: "resolved",
      labels: ["status:ready", "Bug"],
    });
  });

  it("is unresolved, never missing, when the read fails or is cut short", async () => {
    const failing = createGhService({
      env: {},
      query: async () => {
        throw new Error("boom");
      },
    });
    expect(await failing.labels.resolve("o/r", ["x"])).toMatchObject({ status: "unresolved" });
    const cut = createGhService({
      env: {},
      query: async () => ({
        repository: { l0: null, s0: { nodes: [], pageInfo: { hasNextPage: true } } },
      }),
    });
    expect(await cut.labels.resolve("o/r", ["x"])).toMatchObject({ status: "unresolved" });
  });
});
