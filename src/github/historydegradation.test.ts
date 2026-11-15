/**
 * #370 (doc/design/read-degradation.md): a failed history or changed-since query keeps the
 * successfully collected current inventory, marks the read incomplete with the failure's safe
 * category and coverage, never claims "no changes", and never overwrites the cache or advances
 * the checkpoint. Injected readers only.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, historyComplete, type Query } from "./github.js";
import { checkpointSince, main } from "../cli.js";
import { issue, page, pr, repo, time } from "../testing/snapshots.js";

const failure = (category: string) =>
  Object.assign(new Error(`raw gh output with a token-like ghp_secret (${category})`), {
    evidence: { category },
    ...(category.includes("rate-limit") ? { rateLimited: true } : {}),
  });

type HistoryAnswer = "ok" | "fail-first" | "fail-second" | Error;
/** Inventory always succeeds; issue and PR history answer as configured. */
function reader(issueHistory: HistoryAnswer, prHistory: HistoryAnswer = "ok") {
  const calls: string[] = [];
  const answer = (mode: HistoryAnswer, cursor: unknown, field: string, nodes: unknown[]) => {
    if (mode instanceof Error) throw mode;
    if (mode === "fail-first") throw failure("server");
    if (mode === "fail-second" && cursor) throw failure("timeout");
    // Two pages when the second is to fail; the first page is still in the window.
    return {
      repository: {
        [field]: mode === "fail-second" && !cursor ? page(nodes, true, "p2") : page(nodes),
      },
    };
  };
  const query: Query = async (source, vars) => {
    if (source.includes("states:[OPEN,CLOSED,MERGED]")) {
      calls.push("pr-history");
      return answer(prHistory, vars.cursor, "pullRequests", [
        {
          ...pr(),
          number: 30,
          url: `https://github.com/${repo}/pull/30`,
          state: "MERGED",
          updatedAt: time,
        },
      ]);
    }
    if (source.includes("states:[OPEN,CLOSED]")) {
      calls.push("issue-history");
      return answer(issueHistory, vars.cursor, "issues", [
        { ...issue(20), state: "CLOSED", updatedAt: time },
      ]);
    }
    if (source.includes("pullRequests(first"))
      return {
        repository: {
          pullRequests: page([{ ...pr(), number: 3, url: `https://github.com/${repo}/pull/3` }]),
        },
      };
    return { repository: { issues: page([issue(1), issue(2)]) } };
  };
  return { query, calls };
}
const since = "2026-11-01T00:00:00Z";
const read = (q: Query, options = {}) =>
  collect(repo, { since, ...options }, q, () => new Date(time));
const historyCoverage = (data: Awaited<ReturnType<typeof collect>>) =>
  data.collection!.coverage.find((c) => c.source === "history");

describe("current inventory survives a failed history read (#370)", () => {
  it("a primary rate limit keeps the inventory, stops the next history source and never claims no changes", async () => {
    const { query, calls } = reader(failure("rate-limited"));
    const data = await read(query);
    expect(data.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(data.pullRequests.map((p) => p.number)).toEqual([3]);
    expect(data.changed).toEqual([]);
    expect(data.history).toMatchObject({
      state: "failed",
      failure: "issues: rate-limited, pull-requests: not-attempted",
    });
    // The quota refusal stops further history requests rather than spending them.
    expect(calls).toEqual(["issue-history"]);
    expect(historyCoverage(data)).toMatchObject({ state: "failed", observedAt: null });
    expect(data.warnings.join(" ")).toMatch(
      /unknown, not none\. The current inventory was read completely/,
    );
    // Safe category only: the raw message (with its token-like text) never surfaces.
    expect(JSON.stringify(data)).not.toContain("ghp_secret");
    expect(historyComplete(data)).toBe(false);
  });

  it("a secondary rate limit is reported as its own category", async () => {
    const data = await read(reader(failure("secondary-rate-limit")).query);
    expect(data.history?.failure).toMatch(/^issues: secondary-rate-limit/);
    expect(data.issues).toHaveLength(2);
  });

  it("a timeout on one source keeps the other source's changes: partial, not failed", async () => {
    const { query, calls } = reader(failure("timeout"));
    const data = await read(query);
    expect(calls).toEqual(["issue-history", "pr-history"]);
    expect(data.history?.state).toBe("partial");
    expect(data.changed.map((c) => c.number)).toEqual([30]);
    expect(historyCoverage(data)?.state).toBe("partial");
  });

  it("partial pages keep what was read before the failure", async () => {
    const data = await read(reader("fail-second").query);
    expect(data.changed.map((c) => c.number).sort()).toEqual([20, 30]);
    expect(data.history).toMatchObject({ state: "partial", failure: "issues: timeout" });
    expect(data.history?.sources[0]).toMatchObject({ source: "issues", pages: 1, complete: false });
  });

  it("a complete history window is complete, with no warning", async () => {
    const data = await read(reader("ok").query);
    expect(data.history).toMatchObject({ state: "complete", failure: null });
    expect(historyCoverage(data)?.state).toBe("complete");
    expect(data.warnings).toEqual([]);
    expect(historyComplete(data)).toBe(true);
  });

  it("change-window mode marks change evidence incomplete with the failure, keeping the inventory", async () => {
    const window = { from: since, to: time, source: "explicit-since" } as never;
    const data = await collect(
      repo,
      { changeWindow: window },
      reader(failure("timeout")).query,
      () => new Date(time),
    );
    expect(data.issues).toHaveLength(2);
    expect(data.changeEvidence?.complete).toBe(false);
    expect(data.changeEvidence?.coverage[0]).toMatchObject({ complete: false, failure: "timeout" });
    expect(data.changeEvidence?.coverage[0]?.omission).toMatch(/could not be read \(timeout\)/);
    expect(historyComplete(data)).toBe(false);
  });

  it("cancellation still rejects: a cancelled read never returns a report", async () => {
    const controller = new AbortController();
    const query: Query = async (source) => {
      if (source.includes("states:[OPEN,CLOSED]")) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return reader("ok").query(source, {});
    };
    await expect(read(query, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("CLI: incomplete history never advances the checkpoint or overwrites the cache (#370)", () => {
  it("exits 2, keeps the previous cache bytes and checkpoint, and says changes are unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdb-370-"));
    try {
      const cache = join(dir, "cache.json");
      const checkpoint = join(dir, "checkpoint.json");
      await writeFile(cache, "previous successful snapshot");
      await writeFile(
        checkpoint,
        JSON.stringify({ schemaVersion: 1, repository: repo, through: since }),
      );
      const data = await read(reader(failure("rate-limited")).query);
      let text = "";
      const code = await main(
        ["--checkpoint", checkpoint, "--cache", cache, "--full"],
        async (t) => {
          text += t;
        },
        { collect: async () => data, currentRepository: async () => repo },
      );
      expect(code).toBe(2);
      expect(await readFile(cache, "utf8")).toBe("previous successful snapshot");
      expect(await checkpointSince(checkpoint, repo)).toBe(since);
      expect(text).toMatch(
        /UPDATED SINCE .* — FAILED: changes in this window are unknown, not none/,
      );
      expect(text).toMatch(/cache\.json was not overwritten/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
