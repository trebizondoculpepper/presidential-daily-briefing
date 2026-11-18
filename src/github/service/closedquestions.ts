/**
 * Typed closed-question discovery capabilities (#899, doc/design/github-service-composition.md).
 *
 * Encapsulates closed-issue pagination (`listClosedIssues`), truncated comment-history pagination
 * (`listIssueComments`), and repository permission lookup (`permissionOf`) so
 * `briefing/closedquestions.ts` consumes validated TypeScript pages without raw GraphQL queries
 * or raw response traversal.
 */
import {
  comment as commentFields,
  common,
  info,
  isRecord,
  permissionLookup,
  prop,
} from "../github.js";
import type { PermissionLookup, Query, QueryVariables, Rest } from "../github.js";
import type { Comment, Issue } from "../types.js";

export interface ClosedIssuePage {
  issues: Issue[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ClosedIssueCommentsPage {
  comments: Comment[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ClosedQuestionCapabilities {
  /** Read one page of closed issues (baseline inventory or incremental `since` refresh). */
  listClosedIssues(
    repository: string,
    options: { pageSize: number; cursor?: string | null; since?: string; signal?: AbortSignal },
  ): Promise<ClosedIssuePage>;
  /** Read one page of comments for a closed issue; returns null when the issue is unavailable. */
  listIssueComments(
    repository: string,
    issueNumber: number,
    options: { pageSize: number; cursor?: string | null; signal?: AbortSignal },
  ): Promise<ClosedIssueCommentsPage | null>;
  /** Read permission authority for repository record verification. */
  permissionOf(repository: string, signal?: AbortSignal): PermissionLookup;
}

const inventorySource = (size: number) =>
  `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:${size},after:$cursor,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${common}} ${info}}} rateLimit{remaining resetAt}}`;

const sinceSource = (size: number) =>
  `query($owner:String!,$name:String!,$cursor:String,$since:DateTime!){repository(owner:$owner,name:$name){issues(first:${size},after:$cursor,states:CLOSED,filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${common}} ${info}}} rateLimit{remaining resetAt}}`;

const commentsSource = (size: number) =>
  `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:${size},after:$cursor){nodes{${commentFields}} ${info}}}}}}`;

const pageOf = (value: unknown): { nodes: unknown[]; more: boolean; cursor: string | null } => {
  const nodes = prop(value, "nodes");
  const hasNextPage = prop(value, "pageInfo", "hasNextPage");
  const cursor = prop(value, "pageInfo", "endCursor");
  if (!Array.isArray(nodes) || typeof hasNextPage !== "boolean") {
    throw new Error("the response has no valid page of nodes");
  }
  return {
    nodes,
    more: hasNextPage,
    cursor: typeof cursor === "string" ? cursor : null,
  };
};

const validateComment = (node: unknown): Comment => {
  if (
    !isRecord(node) ||
    typeof node.body !== "string" ||
    typeof node.createdAt !== "string" ||
    (node.url !== undefined && typeof node.url !== "string")
  ) {
    throw new Error("the response contains a malformed comment node");
  }
  return node as unknown as Comment;
};

const validateIssue = (node: unknown): Issue => {
  if (
    !isRecord(node) ||
    typeof node.number !== "number" ||
    !Number.isInteger(node.number) ||
    node.number < 1 ||
    typeof node.url !== "string" ||
    !node.url ||
    typeof node.state !== "string"
  ) {
    throw new Error("the response contains a malformed closed issue node");
  }
  const comments = pageOf(node.comments);
  comments.nodes.forEach(validateComment);
  return node as unknown as Issue;
};

/** Build typed closed-question capabilities over GraphQL and REST readers. */
export function closedQuestionsCapabilities(query: Query, rest: Rest): ClosedQuestionCapabilities {
  const runQuery = async (
    repository: string,
    source: string,
    variables: QueryVariables,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const [owner, name] = repository.split("/");
    const data = await query(source, {
      owner: owner ?? "",
      name: name ?? "",
      ...variables,
    });
    const repo = prop(data, "repository");
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };

  return {
    async listClosedIssues(repository, options) {
      const repo = await runQuery(
        repository,
        options.since ? sinceSource(options.pageSize) : inventorySource(options.pageSize),
        {
          ...(options.since ? { since: options.since } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        options.signal,
      );
      const page = pageOf(prop(repo, "issues"));
      return {
        issues: page.nodes.map(validateIssue),
        hasNextPage: page.more,
        endCursor: page.cursor,
      };
    },

    async listIssueComments(repository, issueNumber, options) {
      const repo = await runQuery(
        repository,
        commentsSource(options.pageSize),
        {
          number: issueNumber,
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        options.signal,
      );
      const target = prop(repo, "issueOrPullRequest");
      if (target === null || target === undefined || prop(target, "comments") === undefined) {
        return null;
      }
      const page = pageOf(prop(target, "comments"));
      return {
        comments: page.nodes.map(validateComment),
        hasNextPage: page.more,
        endCursor: page.cursor,
      };
    },

    permissionOf(repository, signal) {
      return permissionLookup(repository, rest, signal);
    },
  };
}
