/**
 * In-memory GitHub boundary for refinement tests (#1094, #1095): reads come from a map of issues,
 * and planned `gh` writes are applied to it, with optional injected failures.
 */
import { applyPlan, planQuestionResolution } from "../workflow/claims.js";
import type { ClaimPlan, GraphQuery } from "../workflow/claims.js";
import {
  foldRefinement,
  planRefinementRequest,
  planRefinementResolve,
  refinementFacts,
  refinementLabel,
  requestRefinement,
  resolveRefinement,
} from "../workflow/refinement.js";
import type { RefinementRequestInput } from "../workflow/refinement.js";
import type { Rest } from "../github/github.js";
import { permissions } from "./fakegh.js";
import { by, page, repo } from "./snapshots.js";

type Note = {
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { __typename: string; login: string };
  lastEditedAt: string | null;
  includesCreatedEdit: boolean;
  editor: null;
};

export function world(viewer = "kavya") {
  let clock = Date.parse("2026-11-19T01:00:00Z");
  let ids = 9000;
  const tick = () => new Date((clock += 60_000)).toISOString();
  const issues = new Map<number, { labels: string[]; comments: Note[] }>();
  const repoLabels = new Set<string>();
  /** Steps whose write fails, by kind ("comment" | "labels" | "label-create"). */
  const failing = new Set<string>();
  const add = (n: number, labels: string[] = ["status:ready"]) =>
    issues.set(n, { labels: [...labels], comments: [] });
  const comment = (n: number, body: string, login = viewer) => {
    const id = ++ids;
    const note: Note = {
      ...by(login),
      databaseId: id,
      url: `https://github.com/${repo}/issues/${n}#issuecomment-${id}`,
      body,
      createdAt: tick(),
      editor: null,
    };
    issues.get(n)!.comments.push(note);
    return note;
  };
  const query: GraphQuery = async (source, variables) => {
    if (source.startsWith("query{viewer")) return { viewer: { __typename: "User", login: viewer } };
    const n = Number(variables.number);
    const i = issues.get(n);
    const named = (key: string) => {
      const name = String(variables[key] ?? "");
      return name && repoLabels.has(name) ? { name } : null;
    };
    return {
      repository: {
        issueOrPullRequest: i
          ? {
              __typename: "Issue",
              number: n,
              title: `T${n}`,
              url: `https://github.com/${repo}/issues/${n}`,
              state: "OPEN",
              updatedAt: "2026-11-19T00:00:00Z",
              labels: page(i.labels.map((name) => ({ name }))),
              issueDependenciesSummary: { blockedBy: 0 },
              blockedBy: page([]),
              closedByPullRequestsReferences: page([]),
              comments: page(i.comments),
              timelineItems: page([]),
            }
          : null,
        claims: page([]),
        ownerLabel: named("label"),
        questionLabel: named("question"),
        decisionLabel: named("decision"),
        needsDesignLabel: named("needsDesign"),
        attentionLabel: named("attention"),
        targetLabel: named("target"),
      },
    };
  };
  const run = async (args: string[]) => {
    if (args[0] === "label" && args[1] === "create") {
      if (failing.has("label-create")) throw new Error("label create failed");
      repoLabels.add(args[2]!);
      return;
    }
    const n = Number(args[2]);
    if (args[0] === "issue" && args[1] === "comment") {
      if (failing.has("comment")) throw new Error("comment failed");
      comment(n, args[args.indexOf("--body") + 1]!);
    } else if (args[0] === "issue" && args[1] === "edit") {
      if (failing.has("labels")) throw new Error("label edit failed");
      const i = issues.get(n)!;
      args.forEach((a, k) => {
        if (a === "--add-label" && !i.labels.includes(args[k + 1]!)) i.labels.push(args[k + 1]!);
        if (a === "--remove-label") i.labels = i.labels.filter((l) => l !== args[k + 1]);
      });
    }
  };
  const permission = permissions({ outsider: "read", ghost: "unknown" as never });
  const writes = { run, query, permission };
  const apply = (plan: ClaimPlan) => applyPlan(repo, plan, { run, query });
  const input = (n: number, questions: string[], extra: Partial<RefinementRequestInput> = {}) => ({
    number: n,
    agent: "kavya",
    designer: "nicole",
    why: "Unclear contract.",
    questions,
    ...extra,
  });
  const request = (n: number, questions: string[] = ["Which storage engine?"], extra = {}) =>
    requestRefinement(repo, input(n, questions, extra), writes);
  const planRequest = (n: number, questions: string[] = ["Which storage engine?"], extra = {}) =>
    planRefinementRequest(repo, input(n, questions, extra), query, permission);
  const resolve = (n: number, opId: string, why = "Answered.") =>
    resolveRefinement(repo, { number: n, agent: "kavya", request: opId, why }, writes);
  const planResolve = (n: number, opId: string, why = "Answered.") =>
    planRefinementResolve(
      repo,
      { number: n, agent: "kavya", request: opId, why },
      query,
      permission,
    );
  const answer = async (n: number, commentId: string) =>
    apply(
      await planQuestionResolution(
        repo,
        {
          number: n,
          agent: "nicole",
          op: "resolve",
          question: `https://github.com/${repo}/issues/${n}#issuecomment-${commentId}`,
          why: "Decided: SQLite.",
        },
        query,
        permission,
      ),
    );
  const fold = (n: number) => foldRefinement(repo, n, issues.get(n)!.comments, permission);
  const facts = async (n: number, estimates: string[] = []) =>
    refinementFacts(await fold(n), {
      historyComplete: true,
      labelPresent: issues.get(n)!.labels.includes(refinementLabel),
      estimates,
    });
  const questionOf = (n: number, k = 0) => String(issues.get(n)!.comments[k]!.databaseId);
  /** REST permission reads, as `gh api` returns them: outsider reads, ghost is unknown. */
  const rest: Rest = async (path) => {
    const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1];
    if (login === "ghost") return { status: 500, body: {} };
    return {
      status: 200,
      body: { role_name: login === "outsider" ? "read" : "write", user: { login } },
    };
  };
  return {
    rest,
    issues,
    failing,
    add,
    comment,
    run,
    query,
    permission,
    apply,
    request,
    planRequest,
    resolve,
    planResolve,
    answer,
    fold,
    facts,
    tick,
    questionOf,
  };
}
