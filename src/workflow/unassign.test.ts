import { describe, expect, it } from "vite-plus/test";
import type { Query } from "../github/github.js";
import { applyUnassign, formatHumanUnassignComment, previewUnassign } from "./unassign.js";

const REPO = "example/project";
const CLAIM_START = "2026-11-18T10:00:00Z";

function makeQuery(opts: {
  labels?: string[];
  assignees?: string[];
  state?: "OPEN" | "CLOSED";
  claimAddedAt?: string | null;
  historyComplete?: boolean;
  comments?: { id: string; body: string; createdAt: string; author?: { login: string } }[];
}): Query {
  const labels = opts.labels ?? ["agent:kavya", "status:in-progress", "impact:M", "needs-human"];
  const assignees = opts.assignees ?? ["alice", "bob"];
  const state = opts.state ?? "OPEN";
  const claimAddedAt = opts.claimAddedAt === undefined ? CLAIM_START : opts.claimAddedAt;
  const historyComplete = opts.historyComplete ?? true;
  const comments = (opts.comments ?? []).map((c) => ({
    ...c,
    author: c.author ?? { __typename: "User", login: "alice" },
  }));

  return (async (query: string) => {
    if (query.includes("timelineItems") && !query.includes("labels(")) {
      return {
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasPreviousPage: !historyComplete, startCursor: null },
              nodes: claimAddedAt
                ? [
                    {
                      __typename: "LabeledEvent",
                      createdAt: claimAddedAt,
                      label: { name: "agent:kavya" },
                    },
                  ]
                : [],
            },
          },
        },
      };
    }
    if (query.includes("comments(") && !query.includes("labels(")) {
      return {
        repository: {
          issueOrPullRequest: {
            comments: {
              pageInfo: { hasPreviousPage: false, startCursor: null },
              nodes: comments,
            },
          },
        },
      };
    }
    return {
      repository: {
        claims: { pageInfo: { hasNextPage: false }, nodes: [] },
        issueOrPullRequest: {
          __typename: "Issue",
          number: 42,
          title: "Stalled task",
          body: "Needs human intervention",
          url: "https://github.com/example/project/issues/42",
          state,
          createdAt: "2026-11-18T09:00:00Z",
          updatedAt: "2026-11-18T10:05:00Z",
          lastEditedAt: null,
          labels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: labels.map((name) => ({ name })),
          },
          assignees: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: assignees.map((login) => ({ __typename: "User", login })),
          },
          issueDependenciesSummary: { blockedBy: 0 },
          blockedBy: { nodes: [] },
          comments: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: null,
            },
            nodes: comments,
          },
          timelineItems: {
            pageInfo: { hasPreviousPage: !historyComplete, startCursor: null },
            nodes: claimAddedAt
              ? [
                  {
                    __typename: "LabeledEvent",
                    createdAt: claimAddedAt,
                    label: { name: "agent:kavya" },
                  },
                ]
              : [],
          },
          closedByPullRequestsReferences: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    };
  }) as Query;
}

const allowPerm = async (login: string) => {
  if (login.includes("/")) throw new Error(`unexpected repository passed as login: ${login}`);
  return "write" as const;
};
const denyPerm = async () => "read" as const;
const unknownPerm = async () => "unknown" as const;

describe("human unassign shared service (#588)", () => {
  it("previews and applies unassign while preserving multiple human assignees, other agents and ticket state", async () => {
    let labels = ["agent:kavya", "agent:other", "status:in-progress", "impact:M", "needs-human"];
    const comments: { id: string; body: string; createdAt: string }[] = [];
    const writeCalls: string[][] = [];

    const query: Query = (async (q, vars) => {
      return makeQuery({ labels, assignees: ["alice", "bob"], comments })(q, vars);
    }) as Query;

    const previewRes = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: allowPerm, actorLogin: "alice" },
    );
    expect(previewRes.ok).toBe(true);
    if (!previewRes.ok) return;
    expect(previewRes.preview.decision.verdict).toBe("allow");
    expect(previewRes.preview.preserved.humanAssignees).toEqual(["alice", "bob"]);
    expect(previewRes.preview.preserved.otherAgents).toEqual(["other"]);
    expect(previewRes.preview.claimStart).toBe(CLAIM_START);

    const result = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-1",
        expectedClaimStart: previewRes.preview.claimStart,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query,
        permission: allowPerm,
        actorLogin: "alice",
        run: async (args) => {
          writeCalls.push(args);
          if (args[0] === "issue" && args[1] === "comment") {
            const bodyIdx = args.indexOf("--body");
            comments.push({
              id: "c1",
              body: args[bodyIdx + 1] ?? "",
              createdAt: "2026-11-18T11:00:00Z",
            });
          } else if (args[0] === "issue" && args[1] === "edit") {
            labels = labels.filter((l) => l !== "agent:kavya");
          }
          return;
        },
      },
    );

    expect(result.status).toBe("applied");
    expect(result.recordOutcome).toBe("applied");
    expect(result.labelOutcome).toBe("removed");
    expect(result.preserved?.humanAssignees).toEqual(["alice", "bob"]);
    expect(result.preserved?.labels).toEqual([
      "agent:other",
      "status:in-progress",
      "impact:M",
      "needs-human",
    ]);
    expect(result.preserved?.state).toBe("OPEN");
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0]![1]).toBe("comment");
    expect(writeCalls[1]).toEqual([
      "issue",
      "edit",
      "42",
      "--repo",
      REPO,
      "--remove-label",
      "agent:kavya",
    ]);
  });

  it("returns idempotent noop when the selected claim is absent", async () => {
    const query = makeQuery({
      labels: ["status:ready", "impact:M"],
      assignees: ["alice"],
      claimAddedAt: null,
    });
    const previewRes = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: allowPerm, actorLogin: "alice" },
    );
    expect(previewRes.ok).toBe(true);
    if (!previewRes.ok) return;
    expect(previewRes.preview.decision.verdict).toBe("noop");

    let writes = 0;
    const result = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-noop",
        expectedClaimStart: null,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query,
        permission: allowPerm,
        actorLogin: "alice",
        run: async () => {
          writes++;
          return;
        },
      },
    );
    expect(result.status).toBe("noop");
    expect(writes).toBe(0);
  });

  it("refuses with CLAIM_REPLACED when a newer claim replaced the previewed claim", async () => {
    const previewQuery = makeQuery({ claimAddedAt: CLAIM_START });
    const previewRes = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query: previewQuery, permission: allowPerm, actorLogin: "alice" },
    );
    expect(previewRes.ok).toBe(true);
    if (!previewRes.ok) return;

    const replacedQuery = makeQuery({ claimAddedAt: "2026-11-18T12:00:00Z" });
    let writes = 0;
    const result = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-replaced",
        expectedClaimStart: CLAIM_START,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query: replacedQuery,
        permission: allowPerm,
        actorLogin: "alice",
        run: async () => {
          writes++;
          return;
        },
      },
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("CLAIM_REPLACED");
    expect(writes).toBe(0);
  });

  it("refuses untrusted context, denied/unknown permission, and incomplete history without override", async () => {
    const query = makeQuery({});
    const untrusted = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: false },
      { query, permission: allowPerm, actorLogin: "alice" },
    );
    expect(untrusted.ok && untrusted.preview.decision.code).toBe("HUMAN_CONTEXT_REQUIRED");

    const denied = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: denyPerm, actorLogin: "alice" },
    );
    expect(denied.ok && denied.preview.decision.code).toBe("PERMISSION_DENIED");

    const unknown = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: unknownPerm, actorLogin: "alice" },
    );
    expect(unknown.ok && unknown.preview.decision.code).toBe("PERMISSION_UNKNOWN");

    const incompleteQuery = makeQuery({ historyComplete: false, claimAddedAt: null });
    const incomplete = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query: incompleteQuery, permission: allowPerm, actorLogin: "alice" },
    );
    expect(incomplete.ok && incomplete.preview.decision.code).toBe("EVIDENCE_INCOMPLETE");

    const overridden = await previewUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        trustedHumanContext: true,
        overrideUnknownHistory: true,
      },
      { query: incompleteQuery, permission: allowPerm, actorLogin: "alice" },
    );
    expect(overridden.ok && overridden.preview.decision.verdict).toBe("allow");
  });

  it("reports partial failure when label removal fails and safely completes on retry with same operationId", async () => {
    let labels = ["agent:kavya", "status:in-progress"];
    const comments: { id: string; body: string; createdAt: string }[] = [];
    const query: Query = ((q: string, v?: Parameters<Query>[1]) =>
      makeQuery({ labels, assignees: ["alice"], comments })(q, v ?? {})) as Query;

    const previewRes = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: allowPerm, actorLogin: "alice" },
    );
    expect(previewRes.ok).toBe(true);
    if (!previewRes.ok) return;

    const partial = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-retry",
        expectedClaimStart: CLAIM_START,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query,
        permission: allowPerm,
        actorLogin: "alice",
        run: async (args) => {
          if (args[1] === "comment") {
            const idx = args.indexOf("--body");
            comments.push({
              id: "c1",
              body: args[idx + 1] ?? "",
              createdAt: "2026-11-18T11:00:00Z",
              author: { __typename: "User", login: "alice" },
              lastEditedAt: null,
              includesCreatedEdit: false,
              editor: null,
            } as never);
            return;
          }
          throw new Error("network timeout removing label");
        },
      },
    );
    expect(partial.status).toBe("partial");
    expect(partial.recordOutcome).toBe("applied");
    expect(partial.labelOutcome).toBe("unknown");

    let commentWrites = 0;
    const retried = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-retry",
        expectedClaimStart: CLAIM_START,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query,
        permission: allowPerm,
        actorLogin: "alice",
        run: async (args) => {
          if (args[1] === "comment") {
            commentWrites++;
            return;
          }
          labels = labels.filter((l) => l !== "agent:kavya");
          return;
        },
      },
    );
    expect(retried.status).toBe("applied");
    expect(retried.recordOutcome).toBe("kept");
    expect(retried.labelOutcome).toBe("removed");
    expect(commentWrites).toBe(0);
  });

  it("reconciles lost response by operationId and refuses mismatched operationId reuse", async () => {
    const existingBody = formatHumanUnassignComment({
      operationId: "op-lost",
      repository: REPO,
      number: 42,
      agent: "kavya",
      claimStart: CLAIM_START,
      actor: "alice",
      expectedRevision: "abc",
    });
    const completedQuery = makeQuery({
      labels: ["status:in-progress"],
      assignees: ["alice"],
      claimAddedAt: CLAIM_START,
      comments: [
        {
          id: "c1",
          body: existingBody,
          createdAt: "2026-11-18T11:00:00Z",
          author: { __typename: "User", login: "alice" },
          lastEditedAt: null,
          includesCreatedEdit: false,
          editor: null,
        } as never,
      ],
    });
    const reconciled = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-lost",
        expectedClaimStart: CLAIM_START,
        expectedRevision: "abc",
        trustedHumanContext: true,
      },
      { query: completedQuery, permission: allowPerm, actorLogin: "alice" },
    );
    expect(reconciled.status).toBe("noop");
    expect(reconciled.recordOutcome).toBe("kept");
    expect(reconciled.labelOutcome).toBe("absent");

    const conflict = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-lost",
        expectedClaimStart: "2026-11-19T00:00:00Z",
        expectedRevision: "abc",
        trustedHumanContext: true,
      },
      { query: completedQuery, permission: allowPerm, actorLogin: "alice" },
    );
    expect(conflict.status).toBe("refused");
    expect(conflict.code).toBe("OPERATION_CONFLICT");
  });

  it("refuses with CLAIM_REPLACED if the claim is replaced after recording intent and before label removal", async () => {
    let claimAddedAt = CLAIM_START;
    const query: Query = ((q: string, v?: Parameters<Query>[1]) =>
      makeQuery({ claimAddedAt })(q, v ?? {})) as Query;
    const previewRes = await previewUnassign(
      { repository: REPO, number: 42, agent: "kavya", trustedHumanContext: true },
      { query, permission: allowPerm, actorLogin: "alice" },
    );
    expect(previewRes.ok).toBe(true);
    if (!previewRes.ok) return;

    const labelWrites: string[][] = [];
    const result = await applyUnassign(
      {
        repository: REPO,
        number: 42,
        agent: "kavya",
        actor: "alice",
        operationId: "op-midflight-replace",
        expectedClaimStart: CLAIM_START,
        expectedRevision: previewRes.preview.revision,
        trustedHumanContext: true,
      },
      {
        query,
        permission: allowPerm,
        actorLogin: "alice",
        run: async (args) => {
          if (args[1] === "comment") {
            // Simulate agent releasing and reacquiring the claim while comment was posted.
            claimAddedAt = "2026-11-18T12:30:00Z";
            return;
          }
          labelWrites.push(args);
        },
      },
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("CLAIM_REPLACED");
    expect(result.labelOutcome).toBe("not-attempted");
    expect(labelWrites).toHaveLength(0);
  });
});
