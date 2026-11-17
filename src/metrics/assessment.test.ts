import { describe, expect, it } from "vite-plus/test";
import { assessmentGroups } from "./assessment.js";
import { provenanceComment } from "../estimation/estimate.js";
import type { MetricProvenance } from "../estimation/estimate.js";
import type { Comment } from "../workflow/claims.js";

// Synthetic fixtures only: no real repository, agent or comment.
let nextId = 9000;
const record = (
  kind: "complexity" | "impact",
  size: "S" | "M" | "L",
  author = "writer",
): Comment => {
  const id = nextId++;
  return {
    databaseId: id,
    url: `https://example.test/c/${id}`,
    body: provenanceComment({
      ...(kind === "complexity"
        ? { schemaVersion: 2, kind: "complexity-estimate" }
        : { schemaVersion: 1, kind: "impact-estimate" }),
      storage: "labels",
      size,
      previous: [],
      rationale: "synthetic",
      assumptions: [],
      references: [],
      estimator: "alice",
      revision: null,
      guidanceVersion: 1,
      recordedAt: "2026-11-10T00:00:00Z",
    } as MetricProvenance),
    createdAt: "2026-11-10T00:00:00Z",
    author: { __typename: "User", login: author },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const trust = async (c: Comment) =>
  c.author?.login === "writer"
    ? ({ status: "trusted" } as const)
    : ({ status: "unknown", why: "permission unknown" } as const);
const facts = (labels: string[], comments: Comment[], complete = true) => ({
  labels: { nodes: labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
  lastEditedAt: null,
  comments,
  commentsComplete: complete,
});

describe("current assessment groups (#832)", () => {
  it("groups both metrics by their current valid size, with explicit basis and provenance", async () => {
    const g = await assessmentGroups(
      facts(["complexity:S", "impact:L"], [record("complexity", "S"), record("impact", "L")]),
      trust,
    );
    expect(g.complexity).toMatchObject({
      basis: "current-valid-complexity",
      group: "S",
      state: "estimated",
    });
    expect(g.complexity.provenance).toMatchObject({
      size: "S",
      recordedAt: "2026-11-10T00:00:00Z",
    });
    expect(g.impact).toMatchObject({
      basis: "current-valid-impact",
      group: "L",
      authority: "trusted",
    });
  });

  it("regroups a label that drifted from its record as stale", async () => {
    const g = await assessmentGroups(facts(["complexity:L"], [record("complexity", "S")]), trust);
    expect(g.complexity).toMatchObject({ group: "stale", size: "L" });
  });

  it("never turns a label set outside pdb into trusted provenance", async () => {
    const g = await assessmentGroups(facts(["impact:M"], []), trust);
    expect(g.impact).toMatchObject({ group: "M", provenance: null, authority: "none" });
    expect(g.impact.reasons.join(" ")).toMatch(/no recorded rationale/);
  });

  it("keeps conflict, unassessed and unknown as their own groups", async () => {
    const conflict = await assessmentGroups(facts(["complexity:S", "complexity:L"], []), trust);
    expect(conflict.complexity.group).toBe("conflict");
    const none = await assessmentGroups(facts([], []), trust);
    expect(none.complexity.group).toBe("unassessed");
    expect(none.impact.group).toBe("unassessed");
    const unverified = await assessmentGroups(
      facts(["complexity:S"], [record("complexity", "S", "stranger")]),
      trust,
    );
    expect(unverified.complexity.group).toBe("unknown");
    const cut = await assessmentGroups(
      facts(["complexity:S"], [record("complexity", "S")], false),
      trust,
    );
    expect(cut.complexity.group).toBe("unknown");
  });
});
