import { describe, expect, it } from "vite-plus/test";
import { createGhService } from "./service.js";
import { graphqlApiOverTransport } from "../github.js";
import { ReadMeter } from "../readplan.js";

describe("typed GH service: github capabilities (#920)", () => {
  it("routes issues.locate and graphqlApiOverTransport through transport and env", async () => {
    const calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const customEnv = { GH_HOST: "ghe.example.com" };
    const transport = async (call: { args: readonly string[]; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: call.args, env: call.env });
      if (
        call.args[0] === "api" &&
        call.args[1] === "--include" &&
        call.args[2] === "repos/o/r/issues/5"
      ) {
        return {
          ok: true as const,
          stdout:
            "HTTP/2.0 200 OK\r\n\r\n" +
            JSON.stringify({
              number: 99,
              html_url: "https://ghe.example.com/other/repo/issues/99",
              repository_url: "https://ghe.example.com/api/v3/repos/other/repo",
            }),
        };
      }
      if (call.args.includes("graphql") && call.args.includes("--include")) {
        return {
          ok: true as const,
          stdout:
            "HTTP/2.0 200 OK\r\nx-github-request-id: req-1\r\n\r\n" +
            JSON.stringify({ data: { ok: true } }),
        };
      }
      if (call.args.includes("graphql")) {
        return {
          ok: true as const,
          stdout: JSON.stringify({ data: { viewer: { login: "alice" } } }),
        };
      }
      return {
        ok: false as const,
        kind: "exit" as const,
        exitCode: 1,
        stdout: "",
        stderr: "unexpected",
      };
    };
    const gh = createGhService({ env: customEnv, transport });
    const graphql = graphqlApiOverTransport(transport, customEnv);

    const located = await gh.issues.locate("o/r", 5);
    expect(located.state).toBe("moved");

    const q = await graphql.query("query { viewer { login } }", {});
    expect(q.data).toEqual({ viewer: { login: "alice" } });

    const m = await graphql.mutate("mutation { noop }", {});
    expect(m.data).toEqual({ ok: true });
    expect(m.response?.requestId).toBe("req-1");

    expect(calls.every((c) => c.env === customEnv)).toBe(true);
  });

  it("delegates snapshot.hydratePullRequests through the injected query boundary", async () => {
    const gh = createGhService({
      query: async () => ({
        repository: {
          pullRequest: {
            number: 10,
            title: "PR 10",
            body: "",
            url: "https://github.com/o/r/pull/10",
            state: "OPEN",
            createdAt: "2026-11-18T00:00:00Z",
            updatedAt: "2026-11-18T00:00:00Z",
            lastEditedAt: null,
            labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            assignees: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            headRefOid: "abc",
            headRefName: "feat",
            baseRefName: "main",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            mergedAt: null,
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            commits: { nodes: [] },
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
            statusCheckRollup: null,
          },
        },
      }),
    });

    const meter = new ReadMeter("issue-detail-v1", "issue-focus", () => new Date());
    const warnings: string[] = [];
    const prs = await gh.snapshot.hydratePullRequests(
      "o/r",
      [{ number: 10, url: "https://github.com/o/r/pull/10" }],
      { meter, warnings, role: "linked" },
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(10);
  });
});
