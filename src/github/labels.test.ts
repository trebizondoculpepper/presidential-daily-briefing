/** #312: label filter requests are bounded and resolve to canonical repository labels. */
import { describe, expect, it } from "vite-plus/test";
import { normalizeLabelRequest, resolveLabels } from "./labels.js";
import type { Query } from "./github.js";

const repoLabels = ["bug", "Sound-Effects", "status:ready"];
const reader = (labels = repoLabels): { query: Query; calls: number } => {
  const state = { calls: 0 };
  const query: Query = async (_source, vars) => {
    state.calls++;
    const repository: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (!/^l\d$/.test(key)) continue;
      const i = key.slice(1);
      repository[`l${i}`] = labels.includes(String(value)) ? { name: value } : null;
      repository[`s${i}`] = {
        nodes: labels
          .filter((l) => l.toLowerCase().includes(String(value).toLowerCase()))
          .map((name) => ({ name })),
        pageInfo: { hasNextPage: false },
      };
    }
    return { repository };
  };
  return Object.assign(state, { query });
};

describe("label filter requests (#312)", () => {
  it("validates names and bounds the request; duplicates ignoring case are idempotent", () => {
    expect(normalizeLabelRequest(["bug", " BUG ", "status:ready"])).toEqual({
      ok: true,
      labels: ["bug", "status:ready"],
    });
    expect(normalizeLabelRequest([" "])).toMatchObject({
      ok: false,
      why: expect.stringMatching(/nonempty/),
    });
    expect(normalizeLabelRequest(["x".repeat(51)])).toMatchObject({ ok: false });
    expect(normalizeLabelRequest(Array.from({ length: 9 }, (_, i) => `l${i}`))).toMatchObject({
      ok: false,
      why: expect.stringMatching(/At most 8/),
    });
  });

  it("resolves canonical names in one query, ignoring case", async () => {
    const r = reader();
    expect(await resolveLabels("o/r", ["bug", "sound-effects"], r.query)).toEqual({
      status: "resolved",
      labels: ["bug", "Sound-Effects"],
    });
    expect(r.calls).toBe(1);
  });

  it("names a confirmed nonexistent label; a substring is not a match", async () => {
    expect(await resolveLabels("o/r", ["sound", "nope"], reader().query)).toEqual({
      status: "unknown",
      missing: ["sound", "nope"],
    });
  });

  it("a search page cut short is unresolved, not a confirmed unknown label", async () => {
    const truncated: Query = async () => ({
      repository: {
        l0: null,
        s0: { nodes: [{ name: "bugfix" }], pageInfo: { hasNextPage: true } },
      },
    });
    expect(await resolveLabels("o/r", ["BUG"], truncated)).toEqual({
      status: "unresolved",
      why: "too many labels resemble BUG to confirm whether it exists",
    });
  });

  it("a failed or malformed lookup is unresolved, never absence, and never leaks the raw error", async () => {
    const failing: Query = async () => {
      throw Object.assign(new Error("ghp_secret raw"), { evidence: { category: "rate-limited" } });
    };
    const failed = await resolveLabels("o/r", ["bug"], failing);
    expect(failed).toEqual({
      status: "unresolved",
      why: "the repository's labels could not be read (rate-limited)",
    });
    const malformed: Query = async () => ({ repository: {} });
    expect((await resolveLabels("o/r", ["bug"], malformed)).status).toBe("unresolved");
  });
});
