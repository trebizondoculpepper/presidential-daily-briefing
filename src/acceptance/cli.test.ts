import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argumentsFor, atomicJson, cachedSnapshot, checkpointSince, main } from "../cli.js";
import { repo, snapshot, time } from "../testing/snapshots.js";

describe("CLI freshness and local state safety", () => {
  it("validates options before collecting and requires explicit offline cache", () => {
    expect(() => argumentsFor(["--offline"])).toThrow("requires");
    expect(() => argumentsFor(["--repo", "bad"])).toThrow("owner/name");
    expect(() => argumentsFor(["--since", "yesterday"])).toThrow("ISO");
    expect(() => argumentsFor(["--limit", "0"])).toThrow("positive");
    expect(() => argumentsFor(["--offline", "--cache", "x", "--since", time])).toThrow(
      "live fetch",
    );
  });
  it("labels old cached snapshots offline, preserves checkpoint and rejects repository mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const cache = join(dir, "cache.json"),
        checkpoint = join(dir, "checkpoint.json");
      await atomicJson(cache, snapshot());
      await atomicJson(checkpoint, { schemaVersion: 1, repository: repo, through: time });
      let rendered = "";
      expect(
        await main(
          ["--offline", "--cache", cache, "--checkpoint", checkpoint, "--json"],
          async (text) => {
            rendered = text;
          },
        ),
      ).toBe(0);
      expect(JSON.parse(rendered).freshness.offline).toBe(true);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      await expect(cachedSnapshot(cache, "wrong/repo")).rejects.toThrow("invalid");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("advances only after complete successful output, using start of collection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const checkpoint = join(dir, "checkpoint.json");
      const data = snapshot();
      data.fetchedAt = "2026-11-12T10:05:00.000Z";
      const runtime = { collect: async () => data, currentRepository: async () => repo };
      await expect(
        main(
          ["--checkpoint", checkpoint],
          async () => {
            throw new Error("broken stdout");
          },
          runtime,
        ),
      ).rejects.toThrow("broken stdout");
      expect(await checkpointSince(checkpoint, repo)).toBeUndefined();
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(0);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      data.warnings.push("incomplete");
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(2);
      expect(JSON.parse(await readFile(checkpoint, "utf8")).through).toBe(time);
      await expect(
        main(["--checkpoint", checkpoint], async () => {}, {
          ...runtime,
          collect: async () => {
            throw new Error("API unavailable");
          },
        }),
      ).rejects.toThrow("API unavailable");
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("help names the installed command (#53)", () => {
  it("leads with pdb and mentions the checkout form only as an alternative", async () => {
    let main_ = "";
    let deps = "";
    await main(["--help"], async (t) => void (main_ = t));
    await main(["deps", "--help"], async (t) => void (deps = t));
    for (const text of [main_, deps]) {
      expect(text).toMatch(/^Usage: pdb /);
      expect(text.split("\n").filter((l) => /^\s*npm run pdb/.test(l))).toEqual([]);
    }
  });
});
