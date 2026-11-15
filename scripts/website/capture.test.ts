import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { packageName, pinRelease, resolveRelease, verifyTarball } from "./provenance.js";
import { sanitizeOutput } from "./sanitize.js";

const bytes = Buffer.from("fixture artifact, never an npm release");
const expected = { version: "1.2.3", gitHead: "a".repeat(40) };
const metadata = {
  name: packageName,
  ...expected,
  dist: {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    tarball: `https://registry.npmjs.org/${packageName}/-/presidential-daily-briefing-1.2.3.tgz`,
  },
};

describe("release capture identity", () => {
  it("pins exact registry identity and verifies the actual artifact bytes", () => {
    const release = pinRelease(expected, "1.2.3", metadata);
    expect(Object.isFrozen(release)).toBe(true);
    verifyTarball(bytes, release);
    expect(() => verifyTarball(Buffer.from("wrong"), release)).toThrow("integrity mismatch");
    expect(() => pinRelease(expected, "1.2.4", metadata)).toThrow("do not match");
    expect(() => pinRelease(expected, "1.2.3", { ...metadata, gitHead: "b".repeat(40) })).toThrow(
      "do not match",
    );
    expect(() =>
      pinRelease(expected, "1.2.3", {
        ...metadata,
        dist: { ...metadata.dist, tarball: "https://registry.npmjs.org.evil.invalid/package.tgz" },
      }),
    ).toThrow("tarball location");
  });
  it("bounds lag probes and never retargets an overtaken candidate", async () => {
    let now = 0,
      reads = 0;
    const boundary = {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
      lookup: async () => {
        reads++;
        return { latest: reads < 3 ? "1.2.2" : "1.2.3", metadata };
      },
    };
    expect((await resolveRelease(expected, boundary)).version).toBe("1.2.3");
    expect(reads).toBe(3);
    await expect(
      resolveRelease(expected, {
        ...boundary,
        lookup: async () => ({ latest: "1.2.4", metadata }),
      }),
    ).rejects.toThrow("superseded");
    now = 0;
    reads = 0;
    await expect(
      resolveRelease(expected, {
        ...boundary,
        lookup: async () => {
          reads++;
          return { latest: "1.2.2", metadata };
        },
      }),
    ).rejects.toThrow("six probes");
    expect(reads).toBe(6);
    expect(now).toBeLessThanOrEqual(120_000);
  });
});

describe("capture exposure boundary", () => {
  const options = {
    sensitiveValues: ["test-secret-value"],
    controlledPaths: ["/tmp/capture-123"],
    privateIdentities: ["private_fixture_identity"],
  };
  it("removes terminal effects and visibly redacts only approved workspace paths", () => {
    const result = sanitizeOutput(
      "\x1b[2Jhello\x1b]8;;https://evil.invalid\x07 link\x1b]8;;\x07\r\n/tmp/capture-123/snapshot.json",
      options,
    );
    expect(result.text).toBe("hello link\n[capture-workspace]/snapshot.json");
    expect(result.terminalControlsRemoved).toBe(true);
    expect(result.redactions).toEqual(["capture workspace path"]);
    expect(result.sha256).toBe(createHash("sha256").update(result.text).digest("hex"));
  });
  it("discards credential, private identity and unexpected path output without echoing it", () => {
    for (const value of [
      "test-secret-value",
      "private_fixture_identity",
      "/Users/example/private.toml",
      "GITHUB_TOKEN=fixture-token",
      "ghp_012345678901234567890123456789012345",
    ]) {
      expect(() => sanitizeOutput(value, options)).toThrow(/discarded/);
    }
    expect(() => sanitizeOutput("x".repeat(2 * 1024 * 1024 + 1), options)).toThrow("2 MiB");
  });
});
