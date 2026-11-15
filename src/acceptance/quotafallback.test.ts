/**
 * Quota fallback (#371, doc/design/read-degradation.md "Last-successful snapshots"): a live read
 * refused for quota reuses the caller's explicit --cache snapshot, labelled stale with its
 * observation time, age and the refusal's own reset evidence; anything unusable is a distinct
 * diagnosis; nothing is written; the next successful live read recovers.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, checkpointSince, main } from "../cli.js";
import { classifyFailure } from "../serve/cache.js";
import { repo, snapshot, time } from "../testing/snapshots.js";

const observed = Date.parse(time);
const minutes = (n: number) => new Date(observed + n * 60_000);
const quota = (retry: { retryAfterSeconds?: number | null; resetAt?: string | null }) =>
  Object.assign(new Error("rate limited"), { rateLimited: true, retry });

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "pdb-quota-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Run the briefing with a collector that throws `failure`, at `now`. */
async function briefing(args: string[], failure: unknown, now: Date) {
  let out = "";
  const code = await main(
    ["--repo", repo, "--no-update-check", ...args],
    async (text) => void (out += text),
    {
      collect: async () => {
        throw failure;
      },
      currentRepository: async () => repo,
      now: () => now,
      stderr: () => {},
    },
  );
  return { code, out };
}

describe("quota fallback to an explicit snapshot (#371)", () => {
  it("labels a compatible snapshot stale, exits 2 and writes nothing", async () => {
    await withDir(async (dir) => {
      const cache = join(dir, "cache.json");
      const checkpoint = join(dir, "checkpoint.json");
      await atomicJson(cache, snapshot());
      const before = await readFile(cache, "utf8");
      const resetAt = "2026-11-12T10:20:00.000Z";
      const { code, out } = await briefing(
        ["--cache", cache, "--checkpoint", checkpoint, "--json"],
        quota({ resetAt }),
        minutes(5),
      );
      expect(code).toBe(2);
      const report = JSON.parse(out);
      expect(report.freshness).toMatchObject({
        source: "stale",
        offline: true,
        fetchedAt: time,
        renderedAt: minutes(5).toISOString(),
        ageSeconds: 300,
        fallback: {
          reason: "live-read-quota-refused",
          cache,
          resetAt,
          retryAfterSeconds: null,
          maxAgeSeconds: 1800,
        },
      });
      expect(report.completeness.complete).toBe(false);
      expect(report.completeness.warnings.join("\n")).toContain(
        `STALE: GitHub refused the live read for quota (quota resets at ${resetAt})`,
      );
      expect(await readFile(cache, "utf8")).toBe(before);
      expect(await checkpointSince(checkpoint, repo)).toBeUndefined();
    });
  });

  it("says STALE CACHE in text, not a chosen offline read", async () => {
    await withDir(async (dir) => {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot());
      const { code, out } = await briefing(["--cache", cache], quota({}), minutes(1));
      expect(code).toBe(2);
      expect(out).toContain("STALE CACHE (live read refused for quota)");
      expect(out).not.toContain("OFFLINE CACHE");
      expect(out).toContain("no reset time was reported");
    });
  });

  it("gives a distinct diagnosis for no, absent, corrupt, foreign and expired snapshots", async () => {
    await withDir(async (dir) => {
      const refused = quota({ retryAfterSeconds: 60 });
      await expect(briefing([], refused, minutes(1))).rejects.toThrow(
        "No stale fallback: no --cache PATH snapshot was given",
      );
      const absent = join(dir, "absent.json");
      await expect(briefing(["--cache", absent], refused, minutes(1))).rejects.toThrow(
        `${absent} does not exist`,
      );
      const corrupt = join(dir, "corrupt.json");
      await writeFile(corrupt, "{ not json");
      await expect(briefing(["--cache", corrupt], refused, minutes(1))).rejects.toThrow(
        "is corrupt (not valid JSON)",
      );
      expect(await readFile(corrupt, "utf8")).toBe("{ not json");
      const foreign = join(dir, "foreign.json");
      await atomicJson(foreign, { ...snapshot(), repository: "other/repo" });
      await expect(briefing(["--cache", foreign], refused, minutes(1))).rejects.toThrow(
        `is not a usable snapshot of ${repo}`,
      );
      const old = join(dir, "old.json");
      await atomicJson(old, snapshot());
      await expect(briefing(["--cache", old], refused, minutes(31))).rejects.toThrow(
        "older than the 30-minute limit",
      );
      // Every diagnosis carries the refusal's own retry evidence.
      await expect(briefing(["--cache", old], refused, minutes(31))).rejects.toThrow(
        "retry after 60s",
      );
    });
  });

  it("does not fall back for failures that are not quota refusals", async () => {
    await withDir(async (dir) => {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot());
      const auth = Object.assign(new Error("auth"), { rateLimited: true, authentication: true });
      await expect(briefing(["--cache", cache], auth, minutes(1))).rejects.toThrow("auth");
      await expect(
        briefing(["--cache", cache], new Error("network down"), minutes(1)),
      ).rejects.toThrow("network down");
    });
  });

  it("recovers to a live read, refreshing the snapshot, once quota resets", async () => {
    await withDir(async (dir) => {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot());
      expect((await briefing(["--cache", cache], quota({}), minutes(1))).code).toBe(2);
      const fresh = { ...snapshot(), fetchedAt: minutes(20).toISOString() };
      let out = "";
      const code = await main(
        ["--repo", repo, "--no-update-check", "--cache", cache, "--json"],
        async (text) => void (out += text),
        { collect: async () => fresh, currentRepository: async () => repo, now: () => minutes(20) },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).freshness).toMatchObject({ source: "live", offline: false });
      expect(JSON.parse(out).freshness.fallback).toBeUndefined();
      expect(JSON.parse(await readFile(cache, "utf8")).fetchedAt).toBe(fresh.fetchedAt);
    });
  });
});

describe("pdb serve rate-limit evidence (#371)", () => {
  const now = observed;
  it("never presents its default cooldown as a GitHub-reported reset", () => {
    const unreported = classifyFailure(quota({}), now);
    expect(unreported.resetReported).toBe(false);
    expect(unreported.message).toContain("reported no reset time");
    expect(unreported.resetAt).toBe(new Date(now + 60_000).toISOString());
    const reported = classifyFailure(quota({ resetAt: minutes(5).toISOString() }), now);
    expect(reported.resetReported).toBe(true);
    expect(reported.resetAt).toBe(minutes(5).toISOString());
    expect(reported.message).toContain("live reads resume after");
    // Bounded: a far reset still caps the cooldown.
    expect(classifyFailure(quota({ retryAfterSeconds: 86_400 }), now).resetAt).toBe(
      minutes(10).toISOString(),
    );
  });
});
