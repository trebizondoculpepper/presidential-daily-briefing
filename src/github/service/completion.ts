/**
 * Typed GitHub completion capabilities (#889, doc/design/github-service-composition.md).
 *
 * Encapsulates issue-completion GraphQL reads (issue + viewer + delivery comments), PR/branch/
 * containment checks, and guarded typed completion writes (`recordCompletion`, `closeIssue`,
 * `removeLabel`) so `workflow/completion.ts` does not compose GraphQL queries or spawn `gh`.
 */
import { classifyCommentResponse, commentCommand, withCommentRecovery } from "../commentwrite.js";
import { ghCommentReceipt, isRateLimit, RateLimitError } from "../dependencies.js";
import { parseGhResponse } from "../evidence.js";
import type { GhResponse } from "../evidence.js";
import { prop } from "../github.js";
import type { Query, Rest } from "../github.js";
import type { GhTransport } from "./transport.js";
import { ticketGuard } from "../../workflow/claims.js";
import type { GhRun, GraphQuery } from "../../workflow/claims.js";
import {
  deliveryCommentFields,
  readDeliveryComments as readDeliveryHistory,
  readPr as readLivePr,
} from "../../workflow/deliverables.js";
import type { LivePr } from "../../workflow/deliverables.js";
import {
  defaultBranch as readDefaultBranch,
  targetContainment as readTargetContainment,
} from "./containment.js";
import type { Containment } from "./containment.js";
import type { DeliveryComment, DeliveryTarget } from "../../workflow/delivery.js";

export interface CompleteIssue {
  __typename?: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  labels: { nodes: { name: string }[]; pageInfo?: { hasNextPage?: boolean } };
  timelineItems?: { nodes: { actor?: { login?: string } | null }[] };
  comments: {
    nodes: DeliveryComment[];
    pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  };
}

export interface CompleteIssueRead {
  viewer: { __typename?: string; login?: string } | null;
  item: CompleteIssue | { __typename: "PullRequest"; url: string } | null;
}

export interface CompletionCapabilities {
  /** Read the target issue/PR, viewer identity, labels, close actor, and initial comments. */
  readIssue(repository: string, number: number): Promise<CompleteIssueRead>;
  /** Paginate delivery/claim comments for an issue. */
  readDeliveryComments(
    repository: string,
    number: number,
    initial: CompleteIssue["comments"],
  ): ReturnType<typeof readDeliveryHistory>;
  /** Read live pull request state/mergeCommit/baseRefName by URL. */
  readPr(url: string): Promise<LivePr | null>;
  /** Read a repository's default branch name. */
  defaultBranch(repository: string): Promise<string | null>;
  /** Check whether a merge commit is contained in the target branch. */
  targetContainment(
    target: DeliveryTarget,
    sha: string,
    branchOf: (repository: string) => Promise<string | null>,
  ): Promise<Containment>;
  /** Post a completion record comment under the live ticket guard and bounded comment recovery. */
  recordCompletion(repository: string, issueNumber: number, body: string): Promise<void>;
  /** Close the issue as completed under the live ticket guard. */
  closeIssue(repository: string, issueNumber: number): Promise<void>;
  /** Remove a workflow label under the live ticket guard. */
  removeLabel(repository: string, issueNumber: number, label: string): Promise<void>;
  /** Return a view of these capabilities that invokes `onRequest` per underlying GH call. */
  counted(onRequest: () => void): CompletionCapabilities;
}

function commentRunOverTransport(transport: GhTransport, query: Query, env?: NodeJS.ProcessEnv) {
  return withCommentRecovery({
    dispatch: async (args) => {
      const target = commentCommand(args)!;
      const outcome = await transport({
        args: [
          "api",
          "--include",
          "--method",
          "POST",
          `repos/${target.repository}/issues/${target.number}/comments`,
          "-f",
          `body=${target.body}`,
        ],
        ...(env ? { env } : {}),
        timeoutMs: 60_000,
        maxBufferBytes: 1024 * 1024,
      });
      if (!outcome.ok) {
        let response: GhResponse | null = null;
        try {
          response = outcome.stdout ? parseGhResponse(outcome.stdout) : null;
        } catch {
          response = null;
        }
        throw Object.assign(new Error("gh issue comment failed."), {
          commentAttempt: classifyCommentResponse(response, {
            exitCode: outcome.exitCode,
            timedOut: outcome.kind === "timeout",
          }),
        });
      }
      try {
        const url = prop(JSON.parse(parseGhResponse(outcome.stdout).body), "html_url");
        return { url: typeof url === "string" ? url : null };
      } catch {
        return { url: null };
      }
    },
    readBack: (target, since) => ghCommentReceipt(target, since, query),
  });
}

/**
 * Build a `GhRun` over an injected `GhTransport`, `Query`, and `env` so service-level
 * transport/environment isolation and bounded comment recovery both hold.
 */
export const runOverTransport = (
  transport: GhTransport,
  query: Query,
  env?: NodeJS.ProcessEnv,
): GhRun => {
  const commentRun = commentRunOverTransport(transport, query, env);
  return async (args, call) => {
    if (commentCommand(args)) {
      await commentRun(args, call);
      return;
    }
    const outcome = await transport({
      args,
      ...(env ? { env } : {}),
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
    });
    if (outcome.ok) return;
    if (isRateLimit(`${outcome.stderr}\n${outcome.stdout}`)) {
      throw new RateLimitError(`gh ${args[0]} ${args[1]} was rate limited by GitHub.`);
    }
    throw new Error(`gh ${args[0]} ${args[1]} failed. Check gh auth status and rate limits.`);
  };
};

/** Build typed completion capabilities over GraphQL, REST, and guarded command execution. */
export function completionCapabilities(
  query: GraphQuery,
  rest: Rest,
  run: GhRun,
): CompletionCapabilities {
  const build = (q: GraphQuery, r: Rest): CompletionCapabilities => ({
    async readIssue(repository, number) {
      const [owner, name] = repository.split("/");
      const data = (await q(
        `query($owner:String!,$name:String!,$number:Int!){viewer{__typename login} repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{url} ... on Issue{number title url state stateReason labels(first:100){nodes{name} pageInfo{hasNextPage}} timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{actor{login}}}} comments(last:100){nodes{${deliveryCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}}`,
        { owner, name, number },
      )) as {
        viewer?: { __typename?: string; login?: string } | null;
        repository: {
          issueOrPullRequest: CompleteIssue | { __typename: "PullRequest"; url: string } | null;
        } | null;
      };
      if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
      return { viewer: data.viewer ?? null, item: data.repository.issueOrPullRequest };
    },
    readDeliveryComments(repository, number, initial) {
      return readDeliveryHistory(repository, number, initial, q);
    },
    readPr(url) {
      return readLivePr(url, q);
    },
    defaultBranch(repository) {
      return readDefaultBranch(repository, q);
    },
    targetContainment(target, sha, branchOf) {
      return readTargetContainment(target, sha, { query: q, rest: r }, branchOf);
    },
    async recordCompletion(repository, issueNumber, body) {
      await run(["issue", "comment", String(issueNumber), "--repo", repository, "--body", body], {
        guard: ticketGuard(repository, issueNumber, q),
      });
    },
    async closeIssue(repository, issueNumber) {
      await run(
        ["issue", "close", String(issueNumber), "--repo", repository, "--reason", "completed"],
        { guard: ticketGuard(repository, issueNumber, q) },
      );
    },
    async removeLabel(repository, issueNumber, label) {
      await run(
        ["issue", "edit", String(issueNumber), "--repo", repository, "--remove-label", label],
        { guard: ticketGuard(repository, issueNumber, q) },
      );
    },
    counted(onRequest) {
      return build(
        (gql, vars) => {
          onRequest();
          return q(gql, vars);
        },
        (path, opts) => {
          onRequest();
          return r(path, opts);
        },
      );
    },
  });
  return build(query, rest);
}
