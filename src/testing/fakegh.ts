/**
 * Injected `gh` boundaries for tests: a fake native-dependency graph and a permission lookup.
 * Test-only (#335 stage 3, doc/design/source-layout.md); never touches the network.
 */
import type { PermissionLookup, Query, RepositoryPermission } from "../github/github.js";
import { page, repo, time } from "./snapshots.js";

/** A fake repository of native edges served through the injected gh query boundary. */
export type Graph = {
  states?: Record<
    number,
    {
      state?: string;
      stateReason?: string | null;
      body?: string;
      labels?: string[];
      createdAt?: string;
      /** Open PRs that close this issue (closedByPullRequestsReferences). */
      closedBy?: number[];
    }
  >;
  pullRequests?: Record<number, number[]>;
  edges: [blocked: number, blocker: number][];
  pageSize?: number;
};
export const graphQuery = (graph: Graph) => {
  const calls: { number: number; cursor?: string }[] = [];
  const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
  const state = (n: number) => graph.states?.[n]?.state ?? "OPEN";
  const blockersOf = (n: number) => graph.edges.filter(([a]) => a === n).map(([, b]) => b);
  const dependantsOf = (n: number) => graph.edges.filter(([, b]) => b === n).map(([a]) => a);
  const summary = (n: number) => ({
    blockedBy: blockersOf(n).filter((b) => state(b) === "OPEN").length,
    totalBlockedBy: blockersOf(n).length,
    blocking: dependantsOf(n).filter(() => state(n) === "OPEN").length,
    totalBlocking: dependantsOf(n).length,
  });
  const node = (n: number) => ({
    number: n,
    title: `Ticket ${n}`,
    state: state(n),
    stateReason: graph.states?.[n]?.stateReason ?? null,
    url: url(n),
    repository: { nameWithOwner: repo },
    issueDependenciesSummary: summary(n),
  });
  const size = graph.pageSize ?? 100;
  const connection = (numbers: number[], cursor?: string) => {
    const start = cursor ? Number(cursor) : 0;
    const more = start + size < numbers.length;
    return page(
      numbers.slice(start, start + size).map(node),
      more,
      more ? String(start + size) : null,
    );
  };
  const known = (n: number) => n in (graph.states ?? {}) || graph.edges.flat().includes(n);
  const eligibility = (n: number) => ({
    createdAt: graph.states?.[n]?.createdAt ?? time,
    labels: page((graph.states?.[n]?.labels ?? ["status:ready"]).map((name) => ({ name }))),
    closedByPullRequestsReferences: page(
      (graph.states?.[n]?.closedBy ?? []).map((p) => ({
        number: p,
        url: `https://github.com/${repo}/pull/${p}`,
        state: "OPEN",
      })),
    ),
  });
  const query: Query = async (source, variables) => {
    // Batched dependant eligibility (#196): aliases d0..dK, one call per batch.
    if ("n0" in variables) {
      const answer: Record<string, unknown> = {};
      for (let i = 0; `n${i}` in variables; i++) {
        const n = Number(variables[`n${i}`]);
        calls.push({ number: n, cursor: "batch" });
        const limit = Number(/blockedBy\(first:(\d+)\)/.exec(source)?.[1] ?? 100);
        const blockers = blockersOf(n);
        answer[`d${i}`] = {
          issue: known(n)
            ? {
                ...node(n),
                ...eligibility(n),
                blockedBy: page(
                  blockers.slice(0, limit).map((b) => ({
                    number: b,
                    url: url(b),
                    state: state(b),
                    stateReason: graph.states?.[b]?.stateReason ?? null,
                  })),
                  blockers.length > limit,
                ),
              }
            : null,
        };
      }
      return answer;
    }
    const number = Number(variables.number);
    const cursor = variables.cursor as string | undefined;
    calls.push({ number, cursor });
    if (source.includes("issueOrPullRequest")) {
      if (graph.pullRequests?.[number])
        return {
          repository: {
            issueOrPullRequest: {
              __typename: "PullRequest",
              number,
              url: `https://github.com/${repo}/pull/${number}`,
              closingIssuesReferences: page(graph.pullRequests[number].map((n) => ({ number: n }))),
            },
          },
        };
      const known = number in (graph.states ?? {}) || graph.edges.flat().includes(number);
      return {
        repository: {
          issueOrPullRequest: known
            ? { __typename: "Issue", number, url: url(number), state: state(number) }
            : null,
        },
      };
    }
    if (!(number in (graph.states ?? {})) && !graph.edges.flat().includes(number))
      return { repository: { issue: null } };
    if (cursor) {
      const field = /blockedBy\(first:100,after/.test(source) ? "blockedBy" : "blocking";
      const numbers = field === "blockedBy" ? blockersOf(number) : dependantsOf(number);
      return { repository: { issue: { [field]: connection(numbers, cursor) } } };
    }
    return {
      repository: {
        issue: {
          ...node(number),
          body: graph.states?.[number]?.body ?? "",
          updatedAt: time,
          labels: page((graph.states?.[number]?.labels ?? []).map((name) => ({ name }))),
          ...(source.includes("closedByPullRequestsReferences") ? eligibility(number) : {}),
          blockedBy: connection(blockersOf(number)),
          blocking: connection(dependantsOf(number)),
        },
      },
    };
  };
  return { query, calls, url };
};
/** An injected per-test permission lookup: never live; write unless the table says otherwise. */
export const permissions = (table: Record<string, RepositoryPermission> = {}) => {
  const calls: string[] = [];
  const lookup: PermissionLookup = async (login) => {
    calls.push(login);
    return table[login] ?? "write";
  };
  return Object.assign(lookup, { calls });
};
