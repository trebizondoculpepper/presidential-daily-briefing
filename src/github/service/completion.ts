/**
 * Typed GitHub completion capabilities (#889, doc/design/github-service-composition.md).
 *
 * Encapsulates issue-completion GraphQL reads (issue + viewer + delivery comments), PR/branch/
 * containment checks, and guarded write-step execution so `workflow/completion.ts` does not
 * compose GraphQL queries or spawn `gh` directly.
 */
import { isRateLimit, RateLimitError } from "../dependencies.js";
import type { Rest } from "../github.js";
import type { GhTransport } from "./transport.js";
import { ticketGuard } from "../../workflow/claims.js";
import type { GhRun, GraphQuery } from "../../workflow/claims.js";
import {
  defaultBranch as readDefaultBranch,
  deliveryCommentFields,
  readDeliveryComments as readDeliveryHistory,
  readPr as readLivePr,
  targetContainment as readTargetContainment,
} from "../../workflow/deliverables.js";
import type { Containment, LivePr } from "../../workflow/deliverables.js";
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
  /** Execute one planned `gh` write step under the live ticket guard. */
  executeStep(repository: string, issueNumber: number, command: string[]): Promise<void>;
  /** Return a view of these capabilities that invokes `onRequest` per underlying GH call. */
  counted(onRequest: () => void): CompletionCapabilities;
}

/** Build a `GhRun` over an injected `GhTransport` so service-level transport isolation holds. */
export const runOverTransport =
  (transport: GhTransport, env?: NodeJS.ProcessEnv): GhRun =>
  async (args) => {
    const outcome = await transport({
      args,
      ...(env ? { env } : {}),
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
    });
    if (outcome.ok) return;
    if (!outcome.ok && isRateLimit(`${outcome.stderr}\n${outcome.stdout}`)) {
      throw new RateLimitError(`gh ${args[0]} ${args[1]} was rate limited by GitHub.`);
    }
    throw new Error(`gh ${args[0]} ${args[1]} failed. Check gh auth status and rate limits.`);
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
    async executeStep(repository, issueNumber, command) {
      await run(command, { guard: ticketGuard(repository, issueNumber, q) });
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
