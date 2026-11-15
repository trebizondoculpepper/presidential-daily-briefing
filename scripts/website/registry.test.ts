import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { boundedDownload, registryBoundary } from "./registry.js";
import { packageName, resolveRelease } from "./provenance.js";
const metadata = {
  name: packageName,
  version: "1.2.3",
  gitHead: "a".repeat(40),
  dist: {
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarball: `https://registry.npmjs.org/${packageName}/-/fixture.tgz`,
  },
};
afterEach(() => vi.restoreAllMocks());

describe("bounded registry transport", () => {
  it("reads exact-version metadata separately from latest and tolerates a bounded missing exact version", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return url.endsWith("/latest")
        ? Response.json(metadata)
        : new Response("missing", { status: 404 });
    });
    const observed = await registryBoundary.lookup("1.2.3", AbortSignal.timeout(1000));
    expect(observed).toEqual({ latest: "1.2.3", metadata: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/\/1\.2\.3$/);
    let now = 0,
      probes = 0;
    const result = await resolveRelease(
      { version: "1.2.3", gitHead: metadata.gitHead },
      {
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
        lookup: async () => ({ latest: "1.2.3", metadata: ++probes === 1 ? null : metadata }),
      },
    );
    expect(result.version).toBe("1.2.3");
    expect(probes).toBe(2);
  });
  it("rejects redirects, missing bodies and oversized responses without returning raw output", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("too large"));
    await expect(
      boundedDownload("https://registry.npmjs.org/fixture", AbortSignal.timeout(1000), 2),
    ).rejects.toThrow("size limit");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    fetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      boundedDownload("https://registry.npmjs.org/fixture", AbortSignal.timeout(1000), 100),
    ).rejects.toThrow("unavailable");
  });
});
